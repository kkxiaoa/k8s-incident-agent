import asyncio
import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import event, func, select
from sqlalchemy.exc import OperationalError
from tests.factories import normalized_trigger

from k8s_incident_agent.domain.models import (
    DiagnosisOutcome,
    DiagnosisWorkflowRunSnapshot,
    EvidenceRecord,
    ModelSnapshot,
    RecommendationRecord,
    RootCauseRecord,
    RunBudget,
    RunStatus,
    TerminalRecord,
)
from k8s_incident_agent.persistence.database import (
    BusinessDatabase,
    create_business_database,
)
from k8s_incident_agent.persistence.models import (
    DiagnosisRow,
    EvidenceRow,
    IncidentRow,
    RunEventRow,
    RunRow,
)
from k8s_incident_agent.persistence.repositories import (
    ActiveRunExistsError,
    IncidentRepository,
    PersistenceOperationError,
    RecoveryConsistencyError,
)
from k8s_incident_agent.runtime.paths import RuntimePaths

SERVICE_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 17, 9, 0, tzinfo=UTC)


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


def _scenario():
    return normalized_trigger()


def _model() -> ModelSnapshot:
    return ModelSnapshot(
        provider="deepseek",
        model_id="deepseek-v4-flash",
        thinking_mode=False,
        prompt_version="stage1-v1",
    )


def _budget() -> RunBudget:
    return RunBudget(max_model_calls=8, max_tool_calls=6, timeout_seconds=180)


async def _row_count(database: BusinessDatabase, row_type: type[object]) -> int:
    async with database.session_factory() as session:
        count = await session.scalar(select(func.count()).select_from(row_type))
    assert count is not None
    return count


async def _fail_run(
    repository: IncidentRepository,
    run_id: UUID,
) -> None:
    await repository.start_run(run_id, NOW)
    await repository.persist_terminal(
        TerminalRecord(
            run_id=run_id,
            completed_at=NOW.replace(minute=1),
            outcome=None,
            summary=None,
            root_causes=(),
            missing_information=(),
            redacted=False,
            error_code="request_timeout",
            error_retryable=True,
            model_calls=1,
            tool_calls=1,
            input_tokens=None,
            output_tokens=None,
        )
    )


@pytest.mark.asyncio
async def test_create_incident_run_and_event_are_one_transaction(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)

        created = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )

        assert created.incident_status.value == "RECEIVED"
        assert created.run_status.value == "QUEUED"
        assert created.event.event_key == "incident.created"
        assert created.event.event_type == "incident.created"
        assert created.event.payload == {
            "attempt": 1,
            "incidentId": str(created.incident_id),
            "incidentStatus": "RECEIVED",
            "occurredAt": created.event.occurred_at.isoformat().replace("+00:00", "Z"),
            "runId": str(created.run_id),
            "runStatus": "QUEUED",
            "schemaVersion": 5,
            "runKind": "diagnosis",
        }
        assert await _row_count(database, IncidentRow) == 1
        assert await _row_count(database, RunRow) == 1
        assert await _row_count(database, RunEventRow) == 1


@pytest.mark.asyncio
async def test_create_rolls_back_all_rows_when_event_insert_fails(
    tmp_path: Path,
) -> None:
    notifications: list[UUID] = []

    async def notify(incident_id: UUID) -> None:
        notifications.append(incident_id)

    def fail_event_insert(
        _mapper: object, _connection: object, _target: object
    ) -> None:
        raise OperationalError(
            "sensitive SQL",
            {"token": "must-not-leak"},
            RuntimeError("/private/database/path"),
        )

    async with _database(tmp_path) as database:
        repository = IncidentRepository(
            database.session_factory,
            on_event_committed=notify,
        )
        event.listen(RunEventRow, "before_insert", fail_event_insert)
        try:
            with pytest.raises(PersistenceOperationError) as error:
                await repository.create_incident_and_run(
                    _scenario(), _model(), _budget()
                )
        finally:
            event.remove(RunEventRow, "before_insert", fail_event_insert)

        assert str(error.value) == "Persistence operation failed"
        assert "sensitive" not in str(error.value)
        assert await _row_count(database, IncidentRow) == 0
        assert await _row_count(database, RunRow) == 0
        assert await _row_count(database, RunEventRow) == 0
        assert notifications == []


