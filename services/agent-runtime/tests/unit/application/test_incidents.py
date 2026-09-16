import base64
import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import func, select
from tests.factories import normalized_trigger

from k8s_incident_agent.api_contracts import CreateIncidentRequest
from k8s_incident_agent.application.incidents import (
    IncidentApplicationService,
    InvalidCursorError,
    RuntimeNotReadyError,
    ScenarioNotFoundError,
)
from k8s_incident_agent.domain.models import (
    DiagnosisOutcome,
    DiagnosisWorkflowRunSnapshot,
    EvidenceRecord,
    ModelSnapshot,
    PersistedEvidence,
    RootCauseRecord,
    RunBudget,
    RunStatus,
    TerminalRecord,
)
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredential
from k8s_incident_agent.persistence.database import (
    BusinessDatabase,
    create_business_database,
)
from k8s_incident_agent.persistence.models import IncidentRow
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.runtime.paths import RuntimePaths
from k8s_incident_agent.scenarios.contracts import (
    PublicScenario,
    ScenarioTarget,
    ScenarioTrigger,
)

SERVICE_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 26, 9, 0, tzinfo=UTC)


def _alembic_config(paths: RuntimePaths) -> Config:
    config = Config(str(SERVICE_ROOT / "alembic.ini"))
    config.attributes["runtime_paths"] = paths
    return config


@asynccontextmanager
async def _database(tmp_path: Path) -> AsyncGenerator[BusinessDatabase]:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await create_business_database(paths)
    try:
        yield database
    finally:
        await database.dispose()


def _scenario() -> PublicScenario:
    return PublicScenario(
        scenario_id="image-pull-backoff",
        scenario_version=2,
        monitoring_alert_id="K8sIncidentImagePullBackOff",
        display_name="Image pull failure",
        description="A Deployment cannot pull its configured image.",
        trigger=ScenarioTrigger(
            type="manual",
            summary="The target Deployment is unavailable.",
        ),
        target=ScenarioTarget(
            cluster="k8s-incident-agent",
            namespace="k8s-incident-scenarios",
            api_version="apps/v1",
            kind="Deployment",
            name="image-pull-backoff",
        ),
    )


class _Scheduler:
    def __init__(self, repository: IncidentRepository, *, fail: bool = False) -> None:
        self.repository = repository
        self.fail = fail
        self.scheduled: list[UUID] = []

    async def schedule(self, run_id: UUID) -> None:
        snapshot = await self.repository.get_workflow_run_snapshot(run_id)
        assert snapshot.run_status is RunStatus.QUEUED
        self.scheduled.append(run_id)
        if self.fail:
            raise RuntimeError("schedule notification failed")


def _service(
    repository: IncidentRepository,
    *,
    scheduler: _Scheduler | None = None,
    credential_lifetime: int = 3600,
) -> tuple[IncidentApplicationService, _Scheduler]:
    resolved_scheduler = scheduler or _Scheduler(repository)
    credential = DiagnosticCredential(
        kubeconfig_path=Path("/unused/diagnostic.kubeconfig"),
        context_name="kind-k8s-incident-agent",
        server_url="https://127.0.0.1:6443",
        expires_at=NOW + timedelta(seconds=credential_lifetime),
        _kubeconfig={},
    )
    return (
        IncidentApplicationService(
            catalog=(_scenario(),),
            repository=repository,
            supervisor=resolved_scheduler,
            credential=credential,
            model=lambda: ModelSnapshot(
                provider="deepseek",
                model_id="deepseek-v4-flash",
                thinking_mode=False,
                prompt_version="stage1-v1",
            ),
            budget=RunBudget(
                max_model_calls=8,
                max_tool_calls=6,
                timeout_seconds=180,
            ),
            now=lambda: NOW,
        ),
        resolved_scheduler,
    )


