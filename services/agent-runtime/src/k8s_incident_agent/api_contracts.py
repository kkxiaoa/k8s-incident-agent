from datetime import datetime, timedelta
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    WithJsonSchema,
    field_validator,
)

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


_JsonObject = Annotated[
    dict[str, JsonValue],
    WithJsonSchema({"type": "object", "additionalProperties": True}),
]


class HealthResponse(_ApiContract):
    status: Literal["ok"] = "ok"


class ScenarioTriggerResponse(_ApiContract):
    type: Literal["manual"]
    summary: str


class ScenarioTargetResponse(_ApiContract):
    cluster: str
    namespace: str
    api_version: str
    kind: str
    name: str


class IncidentTargetResponse(_ApiContract):
    cluster: str
    namespace: str | None
    api_version: str
    kind: str
    name: str


class IncidentSourceResponse(_ApiContract):
    type: Literal["scenario"]
    ref: str | None
    revision: str | None


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
    schema_version: Literal[2] = 2
    incident_id: UUID


class CreateRunResponse(_ApiContract):
    schema_version: Literal[2] = 2
    run_id: UUID


class IncidentListItem(_ApiContract):
    id: UUID
    display_name: str
    target: IncidentTargetResponse
    status: IncidentStatus
    updated_at: datetime


class IncidentListResponse(_ApiContract):
    schema_version: Literal[2] = 2
    items: tuple[IncidentListItem, ...]
    next_cursor: str | None


class IncidentResponse(_ApiContract):
    id: UUID
    source: IncidentSourceResponse
    display_name: str
    trigger_summary: str
    target: IncidentTargetResponse
    status: IncidentStatus
    created_at: datetime


class RunErrorResponse(_ApiContract):
    code: str
    retryable: bool


class RunSummaryResponse(_ApiContract):
    id: UUID
    attempt: int = Field(ge=1)
    status: RunStatus
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None


class SelectedRunResponse(RunSummaryResponse):
    error: RunErrorResponse | None


class RunHistoryResponse(_ApiContract):
    schema_version: Literal[2] = 2
    items: tuple[RunSummaryResponse, ...]
    next_cursor: str | None


class EvidenceResponse(_ApiContract):
    id: UUID
    tool_call_id: str
    tool_name: str
    evidence_kind: str
    target_ref: _JsonObject
    observed_at: datetime
    payload: _JsonObject
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


class RunEventPayload(_ApiContract):
    schema_version: Literal[2]
    incident_id: UUID
    run_id: UUID
    occurred_at: datetime

    @field_validator("occurred_at")
    @classmethod
    def require_utc_occurred_at(cls, value: datetime) -> datetime:
        return _require_utc_datetime(value, "occurredAt")


class IncidentCreatedEventPayload(RunEventPayload):
    attempt: int = Field(ge=1)
    incident_status: Literal["RECEIVED"]
    run_status: Literal["QUEUED"]


class RunQueuedEventPayload(RunEventPayload):
    attempt: int = Field(ge=2)
    run_status: Literal["QUEUED"]


class RunStartedEventPayload(RunEventPayload):
    attempt: int = Field(ge=1)
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


class IncidentCreatedStreamEvent(_ApiContract):
    id: str
    event: Literal["incident.created"]
    data: IncidentCreatedEventPayload


class RunQueuedStreamEvent(_ApiContract):
    id: str
    event: Literal["run.queued"]
    data: RunQueuedEventPayload


class RunStartedStreamEvent(_ApiContract):
    id: str
    event: Literal["run.started"]
    data: RunStartedEventPayload


class ToolStartedStreamEvent(_ApiContract):
    id: str
    event: Literal["tool.started"]
    data: ToolStartedEventPayload


class EvidenceRecordedStreamEvent(_ApiContract):
    id: str
    event: Literal["evidence.recorded"]
    data: EvidenceRecordedEventPayload


class ToolFailedStreamEvent(_ApiContract):
    id: str
    event: Literal["tool.failed"]
    data: ToolFailedEventPayload


class DiagnosisCompletedStreamEvent(_ApiContract):
    id: str
    event: Literal["diagnosis.completed"]
    data: DiagnosisCompletedEventPayload


class DiagnosisInsufficientStreamEvent(_ApiContract):
    id: str
    event: Literal["diagnosis.insufficient"]
    data: DiagnosisInsufficientEventPayload


class RunFailedStreamEvent(_ApiContract):
    id: str
    event: Literal["run.failed"]
    data: RunFailedEventPayload


class RunEventStreamItem(
    RootModel[
        Annotated[
            IncidentCreatedStreamEvent
            | RunQueuedStreamEvent
            | RunStartedStreamEvent
            | ToolStartedStreamEvent
            | EvidenceRecordedStreamEvent
            | ToolFailedStreamEvent
            | DiagnosisCompletedStreamEvent
            | DiagnosisInsufficientStreamEvent
            | RunFailedStreamEvent,
            Field(discriminator="event"),
        ]
    ]
):
    pass


class EventPageResponse(_ApiContract):
    items: tuple[RunEventStreamItem, ...]
    next_cursor: str | None


class RunEventHistoryResponse(_ApiContract):
    schema_version: Literal[2] = 2
    items: tuple[RunEventStreamItem, ...]
    next_cursor: str | None


class IncidentDetailResponse(_ApiContract):
    schema_version: Literal[2] = 2
    incident: IncidentResponse
    selected_run: SelectedRunResponse
    event_page: EventPageResponse
    evidence: tuple[EvidenceResponse, ...]
    diagnosis: DiagnosisResponse | None
    event_cursor: str = Field(pattern=r"^[1-9][0-9]*$")


class ErrorDetail(_ApiContract):
    code: str
    message: str
    retryable: bool


class ErrorResponse(_ApiContract):
    error: ErrorDetail


def error_responses(*status_codes: int) -> dict[int | str, dict[str, Any]]:
    return {status_code: {"model": ErrorResponse} for status_code in status_codes}
