from __future__ import annotations

import asyncio
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final

from pydantic import ValidationError

from k8s_incident_agent.domain.contracts import KubernetesTarget
from k8s_incident_agent.monitoring.catalog import (
    RANGE_PLACEHOLDER,
    AlertCatalog,
    MetricPanelContract,
)
from k8s_incident_agent.monitoring.contracts import (
    MetricPanelPayload,
    MetricPanelResult,
    MetricQueryState,
    MetricRiskDirection,
    MetricSeries,
    MetricSeriesBinding,
    MetricTargetRef,
    MetricTimeAnchor,
    MetricWindow,
    PrometheusHealthSignals,
    PrometheusObservation,
    RecoveryMonitoring,
)
from k8s_incident_agent.monitoring.errors import (
    MonitoringBoundaryError,
    MonitoringErrorCode,
)
from k8s_incident_agent.monitoring.prometheus import (
    PrometheusHttpClient,
    PrometheusQueryResult,
)

_WINDOW_STEPS: Final[dict[MetricWindow, int]] = {
    MetricWindow.FIFTEEN_MINUTES: 15,
    MetricWindow.ONE_HOUR: 60,
    MetricWindow.SIX_HOURS: 300,
    MetricWindow.SEVEN_DAYS: 1_800,
    MetricWindow.FIFTEEN_DAYS: 3_600,
}
# Attributed panels return up to MAX_PANEL_SERIES series, so their step keeps
# 8 x points inside the fixed 512-sample result budget instead of widening it.
_ATTRIBUTED_WINDOW_STEPS: Final[dict[MetricWindow, int]] = {
    MetricWindow.FIFTEEN_MINUTES: 15,
    MetricWindow.ONE_HOUR: 60,
    MetricWindow.SIX_HOURS: 360,
    MetricWindow.SEVEN_DAYS: 10_800,
    MetricWindow.FIFTEEN_DAYS: 21_600,
}
_UP_QUERY: Final = 'up{job=~"kube-state-metrics|alertmanager"}'
_WATCHDOG_QUERY: Final = 'ALERTS{alertname="Watchdog",alertstate="firing"}'
_HEALTH_LOOKBACK_SECONDS: Final = 60


@dataclass(frozen=True, slots=True)
class MetricRange:
    anchor: MetricTimeAnchor
    start: datetime
    end: datetime


def resolve_metric_range(
    window: MetricWindow,
    anchor: MetricTimeAnchor,
    *,
    queried_at: datetime,
    occurred_at: datetime | None = None,
    run_completed_at: datetime | None = None,
) -> MetricRange:
    """Derive the data window from a registered anchor, never from a caller time.

    ``occurrence`` centres the window on the persisted Incident onset so both the
    lead-up and the aftermath are visible; ``run`` ends at the exact Run's
    completion and degrades to ``current`` while that Run is still observing.
    Every window ends no later than ``queried_at``.
    """
    duration = window.duration
    queried_at = _utc_now(queried_at)
    if anchor is MetricTimeAnchor.OCCURRENCE:
        if occurred_at is None:
            raise ValueError("Occurrence anchor requires the Incident onset")
        end = min(_utc_now(occurred_at) + duration / 2, queried_at)
    elif anchor is MetricTimeAnchor.RUN and run_completed_at is not None:
        end = min(_utc_now(run_completed_at), queried_at)
    else:
        end = queried_at
    return MetricRange(anchor=anchor, start=end - duration, end=end)


