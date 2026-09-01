import asyncio
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from typing import cast
from uuid import UUID

import pytest

from k8s_incident_agent.application.events import (
    EventDependencies,
    IncidentEventService,
    InvalidLastEventIdError,
    RunEventNotifier,
    stream_incident_events,
)
from k8s_incident_agent.application.incidents import IncidentNotFoundError
from k8s_incident_agent.domain.models import JsonValue, RunEvent
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    RecoveryConsistencyError,
)

INCIDENT_ID = UUID("00000000-0000-0000-0000-000000000001")
RUN_ID = UUID("00000000-0000-0000-0000-000000000002")
EVIDENCE_ID = UUID("00000000-0000-0000-0000-000000000003")
DIAGNOSIS_ID = UUID("00000000-0000-0000-0000-000000000004")
NOW = datetime(2026, 8, 26, 9, 0, tzinfo=UTC)


def _base_payload() -> dict[str, JsonValue]:
    return {
        "schemaVersion": 2,
        "incidentId": str(INCIDENT_ID),
        "runId": str(RUN_ID),
        "occurredAt": "2026-08-26T09:00:00Z",
    }


def _event(
    event_id: int,
    event_type: str,
    event_key: str,
    extra: dict[str, JsonValue],
) -> RunEvent:
    payload = _base_payload()
    payload.update(extra)
    return RunEvent(
        id=event_id,
        incident_id=INCIDENT_ID,
        run_id=RUN_ID,
        event_key=event_key,
        event_type=event_type,
        occurred_at=NOW,
        payload=payload,
    )


EVENT_CASES = (
    _event(
        1,
        "incident.created",
        "incident.created",
        {
            "attempt": 1,
            "incidentStatus": "RECEIVED",
            "runStatus": "QUEUED",
        },
    ),
    _event(
        2,
        "run.queued",
        "run.queued",
        {"attempt": 2, "runStatus": "QUEUED"},
    ),
    _event(
        3,
        "run.started",
        "run.started",
        {
            "attempt": 1,
            "incidentStatus": "TRIAGING",
            "runStatus": "RUNNING",
        },
    ),
    _event(
        4,
        "tool.started",
        "tool:call-1:started",
        {"toolCallId": "call-1", "toolName": "get_workload"},
    ),
    _event(
        5,
        "evidence.recorded",
        "tool:call-1:evidence",
        {
            "evidenceId": str(EVIDENCE_ID),
            "toolCallId": "call-1",
            "toolName": "get_workload",
            "evidenceKind": "workload",
            "observedAt": "2026-08-26T09:00:00Z",
            "truncated": False,
            "redacted": True,
        },
    ),
    _event(
        6,
        "tool.failed",
        "tool:call-2:failed",
        {
            "toolCallId": "call-2",
            "toolName": "get_pods",
            "errorCode": "request_timeout",
            "retryable": True,
        },
    ),
    _event(
        7,
        "diagnosis.completed",
        "run:terminal",
        {
            "diagnosisId": str(DIAGNOSIS_ID),
            "outcome": "diagnosed",
            "incidentStatus": "DIAGNOSED",
            "runStatus": "COMPLETED",
        },
    ),
    _event(
        8,
        "diagnosis.insufficient",
        "run:terminal",
        {
            "diagnosisId": str(DIAGNOSIS_ID),
            "outcome": "insufficient_evidence",
            "incidentStatus": "INSUFFICIENT_EVIDENCE",
            "runStatus": "COMPLETED",
        },
    ),
    _event(
        9,
        "run.failed",
        "run:terminal",
        {
            "errorCode": "agent_timeout",
            "retryable": True,
            "incidentStatus": "FAILED",
            "runStatus": "FAILED",
        },
    ),
)


class _Repository:
    def __init__(
        self,
        events: tuple[RunEvent, ...] = (),
        *,
        exists: bool = True,
        owned_ids: frozenset[int] | None = None,
    ) -> None:
        self.events = events
        self.exists = exists
        self.owned_ids = (
            frozenset(event.id for event in events) if owned_ids is None else owned_ids
        )
        self.list_calls: list[tuple[UUID, int, int]] = []
        self.ownership_calls: list[tuple[UUID, int]] = []

    async def incident_exists(self, incident_id: UUID) -> bool:
        assert incident_id == INCIDENT_ID
        return self.exists

    async def latest_incident_event_id(self, incident_id: UUID) -> int:
        assert incident_id == INCIDENT_ID
        return max((event.id for event in self.events), default=0)

    async def get_incident_event(
        self,
        incident_id: UUID,
        event_id: int,
    ) -> RunEvent | None:
        assert incident_id == INCIDENT_ID
        self.ownership_calls.append((incident_id, event_id))
        if event_id not in self.owned_ids:
            return None
        return next((event for event in self.events if event.id == event_id), None)

    async def list_incident_events(
        self,
        incident_id: UUID,
        *,
        after_id: int,
        limit: int,
    ) -> tuple[RunEvent, ...]:
        self.list_calls.append((incident_id, after_id, limit))
        return tuple(event for event in self.events if event.id > after_id)[:limit]


