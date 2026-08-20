from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Final
from uuid import UUID, uuid4, uuid5

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from k8s_incident_agent.domain.models import (
    CreatedIncident,
    DiagnosisOutcome,
    EvidenceRecord,
    IncidentStatus,
    JsonValue,
    ModelSnapshot,
    PersistedEvidence,
    PersistedTerminal,
    RootCauseRecord,
    RunBudget,
    RunEvent,
    RunRecord,
    RunStatus,
    TerminalRecord,
    ToolFailureRecord,
)
from k8s_incident_agent.persistence.canonical import canonical_json, parse_json_object
from k8s_incident_agent.persistence.models import (
    DiagnosisRow,
    EvidenceRow,
    IncidentRow,
    RunEventRow,
    RunRow,
)
from k8s_incident_agent.scenarios.contracts import PublicScenario

PROJECT_NAMESPACE: Final = UUID("5c2f2e64-4c10-5ba3-99f0-8f9f37c660b8")
_SCHEMA_VERSION: Final = 1


class RepositoryError(RuntimeError):
    code: str


class RecoveryConsistencyError(RepositoryError):
    code = "recovery_consistency_error"

    def __init__(self) -> None:
        super().__init__("Persisted state conflicts with the replayed operation")


class PersistenceOperationError(RepositoryError):
    code = "internal_error"

    def __init__(self) -> None:
        super().__init__("Persistence operation failed")


async def _execute_with_replay[T](
    operation: Callable[[], Awaitable[T]],
    replay: Callable[[], Awaitable[T]],
) -> T:
    try:
        try:
            return await operation()
        except IntegrityError:
            return await replay()
    except RepositoryError:
        raise
    except SQLAlchemyError:
        raise PersistenceOperationError from None


def evidence_id(run_id: UUID, tool_call_id: str) -> UUID:
    return uuid5(PROJECT_NAMESPACE, f"{run_id}:{tool_call_id}")


def diagnosis_id(run_id: UUID) -> UUID:
    return uuid5(PROJECT_NAMESPACE, f"{run_id}:diagnosis")


def _require_incident_transition(
    current: IncidentStatus, target: IncidentStatus
) -> None:
    if not current.can_transition_to(target):
        raise RecoveryConsistencyError


def _require_run_transition(current: RunStatus, target: RunStatus) -> None:
    if not current.can_transition_to(target):
        raise RecoveryConsistencyError


