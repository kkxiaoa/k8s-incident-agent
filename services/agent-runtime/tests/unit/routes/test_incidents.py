from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from uuid import UUID

import httpx
import pytest
from tests.factories import monitoring_health_service_stub

from k8s_incident_agent import api
from k8s_incident_agent.api import RuntimeContainer
from k8s_incident_agent.api_contracts import (
    CreateIncidentRequest,
    CreateIncidentResponse,
    CreateRunResponse,
    EventPageResponse,
    IncidentDetailResponse,
    IncidentListItem,
    IncidentListResponse,
    IncidentResponse,
    IncidentSourceResponse,
    IncidentTargetResponse,
    RunEventHistoryResponse,
    RunHistoryResponse,
    RunSummaryResponse,
    SelectedRunResponse,
)
from k8s_incident_agent.application.events import IncidentEventService
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.config import Settings
from k8s_incident_agent.domain.models import IncidentStatus, RunStatus
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT, RuntimePaths

INCIDENT_ID = UUID("00000000-0000-0000-0000-000000000001")
RUN_ID = UUID("00000000-0000-0000-0000-000000000002")
NOW = datetime(2026, 8, 26, 9, 0, tzinfo=UTC)
TARGET = IncidentTargetResponse(
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
        return CreateIncidentResponse(incident_id=INCIDENT_ID)

    async def create_run(self, incident_id: UUID) -> CreateRunResponse:
        assert incident_id == INCIDENT_ID
        return CreateRunResponse(run_id=RUN_ID)

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
                    display_name="Image pull failure",
                    target=TARGET,
                    status=IncidentStatus.RECEIVED,
                    updated_at=NOW,
                ),
            ),
            next_cursor=None,
        )

    async def get_incident(
        self,
        incident_id: UUID,
        *,
        run_id: UUID | None,
    ) -> IncidentDetailResponse:
        assert incident_id == INCIDENT_ID
        assert run_id in (None, RUN_ID)
        return IncidentDetailResponse(
            incident=IncidentResponse(
                id=INCIDENT_ID,
                source=IncidentSourceResponse(
                    type="scenario",
                    ref="image-pull-backoff",
                    revision="1",
                ),
                display_name="Image pull failure",
                trigger_summary="The target Deployment is unavailable.",
                target=TARGET,
                status=IncidentStatus.RECEIVED,
                created_at=NOW,
            ),
            selected_run=SelectedRunResponse(
                id=RUN_ID,
                attempt=1,
                status=RunStatus.QUEUED,
                error=None,
                created_at=NOW,
                started_at=None,
                completed_at=None,
            ),
            event_page=EventPageResponse(items=(), next_cursor=None),
            evidence=(),
            diagnosis=None,
            repair=None,
            alert_signal=None,
            event_cursor="1",
        )

    async def list_runs(
        self,
        incident_id: UUID,
        *,
        limit: int,
        cursor: str | None,
    ) -> RunHistoryResponse:
        assert incident_id == INCIDENT_ID
        assert (limit, cursor) == (20, None)
        return RunHistoryResponse(
            items=(
                RunSummaryResponse(
                    id=RUN_ID,
                    attempt=1,
                    status=RunStatus.QUEUED,
                    created_at=NOW,
                    started_at=None,
                    completed_at=None,
                ),
            ),
            next_cursor=None,
        )

    async def list_run_events(
        self,
        incident_id: UUID,
        run_id: UUID,
        *,
        limit: int,
        cursor: str | None,
    ) -> RunEventHistoryResponse:
        assert (incident_id, run_id, limit, cursor) == (
            INCIDENT_ID,
            RUN_ID,
            100,
            None,
        )
        return RunEventHistoryResponse(items=(), next_cursor=None)


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
        "schemaVersion": 4,
        "incidentId": str(INCIDENT_ID),
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
    assert response.json()["items"][0]["updatedAt"] == "2026-08-26T09:00:00Z"
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
    assert document["schemaVersion"] == 4
    assert document["selectedRun"]["startedAt"] is None
    assert document["selectedRun"]["completedAt"] is None
    assert document["selectedRun"]["error"] is None
    assert document["eventCursor"] == "1"
    assert document["eventPage"] == {"items": [], "nextCursor": None}
    assert document["diagnosis"] is None
    assert document["repair"] is None
    assert document["alertSignal"] is None
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


@pytest.mark.asyncio
async def test_run_routes_use_v4_minimal_contracts(tmp_path: Path) -> None:
    service = _IncidentService()
    async with _client(tmp_path, service) as client:
        created = await client.post(f"/api/v1/incidents/{INCIDENT_ID}/runs")
        history = await client.get(f"/api/v1/incidents/{INCIDENT_ID}/runs")
        events = await client.get(
            f"/api/v1/incidents/{INCIDENT_ID}/runs/{RUN_ID}/events"
        )

    assert created.status_code == 202
    assert created.json() == {"schemaVersion": 4, "runId": str(RUN_ID)}
    assert history.status_code == 200
    assert history.json()["items"][0]["attempt"] == 1
    assert events.status_code == 200
    assert events.json() == {"schemaVersion": 4, "items": [], "nextCursor": None}
