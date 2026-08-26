from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Final, cast
from uuid import UUID, uuid4, uuid5

from pydantic import ValidationError
from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import aliased
from sqlalchemy.sql.dml import Delete

from k8s_incident_agent.diagnosis.contracts import ValidatedDiagnosis
from k8s_incident_agent.domain.models import (
    AgentRunSnapshot,
    CreatedIncident,
    DiagnosisOutcome,
    DiagnosisValidationSnapshot,
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
    WorkflowRunSnapshot,
)
from k8s_incident_agent.persistence.canonical import canonical_json, parse_json_object
from k8s_incident_agent.persistence.models import (
    DiagnosisRow,
    EvidenceRow,
    IncidentRow,
    RunEventRow,
    RunRow,
)
from k8s_incident_agent.scenarios.contracts import PublicScenario, ScenarioTarget

PROJECT_NAMESPACE: Final = UUID("5c2f2e64-4c10-5ba3-99f0-8f9f37c660b8")
_SCHEMA_VERSION: Final = 1


@dataclass(frozen=True, slots=True)
class PruneTarget:
    incident_id: UUID
    run_id: UUID
    artifact_directory: Path
    event_rows: int
    evidence_rows: int
    diagnosis_rows: int


@dataclass(frozen=True, slots=True)
class IncidentListRecord:
    id: UUID
    scenario_id: str
    scenario_version: int
    display_name: str
    target: ScenarioTarget
    status: IncidentStatus
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class IncidentListPage:
    items: tuple[IncidentListRecord, ...]
    has_more: bool


@dataclass(frozen=True, slots=True)
class IncidentRunDetail:
    id: UUID
    status: RunStatus
    model: ModelSnapshot
    budget: RunBudget
    model_calls: int | None
    tool_calls: int | None
    input_tokens: int | None
    output_tokens: int | None
    error_code: str | None
    error_retryable: bool | None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None


@dataclass(frozen=True, slots=True)
class IncidentEvidenceDetail:
    id: UUID
    tool_call_id: str
    tool_name: str
    evidence_kind: str
    target_ref: dict[str, JsonValue]
    observed_at: datetime
    payload: dict[str, JsonValue]
    truncated: bool
    redacted: bool


@dataclass(frozen=True, slots=True)
class IncidentDiagnosisDetail:
    id: UUID
    outcome: DiagnosisOutcome
    summary: str
    root_causes: tuple[RootCauseRecord, ...]
    missing_information: tuple[str, ...]
    redacted: bool
    created_at: datetime