class IncidentRepository:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        self._session_factory = session_factory

    async def create_incident_and_run(
        self,
        scenario: PublicScenario,
        model: ModelSnapshot,
        budget: RunBudget,
    ) -> CreatedIncident:
        incident_id = uuid4()
        run_id = uuid4()
        occurred_at = datetime.now(UTC)
        payload = _base_payload(incident_id, run_id, occurred_at)
        payload.update(
            {
                "scenarioId": scenario.scenario_id,
                "incidentStatus": IncidentStatus.RECEIVED.value,
                "runStatus": RunStatus.QUEUED.value,
            }
        )

        try:
            async with self._session_factory() as session, session.begin():
                incident_row = IncidentRow(
                    id=str(incident_id),
                    scenario_id=scenario.scenario_id,
                    scenario_version=scenario.scenario_version,
                    display_name=scenario.display_name,
                    trigger_summary=scenario.trigger.summary,
                    cluster=scenario.target.cluster,
                    namespace=scenario.target.namespace,
                    api_version=scenario.target.api_version,
                    kind=scenario.target.kind,
                    resource_name=scenario.target.name,
                    status=IncidentStatus.RECEIVED,
                    created_at=occurred_at,
                    updated_at=occurred_at,
                )
                session.add(incident_row)
                await session.flush()

                run_row = RunRow(
                    id=str(run_id),
                    incident_id=str(incident_id),
                    status=RunStatus.QUEUED,
                    model_provider=model.provider,
                    model_id=model.model_id,
                    thinking_mode=model.thinking_mode,
                    prompt_version=model.prompt_version,
                    max_model_calls=budget.max_model_calls,
                    max_tool_calls=budget.max_tool_calls,
                    timeout_seconds=budget.timeout_seconds,
                    model_calls=None,
                    tool_calls=None,
                    input_tokens=None,
                    output_tokens=None,
                    error_code=None,
                    error_retryable=None,
                    created_at=occurred_at,
                    started_at=None,
                    completed_at=None,
                    updated_at=occurred_at,
                )
                session.add(run_row)
                await session.flush()

                event_row = _new_event_row(
                    incident_id=incident_id,
                    run_id=run_id,
                    event_key="incident.created",
                    event_type="incident.created",
                    occurred_at=occurred_at,
                    payload=payload,
                )
                session.add(event_row)
                await session.flush()
                run_event = _event_from_row(event_row)
        except SQLAlchemyError:
            raise PersistenceOperationError from None

        return CreatedIncident(
            incident_id=incident_id,
            run_id=run_id,
            incident_status=IncidentStatus.RECEIVED,
            run_status=RunStatus.QUEUED,
            event=run_event,
        )

    async def start_run(self, run_id: UUID, started_at: datetime) -> RunRecord:
        started_at = _require_aware_datetime(started_at)
        return await _execute_with_replay(
            lambda: self._start_run_once(run_id, started_at),
            lambda: self._replay_start_run(run_id, started_at),
        )

    async def _start_run_once(self, run_id: UUID, started_at: datetime) -> RunRecord:
        async with self._session_factory() as session, session.begin():
            run, incident = await _load_run_context(session, run_id)
            existing = await _event_by_key(session, run_id, "run.started")
            if existing is not None:
                return _replayed_start(run, incident, existing, started_at)

            _require_incident_transition(incident.status, IncidentStatus.TRIAGING)
            _require_run_transition(run.status, RunStatus.RUNNING)
            incident.status = IncidentStatus.TRIAGING
            incident.updated_at = started_at
            run.status = RunStatus.RUNNING
            run.started_at = started_at
            run.updated_at = started_at
            payload = _base_payload(UUID(incident.id), run_id, started_at)
            payload.update(
                {
                    "incidentStatus": IncidentStatus.TRIAGING.value,
                    "runStatus": RunStatus.RUNNING.value,
                }
            )
            event_row = _new_event_row(
                incident_id=UUID(incident.id),
                run_id=run_id,
                event_key="run.started",
                event_type="run.started",
                occurred_at=started_at,
                payload=payload,
            )
            session.add(event_row)
            await session.flush()
            return _started_run(run, incident, event_row)

    async def _replay_start_run(self, run_id: UUID, started_at: datetime) -> RunRecord:
        async with self._session_factory() as session:
            run, incident = await _load_run_context(session, run_id)
            existing = await _event_by_key(session, run_id, "run.started")
            if existing is None:
                raise RecoveryConsistencyError
            return _replayed_start(run, incident, existing, started_at)

    async def record_tool_started(
        self,
        run_id: UUID,
        tool_call_id: str,
        tool_name: str,
    ) -> RunEvent:
        return await _execute_with_replay(
            lambda: self._record_tool_started_once(run_id, tool_call_id, tool_name),
            lambda: self._replay_tool_started(run_id, tool_call_id, tool_name),
        )

    async def _record_tool_started_once(
        self,
        run_id: UUID,
        tool_call_id: str,
        tool_name: str,
    ) -> RunEvent:
        event_key = f"tool:{tool_call_id}:started"
        async with self._session_factory() as session, session.begin():
            run, incident = await _load_run_context(session, run_id)
            incident_id = UUID(incident.id)
            existing = await _event_by_key(session, run_id, event_key)
            if existing is not None:
                return _replayed_tool_started(
                    existing,
                    incident_id,
                    run_id,
                    tool_call_id,
                    tool_name,
                )
            _require_active_run(run, incident)
            occurred_at = datetime.now(UTC)
            payload = _base_payload(incident_id, run_id, occurred_at)
            payload.update({"toolCallId": tool_call_id, "toolName": tool_name})
            event_row = _new_event_row(
                incident_id=incident_id,
                run_id=run_id,
                event_key=event_key,
                event_type="tool.started",
                occurred_at=occurred_at,
                payload=payload,
            )
            session.add(event_row)
            await session.flush()
            return _event_from_row(event_row)

    async def _replay_tool_started(
        self,
        run_id: UUID,
        tool_call_id: str,
        tool_name: str,
    ) -> RunEvent:
        async with self._session_factory() as session:
            _, incident = await _load_run_context(session, run_id)
            event_row = await _event_by_key(
                session, run_id, f"tool:{tool_call_id}:started"
            )
            if event_row is None:
                raise RecoveryConsistencyError
            return _replayed_tool_started(
                event_row,
                UUID(incident.id),
                run_id,
                tool_call_id,
                tool_name,
            )

    async def record_evidence(self, evidence: EvidenceRecord) -> PersistedEvidence:
        observed_at = _require_aware_datetime(evidence.observed_at)
        normalized = EvidenceRecord(
            run_id=evidence.run_id,
            tool_call_id=evidence.tool_call_id,
            tool_name=evidence.tool_name,
            evidence_kind=evidence.evidence_kind,
            target_ref=evidence.target_ref,
            observed_at=observed_at,
            payload=evidence.payload,
            truncated=evidence.truncated,
            redacted=evidence.redacted,
        )
        return await _execute_with_replay(
            lambda: self._record_evidence_once(normalized),
            lambda: self._replay_evidence(normalized),
        )

    async def _record_evidence_once(
        self, evidence: EvidenceRecord
    ) -> PersistedEvidence:
        async with self._session_factory() as session, session.begin():
            run, incident = await _load_run_context(session, evidence.run_id)
            incident_id = UUID(incident.id)
            persisted = await _evidence_by_tool_call(
                session, evidence.run_id, evidence.tool_call_id
            )
            failure = await _event_by_key(
                session,
                evidence.run_id,
                f"tool:{evidence.tool_call_id}:failed",
            )
            if persisted is not None or failure is not None:
                return await _resolve_evidence_replay(
                    session,
                    evidence,
                    persisted,
                    failure,
                    incident_id,
                )
            _require_active_run(run, incident)

            persisted_id = evidence_id(evidence.run_id, evidence.tool_call_id)
            evidence_row = EvidenceRow(
                id=str(persisted_id),
                run_id=str(evidence.run_id),
                tool_call_id=evidence.tool_call_id,
                tool_name=evidence.tool_name,
                evidence_kind=evidence.evidence_kind,
                target_ref_json=canonical_json(evidence.target_ref),
                observed_at=evidence.observed_at,
                payload_json=canonical_json(evidence.payload),
                truncated=evidence.truncated,
                redacted=evidence.redacted,
            )
            occurred_at = datetime.now(UTC)
            payload = _base_payload(incident_id, evidence.run_id, occurred_at)
            payload.update(
                {
                    "evidenceId": str(persisted_id),
                    "toolCallId": evidence.tool_call_id,
                    "toolName": evidence.tool_name,
                    "evidenceKind": evidence.evidence_kind,
                    "observedAt": _rfc3339(evidence.observed_at),
                    "truncated": evidence.truncated,
                    "redacted": evidence.redacted,
                }
            )
            event_row = _new_event_row(
                incident_id=incident_id,
                run_id=evidence.run_id,
                event_key=f"tool:{evidence.tool_call_id}:evidence",
                event_type="evidence.recorded",
                occurred_at=occurred_at,
                payload=payload,
            )
            session.add_all((evidence_row, event_row))
            await session.flush()
            return _persisted_evidence(evidence_row, event_row)

    async def _replay_evidence(self, evidence: EvidenceRecord) -> PersistedEvidence:
        async with self._session_factory() as session:
            _, incident = await _load_run_context(session, evidence.run_id)
            persisted = await _evidence_by_tool_call(
                session, evidence.run_id, evidence.tool_call_id
            )
            failure = await _event_by_key(
                session,
                evidence.run_id,
                f"tool:{evidence.tool_call_id}:failed",
            )
            return await _resolve_evidence_replay(
                session,
                evidence,
                persisted,
                failure,
                UUID(incident.id),
            )

    async def record_tool_failure(self, failure: ToolFailureRecord) -> RunEvent:
        occurred_at = _require_aware_datetime(failure.occurred_at)
        normalized = ToolFailureRecord(
            run_id=failure.run_id,
            tool_call_id=failure.tool_call_id,
            tool_name=failure.tool_name,
            error_code=failure.error_code,
            retryable=failure.retryable,
            occurred_at=occurred_at,
        )
        return await _execute_with_replay(
            lambda: self._record_tool_failure_once(normalized),
            lambda: self._replay_tool_failure(normalized),
        )

    async def _record_tool_failure_once(self, failure: ToolFailureRecord) -> RunEvent:
        event_key = f"tool:{failure.tool_call_id}:failed"
        async with self._session_factory() as session, session.begin():
            run, incident = await _load_run_context(session, failure.run_id)
            incident_id = UUID(incident.id)
            evidence = await _evidence_by_tool_call(
                session, failure.run_id, failure.tool_call_id
            )
            existing = await _event_by_key(session, failure.run_id, event_key)
            if evidence is not None or existing is not None:
                return _resolve_failure_replay(
                    failure,
                    evidence,
                    existing,
                    incident_id,
                )
            _require_active_run(run, incident)
            payload = _base_payload(incident_id, failure.run_id, failure.occurred_at)
            payload.update(
                {
                    "toolCallId": failure.tool_call_id,
                    "toolName": failure.tool_name,
                    "errorCode": failure.error_code,
                    "retryable": failure.retryable,
                }
            )
            event_row = _new_event_row(
                incident_id=incident_id,
                run_id=failure.run_id,
                event_key=event_key,
                event_type="tool.failed",
                occurred_at=failure.occurred_at,
                payload=payload,
            )
            session.add(event_row)
            await session.flush()
            return _event_from_row(event_row)

    async def _replay_tool_failure(self, failure: ToolFailureRecord) -> RunEvent:
        async with self._session_factory() as session:
            _, incident = await _load_run_context(session, failure.run_id)
            evidence = await _evidence_by_tool_call(
                session, failure.run_id, failure.tool_call_id
            )
            existing = await _event_by_key(
                session,
                failure.run_id,
                f"tool:{failure.tool_call_id}:failed",
            )
            return _resolve_failure_replay(
                failure,
                evidence,
                existing,
                UUID(incident.id),
            )

    async def persist_terminal(self, terminal: TerminalRecord) -> PersistedTerminal:
        completed_at = _require_aware_datetime(terminal.completed_at)
        normalized = TerminalRecord(
            run_id=terminal.run_id,
            completed_at=completed_at,
            outcome=terminal.outcome,
            summary=terminal.summary,
            root_causes=terminal.root_causes,
            missing_information=terminal.missing_information,
            redacted=terminal.redacted,
            error_code=terminal.error_code,
            error_retryable=terminal.error_retryable,
            model_calls=terminal.model_calls,
            tool_calls=terminal.tool_calls,
            input_tokens=terminal.input_tokens,
            output_tokens=terminal.output_tokens,
        )
        return await _execute_with_replay(
            lambda: self._persist_terminal_once(normalized),
            lambda: self._replay_terminal(normalized),
        )

    async def _persist_terminal_once(
        self, terminal: TerminalRecord
    ) -> PersistedTerminal:
        async with self._session_factory() as session, session.begin():
            run, incident = await _load_run_context(session, terminal.run_id)
            incident_id = UUID(incident.id)
            terminal_event = await _event_by_key(
                session, terminal.run_id, "run:terminal"
            )
            diagnosis = await _diagnosis_by_run(session, terminal.run_id)
            if terminal_event is not None or diagnosis is not None:
                return _resolve_terminal_replay(
                    terminal, run, incident, diagnosis, terminal_event
                )

            incident_target, run_target = _terminal_statuses(terminal)
            _require_incident_transition(incident.status, incident_target)
            _require_run_transition(run.status, run_target)
            if terminal.outcome is not None:
                await _require_current_run_evidence(session, terminal)

            incident.status = incident_target
            incident.updated_at = terminal.completed_at
            run.status = run_target
            run.model_calls = terminal.model_calls
            run.tool_calls = terminal.tool_calls
            run.input_tokens = terminal.input_tokens
            run.output_tokens = terminal.output_tokens
            run.error_code = terminal.error_code
            run.error_retryable = terminal.error_retryable
            run.completed_at = terminal.completed_at
            run.updated_at = terminal.completed_at

            persisted_diagnosis_id: UUID | None = None
            if terminal.outcome is not None:
                persisted_diagnosis_id = diagnosis_id(terminal.run_id)
                session.add(
                    DiagnosisRow(
                        id=str(persisted_diagnosis_id),
                        run_id=str(terminal.run_id),
                        outcome=terminal.outcome,
                        summary=_diagnosis_summary(terminal),
                        root_causes_json=_root_causes_json(terminal.root_causes),
                        missing_information_json=_string_list_json(
                            terminal.missing_information
                        ),
                        redacted=terminal.redacted,
                        created_at=terminal.completed_at,
                    )
                )

            payload = _terminal_payload(
                terminal,
                incident_id,
                incident_target,
                run_target,
                persisted_diagnosis_id,
            )
            event_row = _new_event_row(
                incident_id=incident_id,
                run_id=terminal.run_id,
                event_key="run:terminal",
                event_type=_terminal_event_type(terminal),
                occurred_at=terminal.completed_at,
                payload=payload,
            )
            session.add(event_row)
            await session.flush()
            return PersistedTerminal(
                run_id=terminal.run_id,
                incident_status=incident_target,
                run_status=run_target,
                diagnosis_id=persisted_diagnosis_id,
                event=_event_from_row(event_row),
            )

    async def _replay_terminal(self, terminal: TerminalRecord) -> PersistedTerminal:
        async with self._session_factory() as session:
            run, incident = await _load_run_context(session, terminal.run_id)
            terminal_event = await _event_by_key(
                session, terminal.run_id, "run:terminal"
            )
            diagnosis = await _diagnosis_by_run(session, terminal.run_id)
            return _resolve_terminal_replay(
                terminal, run, incident, diagnosis, terminal_event
            )


