from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from uuid import UUID

import httpx
import pytest

from k8s_incident_agent import api
from k8s_incident_agent.api import RuntimeContainer
from k8s_incident_agent.api_contracts import (
    CreateIncidentRequest,
    CreateIncidentResponse,
    IncidentDetailResponse,
    IncidentListItem,
    IncidentListResponse,
    IncidentResponse,
    RunBudgetResponse,
    RunResponse,
    RunUsageResponse,
    ScenarioTargetResponse,
)
from k8s_incident_agent.application.events import IncidentEventService
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.config import Settings
from k8s_incident_agent.domain.models import IncidentStatus, RunStatus
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT, RuntimePaths

INCIDENT_ID = UUID("00000000-0000-0000-0000-000000000001")
RUN_ID = UUID("00000000-0000-0000-0000-000000000002")
NOW = datetime(2026, 8, 26, 9, 0, tzinfo=UTC)
TARGET = ScenarioTargetResponse(
    cluster="k8s-incident-agent",
    namespace="k8s-incident-scenarios",
    api_version="apps/v1",
    kind="Deployment",
    name="image-pull-backoff",
)


class _IncidentService:
    def __init__(self) -> None:
        self.list_arguments: tuple[int, str | None] | None = None

    async def create_incident(
        self,
        request: CreateIncidentRequest,
    ) -> CreateIncidentResponse:
        assert request.scenario_id == "image-pull-backoff"
        return CreateIncidentResponse(
            incident_id=INCIDENT_ID,
            run_id=RUN_ID,
            incident_status=IncidentStatus.RECEIVED,
            run_status=RunStatus.QUEUED,
        )

    async def list_incidents(
        self,
        *,
        limit: int,
        cursor: str | None,
    ) -> IncidentListResponse:
        self.list_arguments = (limit, cursor)
        return IncidentListResponse(
            items=(
                IncidentListItem(
                    id=INCIDENT_ID,
                    scenario_id="image-pull-backoff",
                    scenario_version=1,
                    display_name="Image pull failure",
                    target=TARGET,
                    status=IncidentStatus.RECEIVED,
                    created_at=NOW,
                    updated_at=NOW,
                ),
            ),
            next_cursor=None,
        )

    async def get_incident(self, incident_id: UUID) -> IncidentDetailResponse:
        assert incident_id == INCIDENT_ID
        return IncidentDetailResponse(
            incident=IncidentResponse(
                id=INCIDENT_ID,
                scenario_id="image-pull-backoff",
                scenario_version=1,
                display_name="Image pull failure",
                trigger_summary="The target Deployment is unavailable.",
                target=TARGET,
                status=IncidentStatus.RECEIVED,
                created_at=NOW,
                updated_at=NOW,
            ),
            run=RunResponse(
                id=RUN_ID,
                status=RunStatus.QUEUED,
                model_provider="deepseek",
                model_id="deepseek-v4-flash",
                thinking_mode=False,
                prompt_version="stage1-v1",
                budget=RunBudgetResponse(
                    max_model_calls=8,
                    max_tool_calls=6,
                    timeout_seconds=180,
                ),
                usage=RunUsageResponse(
                    model_calls=None,
                    tool_calls=None,
                    input_tokens=None,
                    output_tokens=None,
                ),
                error=None,
                created_at=NOW,
                started_at=None,
                completed_at=None,
            ),
            evidence=(),
            diagnosis=None,
        )


@asynccontextmanager
async def _client(
    tmp_path: Path,
    service: _IncidentService,
) -> AsyncGenerator[httpx.AsyncClient]:
    settings = Settings(
        runtime_paths=RuntimePaths.prepare(tmp_path / "runtime"),
        scenario_catalog_dir=REPOSITORY_ROOT / "scenarios",
        _env_file=None,  # pyright: ignore[reportCallIssue]
    )

    @asynccontextmanager
    async def runtime_context(_settings: Settings) -> AsyncGenerator[RuntimeContainer]:
        yield RuntimeContainer(
            incidents=cast(IncidentApplicationService, service),
            events=cast(IncidentEventService, object()),
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
            yield client


@pytest.mark.asyncio
async def test_create_returns_202_and_exact_versioned_projection(
    tmp_path: Path,
) -> None:
    service = _IncidentService()
    async with _client(tmp_path, service) as client:
        response = await client.post(
            "/api/v1/incidents",
            json={"scenarioId": "image-pull-backoff"},
        )

    assert response.status_code == 202
    assert response.json() == {
        "schemaVersion": 1,
        "incidentId": str(INCIDENT_ID),
        "runId": str(RUN_ID),
        "incidentStatus": "RECEIVED",
        "runStatus": "QUEUED",
    }


@pytest.mark.asyncio
async def test_list_uses_default_limit_and_serializes_utc_timestamp(
    tmp_path: Path,
) -> None:
    service = _IncidentService()
    async with _client(tmp_path, service) as client:
        response = await client.get("/api/v1/incidents")

    assert response.status_code == 200
    assert service.list_arguments == (20, None)
    assert response.json()["items"][0]["createdAt"] == "2026-08-26T09:00:00Z"
    assert response.json()["nextCursor"] is None


@pytest.mark.asyncio
async def test_detail_preserves_nullable_run_and_diagnosis_fields(
    tmp_path: Path,
) -> None:
    service = _IncidentService()
    async with _client(tmp_path, service) as client:
        response = await client.get(f"/api/v1/incidents/{INCIDENT_ID}")

    assert response.status_code == 200
    document = response.json()
    assert document["schemaVersion"] == 1
    assert document["run"]["usage"] == {
        "modelCalls": None,
        "toolCalls": None,
        "inputTokens": None,
        "outputTokens": None,
    }
    assert document["run"]["startedAt"] is None
    assert document["run"]["completedAt"] is None
    assert document["run"]["error"] is None
    assert document["diagnosis"] is None
    assert document["evidence"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("query", ["limit=0", "limit=101", "limit=not-an-int"])
async def test_list_query_bounds_use_validation_envelope(
    tmp_path: Path,
    query: str,
) -> None:
    service = _IncidentService()
    async with _client(tmp_path, service) as client:
        response = await client.get(f"/api/v1/incidents?{query}")

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"
    assert service.list_arguments is None
