import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import event, func, select
from sqlalchemy.exc import OperationalError
from tests.factories import seed_legacy_alert_incident

from k8s_incident_agent.application.event_projection import validated_stream_item
from k8s_incident_agent.domain.contracts import (
    IncidentSource,
    KubernetesTarget,
    NormalizedIncidentTrigger,
)
from k8s_incident_agent.domain.models import (
    AlertSignalStatus,
    CanonicalAlertTimestamp,
    ModelSnapshot,
    NormalizedAlertOccurrence,
    RunBudget,
)
from k8s_incident_agent.persistence.database import (
    BusinessDatabase,
    create_business_database,
)
from k8s_incident_agent.persistence.models import (
    AlertSignalRow,
    IncidentRow,
    MonitoringSourceStateRow,
    RunEventRow,
    RunRow,
)
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    PersistenceOperationError,
    RecoveryConsistencyError,
)
from k8s_incident_agent.runtime.paths import RuntimePaths

SERVICE_ROOT = Path(__file__).resolve().parents[3]
START_TIME = datetime(2026, 9, 2, 8, 0, tzinfo=UTC)
STARTS_AT = CanonicalAlertTimestamp("2026-09-02T08:00:00.000000000Z")


def _timestamp(minutes: int) -> CanonicalAlertTimestamp:
    value = START_TIME + timedelta(minutes=minutes)
    return CanonicalAlertTimestamp(value.strftime("%Y-%m-%dT%H:%M:%S.000000000Z"))


def _alembic_config(paths: RuntimePaths) -> Config:
    config = Config(str(SERVICE_ROOT / "alembic.ini"))
    config.attributes["runtime_paths"] = paths
    return config


@asynccontextmanager
async def _database(tmp_path: Path) -> AsyncGenerator[BusinessDatabase]:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await create_business_database(paths)
    try:
        yield database
    finally:
        await database.dispose()


def _model() -> ModelSnapshot:
    return ModelSnapshot(
        provider="deepseek",
        model_id="deepseek-v4-flash",
        thinking_mode=False,
        prompt_version="stage1-v1",
    )


def _budget() -> RunBudget:
    return RunBudget(max_model_calls=8, max_tool_calls=6, timeout_seconds=180)


def _occurrence(
    *,
    fingerprint: str = "0123456789abcdef",
    starts_at: CanonicalAlertTimestamp = STARTS_AT,
    status: AlertSignalStatus = AlertSignalStatus.FIRING,
    ends_at: CanonicalAlertTimestamp | None = None,
    name: str = "image-pull-backoff",
) -> NormalizedAlertOccurrence:
    return NormalizedAlertOccurrence(
        trigger=NormalizedIncidentTrigger(
            source=IncidentSource(
                type="alertmanager",
                ref="K8sIncidentImagePullBackOff",
                revision="2026-09-02.1",
            ),
            display_name="Image pull failure",
            trigger_summary="A Deployment cannot pull its configured container image.",
            target=KubernetesTarget(
                cluster="k8s-incident-agent",
                namespace="k8s-incident-scenarios",
                api_version="apps/v1",
                kind="Deployment",
                name=name,
            ),
        ),
        fingerprint=fingerprint,
        starts_at=starts_at,
        status=status,
        ends_at=ends_at,
    )


async def _count(database: BusinessDatabase, row: type[object]) -> int:
    async with database.session_factory() as session:
        value = await session.scalar(select(func.count()).select_from(row))
    assert isinstance(value, int)
    return value


