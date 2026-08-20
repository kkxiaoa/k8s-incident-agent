from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import event, func, select
from sqlalchemy.exc import OperationalError

from k8s_incident_agent.domain.models import (
    EvidenceRecord,
    ModelSnapshot,
    RunBudget,
)
from k8s_incident_agent.persistence.database import (
    BusinessDatabase,
    create_business_database,
)
from k8s_incident_agent.persistence.models import (
    EvidenceRow,
    IncidentRow,
    RunEventRow,
    RunRow,
)
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    PersistenceOperationError,
)
from k8s_incident_agent.runtime.paths import RuntimePaths
from k8s_incident_agent.scenarios.contracts import (
    PublicScenario,
    ScenarioTarget,
    ScenarioTrigger,
)

SERVICE_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 17, 9, 0, tzinfo=UTC)


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
        scenario_version=1,
        display_name="Image pull failure",
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


def _model() -> ModelSnapshot:
    return ModelSnapshot(
        provider="deepseek",
        model_id="deepseek-v4-flash",
        thinking_mode=False,
        prompt_version="stage1-v1",
    )


def _budget() -> RunBudget:
    return RunBudget(max_model_calls=8, max_tool_calls=6, timeout_seconds=180)


async def _row_count(database: BusinessDatabase, row_type: type[object]) -> int:
    async with database.session_factory() as session:
        count = await session.scalar(select(func.count()).select_from(row_type))
    assert count is not None
    return count


@pytest.mark.asyncio
async def test_create_incident_run_and_event_are_one_transaction(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)

        created = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )

        assert created.incident_status.value == "RECEIVED"
        assert created.run_status.value == "QUEUED"
        assert created.event.event_key == "incident.created"
        assert created.event.event_type == "incident.created"
        assert created.event.payload == {
            "incidentId": str(created.incident_id),
            "incidentStatus": "RECEIVED",
            "occurredAt": created.event.occurred_at.isoformat().replace("+00:00", "Z"),
            "runId": str(created.run_id),
            "runStatus": "QUEUED",
            "scenarioId": "image-pull-backoff",
            "schemaVersion": 1,
        }
        assert await _row_count(database, IncidentRow) == 1
        assert await _row_count(database, RunRow) == 1
        assert await _row_count(database, RunEventRow) == 1


@pytest.mark.asyncio
async def test_create_rolls_back_all_rows_when_event_insert_fails(
    tmp_path: Path,
) -> None:
    def fail_event_insert(
        _mapper: object, _connection: object, _target: object
    ) -> None:
        raise OperationalError(
            "sensitive SQL",
            {"token": "must-not-leak"},
            RuntimeError("/private/database/path"),
        )

    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        event.listen(RunEventRow, "before_insert", fail_event_insert)
        try:
            with pytest.raises(PersistenceOperationError) as error:
                await repository.create_incident_and_run(
                    _scenario(), _model(), _budget()
                )
        finally:
            event.remove(RunEventRow, "before_insert", fail_event_insert)

        assert str(error.value) == "Persistence operation failed"
        assert "sensitive" not in str(error.value)
        assert await _row_count(database, IncidentRow) == 0
        assert await _row_count(database, RunRow) == 0
        assert await _row_count(database, RunEventRow) == 0


@pytest.mark.asyncio
async def test_start_run_updates_both_states_and_records_one_event(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )

        run = await repository.start_run(created.run_id, NOW)

        assert run.status.value == "RUNNING"
        assert run.incident_status.value == "TRIAGING"
        assert run.started_at == NOW
        assert run.event.event_key == "run.started"
        assert run.event.event_type == "run.started"
        assert run.event.payload["incidentStatus"] == "TRIAGING"
        assert run.event.payload["runStatus"] == "RUNNING"


@pytest.mark.asyncio
async def test_start_run_rolls_back_both_states_when_event_insert_fails(
    tmp_path: Path,
) -> None:
    def fail_started_event(
        _mapper: object, _connection: object, target: RunEventRow
    ) -> None:
        if target.event_type == "run.started":
            raise OperationalError("statement", {}, RuntimeError("database failed"))

    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )
        event.listen(RunEventRow, "before_insert", fail_started_event)
        try:
            with pytest.raises(PersistenceOperationError):
                await repository.start_run(created.run_id, NOW)
        finally:
            event.remove(RunEventRow, "before_insert", fail_started_event)

        async with database.session_factory() as session:
            incident = await session.get(IncidentRow, str(created.incident_id))
            run = await session.get(RunRow, str(created.run_id))
            assert incident is not None
            assert run is not None
            assert incident.status.value == "RECEIVED"
            assert run.status.value == "QUEUED"
            assert run.started_at is None
        assert await _row_count(database, RunEventRow) == 1


@pytest.mark.asyncio
async def test_evidence_and_event_are_committed_atomically(tmp_path: Path) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )
        await repository.start_run(created.run_id, NOW)
        evidence_record = EvidenceRecord(
            run_id=created.run_id,
            tool_call_id="call-1",
            tool_name="get_pods",
            evidence_kind="pod_waiting_state",
            target_ref={"name": "pod-a", "namespace": "k8s-incident-scenarios"},
            observed_at=NOW,
            payload={"waitingReason": "ImagePullBackOff"},
            truncated=False,
            redacted=False,
        )

        persisted = await repository.record_evidence(evidence_record)

        assert persisted.event.event_key == "tool:call-1:evidence"
        assert persisted.event.event_type == "evidence.recorded"
        assert persisted.event.payload["evidenceId"] == str(persisted.id)
        assert await _row_count(database, EvidenceRow) == 1


@pytest.mark.asyncio
async def test_evidence_rolls_back_when_its_event_insert_fails(tmp_path: Path) -> None:
    def fail_evidence_event(
        _mapper: object, _connection: object, target: RunEventRow
    ) -> None:
        if target.event_type == "evidence.recorded":
            raise OperationalError("statement", {}, RuntimeError("database failed"))

    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )
        await repository.start_run(created.run_id, NOW)
        event.listen(RunEventRow, "before_insert", fail_evidence_event)
        try:
            with pytest.raises(PersistenceOperationError):
                await repository.record_evidence(
                    EvidenceRecord(
                        run_id=created.run_id,
                        tool_call_id="call-1",
                        tool_name="get_pods",
                        evidence_kind="pod_waiting_state",
                        target_ref={"name": "pod-a"},
                        observed_at=NOW,
                        payload={"waitingReason": "ImagePullBackOff"},
                        truncated=False,
                        redacted=False,
                    )
                )
        finally:
            event.remove(RunEventRow, "before_insert", fail_evidence_event)

        assert await _row_count(database, EvidenceRow) == 0
        assert await _row_count(database, RunEventRow) == 2
