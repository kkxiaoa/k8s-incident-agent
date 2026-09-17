from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast
from uuid import UUID

import httpx
import pytest
from tests.factories import diagnostic_model_stub, operator_sessions_stub

from k8s_incident_agent import api
from k8s_incident_agent.api import RuntimeContainer
from k8s_incident_agent.application.events import IncidentEventService
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.application.monitoring import MonitoringApplicationService
from k8s_incident_agent.config import Settings
from k8s_incident_agent.monitoring.contracts import (
    IncidentMetricPanel,
    IncidentMonitoringPanels,
    MetricMarker,
    MetricMarkerKind,
    MetricPanelResult,
    MetricPanelSignalRole,
    MetricQueryState,
    MetricRiskDirection,
    MetricSample,
    MetricSeries,
    MetricSeriesBinding,
    MetricTimeAnchor,
    MetricWindow,
    MonitoringComponentState,
    MonitoringHealthSnapshot,
    MonitoringOverallState,
    MonitoringOverviewCounts,
    MonitoringOverviewFamily,
    MonitoringOverviewSample,
    MonitoringOverviewSnapshot,
    MonitoringPanelReference,
)
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT, RuntimePaths

NOW = datetime(2026, 9, 2, 9, 0, tzinfo=UTC)


def test_monitoring_overview_rejects_a_stale_24_hour_window() -> None:
    first_hour = NOW - timedelta(hours=24)

    with pytest.raises(ValueError, match="end at the current UTC hour"):
        MonitoringOverviewSnapshot(
            generated_at=NOW,
            counts=MonitoringOverviewCounts(
                total_incidents=0,
                firing_alerts=0,
                triaging_incidents=0,
                waiting_approval_incidents=0,
            ),
            families=(),
            samples=tuple(
                MonitoringOverviewSample(
                    timestamp=first_hour + timedelta(hours=offset),
                    incidents_created=0,
                    alert_conditions_resolved=0,
                )
                for offset in range(24)
            ),
        )


class _MonitoringService:
    def __init__(self) -> None:
        self.anchors: list[tuple[MetricTimeAnchor, UUID | None]] = []

    async def get_health(self) -> MonitoringHealthSnapshot:
        return MonitoringHealthSnapshot(
            state=MonitoringOverallState.DEGRADED,
            checked_at=NOW,
            prometheus=MonitoringComponentState.HEALTHY,
            kube_state_metrics=MonitoringComponentState.HEALTHY,
            rule_evaluation=MonitoringComponentState.HEALTHY,
            alertmanager=MonitoringComponentState.HEALTHY,
            notification=MonitoringComponentState.STALE,
            watchdog_last_received_at=NOW - timedelta(minutes=7),
        )

    async def get_overview(self) -> MonitoringOverviewSnapshot:
        first_hour = NOW - timedelta(hours=23)
        return MonitoringOverviewSnapshot(
            generated_at=NOW,
            counts=MonitoringOverviewCounts(
                total_incidents=8,
                firing_alerts=2,
                triaging_incidents=1,
                waiting_approval_incidents=5,
            ),
            families=(
                MonitoringOverviewFamily(
                    source_ref="K8sIncidentImagePullBackOff",
                    display_name="Image pull failure",
                    count=2,
                ),
            ),
            samples=tuple(
                MonitoringOverviewSample(
                    timestamp=first_hour + timedelta(hours=offset),
                    incidents_created=1 if offset == 23 else 0,
                    alert_conditions_resolved=1 if offset == 22 else 0,
                )
                for offset in range(24)
            ),
        )

    async def list_panels(self, _incident_id: object) -> IncidentMonitoringPanels:
        return IncidentMonitoringPanels(
            panels=(
                MonitoringPanelReference(
                    panel_id="image-pull-affected-pods",
                    title="Affected pods",
                    unit="pods",
                    purpose="Registered purpose.",
                    series_binding=MetricSeriesBinding.TARGET,
                    recommended_window=MetricWindow.FIFTEEN_MINUTES,
                    risk_direction=MetricRiskDirection.HIGHER_IS_WORSE,
                    signal_role=MetricPanelSignalRole.TRIGGER,
                    threshold_duration="30s",
                ),
                MonitoringPanelReference(
                    panel_id="image-pull-available-replicas",
                    title="Available replicas",
                    unit="replicas",
                    purpose="Registered purpose.",
                    series_binding=MetricSeriesBinding.TARGET,
                    recommended_window=MetricWindow.FIFTEEN_MINUTES,
                    risk_direction=MetricRiskDirection.LOWER_IS_WORSE,
                    signal_role=MetricPanelSignalRole.CONTEXT,
                    threshold_duration="5m",
                ),
            )
        )

    async def get_panel(
        self,
        _incident_id: object,
        *,
        panel_id: str,
        window: MetricWindow,
        anchor: MetricTimeAnchor = MetricTimeAnchor.CURRENT,
        run_id: UUID | None = None,
    ) -> IncidentMetricPanel:
        self.anchors.append((anchor, run_id))
        return IncidentMetricPanel(
            result=MetricPanelResult(
                panel_id=panel_id,
                title="Affected pods",
                unit="pods",
                threshold=1.0,
                purpose="Registered purpose.",
                risk_direction=MetricRiskDirection.HIGHER_IS_WORSE,
                series_binding=MetricSeriesBinding.TARGET,
                window=window,
                anchor=MetricTimeAnchor.CURRENT,
                state=MetricQueryState.OK,
                queried_at=NOW,
                range_start=NOW - window.duration,
                range_end=NOW,
                latest_sample_at=NOW,
                current_value=0.0,
                series=[
                    MetricSeries(
                        labels={}, samples=[MetricSample(timestamp=NOW, value=0.0)]
                    )
                ],
            ),
            markers=(
                MetricMarker(
                    kind=MetricMarkerKind.RUN_STARTED,
                    occurred_at=NOW - timedelta(minutes=1),
                    run_attempt=1,
                ),
            ),
            markers_truncated=False,
        )