async def _load_run_context(
    session: AsyncSession, run_id: UUID
) -> tuple[RunRow, IncidentRow]:
    run = await session.get(RunRow, str(run_id))
    if run is None:
        raise RecoveryConsistencyError
    incident = await session.get(IncidentRow, run.incident_id)
    if incident is None:
        raise RecoveryConsistencyError
    return run, incident


async def _event_by_key(
    session: AsyncSession, run_id: UUID, event_key: str
) -> RunEventRow | None:
    return await session.scalar(
        select(RunEventRow).where(
            RunEventRow.run_id == str(run_id),
            RunEventRow.event_key == event_key,
        )
    )


async def _evidence_by_tool_call(
    session: AsyncSession, run_id: UUID, tool_call_id: str
) -> EvidenceRow | None:
    return await session.scalar(
        select(EvidenceRow).where(
            EvidenceRow.run_id == str(run_id),
            EvidenceRow.tool_call_id == tool_call_id,
        )
    )


async def _diagnosis_by_run(session: AsyncSession, run_id: UUID) -> DiagnosisRow | None:
    return await session.scalar(
        select(DiagnosisRow).where(DiagnosisRow.run_id == str(run_id))
    )


def _new_event_row(
    *,
    incident_id: UUID,
    run_id: UUID,
    event_key: str,
    event_type: str,
    occurred_at: datetime,
    payload: dict[str, JsonValue],
) -> RunEventRow:
    return RunEventRow(
        incident_id=str(incident_id),
        run_id=str(run_id),
        event_key=event_key,
        event_type=event_type,
        schema_version=_SCHEMA_VERSION,
        occurred_at=occurred_at,
        payload_json=canonical_json(payload),
    )


