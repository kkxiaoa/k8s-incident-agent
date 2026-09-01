import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Final
from uuid import UUID

from k8s_incident_agent.application.event_projection import validated_event_json
from k8s_incident_agent.application.incidents import IncidentNotFoundError
from k8s_incident_agent.domain.models import RunEvent
from k8s_incident_agent.persistence.repositories import IncidentRepository

_MAX_EVENT_ID: Final = 2**63 - 1
_REPLAY_BATCH_SIZE: Final = 100
_HEARTBEAT_SECONDS: Final = 15.0


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
        if last_event_id_header is None:
            last_event_id = await repository.latest_incident_event_id(incident_id)
        elif last_event_id != 0:
            cursor_event = await repository.get_incident_event(
                incident_id,
                last_event_id,
            )
            if cursor_event is None:
                raise InvalidLastEventIdError
            validated_event_json(cursor_event)

        async def stream() -> AsyncIterator[bytes]:
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
                yield data
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
    document = validated_event_json(event)
    return (f"id: {event.id}\nevent: {event.event_type}\ndata: {document}\n\n").encode()
