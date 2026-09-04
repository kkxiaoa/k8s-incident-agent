from datetime import UTC, datetime, timedelta
from typing import Literal, cast
from uuid import UUID, uuid4

import pytest
from tests.factories import public_scenario

from k8s_incident_agent.application.incidents import IncidentNotFoundError
from k8s_incident_agent.application.monitoring import (
    MonitoringApplicationService,
    MonitoringPanelNotFoundError,
)
from k8s_incident_agent.domain.contracts import IncidentSource, KubernetesTarget
from k8s_incident_agent.domain.models import (
    AlertSignalRecord,
    AlertSignalStatus,
    CanonicalAlertTimestamp,
)
from k8s_incident_agent.monitoring.catalog import AlertCatalog, load_alert_catalog
from k8s_incident_agent.monitoring.contracts import (
    MetricMarkerKind,
    MetricPanelResult,
    MetricQueryState,
    MetricRiskDirection,
    MetricSample,
    MetricWindow,
    MonitoringComponentState,
    MonitoringOverallState,
    PrometheusHealthSignals,
)
from k8s_incident_agent.monitoring.errors import (
    MonitoringBoundaryError,
    MonitoringErrorCode,
)
from k8s_incident_agent.monitoring.service import PrometheusQueryService
from k8s_incident_agent.persistence.repositories import (
    IncidentMonitoringContext,
    IncidentRepository,
    MonitoringOverviewFamilyRecord,
    MonitoringOverviewRecord,
    MonitoringOverviewSampleRecord,
    MonitoringRunInterval,
)
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT

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


class _PanelPrometheus:
    def __init__(self, result: MetricPanelResult) -> None:
        self.result = result
        self.calls: list[tuple[KubernetesTarget, str, MetricWindow]] = []

    async def query_panel(
        self,
        *,
        target: KubernetesTarget,
        panel_id: str,
        window: MetricWindow,
    ) -> MetricPanelResult:
        self.calls.append((target, panel_id, window))
        return self.result


class _PanelRepository:
    def __init__(self, context: IncidentMonitoringContext | None) -> None:
        self.context = context
        self.run_limits: list[int] = []

    async def get_incident_monitoring_context(
        self,
        _incident_id: UUID,
        *,
        run_limit: int,
    ) -> IncidentMonitoringContext | None:
        self.run_limits.append(run_limit)
        return self.context


class _OverviewRepository:
    def __init__(self, overview: MonitoringOverviewRecord) -> None:
        self.overview = overview
        self.generated_at: datetime | None = None

    async def get_monitoring_overview(
        self,
        generated_at: datetime,
    ) -> MonitoringOverviewRecord:
        self.generated_at = generated_at
        return self.overview


def _service(
    *,
    last_watchdog: datetime | None,
    signals: PrometheusHealthSignals | None = None,
    error: MonitoringBoundaryError | None = None,
) -> MonitoringApplicationService:
    return MonitoringApplicationService(
        catalog=AlertCatalog(version="test", entries=()),
        scenarios=(),
        prometheus=cast(PrometheusQueryService, _Prometheus(signals, error)),
        repository=cast(IncidentRepository, _Repository(last_watchdog)),
        now=lambda: NOW,
    )


def _alert_catalog() -> AlertCatalog:
    return load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog")


def _monitoring_context(
    *,
    source_type: Literal["scenario", "alertmanager"] = "alertmanager",
    source_ref: str = "K8sIncidentImagePullBackOff",
    source_revision: str | None = None,
    runs_truncated: bool = True,
) -> IncidentMonitoringContext:
    catalog = _alert_catalog()
    return IncidentMonitoringContext(
        source=IncidentSource(
            type=source_type,
            ref=source_ref,
            revision=source_revision or catalog.version,
        ),
        target=KubernetesTarget(
            cluster="k8s-incident-agent",
            namespace="k8s-incident-scenarios",
            api_version="apps/v1",
            kind="Deployment",
            name="image-pull-backoff",
        ),
        alert_signal=(
            AlertSignalRecord(
                status=AlertSignalStatus.RESOLVED,
                starts_at=CanonicalAlertTimestamp("2026-09-02T08:50:00.000000000Z"),
                ends_at=CanonicalAlertTimestamp("2026-09-02T08:57:00.000000000Z"),
            )
            if source_type == "alertmanager"
            else None
        ),
        runs=(
            MonitoringRunInterval(
                attempt=2,
                started_at=NOW - timedelta(minutes=8),
                completed_at=NOW - timedelta(minutes=5),
            ),
            MonitoringRunInterval(
                attempt=1,
                started_at=NOW - timedelta(hours=1),
                completed_at=NOW - timedelta(minutes=58),
            ),
        ),
        runs_truncated=runs_truncated,
    )


def _panel_result() -> MetricPanelResult:
    return MetricPanelResult(
        panel_id="image-pull-affected-pods",
        title="Affected pods",
        unit="pods",
        threshold=1.0,
        risk_direction=MetricRiskDirection.HIGHER_IS_WORSE,
        window=MetricWindow.FIFTEEN_MINUTES,
        state=MetricQueryState.OK,
        queried_at=NOW,
        latest_sample_at=NOW,
        current_value=0.0,
        samples=[MetricSample(timestamp=NOW, value=0.0)],
    )