def _event_from_row(row: RunEventRow) -> RunEvent:
    try:
        return RunEvent(
            id=row.id,
            incident_id=UUID(row.incident_id),
            run_id=UUID(row.run_id),
            event_key=row.event_key,
            event_type=row.event_type,
            occurred_at=_database_datetime(row.occurred_at),
            payload=parse_json_object(row.payload_json),
        )
    except (TypeError, ValueError):
        raise RecoveryConsistencyError from None


def _base_payload(
    incident_id: UUID, run_id: UUID, occurred_at: datetime
) -> dict[str, JsonValue]:
    return {
        "schemaVersion": _SCHEMA_VERSION,
        "incidentId": str(incident_id),
        "runId": str(run_id),
        "occurredAt": _rfc3339(occurred_at),
    }


def _event_matches(
    row: RunEventRow,
    *,
    incident_id: UUID,
    run_id: UUID,
    event_key: str,
    event_type: str,
    occurred_at: datetime,
    payload: dict[str, JsonValue],
) -> bool:
    return (
        row.incident_id == str(incident_id)
        and row.run_id == str(run_id)
        and row.event_key == event_key
        and row.event_type == event_type
        and row.schema_version == _SCHEMA_VERSION
        and _database_datetime(row.occurred_at) == occurred_at
        and row.payload_json == canonical_json(payload)
    )


