from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Awaitable, Callable, Iterable
from contextlib import suppress
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Final, Literal, cast
from uuid import UUID, uuid4, uuid5

from pydantic import ValidationError
from sqlalchemy import and_, delete, exists, func, or_, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import aliased
from sqlalchemy.sql.dml import Delete

from k8s_incident_agent.auth.public_demo import (
    RunOwnershipError,
    owns_run,
    require_operator_current,
)
from k8s_incident_agent.auth.sessions import (
    OperatorAuthenticationError,
    OperatorSession,
)
from k8s_incident_agent.diagnosis.contracts import (
    ValidatedDiagnosis,
    recommendation_records,
)
from k8s_incident_agent.diagnosis.tool_execution import (
    OBSERVATION_LIMIT,
    normalize_diagnostic_tool_call_identity,
)
from k8s_incident_agent.domain.contracts import (
    IncidentSource,
    KubernetesTarget,
    NormalizedIncidentTrigger,
    RepairHistorySelection,
)
from k8s_incident_agent.domain.models import (
    CANONICAL_ALERT_TIMESTAMP_PATTERN,
    AlertSignalRecord,
    AlertSignalStatus,
    CanonicalAlertTimestamp,
    CreatedIncident,
    CreatedRun,
    DiagnosisOutcome,
    DiagnosisValidationSnapshot,
    DiagnosisWorkflowRunSnapshot,
    EvidenceRecord,
    IncidentStatus,
    JsonValue,
    ModelSnapshot,
    NormalizedAlertOccurrence,
    PersistedAlertBatch,
    PersistedEvidence,
    PersistedTerminal,
    RecommendationRecord,
    RepairOperation,
    RepairWorkflowRunSnapshot,
    RootCauseRecord,
    RunBudget,
    RunEvent,
    RunKind,
    RunRecord,
    RunStatus,
    TerminalRecord,
    ToolFailureRecord,
    WorkflowRunSnapshot,
)
from k8s_incident_agent.execution.contracts import (
    ApprovalDecision,
    ApprovalRecord,
    ExecutionCommand,
    ExecutionReceipt,
    ExecutionRecord,
    ExecutionResult,
    ExecutionStatus,
)
from k8s_incident_agent.kubernetes.contracts import (
    RolloutHistoryPayload,
    WorkloadObservation,
)
from k8s_incident_agent.persistence.canonical import canonical_json, parse_json_object
from k8s_incident_agent.persistence.models import (
    AlertSignalRow,
    ApprovalRow,
    DiagnosisRow,
    EvidenceRow,
    ExecutionRow,
    IncidentRow,
    MonitoringSourceStateRow,
    OperatorSessionRow,
    RepairProposalRow,
    RunEventRow,
    RunRow,
    VerificationRow,
)
from k8s_incident_agent.repair.actions import (
    ActionUnavailableReason,
    IncidentActions,
    RepairHistoryCandidate,
    RepairPreparationSource,
)
from k8s_incident_agent.repair.compiler import (
    RepairPreparationError,
    require_exact_repair_proposal,
)
from k8s_incident_agent.repair.contracts import (
    PatchValidationResponse,
    RepairProposal,
    SetContainerImageIntent,
)
from k8s_incident_agent.repair.history import image_history_candidates
from k8s_incident_agent.repair.records import PreparedRepairRecord, RepairTerminalRecord
from k8s_incident_agent.repair.rollback import RollbackSource, resolve_rollback_change
from k8s_incident_agent.repair.verification_contracts import (
    MAX_OBSERVATION_BYTES,
    VerificationObservation,
    VerificationRecord,
    verification_sample_key,
)

PROJECT_NAMESPACE: Final = UUID("5c2f2e64-4c10-5ba3-99f0-8f9f37c660b8")
_SCHEMA_VERSION: Final = 5
_ACTIVE_RUN_STATUSES: Final = (
    RunStatus.QUEUED,
    RunStatus.RUNNING,
    RunStatus.WAITING_APPROVAL,
)
_CANONICAL_ALERT_TIMESTAMP = re.compile(CANONICAL_ALERT_TIMESTAMP_PATTERN)
_OVERVIEW_HOUR = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}$")


@dataclass(frozen=True, slots=True)
class PruneTarget:
    incident_id: UUID
    updated_at: datetime
    run_ids: tuple[UUID, ...]
    artifact_directories: tuple[Path, ...]
    event_rows: int
    evidence_rows: int
    diagnosis_rows: int
    repair_proposal_rows: int
    run_rows: int
    alert_signal_rows: int
    approval_rows: int = 0
    execution_rows: int = 0
    verification_rows: int = 0


@dataclass(frozen=True, slots=True)
class IncidentListRecord:
    id: UUID
    source: IncidentSource
    display_name: str
    target: KubernetesTarget
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
    kind: RunKind
    operation: RepairOperation | None
    attempt: int
    status: RunStatus
    error_code: str | None
    error_retryable: bool | None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    request_source: Literal["system", "operator"] | None
    source_run_id: UUID | None
    selection: RepairHistorySelection | None
    waiting_expires_at: datetime | None
    end_reason: (
        Literal["expired", "superseded", "rejected", "execution_expired", "withdrawn"]
        | None
    )
    initiated_by_you: bool = False


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
    # None marks a Run recorded before recommendations existed.
    recommendations: tuple[RecommendationRecord, ...] | None
    redacted: bool
    created_at: datetime


@dataclass(frozen=True, slots=True)
class IncidentRepairDetail:
    proposal: RepairProposal
    validation: PatchValidationResponse
    approval: ApprovalRecord | None = None
    execution: ExecutionRecord | None = None
    verification: VerificationRecord | None = None


@dataclass(frozen=True, slots=True)
class RepairVerificationContext:
    record: VerificationRecord
    proposal: RepairProposal
    receipt: ExecutionReceipt
    previous: VerificationObservation | None
    occurrence_resolved: bool | None
    watchdog_received_at: datetime | None


@dataclass(frozen=True, slots=True)
class IncidentDetailRecord:
    incident: IncidentListRecord
    trigger_summary: str
    run: IncidentRunDetail
    evidence: tuple[IncidentEvidenceDetail, ...]
    diagnosis: IncidentDiagnosisDetail | None
    repair: IncidentRepairDetail | None
    alert_signal: AlertSignalRecord | None
    events: tuple[RunEvent, ...]
    has_older_events: bool
    event_cursor: int
    run_creation_blocked: bool = False
    actions: IncidentActions | None = None


@dataclass(frozen=True, slots=True)
class MonitoringRunInterval:
    id: UUID
    attempt: int
    started_at: datetime | None
    completed_at: datetime | None


@dataclass(frozen=True, slots=True)
class IncidentMonitoringContext:
    source: IncidentSource
    target: KubernetesTarget
    occurred_at: datetime
    alert_signal: AlertSignalRecord | None
    runs: tuple[MonitoringRunInterval, ...]
    runs_truncated: bool


@dataclass(frozen=True, slots=True)
class MonitoringOverviewFamilyRecord:
    source_ref: str
    count: int


@dataclass(frozen=True, slots=True)
class MonitoringOverviewSampleRecord:
    timestamp: datetime
    incidents_created: int
    alert_conditions_resolved: int


@dataclass(frozen=True, slots=True)
class MonitoringOverviewRecord:
    total_incidents: int
    firing_alerts: int
    triaging_incidents: int
    waiting_approval_incidents: int
    families: tuple[MonitoringOverviewFamilyRecord, ...]
    samples: tuple[MonitoringOverviewSampleRecord, ...]


@dataclass(frozen=True, slots=True)
class RunListPage:
    items: tuple[IncidentRunDetail, ...]
    has_more: bool


@dataclass(frozen=True, slots=True)
class RunEventPage:
    items: tuple[RunEvent, ...]
    has_more: bool


@dataclass(frozen=True, slots=True)
class _WorkflowRows:
    run: RunRow
    incident: IncidentRow
    alert_signal: AlertSignalRow | None
    diagnosis: DiagnosisRow | None
    repair_proposal: RepairProposalRow | None
    repair: IncidentRepairDetail | None
    start_event: RunEventRow | None
    terminal_event: RunEventRow | None
    managed_events: tuple[RunEventRow, ...]
    source: RepairProposal | RollbackSource | None


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


class ActiveRunExistsError(RepositoryError):
    code = "active_run_exists"

    def __init__(self) -> None:
        super().__init__("Incident already has an active Run")


class RepairSourceInvalidError(RepositoryError):
    code = "repair_source_invalid"


class ApprovalConflictError(RepositoryError):
    code = "approval_conflict"


class ExecutionDisabledError(RepositoryError):
    code = "execution_disabled"


class ExecutionReportConflictError(RepositoryError):
    code = "execution_report_conflict"


class ObservationLimitExceededError(RepositoryError):
    code = "observation_limit_exceeded"

    def __init__(self) -> None:
        super().__init__("The tool already holds its bounded observations for this Run")


class RunNotFoundRepositoryError(RepositoryError):
    code = "run_not_found"

    def __init__(self) -> None:
        super().__init__("Run does not belong to the Incident")


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


