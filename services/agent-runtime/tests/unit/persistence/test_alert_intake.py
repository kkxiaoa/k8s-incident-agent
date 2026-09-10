import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import func, select

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
    TerminalRecord,
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


@pytest.mark.parametrize("reverse", [False, True])
async def test_model_outage_commits_existing_signals_and_watchdog_but_retries_new_firing(
    tmp_path: Path,
    reverse: bool,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        existing = await repository.apply_alert_occurrences(
            (_occurrence(),), _model(), _budget()
        )
        resolved = _occurrence(status=AlertSignalStatus.RESOLVED, ends_at=_timestamp(1))
        new_firing = _occurrence(fingerprint="fedcba9876543210")
        mixed = (new_firing, resolved) if reverse else (resolved, new_firing)
        received_at = START_TIME + timedelta(minutes=2)
        for _ in range(2):
            blocked = await repository.apply_alert_occurrences(
                mixed,
                None,
                _budget(),
                watchdog_received_at=received_at,
            )
            assert blocked.blocked_new_firing is True
            assert blocked.created_run_ids == ()
        assert await repository.get_watchdog_last_received_at() == received_at
        async with database.session_factory() as session:
            assert (
                await session.scalar(select(func.count()).select_from(IncidentRow)) == 1
            )
            assert await session.scalar(select(func.count()).select_from(RunRow)) == 1
            assert (
                await session.scalar(select(func.count()).select_from(AlertSignalRow))
                == 1
            )
            assert (
                await session.scalar(
                    select(func.count())
                    .select_from(RunEventRow)
                    .where(RunEventRow.event_type == "alert.resolved")
                )
                == 1
            )
        first_retry = await repository.apply_alert_occurrences(
            mixed, _model(), _budget()
        )
        second_retry = await repository.apply_alert_occurrences(
            mixed, _model(), _budget()
        )
        assert len(first_retry.created_run_ids) == 1
        assert first_retry.blocked_new_firing is False
        assert second_retry.created_run_ids == ()
        assert set(first_retry.created_run_ids).isdisjoint(existing.created_run_ids)


async def test_model_outage_does_not_block_repeat_firing_unknown_resolved_or_watchdog(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        await repository.apply_alert_occurrences((_occurrence(),), _model(), _budget())
        result = await repository.apply_alert_occurrences(
            (
                _occurrence(),
                _occurrence(
                    fingerprint="fedcba9876543210",
                    status=AlertSignalStatus.RESOLVED,
                    ends_at=_timestamp(1),
                ),
            ),
            None,
            _budget(),
            watchdog_received_at=START_TIME,
        )
        assert result.blocked_new_firing is False
        assert result.created_run_ids == ()
        assert result.events == ()
        assert await repository.get_watchdog_last_received_at() == START_TIME


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
            trigger_summary=(
                "A Deployment cannot pull its configured container image."
            ),
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


@pytest.mark.asyncio
async def test_firing_atomically_creates_one_incident_run_signal_and_event(
    tmp_path: Path,
) -> None:
    notifications: list[object] = []

    async def notify(incident_id: object) -> None:
        notifications.append(incident_id)

    async with _database(tmp_path) as database:
        repository = IncidentRepository(
            database.session_factory,
            on_event_committed=notify,
        )
        result = await repository.apply_alert_occurrences(
            (_occurrence(),),
            _model(),
            _budget(),
        )

        assert len(result.created_run_ids) == 1
        assert [event.event_type for event in result.events] == ["incident.created"]
        assert notifications == [result.events[0].incident_id]
        assert await _count(database, IncidentRow) == 1
        assert await _count(database, RunRow) == 1
        assert await _count(database, AlertSignalRow) == 1
        assert await _count(database, RunEventRow) == 1

        detail = await repository.get_incident_detail(
            result.events[0].incident_id,
            run_id=None,
            event_limit=100,
        )
        assert detail is not None
        assert detail.incident.source == IncidentSource(
            type="alertmanager",
            ref="K8sIncidentImagePullBackOff",
            revision="2026-09-02.1",
        )
        assert detail.alert_signal is not None
        assert detail.alert_signal.status is AlertSignalStatus.FIRING
        assert detail.alert_signal.starts_at == STARTS_AT
        assert detail.alert_signal.ends_at is None


@pytest.mark.asyncio
async def test_monitoring_context_projects_source_target_signal_and_bounded_runs(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        firing = await repository.apply_alert_occurrences(
            (_occurrence(),),
            _model(),
            _budget(),
        )
        run_id = firing.created_run_ids[0]
        incident_id = firing.events[0].incident_id
        await repository.start_run(run_id, START_TIME + timedelta(minutes=1))
        await repository.persist_terminal(
            TerminalRecord(
                run_id=run_id,
                completed_at=START_TIME + timedelta(minutes=2),
                outcome=None,
                summary=None,
                root_causes=(),
                missing_information=(),
                redacted=False,
                error_code="request_timeout",
                error_retryable=True,
                model_calls=1,
                tool_calls=0,
                input_tokens=None,
                output_tokens=None,
            )
        )
        await repository.apply_alert_occurrences(
            (
                _occurrence(
                    status=AlertSignalStatus.RESOLVED,
                    ends_at=_timestamp(3),
                ),
            ),
            _model(),
            _budget(),
        )

        context = await repository.get_incident_monitoring_context(
            incident_id,
            run_limit=1,
        )

        assert context is not None
        assert context.source.ref == "K8sIncidentImagePullBackOff"
        assert context.target.name == "image-pull-backoff"
        assert context.alert_signal is not None
        assert context.alert_signal.status is AlertSignalStatus.RESOLVED
        assert context.alert_signal.ends_at == _timestamp(3)
        assert len(context.runs) == 1
        assert context.runs[0].attempt == 1
        assert context.runs[0].started_at == START_TIME + timedelta(minutes=1)
        assert context.runs[0].completed_at == START_TIME + timedelta(minutes=2)
        assert context.runs_truncated is False


@pytest.mark.asyncio
async def test_nanosecond_distinct_occurrences_keep_distinct_database_identity(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        result = await repository.apply_alert_occurrences(
            (
                _occurrence(
                    starts_at=CanonicalAlertTimestamp("2026-09-02T08:00:00.000000001Z")
                ),
                _occurrence(
                    starts_at=CanonicalAlertTimestamp("2026-09-02T08:00:00.000000002Z")
                ),
            ),
            _model(),
            _budget(),
        )

        assert len(result.created_run_ids) == 2
        assert await _count(database, IncidentRow) == 2
        assert await _count(database, AlertSignalRow) == 2


@pytest.mark.asyncio
async def test_repeat_refreshes_incident_and_unknown_resolved_remains_noop(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        first = await repository.apply_alert_occurrences(
            (_occurrence(),),
            _model(),
            _budget(),
        )
        async with database.session_factory() as session:
            incident = await session.scalar(select(IncidentRow))
            assert incident is not None
            incident.updated_at = START_TIME
            await session.commit()
        repeated = await repository.apply_alert_occurrences(
            (_occurrence(),),
            _model(),
            _budget(),
        )
        unknown_resolved = await repository.apply_alert_occurrences(
            (
                _occurrence(
                    fingerprint="fedcba9876543210",
                    status=AlertSignalStatus.RESOLVED,
                    ends_at=_timestamp(5),
                ),
            ),
            _model(),
            _budget(),
        )

        assert len(first.created_run_ids) == 1
        assert repeated.created_run_ids == repeated.events == ()
        assert unknown_resolved.created_run_ids == unknown_resolved.events == ()
        assert await _count(database, IncidentRow) == 1
        assert await _count(database, RunRow) == 1
        assert await _count(database, AlertSignalRow) == 1
        assert await _count(database, RunEventRow) == 1
        async with database.session_factory() as session:
            incident = await session.scalar(select(IncidentRow))
            assert incident is not None
            assert incident.updated_at.replace(tzinfo=UTC) > START_TIME


@pytest.mark.asyncio
async def test_resolved_is_monotonic_and_does_not_reopen_or_close_incident(
    tmp_path: Path,
) -> None:
    ends_at = _timestamp(5)
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.apply_alert_occurrences(
            (_occurrence(),),
            _model(),
            _budget(),
        )
        resolved = await repository.apply_alert_occurrences(
            (
                _occurrence(
                    status=AlertSignalStatus.RESOLVED,
                    ends_at=ends_at,
                ),
            ),
            _model(),
            _budget(),
        )
        duplicate = await repository.apply_alert_occurrences(
            (
                _occurrence(
                    status=AlertSignalStatus.RESOLVED,
                    ends_at=_timestamp(6),
                ),
                _occurrence(),
            ),
            _model(),
            _budget(),
        )

        assert resolved.created_run_ids == ()
        assert len(resolved.events) == 1
        assert resolved.events[0].event_type == "alert.resolved"
        assert resolved.events[0].payload["alertStatus"] == "RESOLVED"
        assert resolved.events[0].payload["endsAt"] == "2026-09-02T08:05:00.000000000Z"
        assert duplicate.created_run_ids == duplicate.events == ()

        restarted_repository = IncidentRepository(database.session_factory)
        detail = await restarted_repository.get_incident_detail(
            created.events[0].incident_id,
            run_id=None,
            event_limit=100,
        )
        assert detail is not None
        assert detail.incident.status.value == "RECEIVED"
        assert detail.run.status.value == "QUEUED"
        assert detail.alert_signal is not None
        assert detail.alert_signal.status is AlertSignalStatus.RESOLVED
        assert detail.alert_signal.ends_at == ends_at
        assert [event.event_type for event in detail.events] == [
            "alert.resolved",
            "incident.created",
        ]


@pytest.mark.asyncio
async def test_resolved_can_arrive_after_terminal_run_without_mutating_diagnosis(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.apply_alert_occurrences(
            (_occurrence(),),
            _model(),
            _budget(),
        )
        run_id = created.created_run_ids[0]
        await repository.start_run(run_id, START_TIME + timedelta(seconds=1))
        await repository.persist_terminal(
            TerminalRecord(
                run_id=run_id,
                completed_at=START_TIME + timedelta(minutes=1),
                outcome=None,
                summary=None,
                root_causes=(),
                missing_information=(),
                redacted=False,
                error_code="resource_not_found",
                error_retryable=False,
                model_calls=1,
                tool_calls=1,
                input_tokens=None,
                output_tokens=None,
            )
        )
        await repository.apply_alert_occurrences(
            (
                _occurrence(
                    status=AlertSignalStatus.RESOLVED,
                    ends_at=_timestamp(2),
                ),
            ),
            _model(),
            _budget(),
        )

        detail = await repository.get_incident_detail(
            created.events[0].incident_id,
            run_id=None,
            event_limit=100,
        )
        assert detail is not None
        assert detail.incident.status.value == "FAILED"
        assert detail.run.status.value == "FAILED"
        assert detail.run.error_code == "resource_not_found"
        assert detail.alert_signal is not None
        assert detail.alert_signal.status is AlertSignalStatus.RESOLVED


@pytest.mark.asyncio
async def test_concurrent_firing_creates_exactly_one_occurrence(tmp_path: Path) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        results = await asyncio.gather(
            repository.apply_alert_occurrences(
                (_occurrence(),),
                _model(),
                _budget(),
            ),
            repository.apply_alert_occurrences(
                (_occurrence(),),
                _model(),
                _budget(),
            ),
        )

        assert sum(len(result.created_run_ids) for result in results) == 1
        assert await _count(database, IncidentRow) == 1
        assert await _count(database, RunRow) == 1
        assert await _count(database, AlertSignalRow) == 1
        assert await _count(database, RunEventRow) == 1


@pytest.mark.asyncio
async def test_batch_consistency_failure_rolls_back_earlier_occurrences(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        existing = _occurrence()
        await repository.apply_alert_occurrences(
            (existing,),
            _model(),
            _budget(),
        )
        new_occurrence = _occurrence(
            fingerprint="1111111111111111",
            starts_at=_timestamp(1),
            name="another-deployment",
        )
        mismatched_replay = _occurrence(name="unexpected-target")

        with pytest.raises(RecoveryConsistencyError):
            await repository.apply_alert_occurrences(
                (new_occurrence, mismatched_replay),
                _model(),
                _budget(),
            )

        assert await _count(database, IncidentRow) == 1
        assert await _count(database, RunRow) == 1
        assert await _count(database, AlertSignalRow) == 1
        assert await _count(database, RunEventRow) == 1


@pytest.mark.asyncio
async def test_watchdog_state_keeps_only_the_latest_valid_arrival(
    tmp_path: Path,
) -> None:
    first = START_TIME + timedelta(minutes=1)
    older = START_TIME
    latest = START_TIME + timedelta(minutes=2)
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)

        for received_at in (first, older, latest):
            result = await repository.apply_alert_occurrences(
                (),
                _model(),
                _budget(),
                watchdog_received_at=received_at,
            )
            assert result.created_run_ids == result.events == ()

        assert await repository.get_watchdog_last_received_at() == latest
        assert await _count(database, MonitoringSourceStateRow) == 1


@pytest.mark.asyncio
async def test_concurrent_watchdog_arrivals_converge_on_the_latest_time(
    tmp_path: Path,
) -> None:
    earlier = START_TIME + timedelta(minutes=1)
    later = START_TIME + timedelta(minutes=2)
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)

        await asyncio.gather(
            repository.apply_alert_occurrences(
                (),
                _model(),
                _budget(),
                watchdog_received_at=earlier,
            ),
            repository.apply_alert_occurrences(
                (),
                _model(),
                _budget(),
                watchdog_received_at=later,
            ),
        )

        assert await repository.get_watchdog_last_received_at() == later
        assert await _count(database, MonitoringSourceStateRow) == 1


@pytest.mark.asyncio
async def test_watchdog_state_rolls_back_with_an_invalid_alert_batch(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        await repository.apply_alert_occurrences(
            (_occurrence(),),
            _model(),
            _budget(),
        )

        with pytest.raises(RecoveryConsistencyError):
            await repository.apply_alert_occurrences(
                (_occurrence(name="unexpected-target"),),
                _model(),
                _budget(),
                watchdog_received_at=START_TIME + timedelta(minutes=1),
            )

        assert await repository.get_watchdog_last_received_at() is None
        assert await _count(database, MonitoringSourceStateRow) == 0
