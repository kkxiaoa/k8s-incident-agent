from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import event, func, select
from sqlalchemy.exc import IntegrityError, OperationalError
from tests.factories import normalized_trigger

from k8s_incident_agent.domain.models import (
    DiagnosisOutcome,
    EvidenceRecord,
    ModelSnapshot,
    RootCauseRecord,
    RunBudget,
    RunRecord,
    TerminalRecord,
    ToolFailureRecord,
)
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.persistence.database import (
    BusinessDatabase,
    create_business_database,
)
from k8s_incident_agent.persistence.models import (
    DiagnosisRow,
    IncidentRow,
    RunEventRow,
    RunRow,
)
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    PersistenceOperationError,
    RecoveryConsistencyError,
    diagnosis_id,
    evidence_id,
)
from k8s_incident_agent.runtime.paths import RuntimePaths

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


def _scenario(name: str = "image-pull-backoff"):
    return normalized_trigger(name)


MODEL = ModelSnapshot(
    provider="deepseek",
    model_id="deepseek-v4-flash",
    thinking_mode=False,
    prompt_version="stage1-v1",
)
BUDGET = RunBudget(max_model_calls=8, max_tool_calls=6, timeout_seconds=180)


async def _event_count(database: BusinessDatabase) -> int:
    async with database.session_factory() as session:
        count = await session.scalar(select(func.count()).select_from(RunEventRow))
    assert count is not None
    return count


class _ReplayReadFailureRepository(IncidentRepository):
    async def _start_run_once(self, run_id: UUID, started_at: datetime) -> RunRecord:
        raise IntegrityError("insert", {}, RuntimeError("idempotency conflict"))

    async def _replay_start_run(self, run_id: UUID, started_at: datetime) -> RunRecord:
        raise OperationalError(
            "sensitive SELECT",
            {"token": "must-not-leak"},
            RuntimeError("/private/database/path"),
        )


def test_canonical_json_is_utf8_sorted_and_compact() -> None:
    assert canonical_json({"z": "镜像", "a": [2, 1]}) == '{"a":[2,1],"z":"镜像"}'


@pytest.mark.asyncio
async def test_database_error_during_replay_is_sanitized(tmp_path: Path) -> None:
    async with _database(tmp_path) as database:
        repository = _ReplayReadFailureRepository(database.session_factory)

        with pytest.raises(PersistenceOperationError) as error:
            await repository.start_run(uuid4(), NOW)

        assert str(error.value) == "Persistence operation failed"