async def _record_watchdog_arrival(
    session: AsyncSession,
    received_at: datetime,
) -> None:
    state = await session.get(MonitoringSourceStateRow, 1)
    if state is None:
        session.add(
            MonitoringSourceStateRow(
                singleton_id=1,
                last_watchdog_received_at=received_at,
            )
        )
        await session.flush()
        return
    if _database_datetime(state.last_watchdog_received_at) < received_at:
        state.last_watchdog_received_at = received_at


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
        *,
        on_event_committed: Callable[[UUID], Awaitable[None]] | None = None,
        sandbox_execution_enabled: bool = False,
        execution_cluster: str | None = None,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._session_factory = session_factory
        self._on_event_committed = on_event_committed
        self._execution_enabled = sandbox_execution_enabled
        self._execution_cluster = execution_cluster
        self._now = now

    async def incident_exists(self, incident_id: UUID) -> bool:
        try:
            async with self._session_factory() as session:
                return await session.get(IncidentRow, str(incident_id)) is not None
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def get_monitoring_overview(
        self,
        generated_at: datetime,
    ) -> MonitoringOverviewRecord:
        generated_at = _require_aware_datetime(generated_at).astimezone(UTC)
        current_hour = generated_at.replace(minute=0, second=0, microsecond=0)
        first_hour = current_hour - timedelta(hours=23)
        first_alert_timestamp = _canonical_alert_datetime(first_hour)
        generated_alert_timestamp = _canonical_alert_datetime(generated_at)
        try:
            async with self._session_factory() as session:
                total_incidents = _overview_count(
                    await session.scalar(select(func.count()).select_from(IncidentRow))
                )
                firing_alerts = _overview_count(
                    await session.scalar(
                        select(func.count())
                        .select_from(AlertSignalRow)
                        .where(AlertSignalRow.status == AlertSignalStatus.FIRING)
                    )
                )
                triaging_incidents = _overview_count(
                    await session.scalar(
                        select(func.count())
                        .select_from(IncidentRow)
                        .where(IncidentRow.status == IncidentStatus.TRIAGING)
                    )
                )
                waiting_approval_incidents = _overview_count(
                    await session.scalar(
                        select(func.count())
                        .select_from(IncidentRow)
                        .where(IncidentRow.status == IncidentStatus.WAITING_APPROVAL)
                    )
                )

                family_rows = (
                    await session.execute(
                        select(
                            IncidentRow.trigger_source,
                            IncidentRow.trigger_ref,
                            func.count(),
                        )
                        .join(
                            AlertSignalRow,
                            AlertSignalRow.incident_id == IncidentRow.id,
                        )
                        .where(AlertSignalRow.status == AlertSignalStatus.FIRING)
                        .group_by(
                            IncidentRow.trigger_source,
                            IncidentRow.trigger_ref,
                        )
                        .order_by(func.count().desc(), IncidentRow.trigger_ref)
                    )
                ).all()
                families = tuple(
                    _overview_family_record(
                        source_type,
                        source_ref,
                        count,
                    )
                    for source_type, source_ref, count in family_rows
                )

                incident_hour = func.strftime(
                    "%Y-%m-%dT%H",
                    IncidentRow.created_at,
                )
                incident_rows = (
                    (
                        await session.execute(
                            select(incident_hour, func.count())
                            .where(
                                IncidentRow.created_at >= first_hour,
                                IncidentRow.created_at <= generated_at,
                            )
                            .group_by(incident_hour)
                        )
                    )
                    .tuples()
                    .all()
                )
                resolved_hour = func.substr(AlertSignalRow.ends_at, 1, 13)
                resolved_rows = (
                    (
                        await session.execute(
                            select(resolved_hour, func.count())
                            .where(
                                AlertSignalRow.ends_at.is_not(None),
                                AlertSignalRow.ends_at >= first_alert_timestamp,
                                AlertSignalRow.ends_at <= generated_alert_timestamp,
                            )
                            .group_by(resolved_hour)
                        )
                    )
                    .tuples()
                    .all()
                )
                incident_counts = _overview_hour_counts(incident_rows)
                resolved_counts = _overview_hour_counts(resolved_rows)
                samples = tuple(
                    MonitoringOverviewSampleRecord(
                        timestamp=timestamp,
                        incidents_created=incident_counts.get(
                            timestamp.strftime("%Y-%m-%dT%H"),
                            0,
                        ),
                        alert_conditions_resolved=resolved_counts.get(
                            timestamp.strftime("%Y-%m-%dT%H"),
                            0,
                        ),
                    )
                    for timestamp in (
                        first_hour + timedelta(hours=offset) for offset in range(24)
                    )
                )
                return MonitoringOverviewRecord(
                    total_incidents=total_incidents,
                    firing_alerts=firing_alerts,
                    triaging_incidents=triaging_incidents,
                    waiting_approval_incidents=waiting_approval_incidents,
                    families=families,
                    samples=samples,
                )
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def get_incident_monitoring_context(
        self,
        incident_id: UUID,
        *,
        run_limit: int,
    ) -> IncidentMonitoringContext | None:
        if run_limit < 1 or run_limit > 50:
            raise ValueError("Monitoring Run limit must be between 1 and 50")
        try:
            async with self._session_factory() as session:
                incident_row = await session.get(IncidentRow, str(incident_id))
                if incident_row is None:
                    return None
                incident = _incident_list_record(incident_row)
                alert_signal = await session.get(AlertSignalRow, incident_row.id)
                run_rows = list(
                    await session.scalars(
                        select(RunRow)
                        .where(RunRow.incident_id == incident_row.id)
                        .order_by(RunRow.attempt.desc())
                        .limit(run_limit + 1)
                    )
                )
                return IncidentMonitoringContext(
                    source=incident.source,
                    target=incident.target,
                    occurred_at=_incident_onset(incident_row, alert_signal),
                    alert_signal=_alert_signal_record(alert_signal, incident),
                    runs=tuple(
                        MonitoringRunInterval(
                            id=UUID(row.id),
                            attempt=row.attempt,
                            started_at=(
                                _database_datetime(row.started_at)
                                if row.started_at is not None
                                else None
                            ),
                            completed_at=(
                                _database_datetime(row.completed_at)
                                if row.completed_at is not None
                                else None
                            ),
                        )
                        for row in run_rows[:run_limit]
                    ),
                    runs_truncated=len(run_rows) > run_limit,
                )
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def get_incident_event(
        self,
        incident_id: UUID,
        event_id: int,
    ) -> RunEvent | None:
        if event_id <= 0:
            raise ValueError("Event ID must be positive")
        try:
            async with self._session_factory() as session:
                row = (
                    await session.execute(
                        select(RunEventRow, RunRow.incident_id)
                        .join(RunRow, RunRow.id == RunEventRow.run_id)
                        .where(
                            RunEventRow.id == event_id,
                            RunRow.incident_id == str(incident_id),
                        )
                    )
                ).one_or_none()
                return (
                    None
                    if row is None
                    else _event_from_row(row[0], expected_incident_id=incident_id)
                )
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def list_incident_events(
        self,
        incident_id: UUID,
        *,
        after_id: int,
        limit: int,
    ) -> tuple[RunEvent, ...]:
        if after_id < 0:
            raise ValueError("Event cursor must be non-negative")
        if limit < 1 or limit > 100:
            raise ValueError("Event replay limit must be between 1 and 100")
        try:
            async with self._session_factory() as session:
                rows = (
                    await session.execute(
                        select(RunEventRow)
                        .join(RunRow, RunRow.id == RunEventRow.run_id)
                        .where(
                            RunRow.incident_id == str(incident_id),
                            RunEventRow.id > after_id,
                        )
                        .order_by(RunEventRow.id)
                        .limit(limit)
                    )
                ).scalars()
                return tuple(
                    _event_from_row(row, expected_incident_id=incident_id)
                    for row in rows
                )
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def latest_incident_event_id(self, incident_id: UUID) -> int:
        try:
            async with self._session_factory() as session:
                latest = await session.scalar(
                    select(func.max(RunEventRow.id))
                    .join(RunRow, RunRow.id == RunEventRow.run_id)
                    .where(RunRow.incident_id == str(incident_id))
                )
                if latest is None:
                    return 0
                if latest <= 0:
                    raise RecoveryConsistencyError
                return latest
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

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
        *,
        run_id: UUID | None,
        event_limit: int,
        now: datetime | None = None,
        requester: OperatorSession | None = None,
    ) -> IncidentDetailRecord | None:
        if event_limit < 1 or event_limit > 100:
            raise ValueError("Event page limit must be between 1 and 100")
        try:
            async with self._session_factory() as session:
                # SQLite's legacy driver does not begin a snapshot for SELECT.
                # Keep the Run, ledger and Evidence on the same committed version.
                await session.execute(text("BEGIN"))
                incident = await session.get(IncidentRow, str(incident_id))
                if incident is None:
                    return None

                if run_id is None:
                    run = await session.scalar(
                        select(RunRow)
                        .where(RunRow.incident_id == incident.id)
                        .order_by(RunRow.attempt.desc())
                        .limit(1)
                    )
                else:
                    run = await session.get(RunRow, str(run_id))
                    if run is None or run.incident_id != incident.id:
                        raise RunNotFoundRepositoryError
                if run is None:
                    raise RecoveryConsistencyError
                rows = await _load_workflow_rows(session, UUID(run.id))
                if rows.incident.id != incident.id:
                    raise RecoveryConsistencyError
                alert_signal = await session.get(AlertSignalRow, incident.id)
                workflow, terminal = _workflow_run_projection(
                    rows.run,
                    rows.incident,
                    rows.alert_signal,
                    rows.diagnosis,
                    rows.start_event,
                    rows.terminal_event,
                    rows.repair_proposal,
                    rows.repair,
                    rows.managed_events,
                )
                evidence_rows = list(
                    await session.scalars(
                        select(EvidenceRow)
                        .where(EvidenceRow.run_id == run.id)
                        .order_by(EvidenceRow.observed_at, EvidenceRow.id)
                    )
                )
                event_rows = list(
                    await session.scalars(
                        select(RunEventRow)
                        .where(RunEventRow.run_id == run.id)
                        .order_by(RunEventRow.id.desc())
                        .limit(event_limit + 1)
                    )
                )
                event_cursor = await session.scalar(
                    select(func.max(RunEventRow.id))
                    .join(RunRow, RunRow.id == RunEventRow.run_id)
                    .where(RunRow.incident_id == incident.id)
                )
                if not isinstance(event_cursor, int) or event_cursor <= 0:
                    raise RecoveryConsistencyError
                detail = _incident_detail_record(
                    incident,
                    run,
                    rows.diagnosis,
                    rows.repair,
                    alert_signal,
                    evidence_rows,
                    workflow,
                    terminal,
                    event_rows[:event_limit],
                    len(event_rows) > event_limit,
                    event_cursor,
                )
                occupied = await session.scalar(
                    select(
                        exists().where(
                            ExecutionRow.run_id == RunRow.id,
                            RunRow.incident_id == incident.id,
                            ExecutionRow.target_released_at.is_(None),
                        )
                    )
                )
                active_id = await session.scalar(
                    select(RunRow.id).where(
                        RunRow.incident_id == incident.id,
                        RunRow.status.in_(_ACTIVE_RUN_STATUSES),
                    )
                )
                target_occupied = await session.scalar(
                    select(
                        exists().where(
                            ExecutionRow.cluster == incident.cluster,
                            ExecutionRow.namespace == incident.namespace,
                            ExecutionRow.kind == incident.kind,
                            ExecutionRow.resource_name == incident.resource_name,
                            ExecutionRow.target_released_at.is_(None),
                        )
                    )
                )
                in_scope = True
                if rows.repair is not None:
                    try:
                        self._require_execution_scope(rows.repair.proposal)
                    except ApprovalConflictError:
                        in_scope = False
                detail = replace(detail, run_creation_blocked=bool(occupied))
                projected = replace(
                    detail,
                    run=replace(detail.run, initiated_by_you=owns_run(run, requester)),
                    actions=_incident_actions(
                        detail,
                        source=rows.source,
                        active_id=active_id,
                        target_occupied=bool(target_occupied),
                        execution_enabled=self._execution_enabled,
                        in_scope=in_scope,
                        now=_require_aware_datetime(now or datetime.now(UTC)),
                    ),
                )
                assert projected.actions is not None
                actions = projected.actions
                if (
                    run.kind is RunKind.REPAIR
                    and run.status is RunStatus.WAITING_APPROVAL
                ):
                    actions = actions.model_copy(
                        update={
                            "withdraw": None
                            if owns_run(run, requester)
                            else "not_owner"
                        }
                    )
                if requester is None:
                    actions = actions.model_copy(
                        update={
                            name: "authentication_required"
                            for name in (
                                "prepare",
                                "refresh",
                                "edit",
                                "approve",
                                "reject",
                                "rerun",
                                "rollback",
                                "withdraw",
                            )
                            if getattr(actions, name) != "not_applicable"
                        }
                    )
                return replace(projected, actions=actions)
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def list_run_records(
        self,
        incident_id: UUID,
        *,
        limit: int,
        before_attempt: int | None,
        requester: OperatorSession | None = None,
        mine: bool = False,
    ) -> RunListPage | None:
        if limit < 1 or limit > 50:
            raise ValueError("Run list limit must be between 1 and 50")
        if before_attempt is not None and before_attempt < 1:
            raise ValueError("Run cursor attempt must be positive")
        try:
            async with self._session_factory() as session:
                await session.execute(text("BEGIN"))
                incident = await session.get(IncidentRow, str(incident_id))
                if incident is None:
                    return None
                statement = select(RunRow).where(RunRow.incident_id == incident.id)
                if mine:
                    if requester is not None:
                        statement = statement.where(
                            RunRow.request_source == "operator",
                            RunRow.operator_ref == requester.operator_ref,
                        )
                    else:
                        return RunListPage(items=(), has_more=False)
                if before_attempt is not None:
                    statement = statement.where(RunRow.attempt < before_attempt)
                runs = list(
                    await session.scalars(
                        statement.order_by(RunRow.attempt.desc()).limit(limit + 1)
                    )
                )
                details = [
                    replace(
                        await _run_detail_from_row(session, incident, run),
                        initiated_by_you=owns_run(run, requester),
                    )
                    for run in runs[:limit]
                ]
                return RunListPage(
                    items=tuple(details),
                    has_more=len(runs) > limit,
                )
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def list_run_events(
        self,
        incident_id: UUID,
        run_id: UUID,
        *,
        limit: int,
        before_event_id: int | None,
    ) -> RunEventPage:
        if limit < 1 or limit > 100:
            raise ValueError("Event history limit must be between 1 and 100")
        if before_event_id is not None and before_event_id <= 0:
            raise ValueError("Event history cursor must be positive")
        try:
            async with self._session_factory() as session:
                run = await session.get(RunRow, str(run_id))
                if run is None or run.incident_id != str(incident_id):
                    raise RunNotFoundRepositoryError
                statement = select(RunEventRow).where(RunEventRow.run_id == run.id)
                if before_event_id is not None:
                    statement = statement.where(RunEventRow.id < before_event_id)
                rows = list(
                    await session.scalars(
                        statement.order_by(RunEventRow.id.desc()).limit(limit + 1)
                    )
                )
                return RunEventPage(
                    items=tuple(
                        _event_from_row(row, expected_incident_id=incident_id)
                        for row in rows[:limit]
                    ),
                    has_more=len(rows) > limit,
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
                await session.execute(text("BEGIN"))
                rows = await _load_workflow_rows(session, run_id)
                return _workflow_run_snapshot(
                    rows.run,
                    rows.incident,
                    rows.alert_signal,
                    rows.diagnosis,
                    rows.start_event,
                    rows.terminal_event,
                    rows.repair_proposal,
                    rows.repair,
                    rows.managed_events,
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
                    .where(
                        RunRow.status.in_(_ACTIVE_RUN_STATUSES),
                    )
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
                active_run = exists().where(
                    RunRow.incident_id == IncidentRow.id,
                    RunRow.status.in_(_ACTIVE_RUN_STATUSES),
                )
                occupied = exists().where(
                    ExecutionRow.run_id == RunRow.id,
                    RunRow.incident_id == IncidentRow.id,
                    ExecutionRow.target_released_at.is_(None),
                )
                incidents = list(
                    await session.scalars(
                        select(IncidentRow)
                        .where(
                            IncidentRow.updated_at < cutoff,
                            ~active_run,
                            ~occupied,
                        )
                        .order_by(IncidentRow.updated_at, IncidentRow.id)
                    )
                )
                return tuple(
                    [
                        await _prune_target_from_incident(
                            session,
                            incident,
                            artifact_root,
                        )
                        for incident in incidents
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
                incident = await session.get(IncidentRow, str(target.incident_id))
                if incident is None:
                    return False
                if _database_datetime(incident.updated_at) >= cutoff:
                    raise RecoveryConsistencyError
                current = await _prune_target_from_incident(
                    session,
                    incident,
                    artifact_root,
                )
                if current != target:
                    raise RecoveryConsistencyError

                run_ids = tuple(str(run_id) for run_id in target.run_ids)

                await _delete_exact_rows(
                    session,
                    delete(VerificationRow).where(
                        VerificationRow.execution_id.in_(
                            select(ExecutionRow.id).where(
                                ExecutionRow.run_id.in_(run_ids)
                            )
                        )
                    ),
                    target.verification_rows,
                )
                await _delete_exact_rows(
                    session,
                    delete(ExecutionRow).where(ExecutionRow.run_id.in_(run_ids)),
                    target.execution_rows,
                )
                await _delete_exact_rows(
                    session,
                    delete(ApprovalRow).where(ApprovalRow.run_id.in_(run_ids)),
                    target.approval_rows,
                )

                await _delete_exact_rows(
                    session,
                    delete(RunEventRow).where(RunEventRow.run_id.in_(run_ids)),
                    target.event_rows,
                )
                await _delete_exact_rows(
                    session,
                    delete(EvidenceRow).where(EvidenceRow.run_id.in_(run_ids)),
                    target.evidence_rows,
                )
                await _delete_exact_rows(
                    session,
                    delete(RepairProposalRow).where(
                        RepairProposalRow.run_id.in_(run_ids)
                    ),
                    target.repair_proposal_rows,
                )
                await _delete_exact_rows(
                    session,
                    delete(DiagnosisRow).where(DiagnosisRow.run_id.in_(run_ids)),
                    target.diagnosis_rows,
                )
                await _delete_exact_rows(
                    session,
                    delete(AlertSignalRow).where(
                        AlertSignalRow.incident_id == str(target.incident_id)
                    ),
                    target.alert_signal_rows,
                )
                await _delete_exact_rows(
                    session,
                    delete(RunRow).where(RunRow.id.in_(run_ids)),
                    target.run_rows,
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

    async def get_diagnosis_validation_snapshot(
        self,
        run_id: UUID,
    ) -> DiagnosisValidationSnapshot:
        try:
            async with self._session_factory() as session:
                run, incident = await _load_run_context(session, run_id)
                _require_active_run(run, incident)
                if run.kind is not RunKind.DIAGNOSIS:
                    raise RecoveryConsistencyError
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
        call_identity: dict[str, JsonValue] | None = None,
    ) -> PersistedEvidence | ToolFailureRecord | None:
        try:
            normalized_identity = normalize_diagnostic_tool_call_identity(
                tool_name,
                call_identity,
            )
        except ValueError:
            raise RecoveryConsistencyError from None
        try:
            async with self._session_factory() as session:
                run, incident = await _load_run_context(session, run_id)
                incident_id = UUID(incident.id)
                evidence = await _evidence_by_tool_call(session, run_id, tool_call_id)
                failure = await _event_by_key(
                    session, run_id, f"tool:{tool_call_id}:failed"
                )
                if evidence is None and failure is None:
                    return None
                if evidence is not None and failure is not None:
                    raise RecoveryConsistencyError

                started_event = await _require_matching_tool_started(
                    session,
                    incident_id,
                    run_id,
                    tool_call_id,
                    tool_name,
                    normalized_identity,
                    run.kind,
                )

                if evidence is not None:
                    outcome = await _existing_evidence_outcome(
                        session,
                        evidence,
                        incident_id,
                        run_id,
                        tool_call_id,
                        tool_name,
                        run.kind,
                    )
                    if started_event.id >= outcome.event.id:
                        raise RecoveryConsistencyError
                    return outcome
                failure_row = cast(RunEventRow, failure)
                if started_event.id >= failure_row.id:
                    raise RecoveryConsistencyError
                return _existing_failure_outcome(
                    failure_row,
                    _event_payload(failure_row),
                    incident_id,
                    run_id,
                    tool_call_id,
                    tool_name,
                    run.kind,
                )
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def create_incident_and_run(
        self,
        trigger: NormalizedIncidentTrigger,
        model: ModelSnapshot,
        budget: RunBudget,
        *,
        operator_ref: str | None = None,
        requester: OperatorSession | None = None,
    ) -> CreatedIncident:
        try:
            async with self._session_factory() as session, session.begin():
                await session.execute(text("BEGIN IMMEDIATE"))
                if requester is not None:
                    await require_operator_current(
                        session, requester, int(self._now().timestamp())
                    )
                created = await _create_initial_incident(
                    session,
                    trigger,
                    model=model,
                    budget=budget,
                )
                if operator_ref is not None:
                    run = await session.get(RunRow, str(created.run_id))
                    if run is None:
                        raise RecoveryConsistencyError
                    run.request_source, run.operator_ref = "operator", operator_ref
        except SQLAlchemyError:
            raise PersistenceOperationError from None

        await self._notify_committed_event(created.event)
        return created

    async def apply_alert_occurrences(
        self,
        occurrences: tuple[NormalizedAlertOccurrence, ...],
        model: ModelSnapshot | None,
        budget: RunBudget,
        *,
        watchdog_received_at: datetime | None = None,
    ) -> PersistedAlertBatch:
        normalized_watchdog = (
            _require_aware_datetime(watchdog_received_at)
            if watchdog_received_at is not None
            else None
        )
        result = await _execute_with_replay(
            lambda: self._apply_alert_occurrences_once(
                occurrences,
                model,
                budget,
                normalized_watchdog,
            ),
            lambda: self._apply_alert_occurrences_once(
                occurrences,
                model,
                budget,
                normalized_watchdog,
            ),
        )
        for event in result.events:
            await self._notify_committed_event(event)
        return result

    async def _apply_alert_occurrences_once(
        self,
        occurrences: tuple[NormalizedAlertOccurrence, ...],
        model: ModelSnapshot | None,
        budget: RunBudget,
        watchdog_received_at: datetime | None,
    ) -> PersistedAlertBatch:
        created_run_ids: list[UUID] = []
        committed_events: list[RunEvent] = []
        blocked_new_firing = False
        async with self._session_factory() as session, session.begin():
            if watchdog_received_at is not None:
                await _record_watchdog_arrival(session, watchdog_received_at)
            for occurrence in occurrences:
                signal = await session.scalar(
                    select(AlertSignalRow).where(
                        AlertSignalRow.fingerprint == occurrence.fingerprint,
                        AlertSignalRow.starts_at == occurrence.starts_at,
                    )
                )
                if signal is None:
                    if occurrence.status is AlertSignalStatus.RESOLVED:
                        continue
                    if model is None:
                        blocked_new_firing = True
                        continue
                    created = await _create_alert_incident(
                        session,
                        occurrence,
                        model,
                        budget,
                    )
                    created_run_ids.append(created.run_id)
                    committed_events.append(created.event)
                    continue

                resolved_event = await _apply_existing_alert_occurrence(
                    session,
                    signal,
                    occurrence,
                )
                if resolved_event is not None:
                    committed_events.append(resolved_event)

        return PersistedAlertBatch(
            created_run_ids=tuple(created_run_ids),
            events=tuple(committed_events),
            blocked_new_firing=blocked_new_firing,
        )

    async def get_watchdog_last_received_at(self) -> datetime | None:
        try:
            async with self._session_factory() as session:
                state = await session.get(MonitoringSourceStateRow, 1)
                return (
                    None
                    if state is None
                    else _database_datetime(state.last_watchdog_received_at)
                )
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def create_run(
        self,
        incident_id: UUID,
        model: ModelSnapshot,
        budget: RunBudget,
        *,
        replaces_run_id: UUID | None = None,
        operator_ref: str | None = None,
        requester: OperatorSession | None = None,
    ) -> CreatedRun | None:
        run_id = uuid4()
        occurred_at = datetime.now(UTC)
        try:
            async with self._session_factory() as session, session.begin():
                await session.execute(text("BEGIN IMMEDIATE"))
                incident = await session.get(IncidentRow, str(incident_id))
                if incident is None:
                    return None
                if requester is not None:
                    await require_operator_current(
                        session, requester, int(self._now().timestamp())
                    )
                if replaces_run_id is not None:
                    await _replace_waiting_run(
                        session, incident, replaces_run_id, occurred_at
                    )
                await _require_no_incident_execution(session, incident.id)
                active = await session.scalar(
                    select(
                        exists().where(
                            RunRow.incident_id == incident.id,
                            RunRow.status.in_(_ACTIVE_RUN_STATUSES),
                        )
                    )
                )
                if active is not False:
                    raise ActiveRunExistsError
                max_attempt = await session.scalar(
                    select(func.max(RunRow.attempt)).where(
                        RunRow.incident_id == incident.id
                    )
                )
                if not isinstance(max_attempt, int) or max_attempt < 1:
                    raise RecoveryConsistencyError
                attempt = max_attempt + 1
                run_row = _new_run_row(
                    run_id=run_id,
                    incident_id=incident_id,
                    attempt=attempt,
                    model=model,
                    budget=budget,
                    occurred_at=occurred_at,
                )
                session.add(run_row)
                run_row.request_source = "operator" if operator_ref else "system"
                run_row.operator_ref = operator_ref
                await session.flush()
                payload = _base_payload(incident_id, run_id, occurred_at)
                payload.update(
                    {
                        "attempt": attempt,
                        "runStatus": RunStatus.QUEUED.value,
                    }
                )
                event_row = _new_event_row(
                    run_id=run_id,
                    event_key="run.queued",
                    event_type="run.queued",
                    occurred_at=occurred_at,
                    payload=payload,
                )
                session.add(event_row)
                incident.updated_at = occurred_at
                await session.flush()
                event = _event_from_row(
                    event_row,
                    expected_incident_id=incident_id,
                )
        except ActiveRunExistsError:
            raise
        except IntegrityError:
            try:
                async with self._session_factory() as session:
                    active = await session.scalar(
                        select(
                            exists().where(
                                RunRow.incident_id == str(incident_id),
                                RunRow.status.in_(_ACTIVE_RUN_STATUSES),
                            )
                        )
                    )
            except SQLAlchemyError:
                raise PersistenceOperationError from None
            if active is True:
                raise ActiveRunExistsError from None
            raise PersistenceOperationError from None
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

        created = CreatedRun(run_id=run_id)
        await self._notify_committed_event(event)
        return created

    async def create_repair_run(
        self,
        incident_id: UUID,
        source_run_id: UUID,
        *,
        source_execution_id: UUID | None = None,
        selection: RepairHistorySelection | None,
        replaces_run_id: UUID | None,
        operator_ref: str | None,
        now: datetime,
        requester: OperatorSession | None = None,
    ) -> CreatedRun | None:
        now = _require_aware_datetime(now)
        run_id = uuid4()
        try:
            async with self._session_factory() as session, session.begin():
                await session.execute(text("BEGIN IMMEDIATE"))
                incident = await session.get(IncidentRow, str(incident_id))
                if incident is None:
                    return None
                if requester is not None:
                    await require_operator_current(
                        session, requester, int(self._now().timestamp())
                    )
                source = await session.get(RunRow, str(source_run_id))
                source_row = await _repair_proposal_by_run(session, source_run_id)
                if (
                    source is None
                    or source.incident_id != incident.id
                    or source_row is None
                    or source.status
                    not in (
                        RunStatus.COMPLETED,
                        RunStatus.FAILED,
                        RunStatus.WAITING_APPROVAL,
                    )
                    or (
                        source.kind is RunKind.REPAIR
                        and source.operation is not RepairOperation.APPLY
                    )
                ):
                    raise RepairSourceInvalidError
                repair = _incident_repair_detail(source_row, source_run_id)
                if repair.proposal.target != KubernetesTarget(
                    cluster=incident.cluster,
                    namespace=incident.namespace,
                    api_version=incident.api_version,
                    kind=incident.kind,
                    name=incident.resource_name,
                ):
                    raise RepairSourceInvalidError
                if source_execution_id is not None:
                    if selection is not None:
                        raise RepairSourceInvalidError
                    rollback = await _rollback_source(
                        session, source, incident, repair, source_row.validation_json
                    )
                    if rollback.execution_id != source_execution_id:
                        raise RepairSourceInvalidError
                if replaces_run_id is not None:
                    await _replace_waiting_run(session, incident, replaces_run_id, now)
                await _require_no_incident_execution(session, incident.id)
                active = await session.scalar(
                    select(
                        exists().where(
                            RunRow.incident_id == incident.id,
                            RunRow.status.in_(_ACTIVE_RUN_STATUSES),
                        )
                    )
                )
                if active is not False:
                    raise ActiveRunExistsError
                previous_attempt = await session.scalar(
                    select(func.max(RunRow.attempt)).where(
                        RunRow.incident_id == incident.id
                    )
                )
                if (
                    not isinstance(previous_attempt, int)
                    or source.attempt > previous_attempt
                ):
                    raise RecoveryConsistencyError
                run = RunRow(
                    id=str(run_id),
                    incident_id=incident.id,
                    attempt=previous_attempt + 1,
                    kind=RunKind.REPAIR,
                    operation=RepairOperation.ROLLBACK
                    if source_execution_id is not None
                    else RepairOperation.APPLY,
                    status=RunStatus.QUEUED,
                    timeout_seconds=60,
                    source_run_id=source.id,
                    request_source="operator",
                    operator_ref=operator_ref,
                    selection_revision=selection.revision if selection else None,
                    selection_replica_set_uid=selection.replica_set_uid
                    if selection
                    else None,
                    created_at=now,
                    updated_at=now,
                )
                session.add(run)
                await session.flush()
                payload = _base_payload(incident_id, run_id, now, RunKind.REPAIR)
                payload.update({"attempt": run.attempt, "runStatus": "QUEUED"})
                event_row = _new_event_row(
                    run_id=run_id,
                    event_key="run.queued",
                    event_type="run.queued",
                    occurred_at=now,
                    payload=payload,
                )
                session.add(event_row)
                incident.updated_at = now
                await session.flush()
                event = _event_from_row(event_row, expected_incident_id=incident_id)
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None
        await self._notify_committed_event(event)
        return CreatedRun(run_id=run_id)

    async def withdraw_run(
        self, incident_id: UUID, run_id: UUID, requester: OperatorSession
    ) -> None:
        async with self._session_factory.begin() as session:
            await session.execute(text("BEGIN IMMEDIATE"))
            now = self._now()
            await require_operator_current(session, requester, int(now.timestamp()))
            incident = await session.get(IncidentRow, str(incident_id))
            run = await session.get(RunRow, str(run_id))
            if (
                incident is None
                or run is None
                or run.incident_id != incident.id
                or run.status is not RunStatus.WAITING_APPROVAL
            ):
                raise ActiveRunExistsError
            if not owns_run(run, requester):
                raise RunOwnershipError
            await _require_no_incident_execution(session, incident.id)
            event = await _end_waiting_run(session, run, incident, now, "withdrawn")
            await session.flush()
            committed = _event_from_row(event, expected_incident_id=incident_id)
        await self._notify_committed_event(committed)

    async def get_repair_source_proposal(self, run_id: UUID) -> RepairProposal:
        try:
            async with self._session_factory() as session:
                run, incident = await _load_run_context(session, run_id)
                source = await _repair_source(session, run, incident)
                return source.proposal if isinstance(source, RollbackSource) else source
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def get_rollback_source(self, run_id: UUID) -> RollbackSource:
        try:
            async with self._session_factory() as session:
                await session.execute(text("BEGIN"))
                run, incident = await _load_run_context(session, run_id)
                if run.operation is not RepairOperation.ROLLBACK:
                    raise RecoveryConsistencyError
                source = await _repair_source(session, run, incident)
                if not isinstance(source, RollbackSource):
                    raise RecoveryConsistencyError
                return source
        except SQLAlchemyError:
            raise PersistenceOperationError from None

    async def persist_prepared_repair(self, prepared: PreparedRepairRecord) -> None:
        try:
            async with self._session_factory() as session, session.begin():
                await session.execute(text("BEGIN IMMEDIATE"))
                run, incident = await _load_run_context(session, prepared.run_id)
                if run.kind is not RunKind.REPAIR:
                    raise RecoveryConsistencyError
                _require_active_run(run, incident)
                if await _repair_proposal_by_run(session, prepared.run_id) is not None:
                    raise RecoveryConsistencyError
                proposal, validation = prepared.proposal, prepared.validation
                if proposal is not None and validation is not None:
                    source = (
                        await _repair_source(session, run, incident)
                        if run.operation is RepairOperation.ROLLBACK
                        else None
                    )
                    await _require_repair_evidence(
                        session,
                        run,
                        incident,
                        proposal,
                        source if isinstance(source, RollbackSource) else None,
                    )
                    session.add(
                        RepairProposalRow(
                            id=str(proposal.id),
                            run_id=run.id,
                            schema_version=proposal.schema_version,
                            proposal_json=canonical_json(
                                cast(
                                    dict[str, JsonValue],
                                    proposal.model_dump(mode="json"),
                                )
                            ),
                            validation_json=canonical_json(
                                cast(
                                    dict[str, JsonValue],
                                    validation.model_dump(mode="json"),
                                )
                            ),
                            created_at=proposal.diff_checked_at,
                        )
                    )
                    if prepared.selection is not None:
                        run.selection_revision = prepared.selection.revision
                        run.selection_replica_set_uid = (
                            prepared.selection.replica_set_uid
                        )
                run.updated_at = prepared.recorded_at
                incident.updated_at = prepared.recorded_at
                run.error_code = prepared.error_code
                run.error_retryable = prepared.error_retryable
                if prepared.error_code is None:
                    if validation is None:
                        raise RecoveryConsistencyError
                    run.status = RunStatus.WAITING_APPROVAL
                    run.waiting_expires_at = validation.checked_at + timedelta(
                        minutes=15
                    )
                    incident.status = IncidentStatus.WAITING_APPROVAL
                else:
                    run.status = RunStatus.FAILED
                    run.completed_at = prepared.recorded_at
                    incident.status = (
                        IncidentStatus.STALE_RESOURCE
                        if prepared.error_code == "stale_resource"
                        else IncidentStatus.FAILED
                    )
                events = _prepared_repair_events(prepared, UUID(incident.id))
                session.add_all(events)
                await session.flush()
                event = _event_from_row(
                    events[-1], expected_incident_id=UUID(incident.id)
                )
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None
        await self._notify_committed_event(event)

    async def fail_repair_run(
        self,
        run_id: UUID,
        code: str,
        retryable: bool,
        now: datetime,
    ) -> None:
        try:
            async with self._session_factory() as session, session.begin():
                await session.execute(text("BEGIN IMMEDIATE"))
                run, incident = await _load_run_context(session, run_id)
                if (
                    run.kind is not RunKind.REPAIR
                    or run.status not in _ACTIVE_RUN_STATUSES
                ):
                    return
                if (
                    await session.scalar(
                        select(ApprovalRow.id).where(ApprovalRow.run_id == run.id)
                    )
                    is not None
                ):
                    return
                run.status = RunStatus.FAILED
                run.error_code, run.error_retryable = code, retryable
                run.completed_at = run.updated_at = now
                incident.status = IncidentStatus.FAILED
                incident.updated_at = now
                payload = _base_payload(UUID(incident.id), run_id, now, RunKind.REPAIR)
                payload.update(
                    {
                        "errorCode": code,
                        "retryable": retryable,
                        "incidentStatus": "FAILED",
                        "runStatus": "FAILED",
                    }
                )
                event_row = _new_event_row(
                    run_id=run_id,
                    event_key="run:terminal",
                    event_type="run.failed",
                    occurred_at=now,
                    payload=payload,
                )
                session.add(event_row)
                await session.flush()
                event = _event_from_row(
                    event_row, expected_incident_id=UUID(incident.id)
                )
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None
        await self._notify_committed_event(event)

    async def decide_approval(
        self,
        incident_id: UUID,
        run_id: UUID,
        proposal_id: UUID,
        proposal_digest: str,
        decision: ApprovalDecision,
        *,
        operator_ref: str,
        operator_token_hash: str,
        now: Callable[[], datetime],
    ) -> IncidentRepairDetail:
        if not self._execution_enabled:
            raise ExecutionDisabledError
        try:
            async with self._session_factory() as session, session.begin():
                await session.execute(text("BEGIN IMMEDIATE"))
                decided_at = _require_aware_datetime(now())
                principal = await session.get(OperatorSessionRow, operator_token_hash)
                if (
                    principal is None
                    or principal.revoked
                    or principal.expires_at <= decided_at.timestamp()
                    or principal.operator_ref != operator_ref
                ):
                    raise OperatorAuthenticationError
                run = await session.get(RunRow, str(run_id))
                if run is None or run.incident_id != str(incident_id):
                    raise ApprovalConflictError
                rows = await _load_workflow_rows(session, run_id)
                snapshot = _workflow_run_snapshot(
                    rows.run,
                    rows.incident,
                    rows.alert_signal,
                    rows.diagnosis,
                    rows.start_event,
                    rows.terminal_event,
                    rows.repair_proposal,
                    rows.repair,
                    rows.managed_events,
                )
                repair = rows.repair
                if (
                    not isinstance(snapshot, RepairWorkflowRunSnapshot)
                    or repair is None
                    or rows.repair_proposal is None
                    or repair.proposal.id != proposal_id
                    or repair.proposal.digest != proposal_digest
                ):
                    raise ApprovalConflictError
                if repair.approval is not None:
                    if repair.approval.decision != decision:
                        raise ApprovalConflictError
                    return repair
                self._require_execution_scope(repair.proposal)
                if (
                    snapshot.run_status is not RunStatus.WAITING_APPROVAL
                    or snapshot.waiting_expires_at is None
                    or not repair.validation.checked_at
                    <= decided_at
                    < snapshot.waiting_expires_at
                    or repair.validation.outcome != "passed"
                ):
                    raise ApprovalConflictError
                approval = ApprovalRecord(
                    id=uuid4(),
                    run_id=run_id,
                    proposal_id=proposal_id,
                    proposal_digest=proposal_digest,
                    validation_digest=_validation_digest(
                        rows.repair_proposal.validation_json
                    ),
                    decision=decision,
                    actor=operator_ref,
                    decided_at=decided_at,
                    expires_at=snapshot.waiting_expires_at,
                )
                session.add(
                    ApprovalRow(
                        **{
                            **approval.model_dump(),
                            "id": str(approval.id),
                            "run_id": str(run_id),
                            "proposal_id": str(proposal_id),
                        }
                    )
                )
                await session.flush()
                execution: ExecutionRecord | None = None
                if decision == "approve":
                    target = repair.proposal.target
                    execution_row = ExecutionRow(
                        id=str(uuid4()),
                        approval_id=str(approval.id),
                        run_id=str(run_id),
                        cluster=target.cluster,
                        namespace=target.namespace,
                        kind=target.kind,
                        resource_name=target.name,
                        status="PENDING",
                        start_before=min(
                            decided_at + timedelta(seconds=30), approval.expires_at
                        ),
                    )
                    session.add(execution_row)
                    run.status = RunStatus.RUNNING
                    rows.incident.status = IncidentStatus.APPLYING
                    await session.flush()
                    execution = _execution_record(execution_row)
                else:
                    run.status = RunStatus.COMPLETED
                    run.end_reason = "rejected"
                    run.completed_at = decided_at
                    rows.incident.status = IncidentStatus.REJECTED
                run.updated_at = rows.incident.updated_at = decided_at
                payload = _base_payload(incident_id, run_id, decided_at, RunKind.REPAIR)
                payload.update(
                    {
                        "approvalId": str(approval.id),
                        "proposalId": str(proposal_id),
                        "proposalDigest": proposal_digest,
                        "decision": decision,
                        "runStatus": run.status.value,
                        "incidentStatus": rows.incident.status.value,
                    }
                )
                event_row = _new_event_row(
                    run_id=run_id,
                    event_key="repair.approval_decided"
                    if decision == "approve"
                    else "run:terminal",
                    event_type="repair.approval_decided",
                    occurred_at=decided_at,
                    payload=payload,
                )
                session.add(event_row)
                await session.flush()
                event = _event_from_row(event_row, expected_incident_id=incident_id)
                result = replace(repair, approval=approval, execution=execution)
        except IntegrityError:
            raise ApprovalConflictError from None
        except SQLAlchemyError:
            raise PersistenceOperationError from None
        await self._notify_committed_event(event)
        return result

    def _require_execution_scope(self, proposal: RepairProposal) -> None:
        target = proposal.target
        if (
            target.cluster != self._execution_cluster
            or target.namespace != "k8s-incident-scenarios"
            or target.api_version != "apps/v1"
            or target.kind != "Deployment"
        ):
            raise ApprovalConflictError

    async def claim_execution(
        self, *, now: Callable[[], datetime]
    ) -> ExecutionCommand | None:
        if not self._execution_enabled:
            return None
        command: ExecutionCommand | None = None
        event: RunEvent | None = None
        try:
            async with self._session_factory() as session, session.begin():
                await session.execute(text("BEGIN IMMEDIATE"))
                claimed_at = _require_aware_datetime(now())
                execution = await session.scalar(
                    select(ExecutionRow)
                    .where(ExecutionRow.status == "PENDING")
                    .order_by(ExecutionRow.start_before, ExecutionRow.id)
                    .limit(1)
                )
                if execution is None:
                    return None
                rows = await _load_workflow_rows(session, UUID(execution.run_id))
                repair = rows.repair
                if repair is None or repair.approval is None:
                    raise RecoveryConsistencyError
                self._require_execution_scope(repair.proposal)
                if claimed_at < repair.approval.decided_at:
                    raise RecoveryConsistencyError
                if claimed_at >= _database_datetime(execution.start_before):
                    event = await _advance_execution(
                        session, rows, execution, "EXPIRED", claimed_at
                    )
                else:
                    execution.claimed_at = claimed_at
                    event = await _advance_execution(
                        session, rows, execution, "CLAIMED", claimed_at
                    )
                    command = ExecutionCommand(
                        execution_id=UUID(execution.id),
                        approval=repair.approval,
                        change=repair.proposal.change,
                        validation=repair.validation,
                        start_before=_database_datetime(execution.start_before),
                    )
        except SQLAlchemyError:
            raise PersistenceOperationError from None
        await self._notify_committed_event(event)
        # A command may only escape after COMMIT. Cancellation cannot make it claimable again.
        return command

    async def report_execution(
        self,
        execution_id: UUID,
        result: ExecutionResult,
        *,
        now: Callable[[], datetime],
    ) -> ExecutionRecord:
        events: list[RunEvent] = []
        try:
            async with self._session_factory() as session, session.begin():
                await session.execute(text("BEGIN IMMEDIATE"))
                reported_at = _require_aware_datetime(now())
                execution = await session.get(ExecutionRow, str(execution_id))
                if execution is None or execution.claimed_at is None:
                    raise ExecutionReportConflictError
                if reported_at < _database_datetime(execution.claimed_at):
                    raise ExecutionReportConflictError
                rows = await _load_workflow_rows(session, UUID(execution.run_id))
                if rows.repair is None:
                    raise RecoveryConsistencyError
                if (
                    result.receipt is not None
                    and result.receipt.uid != rows.repair.proposal.target_uid
                ):
                    raise ExecutionReportConflictError
                encoded = canonical_json(
                    cast(dict[str, JsonValue], result.model_dump(mode="json"))
                )
                if encoded in (execution.result_json, execution.late_result_json):
                    return _execution_record(execution)
                became_unknown = (
                    execution.status == "CLAIMED"
                    and reported_at
                    > _database_datetime(execution.start_before) + timedelta(seconds=10)
                )
                if became_unknown:
                    events.append(
                        await _advance_execution(
                            session, rows, execution, "UNKNOWN", reported_at
                        )
                    )
                if execution.status == "UNKNOWN":
                    if (became_unknown and result.outcome != "APPLIED") or (
                        result.outcome == "UNKNOWN" and execution.result_json is None
                    ):
                        execution.result_json = encoded
                        execution.reported_at = reported_at
                    elif (
                        result.outcome != "APPLIED"
                        or execution.late_result_json is not None
                    ):
                        raise ExecutionReportConflictError
                    else:
                        execution.late_result_json = encoded
                        execution.reported_at = reported_at
                        events.append(
                            await _advance_execution(
                                session,
                                rows,
                                execution,
                                "UNKNOWN",
                                reported_at,
                                late=True,
                            )
                        )
                elif execution.status != "CLAIMED" or execution.result_json is not None:
                    raise ExecutionReportConflictError
                else:
                    execution.result_json = encoded
                    execution.reported_at = reported_at
                    events.append(
                        await _advance_execution(
                            session, rows, execution, result.outcome, reported_at
                        )
                    )
                persisted = _execution_record(execution)
        except SQLAlchemyError:
            raise PersistenceOperationError from None
        for event in events:
            await self._notify_committed_event(event)
        return persisted

    async def get_verification_context(
        self, run_id: UUID
    ) -> RepairVerificationContext | None:
        try:
            async with self._session_factory() as session, session.begin():
                await session.execute(text("BEGIN IMMEDIATE"))
                rows = await _load_workflow_rows(session, run_id)
                repair = rows.repair
                execution = repair.execution if repair else None
                if (
                    repair is None
                    or execution is None
                    or execution.status != "APPLIED"
                    or rows.run.status is not RunStatus.RUNNING
                ):
                    return None
                if (
                    execution.reported_at is None
                    or execution.result is None
                    or execution.result.receipt is None
                ):
                    raise RecoveryConsistencyError
                record = repair.verification
                if record is None:
                    record = VerificationRecord(
                        execution_id=execution.id,
                        started_at=execution.reported_at,
                        deadline_at=execution.reported_at + timedelta(minutes=10),
                    )
                    session.add(
                        VerificationRow(
                            execution_id=str(execution.id),
                            record_json=record.model_dump_json(),
                        )
                    )
                previous = None
                if record.sample_count:
                    evidence = await _evidence_by_tool_call(
                        session,
                        run_id,
                        verification_sample_key(execution.id, record.sample_count),
                    )
                    if (
                        evidence is None
                        or evidence.evidence_kind != "recovery_observation"
                    ):
                        raise RecoveryConsistencyError
                    previous = VerificationObservation.model_validate_json(
                        evidence.payload_json
                    )
                    if previous.observed_at != record.last_observed_at:
                        raise RecoveryConsistencyError
                signal = await session.get(AlertSignalRow, rows.incident.id)
                watchdog = await session.get(MonitoringSourceStateRow, 1)
                return RepairVerificationContext(
                    record,
                    repair.proposal,
                    execution.result.receipt,
                    previous,
                    signal.status is AlertSignalStatus.RESOLVED
                    if signal is not None
                    else (
                        False
                        if rows.incident.trigger_source == "alertmanager"
                        else None
                    ),
                    _database_datetime(watchdog.last_watchdog_received_at)
                    if watchdog is not None
                    else None,
                )
        except SQLAlchemyError:
            raise PersistenceOperationError from None
        except (ValueError, TypeError):
            raise RecoveryConsistencyError from None

    async def persist_verification(
        self,
        run_id: UUID,
        expected: VerificationRecord,
        updated: VerificationRecord,
        observation: VerificationObservation | None,
    ) -> None:
        events: list[RunEvent] = []
        try:
            async with self._session_factory() as session, session.begin():
                await session.execute(text("BEGIN IMMEDIATE"))
                rows = await _load_workflow_rows(session, run_id)
                if rows.repair is None or rows.repair.verification is None:
                    raise RecoveryConsistencyError
                if rows.repair.verification == updated:
                    return
                if (
                    rows.repair.verification != expected
                    or expected.outcome != "observing"
                    or updated.execution_id != expected.execution_id
                    or updated.started_at != expected.started_at
                    or updated.deadline_at != expected.deadline_at
                    or updated.sample_count
                    != expected.sample_count + (observation is not None)
                ):
                    raise RecoveryConsistencyError
                row = await session.get(VerificationRow, str(updated.execution_id))
                execution = await session.get(ExecutionRow, str(updated.execution_id))
                if row is None or execution is None or execution.status != "APPLIED":
                    raise RecoveryConsistencyError
                at = updated.completed_at or updated.last_observed_at
                if at is None:
                    raise RecoveryConsistencyError
                if observation is not None:
                    encoded = canonical_json(
                        cast(
                            dict[str, JsonValue],
                            observation.model_dump(mode="json", by_alias=True),
                        )
                    )
                    if (
                        len(encoded.encode()) > MAX_OBSERVATION_BYTES
                        or observation.observed_at != updated.last_observed_at
                    ):
                        raise RecoveryConsistencyError
                    key = verification_sample_key(
                        updated.execution_id, updated.sample_count
                    )
                    target = rows.repair.proposal.target
                    evidence_row = EvidenceRow(
                        id=str(evidence_id(run_id, key)),
                        run_id=str(run_id),
                        tool_call_id=key,
                        tool_name="verify_recovery",
                        evidence_kind="recovery_observation",
                        target_ref_json=canonical_json(
                            cast(
                                dict[str, JsonValue],
                                target.model_dump(mode="json", by_alias=True),
                            )
                        ),
                        observed_at=observation.observed_at,
                        payload_json=encoded,
                        truncated=observation.logs.truncated
                        if observation.logs
                        else False,
                        redacted=observation.logs.redacted
                        if observation.logs
                        else False,
                    )
                    event = _new_event_row(
                        run_id=run_id,
                        event_key=f"tool:{key}:evidence",
                        event_type="evidence.recorded",
                        occurred_at=at,
                        payload=_evidence_event_payload(
                            evidence_row,
                            UUID(rows.incident.id),
                            run_id,
                            at,
                            RunKind.REPAIR,
                        ),
                    )
                    session.add_all((evidence_row, event))
                    await session.flush()
                    events.append(
                        _event_from_row(
                            event, expected_incident_id=UUID(rows.incident.id)
                        )
                    )
                row.record_json = updated.model_dump_json()
                if updated.outcome != "observing":
                    rolled_back = rows.run.operation is RepairOperation.ROLLBACK
                    completed = rolled_back or updated.outcome == "recovered"
                    rows.run.status = (
                        RunStatus.COMPLETED if completed else RunStatus.FAILED
                    )
                    rows.run.completed_at = updated.completed_at
                    rows.run.error_code = (
                        None if completed else f"verification_{updated.outcome}"
                    )
                    rows.run.error_retryable = None if completed else False
                    rows.incident.status = (
                        IncidentStatus.ROLLED_BACK
                        if rolled_back
                        else IncidentStatus.RESOLVED
                        if updated.outcome == "recovered"
                        else IncidentStatus.FAILED
                    )
                    execution.target_released_at = updated.completed_at
                rows.run.updated_at = rows.incident.updated_at = at
                payload = _base_payload(
                    UUID(rows.incident.id), run_id, at, RunKind.REPAIR
                )
                payload.update(
                    {
                        "executionId": str(updated.execution_id),
                        "outcome": updated.outcome,
                        "reason": updated.reason,
                        "sampleCount": updated.sample_count,
                        "runStatus": rows.run.status.value,
                        "incidentStatus": rows.incident.status.value,
                    }
                )
                event = _new_event_row(
                    run_id=run_id,
                    event_key="run:terminal"
                    if updated.outcome != "observing"
                    else f"verification:{updated.sample_count}",
                    event_type="repair.verification_updated",
                    occurred_at=at,
                    payload=payload,
                )
                session.add(event)
                await session.flush()
                events.append(
                    _event_from_row(event, expected_incident_id=UUID(rows.incident.id))
                )
        except SQLAlchemyError:
            raise PersistenceOperationError from None
        for event in events:
            await self._notify_committed_event(event)

    async def reconcile_executions(self, now: datetime) -> None:
        events: list[RunEvent] = []
        try:
            async with self._session_factory() as session, session.begin():
                await session.execute(text("BEGIN IMMEDIATE"))
                executions = await session.scalars(
                    select(ExecutionRow)
                    .where(
                        or_(
                            and_(
                                ExecutionRow.status == "PENDING",
                                ExecutionRow.start_before <= now,
                            ),
                            and_(
                                ExecutionRow.status == "CLAIMED",
                                ExecutionRow.start_before < now - timedelta(seconds=10),
                            ),
                        )
                    )
                    .order_by(ExecutionRow.start_before, ExecutionRow.id)
                    .limit(100)
                )
                for execution in executions:
                    rows = await _load_workflow_rows(session, UUID(execution.run_id))
                    events.append(
                        await _advance_execution(
                            session,
                            rows,
                            execution,
                            "EXPIRED" if execution.status == "PENDING" else "UNKNOWN",
                            now,
                        )
                    )
        except SQLAlchemyError:
            raise PersistenceOperationError from None
        for event in events:
            await self._notify_committed_event(event)

    async def expire_waiting_repairs(self, now: datetime) -> None:
        try:
            async with self._session_factory() as session, session.begin():
                await session.execute(text("BEGIN IMMEDIATE"))
                runs = await session.scalars(
                    select(RunRow)
                    .where(
                        RunRow.kind == RunKind.REPAIR,
                        RunRow.status == RunStatus.WAITING_APPROVAL,
                        RunRow.waiting_expires_at <= now,
                    )
                    .order_by(RunRow.waiting_expires_at, RunRow.id)
                    .limit(100)
                )
                events: list[RunEvent] = []
                for run in runs:
                    incident = await session.get(IncidentRow, run.incident_id)
                    if incident is None:
                        raise RecoveryConsistencyError
                    event_row = await _end_waiting_run(
                        session, run, incident, now, "expired"
                    )
                    await session.flush()
                    events.append(
                        _event_from_row(
                            event_row, expected_incident_id=UUID(incident.id)
                        )
                    )
        except RepositoryError:
            raise
        except SQLAlchemyError:
            raise PersistenceOperationError from None
        for event in events:
            await self._notify_committed_event(event)

    async def start_run(self, run_id: UUID, started_at: datetime) -> RunRecord:
        started_at = _require_aware_datetime(started_at)
        result = await _execute_with_replay(
            lambda: self._start_run_once(run_id, started_at),
            lambda: self._replay_start_run(run_id, started_at),
        )
        await self._notify_committed_event(result.event)
        return result

    async def _start_run_once(self, run_id: UUID, started_at: datetime) -> RunRecord:
        async with self._session_factory() as session, session.begin():
            run, incident = await _load_run_context(session, run_id)
            incident_id = UUID(incident.id)
            existing = await _event_by_key(session, run_id, "run.started")
            if existing is not None:
                return _replayed_start(run, incident, existing, started_at)

            target_status = (
                IncidentStatus.TRIAGING
                if run.kind is RunKind.DIAGNOSIS
                else IncidentStatus.PATCH_READY
            )
            if run.kind is RunKind.DIAGNOSIS:
                _require_incident_transition(incident.status, target_status)
            _require_run_transition(run.status, RunStatus.RUNNING)
            incident.status = target_status
            incident.updated_at = started_at
            run.status = RunStatus.RUNNING
            run.started_at = started_at
            run.updated_at = started_at
            event_row = _new_event_row(
                run_id=run_id,
                event_key="run.started",
                event_type="run.started",
                occurred_at=started_at,
                payload=_run_started_event_payload(
                    incident_id,
                    run_id,
                    run.attempt,
                    started_at,
                    run.kind,
                ),
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
        call_identity: dict[str, JsonValue] | None = None,
    ) -> RunEvent:
        try:
            normalized_identity = normalize_diagnostic_tool_call_identity(
                tool_name,
                call_identity,
            )
        except ValueError:
            raise RecoveryConsistencyError from None
        result = await _execute_with_replay(
            lambda: self._record_tool_started_once(
                run_id,
                tool_call_id,
                tool_name,
                normalized_identity,
            ),
            lambda: self._replay_tool_started(
                run_id,
                tool_call_id,
                tool_name,
                normalized_identity,
            ),
        )
        await self._notify_committed_event(result)
        return result

    async def _record_tool_started_once(
        self,
        run_id: UUID,
        tool_call_id: str,
        tool_name: str,
        call_identity: dict[str, JsonValue] | None,
    ) -> RunEvent:
        event_key = f"tool:{tool_call_id}:started"
        async with self._session_factory() as session, session.begin():
            # Parallel tool calls in one model batch must see each other's start
            # rows, so the observation count is taken under the write lock.
            await session.execute(text("BEGIN IMMEDIATE"))
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
                    call_identity,
                    run.kind,
                )
                return _event_from_row(
                    existing,
                    expected_incident_id=incident_id,
                )
            _require_active_run(run, incident)
            if run.kind is RunKind.DIAGNOSIS:
                await _require_observation_capacity(
                    session, run_id, tool_name, call_identity
                )
            occurred_at = datetime.now(UTC)
            event_row = _new_event_row(
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
                    call_identity,
                    run.kind,
                ),
            )
            session.add(event_row)
            await session.flush()
            return _event_from_row(
                event_row,
                expected_incident_id=incident_id,
            )

    async def _replay_tool_started(
        self,
        run_id: UUID,
        tool_call_id: str,
        tool_name: str,
        call_identity: dict[str, JsonValue] | None,
    ) -> RunEvent:
        async with self._session_factory() as session:
            run, incident = await _load_run_context(session, run_id)
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
                call_identity,
                run.kind,
            )
            return _event_from_row(
                event_row,
                expected_incident_id=UUID(incident.id),
            )

    async def record_evidence(self, evidence: EvidenceRecord) -> PersistedEvidence:
        normalized = replace(
            evidence,
            observed_at=_require_aware_datetime(evidence.observed_at),
        )
        result = await _execute_with_replay(
            lambda: self._record_evidence_once(normalized),
            lambda: self._replay_evidence(normalized),
        )
        await self._notify_committed_event(result.event)
        return result

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
                    run.kind,
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
                run_id=evidence.run_id,
                event_key=f"tool:{evidence.tool_call_id}:evidence",
                event_type="evidence.recorded",
                occurred_at=occurred_at,
                payload=_evidence_event_payload(
                    evidence_row,
                    incident_id,
                    evidence.run_id,
                    occurred_at,
                    run.kind,
                ),
            )
            session.add_all((evidence_row, event_row))
            await session.flush()
            return _persisted_evidence(evidence_row, event_row, incident_id)

    async def _replay_evidence(self, evidence: EvidenceRecord) -> PersistedEvidence:
        async with self._session_factory() as session:
            run, incident = await _load_run_context(session, evidence.run_id)
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
                run.kind,
            )

    async def record_tool_failure(self, failure: ToolFailureRecord) -> RunEvent:
        normalized = replace(
            failure,
            occurred_at=_require_aware_datetime(failure.occurred_at),
        )
        result = await _execute_with_replay(
            lambda: self._record_tool_failure_once(normalized),
            lambda: self._replay_tool_failure(normalized),
        )
        await self._notify_committed_event(result)
        return result

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
                    run.kind,
                )
            _require_active_run(run, incident)
            event_row = _new_event_row(
                run_id=failure.run_id,
                event_key=event_key,
                event_type="tool.failed",
                occurred_at=failure.occurred_at,
                payload=_tool_failure_event_payload(failure, incident_id, run.kind),
            )
            session.add(event_row)
            await session.flush()
            return _event_from_row(
                event_row,
                expected_incident_id=incident_id,
            )

    async def _replay_tool_failure(self, failure: ToolFailureRecord) -> RunEvent:
        async with self._session_factory() as session:
            run, incident = await _load_run_context(session, failure.run_id)
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
                run.kind,
            )

    async def persist_terminal(self, terminal: TerminalRecord) -> PersistedTerminal:
        normalized = replace(
            terminal,
            completed_at=_require_aware_datetime(terminal.completed_at),
        )
        result = await _execute_with_replay(
            lambda: self._persist_terminal_once(normalized),
            lambda: self._replay_terminal(normalized),
        )
        await self._notify_committed_event(result.event)
        return result

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
                        recommendations_json=_recommendations_json(
                            terminal.recommendations
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
                event=_event_from_row(
                    event_row,
                    expected_incident_id=incident_id,
                ),
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

    async def persist_repair_terminal(
        self,
        terminal: RepairTerminalRecord,
    ) -> PersistedTerminal:
        normalized = replace(
            terminal,
            diagnosis_completed_at=_require_aware_datetime(
                terminal.diagnosis_completed_at
            ),
            completed_at=_require_aware_datetime(terminal.completed_at),
        )
        result = await _execute_with_replay(
            lambda: self._persist_repair_terminal_once(normalized),
            lambda: self._replay_repair_terminal(normalized),
        )
        await self._notify_committed_event(result.event)
        return result

    async def _persist_repair_terminal_once(
        self,
        terminal: RepairTerminalRecord,
    ) -> PersistedTerminal:
        async with self._session_factory() as session, session.begin():
            run, incident = await _load_run_context(session, terminal.run_id)
            diagnosis = await _diagnosis_by_run(session, terminal.run_id)
            proposal = await _repair_proposal_by_run(session, terminal.run_id)
            managed_events = await _repair_managed_events(session, terminal.run_id)
            if diagnosis is not None or proposal is not None or managed_events:
                return _resolve_repair_terminal_replay(
                    terminal,
                    run,
                    incident,
                    diagnosis,
                    proposal,
                    managed_events,
                )

            _require_active_run(run, incident)
            diagnosis_id_value = diagnosis_id(terminal.run_id)
            diagnosis_terminal = _diagnosis_terminal_record(terminal)
            await _require_current_run_evidence(session, diagnosis_terminal)

            incident_target = _repair_incident_status(terminal)
            _require_repair_status_path(incident.status, terminal, incident_target)
            _require_run_transition(run.status, _repair_run_status(terminal))

            incident.status = incident_target
            incident.updated_at = terminal.completed_at
            run.status = _repair_run_status(terminal)
            run.model_calls = terminal.model_calls
            run.tool_calls = terminal.tool_calls
            run.input_tokens = terminal.input_tokens
            run.output_tokens = terminal.output_tokens
            run.error_code = terminal.error_code
            run.error_retryable = terminal.error_retryable
            run.completed_at = terminal.completed_at
            run.updated_at = terminal.completed_at

            session.add(_repair_diagnosis_row(terminal, diagnosis_id_value))
            if terminal.proposal is not None and terminal.validation is not None:
                session.add(
                    RepairProposalRow(
                        id=str(terminal.proposal.id),
                        run_id=str(terminal.run_id),
                        schema_version=terminal.proposal.schema_version,
                        proposal_json=canonical_json(
                            cast(
                                dict[str, JsonValue],
                                terminal.proposal.model_dump(mode="json"),
                            )
                        ),
                        validation_json=canonical_json(
                            cast(
                                dict[str, JsonValue],
                                terminal.validation.model_dump(mode="json"),
                            )
                        ),
                        created_at=terminal.proposal.diff_checked_at,
                    )
                )

            event_rows = [
                _new_event_row(
                    run_id=terminal.run_id,
                    event_key=event_key,
                    event_type=event_type,
                    occurred_at=occurred_at,
                    payload=payload,
                )
                for event_key, event_type, occurred_at, payload in (
                    _repair_event_documents(
                        terminal,
                        UUID(incident.id),
                        diagnosis_id_value,
                    )
                )
            ]
            session.add_all(event_rows)
            await session.flush()
            final_event = event_rows[-1]
            return PersistedTerminal(
                run_id=terminal.run_id,
                incident_status=incident_target,
                run_status=run.status,
                diagnosis_id=diagnosis_id_value,
                event=_event_from_row(
                    final_event,
                    expected_incident_id=UUID(incident.id),
                ),
            )

    async def _replay_repair_terminal(
        self,
        terminal: RepairTerminalRecord,
    ) -> PersistedTerminal:
        async with self._session_factory() as session:
            run, incident = await _load_run_context(session, terminal.run_id)
            diagnosis = await _diagnosis_by_run(session, terminal.run_id)
            proposal = await _repair_proposal_by_run(session, terminal.run_id)
            managed_events = await _repair_managed_events(session, terminal.run_id)
            return _resolve_repair_terminal_replay(
                terminal,
                run,
                incident,
                diagnosis,
                proposal,
                managed_events,
            )

    async def _notify_committed_event(self, event: RunEvent) -> None:
        if self._on_event_committed is None:
            return
        with suppress(Exception):
            await self._on_event_committed(event.incident_id)


async def _create_initial_incident(
    session: AsyncSession,
    trigger: NormalizedIncidentTrigger,
    *,
    model: ModelSnapshot,
    budget: RunBudget,
) -> CreatedIncident:
    incident_id = uuid4()
    run_id = uuid4()
    occurred_at = datetime.now(UTC)
    incident = IncidentRow(
        id=str(incident_id),
        trigger_source=trigger.source.type,
        trigger_ref=trigger.source.ref,
        trigger_revision=trigger.source.revision,
        display_name=trigger.display_name,
        trigger_summary=trigger.trigger_summary,
        cluster=trigger.target.cluster,
        namespace=trigger.target.namespace,
        api_version=trigger.target.api_version,
        kind=trigger.target.kind,
        resource_name=trigger.target.name,
        status=IncidentStatus.RECEIVED,
        created_at=occurred_at,
        updated_at=occurred_at,
    )
    session.add(incident)
    await session.flush()

    run = _new_run_row(
        run_id=run_id,
        incident_id=incident_id,
        attempt=1,
        model=model,
        budget=budget,
        occurred_at=occurred_at,
    )
    session.add(run)
    await session.flush()

    payload = _base_payload(incident_id, run_id, occurred_at)
    payload.update(
        {
            "attempt": 1,
            "incidentStatus": IncidentStatus.RECEIVED.value,
            "runStatus": RunStatus.QUEUED.value,
        }
    )
    event = _new_event_row(
        run_id=run_id,
        event_key="incident.created",
        event_type="incident.created",
        occurred_at=occurred_at,
        payload=payload,
    )
    session.add(event)
    await session.flush()
    return CreatedIncident(
        incident_id=incident_id,
        run_id=run_id,
        incident_status=IncidentStatus.RECEIVED,
        run_status=RunStatus.QUEUED,
        event=_event_from_row(event, expected_incident_id=incident_id),
    )


async def _create_alert_incident(
    session: AsyncSession,
    occurrence: NormalizedAlertOccurrence,
    model: ModelSnapshot,
    budget: RunBudget,
) -> CreatedIncident:
    if (
        occurrence.trigger.source.type != "alertmanager"
        or occurrence.status is not AlertSignalStatus.FIRING
        or occurrence.ends_at is not None
    ):
        raise RecoveryConsistencyError
    created = await _create_initial_incident(
        session,
        occurrence.trigger,
        model=model,
        budget=budget,
    )
    signal = AlertSignalRow(
        incident_id=str(created.incident_id),
        fingerprint=occurrence.fingerprint,
        starts_at=occurrence.starts_at,
        status=AlertSignalStatus.FIRING,
        ends_at=None,
    )
    session.add(signal)
    await session.flush()
    return created


async def _apply_existing_alert_occurrence(
    session: AsyncSession,
    signal: AlertSignalRow,
    occurrence: NormalizedAlertOccurrence,
) -> RunEvent | None:
    incident = await session.get(IncidentRow, signal.incident_id)
    run = await session.scalar(
        select(RunRow).where(
            RunRow.incident_id == signal.incident_id,
            RunRow.attempt == 1,
        )
    )
    if incident is None or run is None:
        raise RecoveryConsistencyError
    _require_matching_alert_occurrence(signal, incident, occurrence)

    existing_event = await _event_by_key(session, UUID(run.id), "alert.resolved")
    if signal.status is AlertSignalStatus.RESOLVED:
        if existing_event is None:
            raise RecoveryConsistencyError
        return None
    if existing_event is not None:
        raise RecoveryConsistencyError
    if occurrence.status is AlertSignalStatus.FIRING:
        incident.updated_at = datetime.now(UTC)
        await session.flush()
        return None
    if occurrence.ends_at is None:
        raise RecoveryConsistencyError

    occurred_at = datetime.now(UTC)
    incident_id = UUID(incident.id)
    run_id = UUID(run.id)
    signal.status = AlertSignalStatus.RESOLVED
    signal.ends_at = occurrence.ends_at
    incident.updated_at = occurred_at
    payload = _base_payload(incident_id, run_id, occurred_at)
    payload.update(
        {
            "alertStatus": AlertSignalStatus.RESOLVED.value,
            "endsAt": occurrence.ends_at,
        }
    )
    event = _new_event_row(
        run_id=run_id,
        event_key="alert.resolved",
        event_type="alert.resolved",
        occurred_at=occurred_at,
        payload=payload,
    )
    session.add(event)
    await session.flush()
    return _event_from_row(event, expected_incident_id=incident_id)


def _require_matching_alert_occurrence(
    signal: AlertSignalRow,
    incident: IncidentRow,
    occurrence: NormalizedAlertOccurrence,
) -> None:
    trigger = occurrence.trigger
    try:
        matches = (
            signal.fingerprint == occurrence.fingerprint
            and signal.starts_at == occurrence.starts_at
            and incident.trigger_source == "alertmanager"
            and incident.trigger_ref == trigger.source.ref
            and incident.cluster == trigger.target.cluster
            and incident.namespace == trigger.target.namespace
            and incident.api_version == trigger.target.api_version
            and incident.kind == trigger.target.kind
            and incident.resource_name == trigger.target.name
        )
    except (AttributeError, TypeError, ValueError):
        raise RecoveryConsistencyError from None
    if trigger.source.type != "alertmanager" or not matches:
        raise RecoveryConsistencyError


async def _repair_source(
    session: AsyncSession,
    run: RunRow,
    incident: IncidentRow,
) -> RepairProposal | RollbackSource:
    if run.kind is not RunKind.REPAIR or run.source_run_id is None:
        raise RecoveryConsistencyError
    source = await session.get(RunRow, run.source_run_id)
    if (
        source is None
        or source.incident_id != incident.id
        or source.attempt >= run.attempt
        or source.status not in (RunStatus.COMPLETED, RunStatus.FAILED)
        or (
            source.kind is RunKind.REPAIR
            and source.operation is not RepairOperation.APPLY
        )
    ):
        raise RecoveryConsistencyError
    row = await _repair_proposal_by_run(session, UUID(source.id))
    if row is None:
        raise RecoveryConsistencyError
    repair = _incident_repair_detail(row, UUID(source.id))
    if repair.proposal.target != KubernetesTarget(
        cluster=incident.cluster,
        namespace=incident.namespace,
        api_version=incident.api_version,
        kind=incident.kind,
        name=incident.resource_name,
    ):
        raise RecoveryConsistencyError
    if run.operation is RepairOperation.ROLLBACK:
        try:
            return await _rollback_source(
                session, source, incident, repair, row.validation_json
            )
        except RepairSourceInvalidError:
            raise RecoveryConsistencyError from None
    return repair.proposal


async def _rollback_source(
    session: AsyncSession,
    source: RunRow,
    incident: IncidentRow,
    repair: IncidentRepairDetail,
    validation_json: str,
) -> RollbackSource:
    if (
        source.incident_id != incident.id
        or source.kind is not RunKind.REPAIR
        or source.operation is not RepairOperation.APPLY
        or source.status not in (RunStatus.COMPLETED, RunStatus.FAILED)
    ):
        raise RepairSourceInvalidError
    await _require_repair_evidence(session, source, incident, repair.proposal, None)
    repair = await _load_repair_ledger(session, source, repair, validation_json)
    execution = repair.execution
    if (
        execution is None
        or execution.status != "APPLIED"
        or execution.result is None
        or execution.result.receipt is None
        or repair.proposal.change.source_execution_id is not None
    ):
        raise RepairSourceInvalidError
    return RollbackSource(repair.proposal, execution.id, execution.result.receipt)


async def _replace_waiting_run(
    session: AsyncSession,
    incident: IncidentRow,
    replaces_run_id: UUID,
    now: datetime,
) -> None:
    run = await session.get(RunRow, str(replaces_run_id))
    if (
        run is None
        or run.incident_id != incident.id
        or run.status is not RunStatus.WAITING_APPROVAL
    ):
        raise ActiveRunExistsError
    reason = (
        "expired"
        if run.waiting_expires_at is not None
        and _database_datetime(run.waiting_expires_at) <= now
        else "superseded"
    )
    await _end_waiting_run(session, run, incident, now, reason)
    await session.flush()


async def _end_waiting_run(
    session: AsyncSession,
    run: RunRow,
    incident: IncidentRow,
    now: datetime,
    reason: Literal["expired", "superseded", "withdrawn"],
) -> RunEventRow:
    rows = await _load_workflow_rows(session, UUID(run.id))
    snapshot = _workflow_run_snapshot(
        rows.run,
        rows.incident,
        rows.alert_signal,
        rows.diagnosis,
        rows.start_event,
        rows.terminal_event,
        rows.repair_proposal,
        rows.repair,
        rows.managed_events,
    )
    if (
        not isinstance(snapshot, RepairWorkflowRunSnapshot)
        or snapshot.run_status is not RunStatus.WAITING_APPROVAL
    ):
        raise RecoveryConsistencyError
    run.status = RunStatus.COMPLETED
    run.completed_at = now
    run.updated_at = now
    run.end_reason = reason
    incident.status = IncidentStatus.DIAGNOSED
    incident.updated_at = now
    payload = _base_payload(UUID(incident.id), UUID(run.id), now, RunKind.REPAIR)
    payload.update(
        {"reason": reason, "runStatus": "COMPLETED", "incidentStatus": "DIAGNOSED"}
    )
    event = _new_event_row(
        run_id=UUID(run.id),
        event_key="run:terminal",
        event_type="repair.wait_ended",
        occurred_at=now,
        payload=payload,
    )
    session.add(event)
    return event


def _prepared_repair_events(
    prepared: PreparedRepairRecord,
    incident_id: UUID,
) -> list[RunEventRow]:
    stages: list[tuple[str, datetime, dict[str, JsonValue]]] = []
    proposal, validation = prepared.proposal, prepared.validation
    if proposal is not None:
        identity: dict[str, JsonValue] = {
            "proposalId": str(proposal.id),
            "proposalDigest": proposal.digest,
        }
        stages.append(
            (
                "repair.patch_ready",
                proposal.diff_checked_at,
                {
                    **identity,
                    "incidentStatus": "PATCH_READY",
                    "runStatus": "RUNNING",
                },
            )
        )
        if validation is not None and validation.outcome == "passed":
            stages.extend(
                (
                    (
                        "repair.dry_run_passed",
                        validation.checked_at,
                        {
                            **identity,
                            "incidentStatus": "DRY_RUN_PASSED",
                            "runStatus": "RUNNING",
                        },
                    ),
                    (
                        "repair.waiting_approval",
                        prepared.recorded_at,
                        {
                            **identity,
                            "incidentStatus": "WAITING_APPROVAL",
                            "runStatus": "WAITING_APPROVAL",
                        },
                    ),
                )
            )
    if prepared.error_code is not None:
        stages.append(
            (
                "run.failed",
                prepared.recorded_at,
                {
                    "errorCode": prepared.error_code,
                    "retryable": prepared.error_retryable,
                    "incidentStatus": "STALE_RESOURCE"
                    if prepared.error_code == "stale_resource"
                    else "FAILED",
                    "runStatus": "FAILED",
                },
            )
        )
    return [
        _new_event_row(
            run_id=prepared.run_id,
            event_key="run:terminal" if name == "run.failed" else name,
            event_type=name,
            occurred_at=at,
            payload={
                **_base_payload(incident_id, prepared.run_id, at, RunKind.REPAIR),
                **data,
            },
        )
        for name, at, data in stages
    ]


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


async def _require_no_incident_execution(
    session: AsyncSession, incident_id: str
) -> None:
    occupied = await session.scalar(
        select(
            exists().where(
                ExecutionRow.run_id == RunRow.id,
                RunRow.incident_id == incident_id,
                ExecutionRow.target_released_at.is_(None),
            )
        )
    )
    if occupied:
        raise ActiveRunExistsError


def _validation_digest(validation_json: str) -> str:
    return "sha256:" + hashlib.sha256(validation_json.encode()).hexdigest()


def _approval_record(row: ApprovalRow) -> ApprovalRecord:
    try:
        return ApprovalRecord(
            id=UUID(row.id),
            run_id=UUID(row.run_id),
            proposal_id=UUID(row.proposal_id),
            proposal_digest=row.proposal_digest,
            validation_digest=row.validation_digest,
            decision=cast(ApprovalDecision, row.decision),
            actor=row.actor,
            decided_at=_database_datetime(row.decided_at),
            expires_at=_database_datetime(row.expires_at),
        )
    except (ValueError, TypeError):
        raise RecoveryConsistencyError from None


def _execution_record(row: ExecutionRow) -> ExecutionRecord:
    try:
        return ExecutionRecord(
            id=UUID(row.id),
            approval_id=UUID(row.approval_id),
            status=cast(ExecutionStatus, row.status),
            start_before=_database_datetime(row.start_before),
            claimed_at=_database_datetime(row.claimed_at) if row.claimed_at else None,
            reported_at=_database_datetime(row.reported_at)
            if row.reported_at
            else None,
            result=ExecutionResult.model_validate_json(row.result_json)
            if row.result_json
            else None,
            late_result=ExecutionResult.model_validate_json(row.late_result_json)
            if row.late_result_json
            else None,
        )
    except (ValueError, TypeError):
        raise RecoveryConsistencyError from None


async def _load_repair_ledger(
    session: AsyncSession,
    run: RunRow,
    repair: IncidentRepairDetail,
    validation_json: str,
) -> IncidentRepairDetail:
    approval_row = await session.scalar(
        select(ApprovalRow).where(ApprovalRow.run_id == run.id)
    )
    execution_row = await session.scalar(
        select(ExecutionRow).where(ExecutionRow.run_id == run.id)
    )
    if approval_row is None:
        if execution_row is not None:
            raise RecoveryConsistencyError
        return repair
    approval = _approval_record(approval_row)
    proposal, validation = repair.proposal, repair.validation
    if (
        approval.proposal_id != proposal.id
        or approval.proposal_digest != proposal.digest
        or approval.validation_digest != _validation_digest(validation_json)
        or validation.outcome != "passed"
        or not validation.checked_at <= approval.decided_at < approval.expires_at
        or approval.expires_at != validation.checked_at + timedelta(minutes=15)
        or run.waiting_expires_at is None
        or approval.expires_at != _database_datetime(run.waiting_expires_at)
        or (approval.decision == "approve") != (execution_row is not None)
    ):
        raise RecoveryConsistencyError
    execution = _execution_record(execution_row) if execution_row is not None else None
    verification_row = (
        await session.get(VerificationRow, execution_row.id)
        if execution_row is not None
        else None
    )
    try:
        verification = (
            VerificationRecord.model_validate_json(verification_row.record_json)
            if verification_row is not None
            else None
        )
    except (ValueError, TypeError):
        raise RecoveryConsistencyError from None
    if verification is not None and (
        execution is None
        or execution.status != "APPLIED"
        or verification.execution_id != execution.id
        or verification.started_at != execution.reported_at
        or (
            verification.completed_at is not None
            and (
                run.completed_at is None
                or verification.completed_at != _database_datetime(run.completed_at)
            )
        )
        or run.error_code
        != (
            None
            if verification.outcome in ("observing", "recovered")
            or run.operation is RepairOperation.ROLLBACK
            else f"verification_{verification.outcome}"
        )
    ):
        raise RecoveryConsistencyError
    expected_release = verification.completed_at if verification else None
    if execution is not None and (
        execution.status == "EXPIRED"
        or (
            run.operation is RepairOperation.APPLY
            and execution.status in ("REJECTED", "STALE_RESOURCE")
        )
    ):
        expected_release = (
            _database_datetime(run.completed_at)
            if run.completed_at is not None
            else None
        )
    if execution_row is not None and (
        (
            _database_datetime(execution_row.target_released_at)
            if execution_row.target_released_at is not None
            else None
        )
        != expected_release
    ):
        raise RecoveryConsistencyError
    expected_run_status = (
        RunStatus.COMPLETED
        if (
            verification is not None
            and (
                verification.outcome == "recovered"
                or (
                    run.operation is RepairOperation.ROLLBACK
                    and verification.completed_at is not None
                )
            )
        )
        or approval.decision == "reject"
        or (execution is not None and execution.status == "EXPIRED")
        else RunStatus.FAILED
        if verification is not None and verification.outcome != "observing"
        else RunStatus.RUNNING
        if execution is not None
        and execution.status in ("PENDING", "CLAIMED", "APPLIED")
        else RunStatus.FAILED
    )
    if run.status is not expected_run_status:
        raise RecoveryConsistencyError
    if execution is not None and execution_row is not None:
        target = proposal.target
        if (
            execution.approval_id != approval.id
            or (
                execution_row.cluster,
                execution_row.namespace,
                execution_row.kind,
                execution_row.resource_name,
            )
            != (target.cluster, target.namespace, target.kind, target.name)
            or execution.start_before
            != min(approval.decided_at + timedelta(seconds=30), approval.expires_at)
            or (execution.status in ("PENDING", "EXPIRED"))
            != (execution.claimed_at is None)
            or (
                execution.claimed_at is not None
                and not approval.decided_at
                <= execution.claimed_at
                < execution.start_before
            )
            or (
                execution.status == "APPLIED"
                and (execution.result is None or execution.result.outcome != "APPLIED")
            )
            or (
                execution.status in ("PENDING", "CLAIMED", "EXPIRED")
                and execution.result is not None
            )
            or (
                execution.status in ("STALE_RESOURCE", "REJECTED")
                and (
                    execution.result is None
                    or execution.result.outcome != execution.status
                )
            )
            or (
                execution.late_result is not None
                and (
                    execution.status != "UNKNOWN"
                    or execution.late_result.outcome != "APPLIED"
                )
            )
            or (execution.reported_at is None)
            != (execution.result is None and execution.late_result is None)
            or any(
                result.receipt is not None and result.receipt.uid != proposal.target_uid
                for result in (execution.result, execution.late_result)
                if result is not None
            )
        ):
            raise RecoveryConsistencyError
    return replace(
        repair, approval=approval, execution=execution, verification=verification
    )


async def _advance_execution(
    session: AsyncSession,
    rows: _WorkflowRows,
    execution: ExecutionRow,
    status: ExecutionStatus,
    occurred_at: datetime,
    *,
    late: bool = False,
) -> RunEvent:
    run, incident = rows.run, rows.incident
    execution.status = status
    if not late:
        if status in ("PENDING", "CLAIMED", "APPLIED"):
            run.status = RunStatus.RUNNING
            incident.status = (
                IncidentStatus.VERIFYING
                if status == "APPLIED"
                else IncidentStatus.APPLYING
            )
        elif status == "EXPIRED":
            run.status = RunStatus.COMPLETED
            run.end_reason = "execution_expired"
            run.completed_at = occurred_at
            incident.status = IncidentStatus.DIAGNOSED
        else:
            run.status = RunStatus.FAILED
            run.error_code = (
                "execution_outcome_unknown"
                if status == "UNKNOWN"
                else (
                    "stale_resource"
                    if status == "STALE_RESOURCE"
                    else "execution_rejected"
                )
            )
            run.error_retryable = False
            run.completed_at = occurred_at
            incident.status = (
                IncidentStatus.STALE_RESOURCE
                if status == "STALE_RESOURCE"
                else IncidentStatus.FAILED
            )
        if status == "EXPIRED" or (
            run.operation is RepairOperation.APPLY
            and status in ("REJECTED", "STALE_RESOURCE")
        ):
            execution.target_released_at = occurred_at
    run.updated_at = incident.updated_at = occurred_at
    payload = _base_payload(
        UUID(incident.id), UUID(run.id), occurred_at, RunKind.REPAIR
    )
    payload.update(
        {
            "executionId": execution.id,
            "approvalId": execution.approval_id,
            "executionStatus": status,
            "lateResult": late,
            "runStatus": run.status.value,
            "incidentStatus": incident.status.value,
        }
    )
    terminal = (
        status in ("EXPIRED", "REJECTED", "STALE_RESOURCE", "UNKNOWN") and not late
    )
    event_row = _new_event_row(
        run_id=UUID(run.id),
        event_key="run:terminal"
        if terminal
        else f"execution:{execution.id}:{'late_applied' if late else status}",
        event_type="repair.execution_updated",
        occurred_at=occurred_at,
        payload=payload,
    )
    session.add(event_row)
    await session.flush()
    return _event_from_row(event_row, expected_incident_id=UUID(incident.id))


async def _load_workflow_rows(
    session: AsyncSession,
    run_id: UUID,
) -> _WorkflowRows:
    start_event_row = aliased(RunEventRow)
    diagnosis_event_row = aliased(RunEventRow)
    patch_event_row = aliased(RunEventRow)
    dry_run_event_row = aliased(RunEventRow)
    terminal_event_row = aliased(RunEventRow)
    row = (
        await session.execute(
            select(
                RunRow,
                IncidentRow,
                DiagnosisRow,
                RepairProposalRow,
                start_event_row,
                diagnosis_event_row,
                patch_event_row,
                dry_run_event_row,
                terminal_event_row,
            )
            .join(IncidentRow, IncidentRow.id == RunRow.incident_id)
            .outerjoin(DiagnosisRow, DiagnosisRow.run_id == RunRow.id)
            .outerjoin(RepairProposalRow, RepairProposalRow.run_id == RunRow.id)
            .outerjoin(
                start_event_row,
                and_(
                    start_event_row.run_id == RunRow.id,
                    start_event_row.event_key == "run.started",
                ),
            )
            .outerjoin(
                diagnosis_event_row,
                and_(
                    diagnosis_event_row.run_id == RunRow.id,
                    diagnosis_event_row.event_key == "diagnosis.completed",
                ),
            )
            .outerjoin(
                patch_event_row,
                and_(
                    patch_event_row.run_id == RunRow.id,
                    patch_event_row.event_key == "repair.patch_ready",
                ),
            )
            .outerjoin(
                dry_run_event_row,
                and_(
                    dry_run_event_row.run_id == RunRow.id,
                    dry_run_event_row.event_key == "repair.dry_run_passed",
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
    (
        run,
        incident,
        diagnosis,
        repair_proposal,
        start_event,
        diagnosis_event,
        patch_event,
        dry_run_event,
        terminal_event,
    ) = row
    repair = (
        _incident_repair_detail(repair_proposal, run_id)
        if repair_proposal is not None
        else None
    )
    source: RepairProposal | RollbackSource | None = None
    if run.kind is RunKind.REPAIR:
        source = await _repair_source(session, run, incident)
        if repair is not None and repair_proposal is not None:
            await _require_repair_evidence(
                session,
                run,
                incident,
                repair.proposal,
                source if isinstance(source, RollbackSource) else None,
            )
            repair = await _load_repair_ledger(
                session, run, repair, repair_proposal.validation_json
            )
    managed_events = tuple(
        sorted(
            (
                event
                for event in (
                    diagnosis_event,
                    patch_event,
                    dry_run_event,
                    terminal_event,
                )
                if event is not None
            ),
            key=lambda event: event.id,
        )
    )
    if run.kind is RunKind.REPAIR:
        managed_events = await _repair_managed_events(session, run_id)
    return _WorkflowRows(
        run=run,
        incident=incident,
        alert_signal=await session.get(AlertSignalRow, incident.id),
        diagnosis=diagnosis,
        repair_proposal=repair_proposal,
        repair=repair,
        start_event=start_event,
        terminal_event=terminal_event,
        managed_events=managed_events,
        source=source,
    )


async def _prune_target_from_incident(
    session: AsyncSession,
    incident: IncidentRow,
    artifact_root: Path,
) -> PruneTarget:
    await _require_no_incident_execution(session, incident.id)
    try:
        incident_id = UUID(incident.id)
        updated_at = _database_datetime(incident.updated_at)
    except (TypeError, ValueError):
        raise RecoveryConsistencyError from None
    runs = list(
        await session.scalars(
            select(RunRow)
            .where(RunRow.incident_id == incident.id)
            .order_by(RunRow.attempt)
        )
    )
    if not runs or [run.attempt for run in runs] != list(range(1, len(runs) + 1)):
        raise RecoveryConsistencyError
    run_ids: list[UUID] = []
    for run in runs:
        try:
            run_id = UUID(run.id)
        except (TypeError, ValueError):
            raise RecoveryConsistencyError from None
        rows = await _load_workflow_rows(session, run_id)
        snapshot = _workflow_run_snapshot(
            rows.run,
            rows.incident,
            rows.alert_signal,
            rows.diagnosis,
            rows.start_event,
            rows.terminal_event,
            rows.repair_proposal,
            rows.repair,
            rows.managed_events,
        )
        if snapshot.incident_id != incident_id or snapshot.run_status not in (
            RunStatus.COMPLETED,
            RunStatus.FAILED,
        ):
            raise RecoveryConsistencyError
        run_ids.append(run_id)

    persisted_run_ids = tuple(str(run_id) for run_id in run_ids)

    event_rows = await session.scalar(
        select(func.count())
        .select_from(RunEventRow)
        .where(RunEventRow.run_id.in_(persisted_run_ids))
    )
    evidence_rows = await session.scalar(
        select(func.count())
        .select_from(EvidenceRow)
        .where(EvidenceRow.run_id.in_(persisted_run_ids))
    )
    diagnosis_rows = await session.scalar(
        select(func.count())
        .select_from(DiagnosisRow)
        .where(DiagnosisRow.run_id.in_(persisted_run_ids))
    )
    repair_proposal_rows = await session.scalar(
        select(func.count())
        .select_from(RepairProposalRow)
        .where(RepairProposalRow.run_id.in_(persisted_run_ids))
    )
    alert_signal_rows = await session.scalar(
        select(func.count())
        .select_from(AlertSignalRow)
        .where(AlertSignalRow.incident_id == incident.id)
    )
    approval_rows = await session.scalar(
        select(func.count())
        .select_from(ApprovalRow)
        .where(ApprovalRow.run_id.in_(persisted_run_ids))
    )
    execution_rows = await session.scalar(
        select(func.count())
        .select_from(ExecutionRow)
        .where(ExecutionRow.run_id.in_(persisted_run_ids))
    )
    verification_rows = await session.scalar(
        select(func.count())
        .select_from(VerificationRow)
        .where(
            VerificationRow.execution_id.in_(
                select(ExecutionRow.id).where(
                    ExecutionRow.run_id.in_(persisted_run_ids)
                )
            )
        )
    )
    if (
        not isinstance(event_rows, int)
        or event_rows < 0
        or not isinstance(evidence_rows, int)
        or evidence_rows < 0
        or not isinstance(diagnosis_rows, int)
        or diagnosis_rows < 0
        or not isinstance(repair_proposal_rows, int)
        or repair_proposal_rows < 0
        or not isinstance(alert_signal_rows, int)
        or alert_signal_rows < 0
        or not isinstance(approval_rows, int)
        or not isinstance(execution_rows, int)
        or not isinstance(verification_rows, int)
    ):
        raise RecoveryConsistencyError
    return PruneTarget(
        incident_id=incident_id,
        updated_at=updated_at,
        run_ids=tuple(run_ids),
        artifact_directories=tuple(artifact_root / str(run_id) for run_id in run_ids),
        event_rows=event_rows,
        evidence_rows=evidence_rows,
        diagnosis_rows=diagnosis_rows,
        repair_proposal_rows=repair_proposal_rows,
        run_rows=len(runs),
        alert_signal_rows=alert_signal_rows,
        approval_rows=approval_rows,
        execution_rows=execution_rows,
        verification_rows=verification_rows,
    )


async def _delete_exact_rows(
    session: AsyncSession,
    statement: Delete,
    expected_rows: int,
) -> None:
    result = await session.execute(statement)
    if getattr(result, "rowcount", None) != expected_rows:
        raise RecoveryConsistencyError


def _canonical_alert_datetime(value: datetime) -> str:
    normalized = _require_aware_datetime(value).astimezone(UTC)
    return (
        normalized.strftime("%Y-%m-%dT%H:%M:%S.") + f"{normalized.microsecond:06d}000Z"
    )


def _overview_count(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise RecoveryConsistencyError
    return value


def _overview_family_record(
    source_type: object,
    source_ref: object,
    count: object,
) -> MonitoringOverviewFamilyRecord:
    if (
        source_type != "alertmanager"
        or not isinstance(source_ref, str)
        or not source_ref
    ):
        raise RecoveryConsistencyError
    normalized_count = _overview_count(count)
    if normalized_count == 0:
        raise RecoveryConsistencyError
    return MonitoringOverviewFamilyRecord(
        source_ref=source_ref,
        count=normalized_count,
    )


def _overview_hour_counts(
    rows: Iterable[tuple[object, object]],
) -> dict[str, int]:
    counts: dict[str, int] = {}
    for hour, count in rows:
        if not isinstance(hour, str) or _OVERVIEW_HOUR.fullmatch(hour) is None:
            raise RecoveryConsistencyError
        counts[hour] = _overview_count(count)
    return counts


def _incident_list_record(row: IncidentRow) -> IncidentListRecord:
    try:
        if not _is_non_empty_string(row.display_name):
            raise ValueError
        return IncidentListRecord(
            id=UUID(row.id),
            source=IncidentSource(
                type=cast(Literal["scenario", "alertmanager"], row.trigger_source),
                ref=row.trigger_ref,
                revision=row.trigger_revision,
            ),
            display_name=row.display_name,
            target=KubernetesTarget(
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


def _alert_signal_record(
    row: AlertSignalRow | None,
    incident: IncidentListRecord,
) -> AlertSignalRecord | None:
    if incident.source.type == "scenario":
        if row is not None:
            raise RecoveryConsistencyError
        return None
    if row is None:
        raise RecoveryConsistencyError
    try:
        starts_at = _database_alert_timestamp(row.starts_at)
        ends_at = (
            _database_alert_timestamp(row.ends_at) if row.ends_at is not None else None
        )
        if (
            row.incident_id != str(incident.id)
            or (row.status is AlertSignalStatus.FIRING and ends_at is not None)
            or (row.status is AlertSignalStatus.RESOLVED and ends_at is None)
            or (ends_at is not None and ends_at < starts_at)
        ):
            raise ValueError
        return AlertSignalRecord(
            status=row.status,
            starts_at=starts_at,
            ends_at=ends_at,
        )
    except (AttributeError, TypeError, ValueError):
        raise RecoveryConsistencyError from None


def _incident_detail_record(
    incident: IncidentRow,
    run: RunRow,
    diagnosis: DiagnosisRow | None,
    repair: IncidentRepairDetail | None,
    alert_signal: AlertSignalRow | None,
    evidence_rows: list[EvidenceRow],
    workflow: WorkflowRunSnapshot,
    terminal: TerminalRecord | None,
    event_rows: list[RunEventRow],
    has_older_events: bool,
    event_cursor: int,
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
        run_detail = _incident_run_detail(run, workflow)
        completed_at = (
            _database_datetime(run.completed_at)
            if run.completed_at is not None
            else None
        )
        if isinstance(workflow, RepairWorkflowRunSnapshot):
            diagnosis_detail = None
        elif terminal is None:
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
                recommendations=terminal.recommendations,
                redacted=terminal.redacted,
                created_at=_database_datetime(diagnosis.created_at),
            )
        return IncidentDetailRecord(
            incident=incident_record,
            trigger_summary=incident.trigger_summary,
            run=run_detail,
            evidence=tuple(
                _incident_evidence_detail(row, run_id) for row in evidence_rows
            ),
            diagnosis=diagnosis_detail,
            repair=repair,
            alert_signal=_alert_signal_record(alert_signal, incident_record),
            events=tuple(
                _event_from_row(
                    row,
                    expected_incident_id=incident_record.id,
                )
                for row in event_rows
            ),
            has_older_events=has_older_events,
            event_cursor=event_cursor,
        )
    except (AttributeError, TypeError, ValueError):
        raise RecoveryConsistencyError from None


async def _run_detail_from_row(
    session: AsyncSession,
    incident: IncidentRow,
    run: RunRow,
) -> IncidentRunDetail:
    rows = await _load_workflow_rows(session, UUID(run.id))
    if rows.incident.id != incident.id:
        raise RecoveryConsistencyError
    workflow, _ = _workflow_run_projection(
        rows.run,
        rows.incident,
        rows.alert_signal,
        rows.diagnosis,
        rows.start_event,
        rows.terminal_event,
        rows.repair_proposal,
        rows.repair,
        rows.managed_events,
    )
    return _incident_run_detail(run, workflow)


def _incident_run_detail(
    run: RunRow,
    workflow: WorkflowRunSnapshot,
) -> IncidentRunDetail:
    usage: tuple[object, ...] = (
        run.model_calls,
        run.tool_calls,
        run.input_tokens,
        run.output_tokens,
    )
    if (
        not _is_positive_integer(run.attempt)
        or any(not _is_optional_non_negative_integer(value) for value in usage)
        or (run.error_code is None) is not (run.error_retryable is None)
        or run.request_source not in (None, "system", "operator")
        or (run.request_source == "operator") != (run.operator_ref is not None)
    ):
        raise RecoveryConsistencyError
    return IncidentRunDetail(
        id=workflow.id,
        kind=workflow.kind,
        operation=workflow.operation
        if isinstance(workflow, RepairWorkflowRunSnapshot)
        else None,
        attempt=run.attempt,
        status=run.status,
        error_code=run.error_code,
        error_retryable=run.error_retryable,
        created_at=_database_datetime(run.created_at),
        started_at=workflow.started_at,
        completed_at=(
            _database_datetime(run.completed_at)
            if run.completed_at is not None
            else None
        ),
        request_source=run.request_source,
        source_run_id=workflow.source_run_id
        if isinstance(workflow, RepairWorkflowRunSnapshot)
        else None,
        selection=workflow.selection
        if isinstance(workflow, RepairWorkflowRunSnapshot)
        else None,
        waiting_expires_at=workflow.waiting_expires_at
        if isinstance(workflow, RepairWorkflowRunSnapshot)
        else None,
        end_reason=workflow.end_reason
        if isinstance(workflow, RepairWorkflowRunSnapshot)
        else None,
    )


def _incident_actions(
    detail: IncidentDetailRecord,
    *,
    source: RepairProposal | RollbackSource | None,
    active_id: str | None,
    target_occupied: bool,
    execution_enabled: bool,
    in_scope: bool,
    now: datetime,
) -> IncidentActions:
    run, repair = detail.run, detail.repair
    waiting = run.kind is RunKind.REPAIR and run.status is RunStatus.WAITING_APPROVAL
    terminal = run.status in (RunStatus.COMPLETED, RunStatus.FAILED)
    busy: ActionUnavailableReason | None = None
    if detail.run_creation_blocked:
        busy = "execution_held"
    elif active_id is not None and not (waiting and active_id == str(run.id)):
        busy = "active_run"

    preparation_source = None
    if isinstance(source, RollbackSource) and run.source_run_id is not None:
        preparation_source = RepairPreparationSource(
            source_run_id=run.source_run_id, source_execution_id=source.execution_id
        )
    elif repair is not None:
        preparation_source = RepairPreparationSource(
            source_run_id=run.id, source_execution_id=None
        )
    elif run.source_run_id is not None:
        preparation_source = RepairPreparationSource(
            source_run_id=run.source_run_id, source_execution_id=None
        )

    prepare = (
        busy
        if run.kind is RunKind.DIAGNOSIS and terminal and repair
        else "not_applicable"
    )
    refresh = (
        busy
        if run.kind is RunKind.REPAIR
        and (waiting or terminal)
        and (
            repair is None
            or repair.execution is None
            or repair.execution.status in ("EXPIRED", "REJECTED", "STALE_RESOURCE")
        )
        else "not_applicable"
    )
    candidates: list[RepairHistoryCandidate] = []
    if repair is not None and run.operation is not RepairOperation.ROLLBACK:
        proposal = repair.proposal
        for evidence in detail.evidence:
            if (
                evidence.id not in proposal.evidence_ids
                or evidence.evidence_kind != "rollout_history"
                or evidence.truncated
                or evidence.redacted
            ):
                continue
            try:
                history = RolloutHistoryPayload.model_validate(evidence.payload)
            except ValidationError:
                continue
            candidates.extend(
                RepairHistoryCandidate(
                    revision=str(revision.revision),
                    replica_set_uid=revision.replica_set_ref.uid,
                    image=image,
                )
                for revision, image in image_history_candidates(
                    history, proposal.container_name, proposal.current_image
                )
            )
    edit: ActionUnavailableReason | None = "not_applicable"
    if run.operation is not RepairOperation.ROLLBACK and (
        prepare != "not_applicable" or refresh != "not_applicable"
    ):
        edit = busy or (None if candidates else "no_history_candidates")

    decision: ActionUnavailableReason | None = "not_applicable"
    if waiting and repair is not None and repair.approval is None:
        if not execution_enabled:
            decision = "execution_disabled"
        elif not in_scope:
            decision = "outside_scope"
        elif (
            run.waiting_expires_at is None
            or not repair.validation.checked_at <= now < run.waiting_expires_at
            or repair.validation.outcome != "passed"
        ):
            decision = "proposal_expired"
        else:
            decision = None

    rollback: ActionUnavailableReason | None = "not_applicable"
    if (
        terminal
        and run.operation is RepairOperation.APPLY
        and repair is not None
        and repair.execution is not None
        and repair.execution.status == "APPLIED"
        and repair.execution.result is not None
        and repair.execution.result.receipt is not None
    ):
        rollback = busy
    return IncidentActions(
        prepare=prepare,
        refresh=refresh,
        edit=edit,
        approve=decision or ("target_occupied" if target_occupied else None),
        reject=decision,
        rerun=busy,
        rollback=rollback,
        preparation_source=preparation_source,
        history_candidates=tuple(candidates),
    )


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


def _incident_repair_detail(
    row: RepairProposalRow,
    run_id: UUID,
) -> IncidentRepairDetail:
    proposal, validation = _repair_contracts_from_row(row, run_id)
    return IncidentRepairDetail(proposal=proposal, validation=validation)


def _repair_contracts_from_row(
    row: RepairProposalRow,
    run_id: UUID,
) -> tuple[RepairProposal, PatchValidationResponse]:
    try:
        proposal = RepairProposal.model_validate_json(row.proposal_json)
        validation = PatchValidationResponse.model_validate_json(row.validation_json)
        require_exact_repair_proposal(proposal)
        proposal_json = canonical_json(
            cast(dict[str, JsonValue], proposal.model_dump(mode="json"))
        )
        validation_json = canonical_json(
            cast(dict[str, JsonValue], validation.model_dump(mode="json"))
        )
        if (
            row.id != str(proposal.id)
            or row.run_id != str(run_id)
            or row.schema_version != proposal.schema_version
            or proposal.run_id != run_id
            or validation.run_id != run_id
            or validation.proposal_id != proposal.id
            or validation.proposal_digest != proposal.digest
            or validation.checked_at < proposal.diff_checked_at
            or row.proposal_json != proposal_json
            or row.validation_json != validation_json
            or _database_datetime(row.created_at) != proposal.diff_checked_at
        ):
            raise ValueError
        return proposal, validation
    except (AttributeError, TypeError, ValueError, ValidationError):
        raise RecoveryConsistencyError from None


def _workflow_run_snapshot(
    run: RunRow,
    incident: IncidentRow,
    alert_signal: AlertSignalRow | None,
    diagnosis: DiagnosisRow | None,
    start_event: RunEventRow | None,
    terminal_event: RunEventRow | None,
    repair_proposal: RepairProposalRow | None,
    repair: IncidentRepairDetail | None,
    managed_events: tuple[RunEventRow, ...],
) -> WorkflowRunSnapshot:
    snapshot, _ = _workflow_run_projection(
        run,
        incident,
        alert_signal,
        diagnosis,
        start_event,
        terminal_event,
        repair_proposal,
        repair,
        managed_events,
    )
    return snapshot


def _workflow_run_projection(
    run: RunRow,
    incident: IncidentRow,
    alert_signal: AlertSignalRow | None,
    diagnosis: DiagnosisRow | None,
    start_event: RunEventRow | None,
    terminal_event: RunEventRow | None,
    repair_proposal: RepairProposalRow | None,
    repair: IncidentRepairDetail | None,
    managed_events: tuple[RunEventRow, ...],
) -> tuple[WorkflowRunSnapshot, TerminalRecord | None]:
    try:
        run_id = UUID(run.id)
        incident_id = UUID(incident.id)
        target = KubernetesTarget(
            cluster=incident.cluster,
            namespace=incident.namespace,
            api_version=incident.api_version,
            kind=incident.kind,
            name=incident.resource_name,
        )
        if target.namespace is None:
            raise ValueError
    except (AttributeError, TypeError, ValueError):
        raise RecoveryConsistencyError from None
    if run.kind is RunKind.REPAIR:
        return _repair_workflow_snapshot(
            run,
            incident,
            diagnosis,
            target,
            start_event,
            repair,
            managed_events,
        ), None
    if (
        run.incident_id != incident.id
        or not _is_positive_integer(run.attempt)
        or run.kind is not RunKind.DIAGNOSIS
        or run.operation is not None
        or run.status is RunStatus.WAITING_APPROVAL
        or not _valid_workflow_snapshot_values(run, incident)
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
            started_at is not None
            or completed_at is not None
            or not _has_empty_terminal_fields(run, diagnosis, terminal_event)
            or repair_proposal is not None
            or managed_events
        ):
            raise RecoveryConsistencyError
    elif run.status is RunStatus.RUNNING:
        if (
            incident.status is not IncidentStatus.TRIAGING
            or completed_at is not None
            or not _has_empty_terminal_fields(run, diagnosis, terminal_event)
            or repair_proposal is not None
            or managed_events
        ):
            raise RecoveryConsistencyError
    else:
        is_repair_terminal = repair_proposal is not None or any(
            event.event_key != "run:terminal" for event in managed_events
        )
        if is_repair_terminal:
            repair_terminal = _repair_terminal_record_from_rows(
                run,
                diagnosis,
                repair,
            )
            _resolve_repair_terminal_replay(
                repair_terminal,
                run,
                incident,
                diagnosis,
                repair_proposal,
                managed_events,
            )
            terminal = replace(
                _diagnosis_terminal_record(repair_terminal),
                completed_at=repair_terminal.completed_at,
            )
            completed_at = repair_terminal.completed_at
            if started_at is None:
                raise RecoveryConsistencyError
        else:
            terminal = _terminal_record_from_rows(
                run,
                diagnosis,
                terminal_event,
            )
            _resolve_terminal_replay(
                terminal,
                run,
                incident,
                diagnosis,
                terminal_event,
            )
            completed_at = terminal.completed_at
        if run.status is RunStatus.COMPLETED and started_at is None:
            raise RecoveryConsistencyError

    snapshot = DiagnosisWorkflowRunSnapshot(
        id=run_id,
        incident_id=incident_id,
        source=IncidentSource(
            type=cast(Literal["scenario", "alertmanager"], incident.trigger_source),
            ref=incident.trigger_ref,
            revision=incident.trigger_revision,
        ),
        run_status=run.status,
        trigger_summary=incident.trigger_summary,
        target=target,
        model=ModelSnapshot(
            provider=cast(str, run.model_provider),
            model_id=cast(str, run.model_id),
            thinking_mode=cast(bool, run.thinking_mode),
            prompt_version=cast(str, run.prompt_version),
        ),
        budget=RunBudget(
            max_model_calls=cast(int, run.max_model_calls),
            max_tool_calls=cast(int, run.max_tool_calls),
            timeout_seconds=run.timeout_seconds,
        ),
        started_at=started_at,
        occurred_at=_incident_onset(incident, alert_signal),
    )
    return snapshot, terminal


def _incident_onset(
    incident: IncidentRow,
    alert_signal: AlertSignalRow | None,
) -> datetime:
    """The persisted moment the Incident began: alert start, else manual creation."""
    if incident.trigger_source == "alertmanager":
        if alert_signal is None or alert_signal.incident_id != incident.id:
            raise RecoveryConsistencyError
        try:
            starts_at = _database_alert_timestamp(alert_signal.starts_at)
        except ValueError:
            raise RecoveryConsistencyError from None
        return datetime.fromisoformat(starts_at.replace("Z", "+00:00")).astimezone(UTC)
    if alert_signal is not None:
        raise RecoveryConsistencyError
    return _database_datetime(incident.created_at)


def _repair_workflow_snapshot(
    run: RunRow,
    incident: IncidentRow,
    diagnosis: DiagnosisRow | None,
    target: KubernetesTarget,
    start_event: RunEventRow | None,
    repair: IncidentRepairDetail | None,
    managed_events: tuple[RunEventRow, ...],
) -> RepairWorkflowRunSnapshot:
    """Read business state without replaying a diagnostic graph or model checkpoint."""
    started_at = (
        _database_datetime(run.started_at) if run.started_at is not None else None
    )
    completed_at = (
        _database_datetime(run.completed_at) if run.completed_at is not None else None
    )
    terminal = run.status in (RunStatus.COMPLETED, RunStatus.FAILED)
    if (
        run.incident_id != incident.id
        or not _is_positive_integer(run.attempt)
        or not _is_positive_integer(run.timeout_seconds)
        or not _is_non_empty_string(incident.trigger_summary)
        or run.operation not in (RepairOperation.APPLY, RepairOperation.ROLLBACK)
        or diagnosis is not None
        or any(
            value is not None
            for value in (
                run.model_provider,
                run.model_id,
                run.thinking_mode,
                run.prompt_version,
                run.max_model_calls,
                run.max_tool_calls,
                run.model_calls,
                run.tool_calls,
                run.input_tokens,
                run.output_tokens,
            )
        )
        or terminal != (completed_at is not None)
        or (run.status is RunStatus.QUEUED and started_at is not None)
        or (
            run.status
            in (RunStatus.RUNNING, RunStatus.WAITING_APPROVAL, RunStatus.COMPLETED)
            and started_at is None
        )
        or (run.status is RunStatus.FAILED) != (run.error_code is not None)
        or (run.error_code is None) != (run.error_retryable is None)
    ):
        raise RecoveryConsistencyError
    _require_start_event_consistency(run, incident, start_event, started_at)
    expires_at = (
        _database_datetime(run.waiting_expires_at)
        if run.waiting_expires_at is not None
        else None
    )
    try:
        if run.source_run_id is None:
            raise ValueError
        source_run_id = UUID(run.source_run_id)
        selection = (
            None
            if run.selection_revision is None and run.selection_replica_set_uid is None
            else RepairHistorySelection.model_validate(
                {
                    "revision": run.selection_revision,
                    "replica_set_uid": run.selection_replica_set_uid,
                }
            )
        )
    except (TypeError, ValueError):
        raise RecoveryConsistencyError from None
    proposal, validation = (
        (repair.proposal, repair.validation) if repair is not None else (None, None)
    )
    approval = repair.approval if repair is not None else None
    execution = repair.execution if repair is not None else None
    verification = repair.verification if repair is not None else None
    if (
        (expires_at is not None)
        != (validation is not None and validation.outcome == "passed")
        or (
            expires_at is not None
            and validation is not None
            and expires_at != validation.checked_at + timedelta(minutes=15)
        )
        or (
            run.status is RunStatus.WAITING_APPROVAL
            and (
                expires_at is None
                or incident.status is not IncidentStatus.WAITING_APPROVAL
            )
        )
        or (
            run.status is RunStatus.RUNNING
            and incident.status
            is not (
                IncidentStatus.VERIFYING
                if execution is not None and execution.status == "APPLIED"
                else IncidentStatus.APPLYING
                if execution is not None
                else IncidentStatus.PATCH_READY
            )
        )
        or (
            run.status in (RunStatus.QUEUED, RunStatus.RUNNING)
            and approval is None
            and (proposal is not None or managed_events)
        )
        or (run.status is RunStatus.COMPLETED)
        != (
            run.end_reason
            in ("expired", "superseded", "rejected", "execution_expired", "withdrawn")
            or (
                verification is not None
                and (
                    verification.outcome == "recovered"
                    or (
                        run.operation is RepairOperation.ROLLBACK
                        and verification.completed_at is not None
                    )
                )
            )
        )
        or run.end_reason
        not in (
            None,
            "expired",
            "superseded",
            "rejected",
            "execution_expired",
            "withdrawn",
        )
        or (run.end_reason is not None and (expires_at is None or completed_at is None))
        or (
            run.end_reason == "expired"
            and completed_at is not None
            and expires_at is not None
            and completed_at < expires_at
        )
        or (run.operation is RepairOperation.ROLLBACK and selection is not None)
        or (
            proposal is not None
            and (
                (run.operation is RepairOperation.APPLY and selection is None)
                or proposal.target != target
            )
        )
    ):
        raise RecoveryConsistencyError
    if approval is not None:
        if (approval.decision == "reject" and run.end_reason != "rejected") or (
            execution is not None
            and execution.status == "EXPIRED"
            and run.end_reason != "execution_expired"
        ):
            raise RecoveryConsistencyError
    elif run.end_reason in ("rejected", "execution_expired"):
        raise RecoveryConsistencyError
    if approval is not None or run.status in (
        RunStatus.WAITING_APPROVAL,
        RunStatus.COMPLETED,
        RunStatus.FAILED,
    ):
        preparation_events = tuple(
            event
            for event in managed_events
            if event.event_type != "repair.wait_ended"
            and event.event_type
            not in ("repair.approval_decided", "repair.execution_updated")
            and not (expires_at is not None and event.event_key == "run:terminal")
        )
        if not preparation_events:
            raise RecoveryConsistencyError
        prepared = PreparedRepairRecord(
            run_id=UUID(run.id),
            recorded_at=_database_datetime(preparation_events[-1].occurred_at),
            proposal=proposal,
            validation=validation,
            selection=selection,
            error_code=run.error_code if expires_at is None else None,
            error_retryable=run.error_retryable if expires_at is None else None,
        )
        expected_events = _prepared_repair_events(prepared, UUID(incident.id))
        if len(expected_events) != len(preparation_events) or any(
            actual.event_key != expected.event_key
            or actual.payload_json != expected.payload_json
            or actual.event_type != expected.event_type
            or _database_datetime(actual.occurred_at) != expected.occurred_at
            for actual, expected in zip(
                preparation_events, expected_events, strict=True
            )
        ):
            raise RecoveryConsistencyError
        if run.status is RunStatus.COMPLETED and approval is None:
            ended = managed_events[-1]
            expected_payload = _base_payload(
                UUID(incident.id),
                UUID(run.id),
                cast(datetime, completed_at),
                RunKind.REPAIR,
            )
            expected_payload.update(
                {
                    "reason": run.end_reason,
                    "runStatus": "COMPLETED",
                    "incidentStatus": "DIAGNOSED",
                }
            )
            if (
                ended.event_type != "repair.wait_ended"
                or ended.event_key != "run:terminal"
                or ended.payload_json != canonical_json(expected_payload)
            ):
                raise RecoveryConsistencyError
        elif (
            run.status is RunStatus.FAILED
            and expires_at is not None
            and approval is None
        ):
            ended = managed_events[-1]
            expected_payload = _base_payload(
                UUID(incident.id),
                UUID(run.id),
                cast(datetime, completed_at),
                RunKind.REPAIR,
            )
            expected_payload.update(
                {
                    "errorCode": run.error_code,
                    "retryable": run.error_retryable,
                    "incidentStatus": "FAILED",
                    "runStatus": "FAILED",
                }
            )
            if (
                ended.event_type != "run.failed"
                or ended.event_key != "run:terminal"
                or ended.payload_json != canonical_json(expected_payload)
            ):
                raise RecoveryConsistencyError
    return RepairWorkflowRunSnapshot(
        id=UUID(run.id),
        incident_id=UUID(incident.id),
        source=IncidentSource(
            type=cast(Literal["scenario", "alertmanager"], incident.trigger_source),
            ref=incident.trigger_ref,
            revision=incident.trigger_revision,
        ),
        run_status=run.status,
        trigger_summary=incident.trigger_summary,
        target=target,
        started_at=started_at,
        operation=cast(RepairOperation, run.operation),
        timeout_seconds=run.timeout_seconds,
        source_run_id=source_run_id,
        selection=selection,
        waiting_expires_at=expires_at,
        proposal_id=proposal.id if proposal else None,
        end_reason=run.end_reason,
        approval=approval,
        execution=execution,
        verification=verification,
    )


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
        payload=_run_started_event_payload(
            incident_id,
            run_id,
            run.attempt,
            started_at,
            run.kind,
        ),
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
            recommendations=_recommendation_records(diagnosis, validated),
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


def _repair_terminal_record_from_rows(
    run: RunRow,
    diagnosis: DiagnosisRow | None,
    repair: IncidentRepairDetail | None,
) -> RepairTerminalRecord:
    if (
        diagnosis is None
        or run.completed_at is None
        or not isinstance(run.model_calls, int)
        or isinstance(run.model_calls, bool)
        or run.model_calls < 0
        or not isinstance(run.tool_calls, int)
        or isinstance(run.tool_calls, bool)
        or run.tool_calls < 0
    ):
        raise RecoveryConsistencyError
    validated = _validated_diagnosis_from_row(diagnosis)
    proposal: RepairProposal | None = None
    validation: PatchValidationResponse | None = None
    if repair is not None:
        proposal, validation = repair.proposal, repair.validation
        validated = validated.model_copy(
            update={
                "repair_intent": SetContainerImageIntent(
                    action=proposal.action,
                    target=proposal.target,
                    container_name=proposal.container_name,
                    replacement_image=proposal.replacement_image,
                    evidence_ids=list(proposal.evidence_ids),
                )
            }
        )
    try:
        return RepairTerminalRecord(
            run_id=UUID(run.id),
            diagnosis_completed_at=_database_datetime(diagnosis.created_at),
            completed_at=_database_datetime(run.completed_at),
            diagnosis=validated,
            proposal=proposal,
            validation=validation,
            error_code=run.error_code,
            error_retryable=run.error_retryable,
            model_calls=run.model_calls,
            tool_calls=run.tool_calls,
            input_tokens=run.input_tokens,
            output_tokens=run.output_tokens,
        )
    except (TypeError, ValueError):
        raise RecoveryConsistencyError from None


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
                "recommendations": (
                    []
                    if diagnosis.recommendations_json is None
                    else json.loads(diagnosis.recommendations_json)
                ),
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


async def _repair_proposal_by_run(
    session: AsyncSession,
    run_id: UUID,
) -> RepairProposalRow | None:
    return await session.scalar(
        select(RepairProposalRow).where(RepairProposalRow.run_id == str(run_id))
    )


async def _repair_managed_events(
    session: AsyncSession,
    run_id: UUID,
) -> tuple[RunEventRow, ...]:
    rows = await session.scalars(
        select(RunEventRow)
        .where(
            RunEventRow.run_id == str(run_id),
            RunEventRow.event_key.in_(
                (
                    "diagnosis.completed",
                    "repair.patch_ready",
                    "repair.dry_run_passed",
                    "repair.waiting_approval",
                    "run:terminal",
                )
            ),
        )
        .order_by(RunEventRow.id)
    )
    return tuple(rows)


def _new_run_row(
    *,
    run_id: UUID,
    incident_id: UUID,
    attempt: int,
    model: ModelSnapshot,
    budget: RunBudget,
    occurred_at: datetime,
) -> RunRow:
    return RunRow(
        id=str(run_id),
        incident_id=str(incident_id),
        attempt=attempt,
        status=RunStatus.QUEUED,
        kind=RunKind.DIAGNOSIS,
        operation=None,
        request_source="system",
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


def _new_event_row(
    *,
    run_id: UUID,
    event_key: str,
    event_type: str,
    occurred_at: datetime,
    payload: dict[str, JsonValue],
) -> RunEventRow:
    return RunEventRow(
        run_id=str(run_id),
        event_key=event_key,
        event_type=event_type,
        schema_version=_SCHEMA_VERSION,
        occurred_at=occurred_at,
        payload_json=canonical_json(payload),
    )


def _event_from_row(
    row: RunEventRow,
    *,
    expected_incident_id: UUID,
) -> RunEvent:
    try:
        if row.schema_version != _SCHEMA_VERSION:
            raise RecoveryConsistencyError
        payload = _event_payload(row)
        incident_id = UUID(cast(str, payload.get("incidentId")))
        run_id = UUID(row.run_id)
        if (
            incident_id != expected_incident_id
            or payload.get("runId") != str(run_id)
            or payload.get("schemaVersion") != _SCHEMA_VERSION
        ):
            raise RecoveryConsistencyError
        return RunEvent(
            id=row.id,
            incident_id=incident_id,
            run_id=run_id,
            event_key=row.event_key,
            event_type=row.event_type,
            occurred_at=_database_datetime(row.occurred_at),
            payload=payload,
        )
    except (TypeError, ValueError):
        raise RecoveryConsistencyError from None


def _event_payload(row: RunEventRow) -> dict[str, JsonValue]:
    try:
        return parse_json_object(row.payload_json)
    except (TypeError, ValueError):
        raise RecoveryConsistencyError from None


def _base_payload(
    incident_id: UUID,
    run_id: UUID,
    occurred_at: datetime,
    run_kind: RunKind = RunKind.DIAGNOSIS,
) -> dict[str, JsonValue]:
    return {
        "schemaVersion": _SCHEMA_VERSION,
        "incidentId": str(incident_id),
        "runId": str(run_id),
        "runKind": run_kind.value,
        "occurredAt": _rfc3339(occurred_at),
    }


def _tool_started_event_payload(
    incident_id: UUID,
    run_id: UUID,
    tool_call_id: str,
    tool_name: str,
    occurred_at: datetime,
    call_identity: dict[str, JsonValue] | None,
    run_kind: RunKind = RunKind.DIAGNOSIS,
) -> dict[str, JsonValue]:
    payload = _base_payload(incident_id, run_id, occurred_at, run_kind)
    payload.update({"toolCallId": tool_call_id, "toolName": tool_name})
    if call_identity is not None:
        payload["callIdentity"] = call_identity
    return payload


def _run_started_event_payload(
    incident_id: UUID,
    run_id: UUID,
    attempt: int,
    started_at: datetime,
    run_kind: RunKind = RunKind.DIAGNOSIS,
) -> dict[str, JsonValue]:
    payload = _base_payload(incident_id, run_id, started_at, run_kind)
    payload.update(
        {
            "attempt": attempt,
            "incidentStatus": "TRIAGING"
            if run_kind is RunKind.DIAGNOSIS
            else "PATCH_READY",
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
        row.run_id == str(run_id)
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
        status=run.status,
        incident_id=UUID(incident.id),
        incident_status=incident.status,
        started_at=_database_datetime(run.started_at),
        event=_event_from_row(
            event_row,
            expected_incident_id=UUID(incident.id),
        ),
    )


def _replayed_start(
    run: RunRow,
    incident: IncidentRow,
    event_row: RunEventRow,
    started_at: datetime,
) -> RunRecord:
    if run.status is not RunStatus.RUNNING:
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
    call_identity: dict[str, JsonValue] | None,
    run_kind: RunKind = RunKind.DIAGNOSIS,
) -> RunEventRow:
    event_row = await _event_by_key(session, run_id, f"tool:{tool_call_id}:started")
    if event_row is None:
        raise RecoveryConsistencyError
    _require_matching_tool_started_event(
        event_row,
        incident_id,
        run_id,
        tool_call_id,
        tool_name,
        call_identity,
        run_kind,
    )
    return event_row


def _require_matching_tool_started_event(
    event_row: RunEventRow,
    incident_id: UUID,
    run_id: UUID,
    tool_call_id: str,
    tool_name: str,
    call_identity: dict[str, JsonValue] | None,
    run_kind: RunKind = RunKind.DIAGNOSIS,
) -> None:
    actual_identity = _matching_tool_started_identity(
        event_row,
        incident_id,
        run_id,
        tool_call_id,
        tool_name,
        run_kind,
    )
    if actual_identity != call_identity:
        raise RecoveryConsistencyError


def _matching_tool_started_identity(
    event_row: RunEventRow,
    incident_id: UUID,
    run_id: UUID,
    tool_call_id: str,
    tool_name: str,
    run_kind: RunKind = RunKind.DIAGNOSIS,
) -> dict[str, JsonValue] | None:
    occurred_at = _database_datetime(event_row.occurred_at)
    event_payload = _event_payload(event_row)
    try:
        call_identity = normalize_diagnostic_tool_call_identity(
            tool_name,
            event_payload.get("callIdentity"),
        )
    except ValueError:
        raise RecoveryConsistencyError from None
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
            call_identity,
            run_kind,
        ),
    ):
        raise RecoveryConsistencyError
    return call_identity


async def _resolve_evidence_replay(
    session: AsyncSession,
    evidence: EvidenceRecord,
    persisted: EvidenceRow | None,
    failure: RunEventRow | None,
    incident_id: UUID,
    run_kind: RunKind = RunKind.DIAGNOSIS,
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
        run_kind,
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
    return _persisted_evidence(persisted, event_row, incident_id)


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
    run_kind: RunKind = RunKind.DIAGNOSIS,
) -> dict[str, JsonValue]:
    payload = _base_payload(incident_id, run_id, occurred_at, run_kind)
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
    evidence_row: EvidenceRow,
    event_row: RunEventRow,
    incident_id: UUID,
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
            event=_event_from_row(
                event_row,
                expected_incident_id=incident_id,
            ),
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
    run_kind: RunKind = RunKind.DIAGNOSIS,
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
        run_kind,
    )


def _existing_evidence_outcome_from_event(
    evidence_row: EvidenceRow,
    event_row: RunEventRow,
    incident_id: UUID,
    run_id: UUID,
    tool_call_id: str,
    tool_name: str,
    run_kind: RunKind = RunKind.DIAGNOSIS,
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
                run_kind,
            ),
        )
    ):
        raise RecoveryConsistencyError
    return _persisted_evidence(evidence_row, event_row, incident_id)


def _existing_failure_outcome(
    event_row: RunEventRow,
    event_payload: dict[str, JsonValue],
    incident_id: UUID,
    run_id: UUID,
    tool_call_id: str,
    tool_name: str,
    run_kind: RunKind = RunKind.DIAGNOSIS,
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
        payload=_tool_failure_event_payload(failure, incident_id, run_kind),
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
    successes: list[tuple[int, str, str, dict[str, JsonValue] | None]] = []
    persisted_ids: set[UUID] = set()
    persisted_by_id: dict[UUID, PersistedEvidence] = {}
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
        started_event_id, call_identity = _require_earlier_matching_tool_started(
            all_events_by_key,
            event_row,
            incident_id,
            run_id,
            persisted.tool_call_id,
            persisted.tool_name,
        )
        matched_started_event_ids.add(started_event_id)
        if persisted.id in persisted_ids or persisted.tool_call_id in success_call_ids:
            raise RecoveryConsistencyError
        persisted_ids.add(persisted.id)
        persisted_by_id[persisted.id] = persisted
        success_call_ids.add(persisted.tool_call_id)
        matched_evidence_event_ids.add(event_row.id)
        successes.append(
            (
                event_row.id,
                persisted.tool_call_id,
                persisted.tool_name,
                call_identity,
            )
        )

    if matched_evidence_event_ids != {event_row.id for event_row in evidence_events}:
        raise RecoveryConsistencyError

    failures: list[tuple[int, ToolFailureRecord, dict[str, JsonValue] | None]] = []
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
        started_event_id, call_identity = _require_earlier_matching_tool_started(
            all_events_by_key,
            event_row,
            incident_id,
            run_id,
            failure.tool_call_id,
            failure.tool_name,
        )
        matched_started_event_ids.add(started_event_id)
        failures.append((event_row.id, failure, call_identity))

    if matched_started_event_ids != {event_row.id for event_row in started_events}:
        raise RecoveryConsistencyError

    unresolved = tuple(
        failure
        for failure_event_id, failure, failure_identity in failures
        if not failure.retryable
        or not any(
            success_event_id > failure_event_id
            and success_call_id != failure.tool_call_id
            and success_tool_name == failure.tool_name
            and success_identity == failure_identity
            for (
                success_event_id,
                success_call_id,
                success_tool_name,
                success_identity,
            ) in successes
        )
    )
    return DiagnosisValidationSnapshot(
        evidence_by_id=persisted_by_id,
        tool_failures=tuple(failure for _, failure, _ in failures),
        unresolved_tool_failures=unresolved,
    )


async def _require_observation_capacity(
    session: AsyncSession,
    run_id: UUID,
    tool_name: str,
    call_identity: dict[str, JsonValue] | None,
) -> None:
    """Admit at most OBSERVATION_LIMIT non-retryable-failure attempts per tool.

    An attempt counts once its start row exists unless its only outcome is a
    retryable failure, so in-flight parallel calls and non-retryable failures
    occupy capacity while a timed-out read may be tried again.
    """
    started_rows = await session.scalars(
        select(RunEventRow).where(
            RunEventRow.run_id == str(run_id),
            RunEventRow.event_type == "tool.started",
        )
    )
    attempts = 0
    for row in started_rows:
        payload = _event_payload(row)
        if payload.get("toolName") != tool_name:
            continue
        try:
            identity = normalize_diagnostic_tool_call_identity(
                tool_name, payload.get("callIdentity")
            )
        except ValueError:
            raise RecoveryConsistencyError from None
        if identity != call_identity:
            continue
        started_call_id = payload.get("toolCallId")
        if not isinstance(started_call_id, str):
            raise RecoveryConsistencyError
        failure = await _event_by_key(session, run_id, f"tool:{started_call_id}:failed")
        if failure is not None and _event_payload(failure).get("retryable") is True:
            continue
        attempts += 1
    if attempts >= OBSERVATION_LIMIT:
        raise ObservationLimitExceededError


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
    run_kind: RunKind = RunKind.DIAGNOSIS,
) -> tuple[int, dict[str, JsonValue] | None]:
    started_event = events_by_key.get(f"tool:{tool_call_id}:started")
    if started_event is None or started_event.id >= outcome_event.id:
        raise RecoveryConsistencyError
    call_identity = _matching_tool_started_identity(
        started_event,
        incident_id,
        run_id,
        tool_call_id,
        tool_name,
        run_kind,
    )
    return started_event.id, call_identity


async def _require_repair_evidence(
    session: AsyncSession,
    run: RunRow,
    incident: IncidentRow,
    proposal: RepairProposal,
    rollback_source: RollbackSource | None,
) -> None:
    evidence_rows = list(
        await session.scalars(
            select(EvidenceRow).where(
                EvidenceRow.run_id == run.id,
                EvidenceRow.tool_call_id.in_(
                    (
                        "repair:get_workload",
                        "repair:get_rollout_history",
                        "repair:get_pods",
                        "repair:get_events",
                    )
                ),
            )
        )
    )
    event_rows = list(
        await session.scalars(select(RunEventRow).where(RunEventRow.run_id == run.id))
    )
    events = {row.event_key: row for row in event_rows}
    rollback = run.operation is RepairOperation.ROLLBACK
    expected_kinds = (
        {"workload"} if rollback else {"workload", "rollout_history", "pods", "events"}
    )
    if (
        run.started_at is None
        or len(evidence_rows) != len(expected_kinds)
        or {row.evidence_kind for row in evidence_rows} != expected_kinds
        or rollback != (proposal.change.source_execution_id is not None)
    ):
        raise RecoveryConsistencyError
    if set(proposal.evidence_ids) != {
        UUID(row.id)
        for row in evidence_rows
        if row.evidence_kind in ("workload", "rollout_history")
    }:
        raise RecoveryConsistencyError
    for row in evidence_rows:
        event = events.get(f"tool:{row.tool_call_id}:evidence")
        if (
            event is None
            or row.tool_name != f"get_{row.evidence_kind}"
            or row.tool_call_id != f"repair:{row.tool_name}"
        ):
            raise RecoveryConsistencyError
        persisted = _existing_evidence_outcome_from_event(
            row,
            event,
            UUID(incident.id),
            UUID(run.id),
            row.tool_call_id,
            row.tool_name,
            RunKind.REPAIR,
        )
        _require_earlier_matching_tool_started(
            events,
            event,
            UUID(incident.id),
            UUID(run.id),
            row.tool_call_id,
            row.tool_name,
            RunKind.REPAIR,
        )
        if (
            persisted.redacted
            or persisted.truncated
            or not _database_datetime(run.started_at)
            <= persisted.observed_at
            <= proposal.schema_checked_at
        ):
            raise RecoveryConsistencyError
    if rollback:
        if rollback_source is None:
            raise RecoveryConsistencyError
        try:
            row = evidence_rows[0]
            observation = WorkloadObservation.model_validate(
                {
                    "evidence_kind": row.evidence_kind,
                    "target_ref": parse_json_object(row.target_ref_json),
                    "observed_at": _database_datetime(row.observed_at),
                    "payload": parse_json_object(row.payload_json),
                    "truncated": row.truncated,
                    "redacted": row.redacted,
                }
            )
            expected = resolve_rollback_change(
                run_id=UUID(run.id),
                source=rollback_source,
                workload=observation,
                evidence_id=UUID(row.id),
            )
            if proposal.change != expected:
                raise RecoveryConsistencyError
        except (ValueError, RepairPreparationError):
            raise RecoveryConsistencyError from None


def _tool_failure_event_payload(
    failure: ToolFailureRecord,
    incident_id: UUID,
    run_kind: RunKind = RunKind.DIAGNOSIS,
) -> dict[str, JsonValue]:
    payload = _base_payload(incident_id, failure.run_id, failure.occurred_at, run_kind)
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
    run_kind: RunKind = RunKind.DIAGNOSIS,
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
        payload=_tool_failure_event_payload(failure, incident_id, run_kind),
    ):
        raise RecoveryConsistencyError
    return _event_from_row(existing, expected_incident_id=incident_id)


def _require_active_run(run: RunRow, incident: IncidentRow) -> None:
    if run.status is not RunStatus.RUNNING or incident.status is not (
        IncidentStatus.TRIAGING
        if run.kind is RunKind.DIAGNOSIS
        else IncidentStatus.PATCH_READY
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
        run.status is not run_target
        or run.completed_at is None
        or _database_datetime(run.completed_at) != terminal.completed_at
        or _database_datetime(run.updated_at) != terminal.completed_at
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
        event=_event_from_row(
            terminal_event,
            expected_incident_id=incident_id,
        ),
    )


def _diagnosis_terminal_record(terminal: RepairTerminalRecord) -> TerminalRecord:
    diagnosis = terminal.diagnosis
    return TerminalRecord(
        run_id=terminal.run_id,
        completed_at=terminal.diagnosis_completed_at,
        outcome=DiagnosisOutcome.DIAGNOSED,
        summary=diagnosis.summary,
        root_causes=tuple(
            RootCauseRecord(
                code=root_cause.code,
                statement=root_cause.statement,
                confidence=root_cause.confidence,
                evidence_ids=tuple(root_cause.evidence_ids),
            )
            for root_cause in diagnosis.root_causes
        ),
        missing_information=tuple(diagnosis.missing_information),
        redacted=diagnosis.redacted,
        error_code=None,
        error_retryable=None,
        model_calls=terminal.model_calls,
        tool_calls=terminal.tool_calls,
        input_tokens=terminal.input_tokens,
        output_tokens=terminal.output_tokens,
        recommendations=recommendation_records(diagnosis.recommendations),
    )


def _repair_diagnosis_row(
    terminal: RepairTerminalRecord,
    persisted_diagnosis_id: UUID,
) -> DiagnosisRow:
    diagnosis = _diagnosis_terminal_record(terminal)
    return DiagnosisRow(
        id=str(persisted_diagnosis_id),
        run_id=str(terminal.run_id),
        outcome=DiagnosisOutcome.DIAGNOSED,
        summary=_diagnosis_summary(diagnosis),
        root_causes_json=_root_causes_json(diagnosis.root_causes),
        missing_information_json=_string_list_json(diagnosis.missing_information),
        recommendations_json=_recommendations_json(diagnosis.recommendations),
        redacted=diagnosis.redacted,
        created_at=terminal.diagnosis_completed_at,
    )


def _repair_run_status(terminal: RepairTerminalRecord) -> RunStatus:
    return RunStatus.COMPLETED if terminal.error_code is None else RunStatus.FAILED


def _repair_incident_status(terminal: RepairTerminalRecord) -> IncidentStatus:
    if terminal.error_code is None:
        return IncidentStatus.WAITING_APPROVAL
    if terminal.error_code == "stale_resource":
        return IncidentStatus.STALE_RESOURCE
    return IncidentStatus.FAILED


def _require_repair_status_path(
    current: IncidentStatus,
    terminal: RepairTerminalRecord,
    target: IncidentStatus,
) -> None:
    _require_incident_transition(current, IncidentStatus.DIAGNOSED)
    current = IncidentStatus.DIAGNOSED
    if terminal.proposal is not None:
        _require_incident_transition(current, IncidentStatus.PATCH_READY)
        current = IncidentStatus.PATCH_READY
    if terminal.error_code is None:
        _require_incident_transition(current, IncidentStatus.DRY_RUN_PASSED)
        _require_incident_transition(
            IncidentStatus.DRY_RUN_PASSED,
            IncidentStatus.WAITING_APPROVAL,
        )
    else:
        _require_incident_transition(current, target)


def _repair_event_documents(
    terminal: RepairTerminalRecord,
    incident_id: UUID,
    persisted_diagnosis_id: UUID,
) -> tuple[tuple[str, str, datetime, dict[str, JsonValue]], ...]:
    diagnosis_payload = _base_payload(
        incident_id,
        terminal.run_id,
        terminal.diagnosis_completed_at,
    )
    diagnosis_payload.update(
        {
            "diagnosisId": str(persisted_diagnosis_id),
            "outcome": DiagnosisOutcome.DIAGNOSED.value,
            "incidentStatus": IncidentStatus.DIAGNOSED.value,
            "runStatus": RunStatus.RUNNING.value,
        }
    )
    documents: list[tuple[str, str, datetime, dict[str, JsonValue]]] = [
        (
            "diagnosis.completed",
            "diagnosis.completed",
            terminal.diagnosis_completed_at,
            diagnosis_payload,
        )
    ]
    proposal = terminal.proposal
    validation = terminal.validation
    if proposal is not None:
        patch_payload = _base_payload(
            incident_id,
            terminal.run_id,
            proposal.diff_checked_at,
        )
        patch_payload.update(
            {
                "proposalId": str(proposal.id),
                "proposalDigest": proposal.digest,
                "incidentStatus": IncidentStatus.PATCH_READY.value,
                "runStatus": RunStatus.RUNNING.value,
            }
        )
        documents.append(
            (
                "repair.patch_ready",
                "repair.patch_ready",
                proposal.diff_checked_at,
                patch_payload,
            )
        )
    if (
        proposal is not None
        and validation is not None
        and validation.outcome == "passed"
    ):
        dry_run_payload = _base_payload(
            incident_id,
            terminal.run_id,
            validation.checked_at,
        )
        dry_run_payload.update(
            {
                "proposalId": str(proposal.id),
                "proposalDigest": proposal.digest,
                "incidentStatus": IncidentStatus.DRY_RUN_PASSED.value,
                "runStatus": RunStatus.RUNNING.value,
            }
        )
        waiting_payload = _base_payload(
            incident_id,
            terminal.run_id,
            terminal.completed_at,
        )
        waiting_payload.update(
            {
                "proposalId": str(proposal.id),
                "proposalDigest": proposal.digest,
                "incidentStatus": IncidentStatus.WAITING_APPROVAL.value,
                "runStatus": RunStatus.COMPLETED.value,
            }
        )
        documents.extend(
            (
                (
                    "repair.dry_run_passed",
                    "repair.dry_run_passed",
                    validation.checked_at,
                    dry_run_payload,
                ),
                (
                    "run:terminal",
                    "repair.waiting_approval",
                    terminal.completed_at,
                    waiting_payload,
                ),
            )
        )
    else:
        if terminal.error_code is None or terminal.error_retryable is None:
            raise RecoveryConsistencyError
        failed_payload = _base_payload(
            incident_id,
            terminal.run_id,
            terminal.completed_at,
        )
        failed_payload.update(
            {
                "errorCode": terminal.error_code,
                "retryable": terminal.error_retryable,
                "incidentStatus": _repair_incident_status(terminal).value,
                "runStatus": RunStatus.FAILED.value,
            }
        )
        documents.append(
            (
                "run:terminal",
                "run.failed",
                terminal.completed_at,
                failed_payload,
            )
        )
    return tuple(documents)


def _resolve_repair_terminal_replay(
    terminal: RepairTerminalRecord,
    run: RunRow,
    incident: IncidentRow,
    diagnosis: DiagnosisRow | None,
    proposal: RepairProposalRow | None,
    managed_events: tuple[RunEventRow, ...],
) -> PersistedTerminal:
    diagnosis_record = _diagnosis_terminal_record(terminal)
    persisted_diagnosis_id = diagnosis_id(terminal.run_id)
    if diagnosis is None or not _diagnosis_matches(diagnosis, diagnosis_record):
        raise RecoveryConsistencyError
    if not _repair_row_matches(proposal, terminal):
        raise RecoveryConsistencyError

    incident_id = UUID(incident.id)
    expected_documents = _repair_event_documents(
        terminal,
        incident_id,
        persisted_diagnosis_id,
    )
    if len(managed_events) != len(expected_documents):
        raise RecoveryConsistencyError
    for row, (event_key, event_type, occurred_at, payload) in zip(
        managed_events,
        expected_documents,
        strict=True,
    ):
        if not _event_matches(
            row,
            incident_id=incident_id,
            run_id=terminal.run_id,
            event_key=event_key,
            event_type=event_type,
            occurred_at=occurred_at,
            payload=payload,
        ):
            raise RecoveryConsistencyError

    incident_target = _repair_incident_status(terminal)
    run_target = _repair_run_status(terminal)
    if (
        run.status is not run_target
        or run.completed_at is None
        or _database_datetime(run.completed_at) != terminal.completed_at
        or _database_datetime(run.updated_at) != terminal.completed_at
        or run.model_calls != terminal.model_calls
        or run.tool_calls != terminal.tool_calls
        or run.input_tokens != terminal.input_tokens
        or run.output_tokens != terminal.output_tokens
        or run.error_code != terminal.error_code
        or run.error_retryable != terminal.error_retryable
    ):
        raise RecoveryConsistencyError
    return PersistedTerminal(
        run_id=terminal.run_id,
        incident_status=incident_target,
        run_status=run_target,
        diagnosis_id=persisted_diagnosis_id,
        event=_event_from_row(
            managed_events[-1],
            expected_incident_id=incident_id,
        ),
    )


def _repair_row_matches(
    row: RepairProposalRow | None,
    terminal: RepairTerminalRecord,
) -> bool:
    if terminal.proposal is None or terminal.validation is None:
        return row is None
    if row is None:
        return False
    proposal_json = canonical_json(
        cast(dict[str, JsonValue], terminal.proposal.model_dump(mode="json"))
    )
    validation_json = canonical_json(
        cast(dict[str, JsonValue], terminal.validation.model_dump(mode="json"))
    )
    return (
        row.id == str(terminal.proposal.id)
        and row.run_id == str(terminal.run_id)
        and row.schema_version == terminal.proposal.schema_version
        and row.proposal_json == proposal_json
        and row.validation_json == validation_json
        and _database_datetime(row.created_at) == terminal.proposal.diff_checked_at
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
        # A row written before this column cannot be compared on it; every other
        # diagnosis field still has to match for a replay to be accepted.
        and (
            row.recommendations_json is None
            or row.recommendations_json
            == _recommendations_json(terminal.recommendations)
        )
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


def _recommendations_json(
    recommendations: tuple[RecommendationRecord, ...] | None,
) -> str | None:
    if recommendations is None:
        return None
    values: list[JsonValue] = []
    for recommendation in recommendations:
        values.append(
            {
                "action": recommendation.action,
                "purpose": recommendation.purpose,
                "preconditions": recommendation.preconditions,
                "risk": recommendation.risk,
                "verification": recommendation.verification,
                "evidence_ids": [str(value) for value in recommendation.evidence_ids],
            }
        )
    return canonical_json(values)


def _recommendation_records(
    diagnosis: DiagnosisRow,
    validated: ValidatedDiagnosis,
) -> tuple[RecommendationRecord, ...] | None:
    if diagnosis.recommendations_json is None:
        return None
    return recommendation_records(validated.recommendations)


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


def _database_alert_timestamp(value: str) -> CanonicalAlertTimestamp:
    if _CANONICAL_ALERT_TIMESTAMP.fullmatch(value) is None:
        raise ValueError("Persisted alert timestamp is invalid")
    try:
        datetime.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        raise ValueError("Persisted alert timestamp is invalid") from None
    return CanonicalAlertTimestamp(value)


def _rfc3339(value: datetime) -> str:
    return _database_datetime(value).isoformat().replace("+00:00", "Z")
