from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Final, Literal, NewType
from uuid import UUID

from k8s_incident_agent.domain.contracts import (
    IncidentSource,
    KubernetesTarget,
    NormalizedIncidentTrigger,
    RepairHistorySelection,
)
from k8s_incident_agent.execution.contracts import ApprovalRecord, ExecutionRecord
from k8s_incident_agent.repair.verification_contracts import VerificationRecord

type JsonScalar = str | int | float | bool | None
type JsonValue = JsonScalar | list[JsonValue] | dict[str, JsonValue]

CANONICAL_ALERT_TIMESTAMP_PATTERN: Final = (
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$"
)
CanonicalAlertTimestamp = NewType("CanonicalAlertTimestamp", str)


class IncidentStatus(StrEnum):
    RECEIVED = "RECEIVED"
    TRIAGING = "TRIAGING"
    DIAGNOSED = "DIAGNOSED"
    PATCH_READY = "PATCH_READY"
    DRY_RUN_PASSED = "DRY_RUN_PASSED"
    WAITING_APPROVAL = "WAITING_APPROVAL"
    APPLYING = "APPLYING"
    VERIFYING = "VERIFYING"
    RESOLVED = "RESOLVED"
    ROLLED_BACK = "ROLLED_BACK"
    REJECTED = "REJECTED"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    STALE_RESOURCE = "STALE_RESOURCE"
    FAILED = "FAILED"

    def can_transition_to(self, target: IncidentStatus) -> bool:
        return target in _INCIDENT_TRANSITIONS[self]