def _started_run(
    run: RunRow, incident: IncidentRow, event_row: RunEventRow
) -> RunRecord:
    if run.started_at is None:
        raise RecoveryConsistencyError
    return RunRecord(
        id=UUID(run.id),
        incident_id=UUID(incident.id),
        status=run.status,
        incident_status=incident.status,
        started_at=_database_datetime(run.started_at),
        event=_event_from_row(event_row),
    )


def _replayed_start(
    run: RunRow,
    incident: IncidentRow,
    event_row: RunEventRow,
    started_at: datetime,
) -> RunRecord:
    incident_id = UUID(incident.id)
    run_id = UUID(run.id)
    payload = _base_payload(incident_id, run_id, started_at)
    payload.update(
        {
            "incidentStatus": IncidentStatus.TRIAGING.value,
            "runStatus": RunStatus.RUNNING.value,
        }
    )
    if (
        run.status is not RunStatus.RUNNING
        or incident.status is not IncidentStatus.TRIAGING
        or run.started_at is None
        or _database_datetime(run.started_at) != started_at
        or _database_datetime(run.updated_at) != started_at
        or _database_datetime(incident.updated_at) != started_at
        or not _event_matches(
            event_row,
            incident_id=incident_id,
            run_id=run_id,
            event_key="run.started",
            event_type="run.started",
            occurred_at=started_at,
            payload=payload,
        )
    ):
        raise RecoveryConsistencyError
    return _started_run(run, incident, event_row)