class PrometheusQueryService:
    def __init__(
        self,
        *,
        catalog: AlertCatalog,
        client: PrometheusHttpClient,
        cluster_id: str,
        now: Callable[[], datetime],
    ) -> None:
        self._catalog = catalog
        self._client = client
        self._cluster_id = cluster_id
        self._now = now

    @property
    def panel_ids(self) -> tuple[str, ...]:
        return self._catalog.panel_ids

    async def close(self) -> None:
        await self._client.close()

    async def observe_recovery(
        self,
        *,
        target: KubernetesTarget,
        container_name: str,
        pod_uids: tuple[str, ...],
        applied_at: datetime,
    ) -> RecoveryMonitoring:
        if (
            target.cluster != self._cluster_id
            or target.api_version != "apps/v1"
            or target.kind != "Deployment"
            or target.namespace is None
            or not 1 <= len(pod_uids) <= 32
            or len(set(pod_uids)) != len(pod_uids)
        ):
            raise MonitoringBoundaryError(MonitoringErrorCode.TARGET_UNSUPPORTED)
        names = tuple(
            entry.alert_id
            for entry in self._catalog.entries
            if entry.target.api_version == target.api_version
            and entry.target.kind == target.kind
        )
        at = _utc_now(self._now())

        def query(expression: str):
            return self._client.query_instant(expression, at=at, lookback_seconds=60)

        def metric_query(metric: str) -> str:
            selector = (
                f'{metric}{{job="kube-state-metrics",namespace="{_escape_promql_label_value(target.namespace or "")}",'
                f'container="{_escape_promql_label_value(container_name)}",'
                f'uid=~"{_escape_promql_label_value("|".join(re.escape(uid) for uid in pod_uids))}"}}'
            )
            # Aggregate only AFTER timestamp(raw); the oldest input and exact UID
            # coverage cannot be hidden by a fresh evaluation or duplicate series.
            return (
                f"label_replace(count((count by(uid)({selector}) == 1) and on(uid) "
                f'(sum by(uid)({selector}) == 1)), "check", "covered", "", "") or '
                f'label_replace(min(timestamp({selector})), "check", "oldest", "", "")'
            )

        alerts_query = (
            f'ALERTS{{namespace="{_escape_promql_label_value(target.namespace)}",'
            f'deployment="{_escape_promql_label_value(target.name)}",'
            f'alertname=~"{_escape_promql_label_value("|".join(re.escape(name) for name in names))}",'
            'alertstate=~"pending|firing"}'
        )
        up, up_at, ready, running, alerts, rules = await asyncio.gather(
            query(_UP_QUERY),
            query(f"timestamp({_UP_QUERY})"),
            query(metric_query("kube_pod_container_status_ready")),
            query(metric_query("kube_pod_container_status_running")),
            query(alerts_query),
            self._client.read_recovery_rules((*names, "Watchdog")),
        )
        partial = any(result.partial for result in (up, up_at, ready, running, alerts))
        healthy_up = all(
            _single_up(up, job) and _fresh_job(up_at, job, at)
            for job in ("kube-state-metrics", "alertmanager")
        )
        oldest_rule = min(rule.last_evaluation for rule in rules)
        received_at = _utc_now(self._now())
        healthy_rules = all(
            rule.health == "ok" and _fresh(rule.last_evaluation, received_at)
            for rule in rules
        )
        oldest_samples: list[datetime] = []
        target_healthy = not partial
        for result in (ready, running):
            if any(
                len(series.labels) != 1 or series.labels[0][0] != "check"
                for series in result.series
            ):
                raise MonitoringBoundaryError(
                    MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID
                )
            values = {
                series.label("check"): series.samples[-1].value
                for series in result.series
            }
            if set(values) != {"covered", "oldest"} or len(result.series) != 2:
                target_healthy = False
                continue
            sampled_at = _sample_time(values["oldest"])
            oldest_samples.append(sampled_at)
            target_healthy = (
                target_healthy
                and values["covered"] == len(pod_uids)
                and _fresh(sampled_at, at)
                and sampled_at >= applied_at
            )
        active: set[str] = set()
        for series in alerts.series:
            name = series.label("alertname")
            if (
                name is None
                or name not in names
                or series.label("namespace") != target.namespace
                or series.label("deployment") != target.name
                or series.label("alertstate") not in ("pending", "firing")
                or series.samples[-1].value != 1
            ):
                raise MonitoringBoundaryError(
                    MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID
                )
            active.add(name)
        return RecoveryMonitoring(
            checked_at=at,
            chain_healthy=not partial and healthy_up and healthy_rules,
            target_healthy=target_healthy,
            oldest_target_sample_at=min(oldest_samples) if oldest_samples else None,
            oldest_rule_evaluation_at=oldest_rule,
            active_alerts=sorted(active),
        )

    async def query_panel(
        self,
        *,
        target: KubernetesTarget,
        panel_id: str,
        window: MetricWindow,
        metric_range: MetricRange,
        queried_at: datetime,
    ) -> MetricPanelResult:
        panel = self._require_panel(target, panel_id)
        queried_at = _utc_now(queried_at)
        try:
            return await self._query_panel(
                target=target,
                panel=panel,
                window=window,
                metric_range=metric_range,
                queried_at=queried_at,
            )
        except MonitoringBoundaryError as error:
            if error.code is MonitoringErrorCode.QUERY_FAILED:
                state = MetricQueryState.QUERY_ERROR
            elif error.code in {
                MonitoringErrorCode.REQUEST_TIMEOUT,
                MonitoringErrorCode.UNAVAILABLE,
            }:
                state = MetricQueryState.MONITORING_UNAVAILABLE
            else:
                raise
            return _empty_panel_result(
                panel,
                window=window,
                metric_range=metric_range,
                state=state,
                queried_at=queried_at,
            )

    async def observe_panel(
        self,
        *,
        target: KubernetesTarget,
        panel_id: str,
        window: MetricWindow,
        metric_range: MetricRange,
        queried_at: datetime,
    ) -> PrometheusObservation:
        panel = self._require_panel(target, panel_id)
        queried_at = _utc_now(queried_at)
        result = await self._query_panel(
            target=target,
            panel=panel,
            window=window,
            metric_range=metric_range,
            queried_at=queried_at,
        )
        namespace = target.namespace
        if namespace is None:
            raise MonitoringBoundaryError(MonitoringErrorCode.TARGET_UNSUPPORTED)
        return PrometheusObservation(
            evidence_kind="metrics",
            target_ref=MetricTargetRef(
                cluster=target.cluster,
                namespace=namespace,
                api_version=target.api_version,
                kind=target.kind,
                name=target.name,
            ),
            observed_at=queried_at,
            payload=MetricPanelPayload(result=result),
        )

    async def read_health_signals(self) -> PrometheusHealthSignals:
        checked_at = _utc_now(self._now())
        up = await self._client.query_instant(
            _UP_QUERY,
            at=checked_at,
            lookback_seconds=_HEALTH_LOOKBACK_SECONDS,
        )
        watchdog = await self._client.query_instant(
            _WATCHDOG_QUERY,
            at=checked_at,
            lookback_seconds=_HEALTH_LOOKBACK_SECONDS,
        )
        return PrometheusHealthSignals(
            checked_at=checked_at,
            partial=up.partial or watchdog.partial,
            kube_state_metrics_available=_single_up(up, "kube-state-metrics"),
            alertmanager_available=_single_up(up, "alertmanager"),
            watchdog_rule_firing=_watchdog_firing(watchdog),
        )

    async def _query_panel(
        self,
        *,
        target: KubernetesTarget,
        panel: MetricPanelContract,
        window: MetricWindow,
        metric_range: MetricRange,
        queried_at: datetime,
    ) -> MetricPanelResult:
        if (
            metric_range.end - metric_range.start != window.duration
            or metric_range.end > queried_at
        ):
            raise ValueError("Metric range does not match the requested window")
        binding = MetricSeriesBinding(panel.series_binding)
        step_seconds = (
            _WINDOW_STEPS[window]
            if binding is MetricSeriesBinding.TARGET
            else _ATTRIBUTED_WINDOW_STEPS[window]
        )
        expression = _render_query(panel.query_template, target, step_seconds)
        result = await self._client.query_range(
            expression,
            start=metric_range.start,
            end=metric_range.end,
            step_seconds=step_seconds,
            lookback_seconds=panel.stale_after_seconds,
        )
        if not result.series:
            return _empty_panel_result(
                panel,
                window=window,
                metric_range=metric_range,
                state=(
                    MetricQueryState.PARTIAL
                    if result.partial
                    else MetricQueryState.NO_DATA
                ),
                queried_at=queried_at,
            )
        series = _attributed_series(result, binding)
        if any(
            sample.timestamp > metric_range.end or sample.timestamp < metric_range.start
            for item in series
            for sample in item.samples
        ):
            raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
        latest_at = max(item.samples[-1].timestamp for item in series)
        if result.partial:
            state = MetricQueryState.PARTIAL
        elif latest_at < metric_range.end:
            state = MetricQueryState.STALE
        else:
            state = MetricQueryState.OK
        try:
            return MetricPanelResult(
                panel_id=panel.panel_id,
                title=panel.title,
                unit=panel.unit,
                purpose=panel.purpose,
                threshold=panel.threshold,
                risk_direction=MetricRiskDirection(panel.risk_direction),
                series_binding=binding,
                window=window,
                anchor=metric_range.anchor,
                state=state,
                queried_at=queried_at,
                range_start=metric_range.start,
                range_end=metric_range.end,
                latest_sample_at=latest_at,
                current_value=(
                    series[0].samples[-1].value
                    if binding is MetricSeriesBinding.TARGET
                    else None
                ),
                series=series,
            )
        except ValidationError:
            # The fixed template returned series the binding cannot attribute.
            raise MonitoringBoundaryError(
                MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID
            ) from None

    def _require_panel(
        self,
        target: KubernetesTarget,
        panel_id: str,
    ) -> MetricPanelContract:
        if self._catalog.find_panel(panel_id) is None:
            raise MonitoringBoundaryError(MonitoringErrorCode.PANEL_NOT_FOUND)
        if target.cluster != self._cluster_id or target.namespace is None:
            raise MonitoringBoundaryError(MonitoringErrorCode.TARGET_UNSUPPORTED)
        admitted = next(
            (
                panel
                for panel in self._catalog.panels_for_target(
                    target.api_version, target.kind
                )
                if panel.panel_id == panel_id
            ),
            None,
        )
        if admitted is None:
            raise MonitoringBoundaryError(MonitoringErrorCode.TARGET_UNSUPPORTED)
        return admitted