@pytest.mark.parametrize("status", list(AlertSignalStatus))
async def test_new_notifications_persist_without_incidents_or_runs_and_survive_restart(
    tmp_path: Path,
    status: AlertSignalStatus,
) -> None:
    occurrence = _occurrence(
        status=status,
        ends_at=_timestamp(1) if status is AlertSignalStatus.RESOLVED else None,
    )
    async with _database(tmp_path) as database:
        repository = IncidentRepository(
            database.session_factory, now=lambda: START_TIME
        )
        await repository.apply_alert_occurrences((occurrence,))
        await repository.apply_alert_occurrences(
            (occurrence,),
            received_at=START_TIME + timedelta(minutes=2),
        )
        assert await _count(database, AlertSignalRow) == 1
        for row in (IncidentRow, RunRow, RunEventRow):
            assert await _count(database, row) == 0
    async with _database(tmp_path) as database:
        reopened = IncidentRepository(database.session_factory)
        overview = await reopened.get_monitoring_overview(
            START_TIME + timedelta(minutes=3)
        )
        assert overview.unassigned_count == 1
        signal = overview.unassigned_signals[0]
        assert signal.target == occurrence.trigger.target
        assert signal.status == status.value
        assert signal.starts_at == STARTS_AT
        assert signal.ends_at == occurrence.ends_at
        assert signal.last_received_at == START_TIME + timedelta(minutes=2)
        async with database.session_factory() as session:
            stored = await session.get(
                AlertSignalRow, (occurrence.fingerprint, STARTS_AT)
            )
            assert stored is not None and stored.incident_id is None
            assert stored.trigger_ref == occurrence.trigger.source.ref
            assert stored.first_received_at is not None
            assert stored.first_received_at.replace(tzinfo=UTC) == START_TIME
            assert (
                stored.resolved_received_at.replace(tzinfo=UTC)
                if stored.resolved_received_at is not None
                else None
            ) == (START_TIME if status is AlertSignalStatus.RESOLVED else None)


@pytest.mark.parametrize("reverse", [False, True])
async def test_firing_and_resolved_preserve_last_notification_and_resolved_evidence(
    tmp_path: Path,
    reverse: bool,
) -> None:
    firing = _occurrence()
    resolved = _occurrence(status=AlertSignalStatus.RESOLVED, ends_at=_timestamp(5))
    sequence = (resolved, firing) if reverse else (firing, resolved)
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        for index, occurrence in enumerate(sequence):
            await repository.apply_alert_occurrences(
                (occurrence,),
                received_at=START_TIME + timedelta(minutes=index),
            )
        overview = await repository.get_monitoring_overview(
            START_TIME + timedelta(minutes=10)
        )
        signal = overview.unassigned_signals[0]
        assert signal.status == sequence[-1].status.value
        assert signal.ends_at == resolved.ends_at
        async with database.session_factory() as session:
            stored = await session.get(AlertSignalRow, (firing.fingerprint, STARTS_AT))
            assert stored is not None and stored.resolved_received_at is not None
            assert stored.resolved_received_at.replace(
                tzinfo=UTC
            ) == START_TIME + timedelta(minutes=0 if reverse else 1)
        assert await _count(database, IncidentRow) == 0
        assert await _count(database, RunRow) == 0


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("status", list(AlertSignalStatus))
async def test_receipt_bounds_survive_out_of_order_commits(
    tmp_path: Path,
    legacy: bool,
    status: AlertSignalStatus,
) -> None:
    occurrence = _occurrence(
        status=status,
        ends_at=_timestamp(1) if status is AlertSignalStatus.RESOLVED else None,
    )
    earlier = START_TIME + timedelta(minutes=1)
    later = START_TIME + timedelta(minutes=2)
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = (
            await seed_legacy_alert_incident(
                repository, occurrence, _model(), _budget()
            )
            if legacy
            else None
        )
        before = (
            await repository.get_incident_detail(
                created.incident_id, run_id=None, event_limit=100
            )
            if created is not None
            else None
        )
        # Arrival timestamps are captured before SQLite serializes their writes.
        for received_at in (later, earlier):
            await repository.apply_alert_occurrences(
                (occurrence,), received_at=received_at
            )
        async with database.session_factory() as session:
            signal = await session.get(
                AlertSignalRow, (occurrence.fingerprint, STARTS_AT)
            )
            assert signal is not None
            assert (
                signal.first_received_at.replace(tzinfo=UTC)
                if signal.first_received_at is not None
                else None,
                signal.last_received_at.replace(tzinfo=UTC)
                if signal.last_received_at is not None
                else None,
            ) == (None if legacy else earlier, later)
            assert signal.status is status and signal.ends_at == occurrence.ends_at
            assert (
                signal.resolved_received_at.replace(tzinfo=UTC)
                if signal.resolved_received_at is not None
                else None
            ) == (
                later if not legacy and status is AlertSignalStatus.RESOLVED else None
            )
        assert await _count(database, AlertSignalRow) == 1
        for row in (IncidentRow, RunRow, RunEventRow):
            assert await _count(database, row) == int(legacy)
        if created is not None:
            assert (
                await repository.get_incident_detail(
                    created.incident_id,
                    run_id=None,
                    event_limit=100,
                )
                == before
            )
        else:
            overview = await repository.get_monitoring_overview(later)
            assert overview.unassigned_signals[0].last_received_at == later