class RunStatus(StrEnum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    WAITING_APPROVAL = "WAITING_APPROVAL"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"

    def can_transition_to(self, target: RunStatus) -> bool:
        return target in _RUN_TRANSITIONS[self]


class RunKind(StrEnum):
    DIAGNOSIS = "diagnosis"
    REPAIR = "repair"


class RepairOperation(StrEnum):
    APPLY = "apply"
    ROLLBACK = "rollback"


class AlertSignalStatus(StrEnum):
    FIRING = "FIRING"
    RESOLVED = "RESOLVED"


class DiagnosisOutcome(StrEnum):
    DIAGNOSED = "diagnosed"
    INSUFFICIENT_EVIDENCE = "insufficient_evidence"

    @property
    def incident_status(self) -> IncidentStatus:
        if self is DiagnosisOutcome.DIAGNOSED:
            return IncidentStatus.DIAGNOSED
        return IncidentStatus.INSUFFICIENT_EVIDENCE


@dataclass(frozen=True, slots=True)
class ModelSnapshot:
    provider: str
    model_id: str
    thinking_mode: bool
    prompt_version: str


@dataclass(frozen=True, slots=True)
class RunBudget:
    max_model_calls: int
    max_tool_calls: int
    timeout_seconds: int


@dataclass(frozen=True, slots=True)
class RunEvent:
    id: int
    incident_id: UUID
    run_id: UUID
    event_key: str
    event_type: str
    occurred_at: datetime
    payload: dict[str, JsonValue]


@dataclass(frozen=True, slots=True)
class CreatedIncident:
    incident_id: UUID
    run_id: UUID
    incident_status: IncidentStatus
    run_status: RunStatus
    event: RunEvent


@dataclass(frozen=True, slots=True)
class CreatedRun:
    run_id: UUID


@dataclass(frozen=True, slots=True)
class NormalizedAlertOccurrence:
    trigger: NormalizedIncidentTrigger
    fingerprint: str
    starts_at: CanonicalAlertTimestamp
    status: AlertSignalStatus
    ends_at: CanonicalAlertTimestamp | None


@dataclass(frozen=True, slots=True)
class AlertSignalRecord:
    status: AlertSignalStatus
    starts_at: CanonicalAlertTimestamp
    ends_at: CanonicalAlertTimestamp | None


@dataclass(frozen=True, slots=True)
class PersistedAlertBatch:
    created_run_ids: tuple[UUID, ...]
    events: tuple[RunEvent, ...]
    blocked_new_firing: bool


@dataclass(frozen=True, slots=True)
class RunRecord:
    id: UUID
    incident_id: UUID
    status: RunStatus
    incident_status: IncidentStatus
    started_at: datetime
    event: RunEvent


@dataclass(frozen=True, slots=True)
class AgentRunSnapshot:
    id: UUID
    started_at: datetime
    timeout_seconds: int


@dataclass(frozen=True, slots=True)
class _WorkflowRunSnapshot:
    id: UUID
    incident_id: UUID
    source: IncidentSource
    run_status: RunStatus
    trigger_summary: str
    target: KubernetesTarget
    started_at: datetime | None


@dataclass(frozen=True, slots=True)
class DiagnosisWorkflowRunSnapshot(_WorkflowRunSnapshot):
    model: ModelSnapshot
    budget: RunBudget
    kind: Literal[RunKind.DIAGNOSIS] = field(default=RunKind.DIAGNOSIS, init=False)


@dataclass(frozen=True, slots=True)
class RepairWorkflowRunSnapshot(_WorkflowRunSnapshot):
    operation: RepairOperation
    timeout_seconds: int
    source_run_id: UUID
    selection: RepairHistorySelection | None
    waiting_expires_at: datetime | None
    proposal_id: UUID | None
    end_reason: Literal["expired", "superseded", "rejected", "execution_expired"] | None
    approval: ApprovalRecord | None = None
    execution: ExecutionRecord | None = None
    verification: VerificationRecord | None = None
    kind: Literal[RunKind.REPAIR] = field(default=RunKind.REPAIR, init=False)


type WorkflowRunSnapshot = DiagnosisWorkflowRunSnapshot | RepairWorkflowRunSnapshot


@dataclass(frozen=True, slots=True)
class EvidenceRecord:
    run_id: UUID
    tool_call_id: str
    tool_name: str
    evidence_kind: str
    target_ref: dict[str, JsonValue]
    observed_at: datetime
    payload: dict[str, JsonValue]
    truncated: bool
    redacted: bool


@dataclass(frozen=True, slots=True)
class PersistedEvidence:
    id: UUID
    run_id: UUID
    tool_call_id: str
    tool_name: str
    evidence_kind: str
    target_ref: dict[str, JsonValue]
    observed_at: datetime
    payload: dict[str, JsonValue]
    truncated: bool
    redacted: bool
    event: RunEvent


@dataclass(frozen=True, slots=True)
class ToolFailureRecord:
    run_id: UUID
    tool_call_id: str
    tool_name: str
    error_code: str
    retryable: bool
    occurred_at: datetime


@dataclass(frozen=True, slots=True)
class DiagnosisValidationSnapshot:
    evidence_by_id: dict[UUID, PersistedEvidence]
    tool_failures: tuple[ToolFailureRecord, ...]
    unresolved_tool_failures: tuple[ToolFailureRecord, ...]


@dataclass(frozen=True, slots=True)
class RootCauseRecord:
    code: str
    statement: str
    confidence: Literal["low", "medium", "high"]
    evidence_ids: tuple[UUID, ...]


@dataclass(frozen=True, slots=True)
class TerminalRecord:
    run_id: UUID
    completed_at: datetime
    outcome: DiagnosisOutcome | None
    summary: str | None
    root_causes: tuple[RootCauseRecord, ...]
    missing_information: tuple[str, ...]
    redacted: bool
    error_code: str | None
    error_retryable: bool | None
    model_calls: int | None
    tool_calls: int | None
    input_tokens: int | None
    output_tokens: int | None

    def __post_init__(self) -> None:
        if self.outcome is not None:
            if (
                self.summary is None
                or self.error_code is not None
                or self.error_retryable is not None
            ):
                raise ValueError("Diagnosis terminal record contains invalid fields")
            return
        if self.error_code is None or self.error_retryable is None:
            raise ValueError("Failure terminal record requires an error")
        if (
            self.summary is not None
            or self.root_causes
            or self.missing_information
            or self.redacted
        ):
            raise ValueError("Failure terminal record must not contain diagnosis data")


@dataclass(frozen=True, slots=True)
class PersistedTerminal:
    run_id: UUID
    incident_status: IncidentStatus
    run_status: RunStatus
    diagnosis_id: UUID | None
    event: RunEvent


_INCIDENT_TRANSITIONS: Final[dict[IncidentStatus, frozenset[IncidentStatus]]] = {
    IncidentStatus.RECEIVED: frozenset(
        {IncidentStatus.TRIAGING, IncidentStatus.FAILED}
    ),
    IncidentStatus.TRIAGING: frozenset(
        {
            IncidentStatus.DIAGNOSED,
            IncidentStatus.INSUFFICIENT_EVIDENCE,
            IncidentStatus.FAILED,
        }
    ),
    IncidentStatus.DIAGNOSED: frozenset(
        {
            IncidentStatus.TRIAGING,
            IncidentStatus.PATCH_READY,
            IncidentStatus.FAILED,
        }
    ),
    IncidentStatus.PATCH_READY: frozenset(
        {
            IncidentStatus.DRY_RUN_PASSED,
            IncidentStatus.STALE_RESOURCE,
            IncidentStatus.FAILED,
        }
    ),
    IncidentStatus.DRY_RUN_PASSED: frozenset(
        {IncidentStatus.WAITING_APPROVAL, IncidentStatus.FAILED}
    ),
    IncidentStatus.WAITING_APPROVAL: frozenset(
        {
            IncidentStatus.TRIAGING,
            IncidentStatus.FAILED,
            IncidentStatus.APPLYING,
            IncidentStatus.REJECTED,
        }
    ),
    IncidentStatus.APPLYING: frozenset(
        {IncidentStatus.VERIFYING, IncidentStatus.FAILED, IncidentStatus.STALE_RESOURCE}
    ),
    IncidentStatus.VERIFYING: frozenset(
        {IncidentStatus.FAILED, IncidentStatus.RESOLVED, IncidentStatus.ROLLED_BACK}
    ),
    IncidentStatus.RESOLVED: frozenset({IncidentStatus.TRIAGING}),
    IncidentStatus.ROLLED_BACK: frozenset({IncidentStatus.TRIAGING}),
    IncidentStatus.REJECTED: frozenset({IncidentStatus.TRIAGING}),
    IncidentStatus.INSUFFICIENT_EVIDENCE: frozenset(
        {IncidentStatus.TRIAGING, IncidentStatus.FAILED}
    ),
    IncidentStatus.FAILED: frozenset({IncidentStatus.TRIAGING, IncidentStatus.FAILED}),
    IncidentStatus.STALE_RESOURCE: frozenset(
        {IncidentStatus.TRIAGING, IncidentStatus.FAILED}
    ),
}

_RUN_TRANSITIONS: Final[dict[RunStatus, frozenset[RunStatus]]] = {
    RunStatus.QUEUED: frozenset({RunStatus.RUNNING, RunStatus.FAILED}),
    RunStatus.RUNNING: frozenset(
        {RunStatus.WAITING_APPROVAL, RunStatus.COMPLETED, RunStatus.FAILED}
    ),
    RunStatus.WAITING_APPROVAL: frozenset(
        {RunStatus.RUNNING, RunStatus.COMPLETED, RunStatus.FAILED}
    ),
    RunStatus.COMPLETED: frozenset(),
    RunStatus.FAILED: frozenset(),
}