@pytest.mark.asyncio
async def test_monitoring_health_route_returns_the_bounded_projection(
    tmp_path: Path,
) -> None:
    settings = Settings(
        runtime_paths=RuntimePaths.prepare(tmp_path / "runtime"),
        scenario_catalog_dir=REPOSITORY_ROOT / "scenarios",
        _env_file=None,  # pyright: ignore[reportCallIssue]
    )

    @asynccontextmanager
    async def runtime_context(
        _settings: Settings,
    ) -> AsyncGenerator[RuntimeContainer]:
        yield RuntimeContainer(
            operator=operator_sessions_stub(),
            diagnostic_model=diagnostic_model_stub(),
            incidents=cast(IncidentApplicationService, object()),
            events=cast(IncidentEventService, object()),
            alerts=None,
            monitoring=cast(MonitoringApplicationService, _MonitoringService()),
        )

    app = api.create_app(
        settings=settings,
        runtime_context_factory=runtime_context,
    )
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
        ) as client:
            response = await client.get("/api/v1/monitoring/health")

    assert response.status_code == 200
    assert response.json() == {
        "state": "degraded",
        "checkedAt": "2026-09-02T09:00:00Z",
        "prometheus": "healthy",
        "kubeStateMetrics": "healthy",
        "ruleEvaluation": "healthy",
        "alertmanager": "healthy",
        "notification": "stale",
        "watchdogLastReceivedAt": "2026-09-02T08:53:00Z",
    }


@pytest.mark.asyncio
async def test_monitoring_overview_route_returns_fixed_24_hour_projection(
    tmp_path: Path,
) -> None:
    settings = Settings(
        runtime_paths=RuntimePaths.prepare(tmp_path / "runtime"),
        scenario_catalog_dir=REPOSITORY_ROOT / "scenarios",
        _env_file=None,  # pyright: ignore[reportCallIssue]
    )

    @asynccontextmanager
    async def runtime_context(
        _settings: Settings,
    ) -> AsyncGenerator[RuntimeContainer]:
        yield RuntimeContainer(
            operator=operator_sessions_stub(),
            diagnostic_model=diagnostic_model_stub(),
            incidents=cast(IncidentApplicationService, object()),
            events=cast(IncidentEventService, object()),
            alerts=None,
            monitoring=cast(MonitoringApplicationService, _MonitoringService()),
        )

    app = api.create_app(settings=settings, runtime_context_factory=runtime_context)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
        ) as client:
            response = await client.get("/api/v1/monitoring/overview")

    assert response.status_code == 200
    payload = response.json()
    assert payload["schemaVersion"] == 2
    assert payload["window"] == "24h"
    assert payload["counts"] == {
        "totalIncidents": 8,
        "firingAlerts": 2,
        "triagingIncidents": 1,
        "waitingApprovalIncidents": 5,
    }
    assert payload["families"] == [
        {
            "sourceRef": "K8sIncidentImagePullBackOff",
            "displayName": "Image pull failure",
            "count": 2,
        }
    ]
    assert len(payload["samples"]) == 24
    assert payload["samples"][-1]["incidentsCreated"] == 1
    assert payload["samples"][-2]["alertConditionsResolved"] == 1