@pytest.mark.asyncio
async def test_create_commits_before_schedule_and_returns_persisted_identity(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        service, scheduler = _service(repository)

        response = await service.create_incident(
            CreateIncidentRequest(scenario_id="image-pull-backoff")
        )

        assert len(scheduler.scheduled) == 1
        run_id = scheduler.scheduled[0]
        snapshot = await repository.get_workflow_run_snapshot(run_id)
        assert isinstance(snapshot, DiagnosisWorkflowRunSnapshot)
        assert snapshot.incident_id == response.incident_id
        assert snapshot.model.model_id == "deepseek-v4-flash"
        assert snapshot.budget == RunBudget(8, 6, 180)


@pytest.mark.asyncio
async def test_schedule_failure_keeps_committed_queued_run_for_reconciliation(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        scheduler = _Scheduler(repository, fail=True)
        service, _ = _service(repository, scheduler=scheduler)

        response = await service.create_incident(
            CreateIncidentRequest(scenario_id="image-pull-backoff")
        )

        assert len(scheduler.scheduled) == 1
        run_id = scheduler.scheduled[0]
        snapshot = await repository.get_workflow_run_snapshot(run_id)
        assert snapshot.run_status is RunStatus.QUEUED
        assert await repository.list_recoverable_run_ids() == (run_id,)
        assert snapshot.incident_id == response.incident_id


@pytest.mark.asyncio
async def test_unknown_scenario_and_short_ttl_create_no_partial_rows(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        service, _ = _service(repository, credential_lifetime=239)

        with pytest.raises(ScenarioNotFoundError):
            await service.create_incident(CreateIncidentRequest(scenario_id="unknown"))
        with pytest.raises(RuntimeNotReadyError):
            await service.create_incident(
                CreateIncidentRequest(scenario_id="image-pull-backoff")
            )

        async with database.session_factory() as session:
            assert (
                await session.scalar(select(func.count()).select_from(IncidentRow)) == 0
            )


@pytest.mark.asyncio
async def test_list_uses_descending_keyset_order_and_canonical_cursor(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        service, _ = _service(repository)
        for _ in range(3):
            await service.create_incident(
                CreateIncidentRequest(scenario_id="image-pull-backoff")
            )
        async with database.session_factory() as session, session.begin():
            rows = list(await session.scalars(select(IncidentRow)))
            for row in rows:
                row.created_at = NOW
                row.updated_at = NOW
        expected = sorted((UUID(row.id) for row in rows), reverse=True)

        first = await service.list_incidents(limit=2, cursor=None)
        assert [item.id for item in first.items] == expected[:2]
        assert first.next_cursor is not None
        assert "=" not in first.next_cursor

        boundary = first.items[-1]
        equivalent_cursor = _cursor_document(
            {
                "id": f"{{{str(boundary.id).upper()}}}",
                "extra": "ignored",
                "createdAt": NOW.isoformat(),
            },
            padded=True,
            compact=False,
        )
        assert equivalent_cursor.endswith("=")

        second = await service.list_incidents(limit=2, cursor=equivalent_cursor)
        assert [item.id for item in second.items] == expected[2:]
        assert second.next_cursor is None


def _cursor_document(
    value: dict[str, object],
    *,
    padded: bool = False,
    compact: bool = True,
) -> str:
    encoded = base64.urlsafe_b64encode(
        json.dumps(
            value,
            separators=(",", ":") if compact else None,
            sort_keys=compact,
        ).encode()
    )
    return (encoded if padded else encoded.rstrip(b"=")).decode()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cursor",
    [
        "not-valid!",
        base64.urlsafe_b64encode(b"{").rstrip(b"=").decode(),
        _cursor_document({"id": "00000000-0000-0000-0000-000000000001"}),
        _cursor_document({"createdAt": "2026-08-26T09:00:00Z"}),
        _cursor_document(
            {
                "createdAt": 1,
                "id": "00000000-0000-0000-0000-000000000001",
            }
        ),
        _cursor_document(
            {
                "createdAt": "2026-08-26T09:00:00Z",
                "id": 1,
            }
        ),
        _cursor_document(
            {
                "createdAt": "not-a-timestamp",
                "id": "00000000-0000-0000-0000-000000000001",
            }
        ),
        _cursor_document(
            {
                "createdAt": "2026-08-26T10:00:00+01:00",
                "id": "00000000-0000-0000-0000-000000000001",
            }
        ),
        _cursor_document(
            {
                "createdAt": "2026-08-26T09:00:00Z",
                "id": "not-a-uuid",
            }
        ),
    ],
)
async def test_list_rejects_semantically_invalid_cursor(
    tmp_path: Path,
    cursor: str,
) -> None:
    async with _database(tmp_path) as database:
        service, _ = _service(IncidentRepository(database.session_factory))

        with pytest.raises(InvalidCursorError):
            await service.list_incidents(limit=20, cursor=cursor)


@pytest.mark.asyncio
async def test_run_and_event_cursors_reject_json_booleans(tmp_path: Path) -> None:
    incident_id = UUID("00000000-0000-4000-8000-000000000001")
    run_id = UUID("00000000-0000-4000-8000-000000000002")
    async with _database(tmp_path) as database:
        service, _ = _service(IncidentRepository(database.session_factory))

        with pytest.raises(InvalidCursorError):
            await service.list_runs(
                incident_id,
                limit=20,
                cursor=_cursor_document(
                    {"incidentId": str(incident_id), "attempt": True}
                ),
            )
        with pytest.raises(InvalidCursorError):
            await service.list_run_events(
                incident_id,
                run_id,
                limit=100,
                cursor=_cursor_document(
                    {
                        "incidentId": str(incident_id),
                        "runId": str(run_id),
                        "eventId": True,
                    }
                ),
            )


@pytest.mark.asyncio
async def test_detail_projects_terminal_run_and_sorts_evidence_by_time_then_id(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        service, _ = _service(repository)
        created = await repository.create_incident_and_run(
            normalized_trigger(),
            ModelSnapshot("deepseek", "deepseek-v4-flash", False, "stage1-v1"),
            RunBudget(8, 6, 180),
        )
        await repository.start_run(created.run_id, NOW)
        persisted: list[PersistedEvidence] = []
        for call_id in ("call-b", "call-a"):
            await repository.record_tool_started(
                created.run_id,
                call_id,
                "get_workload",
            )
            persisted.append(
                await repository.record_evidence(
                    EvidenceRecord(
                        run_id=created.run_id,
                        tool_call_id=call_id,
                        tool_name="get_workload",
                        evidence_kind="workload",
                        target_ref={"name": "image-pull-backoff"},
                        observed_at=NOW + timedelta(seconds=5),
                        payload={"workload": {"resourceVersion": "1"}},
                        truncated=False,
                        redacted=False,
                    )
                )
            )
        await repository.persist_terminal(
            TerminalRecord(
                run_id=created.run_id,
                completed_at=NOW + timedelta(seconds=30),
                outcome=DiagnosisOutcome.DIAGNOSED,
                summary="The image cannot be pulled.",
                root_causes=(
                    RootCauseRecord(
                        code="image_pull_failure",
                        statement="The configured image is unavailable.",
                        confidence="high",
                        evidence_ids=tuple(item.id for item in persisted),
                    ),
                ),
                missing_information=(),
                redacted=False,
                error_code=None,
                error_retryable=None,
                model_calls=4,
                tool_calls=3,
                input_tokens=1000,
                output_tokens=200,
            )
        )

        response = await service.get_incident(created.incident_id, run_id=None)

        assert response.selected_run.id == created.run_id
        assert response.selected_run.attempt == 1
        assert response.selected_run.status is RunStatus.COMPLETED
        assert response.selected_run.error is None
        assert response.diagnosis is not None
        assert response.diagnosis.outcome is DiagnosisOutcome.DIAGNOSED
        assert [item.id for item in response.evidence] == sorted(
            item.id for item in persisted
        )
        assert response.event_page.items[0].root.event == "diagnosis.completed"
