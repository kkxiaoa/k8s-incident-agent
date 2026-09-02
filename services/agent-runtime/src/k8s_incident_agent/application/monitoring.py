from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from uuid import UUID

from k8s_incident_agent.application.incidents import IncidentNotFoundError
from k8s_incident_agent.monitoring.catalog import AlertCatalog, AlertCatalogEntry
from k8s_incident_agent.monitoring.contracts import (
    IncidentMetricPanel,
    IncidentMonitoringPanels,
    MetricMarker,
    MetricMarkerKind,
    MetricWindow,
    MonitoringComponentState,
    MonitoringHealthSnapshot,
    MonitoringOverallState,
    MonitoringPanelReference,
)
from k8s_incident_agent.monitoring.errors import (
    MonitoringBoundaryError,
    MonitoringErrorCode,
)
from k8s_incident_agent.monitoring.service import PrometheusQueryService
from k8s_incident_agent.persistence.repositories import (
    IncidentMonitoringContext,
    IncidentRepository,
)
from k8s_incident_agent.scenarios.contracts import PublicScenario

_WATCHDOG_STALE_AFTER = timedelta(minutes=6)
_MARKER_RUN_LIMIT = 50


class MonitoringPanelNotFoundError(RuntimeError):
    pass


class MonitoringApplicationService:
    def __init__(
        self,
        *,
        catalog: AlertCatalog,
        scenarios: tuple[PublicScenario, ...],
        prometheus: PrometheusQueryService,
        repository: IncidentRepository,
        now: Callable[[], datetime],
    ) -> None:
        self._catalog = catalog
        self._scenario_sources = {
            scenario.scenario_id: (
                str(scenario.scenario_version),
                scenario.monitoring_alert_id,
            )
            for scenario in scenarios
        }
        if len(self._scenario_sources) != len(scenarios):
            raise ValueError("Scenario catalog contains duplicate identifiers")
        for scenario in scenarios:
            entry = catalog.find(scenario.monitoring_alert_id)
            if (
                entry is None
                or scenario.target.api_version != entry.target.api_version
                or scenario.target.kind != entry.target.kind
            ):
                raise ValueError("Scenario monitoring mapping is invalid")
        self._prometheus = prometheus
        self._repository = repository
        self._now = now

    async def get_health(self) -> MonitoringHealthSnapshot:
        last_watchdog = await self._repository.get_watchdog_last_received_at()
        try:
            signals = await self._prometheus.read_health_signals()
        except MonitoringBoundaryError as error:
            unavailable = error.code in {
                MonitoringErrorCode.REQUEST_TIMEOUT,
                MonitoringErrorCode.UNAVAILABLE,
            }
            return MonitoringHealthSnapshot(
                state=(
                    MonitoringOverallState.UNAVAILABLE
                    if unavailable
                    else MonitoringOverallState.DEGRADED
                ),
                checked_at=self._now(),
                prometheus=(
                    MonitoringComponentState.UNAVAILABLE
                    if unavailable
                    else MonitoringComponentState.DEGRADED
                ),
                kube_state_metrics=MonitoringComponentState.UNKNOWN,
                rule_evaluation=MonitoringComponentState.UNKNOWN,
                alertmanager=MonitoringComponentState.UNKNOWN,
                notification=MonitoringComponentState.UNKNOWN,
                watchdog_last_received_at=last_watchdog,
            )

        prometheus = (
            MonitoringComponentState.DEGRADED
            if signals.partial
            else MonitoringComponentState.HEALTHY
        )
        kube_state_metrics = (
            MonitoringComponentState.HEALTHY
            if signals.kube_state_metrics_available
            else MonitoringComponentState.UNAVAILABLE
        )
        rule_evaluation = (
            MonitoringComponentState.HEALTHY
            if signals.watchdog_rule_firing
            else MonitoringComponentState.DEGRADED
        )
        alertmanager = (
            MonitoringComponentState.HEALTHY
            if signals.alertmanager_available
            else MonitoringComponentState.UNAVAILABLE
        )
        notification = _notification_state(
            checked_at=signals.checked_at,
            last_watchdog=last_watchdog,
            alertmanager_available=signals.alertmanager_available,
        )
        components = (
            prometheus,
            kube_state_metrics,
            rule_evaluation,
            alertmanager,
            notification,
        )
        return MonitoringHealthSnapshot(
            state=(
                MonitoringOverallState.HEALTHY
                if all(
                    component is MonitoringComponentState.HEALTHY
                    for component in components
                )
                else MonitoringOverallState.DEGRADED
            ),
            checked_at=signals.checked_at,
            prometheus=prometheus,
            kube_state_metrics=kube_state_metrics,
            rule_evaluation=rule_evaluation,
            alertmanager=alertmanager,
            notification=notification,
            watchdog_last_received_at=last_watchdog,
        )

    async def list_panels(self, incident_id: UUID) -> IncidentMonitoringPanels:
        context = await self._monitoring_context(incident_id, run_limit=1)
        entry = self._entry_for_context(context)
        return IncidentMonitoringPanels(
            panels=(
                ()
                if entry is None
                else tuple(
                    MonitoringPanelReference(
                        panel_id=panel.panel_id,
                        recommended_window=MetricWindow(panel.recommended_window),
                    )
                    for panel in entry.panels
                )
            )
        )

    async def get_panel(
        self,
        incident_id: UUID,
        *,
        panel_id: str,
        window: MetricWindow,
    ) -> IncidentMetricPanel:
        context = await self._monitoring_context(
            incident_id,
            run_limit=_MARKER_RUN_LIMIT,
        )
        entry = self._entry_for_context(context)
        if entry is None or all(panel.panel_id != panel_id for panel in entry.panels):
            raise MonitoringPanelNotFoundError
        try:
            result = await self._prometheus.query_panel(
                target=context.target,
                panel_id=panel_id,
                window=window,
            )
        except MonitoringBoundaryError as error:
            if error.code in {
                MonitoringErrorCode.PANEL_NOT_FOUND,
                MonitoringErrorCode.TARGET_UNSUPPORTED,
            }:
                raise MonitoringPanelNotFoundError from None
            raise
        return IncidentMetricPanel(
            result=result,
            markers=_panel_markers(context, result.queried_at, window),
            markers_truncated=context.runs_truncated,
        )

    async def _monitoring_context(
        self,
        incident_id: UUID,
        *,
        run_limit: int,
    ) -> IncidentMonitoringContext:
        context = await self._repository.get_incident_monitoring_context(
            incident_id,
            run_limit=run_limit,
        )
        if context is None:
            raise IncidentNotFoundError
        return context

    def _entry_for_context(
        self,
        context: IncidentMonitoringContext,
    ) -> AlertCatalogEntry | None:
        if context.source.type == "alertmanager":
            if context.source.revision != self._catalog.version:
                return None
            return self._catalog.find(context.source.ref)
        source = self._scenario_sources.get(context.source.ref)
        if source is None or source[0] != context.source.revision:
            return None
        return self._catalog.find(source[1])