@pytest.mark.asyncio
async def test_rerun_requires_terminal_predecessor_and_keeps_attempts_isolated(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        first = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )

        with pytest.raises(ActiveRunExistsError):
            await repository.create_run(first.incident_id, _model(), _budget())

        await _fail_run(repository, first.run_id)
        second = await repository.create_run(first.incident_id, _model(), _budget())
        assert second is not None

        latest = await repository.get_incident_detail(
            first.incident_id,
            run_id=None,
            event_limit=100,
        )
        historical = await repository.get_incident_detail(
            first.incident_id,
            run_id=first.run_id,
            event_limit=100,
        )
        assert latest is not None
        assert historical is not None
        assert latest.run.id == second.run_id
        assert latest.run.attempt == 2
        assert latest.run.status is RunStatus.QUEUED
        assert [event.event_type for event in latest.events] == ["run.queued"]
        assert historical.run.id == first.run_id
        assert historical.run.attempt == 1
        assert historical.run.status is RunStatus.FAILED
        assert historical.run.error_code == "request_timeout"
        assert all(event.run_id == first.run_id for event in historical.events)


@pytest.mark.asyncio
async def test_concurrent_rerun_creates_exactly_one_active_attempt(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        first = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )
        await _fail_run(repository, first.run_id)

        results = await asyncio.gather(
            repository.create_run(first.incident_id, _model(), _budget()),
            repository.create_run(first.incident_id, _model(), _budget()),
            return_exceptions=True,
        )

        created = [
            result for result in results if not isinstance(result, BaseException)
        ]
        rejected = [result for result in results if isinstance(result, BaseException)]
        assert len(created) == 1
        assert len(rejected) == 1
        assert isinstance(rejected[0], ActiveRunExistsError)
        page = await repository.list_run_records(
            first.incident_id,
            limit=50,
            before_attempt=None,
        )
        assert page is not None
        assert [(run.attempt, run.status) for run in page.items] == [
            (2, RunStatus.QUEUED),
            (1, RunStatus.FAILED),
        ]


@pytest.mark.asyncio
async def test_replay_queries_filter_incident_in_sql_and_preserve_global_gaps(
    tmp_path: Path,
) -> None:
    notifications: list[UUID] = []

    async def notify(incident_id: UUID) -> None:
        notifications.append(incident_id)

    async with _database(tmp_path) as database:
        repository = IncidentRepository(
            database.session_factory,
            on_event_committed=notify,
        )
        first = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )
        second = await repository.create_incident_and_run(
            _scenario().model_copy(update={"scenario_id": "another-scenario"}),
            _model(),
            _budget(),
        )
        started = await repository.start_run(first.run_id, NOW)

        first_events = await repository.list_incident_events(
            first.incident_id,
            after_id=0,
            limit=100,
        )
        after_created = await repository.list_incident_events(
            first.incident_id,
            after_id=first.event.id,
            limit=100,
        )

        assert [event.id for event in first_events] == [
            first.event.id,
            started.event.id,
        ]
        assert second.event.id not in {event.id for event in first_events}
        assert started.event.id - first.event.id == 2
        assert after_created == (started.event,)
        assert (
            await repository.get_incident_event(
                first.incident_id,
                first.event.id,
            )
            == first.event
        )
        assert (
            await repository.get_incident_event(
                first.incident_id,
                second.event.id,
            )
            is None
        )
        assert notifications == [
            first.incident_id,
            second.incident_id,
            first.incident_id,
        ]


@pytest.mark.asyncio
async def test_notifier_failure_does_not_reclassify_committed_write_as_failure(
    tmp_path: Path,
) -> None:
    async def fail_notification(_incident_id: UUID) -> None:
        raise RuntimeError("notifier unavailable")

    async with _database(tmp_path) as database:
        repository = IncidentRepository(
            database.session_factory,
            on_event_committed=fail_notification,
        )

        created = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )

        assert await repository.incident_exists(created.incident_id)
        assert await _row_count(database, RunEventRow) == 1


@pytest.mark.asyncio
async def test_start_run_updates_both_states_and_records_one_event(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )

        run = await repository.start_run(created.run_id, NOW)

        assert run.status.value == "RUNNING"
        assert run.incident_status.value == "TRIAGING"
        assert run.started_at == NOW
        assert run.event.event_key == "run.started"
        assert run.event.event_type == "run.started"
        assert run.event.payload["incidentStatus"] == "TRIAGING"
        assert run.event.payload["runStatus"] == "RUNNING"