def _empty_panel_result(
    panel: MetricPanelContract,
    *,
    window: MetricWindow,
    metric_range: MetricRange,
    state: MetricQueryState,
    queried_at: datetime,
) -> MetricPanelResult:
    return MetricPanelResult(
        panel_id=panel.panel_id,
        title=panel.title,
        unit=panel.unit,
        purpose=panel.purpose,
        threshold=panel.threshold,
        risk_direction=MetricRiskDirection(panel.risk_direction),
        series_binding=MetricSeriesBinding(panel.series_binding),
        window=window,
        anchor=metric_range.anchor,
        state=state,
        queried_at=queried_at,
        range_start=metric_range.start,
        range_end=metric_range.end,
        latest_sample_at=None,
        current_value=None,
        series=[],
    )


def _attributed_series(
    result: PrometheusQueryResult,
    binding: MetricSeriesBinding,
) -> list[MetricSeries]:
    """Project raw series onto the panel's attribution labels, fail-closed.

    The fixed templates already aggregate onto exactly the binding's labels, so
    any other label set means the template or Prometheus contract drifted and the
    result must not be presented as attributed Evidence.
    """
    if binding is MetricSeriesBinding.TARGET and len(result.series) != 1:
        raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
    try:
        return [
            MetricSeries(labels=dict(raw.labels), samples=list(raw.samples))
            for raw in result.series
        ]
    except ValueError:
        raise MonitoringBoundaryError(
            MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID
        ) from None