@pytest.mark.asyncio
async def test_incident_monitoring_routes_return_catalog_refs_panel_and_markers(
    tmp_path: Path,
) -> None:
    settings = Settings(
        runtime_paths=RuntimePaths.prepare(tmp_path / "runtime"),
        scenario_catalog_dir=REPOSITORY_ROOT / "scenarios",
        _env_file=None,  # pyright: ignore[reportCallIssue]
    )

    @asynccontextmanager
    async def runtime_context(
        _settings: Settings,
    ) -> AsyncGenerator[RuntimeContainer]:
        yield RuntimeContainer(
            operator=operator_sessions_stub(),
            diagnostic_model=diagnostic_model_stub(),
            incidents=cast(IncidentApplicationService, object()),
            events=cast(IncidentEventService, object()),
            alerts=None,
            monitoring=cast(MonitoringApplicationService, _MonitoringService()),
        )

    app = api.create_app(
        settings=settings,
        runtime_context_factory=runtime_context,
    )
    incident_id = "11111111-1111-4111-8111-111111111111"
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
        ) as client:
            refs = await client.get(
                f"/api/v1/incidents/{incident_id}/monitoring/panels"
            )
            panel = await client.get(
                f"/api/v1/incidents/{incident_id}/monitoring/panels/"
                "image-pull-affected-pods?window=15d"
            )
            invalid = await client.get(
                f"/api/v1/incidents/{incident_id}/monitoring/panels/"
                "image-pull-affected-pods?window=24h"
            )
            invalid_panel = await client.get(
                f"/api/v1/incidents/{incident_id}/monitoring/panels/not_valid"
            )

    assert refs.status_code == 200
    assert refs.json() == {
        "schemaVersion": 4,
        "panels": [
            {
                "panelId": "image-pull-affected-pods",
                "title": "Affected pods",
                "unit": "pods",
                "purpose": "Registered purpose.",
                "seriesBinding": "target",
                "recommendedWindow": "15m",
                "riskDirection": "higher_is_worse",
                "signalRole": "trigger",
                "thresholdDuration": "30s",
            },
            {
                "panelId": "image-pull-available-replicas",
                "title": "Available replicas",
                "unit": "replicas",
                "purpose": "Registered purpose.",
                "seriesBinding": "target",
                "recommendedWindow": "15m",
                "riskDirection": "lower_is_worse",
                "signalRole": "context",
                "thresholdDuration": "5m",
            },
        ],
    }
    assert panel.status_code == 200
    assert panel.json() == {
        "schemaVersion": 2,
        "result": {
            "panelId": "image-pull-affected-pods",
            "title": "Affected pods",
            "unit": "pods",
            "purpose": "Registered purpose.",
            "threshold": 1.0,
            "riskDirection": "higher_is_worse",
            "seriesBinding": "target",
            "window": "15d",
            "anchor": "current",
            "state": "ok",
            "queriedAt": "2026-09-02T09:00:00Z",
            "rangeStart": "2026-08-18T09:00:00Z",
            "rangeEnd": "2026-09-02T09:00:00Z",
            "latestSampleAt": "2026-09-02T09:00:00Z",
            "currentValue": 0.0,
            "series": [
                {
                    "labels": {},
                    "samples": [{"timestamp": "2026-09-02T09:00:00Z", "value": 0.0}],
                }
            ],
        },
        "markers": [
            {
                "kind": "run_started",
                "occurredAt": "2026-09-02T08:59:00Z",
                "runAttempt": 1,
            }
        ],
        "markersTruncated": False,
    }
    assert invalid.status_code == 422
    assert invalid_panel.status_code == 422
    assert invalid.json()["error"]["code"] == "invalid_request"