@pytest.mark.asyncio
async def test_same_start_and_tool_events_replay_without_duplicate_rows(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(_scenario(), MODEL, BUDGET)

        first_start = await repository.start_run(created.run_id, NOW)
        replayed_start = await repository.start_run(created.run_id, NOW)
        first_tool = await repository.record_tool_started(
            created.run_id, "call-1", "get_pods"
        )
        replayed_tool = await repository.record_tool_started(
            created.run_id, "call-1", "get_pods"
        )

        assert replayed_start == first_start
        assert replayed_tool == first_tool
        assert await _event_count(database) == 3


@pytest.mark.asyncio
async def test_same_event_key_with_different_content_fails_closed(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(_scenario(), MODEL, BUDGET)
        await repository.start_run(created.run_id, NOW)
        await repository.record_tool_started(created.run_id, "call-1", "get_pods")

        with pytest.raises(RecoveryConsistencyError):
            await repository.record_tool_started(created.run_id, "call-1", "get_events")
        with pytest.raises(RecoveryConsistencyError):
            await repository.start_run(created.run_id, NOW + timedelta(seconds=1))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "corrupted_field",
    [
        "run_updated_at",
        "event_occurred_at",
    ],
)
async def test_start_replay_rejects_inconsistent_persisted_side_effect(
    tmp_path: Path,
    corrupted_field: str,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(_scenario(), MODEL, BUDGET)
        await repository.start_run(created.run_id, NOW)

        async with database.session_factory() as session, session.begin():
            run = await session.get(RunRow, str(created.run_id))
            event_row = await session.scalar(
                select(RunEventRow).where(
                    RunEventRow.run_id == str(created.run_id),
                    RunEventRow.event_key == "run.started",
                )
            )
            assert run is not None
            assert event_row is not None
            if corrupted_field == "run_updated_at":
                run.updated_at = NOW + timedelta(seconds=1)
            elif corrupted_field == "event_occurred_at":
                event_row.occurred_at = NOW + timedelta(seconds=1)
            else:
                raise AssertionError("Unknown persisted side effect")

        with pytest.raises(RecoveryConsistencyError):
            await repository.start_run(created.run_id, NOW)


@pytest.mark.asyncio
async def test_evidence_replay_uses_canonical_content_and_stable_uuid(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(_scenario(), MODEL, BUDGET)
        await repository.start_run(created.run_id, NOW)
        evidence = EvidenceRecord(
            run_id=created.run_id,
            tool_call_id="call-1",
            tool_name="get_pods",
            evidence_kind="pod_waiting_state",
            target_ref={"namespace": "ns", "name": "pod-a"},
            observed_at=NOW,
            payload={"reason": "ImagePullBackOff", "ready": False},
            truncated=False,
            redacted=False,
        )

        first = await repository.record_evidence(evidence)
        replayed = await repository.record_evidence(
            EvidenceRecord(
                run_id=created.run_id,
                tool_call_id="call-1",
                tool_name="get_pods",
                evidence_kind="pod_waiting_state",
                target_ref={"name": "pod-a", "namespace": "ns"},
                observed_at=NOW,
                payload={"ready": False, "reason": "ImagePullBackOff"},
                truncated=False,
                redacted=False,
            )
        )

        assert first == replayed
        assert first.id == evidence_id(created.run_id, "call-1")
        assert await _event_count(database) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("success_first", [True, False])
async def test_tool_success_and_failure_cannot_coexist(
    tmp_path: Path,
    success_first: bool,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(_scenario(), MODEL, BUDGET)
        await repository.start_run(created.run_id, NOW)
        evidence = EvidenceRecord(
            run_id=created.run_id,
            tool_call_id="call-1",
            tool_name="get_pods",
            evidence_kind="pods",
            target_ref={"name": "deployment-a"},
            observed_at=NOW,
            payload={"items": []},
            truncated=False,
            redacted=False,
        )
        failure = ToolFailureRecord(
            run_id=created.run_id,
            tool_call_id="call-1",
            tool_name="get_pods",
            error_code="request_timeout",
            retryable=True,
            occurred_at=NOW,
        )

        if success_first:
            await repository.record_evidence(evidence)
            conflicting_operation = repository.record_tool_failure(failure)
        else:
            await repository.record_tool_failure(failure)
            conflicting_operation = repository.record_evidence(evidence)

        with pytest.raises(RecoveryConsistencyError):
            await conflicting_operation


@pytest.mark.asyncio
async def test_tool_failure_replays_only_identical_canonical_failure(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(_scenario(), MODEL, BUDGET)
        await repository.start_run(created.run_id, NOW)
        failure = ToolFailureRecord(
            run_id=created.run_id,
            tool_call_id="call-1",
            tool_name="get_events",
            error_code="permission_denied",
            retryable=False,
            occurred_at=NOW,
        )

        first = await repository.record_tool_failure(failure)
        replayed = await repository.record_tool_failure(failure)

        assert first == replayed
        assert first.event_key == "tool:call-1:failed"
        assert first.event_type == "tool.failed"


@pytest.mark.asyncio
async def test_terminal_replay_rejects_different_terminal_content(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(_scenario(), MODEL, BUDGET)
        await repository.start_run(created.run_id, NOW)
        evidence = await repository.record_evidence(
            EvidenceRecord(
                run_id=created.run_id,
                tool_call_id="call-1",
                tool_name="get_pods",
                evidence_kind="pods",
                target_ref={"name": "deployment-a"},
                observed_at=NOW,
                payload={"items": []},
                truncated=False,
                redacted=False,
            )
        )
        terminal = TerminalRecord(
            run_id=created.run_id,
            completed_at=NOW + timedelta(seconds=2),
            outcome=DiagnosisOutcome.DIAGNOSED,
            summary="The image cannot be pulled.",
            root_causes=(
                RootCauseRecord(
                    code="image_pull_failure",
                    statement="The registry name does not resolve.",
                    confidence="high",
                    evidence_ids=(evidence.id,),
                ),
            ),
            missing_information=(),
            redacted=False,
            error_code=None,
            error_retryable=None,
            model_calls=3,
            tool_calls=2,
            input_tokens=100,
            output_tokens=50,
        )

        first = await repository.persist_terminal(terminal)
        replayed = await repository.persist_terminal(terminal)

        assert first == replayed
        assert first.diagnosis_id == diagnosis_id(created.run_id)
        assert first.event.event_key == "run:terminal"
        assert first.event.event_type == "diagnosis.completed"
        assert await _event_count(database) == 4

        with pytest.raises(RecoveryConsistencyError):
            await repository.persist_terminal(
                replace(terminal, summary="Different terminal content")
            )

        with pytest.raises(RecoveryConsistencyError):
            await repository.persist_terminal(
                TerminalRecord(
                    run_id=created.run_id,
                    completed_at=terminal.completed_at,
                    outcome=DiagnosisOutcome.INSUFFICIENT_EVIDENCE,
                    summary="The available evidence is insufficient.",
                    root_causes=(),
                    missing_information=("Pod status is unavailable.",),
                    redacted=False,
                    error_code=None,
                    error_retryable=None,
                    model_calls=3,
                    tool_calls=2,
                    input_tokens=100,
                    output_tokens=50,
                )
            )

        with pytest.raises(RecoveryConsistencyError):
            await repository.persist_terminal(
                TerminalRecord(
                    run_id=created.run_id,
                    completed_at=terminal.completed_at,
                    outcome=None,
                    summary=None,
                    root_causes=(),
                    missing_information=(),
                    redacted=False,
                    error_code="agent_timeout",
                    error_retryable=True,
                    model_calls=3,
                    tool_calls=2,
                    input_tokens=100,
                    output_tokens=50,
                )
            )

        assert await _event_count(database) == 4


@pytest.mark.asyncio
async def test_terminal_replay_rejects_inconsistent_run_updated_at(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(_scenario(), MODEL, BUDGET)
        await repository.start_run(created.run_id, NOW)
        terminal = TerminalRecord(
            run_id=created.run_id,
            completed_at=NOW + timedelta(seconds=1),
            outcome=None,
            summary=None,
            root_causes=(),
            missing_information=(),
            redacted=False,
            error_code="request_timeout",
            error_retryable=True,
            model_calls=1,
            tool_calls=1,
            input_tokens=10,
            output_tokens=5,
        )
        await repository.persist_terminal(terminal)

        async with database.session_factory() as session, session.begin():
            run = await session.get(RunRow, str(created.run_id))
            assert run is not None
            run.updated_at = terminal.completed_at + timedelta(seconds=1)

        with pytest.raises(RecoveryConsistencyError):
            await repository.persist_terminal(terminal)


@pytest.mark.asyncio
async def test_terminal_rolls_back_diagnosis_and_states_when_event_insert_fails(
    tmp_path: Path,
) -> None:
    def fail_terminal_event(
        _mapper: object, _connection: object, target: RunEventRow
    ) -> None:
        if target.event_key == "run:terminal":
            raise OperationalError("statement", {}, RuntimeError("database failed"))

    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(_scenario(), MODEL, BUDGET)
        await repository.start_run(created.run_id, NOW)
        event.listen(RunEventRow, "before_insert", fail_terminal_event)
        try:
            with pytest.raises(PersistenceOperationError):
                await repository.persist_terminal(
                    TerminalRecord(
                        run_id=created.run_id,
                        completed_at=NOW + timedelta(seconds=1),
                        outcome=DiagnosisOutcome.INSUFFICIENT_EVIDENCE,
                        summary="The available evidence is insufficient.",
                        root_causes=(),
                        missing_information=("Pod status is unavailable.",),
                        redacted=False,
                        error_code=None,
                        error_retryable=None,
                        model_calls=1,
                        tool_calls=1,
                        input_tokens=10,
                        output_tokens=5,
                    )
                )
        finally:
            event.remove(RunEventRow, "before_insert", fail_terminal_event)

        async with database.session_factory() as session:
            incident = await session.get(IncidentRow, str(created.incident_id))
            run = await session.get(RunRow, str(created.run_id))
            assert incident is not None
            assert run is not None
            assert incident.status.value == "TRIAGING"
            assert run.status.value == "RUNNING"
            assert run.completed_at is None
            assert (
                await session.scalar(select(func.count()).select_from(DiagnosisRow))
                == 0
            )
        assert await _event_count(database) == 2


@pytest.mark.asyncio
async def test_terminal_rejects_evidence_from_another_run(tmp_path: Path) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        first = await repository.create_incident_and_run(_scenario(), MODEL, BUDGET)
        second = await repository.create_incident_and_run(
            _scenario("another-scenario"), MODEL, BUDGET
        )
        await repository.start_run(first.run_id, NOW)
        await repository.start_run(second.run_id, NOW)
        foreign_evidence = await repository.record_evidence(
            EvidenceRecord(
                run_id=first.run_id,
                tool_call_id="call-1",
                tool_name="get_pods",
                evidence_kind="pods",
                target_ref={"name": "deployment-a"},
                observed_at=NOW,
                payload={"items": []},
                truncated=False,
                redacted=False,
            )
        )

        with pytest.raises(RecoveryConsistencyError):
            await repository.persist_terminal(
                TerminalRecord(
                    run_id=second.run_id,
                    completed_at=NOW,
                    outcome=DiagnosisOutcome.DIAGNOSED,
                    summary="Diagnosis",
                    root_causes=(
                        RootCauseRecord(
                            code="image_pull_failure",
                            statement="Failure",
                            confidence="high",
                            evidence_ids=(foreign_evidence.id,),
                        ),
                    ),
                    missing_information=(),
                    redacted=False,
                    error_code=None,
                    error_retryable=None,
                    model_calls=1,
                    tool_calls=1,
                    input_tokens=1,
                    output_tokens=1,
                )
            )

        async with database.session_factory() as session:
            assert (
                await session.scalar(select(func.count()).select_from(DiagnosisRow))
                == 0
            )
