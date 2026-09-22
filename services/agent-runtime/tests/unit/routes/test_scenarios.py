from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import httpx
import pytest
from tests.factories import (
    diagnostic_model_stub,
    monitoring_health_service_stub,
    operator_sessions_stub,
)

from k8s_incident_agent import api
from k8s_incident_agent.api import RuntimeContainer
from k8s_incident_agent.application.events import IncidentEventService
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.application.scheduling import RunScheduler
from k8s_incident_agent.config import Settings
from k8s_incident_agent.domain.models import RunBudget
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredentialLease
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT, RuntimePaths
from k8s_incident_agent.scenarios.catalog import load_scenario_catalog


@pytest.mark.asyncio
async def test_scenario_route_returns_only_versioned_public_projection(
    tmp_path: Path,
) -> None:
    settings = Settings(
        runtime_paths=RuntimePaths.prepare(tmp_path / "runtime"),
        scenario_catalog_dir=REPOSITORY_ROOT / "scenarios",
        _env_file=None,  # pyright: ignore[reportCallIssue]
    )
    service = IncidentApplicationService(
        catalog=load_scenario_catalog(REPOSITORY_ROOT / "scenarios"),
        repository=cast(IncidentRepository, object()),
        supervisor=cast(RunScheduler, object()),
        credential=cast(DiagnosticCredentialLease, object()),
        model=lambda: None,
        budget=RunBudget(max_model_calls=12, max_tool_calls=12, timeout_seconds=180),
        now=lambda: datetime.now(UTC),
    )

    @asynccontextmanager
    async def runtime_context(_settings: Settings) -> AsyncGenerator[RuntimeContainer]:
        yield RuntimeContainer(
            operator=operator_sessions_stub(),
            diagnostic_model=diagnostic_model_stub(),
            incidents=service,
            events=cast(IncidentEventService, object()),
            alerts=None,
            monitoring=monitoring_health_service_stub(),
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
            response = await client.get("/api/v1/scenarios")

    assert response.status_code == 200
    document = response.json()
    assert document["schemaVersion"] == 1
    assert len(document["items"]) == 7
    image_pull = next(
        item for item in document["items"] if item["scenarioId"] == "image-pull-backoff"
    )
    assert image_pull == {
        "scenarioId": "image-pull-backoff",
        "scenarioVersion": 5,
        "displayName": "Image pull failure",
        "description": "A Deployment cannot pull its configured image.",
        "trigger": {
            "type": "manual",
            "summary": "The target Deployment is unavailable.",
        },
        "target": {
            "cluster": "k8s-incident-agent",
            "namespace": "k8s-incident-scenarios",
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "name": "image-pull-backoff",
        },
    }
    for item in document["items"]:
        assert set(item) == {
            "scenarioId",
            "scenarioVersion",
            "displayName",
            "description",
            "trigger",
            "target",
        }