def _render_query(
    template: str,
    target: KubernetesTarget,
    step_seconds: int,
) -> str:
    namespace = target.namespace
    if namespace is None:
        raise MonitoringBoundaryError(MonitoringErrorCode.TARGET_UNSUPPORTED)

    def rolling_range(match: re.Match[str]) -> str:
        minimum = int(match.group(1)) * (60 if match.group(2) == "m" else 1)
        return f"{max(minimum, step_seconds)}s"

    return RANGE_PLACEHOLDER.sub(
        rolling_range,
        template.replace(
            "{{namespace}}", _escape_promql_label_value(namespace)
        ).replace("{{name}}", _escape_promql_label_value(target.name)),
    )


def _escape_promql_label_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _single_up(result: PrometheusQueryResult, job: str) -> bool:
    matching = [series for series in result.series if series.label("job") == job]
    if len(matching) > 1:
        raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
    return bool(matching and matching[0].samples[-1].value == 1)


def _sample_time(seconds: float) -> datetime:
    try:
        return datetime.fromtimestamp(seconds, UTC)
    except (ValueError, OverflowError, OSError):
        raise MonitoringBoundaryError(
            MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID
        ) from None


def _fresh(sample: datetime, at: datetime) -> bool:
    return at - timedelta(seconds=60) <= sample <= at


def _fresh_job(result: PrometheusQueryResult, job: str, at: datetime) -> bool:
    matching = [series for series in result.series if series.label("job") == job]
    return len(matching) == 1 and _fresh(
        _sample_time(matching[0].samples[-1].value), at
    )


def _watchdog_firing(result: PrometheusQueryResult) -> bool:
    if len(result.series) > 1:
        raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
    return bool(result.series and result.series[0].samples[-1].value == 1)


def _utc_now(value: datetime) -> datetime:
    if value.utcoffset() is None:
        raise ValueError("Monitoring clock must include a timezone")
    utc_value = value.astimezone(UTC)
    return utc_value.replace(microsecond=(utc_value.microsecond // 1000) * 1000)
