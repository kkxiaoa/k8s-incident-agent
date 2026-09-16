from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from uuid import UUID

import httpx
import pytest
from tests.factories import (
    diagnostic_model_stub,
    monitoring_health_service_stub,
    operator_sessions_stub,
)
from tests.unit.persistence.test_repair_persistence import (
    BUDGET,
    MODEL,
    _database,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.repair.test_repair_preparation import (
    FRESH_NOW,
    seed_source,
)
from tests.unit.repair.test_repair_preparation import (
    credential as diagnostic_credential,
)
from tests.unit.routes.test_operator import credential as credential

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
from k8s_incident_agent.auth.sessions import OperatorSessions
from k8s_incident_agent.auth.verifier import PasswordVerifier
from k8s_incident_agent.config import Settings
from k8s_incident_agent.domain.models import IncidentStatus, RunKind, RunStatus
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.repair.actions import IncidentActions
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT, RuntimePaths


class _QueuedScheduler:
    async def schedule(self, run_id: UUID) -> None:
        del run_id


@pytest.mark.parametrize("operation", ["repair-runs", "runs"])
async def test_online_authenticated_existing_incident_mutations_use_real_persistence(
    tmp_path: Path,
    credential: tuple[str, str],
    operation: str,
) -> None:
    password, encoded = credential
    origin = "https://console.example.test"
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, source_id = await seed_source(repository)
        service = IncidentApplicationService(
            catalog=(),
            repository=repository,
            supervisor=_QueuedScheduler(),
            credential=diagnostic_credential(),
            model=lambda: MODEL,
            budget=BUDGET,
            now=lambda: FRESH_NOW,
        )
        sessions = OperatorSessions(
            sessions=database.session_factory,
            verifier=PasswordVerifier(encoded),
            origin=origin,
        )
        await sessions.start()

        @asynccontextmanager
        async def context(_settings: Settings) -> AsyncGenerator[RuntimeContainer]:
            yield RuntimeContainer(
                incidents=service,
                events=cast(IncidentEventService, object()),
                alerts=None,
                monitoring=monitoring_health_service_stub(),
                diagnostic_model=diagnostic_model_stub(),
                operator=sessions,
            )

        settings = Settings(
            runtime_paths=RuntimePaths.prepare(tmp_path / "api"),
            incident_intake_mode="online",
            _env_file=None,  # pyright: ignore[reportCallIssue]
        )
        app = api.create_app(settings=settings, runtime_context_factory=context)
        try:
            async with (
                app.router.lifespan_context(app),
                httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                    base_url=origin,
                ) as client,
            ):
                path = f"/api/v1/incidents/{incident_id}/{operation}"
                body: dict[str, object] = (
                    {"sourceRunId": str(source_id)}
                    if operation == "repair-runs"
                    else {}
                )
                assert (await client.post(path, json=body)).status_code == 401
                login = await client.post(
                    "/api/v1/operator/login",
                    json={"password": password},
                    headers={"Origin": origin},
                )
                assert login.status_code == 200
                headers = {"Origin": origin, "X-CSRF-Token": login.json()["csrfToken"]}
                assert (
                    await client.post(
                        "/api/v1/incidents",
                        json={"scenarioId": "image-pull-backoff"},
                        headers=headers,
                    )
                ).status_code == 405
                assert (await client.get("/api/v1/scenarios")).status_code == 404
                assert (
                    await client.post(path, json=body, headers={"Origin": origin})
                ).status_code == 403
                invalid_bodies: list[dict[str, object]] = [
                    {**body, "actor": "someone"},
                    {**body, "patch": []},
                ]
                if operation == "repair-runs":
                    invalid_bodies.extend(
                        {**body, "selection": selection}
                        for selection in (
                            {"revision": 2, "replicaSetUid": "rs-old"},
                            {"revision": "02", "replicaSetUid": "rs-old"},
                            {
                                "revision": "9223372036854775808",
                                "replicaSetUid": "rs-old",
                            },
                            {"revision": "2", "replicaSetUid": " rs-old"},
                            {"revision": "2", "replicaSetUid": "rs-old\n"},
                        )
                    )
                for invalid in invalid_bodies:
                    response = await client.post(path, json=invalid, headers=headers)
                    assert response.status_code == 422, response.text
                    assert (
                        len(
                            (
                                await service.list_runs(
                                    incident_id, limit=50, cursor=None
                                )
                            ).items
                        )
                        == 1
                    )
                if operation == "repair-runs":
                    body["selection"] = {
                        "revision": "9223372036854775807",
                        "replicaSetUid": "rs-old",
                    }
                response = await client.post(path, json=body, headers=headers)
                assert response.status_code == 202, response.text
                detail = (
                    await client.get(
                        f"/api/v1/incidents/{incident_id}?runId={response.json()['runId']}"
                    )
                ).json()
                selected = detail["selectedRun"]
                assert selected["kind"] == (
                    "repair" if operation == "repair-runs" else "diagnosis"
                )
                assert (
                    selected["status"] == "QUEUED"
                    and selected["requestSource"] == "operator"
                )
                assert selected["sourceRunId"] == (
                    str(source_id) if operation == "repair-runs" else None
                )
                if operation == "repair-runs":
                    assert selected["selection"] == body["selection"]
                assert (
                    await client.post(path, json=body, headers=headers)
                ).status_code == 409
        finally:
            await sessions.close()


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
        *,
        operator_ref: str,
        requester: object,
    ) -> CreateIncidentResponse:
        assert request.scenario_id == "image-pull-backoff"
        return CreateIncidentResponse(incident_id=INCIDENT_ID)

    async def create_run(
        self,
        incident_id: UUID,
        *,
        replaces_run_id: UUID | None,
        operator_ref: str,
        requester: object,
    ) -> CreateRunResponse:
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
        requester: object,
    ) -> IncidentDetailResponse:
        assert incident_id == INCIDENT_ID
        assert run_id in (None, RUN_ID)
        return IncidentDetailResponse(
            actions=IncidentActions(
                prepare="not_applicable",
                refresh="not_applicable",
                edit="not_applicable",
                approve="not_applicable",
                reject="not_applicable",
                rollback="not_applicable",
                rerun="active_run",
                preparation_source=None,
                history_candidates=(),
            ),
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
                kind=RunKind.DIAGNOSIS,
                operation=None,
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
        requester: object,
        mine: bool,
    ) -> RunHistoryResponse:
        assert incident_id == INCIDENT_ID
        assert (limit, cursor) == (20, None)
        return RunHistoryResponse(
            items=(
                RunSummaryResponse(
                    id=RUN_ID,
                    kind=RunKind.DIAGNOSIS,
                    operation=None,
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
            operator=operator_sessions_stub(),
            diagnostic_model=diagnostic_model_stub(),
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
        "schemaVersion": 5,
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
    assert document["schemaVersion"] == 5
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
    assert created.json() == {"schemaVersion": 5, "runId": str(RUN_ID)}
    assert history.status_code == 200
    assert history.json()["items"][0]["attempt"] == 1
    assert events.status_code == 200
    assert events.json() == {"schemaVersion": 5, "items": [], "nextCursor": None}