@pytest.mark.asyncio
async def test_start_run_rolls_back_both_states_when_event_insert_fails(
    tmp_path: Path,
) -> None:
    def fail_started_event(
        _mapper: object, _connection: object, target: RunEventRow
    ) -> None:
        if target.event_type == "run.started":
            raise OperationalError("statement", {}, RuntimeError("database failed"))

    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )
        event.listen(RunEventRow, "before_insert", fail_started_event)
        try:
            with pytest.raises(PersistenceOperationError):
                await repository.start_run(created.run_id, NOW)
        finally:
            event.remove(RunEventRow, "before_insert", fail_started_event)

        async with database.session_factory() as session:
            incident = await session.get(IncidentRow, str(created.incident_id))
            run = await session.get(RunRow, str(created.run_id))
            assert incident is not None
            assert run is not None
            assert incident.status.value == "RECEIVED"
            assert run.status.value == "QUEUED"
            assert run.started_at is None
        assert await _row_count(database, RunEventRow) == 1


@pytest.mark.asyncio
async def test_evidence_and_event_are_committed_atomically(tmp_path: Path) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )
        await repository.start_run(created.run_id, NOW)
        evidence_record = EvidenceRecord(
            run_id=created.run_id,
            tool_call_id="call-1",
            tool_name="get_pods",
            evidence_kind="pod_waiting_state",
            target_ref={"name": "pod-a", "namespace": "k8s-incident-scenarios"},
            observed_at=NOW,
            payload={"waitingReason": "ImagePullBackOff"},
            truncated=False,
            redacted=False,
        )

        persisted = await repository.record_evidence(evidence_record)

        assert persisted.event.event_key == "tool:call-1:evidence"
        assert persisted.event.event_type == "evidence.recorded"
        assert persisted.event.payload["evidenceId"] == str(persisted.id)
        assert await _row_count(database, EvidenceRow) == 1


@pytest.mark.asyncio
async def test_evidence_rolls_back_when_its_event_insert_fails(tmp_path: Path) -> None:
    def fail_evidence_event(
        _mapper: object, _connection: object, target: RunEventRow
    ) -> None:
        if target.event_type == "evidence.recorded":
            raise OperationalError("statement", {}, RuntimeError("database failed"))

    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )
        await repository.start_run(created.run_id, NOW)
        event.listen(RunEventRow, "before_insert", fail_evidence_event)
        try:
            with pytest.raises(PersistenceOperationError):
                await repository.record_evidence(
                    EvidenceRecord(
                        run_id=created.run_id,
                        tool_call_id="call-1",
                        tool_name="get_pods",
                        evidence_kind="pod_waiting_state",
                        target_ref={"name": "pod-a"},
                        observed_at=NOW,
                        payload={"waitingReason": "ImagePullBackOff"},
                        truncated=False,
                        redacted=False,
                    )
                )
        finally:
            event.remove(RunEventRow, "before_insert", fail_evidence_event)

        assert await _row_count(database, EvidenceRow) == 0
        assert await _row_count(database, RunEventRow) == 2


@pytest.mark.asyncio
async def test_workflow_snapshot_and_recoverable_scan_use_persisted_run_state(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        queued = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )
        running = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )
        await repository.start_run(running.run_id, NOW)

        queued_snapshot = await repository.get_workflow_run_snapshot(queued.run_id)
        running_snapshot = await repository.get_workflow_run_snapshot(running.run_id)

        assert queued_snapshot.run_status is RunStatus.QUEUED
        assert queued_snapshot.started_at is None
        assert queued_snapshot.trigger_summary == _scenario().trigger_summary
        assert queued_snapshot.target == _scenario().target
        assert isinstance(queued_snapshot, DiagnosisWorkflowRunSnapshot)
        assert queued_snapshot.model == _model()
        assert queued_snapshot.budget == _budget()
        assert running_snapshot.run_status is RunStatus.RUNNING
        assert running_snapshot.started_at == NOW
        assert await repository.list_recoverable_run_ids() == (
            queued.run_id,
            running.run_id,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    ["missing", "tampered", "run_updated_at"],
)
async def test_workflow_snapshot_requires_matching_run_started_event(
    tmp_path: Path,
    mutation: str,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )
        await repository.start_run(created.run_id, NOW)

        async with database.session_factory() as session, session.begin():
            start_event = await session.scalar(
                select(RunEventRow).where(
                    RunEventRow.run_id == str(created.run_id),
                    RunEventRow.event_key == "run.started",
                )
            )
            assert start_event is not None
            if mutation == "missing":
                await session.delete(start_event)
            elif mutation == "tampered":
                start_event.payload_json = "{}"
            elif mutation == "run_updated_at":
                run = await session.get(RunRow, str(created.run_id))
                assert run is not None
                run.updated_at = NOW.replace(second=1)
            else:
                raise AssertionError("Unknown mutation")

        with pytest.raises(RecoveryConsistencyError):
            await repository.get_workflow_run_snapshot(created.run_id)


