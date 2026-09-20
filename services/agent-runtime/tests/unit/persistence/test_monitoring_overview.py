from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config

from k8s_incident_agent.domain.models import (
    AlertSignalStatus,
    IncidentStatus,
    RunKind,
    RunStatus,
)
from k8s_incident_agent.persistence.database import (
    BusinessDatabase,
    create_business_database,
)
from k8s_incident_agent.persistence.models import (
    AlertSignalRow,
    IncidentRow,
    RunEventRow,
    RunRow,
)
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.runtime.paths import RuntimePaths

SERVICE_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 9, 3, 9, 37, tzinfo=UTC)


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


def _canonical(value: datetime) -> str:
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.000000000Z")


def _incident(
    *,
    source_ref: str,
    status: IncidentStatus,
    created_at: datetime,
    source_type: str = "alertmanager",
) -> IncidentRow:
    incident_id = str(uuid4())
    return IncidentRow(
        id=incident_id,
        trigger_source=source_type,
        trigger_ref=source_ref,
        trigger_revision="2026-09-03.4",
        display_name=source_ref,
        trigger_summary="Persisted monitoring overview fixture.",
        cluster="k8s-incident-agent",
        namespace="k8s-incident-scenarios",
        api_version="apps/v1",
        kind="Deployment",
        resource_name=source_ref.lower(),
        status=status,
        created_at=created_at,
        updated_at=created_at,
    )


def _signal(
    incident: IncidentRow,
    *,
    status: AlertSignalStatus,
    starts_at: datetime,
    ends_at: datetime | None = None,
) -> AlertSignalRow:
    return AlertSignalRow(
        incident_id=incident.id,
        fingerprint=incident.id.replace("-", "")[:16],
        starts_at=_canonical(starts_at),
        status=status,
        ends_at=None if ends_at is None else _canonical(ends_at),
    )