async def test_associated_notifications_use_incident_owner_without_mutating_run_or_business_time(
    tmp_path: Path,
) -> None:
    notifications: list[object] = []

    async def notify(incident_id: object) -> None:
        notifications.append(incident_id)

    async with _database(tmp_path) as database:
        repository = IncidentRepository(
            database.session_factory, on_event_committed=notify
        )
        created = await seed_legacy_alert_incident(
            repository, _occurrence(), _model(), _budget()
        )
        before = await repository.get_incident_detail(
            created.incident_id, run_id=None, event_limit=100
        )
        assert before is not None and before.run is not None
        notifications.clear()
        sequence = (
            _occurrence(status=AlertSignalStatus.RESOLVED, ends_at=_timestamp(5)),
            _occurrence(),
            _occurrence(status=AlertSignalStatus.RESOLVED, ends_at=_timestamp(6)),
        )
        for index, occurrence in enumerate(sequence):
            received_at = START_TIME + timedelta(minutes=10 + index)
            await repository.apply_alert_occurrences(
                (occurrence,), received_at=received_at
            )
            await repository.apply_alert_occurrences(
                (occurrence,),
                received_at=received_at + timedelta(seconds=1),
            )
        after = await repository.get_incident_detail(
            created.incident_id, run_id=None, event_limit=100
        )
        assert after is not None and after.run is not None
        assert after.incident == before.incident
        assert after.run == before.run
        assert after.events == before.events
        assert after.alert_signal is not None
        assert after.alert_signal.ends_at == _timestamp(6)
        events = await repository.list_incident_events(
            created.incident_id, after_id=0, limit=100
        )
        assert [item.event_type for item in events] == [
            "incident.created",
            "alert.notification",
            "alert.notification",
            "alert.notification",
        ]
        assert notifications == [created.incident_id] * 3
        assert all(item.run_id is None for item in events[1:])
        assert events[0].payload["schemaVersion"] == 5
        assert all(
            validated_stream_item(item).root.data.schema_version == 6 for item in events
        )
        assert after.event_cursor == events[-1].id
        assert (
            await repository.get_incident_event(created.incident_id, events[-1].id)
            == events[-1]
        )
        async with database.session_factory() as session:
            signal = await session.get(
                AlertSignalRow, (_occurrence().fingerprint, STARTS_AT)
            )
            assert signal is not None and signal.first_received_at is None
            assert signal.resolved_received_at is not None
            assert signal.resolved_received_at.replace(
                tzinfo=UTC
            ) == START_TIME + timedelta(minutes=12)