def _replayed_tool_started(
    event_row: RunEventRow,
    incident_id: UUID,
    run_id: UUID,
    tool_call_id: str,
    tool_name: str,
) -> RunEvent:
    occurred_at = _database_datetime(event_row.occurred_at)
    payload = _base_payload(incident_id, run_id, occurred_at)
    payload.update({"toolCallId": tool_call_id, "toolName": tool_name})
    if not _event_matches(
        event_row,
        incident_id=incident_id,
        run_id=run_id,
        event_key=f"tool:{tool_call_id}:started",
        event_type="tool.started",
        occurred_at=occurred_at,
        payload=payload,
    ):
        raise RecoveryConsistencyError
    return _event_from_row(event_row)


async def _resolve_evidence_replay(
    session: AsyncSession,
    evidence: EvidenceRecord,
    persisted: EvidenceRow | None,
    failure: RunEventRow | None,
    incident_id: UUID,
) -> PersistedEvidence:
    if persisted is None or failure is not None:
        raise RecoveryConsistencyError
    event_row = await _event_by_key(
        session, evidence.run_id, f"tool:{evidence.tool_call_id}:evidence"
    )
    if event_row is None or not _evidence_matches(persisted, evidence):
        raise RecoveryConsistencyError
    occurred_at = _database_datetime(event_row.occurred_at)
    expected_payload = _evidence_event_payload(
        persisted,
        incident_id,
        evidence.run_id,
        occurred_at,
    )
    if not _event_matches(
        event_row,
        incident_id=incident_id,
        run_id=evidence.run_id,
        event_key=f"tool:{evidence.tool_call_id}:evidence",
        event_type="evidence.recorded",
        occurred_at=occurred_at,
        payload=expected_payload,
    ):
        raise RecoveryConsistencyError
    return _persisted_evidence(persisted, event_row)


def _evidence_matches(row: EvidenceRow, evidence: EvidenceRecord) -> bool:
    return (
        row.id == str(evidence_id(evidence.run_id, evidence.tool_call_id))
        and row.run_id == str(evidence.run_id)
        and row.tool_call_id == evidence.tool_call_id
        and row.tool_name == evidence.tool_name
        and row.evidence_kind == evidence.evidence_kind
        and row.target_ref_json == canonical_json(evidence.target_ref)
        and _database_datetime(row.observed_at) == evidence.observed_at
        and row.payload_json == canonical_json(evidence.payload)
        and row.truncated is evidence.truncated
        and row.redacted is evidence.redacted
    )


