from __future__ import annotations

import asyncio
import re
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Final

from k8s_incident_agent.domain.contracts import KubernetesTarget
from k8s_incident_agent.monitoring.catalog import (
    AlertCatalog,
    MetricPanelContract,
)
from k8s_incident_agent.monitoring.contracts import (
    MetricPanelPayload,
    MetricPanelResult,
    MetricQueryState,
    MetricRiskDirection,
    MetricTargetRef,
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
_UP_QUERY: Final = 'up{job=~"kube-state-metrics|alertmanager"}'
_WATCHDOG_QUERY: Final = 'ALERTS{alertname="Watchdog",alertstate="firing"}'
_HEALTH_LOOKBACK_SECONDS: Final = 60


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
    ) -> MetricPanelResult:
        panel = self._require_panel(target, panel_id)
        queried_at = _utc_now(self._now())
        try:
            return await self._query_panel(
                target=target,
                panel=panel,
                window=window,
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
                state=state,
                queried_at=queried_at,
            )

    async def observe_panel(
        self,
        *,
        target: KubernetesTarget,
        panel_id: str,
        window: MetricWindow,
    ) -> PrometheusObservation:
        panel = self._require_panel(target, panel_id)
        queried_at = _utc_now(self._now())
        result = await self._query_panel(
            target=target,
            panel=panel,
            window=window,
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
        queried_at: datetime,
    ) -> MetricPanelResult:
        step_seconds = _WINDOW_STEPS[window]
        expression = _render_query(panel.query_template, target)
        result = await self._client.query_range(
            expression,
            start=queried_at - window.duration,
            end=queried_at,
            step_seconds=step_seconds,
            lookback_seconds=panel.stale_after_seconds,
        )
        if not result.series:
            return _empty_panel_result(
                panel,
                window=window,
                state=(
                    MetricQueryState.PARTIAL
                    if result.partial
                    else MetricQueryState.NO_DATA
                ),
                queried_at=queried_at,
            )
        if len(result.series) != 1 or result.series[0].labels:
            raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
        samples = result.series[0].samples
        if any(sample.timestamp > queried_at for sample in samples):
            raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
        latest = samples[-1]
        if result.partial:
            state = MetricQueryState.PARTIAL
        elif latest.timestamp < queried_at:
            state = MetricQueryState.STALE
        else:
            state = MetricQueryState.OK
        return MetricPanelResult(
            panel_id=panel.panel_id,
            title=panel.title,
            unit=panel.unit,
            threshold=panel.threshold,
            risk_direction=MetricRiskDirection(panel.risk_direction),
            window=window,
            state=state,
            queried_at=queried_at,
            latest_sample_at=latest.timestamp,
            current_value=latest.value,
            samples=list(samples),
        )

    def _require_panel(
        self,
        target: KubernetesTarget,
        panel_id: str,
    ) -> MetricPanelContract:
        match = self._catalog.find_panel(panel_id)
        if match is None:
            raise MonitoringBoundaryError(MonitoringErrorCode.PANEL_NOT_FOUND)
        entry, panel = match
        if (
            target.cluster != self._cluster_id
            or target.namespace is None
            or target.api_version != entry.target.api_version
            or target.kind != entry.target.kind
        ):
            raise MonitoringBoundaryError(MonitoringErrorCode.TARGET_UNSUPPORTED)
        return panel


def _empty_panel_result(
    panel: MetricPanelContract,
    *,
    window: MetricWindow,
    state: MetricQueryState,
    queried_at: datetime,
) -> MetricPanelResult:
    return MetricPanelResult(
        panel_id=panel.panel_id,
        title=panel.title,
        unit=panel.unit,
        threshold=panel.threshold,
        risk_direction=MetricRiskDirection(panel.risk_direction),
        window=window,
        state=state,
        queried_at=queried_at,
        latest_sample_at=None,
        current_value=None,
        samples=[],
    )


def _render_query(template: str, target: KubernetesTarget) -> str:
    namespace = target.namespace
    if namespace is None:
        raise MonitoringBoundaryError(MonitoringErrorCode.TARGET_UNSUPPORTED)
    return template.replace(
        "{{namespace}}", _escape_promql_label_value(namespace)
    ).replace("{{name}}", _escape_promql_label_value(target.name))


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