def _panel_service(
    context: IncidentMonitoringContext | None,
) -> tuple[MonitoringApplicationService, _PanelRepository, _PanelPrometheus]:
    repository = _PanelRepository(context)
    prometheus = _PanelPrometheus(_panel_result())
    service = MonitoringApplicationService(
        catalog=_alert_catalog(),
        scenarios=(public_scenario(),),
        prometheus=cast(PrometheusQueryService, prometheus),
        repository=cast(IncidentRepository, repository),
        now=lambda: NOW,
    )
    return service, repository, prometheus


@pytest.mark.asyncio
async def test_overview_maps_current_catalog_families_and_preserves_hourly_counts() -> (
    None
):
    samples = tuple(
        MonitoringOverviewSampleRecord(
            timestamp=NOW.replace(minute=0) - timedelta(hours=23 - offset),
            incidents_created=1 if offset == 22 else 0,
            alert_conditions_resolved=1 if offset == 23 else 0,
        )
        for offset in range(24)
    )
    repository = _OverviewRepository(
        MonitoringOverviewRecord(
            total_incidents=7,
            firing_alerts=2,
            triaging_incidents=1,
            diagnosed_incidents=4,
            families=(
                MonitoringOverviewFamilyRecord(
                    source_ref="K8sIncidentImagePullBackOff",
                    count=1,
                ),
                MonitoringOverviewFamilyRecord(
                    source_ref="retired-alert",
                    count=1,
                ),
            ),
            samples=samples,
        )
    )
    service = MonitoringApplicationService(
        catalog=_alert_catalog(),
        scenarios=(public_scenario(),),
        prometheus=cast(PrometheusQueryService, object()),
        repository=cast(IncidentRepository, repository),
        now=lambda: NOW,
    )

    result = await service.get_overview()

    assert repository.generated_at == NOW
    assert result.counts.total_incidents == 7
    assert result.counts.firing_alerts == 2
    assert [family.display_name for family in result.families] == [
        "Image pull failure",
        "retired-alert",
    ]
    assert len(result.samples) == 24
    assert result.samples[-2].incidents_created == 1
    assert result.samples[-1].alert_conditions_resolved == 1


@pytest.mark.asyncio
async def test_catalog_drives_alertmanager_and_evaluation_panel_references() -> None:
    service, repository, _ = _panel_service(_monitoring_context())

    alert_panels = await service.list_panels(uuid4())
    repository.context = _monitoring_context(
        source_type="scenario",
        source_ref="image-pull-backoff",
        source_revision="1",
        runs_truncated=False,
    )
    scenario_panels = await service.list_panels(uuid4())

    assert alert_panels == scenario_panels
    assert [
        panel.model_dump(mode="json", by_alias=True) for panel in alert_panels.panels
    ] == [
        {
            "panelId": "image-pull-affected-pods",
            "recommendedWindow": "15m",
            "riskDirection": "higher_is_worse",
            "signalRole": "trigger",
            "thresholdDuration": "30s",
        },
        {
            "panelId": "image-pull-available-replicas",
            "recommendedWindow": "15m",
            "riskDirection": "lower_is_worse",
            "signalRole": "context",
            "thresholdDuration": "5m",
        },
    ]
    assert repository.run_limits == [1, 1]


@pytest.mark.asyncio
async def test_crash_loop_panels_use_the_same_catalog_projection() -> None:
    service, _, _ = _panel_service(
        _monitoring_context(source_ref="K8sIncidentCrashLoopBackOff")
    )

    result = await service.list_panels(uuid4())

    assert [panel.panel_id for panel in result.panels] == [
        "crash-loop-restarts",
        "crash-loop-waiting-containers",
    ]


@pytest.mark.asyncio
async def test_panel_query_uses_persisted_target_and_projects_independent_markers() -> (
    None
):
    context = _monitoring_context()
    service, repository, prometheus = _panel_service(context)

    panel = await service.get_panel(
        uuid4(),
        panel_id="image-pull-affected-pods",
        window=MetricWindow.FIFTEEN_MINUTES,
    )

    assert prometheus.calls == [
        (
            context.target,
            "image-pull-affected-pods",
            MetricWindow.FIFTEEN_MINUTES,
        )
    ]
    assert panel.result.current_value == 0
    assert [(marker.kind, marker.run_attempt) for marker in panel.markers] == [
        (MetricMarkerKind.ALERT_FIRING, None),
        (MetricMarkerKind.RUN_STARTED, 2),
        (MetricMarkerKind.RUN_COMPLETED, 2),
        (MetricMarkerKind.ALERT_RESOLVED, None),
    ]
    assert panel.markers_truncated is True
    assert repository.run_limits == [50]


@pytest.mark.asyncio
async def test_unknown_incident_and_foreign_panel_fail_before_prometheus_query() -> (
    None
):
    missing_service, _, missing_prometheus = _panel_service(None)
    with pytest.raises(IncidentNotFoundError):
        await missing_service.list_panels(uuid4())
    assert missing_prometheus.calls == []

    service, _, prometheus = _panel_service(_monitoring_context())
    with pytest.raises(MonitoringPanelNotFoundError):
        await service.get_panel(
            uuid4(),
            panel_id="another-alert-panel",
            window=MetricWindow.FIFTEEN_MINUTES,
        )
    assert prometheus.calls == []


@pytest.mark.asyncio
async def test_catalog_revision_mismatch_exposes_no_current_panels() -> None:
    service, _, prometheus = _panel_service(
        _monitoring_context(source_revision="older-catalog")
    )

    result = await service.list_panels(uuid4())

    assert result.panels == ()
    assert prometheus.calls == []


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
