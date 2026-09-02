from datetime import UTC, datetime, timedelta
from typing import cast

import pytest

from k8s_incident_agent.application.monitoring import MonitoringHealthService
from k8s_incident_agent.monitoring.contracts import (
    MonitoringComponentState,
    MonitoringOverallState,
    PrometheusHealthSignals,
)
from k8s_incident_agent.monitoring.errors import (
    MonitoringBoundaryError,
    MonitoringErrorCode,
)
from k8s_incident_agent.monitoring.service import PrometheusQueryService
from k8s_incident_agent.persistence.repositories import IncidentRepository

NOW = datetime(2026, 9, 2, 9, 0, tzinfo=UTC)


class _Repository:
    def __init__(self, last_watchdog: datetime | None) -> None:
        self.last_watchdog = last_watchdog

    async def get_watchdog_last_received_at(self) -> datetime | None:
        return self.last_watchdog


class _Prometheus:
    def __init__(
        self,
        signals: PrometheusHealthSignals | None = None,
        error: MonitoringBoundaryError | None = None,
    ) -> None:
        self.signals = signals
        self.error = error

    async def read_health_signals(self) -> PrometheusHealthSignals:
        if self.error is not None:
            raise self.error
        assert self.signals is not None
        return self.signals


def _service(
    *,
    last_watchdog: datetime | None,
    signals: PrometheusHealthSignals | None = None,
    error: MonitoringBoundaryError | None = None,
) -> MonitoringHealthService:
    return MonitoringHealthService(
        prometheus=cast(PrometheusQueryService, _Prometheus(signals, error)),
        repository=cast(IncidentRepository, _Repository(last_watchdog)),
        now=lambda: NOW,
    )


@pytest.mark.asyncio
async def test_all_live_signals_are_reported_healthy() -> None:
    result = await _service(
        last_watchdog=NOW - timedelta(minutes=1),
        signals=PrometheusHealthSignals(
            checked_at=NOW,
            partial=False,
            kube_state_metrics_available=True,
            alertmanager_available=True,
            watchdog_rule_firing=True,
        ),
    ).get_health()

    assert result.state is MonitoringOverallState.HEALTHY
    assert {
        result.prometheus,
        result.kube_state_metrics,
        result.rule_evaluation,
        result.alertmanager,
        result.notification,
    } == {MonitoringComponentState.HEALTHY}
    assert result.watchdog_last_received_at == NOW - timedelta(minutes=1)


@pytest.mark.asyncio
async def test_broken_scrape_rule_alertmanager_and_notification_are_distinct() -> None:
    result = await _service(
        last_watchdog=NOW - timedelta(minutes=7),
        signals=PrometheusHealthSignals(
            checked_at=NOW,
            partial=True,
            kube_state_metrics_available=False,
            alertmanager_available=False,
            watchdog_rule_firing=False,
        ),
    ).get_health()

    assert result.state is MonitoringOverallState.DEGRADED
    assert result.prometheus is MonitoringComponentState.DEGRADED
    assert result.kube_state_metrics is MonitoringComponentState.UNAVAILABLE
    assert result.rule_evaluation is MonitoringComponentState.DEGRADED
    assert result.alertmanager is MonitoringComponentState.UNAVAILABLE
    assert result.notification is MonitoringComponentState.UNAVAILABLE


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "last_watchdog",
    [None, NOW - timedelta(minutes=7), NOW + timedelta(seconds=1)],
)
async def test_missing_stale_or_future_watchdog_marks_notification_stale(
    last_watchdog: datetime | None,
) -> None:
    result = await _service(
        last_watchdog=last_watchdog,
        signals=PrometheusHealthSignals(
            checked_at=NOW,
            partial=False,
            kube_state_metrics_available=True,
            alertmanager_available=True,
            watchdog_rule_firing=True,
        ),
    ).get_health()

    assert result.state is MonitoringOverallState.DEGRADED
    assert result.notification is MonitoringComponentState.STALE


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("code", "overall", "prometheus"),
    [
        (
            MonitoringErrorCode.REQUEST_TIMEOUT,
            MonitoringOverallState.UNAVAILABLE,
            MonitoringComponentState.UNAVAILABLE,
        ),
        (
            MonitoringErrorCode.UNAVAILABLE,
            MonitoringOverallState.UNAVAILABLE,
            MonitoringComponentState.UNAVAILABLE,
        ),
        (
            MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID,
            MonitoringOverallState.DEGRADED,
            MonitoringComponentState.DEGRADED,
        ),
    ],
)
async def test_prometheus_failure_keeps_other_components_unknown(
    code: MonitoringErrorCode,
    overall: MonitoringOverallState,
    prometheus: MonitoringComponentState,
) -> None:
    result = await _service(
        last_watchdog=NOW - timedelta(minutes=1),
        error=MonitoringBoundaryError(code),
    ).get_health()

    assert result.state is overall
    assert result.prometheus is prometheus
    assert result.kube_state_metrics is MonitoringComponentState.UNKNOWN
    assert result.rule_evaluation is MonitoringComponentState.UNKNOWN
    assert result.alertmanager is MonitoringComponentState.UNKNOWN
    assert result.notification is MonitoringComponentState.UNKNOWN