def _notification_state(
    *,
    checked_at: datetime,
    last_watchdog: datetime | None,
    alertmanager_available: bool,
) -> MonitoringComponentState:
    if not alertmanager_available:
        return MonitoringComponentState.UNAVAILABLE
    if (
        last_watchdog is None
        or last_watchdog > checked_at
        or checked_at - last_watchdog > _WATCHDOG_STALE_AFTER
    ):
        return MonitoringComponentState.STALE
    return MonitoringComponentState.HEALTHY


def _panel_markers(
    context: IncidentMonitoringContext,
    queried_at: datetime,
    window: MetricWindow,
) -> tuple[MetricMarker, ...]:
    start = queried_at - window.duration
    markers: list[MetricMarker] = []
    signal = context.alert_signal
    if signal is not None:
        firing_at = _alert_timestamp(signal.starts_at)
        if start <= firing_at <= queried_at:
            markers.append(
                MetricMarker(
                    kind=MetricMarkerKind.ALERT_FIRING,
                    occurred_at=firing_at,
                )
            )
        if signal.ends_at is not None:
            resolved_at = _alert_timestamp(signal.ends_at)
            if start <= resolved_at <= queried_at:
                markers.append(
                    MetricMarker(
                        kind=MetricMarkerKind.ALERT_RESOLVED,
                        occurred_at=resolved_at,
                    )
                )
    for run in context.runs:
        if run.started_at is not None and start <= run.started_at <= queried_at:
            markers.append(
                MetricMarker(
                    kind=MetricMarkerKind.RUN_STARTED,
                    occurred_at=run.started_at,
                    run_attempt=run.attempt,
                )
            )
        if run.completed_at is not None and start <= run.completed_at <= queried_at:
            markers.append(
                MetricMarker(
                    kind=MetricMarkerKind.RUN_COMPLETED,
                    occurred_at=run.completed_at,
                    run_attempt=run.attempt,
                )
            )
    return tuple(
        sorted(
            markers,
            key=lambda marker: (
                marker.occurred_at,
                marker.kind.value,
                marker.run_attempt or 0,
            ),
        )
    )


def _alert_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    return parsed.astimezone(UTC)
