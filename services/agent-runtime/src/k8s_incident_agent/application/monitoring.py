from collections.abc import Callable
from datetime import datetime, timedelta

from k8s_incident_agent.monitoring.contracts import (
    MonitoringComponentState,
    MonitoringHealthSnapshot,
    MonitoringOverallState,
)
from k8s_incident_agent.monitoring.errors import (
    MonitoringBoundaryError,
    MonitoringErrorCode,
)
from k8s_incident_agent.monitoring.service import PrometheusQueryService
from k8s_incident_agent.persistence.repositories import IncidentRepository

_WATCHDOG_STALE_AFTER = timedelta(minutes=6)


class MonitoringHealthService:
    def __init__(
        self,
        *,
        prometheus: PrometheusQueryService,
        repository: IncidentRepository,
        now: Callable[[], datetime],
    ) -> None:
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
