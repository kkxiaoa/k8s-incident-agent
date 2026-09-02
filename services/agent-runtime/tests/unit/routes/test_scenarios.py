from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import cast

import httpx
import pytest
from tests.factories import monitoring_health_service_stub

from k8s_incident_agent import api
from k8s_incident_agent.api import RuntimeContainer
from k8s_incident_agent.api_contracts import (
    ScenarioListResponse,
    ScenarioResponse,
    ScenarioTargetResponse,
    ScenarioTriggerResponse,
)
from k8s_incident_agent.application.events import IncidentEventService
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.config import Settings
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT, RuntimePaths


class _ScenarioService:
    async def list_scenarios(self) -> ScenarioListResponse:
        return ScenarioListResponse(
            items=(
                ScenarioResponse(
                    scenario_id="image-pull-backoff",
                    scenario_version=1,
                    display_name="Image pull failure",
                    description="A Deployment cannot pull its configured image.",
                    trigger=ScenarioTriggerResponse(
                        type="manual",
                        summary="The target Deployment is unavailable.",
                    ),
                    target=ScenarioTargetResponse(
                        cluster="k8s-incident-agent",
                        namespace="k8s-incident-scenarios",
                        api_version="apps/v1",
                        kind="Deployment",
                        name="image-pull-backoff",
                    ),
                ),
            )
        )


@pytest.mark.asyncio
async def test_scenario_route_returns_only_versioned_public_projection(
    tmp_path: Path,
) -> None:
    settings = Settings(
        runtime_paths=RuntimePaths.prepare(tmp_path / "runtime"),
        scenario_catalog_dir=REPOSITORY_ROOT / "scenarios",
        _env_file=None,  # pyright: ignore[reportCallIssue]
    )

    @asynccontextmanager
    async def runtime_context(_settings: Settings) -> AsyncGenerator[RuntimeContainer]:
        yield RuntimeContainer(
            incidents=cast(IncidentApplicationService, _ScenarioService()),
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
    assert response.json() == {
        "schemaVersion": 1,
        "items": [
            {
                "scenarioId": "image-pull-backoff",
                "scenarioVersion": 1,
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
        ],
    }
    assert "expectedRootCauses" not in response.text
    assert "deterministicVerifier" not in response.text
