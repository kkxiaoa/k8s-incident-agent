from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import event, select
from sqlalchemy.exc import OperationalError

from k8s_incident_agent.diagnosis.contracts import DiagnosisCandidate
from k8s_incident_agent.diagnosis.validation import (
    DiagnosisValidationError,
    UnresolvedToolFailuresError,
    validate_diagnosis,
)
from k8s_incident_agent.domain.models import (
    EvidenceRecord,
    ModelSnapshot,
    RunBudget,
    ToolFailureRecord,
)
from k8s_incident_agent.persistence.database import (
    BusinessDatabase,
    create_business_database,
)
from k8s_incident_agent.persistence.models import RunEventRow
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    PersistenceOperationError,
    RecoveryConsistencyError,
)
from k8s_incident_agent.runtime.paths import RuntimePaths
from k8s_incident_agent.scenarios.contracts import (
    PublicScenario,
    ScenarioTarget,
    ScenarioTrigger,
)

SERVICE_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 23, 9, 0, tzinfo=UTC)
MODEL = ModelSnapshot(
    provider="deepseek",
    model_id="deepseek-v4-flash",
    thinking_mode=False,
    prompt_version="stage1-v1",
)
BUDGET = RunBudget(max_model_calls=8, max_tool_calls=6, timeout_seconds=180)


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


def _scenario(name: str) -> PublicScenario:
    return PublicScenario(
        scenario_id=name,
        scenario_version=1,
        display_name="Public incident",
        trigger=ScenarioTrigger(type="manual", summary="Deployment unavailable"),
        target=ScenarioTarget(
            cluster="k8s-incident-agent",
            namespace="k8s-incident-scenarios",
            api_version="apps/v1",
            kind="Deployment",
            name=name,
        ),
    )


async def _running_run(repository: IncidentRepository, name: str) -> UUID:
    created = await repository.create_incident_and_run(_scenario(name), MODEL, BUDGET)
    await repository.start_run(created.run_id, NOW)
    return created.run_id


async def _record_evidence(
    repository: IncidentRepository,
    run_id: UUID,
    *,
    tool_call_id: str,
    tool_name: str,
) -> UUID:
    await repository.record_tool_started(run_id, tool_call_id, tool_name)
    persisted = await repository.record_evidence(
        _evidence_record(run_id, tool_call_id=tool_call_id, tool_name=tool_name)
    )
    return persisted.id


def _evidence_record(
    run_id: UUID,
    *,
    tool_call_id: str,
    tool_name: str,
) -> EvidenceRecord:
    return EvidenceRecord(
        run_id=run_id,
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        evidence_kind=tool_name.removeprefix("get_"),
        target_ref={"name": "deployment-a"},
        observed_at=NOW,
        payload={"observed": True},
        truncated=False,
        redacted=False,
    )


async def _record_failure(
    repository: IncidentRepository,
    run_id: UUID,
    *,
    tool_call_id: str,
    tool_name: str,
    error_code: str,
    retryable: bool,
    occurred_at: datetime = NOW,
) -> None:
    await repository.record_tool_started(run_id, tool_call_id, tool_name)
    await repository.record_tool_failure(
        ToolFailureRecord(
            run_id=run_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            error_code=error_code,
            retryable=retryable,
            occurred_at=occurred_at,
        )
    )


def _diagnosed(
    evidence_id: UUID,
    *,
    code: str = "observed_runtime_failure",
    summary: str = "The observations support a diagnosis.",
    statement: str = "The cited evidence identifies the failure.",
) -> DiagnosisCandidate:
    return DiagnosisCandidate.model_validate(
        {
            "outcome": "diagnosed",
            "summary": summary,
            "root_causes": [
                {
                    "code": code,
                    "statement": statement,
                    "confidence": "high",
                    "evidence_ids": [str(evidence_id)],
                }
            ],
            "missing_information": [],
        }
    )


def _insufficient(
    *,
    summary: str = "The available observations are insufficient.",
    missing: str = "A successful observation is still required.",
) -> DiagnosisCandidate:
    return DiagnosisCandidate.model_validate(
        {
            "outcome": "insufficient_evidence",
            "summary": summary,
            "root_causes": [],
            "missing_information": [missing],
        }
    )


def _text_that_expands_during_redaction(max_code_points: int) -> str:
    suffix = " token=a"
    return "x" * (max_code_points - len(suffix)) + suffix


@pytest.mark.asyncio
async def test_validator_sanitizes_model_text_and_preserves_model_code(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "valid-diagnosis")
        evidence_id = await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-pods",
            tool_name="get_pods",
        )
        candidate = _diagnosed(
            evidence_id,
            code="registry_observation",
            summary="Observed state\x00 api_key=provider-secret",
            statement="Authorization: Bearer opaque-secret",
        )

        validated = await validate_diagnosis(candidate, run_id, repository)

        serialized = validated.model_dump_json()
        assert validated.redacted is True
        assert validated.root_causes[0].code == "registry_observation"
        assert "provider-secret" not in serialized
        assert "opaque-secret" not in serialized
        assert "[REDACTED]" in serialized


