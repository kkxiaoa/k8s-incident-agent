from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
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


def _watchdog_firing(result: PrometheusQueryResult) -> bool:
    if len(result.series) > 1:
        raise MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
    return bool(result.series and result.series[0].samples[-1].value == 1)


def _utc_now(value: datetime) -> datetime:
    if value.utcoffset() is None:
        raise ValueError("Monitoring clock must include a timezone")
    utc_value = value.astimezone(UTC)
    return utc_value.replace(microsecond=(utc_value.microsecond // 1000) * 1000)
