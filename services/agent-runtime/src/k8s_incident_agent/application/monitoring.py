from collections.abc import Callable
from datetime import UTC, datetime
from uuid import UUID

from k8s_incident_agent.application.incidents import IncidentNotFoundError
from k8s_incident_agent.monitoring.catalog import AlertCatalog, AlertCatalogEntry
from k8s_incident_agent.monitoring.contracts import (
    WATCHDOG_STALE_AFTER,
    IncidentMetricPanel,
    IncidentMonitoringPanels,
    MetricMarker,
    MetricMarkerKind,
    MetricPanelSignalRole,
    MetricRiskDirection,
    MetricSeriesBinding,
    MetricTimeAnchor,
    MetricWindow,
    MonitoringComponentState,
    MonitoringHealthAlert,
    MonitoringHealthSnapshot,
    MonitoringOverallState,
    MonitoringOverviewCounts,
    MonitoringOverviewFamily,
    MonitoringOverviewSample,
    MonitoringOverviewSnapshot,
    MonitoringPanelReference,
)
from k8s_incident_agent.monitoring.errors import (
    MonitoringBoundaryError,
    MonitoringErrorCode,
)
from k8s_incident_agent.monitoring.service import (
    MetricRange,
    PrometheusQueryService,
    resolve_metric_range,
)
from k8s_incident_agent.persistence.repositories import (
    IncidentMonitoringContext,
    IncidentRepository,
)
from k8s_incident_agent.scenarios.contracts import PublicScenario

_MARKER_RUN_LIMIT = 50


class MonitoringPanelNotFoundError(RuntimeError):
    pass


class MonitoringAnchorInvalidError(RuntimeError):
    """The anchor and runId query parameters do not form a registered anchor."""


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
                health_alerts=(),
            )

        prometheus = (
            MonitoringComponentState.DEGRADED
            if signals.partial
            else MonitoringComponentState.HEALTHY
        )
        health_alerts = tuple(
            MonitoringHealthAlert(
                alert_id=alert.alert_id,
                display_name=entry.display_name,
                component=entry.component,
                active_since=alert.active_since,
            )
            for alert in signals.firing_health_alerts
            if (entry := self._catalog.find_health(alert.alert_id)) is not None
        )
        components_alerting = {alert.component for alert in health_alerts}
        # This node stands for the whole collection path shown as "指标采集":
        # KSM reachability plus collection health rules, including kubelet jobs.
        kube_state_metrics = (
            MonitoringComponentState.UNAVAILABLE
            if not signals.kube_state_metrics_available
            else MonitoringComponentState.DEGRADED
            if "collection" in components_alerting
            else MonitoringComponentState.HEALTHY
        )
        rule_evaluation = (
            MonitoringComponentState.HEALTHY
            if signals.watchdog_rule_firing
            and signals.health_rules_evaluating
            and "rules" not in components_alerting
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
            health_alerts=health_alerts,
        )

    async def get_overview(self) -> MonitoringOverviewSnapshot:
        generated_at = self._now()
        overview = await self._repository.get_monitoring_overview(generated_at)
        families: list[MonitoringOverviewFamily] = []
        for family in overview.families:
            entry = self._catalog.find(family.source_ref)
            families.append(
                MonitoringOverviewFamily(
                    source_ref=family.source_ref,
                    display_name=(
                        entry.display_name if entry is not None else family.source_ref
                    ),
                    count=family.count,
                )
            )
        return MonitoringOverviewSnapshot(
            generated_at=generated_at,
            counts=MonitoringOverviewCounts(
                total_incidents=overview.total_incidents,
                firing_alerts=overview.firing_alerts,
                triaging_incidents=overview.triaging_incidents,
                waiting_approval_incidents=overview.waiting_approval_incidents,
            ),
            families=tuple(families),
            samples=tuple(
                MonitoringOverviewSample(
                    timestamp=sample.timestamp,
                    incidents_created=sample.incidents_created,
                    alert_conditions_resolved=sample.alert_conditions_resolved,
                )
                for sample in overview.samples
            ),
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
                        title=panel.title,
                        unit=panel.unit,
                        purpose=panel.purpose,
                        series_binding=MetricSeriesBinding(panel.series_binding),
                        recommended_window=MetricWindow(panel.recommended_window),
                        risk_direction=MetricRiskDirection(panel.risk_direction),
                        signal_role=MetricPanelSignalRole(panel.signal_role),
                        threshold_duration=panel.threshold_duration,
                    )
                    for panel in self._catalog.default_panels(entry)
                )
            )
        )

    async def get_panel(
        self,
        incident_id: UUID,
        *,
        panel_id: str,
        window: MetricWindow,
        anchor: MetricTimeAnchor = MetricTimeAnchor.CURRENT,
        run_id: UUID | None = None,
    ) -> IncidentMetricPanel:
        if (anchor is MetricTimeAnchor.RUN) is not (run_id is not None):
            raise MonitoringAnchorInvalidError
        context = await self._monitoring_context(
            incident_id,
            run_limit=_MARKER_RUN_LIMIT,
        )
        entry = self._entry_for_context(context)
        if entry is None or all(
            panel.panel_id != panel_id for panel in self._catalog.default_panels(entry)
        ):
            raise MonitoringPanelNotFoundError
        queried_at = self._now()
        metric_range = resolve_metric_range(
            window,
            anchor,
            queried_at=queried_at,
            occurred_at=context.occurred_at,
            run_completed_at=_anchored_run_completion(context, run_id),
        )
        try:
            result = await self._prometheus.query_panel(
                target=context.target,
                panel_id=panel_id,
                window=window,
                metric_range=metric_range,
                queried_at=queried_at,
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
            markers=_panel_markers(context, metric_range),
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
        or checked_at - last_watchdog > WATCHDOG_STALE_AFTER
    ):
        return MonitoringComponentState.STALE
    return MonitoringComponentState.HEALTHY


def _anchored_run_completion(
    context: IncidentMonitoringContext,
    run_id: UUID | None,
) -> datetime | None:
    """Completion time of the exact Run named by the caller, or None while it runs.

    Only Runs of this Incident are acceptable anchors; a foreign or unknown Run id
    is reported as not found so the Console cannot read another Incident's window.
    """
    if run_id is None:
        return None
    run = next((item for item in context.runs if item.id == run_id), None)
    if run is None:
        raise MonitoringPanelNotFoundError
    return run.completed_at


def _panel_markers(
    context: IncidentMonitoringContext,
    metric_range: MetricRange,
) -> tuple[MetricMarker, ...]:
    start, queried_at = metric_range.start, metric_range.end
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