async def test_nanosecond_occurrences_keep_distinct_database_identity(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        await repository.apply_alert_occurrences(
            tuple(
                _occurrence(
                    starts_at=CanonicalAlertTimestamp(
                        f"2026-09-02T08:00:00.00000000{index}Z"
                    )
                )
                for index in (1, 2)
            )
        )
        assert await _count(database, AlertSignalRow) == 2
        assert await _count(database, IncidentRow) == 0
        assert await _count(database, RunRow) == 0


async def test_concurrent_deliveries_create_one_occurrence(tmp_path: Path) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        await asyncio.gather(
            repository.apply_alert_occurrences((_occurrence(),)),
            repository.apply_alert_occurrences((_occurrence(),)),
        )
        assert await _count(database, AlertSignalRow) == 1
        assert await _count(database, IncidentRow) == 0
        assert await _count(database, RunRow) == 0


async def test_inconsistent_batch_rolls_back_new_signal_and_watchdog(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(
            database.session_factory, now=lambda: START_TIME
        )
        await repository.apply_alert_occurrences((_occurrence(),))
        with pytest.raises(RecoveryConsistencyError):
            await repository.apply_alert_occurrences(
                (
                    _occurrence(
                        fingerprint="1111111111111111", name="another-deployment"
                    ),
                    _occurrence(name="unexpected-target"),
                ),
                received_at=START_TIME + timedelta(minutes=1),
                watchdog_received_at=START_TIME,
            )
        assert await _count(database, AlertSignalRow) == 1
        assert await _count(database, IncidentRow) == 0
        assert await repository.get_watchdog_last_received_at() is None
        overview = await repository.get_monitoring_overview(START_TIME)
        assert overview.unassigned_signals[0].last_received_at == START_TIME


async def test_event_write_failure_rolls_back_signal_and_retry_commits_once(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await seed_legacy_alert_incident(
            repository, _occurrence(), _model(), _budget()
        )

        def fail_event(
            _connection: Any,
            _cursor: Any,
            statement: str,
            parameters: Any,
            _context: Any,
            _many: bool,
        ) -> None:
            if statement.startswith("INSERT INTO run_events"):
                raise OperationalError(
                    statement, parameters, RuntimeError("injected ledger failure")
                )

        event.listen(database.engine.sync_engine, "before_cursor_execute", fail_event)
        resolved = _occurrence(status=AlertSignalStatus.RESOLVED, ends_at=_timestamp(5))
        try:
            with pytest.raises(PersistenceOperationError):
                await repository.apply_alert_occurrences((resolved,))
        finally:
            event.remove(
                database.engine.sync_engine, "before_cursor_execute", fail_event
            )
        detail = await repository.get_incident_detail(
            created.incident_id, run_id=None, event_limit=100
        )
        assert detail is not None and detail.alert_signal is not None
        assert detail.alert_signal.status is AlertSignalStatus.FIRING
        assert await _count(database, RunEventRow) == 1
        await repository.apply_alert_occurrences((resolved,))
        await repository.apply_alert_occurrences((resolved,))
        assert await _count(database, RunEventRow) == 2


async def test_primary_signal_keeps_legacy_source_when_more_occurrences_are_attached(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await seed_legacy_alert_incident(
            repository, _occurrence(), _model(), _budget()
        )
        additional = _occurrence(
            fingerprint="1111111111111111", starts_at=_timestamp(-5)
        )
        await repository.apply_alert_occurrences((additional,))
        async with database.session_factory() as session, session.begin():
            signal = await session.get(
                AlertSignalRow, (additional.fingerprint, additional.starts_at)
            )
            assert signal is not None
            signal.incident_id = str(created.incident_id)
        context = await repository.get_incident_monitoring_context(
            created.incident_id, run_limit=1
        )
        assert context is not None and context.alert_signal is not None
        assert context.alert_signal.starts_at == STARTS_AT
        assert context.occurred_at == START_TIME


async def test_watchdog_stays_independent_and_keeps_latest_arrival(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        await asyncio.gather(
            *(
                repository.apply_alert_occurrences(
                    (), watchdog_received_at=START_TIME + timedelta(minutes=index)
                )
                for index in (1, 0, 2)
            )
        )
        assert (
            await repository.get_watchdog_last_received_at()
            == START_TIME + timedelta(minutes=2)
        )
        assert await _count(database, MonitoringSourceStateRow) == 1
        assert await _count(database, AlertSignalRow) == 0