@pytest.mark.asyncio
async def test_overview_aggregates_all_incidents_and_fixed_utc_hour_buckets(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        crash = _incident(
            source_ref="K8sIncidentCrashLoopBackOff",
            status=IncidentStatus.TRIAGING,
            created_at=NOW - timedelta(minutes=10),
        )
        image_firing = _incident(
            source_ref="K8sIncidentImagePullBackOff",
            status=IncidentStatus.DIAGNOSED,
            created_at=NOW - timedelta(hours=2),
        )
        image_resolved = _incident(
            source_ref="K8sIncidentImagePullBackOff",
            status=IncidentStatus.DIAGNOSED,
            created_at=NOW - timedelta(hours=3),
        )
        old = _incident(
            source_ref="K8sIncidentImagePullBackOff",
            status=IncidentStatus.FAILED,
            created_at=NOW - timedelta(days=2),
            source_type="scenario",
        )
        async with database.session_factory() as session, session.begin():
            session.add_all([crash, image_firing, image_resolved, old])
            await session.flush()
            session.add_all(
                [
                    _signal(
                        crash,
                        status=AlertSignalStatus.FIRING,
                        starts_at=NOW - timedelta(minutes=20),
                    ),
                    _signal(
                        image_firing,
                        status=AlertSignalStatus.FIRING,
                        starts_at=NOW - timedelta(hours=2, minutes=10),
                    ),
                    _signal(
                        image_resolved,
                        status=AlertSignalStatus.RESOLVED,
                        starts_at=NOW - timedelta(hours=4),
                        ends_at=NOW - timedelta(hours=1),
                    ),
                ]
            )

        result = await IncidentRepository(
            database.session_factory
        ).get_monitoring_overview(NOW)

    assert result.total_incidents == 4
    assert result.firing_alerts == 2
    assert result.triaging_incidents == 1
    assert result.waiting_approval_incidents == 0
    assert [(family.source_ref, family.count) for family in result.families] == [
        ("K8sIncidentCrashLoopBackOff", 1),
        ("K8sIncidentImagePullBackOff", 1),
    ]
    assert len(result.samples) == 24
    assert result.samples[0].timestamp == NOW.replace(
        minute=0,
        second=0,
        microsecond=0,
    ) - timedelta(hours=23)
    assert sum(sample.incidents_created for sample in result.samples) == 3
    assert sum(sample.alert_conditions_resolved for sample in result.samples) == 1
    assert result.samples[-1].incidents_created == 1
    assert result.samples[-2].alert_conditions_resolved == 1


@pytest.mark.asyncio
async def test_overview_counts_only_incidents_currently_waiting_approval(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        incidents = [
            _incident(
                source_ref=f"status-{status.value}",
                status=status,
                created_at=NOW - timedelta(days=2),
                source_type="scenario",
            )
            for status in IncidentStatus
        ]
        waiting = next(
            incident
            for incident in incidents
            if incident.status == IncidentStatus.WAITING_APPROVAL
        )
        async with database.session_factory() as session, session.begin():
            session.add_all(incidents)

        repository = IncidentRepository(database.session_factory)
        assert (
            await repository.get_monitoring_overview(NOW)
        ).waiting_approval_incidents == 1

        async with database.session_factory() as session, session.begin():
            row = await session.get(IncidentRow, waiting.id)
            assert row is not None
            row.status = IncidentStatus.TRIAGING

        assert (
            await repository.get_monitoring_overview(NOW)
        ).waiting_approval_incidents == 0


def _run(incident: IncidentRow, *, attempt: int, created_at: datetime) -> RunRow:
    return RunRow(
        id=str(uuid4()),
        incident_id=incident.id,
        attempt=attempt,
        status=RunStatus.COMPLETED,
        kind=RunKind.DIAGNOSIS,
        model_provider="fake",
        model_id="fake-model",
        thinking_mode=False,
        prompt_version="test",
        max_model_calls=1,
        max_tool_calls=1,
        timeout_seconds=180,
        created_at=created_at,
        started_at=created_at,
        completed_at=created_at,
        updated_at=created_at,
    )


def _terminal_event(
    run: RunRow,
    *,
    incident_status: IncidentStatus,
    occurred_at: datetime,
    event_key: str = "run:terminal",
) -> RunEventRow:
    return RunEventRow(
        run_id=run.id,
        event_key=event_key,
        event_type="run.failed",
        schema_version=5,
        occurred_at=occurred_at,
        payload_json=(
            '{"incidentStatus": "' + incident_status.value + '", "runStatus": "FAILED"}'
        ),
    )


@pytest.mark.asyncio
async def test_overview_counts_terminal_transitions_not_remaining_work(
    tmp_path: Path,
) -> None:
    """A reopened Incident ends twice, and both endings are real transitions."""

    async with _database(tmp_path) as database:
        incident = _incident(
            source_ref="K8sIncidentImagePullBackOff",
            status=IncidentStatus.FAILED,
            created_at=NOW - timedelta(hours=5),
        )
        outside = _incident(
            source_ref="K8sIncidentCrashLoopBackOff",
            status=IncidentStatus.RESOLVED,
            created_at=NOW - timedelta(days=3),
        )
        async with database.session_factory() as session, session.begin():
            session.add_all([incident, outside])
            await session.flush()
            first = _run(incident, attempt=1, created_at=NOW - timedelta(hours=5))
            second = _run(incident, attempt=2, created_at=NOW - timedelta(hours=2))
            third = _run(incident, attempt=3, created_at=NOW - timedelta(hours=1))
            stale = _run(outside, attempt=1, created_at=NOW - timedelta(days=3))
            session.add_all([first, second, third, stale])
            await session.flush()
            session.add_all(
                [
                    _terminal_event(
                        first,
                        incident_status=IncidentStatus.INSUFFICIENT_EVIDENCE,
                        occurred_at=NOW - timedelta(hours=4),
                    ),
                    _terminal_event(
                        third,
                        incident_status=IncidentStatus.FAILED,
                        occurred_at=NOW - timedelta(hours=1),
                    ),
                    # A Run that ended without ending its Incident.
                    _terminal_event(
                        second,
                        incident_status=IncidentStatus.DIAGNOSED,
                        occurred_at=NOW - timedelta(hours=1),
                        event_key="diagnosis.completed",
                    ),
                    # A Run can end while its Incident waits for approval or
                    # returns to DIAGNOSED; those endings are not terminal.
                    _terminal_event(
                        second,
                        incident_status=IncidentStatus.WAITING_APPROVAL,
                        occurred_at=NOW - timedelta(hours=2),
                    ),
                    # A late execution result repeats the status it did not write.
                    _terminal_event(
                        first,
                        incident_status=IncidentStatus.FAILED,
                        occurred_at=NOW - timedelta(hours=3),
                        event_key="execution:late",
                    ),
                    # Outside the 24 hour window.
                    _terminal_event(
                        stale,
                        incident_status=IncidentStatus.RESOLVED,
                        occurred_at=NOW - timedelta(days=3),
                    ),
                ]
            )

        result = await IncidentRepository(
            database.session_factory
        ).get_monitoring_overview(NOW)

    assert sum(sample.incidents_settled for sample in result.samples) == 2
    assert result.samples[-5].incidents_settled == 1
    assert result.samples[-2].incidents_settled == 1
    assert result.samples[-1].incidents_settled == 0