def _dependencies(
    repository: _Repository,
    *,
    notifier: RunEventNotifier | None = None,
) -> EventDependencies:
    return EventDependencies(
        repository=cast(IncidentRepository, repository),
        notifier=notifier or RunEventNotifier(),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "value",
    ["", "-1", "+1", "1.0", "\uff11\uff12", str(2**63), "9" * 10_000],
)
async def test_open_stream_rejects_non_decimal_negative_and_oversized_cursors(
    value: str,
) -> None:
    service = IncidentEventService(_dependencies(_Repository()))

    with pytest.raises(InvalidLastEventIdError):
        await service.open_stream(INCIDENT_ID, value)


@pytest.mark.asyncio
async def test_open_stream_validates_incident_and_nonzero_cursor_ownership() -> None:
    missing = IncidentEventService(_dependencies(_Repository(exists=False)))
    with pytest.raises(IncidentNotFoundError):
        await missing.open_stream(INCIDENT_ID, None)

    wrong_owner = IncidentEventService(_dependencies(_Repository()))
    with pytest.raises(InvalidLastEventIdError):
        await wrong_owner.open_stream(INCIDENT_ID, "7")


@pytest.mark.asyncio
async def test_zero_cursor_starts_at_first_event_without_ownership_lookup() -> None:
    repository = _Repository((EVENT_CASES[-1],))
    stream = await IncidentEventService(_dependencies(repository)).open_stream(
        INCIDENT_ID,
        "000",
    )

    assert (
        await anext(stream)
        == (
            f"id: {EVENT_CASES[-1].id}\n"
            f"event: {EVENT_CASES[-1].event_type}\n"
            f"data: {canonical_json(EVENT_CASES[-1].payload)}\n\n"
        ).encode()
    )
    assert repository.ownership_calls == []


@pytest.mark.asyncio
async def test_missing_cursor_tails_after_current_latest_event() -> None:
    repository = _Repository(EVENT_CASES)
    notifier = _ImmediateTimeoutNotifier()
    stream = await IncidentEventService(
        _dependencies(repository, notifier=notifier)
    ).open_stream(INCIDENT_ID, None)

    assert await anext(stream) == b": heartbeat\n\n"
    assert repository.list_calls == [(INCIDENT_ID, EVENT_CASES[-1].id, 100)]
    await cast(AsyncGenerator[bytes], stream).aclose()


@pytest.mark.asyncio
async def test_serializer_rejects_unpersisted_payload_fields() -> None:
    event = EVENT_CASES[0]
    corrupted_payload = dict(event.payload)
    corrupted_payload["rawKubernetesBody"] = {"secret": "must-not-stream"}
    corrupted = RunEvent(
        id=event.id,
        incident_id=event.incident_id,
        run_id=event.run_id,
        event_key=event.event_key,
        event_type=event.event_type,
        occurred_at=event.occurred_at,
        payload=corrupted_payload,
    )
    stream = stream_incident_events(
        INCIDENT_ID,
        0,
        _dependencies(_Repository((corrupted,))),
    )

    with pytest.raises(RecoveryConsistencyError):
        await anext(stream)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("event", "updates"),
    [
        (
            EVENT_CASES[5],
            {"errorCode": "permission_denied", "retryable": True},
        ),
        (
            EVENT_CASES[-1],
            {"errorCode": "agent_timeout", "retryable": False},
        ),
    ],
    ids=("tool-failure", "run-failure"),
)
async def test_serializer_rejects_invalid_failure_contracts(
    event: RunEvent,
    updates: dict[str, JsonValue],
) -> None:
    payload = dict(event.payload)
    payload.update(updates)
    corrupted = RunEvent(
        id=event.id,
        incident_id=event.incident_id,
        run_id=event.run_id,
        event_key=event.event_key,
        event_type=event.event_type,
        occurred_at=event.occurred_at,
        payload=payload,
    )
    stream = stream_incident_events(
        INCIDENT_ID,
        0,
        _dependencies(_Repository((corrupted,))),
    )

    with pytest.raises(RecoveryConsistencyError):
        await anext(stream)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("event", "field"),
    [
        (EVENT_CASES[0], "occurredAt"),
        (EVENT_CASES[4], "observedAt"),
    ],
)
async def test_serializer_rejects_non_utc_event_timestamps(
    event: RunEvent,
    field: str,
) -> None:
    payload = dict(event.payload)
    payload[field] = "2026-08-26T10:00:00+01:00"
    corrupted = RunEvent(
        id=event.id,
        incident_id=event.incident_id,
        run_id=event.run_id,
        event_key=event.event_key,
        event_type=event.event_type,
        occurred_at=event.occurred_at,
        payload=payload,
    )
    stream = stream_incident_events(
        INCIDENT_ID,
        0,
        _dependencies(_Repository((corrupted,))),
    )

    with pytest.raises(RecoveryConsistencyError):
        await anext(stream)