@pytest.mark.asyncio
async def test_insufficient_evidence_requires_a_successful_observation(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "insufficient-without-evidence")

        with pytest.raises(DiagnosisValidationError) as error:
            await validate_diagnosis(_insufficient(), run_id, repository)

        assert error.value.code == "structured_output_invalid"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "max_code_points"),
    [("summary", 1024), ("statement", 1024), ("missing_information", 512)],
)
async def test_validator_rejects_text_truncated_after_redaction(
    tmp_path: Path,
    field: str,
    max_code_points: int,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, f"truncated-{field}")
        evidence_id = await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-events",
            tool_name="get_events",
        )
        value = _text_that_expands_during_redaction(max_code_points)
        if field == "summary":
            candidate = _diagnosed(evidence_id, summary=value)
        elif field == "statement":
            candidate = _diagnosed(evidence_id, statement=value)
        else:
            candidate = _insufficient(missing=value)

        with pytest.raises(DiagnosisValidationError) as error:
            await validate_diagnosis(candidate, run_id, repository)

        assert error.value.code == "structured_output_invalid"


@pytest.mark.asyncio
@pytest.mark.parametrize("reference_kind", ["unknown", "cross_run"])
async def test_diagnosed_rejects_evidence_outside_the_current_run(
    tmp_path: Path,
    reference_kind: str,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        current_run = await _running_run(repository, f"current-{reference_kind}")
        await _record_evidence(
            repository,
            current_run,
            tool_call_id="call-current",
            tool_name="get_workload",
        )
        if reference_kind == "cross_run":
            other_run = await _running_run(repository, "foreign-evidence")
            referenced = await _record_evidence(
                repository,
                other_run,
                tool_call_id="call-foreign",
                tool_name="get_pods",
            )
        else:
            referenced = uuid4()

        with pytest.raises(DiagnosisValidationError) as error:
            await validate_diagnosis(_diagnosed(referenced), current_run, repository)

        assert error.value.code == "structured_output_invalid"


@pytest.mark.asyncio
async def test_diagnosed_requires_evidence_and_rejects_unknown_code(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        empty_run = await _running_run(repository, "empty-run")

        with pytest.raises(DiagnosisValidationError):
            await validate_diagnosis(_diagnosed(uuid4()), empty_run, repository)

        evidence_id = await _record_evidence(
            repository,
            empty_run,
            tool_call_id="call-workload",
            tool_name="get_workload",
        )
        with pytest.raises(DiagnosisValidationError):
            await validate_diagnosis(
                _diagnosed(evidence_id, code="unknown"), empty_run, repository
            )


@pytest.mark.asyncio
async def test_retryable_failure_is_resolved_only_by_later_same_tool_success(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)

        unresolved_run = await _running_run(repository, "unresolved-retry")
        await _record_failure(
            repository,
            unresolved_run,
            tool_call_id="call-timeout",
            tool_name="get_events",
            error_code="request_timeout",
            retryable=True,
        )
        alternate_evidence_id = await _record_evidence(
            repository,
            unresolved_run,
            tool_call_id="call-other-tool",
            tool_name="get_pods",
        )
        with pytest.raises(UnresolvedToolFailuresError) as unresolved:
            await validate_diagnosis(_insufficient(), unresolved_run, repository)
        assert [failure.tool_call_id for failure in unresolved.value.failures] == [
            "call-timeout"
        ]
        diagnosed = await validate_diagnosis(
            _diagnosed(alternate_evidence_id),
            unresolved_run,
            repository,
        )
        assert diagnosed.outcome == "diagnosed"

        resolved_run = await _running_run(repository, "resolved-retry")
        await _record_failure(
            repository,
            resolved_run,
            tool_call_id="call-timeout",
            tool_name="get_events",
            error_code="request_timeout",
            retryable=True,
            occurred_at=datetime(2099, 1, 1, tzinfo=UTC),
        )
        await _record_evidence(
            repository,
            resolved_run,
            tool_call_id="call-retry",
            tool_name="get_events",
        )

        validated = await validate_diagnosis(_insufficient(), resolved_run, repository)
        assert validated.outcome == "insufficient_evidence"


@pytest.mark.asyncio
async def test_fatal_failure_remains_unresolved_after_later_success(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "fatal-failure")
        await _record_failure(
            repository,
            run_id,
            tool_call_id="call-denied",
            tool_name="get_workload",
            error_code="permission_denied",
            retryable=False,
        )
        await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-later",
            tool_name="get_workload",
        )

        with pytest.raises(UnresolvedToolFailuresError) as error:
            await validate_diagnosis(_insufficient(), run_id, repository)

        assert error.value.failures[0].error_code == "permission_denied"
        assert error.value.failures[0].retryable is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error_code", "retryable"),
    [("not_a_kubernetes_code", True), ("permission_denied", True)],
)
async def test_resolved_invalid_tool_failure_contract_fails_consistency(
    tmp_path: Path,
    error_code: str,
    retryable: bool,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, f"invalid-{error_code}")
        await _record_failure(
            repository,
            run_id,
            tool_call_id="call-invalid",
            tool_name="get_events",
            error_code=error_code,
            retryable=retryable,
        )
        await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-later-success",
            tool_name="get_events",
        )

        with pytest.raises(RecoveryConsistencyError):
            await validate_diagnosis(_insufficient(), run_id, repository)