def _evidence_event_payload(
    evidence_row: EvidenceRow,
    incident_id: UUID,
    run_id: UUID,
    occurred_at: datetime,
) -> dict[str, JsonValue]:
    payload = _base_payload(incident_id, run_id, occurred_at)
    payload.update(
        {
            "evidenceId": evidence_row.id,
            "toolCallId": evidence_row.tool_call_id,
            "toolName": evidence_row.tool_name,
            "evidenceKind": evidence_row.evidence_kind,
            "observedAt": _rfc3339(_database_datetime(evidence_row.observed_at)),
            "truncated": evidence_row.truncated,
            "redacted": evidence_row.redacted,
        }
    )
    return payload


def _persisted_evidence(
    evidence_row: EvidenceRow, event_row: RunEventRow
) -> PersistedEvidence:
    try:
        return PersistedEvidence(
            id=UUID(evidence_row.id),
            run_id=UUID(evidence_row.run_id),
            tool_call_id=evidence_row.tool_call_id,
            tool_name=evidence_row.tool_name,
            evidence_kind=evidence_row.evidence_kind,
            target_ref=parse_json_object(evidence_row.target_ref_json),
            observed_at=_database_datetime(evidence_row.observed_at),
            payload=parse_json_object(evidence_row.payload_json),
            truncated=evidence_row.truncated,
            redacted=evidence_row.redacted,
            event=_event_from_row(event_row),
        )
    except (TypeError, ValueError):
        raise RecoveryConsistencyError from None


def _resolve_failure_replay(
    failure: ToolFailureRecord,
    evidence: EvidenceRow | None,
    existing: RunEventRow | None,
    incident_id: UUID,
) -> RunEvent:
    if evidence is not None or existing is None:
        raise RecoveryConsistencyError
    payload = _base_payload(incident_id, failure.run_id, failure.occurred_at)
    payload.update(
        {
            "toolCallId": failure.tool_call_id,
            "toolName": failure.tool_name,
            "errorCode": failure.error_code,
            "retryable": failure.retryable,
        }
    )
    if not _event_matches(
        existing,
        incident_id=incident_id,
        run_id=failure.run_id,
        event_key=f"tool:{failure.tool_call_id}:failed",
        event_type="tool.failed",
        occurred_at=failure.occurred_at,
        payload=payload,
    ):
        raise RecoveryConsistencyError
    return _event_from_row(existing)


def _require_active_run(run: RunRow, incident: IncidentRow) -> None:
    if (
        run.status is not RunStatus.RUNNING
        or incident.status is not IncidentStatus.TRIAGING
    ):
        raise RecoveryConsistencyError


async def _require_current_run_evidence(
    session: AsyncSession, terminal: TerminalRecord
) -> None:
    referenced_ids = {
        str(evidence_id)
        for root_cause in terminal.root_causes
        for evidence_id in root_cause.evidence_ids
    }
    if not referenced_ids:
        return
    rows = await session.scalars(
        select(EvidenceRow.id).where(
            EvidenceRow.run_id == str(terminal.run_id),
            EvidenceRow.id.in_(referenced_ids),
        )
    )
    if set(rows) != referenced_ids:
        raise RecoveryConsistencyError


def _terminal_statuses(
    terminal: TerminalRecord,
) -> tuple[IncidentStatus, RunStatus]:
    if terminal.outcome is not None:
        return terminal.outcome.incident_status, RunStatus.COMPLETED
    return IncidentStatus.FAILED, RunStatus.FAILED


def _terminal_event_type(terminal: TerminalRecord) -> str:
    if terminal.outcome is DiagnosisOutcome.DIAGNOSED:
        return "diagnosis.completed"
    if terminal.outcome is DiagnosisOutcome.INSUFFICIENT_EVIDENCE:
        return "diagnosis.insufficient"
    return "run.failed"


