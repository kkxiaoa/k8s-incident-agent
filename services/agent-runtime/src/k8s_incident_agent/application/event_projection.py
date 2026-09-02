from pydantic import ValidationError

from k8s_incident_agent.api_contracts import (
    EvidenceRecordedEventPayload,
    RunEventPayload,
    RunEventStreamItem,
    RunFailedEventPayload,
    ToolFailedEventPayload,
    ToolStartedEventPayload,
)
from k8s_incident_agent.diagnosis.tool_execution import (
    validate_diagnostic_tool_failure_contract,
)
from k8s_incident_agent.domain.models import RunEvent
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.persistence.repositories import RecoveryConsistencyError
from k8s_incident_agent.workflow.failures import require_terminal_error_contract


def validated_stream_item(event: RunEvent) -> RunEventStreamItem:
    try:
        stream_item = RunEventStreamItem.model_validate_json(
            canonical_json(
                {
                    "id": str(event.id),
                    "event": event.event_type,
                    "data": event.payload,
                }
            )
        )
    except ValidationError:
        raise RecoveryConsistencyError from None
    payload = stream_item.root.data
    if isinstance(payload, ToolFailedEventPayload):
        try:
            validate_diagnostic_tool_failure_contract(
                payload.tool_name,
                payload.error_code,
                retryable=payload.retryable,
            )
        except ValueError:
            raise RecoveryConsistencyError from None
    elif isinstance(payload, RunFailedEventPayload):
        require_terminal_error_contract(payload.error_code, payload.retryable)
    if (
        payload.incident_id != event.incident_id
        or payload.run_id != event.run_id
        or payload.occurred_at != event.occurred_at
        or _event_payload(payload) != event.payload
        or event.event_key != _expected_event_key(event.event_type, payload)
    ):
        raise RecoveryConsistencyError
    return stream_item


def _event_payload(payload: RunEventPayload) -> dict[str, object]:
    serialized = payload.model_dump(mode="json")
    if isinstance(payload, ToolStartedEventPayload) and payload.call_identity is None:
        serialized.pop("callIdentity")
    return serialized


def validated_event_json(event: RunEvent) -> str:
    validated_stream_item(event)
    return canonical_json(event.payload)


def _expected_event_key(event_type: str, payload: RunEventPayload) -> str:
    if event_type in {"diagnosis.completed", "diagnosis.insufficient", "run.failed"}:
        return "run:terminal"
    suffix = {
        "tool.started": "started",
        "evidence.recorded": "evidence",
        "tool.failed": "failed",
    }.get(event_type)
    if suffix is None:
        return event_type
    if not isinstance(
        payload,
        (ToolStartedEventPayload, EvidenceRecordedEventPayload, ToolFailedEventPayload),
    ):
        raise RecoveryConsistencyError
    return f"tool:{payload.tool_call_id}:{suffix}"