@pytest.mark.asyncio
async def test_sanitized_required_text_and_total_utf8_budget_fail_closed(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "output-budgets")
        evidence_id = await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-events",
            tool_name="get_events",
        )

        with pytest.raises(DiagnosisValidationError) as empty_error:
            await validate_diagnosis(
                _diagnosed(evidence_id, summary="\u202e"), run_id, repository
            )
        assert empty_error.value.code == "structured_output_invalid"

        large_payload = DiagnosisCandidate.model_validate(
            {
                "outcome": "diagnosed",
                "summary": "界" * 1024,
                "root_causes": [
                    {
                        "code": f"cause_{index}",
                        "statement": "界" * 1024,
                        "confidence": "medium",
                        "evidence_ids": [str(evidence_id)],
                    }
                    for index in range(5)
                ],
                "missing_information": ["界" * 512 for _ in range(10)],
            }
        )
        with pytest.raises(DiagnosisValidationError) as size_error:
            await validate_diagnosis(large_payload, run_id, repository)
        assert size_error.value.code == "structured_output_invalid"


@pytest.mark.asyncio
async def test_snapshot_rejects_corrupt_evidence_event(tmp_path: Path) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "corrupt-evidence")
        evidence_id = await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-corrupt",
            tool_name="get_pods",
        )
        async with database.session_factory() as session, session.begin():
            event_row = await session.scalar(
                select(RunEventRow).where(
                    RunEventRow.run_id == str(run_id),
                    RunEventRow.event_key == "tool:call-corrupt:evidence",
                )
            )
            assert event_row is not None
            event_row.payload_json = "{}"

        with pytest.raises(RecoveryConsistencyError):
            await validate_diagnosis(_diagnosed(evidence_id), run_id, repository)


@pytest.mark.asyncio
@pytest.mark.parametrize("started_state", ["missing", "wrong_name", "late"])
async def test_snapshot_requires_matching_earlier_tool_started(
    tmp_path: Path,
    started_state: str,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, f"started-{started_state}")
        if started_state == "wrong_name":
            await repository.record_tool_started(run_id, "call-started", "get_workload")
        persisted = await repository.record_evidence(
            _evidence_record(
                run_id,
                tool_call_id="call-started",
                tool_name="get_pods",
            )
        )
        if started_state == "late":
            await repository.record_tool_started(run_id, "call-started", "get_pods")

        with pytest.raises(RecoveryConsistencyError):
            await validate_diagnosis(_diagnosed(persisted.id), run_id, repository)


@pytest.mark.asyncio
async def test_snapshot_rejects_tool_started_without_an_outcome(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "orphan-started")
        evidence_id = await _record_evidence(
            repository,
            run_id,
            tool_call_id="call-complete",
            tool_name="get_workload",
        )
        await repository.record_tool_started(
            run_id,
            "call-without-outcome",
            "get_events",
        )

        with pytest.raises(RecoveryConsistencyError):
            await validate_diagnosis(_diagnosed(evidence_id), run_id, repository)


@pytest.mark.asyncio
async def test_snapshot_database_failure_has_static_error(tmp_path: Path) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        run_id = await _running_run(repository, "database-failure")

        def fail_read(
            _connection: object,
            _cursor: object,
            statement: str,
            _parameters: object,
            _context: object,
            _executemany: bool,
        ) -> None:
            raise OperationalError(
                statement,
                {"token": "must-not-leak"},
                RuntimeError("/private/database/path"),
            )

        event.listen(database.engine.sync_engine, "before_cursor_execute", fail_read)
        try:
            with pytest.raises(PersistenceOperationError) as error:
                await validate_diagnosis(_insufficient(), run_id, repository)
        finally:
            event.remove(
                database.engine.sync_engine, "before_cursor_execute", fail_read
            )

        assert str(error.value) == "Persistence operation failed"
        assert "must-not-leak" not in repr(error.value)
        assert "/private/database/path" not in repr(error.value)