@dataclass(frozen=True, slots=True)
class IncidentDetailRecord:
    incident: IncidentListRecord
    trigger_summary: str
    run: IncidentRunDetail
    evidence: tuple[IncidentEvidenceDetail, ...]
    diagnosis: IncidentDiagnosisDetail | None


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

    async def list_incident_records(
        self,
        *,
        limit: int,
        cursor: tuple[datetime, UUID] | None,
    ) -> IncidentListPage:
        if limit < 1 or limit > 100:
            raise ValueError("Incident list limit must be between 1 and 100")
        try:
            async with self._session_factory() as session:
                statement = select(IncidentRow)
                if cursor is not None:
                    cursor_created_at = _require_aware_datetime(cursor[0])
                    cursor_id = str(cursor[1])
                    statement = statement.where(
                        or_(
                            IncidentRow.created_at < cursor_created_at,
                            and_(
                                IncidentRow.created_at == cursor_created_at,
                                IncidentRow.id < cursor_id,
                            ),
                        )
                    )
                rows = list(
                    await session.scalars(
                        statement.order_by(
                            IncidentRow.created_at.desc(),
                            IncidentRow.id.desc(),
                        ).limit(limit + 1)
                    )
                )
                return IncidentListPage(
                    items=tuple(_incident_list_record(row) for row in rows[:limit]),
                    has_more=len(rows) > limit,
                )
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def get_incident_detail(
        self,
        incident_id: UUID,
    ) -> IncidentDetailRecord | None:
        try:
            async with self._session_factory() as session:
                start_event_row = aliased(RunEventRow)
                terminal_event_row = aliased(RunEventRow)
                row = (
                    await session.execute(
                        select(
                            IncidentRow,
                            RunRow,
                            DiagnosisRow,
                            start_event_row,
                            terminal_event_row,
                        )
                        .outerjoin(RunRow, RunRow.incident_id == IncidentRow.id)
                        .outerjoin(DiagnosisRow, DiagnosisRow.run_id == RunRow.id)
                        .outerjoin(
                            start_event_row,
                            and_(
                                start_event_row.run_id == RunRow.id,
                                start_event_row.event_key == "run.started",
                            ),
                        )
                        .outerjoin(
                            terminal_event_row,
                            and_(
                                terminal_event_row.run_id == RunRow.id,
                                terminal_event_row.event_key == "run:terminal",
                            ),
                        )
                        .where(IncidentRow.id == str(incident_id))
                    )
                ).one_or_none()
                if row is None:
                    return None
                incident, run, diagnosis, start_event, terminal_event = row
                if run is None:
                    raise RecoveryConsistencyError
                workflow, terminal = _workflow_run_projection(
                    run,
                    incident,
                    diagnosis,
                    start_event,
                    terminal_event,
                )
                evidence_rows = list(
                    await session.scalars(
                        select(EvidenceRow)
                        .where(EvidenceRow.run_id == run.id)
                        .order_by(EvidenceRow.observed_at, EvidenceRow.id)
                    )
                )
                return _incident_detail_record(
                    incident,
                    run,
                    diagnosis,
                    evidence_rows,
                    workflow,
                    terminal,
                )
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def get_workflow_run_snapshot(
        self,
        run_id: UUID,
    ) -> WorkflowRunSnapshot:
        try:
            async with self._session_factory() as session:
                start_event_row = aliased(RunEventRow)
                terminal_event_row = aliased(RunEventRow)
                row = (
                    await session.execute(
                        select(
                            RunRow,
                            IncidentRow,
                            DiagnosisRow,
                            start_event_row,
                            terminal_event_row,
                        )
                        .join(IncidentRow, IncidentRow.id == RunRow.incident_id)
                        .outerjoin(
                            DiagnosisRow,
                            DiagnosisRow.run_id == RunRow.id,
                        )
                        .outerjoin(
                            start_event_row,
                            and_(
                                start_event_row.run_id == RunRow.id,
                                start_event_row.event_key == "run.started",
                            ),
                        )
                        .outerjoin(
                            terminal_event_row,
                            and_(
                                terminal_event_row.run_id == RunRow.id,
                                terminal_event_row.event_key == "run:terminal",
                            ),
                        )
                        .where(RunRow.id == str(run_id))
                    )
                ).one_or_none()
                if row is None:
                    raise RecoveryConsistencyError
                run, incident, diagnosis, start_event, terminal_event = row
                return _workflow_run_snapshot(
                    run,
                    incident,
                    diagnosis,
                    start_event,
                    terminal_event,
                )
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def list_recoverable_run_ids(self) -> tuple[UUID, ...]:
        try:
            async with self._session_factory() as session:
                values = await session.scalars(
                    select(RunRow.id)
                    .where(RunRow.status.in_((RunStatus.QUEUED, RunStatus.RUNNING)))
                    .order_by(RunRow.created_at, RunRow.id)
                )
                try:
                    return tuple(UUID(value) for value in values)
                except ValueError:
                    raise RecoveryConsistencyError from None
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def list_prune_targets(
        self,
        cutoff: datetime,
        artifact_root: Path,
    ) -> tuple[PruneTarget, ...]:
        cutoff = _require_aware_datetime(cutoff)
        try:
            async with self._session_factory() as session:
                rows = (
                    await session.execute(
                        select(RunRow, IncidentRow)
                        .join(IncidentRow, IncidentRow.id == RunRow.incident_id)
                        .where(
                            RunRow.status.in_((RunStatus.COMPLETED, RunStatus.FAILED)),
                            RunRow.completed_at.is_not(None),
                            RunRow.completed_at < cutoff,
                        )
                        .order_by(RunRow.completed_at, RunRow.id)
                    )
                ).all()
                return tuple(
                    [
                        await _prune_target_from_rows(
                            session,
                            run,
                            incident,
                            artifact_root,
                        )
                        for run, incident in rows
                    ]
                )
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def delete_prune_target(
        self,
        target: PruneTarget,
        cutoff: datetime,
        artifact_root: Path,
    ) -> bool:
        cutoff = _require_aware_datetime(cutoff)
        try:
            async with self._session_factory() as session, session.begin():
                run = await session.get(RunRow, str(target.run_id))
                if run is None:
                    return False
                incident = await session.get(IncidentRow, run.incident_id)
                if (
                    incident is None
                    or run.completed_at is None
                    or run.status not in (RunStatus.COMPLETED, RunStatus.FAILED)
                    or _database_datetime(run.completed_at) >= cutoff
                ):
                    raise RecoveryConsistencyError
                current = await _prune_target_from_rows(
                    session,
                    run,
                    incident,
                    artifact_root,
                )
                if current != target:
                    raise RecoveryConsistencyError

                await _delete_exact_rows(
                    session,
                    delete(RunEventRow).where(RunEventRow.run_id == str(target.run_id)),
                    target.event_rows,
                )
                await _delete_exact_rows(
                    session,
                    delete(EvidenceRow).where(EvidenceRow.run_id == str(target.run_id)),
                    target.evidence_rows,
                )
                await _delete_exact_rows(
                    session,
                    delete(DiagnosisRow).where(
                        DiagnosisRow.run_id == str(target.run_id)
                    ),
                    target.diagnosis_rows,
                )
                await _delete_exact_rows(
                    session,
                    delete(RunRow).where(RunRow.id == str(target.run_id)),
                    1,
                )
                await _delete_exact_rows(
                    session,
                    delete(IncidentRow).where(
                        IncidentRow.id == str(target.incident_id)
                    ),
                    1,
                )
                return True
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def get_agent_run_snapshot(self, run_id: UUID) -> AgentRunSnapshot:
        try:
            async with self._session_factory() as session:
                run, incident = await _load_run_context(session, run_id)
                _require_active_run(run, incident)
                if run.started_at is None or run.timeout_seconds <= 0:
                    raise RecoveryConsistencyError
                return AgentRunSnapshot(
                    id=run_id,
                    started_at=_database_datetime(run.started_at),
                    timeout_seconds=run.timeout_seconds,
                )
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def get_diagnosis_validation_snapshot(
        self,
        run_id: UUID,
    ) -> DiagnosisValidationSnapshot:
        try:
            async with self._session_factory() as session:
                run, incident = await _load_run_context(session, run_id)
                _require_active_run(run, incident)
                evidence_rows = list(
                    await session.scalars(
                        select(EvidenceRow).where(EvidenceRow.run_id == str(run_id))
                    )
                )
                event_rows = list(
                    await session.scalars(
                        select(RunEventRow)
                        .where(RunEventRow.run_id == str(run_id))
                        .order_by(RunEventRow.id)
                    )
                )
                return _diagnosis_validation_snapshot(
                    evidence_rows,
                    event_rows,
                    incident_id=UUID(incident.id),
                    run_id=run_id,
                )
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def get_tool_outcome(
        self,
        run_id: UUID,
        tool_call_id: str,
        tool_name: str,
    ) -> PersistedEvidence | ToolFailureRecord | None:
        try:
            async with self._session_factory() as session:
                _, incident = await _load_run_context(session, run_id)
                incident_id = UUID(incident.id)
                evidence = await _evidence_by_tool_call(session, run_id, tool_call_id)
                failure = await _event_by_key(
                    session, run_id, f"tool:{tool_call_id}:failed"
                )
                if evidence is None and failure is None:
                    return None
                if evidence is not None and failure is not None:
                    raise RecoveryConsistencyError

                await _require_matching_tool_started(
                    session,
                    incident_id,
                    run_id,
                    tool_call_id,
                    tool_name,
                )

                if evidence is not None:
                    return await _existing_evidence_outcome(
                        session,
                        evidence,
                        incident_id,
                        run_id,
                        tool_call_id,
                        tool_name,
                    )
                failure_row = cast(RunEventRow, failure)
                return _existing_failure_outcome(
                    failure_row,
                    _event_payload(failure_row),
                    incident_id,
                    run_id,
                    tool_call_id,
                    tool_name,
                )
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

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
            incident_id = UUID(incident.id)
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
            event_row = _new_event_row(
                incident_id=incident_id,
                run_id=run_id,
                event_key="run.started",
                event_type="run.started",
                occurred_at=started_at,
                payload=_run_started_event_payload(incident_id, run_id, started_at),
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
                _require_matching_tool_started_event(
                    existing,
                    incident_id,
                    run_id,
                    tool_call_id,
                    tool_name,
                )
                return _event_from_row(existing)
            _require_active_run(run, incident)
            occurred_at = datetime.now(UTC)
            event_row = _new_event_row(
                incident_id=incident_id,
                run_id=run_id,
                event_key=event_key,
                event_type="tool.started",
                occurred_at=occurred_at,
                payload=_tool_started_event_payload(
                    incident_id,
                    run_id,
                    tool_call_id,
                    tool_name,
                    occurred_at,
                ),
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
            _require_matching_tool_started_event(
                event_row,
                UUID(incident.id),
                run_id,
                tool_call_id,
                tool_name,
            )
            return _event_from_row(event_row)

    async def record_evidence(self, evidence: EvidenceRecord) -> PersistedEvidence:
        normalized = replace(
            evidence,
            observed_at=_require_aware_datetime(evidence.observed_at),
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
            event_row = _new_event_row(
                incident_id=incident_id,
                run_id=evidence.run_id,
                event_key=f"tool:{evidence.tool_call_id}:evidence",
                event_type="evidence.recorded",
                occurred_at=occurred_at,
                payload=_evidence_event_payload(
                    evidence_row,
                    incident_id,
                    evidence.run_id,
                    occurred_at,
                ),
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
        normalized = replace(
            failure,
            occurred_at=_require_aware_datetime(failure.occurred_at),
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
            event_row = _new_event_row(
                incident_id=incident_id,
                run_id=failure.run_id,
                event_key=event_key,
                event_type="tool.failed",
                occurred_at=failure.occurred_at,
                payload=_tool_failure_event_payload(failure, incident_id),
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
        normalized = replace(
            terminal,
            completed_at=_require_aware_datetime(terminal.completed_at),
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


async def _prune_target_from_rows(
    session: AsyncSession,
    run: RunRow,
    incident: IncidentRow,
    artifact_root: Path,
) -> PruneTarget:
    try:
        run_id = UUID(run.id)
    except (TypeError, ValueError):
        raise RecoveryConsistencyError from None
    diagnosis = await _diagnosis_by_run(session, run_id)
    start_event = await _event_by_key(session, run_id, "run.started")
    terminal_event = await _event_by_key(session, run_id, "run:terminal")
    snapshot = _workflow_run_snapshot(
        run,
        incident,
        diagnosis,
        start_event,
        terminal_event,
    )
    if snapshot.run_status not in (RunStatus.COMPLETED, RunStatus.FAILED):
        raise RecoveryConsistencyError

    event_rows = await session.scalar(
        select(func.count())
        .select_from(RunEventRow)
        .where(RunEventRow.run_id == run.id)
    )
    evidence_rows = await session.scalar(
        select(func.count())
        .select_from(EvidenceRow)
        .where(EvidenceRow.run_id == run.id)
    )
    diagnosis_rows = await session.scalar(
        select(func.count())
        .select_from(DiagnosisRow)
        .where(DiagnosisRow.run_id == run.id)
    )
    if (
        not isinstance(event_rows, int)
        or event_rows < 0
        or not isinstance(evidence_rows, int)
        or evidence_rows < 0
        or not isinstance(diagnosis_rows, int)
        or diagnosis_rows < 0
    ):
        raise RecoveryConsistencyError
    return PruneTarget(
        incident_id=snapshot.incident_id,
        run_id=snapshot.id,
        artifact_directory=artifact_root / str(snapshot.id),
        event_rows=event_rows,
        evidence_rows=evidence_rows,
        diagnosis_rows=diagnosis_rows,
    )


async def _delete_exact_rows(
    session: AsyncSession,
    statement: Delete,
    expected_rows: int,
) -> None:
    result = await session.execute(statement)
    if getattr(result, "rowcount", None) != expected_rows:
        raise RecoveryConsistencyError


def _incident_list_record(row: IncidentRow) -> IncidentListRecord:
    try:
        if (
            not _is_non_empty_string(row.scenario_id)
            or not _is_positive_integer(row.scenario_version)
            or not _is_non_empty_string(row.display_name)
        ):
            raise ValueError
        return IncidentListRecord(
            id=UUID(row.id),
            scenario_id=row.scenario_id,
            scenario_version=row.scenario_version,
            display_name=row.display_name,
            target=ScenarioTarget(
                cluster=row.cluster,
                namespace=row.namespace,
                api_version=row.api_version,
                kind=row.kind,
                name=row.resource_name,
            ),
            status=row.status,
            created_at=_database_datetime(row.created_at),
            updated_at=_database_datetime(row.updated_at),
        )
    except (AttributeError, TypeError, ValueError):
        raise RecoveryConsistencyError from None


def _incident_detail_record(
    incident: IncidentRow,
    run: RunRow,
    diagnosis: DiagnosisRow | None,
    evidence_rows: list[EvidenceRow],
    workflow: WorkflowRunSnapshot,
    terminal: TerminalRecord | None,
) -> IncidentDetailRecord:
    incident_record = _incident_list_record(incident)
    try:
        run_id = UUID(run.id)
        if (
            incident_record.id != workflow.incident_id
            or run_id != workflow.id
            or run.status is not workflow.run_status
            or not _is_non_empty_string(incident.trigger_summary)
        ):
            raise ValueError
        usage: tuple[object, ...] = (
            run.model_calls,
            run.tool_calls,
            run.input_tokens,
            run.output_tokens,
        )
        if any(not _is_optional_non_negative_integer(value) for value in usage):
            raise ValueError
        completed_at = (
            _database_datetime(run.completed_at)
            if run.completed_at is not None
            else None
        )
        if terminal is None:
            if (
                diagnosis is not None
                or completed_at is not None
                or run.error_code is not None
                or run.error_retryable is not None
            ):
                raise ValueError
            diagnosis_detail = None
        elif terminal.outcome is None:
            if diagnosis is not None or terminal.completed_at != completed_at:
                raise ValueError
            diagnosis_detail = None
        else:
            if diagnosis is None or terminal.completed_at != completed_at:
                raise ValueError
            diagnosis_detail = IncidentDiagnosisDetail(
                id=UUID(diagnosis.id),
                outcome=terminal.outcome,
                summary=cast(str, terminal.summary),
                root_causes=terminal.root_causes,
                missing_information=terminal.missing_information,
                redacted=terminal.redacted,
                created_at=_database_datetime(diagnosis.created_at),
            )
        return IncidentDetailRecord(
            incident=incident_record,
            trigger_summary=incident.trigger_summary,
            run=IncidentRunDetail(
                id=run_id,
                status=run.status,
                model=workflow.model,
                budget=workflow.budget,
                model_calls=run.model_calls,
                tool_calls=run.tool_calls,
                input_tokens=run.input_tokens,
                output_tokens=run.output_tokens,
                error_code=run.error_code,
                error_retryable=run.error_retryable,
                created_at=_database_datetime(run.created_at),
                started_at=workflow.started_at,
                completed_at=completed_at,
            ),
            evidence=tuple(
                _incident_evidence_detail(row, run_id) for row in evidence_rows
            ),
            diagnosis=diagnosis_detail,
        )
    except (AttributeError, TypeError, ValueError):
        raise RecoveryConsistencyError from None


def _incident_evidence_detail(
    row: EvidenceRow,
    run_id: UUID,
) -> IncidentEvidenceDetail:
    try:
        if (
            UUID(row.run_id) != run_id
            or not _is_non_empty_string(row.tool_call_id)
            or not _is_non_empty_string(row.tool_name)
            or not _is_non_empty_string(row.evidence_kind)
            or type(cast(object, row.truncated)) is not bool
            or type(cast(object, row.redacted)) is not bool
        ):
            raise ValueError
        return IncidentEvidenceDetail(
            id=UUID(row.id),
            tool_call_id=row.tool_call_id,
            tool_name=row.tool_name,
            evidence_kind=row.evidence_kind,
            target_ref=parse_json_object(row.target_ref_json),
            observed_at=_database_datetime(row.observed_at),
            payload=parse_json_object(row.payload_json),
            truncated=row.truncated,
            redacted=row.redacted,
        )
    except (AttributeError, TypeError, ValueError):
        raise RecoveryConsistencyError from None


def _workflow_run_snapshot(
    run: RunRow,
    incident: IncidentRow,
    diagnosis: DiagnosisRow | None,
    start_event: RunEventRow | None,
    terminal_event: RunEventRow | None,
) -> WorkflowRunSnapshot:
    snapshot, _ = _workflow_run_projection(
        run,
        incident,
        diagnosis,
        start_event,
        terminal_event,
    )
    return snapshot


def _workflow_run_projection(
    run: RunRow,
    incident: IncidentRow,
    diagnosis: DiagnosisRow | None,
    start_event: RunEventRow | None,
    terminal_event: RunEventRow | None,
) -> tuple[WorkflowRunSnapshot, TerminalRecord | None]:
    try:
        run_id = UUID(run.id)
        incident_id = UUID(incident.id)
        target = ScenarioTarget(
            cluster=incident.cluster,
            namespace=incident.namespace,
            api_version=incident.api_version,
            kind=incident.kind,
            name=incident.resource_name,
        )
    except (AttributeError, TypeError, ValueError):
        raise RecoveryConsistencyError from None
    if run.incident_id != incident.id or not _valid_workflow_snapshot_values(
        run, incident
    ):
        raise RecoveryConsistencyError

    started_at = (
        _database_datetime(run.started_at) if run.started_at is not None else None
    )
    completed_at = (
        _database_datetime(run.completed_at) if run.completed_at is not None else None
    )
    if run.status is RunStatus.RUNNING:
        if started_at is None:
            raise RecoveryConsistencyError
        _require_active_start_consistency(
            run,
            incident,
            start_event,
            expected_started_at=started_at,
        )
    else:
        _require_start_event_consistency(
            run,
            incident,
            start_event,
            started_at,
        )
    terminal: TerminalRecord | None = None
    if run.status is RunStatus.QUEUED:
        if (
            incident.status is not IncidentStatus.RECEIVED
            or started_at is not None
            or completed_at is not None
            or not _has_empty_terminal_fields(run, diagnosis, terminal_event)
        ):
            raise RecoveryConsistencyError
    elif run.status is RunStatus.RUNNING:
        if (
            incident.status is not IncidentStatus.TRIAGING
            or completed_at is not None
            or not _has_empty_terminal_fields(run, diagnosis, terminal_event)
        ):
            raise RecoveryConsistencyError
    else:
        terminal = _terminal_record_from_rows(
            run,
            diagnosis,
            terminal_event,
        )
        _resolve_terminal_replay(terminal, run, incident, diagnosis, terminal_event)
        completed_at = terminal.completed_at
        if run.status is RunStatus.COMPLETED and started_at is None:
            raise RecoveryConsistencyError

    snapshot = WorkflowRunSnapshot(
        id=run_id,
        incident_id=incident_id,
        run_status=run.status,
        trigger_summary=incident.trigger_summary,
        target=target,
        model=ModelSnapshot(
            provider=run.model_provider,
            model_id=run.model_id,
            thinking_mode=run.thinking_mode,
            prompt_version=run.prompt_version,
        ),
        budget=RunBudget(
            max_model_calls=run.max_model_calls,
            max_tool_calls=run.max_tool_calls,
            timeout_seconds=run.timeout_seconds,
        ),
        started_at=started_at,
    )
    return snapshot, terminal


def _require_start_event_consistency(
    run: RunRow,
    incident: IncidentRow,
    start_event: RunEventRow | None,
    started_at: datetime | None,
) -> None:
    if started_at is None:
        if start_event is not None:
            raise RecoveryConsistencyError
        return
    if start_event is None:
        raise RecoveryConsistencyError
    incident_id = UUID(incident.id)
    run_id = UUID(run.id)
    if not _event_matches(
        start_event,
        incident_id=incident_id,
        run_id=run_id,
        event_key="run.started",
        event_type="run.started",
        occurred_at=started_at,
        payload=_run_started_event_payload(incident_id, run_id, started_at),
    ):
        raise RecoveryConsistencyError


def _require_active_start_consistency(
    run: RunRow,
    incident: IncidentRow,
    start_event: RunEventRow | None,
    expected_started_at: datetime,
) -> None:
    if (
        run.started_at is None
        or _database_datetime(run.started_at) != expected_started_at
        or _database_datetime(run.updated_at) != expected_started_at
        or _database_datetime(incident.updated_at) != expected_started_at
    ):
        raise RecoveryConsistencyError
    _require_start_event_consistency(
        run,
        incident,
        start_event,
        expected_started_at,
    )


def _valid_workflow_snapshot_values(run: RunRow, incident: IncidentRow) -> bool:
    text_values: tuple[object, ...] = (
        incident.trigger_summary,
        run.model_provider,
        run.model_id,
        run.prompt_version,
    )
    budget_values: tuple[object, ...] = (
        run.max_model_calls,
        run.max_tool_calls,
        run.timeout_seconds,
    )
    thinking_mode: object = run.thinking_mode
    return (
        all(_is_non_empty_string(value) for value in text_values)
        and _is_boolean(thinking_mode)
        and all(_is_positive_integer(value) for value in budget_values)
    )


def _is_non_empty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value)


def _is_boolean(value: object) -> bool:
    return isinstance(value, bool)


def _is_positive_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _is_optional_non_negative_integer(value: object) -> bool:
    return value is None or (
        isinstance(value, int) and not isinstance(value, bool) and value >= 0
    )


def _has_empty_terminal_fields(
    run: RunRow,
    diagnosis: DiagnosisRow | None,
    terminal_event: RunEventRow | None,
) -> bool:
    return (
        diagnosis is None
        and terminal_event is None
        and run.model_calls is None
        and run.tool_calls is None
        and run.input_tokens is None
        and run.output_tokens is None
        and run.error_code is None
        and run.error_retryable is None
    )


def _terminal_record_from_rows(
    run: RunRow,
    diagnosis: DiagnosisRow | None,
    terminal_event: RunEventRow | None,
) -> TerminalRecord:
    if run.completed_at is None or terminal_event is None:
        raise RecoveryConsistencyError
    completed_at = _database_datetime(run.completed_at)
    if run.status is RunStatus.COMPLETED:
        if (
            diagnosis is None
            or run.error_code is not None
            or run.error_retryable is not None
        ):
            raise RecoveryConsistencyError
        validated = _validated_diagnosis_from_row(diagnosis)
        return TerminalRecord(
            run_id=UUID(run.id),
            completed_at=completed_at,
            outcome=DiagnosisOutcome(validated.outcome),
            summary=validated.summary,
            root_causes=tuple(
                RootCauseRecord(
                    code=root_cause.code,
                    statement=root_cause.statement,
                    confidence=root_cause.confidence,
                    evidence_ids=tuple(root_cause.evidence_ids),
                )
                for root_cause in validated.root_causes
            ),
            missing_information=tuple(validated.missing_information),
            redacted=validated.redacted,
            error_code=None,
            error_retryable=None,
            model_calls=run.model_calls,
            tool_calls=run.tool_calls,
            input_tokens=run.input_tokens,
            output_tokens=run.output_tokens,
        )
    if (
        run.status is not RunStatus.FAILED
        or diagnosis is not None
        or not isinstance(run.error_code, str)
        or not run.error_code
        or not isinstance(run.error_retryable, bool)
    ):
        raise RecoveryConsistencyError
    return TerminalRecord(
        run_id=UUID(run.id),
        completed_at=completed_at,
        outcome=None,
        summary=None,
        root_causes=(),
        missing_information=(),
        redacted=False,
        error_code=run.error_code,
        error_retryable=run.error_retryable,
        model_calls=run.model_calls,
        tool_calls=run.tool_calls,
        input_tokens=run.input_tokens,
        output_tokens=run.output_tokens,
    )


def _validated_diagnosis_from_row(
    diagnosis: DiagnosisRow,
) -> ValidatedDiagnosis:
    try:
        return ValidatedDiagnosis.model_validate(
            {
                "outcome": diagnosis.outcome.value,
                "summary": diagnosis.summary,
                "root_causes": json.loads(diagnosis.root_causes_json),
                "missing_information": json.loads(diagnosis.missing_information_json),
                "redacted": diagnosis.redacted,
            }
        )
    except (AttributeError, TypeError, json.JSONDecodeError, ValidationError):
        raise RecoveryConsistencyError from None


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
            payload=_event_payload(row),
        )
    except (TypeError, ValueError):
        raise RecoveryConsistencyError from None


def _event_payload(row: RunEventRow) -> dict[str, JsonValue]:
    try:
        return parse_json_object(row.payload_json)
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


def _tool_started_event_payload(
    incident_id: UUID,
    run_id: UUID,
    tool_call_id: str,
    tool_name: str,
    occurred_at: datetime,
) -> dict[str, JsonValue]:
    payload = _base_payload(incident_id, run_id, occurred_at)
    payload.update({"toolCallId": tool_call_id, "toolName": tool_name})
    return payload


def _run_started_event_payload(
    incident_id: UUID,
    run_id: UUID,
    started_at: datetime,
) -> dict[str, JsonValue]:
    payload = _base_payload(incident_id, run_id, started_at)
    payload.update(
        {
            "incidentStatus": IncidentStatus.TRIAGING.value,
            "runStatus": RunStatus.RUNNING.value,
        }
    )
    return payload


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
    if (
        run.status is not RunStatus.RUNNING
        or incident.status is not IncidentStatus.TRIAGING
    ):
        raise RecoveryConsistencyError
    _require_active_start_consistency(
        run,
        incident,
        event_row,
        expected_started_at=started_at,
    )
    return _started_run(run, incident, event_row)


async def _require_matching_tool_started(
    session: AsyncSession,
    incident_id: UUID,
    run_id: UUID,
    tool_call_id: str,
    tool_name: str,
) -> None:
    event_row = await _event_by_key(session, run_id, f"tool:{tool_call_id}:started")
    if event_row is None:
        raise RecoveryConsistencyError
    _require_matching_tool_started_event(
        event_row,
        incident_id,
        run_id,
        tool_call_id,
        tool_name,
    )


def _require_matching_tool_started_event(
    event_row: RunEventRow,
    incident_id: UUID,
    run_id: UUID,
    tool_call_id: str,
    tool_name: str,
) -> None:
    occurred_at = _database_datetime(event_row.occurred_at)
    if not _event_matches(
        event_row,
        incident_id=incident_id,
        run_id=run_id,
        event_key=f"tool:{tool_call_id}:started",
        event_type="tool.started",
        occurred_at=occurred_at,
        payload=_tool_started_event_payload(
            incident_id,
            run_id,
            tool_call_id,
            tool_name,
            occurred_at,
        ),
    ):
        raise RecoveryConsistencyError


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


async def _existing_evidence_outcome(
    session: AsyncSession,
    evidence_row: EvidenceRow,
    incident_id: UUID,
    run_id: UUID,
    tool_call_id: str,
    tool_name: str,
) -> PersistedEvidence:
    event_row = await _event_by_key(session, run_id, f"tool:{tool_call_id}:evidence")
    if event_row is None:
        raise RecoveryConsistencyError
    return _existing_evidence_outcome_from_event(
        evidence_row,
        event_row,
        incident_id,
        run_id,
        tool_call_id,
        tool_name,
    )


def _existing_evidence_outcome_from_event(
    evidence_row: EvidenceRow,
    event_row: RunEventRow,
    incident_id: UUID,
    run_id: UUID,
    tool_call_id: str,
    tool_name: str,
) -> PersistedEvidence:
    occurred_at = _database_datetime(event_row.occurred_at)
    if (
        evidence_row.id != str(evidence_id(run_id, tool_call_id))
        or evidence_row.tool_name != tool_name
        or not _event_matches(
            event_row,
            incident_id=incident_id,
            run_id=run_id,
            event_key=f"tool:{tool_call_id}:evidence",
            event_type="evidence.recorded",
            occurred_at=occurred_at,
            payload=_evidence_event_payload(
                evidence_row,
                incident_id,
                run_id,
                occurred_at,
            ),
        )
    ):
        raise RecoveryConsistencyError
    return _persisted_evidence(evidence_row, event_row)


def _existing_failure_outcome(
    event_row: RunEventRow,
    event_payload: dict[str, JsonValue],
    incident_id: UUID,
    run_id: UUID,
    tool_call_id: str,
    tool_name: str,
) -> ToolFailureRecord:
    error_code = event_payload.get("errorCode")
    retryable = event_payload.get("retryable")
    if not isinstance(error_code, str) or not isinstance(retryable, bool):
        raise RecoveryConsistencyError
    occurred_at = _database_datetime(event_row.occurred_at)
    failure = ToolFailureRecord(
        run_id=run_id,
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        error_code=error_code,
        retryable=retryable,
        occurred_at=occurred_at,
    )
    if not _event_matches(
        event_row,
        incident_id=incident_id,
        run_id=run_id,
        event_key=f"tool:{tool_call_id}:failed",
        event_type="tool.failed",
        occurred_at=occurred_at,
        payload=_tool_failure_event_payload(failure, incident_id),
    ):
        raise RecoveryConsistencyError
    return failure


def _diagnosis_validation_snapshot(
    evidence_rows: list[EvidenceRow],
    event_rows: list[RunEventRow],
    *,
    incident_id: UUID,
    run_id: UUID,
) -> DiagnosisValidationSnapshot:
    evidence_events = [
        event_row for event_row in event_rows if _is_evidence_outcome_event(event_row)
    ]
    failure_events = [
        event_row for event_row in event_rows if _is_failure_outcome_event(event_row)
    ]
    started_events = [
        event_row for event_row in event_rows if _is_tool_started_event(event_row)
    ]
    evidence_events_by_key = {
        event_row.event_key: event_row for event_row in evidence_events
    }
    all_events_by_key = {event_row.event_key: event_row for event_row in event_rows}

    matched_evidence_event_ids: set[int] = set()
    matched_started_event_ids: set[int] = set()
    successes: list[tuple[int, str, str]] = []
    persisted_ids: set[UUID] = set()
    success_call_ids: set[str] = set()
    for evidence_row in evidence_rows:
        event_row = evidence_events_by_key.get(
            f"tool:{evidence_row.tool_call_id}:evidence"
        )
        if event_row is None:
            raise RecoveryConsistencyError
        persisted = _existing_evidence_outcome_from_event(
            evidence_row,
            event_row,
            incident_id,
            run_id,
            evidence_row.tool_call_id,
            evidence_row.tool_name,
        )
        matched_started_event_ids.add(
            _require_earlier_matching_tool_started(
                all_events_by_key,
                event_row,
                incident_id,
                run_id,
                persisted.tool_call_id,
                persisted.tool_name,
            )
        )
        if persisted.id in persisted_ids or persisted.tool_call_id in success_call_ids:
            raise RecoveryConsistencyError
        persisted_ids.add(persisted.id)
        success_call_ids.add(persisted.tool_call_id)
        matched_evidence_event_ids.add(event_row.id)
        successes.append((event_row.id, persisted.tool_call_id, persisted.tool_name))

    if matched_evidence_event_ids != {event_row.id for event_row in evidence_events}:
        raise RecoveryConsistencyError

    failures: list[tuple[int, ToolFailureRecord]] = []
    failure_call_ids: set[str] = set()
    for event_row in failure_events:
        payload = _event_payload(event_row)
        tool_call_id = payload.get("toolCallId")
        tool_name = payload.get("toolName")
        if not isinstance(tool_call_id, str) or not isinstance(tool_name, str):
            raise RecoveryConsistencyError
        if tool_call_id in failure_call_ids or tool_call_id in success_call_ids:
            raise RecoveryConsistencyError
        failure_call_ids.add(tool_call_id)
        failure = _existing_failure_outcome(
            event_row,
            payload,
            incident_id,
            run_id,
            tool_call_id,
            tool_name,
        )
        matched_started_event_ids.add(
            _require_earlier_matching_tool_started(
                all_events_by_key,
                event_row,
                incident_id,
                run_id,
                failure.tool_call_id,
                failure.tool_name,
            )
        )
        failures.append((event_row.id, failure))

    if matched_started_event_ids != {event_row.id for event_row in started_events}:
        raise RecoveryConsistencyError

    unresolved = tuple(
        failure
        for failure_event_id, failure in failures
        if not failure.retryable
        or not any(
            success_event_id > failure_event_id
            and success_call_id != failure.tool_call_id
            and success_tool_name == failure.tool_name
            for success_event_id, success_call_id, success_tool_name in successes
        )
    )
    return DiagnosisValidationSnapshot(
        evidence_ids=frozenset(persisted_ids),
        tool_failures=tuple(failure for _, failure in failures),
        unresolved_tool_failures=unresolved,
    )


def _is_evidence_outcome_event(event_row: RunEventRow) -> bool:
    return event_row.event_type == "evidence.recorded" or (
        event_row.event_key.startswith("tool:")
        and event_row.event_key.endswith(":evidence")
    )


def _is_failure_outcome_event(event_row: RunEventRow) -> bool:
    return event_row.event_type == "tool.failed" or (
        event_row.event_key.startswith("tool:")
        and event_row.event_key.endswith(":failed")
    )


def _is_tool_started_event(event_row: RunEventRow) -> bool:
    return event_row.event_type == "tool.started" or (
        event_row.event_key.startswith("tool:")
        and event_row.event_key.endswith(":started")
    )


def _require_earlier_matching_tool_started(
    events_by_key: dict[str, RunEventRow],
    outcome_event: RunEventRow,
    incident_id: UUID,
    run_id: UUID,
    tool_call_id: str,
    tool_name: str,
) -> int:
    started_event = events_by_key.get(f"tool:{tool_call_id}:started")
    if started_event is None or started_event.id >= outcome_event.id:
        raise RecoveryConsistencyError
    _require_matching_tool_started_event(
        started_event,
        incident_id,
        run_id,
        tool_call_id,
        tool_name,
    )
    return started_event.id


def _tool_failure_event_payload(
    failure: ToolFailureRecord,
    incident_id: UUID,
) -> dict[str, JsonValue]:
    payload = _base_payload(incident_id, failure.run_id, failure.occurred_at)
    payload.update(
        {
            "toolCallId": failure.tool_call_id,
            "toolName": failure.tool_name,
            "errorCode": failure.error_code,
            "retryable": failure.retryable,
        }
    )
    return payload


def _resolve_failure_replay(
    failure: ToolFailureRecord,
    evidence: EvidenceRow | None,
    existing: RunEventRow | None,
    incident_id: UUID,
) -> RunEvent:
    if evidence is not None or existing is None:
        raise RecoveryConsistencyError
    if not _event_matches(
        existing,
        incident_id=incident_id,
        run_id=failure.run_id,
        event_key=f"tool:{failure.tool_call_id}:failed",
        event_type="tool.failed",
        occurred_at=failure.occurred_at,
        payload=_tool_failure_event_payload(failure, incident_id),
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
