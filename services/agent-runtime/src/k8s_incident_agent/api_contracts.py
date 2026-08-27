from datetime import datetime, timedelta
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from k8s_incident_agent.domain.models import (
    DiagnosisOutcome,
    IncidentStatus,
    JsonValue,
    RunStatus,
)


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


def _require_utc_datetime(value: datetime, field_name: str) -> datetime:
    if value.utcoffset() != timedelta(0):
        raise ValueError(f"{field_name} must use UTC")
    return value


class _ApiContract(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        serialize_by_alias=True,
        strict=True,
    )


class ScenarioTriggerResponse(_ApiContract):
    type: Literal["manual"]
    summary: str


class ScenarioTargetResponse(_ApiContract):
    cluster: str
    namespace: str
    api_version: str
    kind: str
    name: str


class ScenarioResponse(_ApiContract):
    scenario_id: str
    scenario_version: int
    display_name: str
    description: str
    trigger: ScenarioTriggerResponse
    target: ScenarioTargetResponse


class ScenarioListResponse(_ApiContract):
    schema_version: Literal[1] = 1
    items: tuple[ScenarioResponse, ...]


class CreateIncidentRequest(_ApiContract):
    scenario_id: str = Field(min_length=1)

    @field_validator("scenario_id")
    @classmethod
    def require_normalized_scenario_id(cls, value: str) -> str:
        if value != value.strip() or any(
            ord(character) < 0x20 or ord(character) == 0x7F for character in value
        ):
            raise ValueError("scenarioId must be normalized")
        return value


class CreateIncidentResponse(_ApiContract):
    schema_version: Literal[1] = 1
    incident_id: UUID
    run_id: UUID
    incident_status: IncidentStatus
    run_status: RunStatus


class IncidentListItem(_ApiContract):
    id: UUID
    scenario_id: str
    scenario_version: int
    display_name: str
    target: ScenarioTargetResponse
    status: IncidentStatus
    created_at: datetime
    updated_at: datetime


class IncidentListResponse(_ApiContract):
    schema_version: Literal[1] = 1
    items: tuple[IncidentListItem, ...]
    next_cursor: str | None


class IncidentResponse(_ApiContract):
    id: UUID
    scenario_id: str
    scenario_version: int
    display_name: str
    trigger_summary: str
    target: ScenarioTargetResponse
    status: IncidentStatus
    created_at: datetime
    updated_at: datetime


class RunBudgetResponse(_ApiContract):
    max_model_calls: int
    max_tool_calls: int
    timeout_seconds: int


class RunUsageResponse(_ApiContract):
    model_calls: int | None
    tool_calls: int | None
    input_tokens: int | None
    output_tokens: int | None


class RunErrorResponse(_ApiContract):
    code: str
    retryable: bool


class RunResponse(_ApiContract):
    id: UUID
    status: RunStatus
    model_provider: str
    model_id: str
    thinking_mode: bool
    prompt_version: str
    budget: RunBudgetResponse
    usage: RunUsageResponse
    error: RunErrorResponse | None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None


class EvidenceResponse(_ApiContract):
    id: UUID
    tool_call_id: str
    tool_name: str
    evidence_kind: str
    target_ref: dict[str, JsonValue]
    observed_at: datetime
    payload: dict[str, JsonValue]
    truncated: bool
    redacted: bool


class RootCauseResponse(_ApiContract):
    code: str
    statement: str
    confidence: Literal["low", "medium", "high"]
    evidence_ids: tuple[UUID, ...]


class DiagnosisResponse(_ApiContract):
    id: UUID
    outcome: DiagnosisOutcome
    summary: str
    root_causes: tuple[RootCauseResponse, ...]
    missing_information: tuple[str, ...]
    redacted: bool
    created_at: datetime


class IncidentDetailResponse(_ApiContract):
    schema_version: Literal[1] = 1
    incident: IncidentResponse
    run: RunResponse
    evidence: tuple[EvidenceResponse, ...]
    diagnosis: DiagnosisResponse | None


class RunEventPayload(_ApiContract):
    schema_version: Literal[1]
    incident_id: UUID
    run_id: UUID
    occurred_at: datetime

    @field_validator("occurred_at")
    @classmethod
    def require_utc_occurred_at(cls, value: datetime) -> datetime:
        return _require_utc_datetime(value, "occurredAt")


class IncidentCreatedEventPayload(RunEventPayload):
    scenario_id: str
    incident_status: Literal["RECEIVED"]
    run_status: Literal["QUEUED"]


class RunStartedEventPayload(RunEventPayload):
    incident_status: Literal["TRIAGING"]
    run_status: Literal["RUNNING"]


class ToolStartedEventPayload(RunEventPayload):
    tool_call_id: str
    tool_name: str


class EvidenceRecordedEventPayload(RunEventPayload):
    evidence_id: UUID
    tool_call_id: str
    tool_name: str
    evidence_kind: str
    observed_at: datetime
    truncated: bool
    redacted: bool

    @field_validator("observed_at")
    @classmethod
    def require_utc_observed_at(cls, value: datetime) -> datetime:
        return _require_utc_datetime(value, "observedAt")


class ToolFailedEventPayload(RunEventPayload):
    tool_call_id: str
    tool_name: str
    error_code: str
    retryable: bool


class DiagnosisCompletedEventPayload(RunEventPayload):
    diagnosis_id: UUID
    outcome: Literal["diagnosed"]
    incident_status: Literal["DIAGNOSED"]
    run_status: Literal["COMPLETED"]


class DiagnosisInsufficientEventPayload(RunEventPayload):
    diagnosis_id: UUID
    outcome: Literal["insufficient_evidence"]
    incident_status: Literal["INSUFFICIENT_EVIDENCE"]
    run_status: Literal["COMPLETED"]


class RunFailedEventPayload(RunEventPayload):
    error_code: str
    retryable: bool
    incident_status: Literal["FAILED"]
    run_status: Literal["FAILED"]


class ErrorDetail(_ApiContract):
    code: str
    message: str
    retryable: bool


class ErrorResponse(_ApiContract):
    error: ErrorDetail