@pytest.mark.asyncio
@pytest.mark.parametrize("event", EVENT_CASES, ids=lambda event: event.event_type)
async def test_serializer_emits_exact_persisted_payload_for_all_event_types(
    event: RunEvent,
) -> None:
    stream = stream_incident_events(
        INCIDENT_ID,
        0,
        _dependencies(_Repository((event,))),
    )

    data = await anext(stream)

    assert (
        data
        == (
            f"id: {event.id}\n"
            f"event: {event.event_type}\n"
            f"data: {canonical_json(event.payload)}\n\n"
        ).encode()
    )
    await cast(AsyncGenerator[bytes], stream).aclose()


@pytest.mark.asyncio
async def test_replay_uses_batches_of_100_and_allows_global_id_gaps() -> None:
    events = tuple(
        _event(
            event_id,
            "tool.started",
            f"tool:call-{event_id}:started",
            {"toolCallId": f"call-{event_id}", "toolName": "get_pods"},
        )
        for event_id in range(2, 204, 2)
    )
    repository = _Repository(events)
    stream = stream_incident_events(
        INCIDENT_ID,
        0,
        _dependencies(repository),
    )

    documents = [await anext(stream) for _ in events]

    assert len(documents) == 101
    assert repository.list_calls == [
        (INCIDENT_ID, 0, 100),
        (INCIDENT_ID, 200, 100),
    ]
    await cast(AsyncGenerator[bytes], stream).aclose()


@pytest.mark.asyncio
async def test_reconnect_starts_after_cursor_without_duplicate_and_keeps_stream_open() -> (
    None
):
    created, queued, started, *_rest, terminal = EVENT_CASES
    repository = _Repository((created, started, terminal))
    notifier = _ImmediateTimeoutNotifier()
    stream = await IncidentEventService(
        _dependencies(repository, notifier=notifier)
    ).open_stream(INCIDENT_ID, str(created.id))

    replayed = [await anext(stream), await anext(stream)]

    assert f"id: {created.id}\n".encode() not in b"".join(replayed)
    assert replayed[0].startswith(f"id: {started.id}\n".encode())
    assert replayed[1].startswith(f"id: {terminal.id}\n".encode())
    assert await anext(stream) == b": heartbeat\n\n"
    assert queued.id not in {created.id, started.id, terminal.id}
    await cast(AsyncGenerator[bytes], stream).aclose()


@pytest.mark.asyncio
async def test_reconnect_after_already_received_terminal_keeps_stream_open() -> None:
    terminal = EVENT_CASES[-1]
    notifier = _ImmediateTimeoutNotifier()
    service = IncidentEventService(
        _dependencies(_Repository((terminal,)), notifier=notifier)
    )
    stream = await service.open_stream(INCIDENT_ID, str(terminal.id))

    assert await anext(stream) == b": heartbeat\n\n"
    await cast(AsyncGenerator[bytes], stream).aclose()


class _RecoveredRepository(_Repository):
    def __init__(self, recovered: RunEvent) -> None:
        super().__init__()
        self._recovered = recovered
        self._reads = 0

    async def list_incident_events(
        self,
        incident_id: UUID,
        *,
        after_id: int,
        limit: int,
    ) -> tuple[RunEvent, ...]:
        self._reads += 1
        self.list_calls.append((incident_id, after_id, limit))
        if self._reads == 1 or after_id >= self._recovered.id:
            return ()
        return (self._recovered,)


class _ImmediateTimeoutNotifier(RunEventNotifier):
    def __init__(self) -> None:
        super().__init__()
        self.wait_calls: list[tuple[UUID, float]] = []

    async def wait(self, incident_id: UUID, timeout_seconds: float) -> bool:
        self.wait_calls.append((incident_id, timeout_seconds))
        return False


@pytest.mark.asyncio
async def test_lost_notification_recovers_from_database_after_heartbeat() -> None:
    terminal = EVENT_CASES[-1]
    repository = _RecoveredRepository(terminal)
    notifier = _ImmediateTimeoutNotifier()
    stream = stream_incident_events(
        INCIDENT_ID,
        0,
        _dependencies(repository, notifier=notifier),
    )

    assert await anext(stream) == b": heartbeat\n\n"
    assert notifier.wait_calls == [(INCIDENT_ID, 15.0)]
    assert (
        await anext(stream)
        == (
            f"id: {terminal.id}\n"
            f"event: {terminal.event_type}\n"
            f"data: {canonical_json(terminal.payload)}\n\n"
        ).encode()
    )
    assert await anext(stream) == b": heartbeat\n\n"
    await cast(AsyncGenerator[bytes], stream).aclose()


@pytest.mark.asyncio
async def test_notifier_does_not_retain_notification_without_active_waiter() -> None:
    notifier = RunEventNotifier()

    await notifier.notify(INCIDENT_ID)

    assert await notifier.wait(INCIDENT_ID, 0.001) is False


@pytest.mark.asyncio
async def test_notifier_wakes_all_active_waiters() -> None:
    notifier = RunEventNotifier()
    waiters = [
        asyncio.create_task(notifier.wait(INCIDENT_ID, 1)),
        asyncio.create_task(notifier.wait(INCIDENT_ID, 1)),
    ]
    await asyncio.sleep(0)

    await notifier.notify(INCIDENT_ID)

    assert await asyncio.gather(*waiters) == [True, True]
