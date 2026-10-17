from __future__ import annotations

import asyncio
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from itertools import batched
from typing import Final

from pydantic import ValidationError

from k8s_incident_agent.domain.contracts import KubernetesTarget
from k8s_incident_agent.kubernetes.contracts import CurrentTargetFacts
from k8s_incident_agent.monitoring.catalog import (
    RANGE_PLACEHOLDER,
    AlertCatalog,
    AlertCatalogEntry,
    MetricPanelContract,
)
from k8s_incident_agent.monitoring.contracts import (
    CurrentAlertState,
    FiringHealthAlert,
    MetricPanelPayload,
    MetricPanelResult,
    MetricQueryState,
    MetricRiskDirection,
    MetricSeries,
    MetricSeriesBinding,
    MetricTargetRef,
    MetricTimeAnchor,
    MetricWindow,
    ObservationReason,
    PrometheusHealthSignals,
    PrometheusObservation,
    RecoveryMonitoring,
    RuleAlertObservation,
)
from k8s_incident_agent.monitoring.errors import (
    MonitoringBoundaryError,
    MonitoringErrorCode,
)
from k8s_incident_agent.monitoring.prometheus import (
    PrometheusHttpClient,
    PrometheusQueryResult,
    PrometheusRule,
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

    @property
    def catalog_version(self) -> str:
        return self._catalog.version

    async def read_reconciliation_rules(
        self,
    ) -> dict[str, PrometheusRule | ObservationReason]:
        """Share the bounded rule definition reads across one reconciliation pass."""
        result: dict[str, PrometheusRule | ObservationReason] = {}
        for batch in batched(self._catalog.entries, 8, strict=False):
            names = tuple(entry.alert_id for entry in batch)
            try:
                rules = await self._client.read_alert_rules(names)
                result.update((rule.name, rule) for rule in rules)
            except MonitoringBoundaryError as error:
                result.update((name, _observation_failure(error)) for name in names)
        return result

    async def observe_current_alerts(
        self,
        target: KubernetesTarget,
        facts: CurrentTargetFacts,
        rules: dict[str, PrometheusRule | ObservationReason],
        *,
        at: datetime,
    ) -> tuple[RuleAlertObservation, ...]:
        if target.cluster != self._cluster_id or target.namespace is None:
            raise MonitoringBoundaryError(MonitoringErrorCode.TARGET_UNSUPPORTED)
        entries = tuple(
            entry
            for entry in self._catalog.entries
            if (entry.target.api_version, entry.target.kind)
            == (target.api_version, target.kind)
        )
        if not entries:
            raise MonitoringBoundaryError(MonitoringErrorCode.TARGET_UNSUPPORTED)
        definitions = _rule_definition_reasons(entries, rules, at=at)
        # Rule evaluation uses wall time; PromQL samples use millisecond slots.
        at = _utc_now(at)
        inputs = _reconciliation_inputs(facts)
        windows = {
            entry.alert_id: window
            for entry in entries
            if (definition := inputs.get(entry.alert_id)) is not None
            and (
                window := max(
                    (item.window_seconds for item in definition.specific), default=0
                )
            )
        }
        alerts, expressions, coverage = await self._read_current_checks(
            target, entries, inputs, at=at
        )
        ranges = await self._read_range_checks(inputs, windows, at=at)
        return _rule_observations(
            entries,
            rules,
            definitions,
            alerts=alerts,
            expressions=expressions,
            coverage=coverage,
            ranges=ranges,
            windows=windows,
        )

    async def _read_current_checks(
        self,
        target: KubernetesTarget,
        entries: tuple[AlertCatalogEntry, ...],
        inputs: dict[str, _RuleInputs],
        *,
        at: datetime,
    ) -> tuple[_QueryChecks, _QueryChecks, _QueryChecks]:
        observed = (_QueryChecks(), _QueryChecks(), _QueryChecks())
        # The batch itself, not only the HTTP semaphore, bounds queued work.
        for batch in batched(entries, 8, strict=False):
            names, queries = _current_alert_queries(target, batch, inputs, at=at)
            results = await asyncio.gather(
                *(
                    self._client.query_instant(query, at=at, lookback_seconds=60)
                    for query in queries
                ),
                return_exceptions=True,
            )
            for checks, result in zip(observed, results, strict=True):
                if isinstance(result, BaseException):
                    if not isinstance(result, MonitoringBoundaryError):
                        raise result
                    reason = _observation_failure(result)
                else:
                    try:
                        checks.values.update(_check_values(result, names, at=at))
                        reason = (
                            ObservationReason.INCOMPLETE if result.partial else None
                        )
                    except MonitoringBoundaryError as error:
                        reason = _observation_failure(error)
                if reason is not None:
                    checks.failures.update((name, reason) for name in names)
        return observed

    async def _read_range_checks(
        self,
        inputs: dict[str, _RuleInputs],
        windows: dict[str, int],
        *,
        at: datetime,
    ) -> _QueryChecks:
        observed = _QueryChecks()
        # Ten minutes / 15 seconds gives 41 points; eight rules remain within
        # the existing 512-sample ceiling. Missing grid points are never filled.
        for names in batched(windows, 8, strict=False):
            window = max(windows[name] for name in names)
            start = at - timedelta(seconds=window)
            query = _input_coverage_query(inputs, names, at=at, range_sample=True)
            try:
                result = await self._client.query_range(
                    query, start=start, end=at, step_seconds=15, lookback_seconds=60
                )
                if result.partial:
                    raise MonitoringBoundaryError(
                        MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID
                    )
                for series in result.series:
                    name = series.label("alertname")
                    if name not in names or len(series.labels) != 1:
                        raise MonitoringBoundaryError(
                            MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID
                        )
                    required_window = windows[name]
                    required_start = at - timedelta(seconds=required_window)
                    samples = tuple(
                        sample
                        for sample in series.samples
                        if sample.timestamp >= required_start
                    )
                    expected = tuple(
                        required_start + timedelta(seconds=15 * index)
                        for index in range(required_window // 15 + 1)
                    )
                    observed.values[name] = float(
                        tuple(sample.timestamp for sample in samples) == expected
                        and all(sample.value == 1 for sample in samples)
                    )
            except MonitoringBoundaryError as error:
                observed.failures.update(
                    (name, _observation_failure(error)) for name in names
                )
        return observed

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
        names = self._catalog.recovery_alerts("set_container_image")
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
            self._client.read_alert_rules((*names, "Watchdog")),
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
        health_ids = tuple(entry.alert_id for entry in self._catalog.health_entries)

        async def query(expression: str) -> PrometheusQueryResult:
            return await self._client.query_instant(
                expression,
                at=checked_at,
                lookback_seconds=_HEALTH_LOOKBACK_SECONDS,
            )

        # An empty firing set only means healthy when every registered health
        # rule is loaded and evaluating; a missing rule fails the rules read.
        up, watchdog, firing, rules = await asyncio.gather(
            query(_UP_QUERY),
            query(_WATCHDOG_QUERY),
            query(_firing_since_query(health_ids)),
            self._client.read_alert_rules((*health_ids, "Watchdog")),
        )
        received_at = _utc_now(self._now())
        return PrometheusHealthSignals(
            checked_at=checked_at,
            partial=up.partial or watchdog.partial or firing.partial,
            kube_state_metrics_available=_single_up(up, "kube-state-metrics"),
            alertmanager_available=_single_up(up, "alertmanager"),
            watchdog_rule_firing=_watchdog_firing(watchdog),
            health_rules_evaluating=all(
                rule.health == "ok" and _fresh(rule.last_evaluation, received_at)
                for rule in rules
            ),
            firing_health_alerts=_firing_health_alerts(firing, health_ids),
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
        minimum = int(match.group(2)) * (60 if match.group(3) == "m" else 1)
        seconds = max(minimum, step_seconds)
        return f"{seconds}s" if match.group(1) == "range" else str(seconds)

    return RANGE_PLACEHOLDER.sub(
        rolling_range,
        template.replace(
            "{{namespace}}", _escape_promql_label_value(namespace)
        ).replace("{{name}}", _escape_promql_label_value(target.name)),
    )


def _escape_promql_label_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _firing_since_query(alert_ids: tuple[str, ...]) -> str:
    names = _escape_promql_label_value("|".join(re.escape(name) for name in alert_ids))
    # ALERTS_FOR_STATE carries when each alert became active; the join keeps only
    # alerts past their `for` duration, so pending health rules are not reported.
    return (
        f'min by (alertname) (ALERTS_FOR_STATE{{alertname=~"{names}"}} '
        f'and ignoring(alertstate) ALERTS{{alertname=~"{names}",alertstate="firing"}})'
    )


def _firing_health_alerts(
    result: PrometheusQueryResult,
    alert_ids: tuple[str, ...],
) -> tuple[FiringHealthAlert, ...]:
    alerts: list[FiringHealthAlert] = []
    for series in result.series:
        name = series.label("alertname")
        if len(series.labels) != 1 or name not in alert_ids:
            raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
        alerts.append(
            FiringHealthAlert(
                alert_id=name,
                active_since=_sample_time(series.samples[-1].value),
            )
        )
    return tuple(sorted(alerts, key=lambda alert: alert.alert_id))


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


@dataclass(frozen=True, slots=True)
class _RawInput:
    selector: str
    since: datetime | None
    count: int = 1
    value: float | None = None
    window_seconds: int = 0
    absent_counter: bool = False
    whole_seconds: bool = False


@dataclass(frozen=True, slots=True)
class _RuleInputs:
    common: tuple[_RawInput, ...] = ()
    specific: tuple[_RawInput, ...] = ()


@dataclass(slots=True)
class _QueryChecks:
    values: dict[str, float] = field(default_factory=dict[str, float])
    failures: dict[str, ObservationReason] = field(
        default_factory=dict[str, ObservationReason]
    )


def _rule_definition_reasons(
    entries: tuple[AlertCatalogEntry, ...],
    rules: dict[str, PrometheusRule | ObservationReason],
    *,
    at: datetime,
) -> dict[str, ObservationReason | None]:
    definitions: dict[str, ObservationReason | None] = {}
    for entry in entries:
        rule = rules.get(entry.alert_id, ObservationReason.RULE_MISMATCH)
        reason = rule if isinstance(rule, ObservationReason) else None
        if isinstance(rule, PrometheusRule):
            if (
                rule.query != entry.rule.expression
                or rule.duration != entry.rule.duration_seconds
                or rule.keep_firing_for != entry.rule.keep_firing_seconds
                or rule.labels != (("severity", "warning"),)
            ):
                reason = ObservationReason.RULE_MISMATCH
            elif rule.health != "ok" or not _fresh(rule.last_evaluation, at):
                reason = ObservationReason.STALE
        definitions[entry.alert_id] = reason
    return definitions


def _current_alert_queries(
    target: KubernetesTarget,
    entries: tuple[AlertCatalogEntry, ...],
    inputs: dict[str, _RuleInputs],
    *,
    at: datetime,
) -> tuple[tuple[str, ...], tuple[str, str, str]]:
    names = tuple(entry.alert_id for entry in entries)
    selector = _selector(
        "ALERTS",
        {
            "namespace": target.namespace or "",
            entries[0].target.name_label: target.name,
        },
        f'alertname=~"{"|".join(names)}",alertstate=~"pending|firing"',
    )
    pending = selector.replace('alertstate=~"pending|firing"', 'alertstate="pending"')
    firing = selector.replace('alertstate=~"pending|firing"', 'alertstate="firing"')
    alerts = (
        f"max by(alertname) (({pending}) or (2 * {firing})) * on(alertname) "
        f"min by(alertname) ((timestamp({selector}) >= bool (time() - 60)) "
        f"* (timestamp({selector}) <= bool time()))"
    )
    expressions = " or ".join(
        _named_check(
            f"count(({entry.rule.expression}) and on(namespace, {entry.target.name_label}) "
            f"{_target_vector(target, entry)})",
            entry.alert_id,
        )
        for entry in entries
    )
    return names, (alerts, expressions, _input_coverage_query(inputs, names, at=at))


def _input_coverage_query(
    inputs: dict[str, _RuleInputs],
    names: tuple[str, ...],
    *,
    at: datetime,
    range_sample: bool = False,
) -> str:
    groups: dict[tuple[_RawInput, ...], list[str]] = {}
    for name in names:
        definition = inputs.get(name)
        common = (
            definition.common if definition is not None and not range_sample else ()
        )
        specific = (
            tuple(
                item
                for item in definition.specific
                if not range_sample or item.window_seconds
            )
            if definition is not None
            else None
        )
        groups.setdefault(common, []).append(
            _named_check(
                _input_checks(specific, at=at, range_sample=range_sample), name
            )
        )
    queries: list[str] = []
    for common, checks in groups.items():
        query = " or ".join(checks)
        if common:
            # One unlabeled ownership proof gates every rule in this group;
            # rule-specific failures retain their own alertname and value.
            query = f"({_input_checks(common, at=at)}) * on() group_right() ({query})"
        queries.append(f"({query})")
    return " or ".join(queries)


def _rule_observations(
    entries: tuple[AlertCatalogEntry, ...],
    rules: dict[str, PrometheusRule | ObservationReason],
    definitions: dict[str, ObservationReason | None],
    *,
    alerts: _QueryChecks,
    expressions: _QueryChecks,
    coverage: _QueryChecks,
    ranges: _QueryChecks,
    windows: dict[str, int],
) -> tuple[RuleAlertObservation, ...]:
    observed: list[RuleAlertObservation] = []
    for entry in entries:
        name = entry.alert_id
        rule = rules.get(name, ObservationReason.RULE_MISMATCH)
        reason = definitions[name]
        for dependency in {
            "K8sIncidentContainerOOMKilled": ("K8sIncidentCrashLoopBackOff",),
            "K8sIncidentContainerAbnormalExit": (
                "K8sIncidentCrashLoopBackOff",
                "K8sIncidentLivenessProbeRestart",
                "K8sIncidentContainerOOMKilled",
                "K8sIncidentContainerProbeFailing",
            ),
        }.get(name, ()):
            reason = reason or definitions[dependency]
        for checks in (alerts, expressions, coverage, ranges):
            reason = reason or checks.failures.get(name)
        active = alerts.values.get(name)
        state = (
            CurrentAlertState.FIRING
            if active == 2
            else CurrentAlertState.PENDING
            if active == 1
            else CurrentAlertState.UNKNOWN
        )
        if active == 0:
            reason = reason or ObservationReason.STALE
        elif active not in (None, 1, 2):
            reason = reason or ObservationReason.INCOMPLETE
        if coverage.values.get(name) != 1 or (
            name in windows and ranges.values.get(name) != 1
        ):
            reason = reason or ObservationReason.INPUT_MISSING
        if active is None:
            if name in expressions.values:
                reason = reason or ObservationReason.WAITING_EVALUATION
            elif reason is None:
                state = CurrentAlertState.CLEAR
        observed.append(
            RuleAlertObservation(
                alert_id=name,
                state=state,
                complete=reason is None,
                reason=reason,
                evaluated_at=rule.last_evaluation
                if isinstance(rule, PrometheusRule)
                else None,
            )
        )
    return tuple(observed)


def _selector(metric: str, labels: dict[str, str], extra: str = "") -> str:
    matchers = [
        f'{key}="{_escape_promql_label_value(value)}"' for key, value in labels.items()
    ]
    if extra:
        matchers.append(extra)
    return f"{metric}{{{','.join(matchers)}}}"


def _named_check(expression: str, name: str) -> str:
    return f'label_replace(({expression}), "alertname", "{name}", "", "")'


def _target_vector(target: KubernetesTarget, entry: AlertCatalogEntry) -> str:
    return (
        f'label_replace(label_replace(vector(1), "namespace", "{_escape_promql_label_value(target.namespace or "")}", "", ""), '
        f'"{entry.target.name_label}", "{_escape_promql_label_value(target.name)}", "", "")'
    )


def _input_checks(
    inputs: tuple[_RawInput, ...] | None, *, at: datetime, range_sample: bool = False
) -> str:
    if inputs is None:
        return "vector(0)"
    checks: list[str] = []
    for item in inputs:
        if item.since is None or item.since > at - timedelta(
            seconds=item.window_seconds
        ):
            return "vector(0)"
        selector = item.selector
        count = f"(count({selector}) or vector(0))"
        check = f"({count} == bool {item.count})"
        if item.count:
            valid = f"timestamp({selector}) >= (time() - 60)"
            valid = f"({valid}) and (timestamp({selector}) <= time())"
            valid = (
                f"({valid}) and (timestamp({selector}) >= {item.since.timestamp():.3f})"
            )
            check += f" * ((count({valid}) or vector(0)) == bool {item.count})"
            if item.value is not None and not range_sample:
                value = f"floor({selector})" if item.whole_seconds else selector
                check += f" * ((count({value} == {item.value}) or vector(0)) == bool {item.count})"
            if item.window_seconds and not range_sample:
                check += f" * ((count(count_over_time({selector}[{item.window_seconds}s]) >= 2) or vector(0)) == bool {item.count})"
        if item.absent_counter:
            # A never-created failed counter is normal. This alternative is
            # valid only with the separately required, UID-bound probe producer.
            absent = f"absent_over_time({selector}[{item.window_seconds}s] @ {at.timestamp():.3f})"
            check = f"((({check}) == 1) or max({absent}))"
        checks.append(f"({check})")
    return " * ".join(checks) if checks else "vector(1)"


def _check_values(
    result: PrometheusQueryResult, names: tuple[str, ...], *, at: datetime
) -> dict[str, float]:
    values: dict[str, float] = {}
    for series in result.series:
        name = series.label("alertname")
        if (
            name not in names
            or len(series.labels) != 1
            or name in values
            or series.samples[-1].timestamp != at
        ):
            raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
        values[name] = series.samples[-1].value
    return values


def _observation_failure(error: MonitoringBoundaryError) -> ObservationReason:
    return {
        MonitoringErrorCode.REQUEST_TIMEOUT: ObservationReason.REQUEST_TIMEOUT,
        MonitoringErrorCode.UNAVAILABLE: ObservationReason.UNAVAILABLE,
        MonitoringErrorCode.RESULT_BUDGET_EXCEEDED: ObservationReason.BUDGET_EXCEEDED,
    }.get(error.code, ObservationReason.INCOMPLETE)


def _reconciliation_inputs(
    facts: CurrentTargetFacts,
) -> dict[str, _RuleInputs]:
    """Project only registered raw dependencies from the current SDK identities.

    Each expected object/container gets its own cardinality check before any
    aggregation. An extra series cannot compensate for a missing identity.
    """
    reference = facts.target_ref
    namespace = reference.namespace
    created = facts.created_at
    source = {"job": "kube-state-metrics", "namespace": namespace}
    if facts.claim is not None:
        labels = {**source, "persistentvolumeclaim": reference.name}
        return {
            "K8sIncidentPersistentVolumeClaimPending": _RuleInputs(
                specific=(
                    _RawInput(
                        _selector("kube_persistentvolumeclaim_created", labels),
                        created,
                        value=float(int(created.timestamp())) if created else None,
                    ),
                    _RawInput(
                        _selector(
                            "kube_persistentvolumeclaim_status_phase",
                            {**labels, "phase": "Pending"},
                        ),
                        created,
                        value=float(facts.claim.phase == "Pending"),
                    ),
                    _RawInput(
                        _selector(
                            "kube_persistentvolumeclaim_labels",
                            {
                                **labels,
                                "label_k8s_incident_agent_io_pending_policy": facts.pending_policy
                                or "",
                            },
                        ),
                        created,
                        value=1,
                    ),
                )
            )
        }
    if facts.service is not None:
        service = facts.service
        labels = {**source, "service": reference.name, "uid": reference.uid}
        inputs = [
            _RawInput(
                _selector(
                    "kube_service_labels",
                    {
                        **labels,
                        "label_k8s_incident_agent_io_monitor_selector": "true"
                        if service.service.monitoring_enabled
                        else "",
                    },
                ),
                created,
                value=1,
            ),
            _RawInput(
                _selector(
                    "kube_service_spec_type",
                    {**labels, "type": service.service.service_type},
                ),
                created,
                value=1,
            ),
            _RawInput(_selector("kube_service_info", labels), created, value=1),
        ]
        for candidate in service.candidate_pods:
            inputs.append(
                _RawInput(
                    _selector(
                        "kube_pod_labels",
                        {
                            **source,
                            "pod": candidate.pod_ref.name,
                            "uid": candidate.pod_ref.uid,
                            "label_k8s_incident_agent_io_service": reference.name,
                        },
                    ),
                    created,
                    value=1,
                )
            )
        for item in service.endpoint_slices:
            slice_labels = {**source, "endpointslice": item.endpoint_slice_ref.name}
            inputs.append(
                _RawInput(
                    _selector(
                        "kube_endpointslice_labels",
                        {
                            **slice_labels,
                            "label_kubernetes_io_service_name": reference.name,
                        },
                    ),
                    created,
                    value=1,
                )
            )
            inputs.extend(
                _RawInput(
                    _selector(
                        "kube_endpointslice_endpoints", {**slice_labels, "ready": ready}
                    ),
                    created,
                    count=count,
                    value=1,
                )
                for ready, count in facts.endpoint_sample_counts[
                    item.endpoint_slice_ref.name
                ].items()
            )
        return {
            "K8sIncidentServiceEndpointsUnavailable": _RuleInputs(
                specific=tuple(inputs)
            )
        }
    workload = facts.workload
    if workload is None:
        return {}
    deployment = {**source, "deployment": reference.name}
    result: dict[str, _RuleInputs] = {
        "K8sIncidentDeploymentReplicasUnavailable": _RuleInputs(
            specific=(
                _RawInput(
                    _selector("kube_deployment_spec_replicas", deployment),
                    created,
                    value=float(workload.replicas.desired),
                ),
                _RawInput(
                    _selector("kube_deployment_status_replicas_available", deployment),
                    created,
                    value=float(workload.replicas.available),
                ),
            )
        )
    }
    if not facts.pods:
        return result
    common: list[_RawInput] = []
    dependencies: dict[str, list[_RawInput]] = {
        name: []
        for name in (
            "ImagePullBackOff",
            "CrashLoopBackOff",
            "ReadinessProbeFailure",
            "LivenessProbeRestart",
            "ContainerOOMKilled",
            "ContainerAbnormalExit",
            "ContainerMemoryNearLimit",
            "ContainerCPUThrottled",
            "ContainerProbeFailing",
            "PodUnschedulable",
        )
    }
    for current in facts.pods:
        pod = current.pod
        labels = {**source, "pod": pod.name, "uid": pod.uid}
        common.append(
            _RawInput(
                _selector(
                    "kube_pod_owner",
                    {
                        **labels,
                        "owner_kind": "ReplicaSet",
                        "owner_is_controller": "true",
                        "owner_name": pod.owner.name,
                    },
                ),
                current.created_at,
                value=1,
            )
        )
        common.append(
            _RawInput(
                _selector(
                    "kube_replicaset_owner",
                    {
                        **source,
                        "replicaset": pod.owner.name,
                        "owner_kind": "Deployment",
                        "owner_is_controller": "true",
                        "owner_name": reference.name,
                    },
                ),
                created,
                value=1,
            )
        )
        monitored = {
            key: current.monitoring_labels.get(f"k8s-incident-agent.io/{key}", "")
            for key in ("readiness-container", "readiness-slo", "liveness-container")
        }
        pod_labels = _RawInput(
            _selector(
                "kube_pod_labels",
                {
                    **labels,
                    **{
                        f"label_k8s_incident_agent_io_{key.replace('-', '_')}": value
                        for key, value in monitored.items()
                    },
                },
            ),
            current.created_at,
            value=1,
        )
        for name in (
            "ReadinessProbeFailure",
            "LivenessProbeRestart",
            "ContainerProbeFailing",
        ):
            dependencies[name].append(pod_labels)
        scheduled = next(
            (item.status for item in pod.conditions if item.type == "PodScheduled"),
            None,
        )
        dependencies["PodUnschedulable"].append(
            _RawInput(
                _selector("kube_pod_status_unschedulable", labels),
                current.created_at if scheduled in ("True", "False") else None,
                count=1 if scheduled == "False" else 0,
                value=1,
            )
        )
        for container in pod.containers:
            identity = {**labels, "container": container.name}
            since = current.created_at
            running = _RawInput(
                _selector("kube_pod_container_status_running", identity),
                since if container.state.status != "unknown" else None,
                value=float(container.state.status == "running"),
            )
            waiting = _RawInput(
                _selector(
                    "kube_pod_container_status_waiting_reason",
                    {
                        **identity,
                        **(
                            {"reason": container.state.reason}
                            if container.state.status == "waiting"
                            and container.state.reason
                            else {}
                        ),
                    },
                ),
                since,
                count=1 if container.state.status == "waiting" else 0,
                value=1,
            )
            restarts = _selector("kube_pod_container_status_restarts_total", identity)
            dependencies["ImagePullBackOff"].extend((running, waiting))
            dependencies["CrashLoopBackOff"].extend(
                (
                    running,
                    waiting,
                    _RawInput(
                        restarts,
                        since,
                        value=float(container.restart_count)
                        if container.restart_count is not None
                        else None,
                    ),
                )
            )
            if (
                monitored["readiness-container"] == container.name
                and monitored["readiness-slo"] == "2m"
            ):
                ready = current.container_ready.get(container.name)
                dependencies["ReadinessProbeFailure"].extend(
                    (
                        running,
                        _RawInput(
                            _selector("kube_pod_container_status_ready", identity),
                            since if ready is not None else None,
                            value=float(bool(ready)),
                        ),
                    )
                )
            if monitored["liveness-container"] == container.name:
                dependencies["LivenessProbeRestart"].append(
                    _RawInput(restarts, since, window_seconds=300)
                )
            previous = container.last_state
            terminated = previous is not None and previous.status == "terminated"
            termination = _RawInput(
                _selector(
                    "kube_pod_container_status_last_terminated_reason",
                    {
                        **identity,
                        **(
                            {"reason": previous.reason}
                            if terminated and previous and previous.reason
                            else {}
                        ),
                    },
                ),
                since,
                count=int(terminated),
                value=1,
            )
            dependencies["ContainerOOMKilled"].append(termination)
            dependencies["ContainerAbnormalExit"].extend(
                (termination, _RawInput(restarts, since, window_seconds=600))
            )
            if terminated:
                ended = (
                    datetime.fromisoformat(previous.finished_at)
                    if previous and previous.finished_at
                    else None
                )
                dependencies["ContainerOOMKilled"].append(
                    _RawInput(
                        _selector(
                            "kube_pod_container_status_last_terminated_timestamp",
                            identity,
                        ),
                        since if ended else None,
                        value=float(int(ended.timestamp())) if ended else None,
                    )
                )
            # Kubelet series without UID must belong to this running container
            # lifetime; limits alone cannot prove that CFS quota is available.
            started = (
                datetime.fromisoformat(container.state.started_at)
                if container.state.started_at
                else None
            )
            kubelet = {
                "namespace": namespace,
                "pod": pod.name,
                "container": container.name,
            }
            start_input = _RawInput(
                _selector(
                    "container_start_time_seconds",
                    {**kubelet, "job": "kubelet-resource"},
                ),
                started,
                # Resource metrics retain nanoseconds; Kubernetes API Time
                # serializes seconds. Freshness still reads the raw timestamp.
                value=float(int(started.timestamp())) if started else None,
                whole_seconds=True,
            )
            resources = container.configured_resources
            memory = resources.limits.memory_bytes if resources else None
            memory_limit = _RawInput(
                _selector(
                    "kube_pod_container_resource_limits",
                    {**identity, "resource": "memory"},
                ),
                since,
                count=int(memory is not None),
                value=memory,
            )
            dependencies["ContainerMemoryNearLimit"].append(memory_limit)
            if memory is not None and memory > 0:
                dependencies["ContainerMemoryNearLimit"].extend(
                    (
                        start_input,
                        _RawInput(
                            _selector(
                                "container_memory_working_set_bytes",
                                {**kubelet, "job": "kubelet-resource"},
                            ),
                            started,
                        ),
                    )
                )
            container_id = current.container_ids.get(container.name)
            runtime, _, current_id = (container_id or "").partition("://")
            pod_path = re.escape(pod.uid)
            systemd_pod = re.escape(pod.uid.replace("-", "_"))
            cgroup = (
                f"(.*/)?(pod{pod_path}|kubepods(-burstable|-besteffort)?-pod{systemd_pod}\\.slice)/"
                f"({re.escape(current_id)}|cri-containerd-{re.escape(current_id)}\\.scope)"
            )
            for metric in (
                "container_cpu_cfs_periods_total",
                "container_cpu_cfs_throttled_periods_total",
            ):
                # The catalog sums all cgroups for a container name. An old
                # cgroup must not dilute the current container's ratio.
                dependencies["ContainerCPUThrottled"].append(
                    _RawInput(
                        _selector(metric, {**kubelet, "job": "kubelet-cadvisor"}),
                        started,
                        window_seconds=300,
                    )
                )
                dependencies["ContainerCPUThrottled"].append(
                    _RawInput(
                        _selector(
                            metric,
                            {**kubelet, "job": "kubelet-cadvisor"},
                            f'id=~"{_escape_promql_label_value(cgroup)}"',
                        ),
                        started if runtime == "containerd" and current_id else None,
                        window_seconds=300,
                    )
                )
            probes = current.container_probes.get(container.name, [])
            excluded = (
                monitored["readiness-container"] == container.name
                and monitored["readiness-slo"] == "2m"
            ) or monitored["liveness-container"] == container.name
            if probes and not excluded:
                dependencies["ContainerProbeFailing"].append(
                    _RawInput(
                        _selector("kube_pod_container_state_started", identity),
                        started,
                        value=float(int(started.timestamp())) if started else None,
                    )
                )
                for probe in probes:
                    probe_labels = {
                        **kubelet,
                        "job": "kubelet-probes",
                        "pod_uid": pod.uid,
                        "probe_type": probe.probe_kind.title(),
                    }
                    dependencies["ContainerProbeFailing"].extend(
                        (
                            _RawInput(
                                _selector(
                                    "prober_probe_total",
                                    {**probe_labels, "result": "successful"},
                                ),
                                started,
                                window_seconds=300,
                            ),
                            _RawInput(
                                _selector(
                                    "prober_probe_total",
                                    {**probe_labels, "result": "failed"},
                                ),
                                started,
                                window_seconds=300,
                                absent_counter=True,
                            ),
                        )
                    )
        container_names = {item.name for item in pod.containers}
        for label, rule in (
            ("readiness-container", "ReadinessProbeFailure"),
            ("liveness-container", "LivenessProbeRestart"),
        ):
            if monitored[label] and monitored[label] not in container_names:
                dependencies[rule].append(_RawInput("vector(0)", None))
    ownership = tuple(dict.fromkeys(common))
    for name, items in dependencies.items():
        result[f"K8sIncident{name}"] = _RuleInputs(
            common=ownership, specific=tuple(items)
        )
    return result
