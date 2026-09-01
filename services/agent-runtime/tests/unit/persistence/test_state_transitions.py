from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from tests.factories import normalized_trigger

from k8s_incident_agent.domain.models import (
    DiagnosisOutcome,
    ModelSnapshot,
    RunBudget,
    TerminalRecord,
)
from k8s_incident_agent.persistence.database import (
    BusinessDatabase,
    create_business_database,
)
from k8s_incident_agent.persistence.models import IncidentRow, RunRow
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    RecoveryConsistencyError,
)
from k8s_incident_agent.runtime.paths import RuntimePaths

SERVICE_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 17, 9, 0, tzinfo=UTC)
MODEL = ModelSnapshot(
    provider="deepseek",
    model_id="deepseek-v4-flash",
    thinking_mode=False,
    prompt_version="stage1-v1",
)
BUDGET = RunBudget(max_model_calls=8, max_tool_calls=6, timeout_seconds=180)


@asynccontextmanager
async def _database(tmp_path: Path) -> AsyncGenerator[BusinessDatabase]:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    config = Config(str(SERVICE_ROOT / "alembic.ini"))
    config.attributes["runtime_paths"] = paths
    command.upgrade(config, "head")
    database = await create_business_database(paths)
    try:
        yield database
    finally:
        await database.dispose()


def _scenario():
    return normalized_trigger()


def _failure_terminal(run_id: UUID) -> TerminalRecord:
    return TerminalRecord(
        run_id=run_id,
        completed_at=NOW,
        outcome=None,
        summary=None,
        root_causes=(),
        missing_information=(),
        redacted=False,
        error_code="authentication_failed",
        error_retryable=False,
        model_calls=0,
        tool_calls=0,
        input_tokens=None,
        output_tokens=None,
    )


def test_terminal_record_rejects_mixed_diagnosis_and_error_data() -> None:
    with pytest.raises(ValueError):
        TerminalRecord(
            run_id=uuid4(),
            completed_at=NOW,
            outcome=DiagnosisOutcome.DIAGNOSED,
            summary="Diagnosis",
            root_causes=(),
            missing_information=(),
            redacted=False,
            error_code="model_upstream_failed",
            error_retryable=None,
            model_calls=1,
            tool_calls=0,
            input_tokens=None,
            output_tokens=None,
        )


@pytest.mark.asyncio
async def test_queued_run_can_fail_in_one_terminal_transaction(tmp_path: Path) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(_scenario(), MODEL, BUDGET)

        terminal = await repository.persist_terminal(_failure_terminal(created.run_id))

        assert terminal.incident_status.value == "FAILED"
        assert terminal.run_status.value == "FAILED"
        assert terminal.diagnosis_id is None
        assert terminal.event.event_key == "run:terminal"
        assert terminal.event.event_type == "run.failed"
        assert terminal.event.payload["errorCode"] == "authentication_failed"
        async with database.session_factory() as session:
            incident = await session.get(IncidentRow, str(created.incident_id))
            run = await session.get(RunRow, str(created.run_id))
            assert incident is not None
            assert run is not None
            assert incident.status.value == "FAILED"
            assert run.status.value == "FAILED"
            assert run.error_code == "authentication_failed"
            assert run.error_retryable is False


@pytest.mark.asyncio
async def test_diagnosis_terminal_is_rejected_before_run_starts(tmp_path: Path) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(_scenario(), MODEL, BUDGET)
        terminal = TerminalRecord(
            run_id=created.run_id,
            completed_at=NOW,
            outcome=DiagnosisOutcome.INSUFFICIENT_EVIDENCE,
            summary="Evidence is unavailable.",
            root_causes=(),
            missing_information=("Pod status is missing.",),
            redacted=False,
            error_code=None,
            error_retryable=None,
            model_calls=1,
            tool_calls=0,
            input_tokens=10,
            output_tokens=5,
        )

        with pytest.raises(RecoveryConsistencyError):
            await repository.persist_terminal(terminal)

        async with database.session_factory() as session:
            incident = await session.get(IncidentRow, str(created.incident_id))
            run = await session.get(RunRow, str(created.run_id))
            assert incident is not None
            assert run is not None
            assert incident.status.value == "RECEIVED"
            assert run.status.value == "QUEUED"