@pytest.mark.asyncio
async def test_workflow_snapshot_validates_completed_diagnosis_and_terminal_event(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )
        await repository.start_run(created.run_id, NOW)
        await repository.record_tool_started(
            created.run_id,
            "call-workload",
            "get_workload",
        )
        evidence = await repository.record_evidence(
            EvidenceRecord(
                run_id=created.run_id,
                tool_call_id="call-workload",
                tool_name="get_workload",
                evidence_kind="workload",
                target_ref={"kind": "Deployment", "name": "image-pull-backoff"},
                observed_at=NOW,
                payload={"availableReplicas": 0},
                truncated=False,
                redacted=False,
            )
        )
        completed_at = NOW.replace(minute=1)
        await repository.persist_terminal(
            TerminalRecord(
                run_id=created.run_id,
                completed_at=completed_at,
                outcome=DiagnosisOutcome.DIAGNOSED,
                summary="The Deployment has no available replicas.",
                root_causes=(
                    RootCauseRecord(
                        code="deployment_unavailable",
                        statement="The workload observation reports zero availability.",
                        confidence="high",
                        evidence_ids=(evidence.id,),
                    ),
                ),
                missing_information=(),
                redacted=False,
                error_code=None,
                error_retryable=None,
                model_calls=2,
                tool_calls=2,
                input_tokens=None,
                output_tokens=None,
            )
        )

        snapshot = await repository.get_workflow_run_snapshot(created.run_id)

        assert snapshot.run_status is RunStatus.COMPLETED
        assert snapshot.started_at == NOW
        assert await repository.list_recoverable_run_ids() == ()

        async with database.session_factory() as session, session.begin():
            terminal_event = await session.scalar(
                select(RunEventRow).where(
                    RunEventRow.run_id == str(created.run_id),
                    RunEventRow.event_key == "run:terminal",
                )
            )
            assert terminal_event is not None
            terminal_event.payload_json = "{}"

        with pytest.raises(RecoveryConsistencyError):
            await repository.get_workflow_run_snapshot(created.run_id)


@pytest.mark.asyncio
async def test_workflow_snapshot_reuses_strict_diagnosis_contract(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )
        await repository.start_run(created.run_id, NOW)
        await repository.record_tool_started(
            created.run_id,
            "call-workload",
            "get_workload",
        )
        evidence = await repository.record_evidence(
            EvidenceRecord(
                run_id=created.run_id,
                tool_call_id="call-workload",
                tool_name="get_workload",
                evidence_kind="workload",
                target_ref={"kind": "Deployment", "name": "image-pull-backoff"},
                observed_at=NOW,
                payload={"availableReplicas": 0},
                truncated=False,
                redacted=False,
            )
        )
        await repository.persist_terminal(
            TerminalRecord(
                run_id=created.run_id,
                completed_at=NOW.replace(minute=1),
                outcome=DiagnosisOutcome.DIAGNOSED,
                summary="The Deployment has no available replicas.",
                root_causes=(
                    RootCauseRecord(
                        code="deployment_unavailable",
                        statement="The workload observation reports zero availability.",
                        confidence="high",
                        evidence_ids=(evidence.id,),
                    ),
                ),
                missing_information=(),
                redacted=False,
                error_code=None,
                error_retryable=None,
                model_calls=2,
                tool_calls=2,
                input_tokens=None,
                output_tokens=None,
            )
        )

        async with database.session_factory() as session, session.begin():
            diagnosis = await session.scalar(
                select(DiagnosisRow).where(DiagnosisRow.run_id == str(created.run_id))
            )
            assert diagnosis is not None
            diagnosis.root_causes_json = json.dumps(
                [
                    {
                        "code": "deployment_unavailable",
                        "statement": (
                            "The workload observation reports zero availability."
                        ),
                        "confidence": "high",
                        "evidence_ids": [str(evidence.id), str(evidence.id)],
                    }
                ]
            )

        with pytest.raises(RecoveryConsistencyError):
            await repository.get_workflow_run_snapshot(created.run_id)