def _terminal_payload(
    terminal: TerminalRecord,
    incident_id: UUID,
    incident_status: IncidentStatus,
    run_status: RunStatus,
    persisted_diagnosis_id: UUID | None,
) -> dict[str, JsonValue]:
    payload = _base_payload(incident_id, terminal.run_id, terminal.completed_at)
    payload.update(
        {
            "incidentStatus": incident_status.value,
            "runStatus": run_status.value,
        }
    )
    if terminal.outcome is not None:
        if persisted_diagnosis_id is None:
            raise RecoveryConsistencyError
        payload.update(
            {
                "diagnosisId": str(persisted_diagnosis_id),
                "outcome": terminal.outcome.value,
            }
        )
    else:
        if terminal.error_code is None or terminal.error_retryable is None:
            raise RecoveryConsistencyError
        payload.update(
            {
                "errorCode": terminal.error_code,
                "retryable": terminal.error_retryable,
            }
        )
    return payload


def _resolve_terminal_replay(
    terminal: TerminalRecord,
    run: RunRow,
    incident: IncidentRow,
    diagnosis: DiagnosisRow | None,
    terminal_event: RunEventRow | None,
) -> PersistedTerminal:
    if terminal_event is None:
        raise RecoveryConsistencyError
    incident_target, run_target = _terminal_statuses(terminal)
    expected_diagnosis_id: UUID | None = None
    if terminal.outcome is not None:
        expected_diagnosis_id = diagnosis_id(terminal.run_id)
        if diagnosis is None or not _diagnosis_matches(diagnosis, terminal):
            raise RecoveryConsistencyError
    elif diagnosis is not None:
        raise RecoveryConsistencyError

    incident_id = UUID(incident.id)
    payload = _terminal_payload(
        terminal,
        incident_id,
        incident_target,
        run_target,
        expected_diagnosis_id,
    )
    if (
        incident.status is not incident_target
        or run.status is not run_target
        or run.completed_at is None
        or _database_datetime(run.completed_at) != terminal.completed_at
        or _database_datetime(run.updated_at) != terminal.completed_at
        or _database_datetime(incident.updated_at) != terminal.completed_at
        or run.model_calls != terminal.model_calls
        or run.tool_calls != terminal.tool_calls
        or run.input_tokens != terminal.input_tokens
        or run.output_tokens != terminal.output_tokens
        or run.error_code != terminal.error_code
        or run.error_retryable != terminal.error_retryable
        or not _event_matches(
            terminal_event,
            incident_id=incident_id,
            run_id=terminal.run_id,
            event_key="run:terminal",
            event_type=_terminal_event_type(terminal),
            occurred_at=terminal.completed_at,
            payload=payload,
        )
    ):
        raise RecoveryConsistencyError
    return PersistedTerminal(
        run_id=terminal.run_id,
        incident_status=incident_target,
        run_status=run_target,
        diagnosis_id=expected_diagnosis_id,
        event=_event_from_row(terminal_event),
    )


def _diagnosis_matches(row: DiagnosisRow, terminal: TerminalRecord) -> bool:
    return (
        terminal.outcome is not None
        and row.id == str(diagnosis_id(terminal.run_id))
        and row.run_id == str(terminal.run_id)
        and row.outcome is terminal.outcome
        and row.summary == _diagnosis_summary(terminal)
        and row.root_causes_json == _root_causes_json(terminal.root_causes)
        and row.missing_information_json
        == _string_list_json(terminal.missing_information)
        and row.redacted is terminal.redacted
        and _database_datetime(row.created_at) == terminal.completed_at
    )


def _diagnosis_summary(terminal: TerminalRecord) -> str:
    if terminal.summary is None:
        raise RecoveryConsistencyError
    return terminal.summary


def _root_causes_json(root_causes: tuple[RootCauseRecord, ...]) -> str:
    values: list[JsonValue] = []
    for root_cause in root_causes:
        values.append(
            {
                "code": root_cause.code,
                "statement": root_cause.statement,
                "confidence": root_cause.confidence,
                "evidence_ids": [str(value) for value in root_cause.evidence_ids],
            }
        )
    return canonical_json(values)


def _string_list_json(values: tuple[str, ...]) -> str:
    json_values: list[JsonValue] = list(values)
    return canonical_json(json_values)


def _require_aware_datetime(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Datetime must include a UTC offset")
    return value.astimezone(UTC)


def _database_datetime(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _rfc3339(value: datetime) -> str:
    return _database_datetime(value).isoformat().replace("+00:00", "Z")
