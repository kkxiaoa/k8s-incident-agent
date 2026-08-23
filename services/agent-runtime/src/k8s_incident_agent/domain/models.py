from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Final, Literal
from uuid import UUID

type JsonScalar = str | int | float | bool | None
type JsonValue = JsonScalar | list[JsonValue] | dict[str, JsonValue]


class IncidentStatus(StrEnum):
    RECEIVED = "RECEIVED"
    TRIAGING = "TRIAGING"
    DIAGNOSED = "DIAGNOSED"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    FAILED = "FAILED"

    def can_transition_to(self, target: IncidentStatus) -> bool:
        return target in _INCIDENT_TRANSITIONS[self]


class RunStatus(StrEnum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"

    def can_transition_to(self, target: RunStatus) -> bool:
        return target in _RUN_TRANSITIONS[self]


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
    evidence_ids: frozenset[UUID]
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
    IncidentStatus.DIAGNOSED: frozenset(),
    IncidentStatus.INSUFFICIENT_EVIDENCE: frozenset(),
    IncidentStatus.FAILED: frozenset(),
}

_RUN_TRANSITIONS: Final[dict[RunStatus, frozenset[RunStatus]]] = {
    RunStatus.QUEUED: frozenset({RunStatus.RUNNING, RunStatus.FAILED}),
    RunStatus.RUNNING: frozenset({RunStatus.COMPLETED, RunStatus.FAILED}),
    RunStatus.COMPLETED: frozenset(),
    RunStatus.FAILED: frozenset(),
}
