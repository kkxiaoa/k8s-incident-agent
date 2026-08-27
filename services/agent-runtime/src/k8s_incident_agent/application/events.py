import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Final
from uuid import UUID

from pydantic import ValidationError

from k8s_incident_agent.api_contracts import (
    EvidenceRecordedEventPayload,
    RunEventPayload,
    RunEventStreamItem,
    RunFailedEventPayload,
    ToolFailedEventPayload,
    ToolStartedEventPayload,
)
from k8s_incident_agent.application.incidents import IncidentNotFoundError
from k8s_incident_agent.domain.models import RunEvent
from k8s_incident_agent.kubernetes.errors import validate_kubernetes_failure_contract
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    RecoveryConsistencyError,
)
from k8s_incident_agent.workflow.failures import require_terminal_error_contract

_MAX_EVENT_ID: Final = 2**63 - 1
_REPLAY_BATCH_SIZE: Final = 100
_HEARTBEAT_SECONDS: Final = 15.0
_TERMINAL_EVENT_TYPES: Final = frozenset(
    {"diagnosis.completed", "diagnosis.insufficient", "run.failed"}
)


class InvalidLastEventIdError(RuntimeError):
    pass


class RunEventNotifier:
    def __init__(self) -> None:
        self._waiters: dict[UUID, set[asyncio.Event]] = {}

    async def notify(self, incident_id: UUID) -> None:
        for waiter in tuple(self._waiters.get(incident_id, ())):
            waiter.set()

    async def wait(self, incident_id: UUID, timeout_seconds: float) -> bool:
        if timeout_seconds <= 0:
            raise ValueError("Event wait timeout must be positive")
        waiter = asyncio.Event()
        waiters = self._waiters.setdefault(incident_id, set())
        waiters.add(waiter)
        try:
            await asyncio.wait_for(waiter.wait(), timeout_seconds)
        except TimeoutError:
            return False
        finally:
            waiters.discard(waiter)
            if not waiters:
                self._waiters.pop(incident_id, None)
        return True


@dataclass(frozen=True, slots=True)
class EventDependencies:
    repository: IncidentRepository
    notifier: RunEventNotifier


class IncidentEventService:
    def __init__(self, dependencies: EventDependencies) -> None:
        self._dependencies = dependencies

    async def open_stream(
        self,
        incident_id: UUID,
        last_event_id_header: str | None,
    ) -> AsyncIterator[bytes]:
        last_event_id = _parse_last_event_id(last_event_id_header)
        repository = self._dependencies.repository
        if not await repository.incident_exists(incident_id):
            raise IncidentNotFoundError
        cursor_event = None
        if last_event_id != 0:
            cursor_event = await repository.get_incident_event(
                incident_id,
                last_event_id,
            )
            if cursor_event is None:
                raise InvalidLastEventIdError
            _validated_event_json(cursor_event)

        async def stream() -> AsyncIterator[bytes]:
            if (
                cursor_event is not None
                and cursor_event.event_type in _TERMINAL_EVENT_TYPES
            ):
                return
            async for data in stream_incident_events(
                incident_id,
                last_event_id,
                self._dependencies,
            ):
                yield data

        return stream()


async def stream_incident_events(
    incident_id: UUID,
    last_event_id: int,
    dependencies: EventDependencies,
) -> AsyncIterator[bytes]:
    cursor = last_event_id
    while True:
        events = await dependencies.repository.list_incident_events(
            incident_id,
            after_id=cursor,
            limit=_REPLAY_BATCH_SIZE,
        )
        if events:
            for event in events:
                data = _serialize_event(event)
                cursor = event.id
                terminal = event.event_type in _TERMINAL_EVENT_TYPES
                yield data
                if terminal:
                    return
            continue

        notified = await dependencies.notifier.wait(
            incident_id,
            _HEARTBEAT_SECONDS,
        )
        if not notified:
            yield b": heartbeat\n\n"


def _parse_last_event_id(value: str | None) -> int:
    if value is None:
        return 0
    if not value or any(character < "0" or character > "9" for character in value):
        raise InvalidLastEventIdError
    normalized = value.lstrip("0") or "0"
    if len(normalized) > len(str(_MAX_EVENT_ID)):
        raise InvalidLastEventIdError
    parsed = int(normalized)
    if parsed > _MAX_EVENT_ID:
        raise InvalidLastEventIdError
    return parsed


def _serialize_event(event: RunEvent) -> bytes:
    document = _validated_event_json(event)
    return (f"id: {event.id}\nevent: {event.event_type}\ndata: {document}\n\n").encode()


def _validated_event_json(event: RunEvent) -> str:
    document = canonical_json(event.payload)
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
            validate_kubernetes_failure_contract(
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
        or payload.model_dump(mode="json") != event.payload
        or event.event_key != _expected_event_key(event.event_type, payload)
    ):
        raise RecoveryConsistencyError
    return document


def _expected_event_key(event_type: str, payload: RunEventPayload) -> str:
    if event_type in _TERMINAL_EVENT_TYPES:
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