@pytest.mark.asyncio
async def test_recommendations_survive_a_restart_and_absence_stays_absent(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )
        await repository.start_run(created.run_id, NOW)
        await repository.record_tool_started(created.run_id, "call-1", "get_workload")
        evidence = await repository.record_evidence(
            EvidenceRecord(
                run_id=created.run_id,
                tool_call_id="call-1",
                tool_name="get_workload",
                evidence_kind="workload",
                target_ref={"kind": "Deployment", "name": "image-pull-backoff"},
                observed_at=NOW,
                payload={"availableReplicas": 0},
                truncated=False,
                redacted=False,
            )
        )
        recommendation = RecommendationRecord(
            action="对照 rollout 历史确认当前镜像是否为误发布",
            purpose="判断是否应回到上一可用镜像",
            preconditions="确认上一版本镜像仍可拉取",
            risk="上一版本同样有问题时无法恢复",
            verification="观察可用副本是否回到期望值",
            evidence_ids=(evidence.id,),
        )
        await repository.persist_terminal(
            TerminalRecord(
                run_id=created.run_id,
                completed_at=NOW.replace(minute=1),
                outcome=DiagnosisOutcome.DIAGNOSED,
                summary="The Deployment has no available replicas.",
                root_causes=(
                    RootCauseRecord(
                        code="deployment_unavailable",
                        statement="The workload observation reports zero availability.",
                        confidence="high",
                        evidence_ids=(evidence.id,),
                    ),
                ),
                missing_information=(),
                redacted=False,
                error_code=None,
                error_retryable=None,
                model_calls=2,
                tool_calls=2,
                input_tokens=None,
                output_tokens=None,
                recommendations=(recommendation,),
            )
        )

    # A fresh process reads the same database file.
    database = await create_business_database(
        RuntimePaths.prepare(tmp_path / "runtime")
    )
    try:
        repository = IncidentRepository(database.session_factory)
        detail = await repository.get_incident_detail(
            created.incident_id, run_id=created.run_id, event_limit=10
        )
        assert detail is not None
        assert detail.diagnosis is not None
        assert detail.diagnosis.recommendations == (recommendation,)

        async with database.session_factory() as session, session.begin():
            row = await session.scalar(select(DiagnosisRow))
            assert row is not None
            # A Run recorded before this column keeps NULL, and the reader is
            # told the Run produced none instead of being shown an empty list.
            row.recommendations_json = None
        detail = await repository.get_incident_detail(
            created.incident_id, run_id=created.run_id, event_limit=10
        )
        assert detail is not None
        assert detail.diagnosis is not None
        assert detail.diagnosis.recommendations is None
    finally:
        await database.dispose()


@pytest.mark.asyncio
async def test_status_writes_publish_the_status_they_persisted(tmp_path: Path) -> None:
    """The overview reads terminal transitions out of the event payloads.

    This pins the diagnosis chain; the repair chain's own ending is pinned in
    `test_repair_persistence.py`. A schema version that drops the field from
    either chain fails one of them.
    """

    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )
        started = await repository.start_run(created.run_id, NOW)
        terminal = await repository.persist_terminal(
            TerminalRecord(
                run_id=created.run_id,
                completed_at=NOW.replace(minute=2),
                outcome=DiagnosisOutcome.INSUFFICIENT_EVIDENCE,
                summary="Evidence is insufficient.",
                root_causes=(),
                missing_information=("registry pull audit",),
                redacted=False,
                error_code=None,
                error_retryable=None,
                model_calls=1,
                tool_calls=1,
                input_tokens=10,
                output_tokens=10,
            )
        )

        async with database.session_factory() as session:
            rows = (
                await session.scalars(select(RunEventRow).order_by(RunEventRow.id))
            ).all()
            incident = await session.get(IncidentRow, str(created.incident_id))

        assert incident is not None
        assert incident.status.value == "INSUFFICIENT_EVIDENCE"
        published = {
            row.event_key: json.loads(row.payload_json).get("incidentStatus")
            for row in rows
        }
        assert published == {
            "incident.created": "RECEIVED",
            "run.started": "TRIAGING",
            "run:terminal": "INSUFFICIENT_EVIDENCE",
        }
        assert created.incident_status.value == "RECEIVED"
        assert started.incident_status.value == "TRIAGING"
        assert terminal.incident_status.value == incident.status.value
        # The overview counts this event; its key marks the Run's own ending.
        assert [row.event_key for row in rows][-1] == "run:terminal"
