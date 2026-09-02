from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

import httpx
import pytest

from k8s_incident_agent import api
from k8s_incident_agent.api import RuntimeContainer
from k8s_incident_agent.application.events import IncidentEventService
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.application.monitoring import MonitoringHealthService
from k8s_incident_agent.config import Settings
from k8s_incident_agent.monitoring.contracts import (
    MonitoringComponentState,
    MonitoringHealthSnapshot,
    MonitoringOverallState,
)
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT, RuntimePaths

NOW = datetime(2026, 9, 2, 9, 0, tzinfo=UTC)


class _MonitoringService:
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
            incidents=cast(IncidentApplicationService, object()),
            events=cast(IncidentEventService, object()),
            alerts=None,
            monitoring=cast(MonitoringHealthService, _MonitoringService()),
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
