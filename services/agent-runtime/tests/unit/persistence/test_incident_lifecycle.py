import asyncio
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
from typing import cast
from uuid import UUID

import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    V1DeploymentCondition,
)
from sqlalchemy import event, select, text
from tests.factories import normalized_trigger
from tests.recovery_fixtures import MonitoringFixture, RecoveryFixture
from tests.unit.monitoring.test_reconciliation import CurrentTargetFixture
from tests.unit.persistence.test_episode_diagnosis import (
    CATALOG,
    CRASH,
    diagnose_run,
    observation,
    occurrence,
)
from tests.unit.persistence.test_repair_persistence import (
    BUDGET,
    MODEL,
    _database,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.repair.test_explicit_rollback import finish_source, observe
from tests.unit.repair.test_repair_preparation import FRESH_NOW, TARGET
from tests.unit.repair.test_repair_preparation import (
    credential as diagnostic_credential,
)
from tests.unit.routes.test_approvals import applied_result, approval_harness
from tests.unit.routes.test_operator import credential as credential

from k8s_incident_agent.api import RuntimeContainer
from k8s_incident_agent.application.event_projection import validated_stream_item
from k8s_incident_agent.domain.models import (
    AlertSignalStatus,
    CanonicalAlertTimestamp,
    IncidentLifecycleStatus,
    IncidentStatus,
    RepairWorkflowRunSnapshot,
)
from k8s_incident_agent.monitoring.contracts import (
    CurrentAlertObservation,
    CurrentAlertState,
    CurrentAlertSummary,
    ObservationReason,
)
from k8s_incident_agent.persistence.models import (
    AlertSignalRow,
    CurrentAlertObservationRow,
    IncidentRow,
    RunRow,
)
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    PruneTarget,
    RecoveryConsistencyError,
    ResolvedAlertPruneTarget,
)
from k8s_incident_agent.repair.verification import verify_recovery


async def healthy_observation(at: datetime) -> CurrentAlertObservation:
    observed = await observation(
        at,
        alerts=tuple(
            entry.alert_id
            for entry in CATALOG.entries
            if entry.target.kind == TARGET.kind
        ),
    )
    return observed.model_copy(
        update={
            "summary": observed.summary.model_copy(
                update={
                    "state": CurrentAlertState.CLEAR,
                    "rules": tuple(
                        rule.model_copy(update={"state": CurrentAlertState.CLEAR})
                        for rule in observed.summary.rules
                    ),
                }
            )
        }
    )


async def sample(repository: IncidentRepository, at: datetime) -> None:
    revision = await repository.save_current_alert_observation(
        await healthy_observation(at)
    )
    await repository.reconcile_episode_diagnosis(
        TARGET,
        CATALOG,
        None,
        BUDGET,
        sample_started_at=at,
        observation_revision=revision,
    )


@pytest.mark.parametrize("with_run", [False, True])
async def test_stable_health_closes_without_changing_processing_or_run_history(
    tmp_path: Path, with_run: bool
) -> None:
    clock = [FRESH_NOW]
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        await repository.apply_alert_occurrences((occurrence(CRASH, 1),))
        revision = await repository.save_current_alert_observation(await observation())
        runs = await repository.reconcile_episode_diagnosis(
            TARGET,
            CATALOG,
            MODEL if with_run else None,
            BUDGET,
            sample_started_at=clock[0],
            observation_revision=revision,
        )
        if with_run:
            await diagnose_run(repository, runs[0], CurrentTargetFixture(), clock[0])
        async with database.session_factory() as session:
            incident_id = UUID((await session.scalars(select(IncidentRow.id))).one())
        for tick in range(11):
            clock[0] = FRESH_NOW + timedelta(seconds=30 + tick * 30)
            await sample(repository, clock[0])
            detail = await repository.get_incident_detail(
                incident_id, run_id=None, event_limit=100
            )
            assert detail is not None
            assert detail.incident.lifecycle_status is (
                IncidentLifecycleStatus.CLOSED
                if tick == 10
                else IncidentLifecycleStatus.OPEN
            )
            assert detail.incident.status is (
                IncidentStatus.DIAGNOSED if with_run else IncidentStatus.RECEIVED
            )
        events = await repository.list_incident_events(
            incident_id, after_id=0, limit=100
        )
        closed = [event for event in events if event.event_type == "incident.closed"]
        assert len(closed) == 1 and closed[0].run_id is None
        assert closed[0].payload["basis"] == "observed_stable"
        validated_stream_item(closed[0])
        async with database.session_factory() as session:
            assert len(list(await session.scalars(select(RunRow)))) == int(with_run)


async def open_episode(repository: IncidentRepository) -> UUID:
    signal = occurrence(CRASH, 1)
    await repository.apply_alert_occurrences((signal,))
    revision = await repository.save_current_alert_observation(await observation())
    await repository.reconcile_episode_diagnosis(
        TARGET,
        CATALOG,
        None,
        BUDGET,
        sample_started_at=FRESH_NOW,
        observation_revision=revision,
    )
    async with repository._session_factory() as session:  # pyright: ignore[reportPrivateUsage]
        incident_id = await session.scalar(
            select(AlertSignalRow.incident_id).where(
                AlertSignalRow.fingerprint == signal.fingerprint,
                AlertSignalRow.starts_at == signal.starts_at,
            )
        )
        assert incident_id is not None
        return UUID(incident_id)


async def advance_window(
    repository: IncidentRepository, clock: list[datetime], ticks: int = 10
) -> None:
    for _ in range(ticks):
        clock[0] += timedelta(seconds=30)
        await sample(repository, clock[0])


@pytest.mark.parametrize("change", ["duplicate", "new", "status", "aba", "observation"])
async def test_only_unchanged_sampling_revision_can_close(
    tmp_path: Path, change: str
) -> None:
    clock = [FRESH_NOW]
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        incident_id = await open_episode(repository)
        await advance_window(repository, clock)
        clock[0] += timedelta(seconds=30)
        healthy = await healthy_observation(clock[0])
        revision = await repository.save_current_alert_observation(healthy)
        firing = occurrence(CRASH, 1)
        if change == "observation":
            await repository.save_current_alert_observation(healthy)
        elif change in ("status", "aba"):
            await repository.apply_alert_occurrences(
                (
                    replace(
                        firing,
                        status=AlertSignalStatus.RESOLVED,
                        ends_at=CanonicalAlertTimestamp(
                            clock[0].strftime("%Y-%m-%dT%H:%M:%S.000000000Z")
                        ),
                    ),
                )
            )
            if change == "aba":
                await repository.apply_alert_occurrences((firing,))
        else:
            await repository.apply_alert_occurrences(
                (occurrence(CRASH, 2) if change == "new" else firing,)
            )
        await repository.reconcile_episode_diagnosis(
            TARGET,
            CATALOG,
            None,
            BUDGET,
            sample_started_at=clock[0],
            observation_revision=revision,
        )
        detail = await repository.get_incident_detail(
            incident_id, run_id=None, event_limit=100
        )
        assert detail is not None
        assert detail.incident.lifecycle_status is (
            IncidentLifecycleStatus.CLOSED
            if change == "duplicate"
            else IncidentLifecycleStatus.OPEN
        )


@pytest.mark.parametrize(
    "fault",
    [
        "unknown",
        "pending",
        "firing",
        "uid",
        "unhealthy",
        "rules",
        "catalog",
        "clock",
        "gap",
        "restart",
    ],
)
async def test_untrusted_health_interrupts_the_entire_stable_window(
    tmp_path: Path, fault: str
) -> None:
    clock = [FRESH_NOW]
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        incident_id = await open_episode(repository)
        await advance_window(repository, clock)
        clock[0] += timedelta(seconds=61 if fault == "gap" else 30)
        healthy = await healthy_observation(clock[0])
        assert healthy.facts is not None
        if fault in ("unknown", "pending", "firing"):
            state = CurrentAlertState(fault.upper())
            healthy = healthy.model_copy(
                update={
                    "summary": healthy.summary.model_copy(
                        update={"state": state, "complete": fault != "unknown"}
                    )
                }
            )
        elif fault == "uid":
            healthy = healthy.model_copy(
                update={
                    "facts": healthy.facts.model_copy(
                        update={
                            "target_ref": healthy.facts.target_ref.model_copy(
                                update={"uid": "recreated"}
                            )
                        }
                    )
                }
            )
        elif fault == "unhealthy":
            healthy = healthy.model_copy(
                update={"facts": healthy.facts.model_copy(update={"healthy": False})}
            )
        elif fault == "rules":
            healthy = healthy.model_copy(
                update={
                    "summary": healthy.summary.model_copy(
                        update={"rules": healthy.summary.rules[1:]}
                    )
                }
            )
        elif fault == "catalog":
            healthy = healthy.model_copy(update={"catalog_version": "outdated"})
        elif fault == "clock":
            healthy = healthy.model_copy(
                update={
                    "summary": healthy.summary.model_copy(
                        update={"received_at": clock[0] + timedelta(seconds=1)}
                    )
                }
            )
        elif fault == "restart":
            await repository.interrupt_stable_health()
        revision = await repository.save_current_alert_observation(healthy)
        await repository.reconcile_episode_diagnosis(
            TARGET,
            CATALOG,
            None,
            BUDGET,
            sample_started_at=clock[0],
            observation_revision=revision,
        )
        detail = await repository.get_incident_detail(
            incident_id, run_id=None, event_limit=100
        )
        assert (
            detail is not None
            and detail.incident.lifecycle_status is IncidentLifecycleStatus.OPEN
        )
        await advance_window(repository, clock, 9)
        detail = await repository.get_incident_detail(
            incident_id, run_id=None, event_limit=100
        )
        assert (
            detail is not None
            and detail.incident.lifecycle_status is IncidentLifecycleStatus.OPEN
        )
        await advance_window(repository, clock, 2)
        detail = await repository.get_incident_detail(
            incident_id, run_id=None, event_limit=100
        )
        assert (
            detail is not None
            and detail.incident.lifecycle_status is IncidentLifecycleStatus.CLOSED
        )


async def test_final_clock_is_read_after_acquiring_the_write_lock(
    tmp_path: Path,
) -> None:
    clock = [FRESH_NOW]
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        incident_id = await open_episode(repository)
        await advance_window(repository, clock)
        clock[0] += timedelta(seconds=30)
        started = clock[0]
        revision = await repository.save_current_alert_observation(
            await healthy_observation(started)
        )
        waiting = asyncio.Event()

        def locking(
            _connection: object,
            _cursor: object,
            statement: str,
            _parameters: object,
            _context: object,
            _many: bool,
        ) -> None:
            if statement == "BEGIN IMMEDIATE":
                waiting.set()

        async with database.session_factory() as blocker:
            await blocker.execute(text("BEGIN IMMEDIATE"))
            event.listen(database.engine.sync_engine, "before_cursor_execute", locking)
            task = asyncio.create_task(
                repository.reconcile_episode_diagnosis(
                    TARGET,
                    CATALOG,
                    None,
                    BUDGET,
                    sample_started_at=started,
                    observation_revision=revision,
                )
            )
            try:
                await asyncio.wait_for(waiting.wait(), 5)
                clock[0] += timedelta(seconds=61)
                await blocker.commit()
                await task
            finally:
                event.remove(
                    database.engine.sync_engine, "before_cursor_execute", locking
                )
                await asyncio.gather(task, return_exceptions=True)
        detail = await repository.get_incident_detail(
            incident_id, run_id=None, event_limit=100
        )
        assert (
            detail is not None
            and detail.incident.lifecycle_status is IncidentLifecycleStatus.OPEN
        )


@pytest.mark.parametrize("identity", ["saved", "missing", "contradictory", "legacy"])
async def test_scenario_closure_uses_saved_evidence_uid_without_adopting_identity(
    tmp_path: Path, identity: str
) -> None:
    clock = [FRESH_NOW]
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        created = await repository.create_incident_and_run(
            normalized_trigger(), MODEL, BUDGET
        )
        await diagnose_run(repository, created.run_id, CurrentTargetFixture(), clock[0])
        from k8s_incident_agent.persistence.models import EvidenceRow

        async with database.session_factory.begin() as session:
            incident = await session.get(IncidentRow, str(created.incident_id))
            assert incident is not None
            if identity == "legacy":
                incident.lifecycle_status = None
            for index, saved in enumerate(await session.scalars(select(EvidenceRow))):
                if identity == "missing" or (
                    identity == "contradictory" and index == 0
                ):
                    saved.target_ref_json = saved.target_ref_json.replace(
                        "deployment-uid", "other-uid"
                    )
        await advance_window(repository, clock, 11)
        detail = await repository.get_incident_detail(
            created.incident_id, run_id=None, event_limit=100
        )
        assert detail is not None
        assert detail.incident.lifecycle_status is (
            IncidentLifecycleStatus.CLOSED
            if identity == "saved"
            else None
            if identity == "legacy"
            else IncidentLifecycleStatus.OPEN
        )
        async with database.session_factory() as session:
            incident = await session.get(IncidentRow, str(created.incident_id))
            assert (
                incident is not None
                and incident.target_uid is None
                and incident.correlation_group is None
            )


async def test_prune_uses_closure_time_and_deletes_zero_run_aggregate(
    tmp_path: Path,
) -> None:
    clock = [FRESH_NOW]
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        incident_id = await open_episode(repository)
        await advance_window(repository, clock, 11)
        closed = clock[0]
        async with database.session_factory.begin() as session:
            incident = await session.get(IncidentRow, str(incident_id))
            assert incident is not None
            incident.updated_at = closed + timedelta(days=8)
        assert await repository.list_prune_targets(closed, tmp_path / "artifacts") == ()
        targets = await repository.list_prune_targets(
            closed + timedelta(seconds=1), tmp_path / "artifacts"
        )
        assert len(targets) == 1 and isinstance(targets[0], PruneTarget)
        assert targets[0].closed_at == closed and targets[0].run_ids == ()
        assert await repository.delete_prune_target(
            targets[0], closed + timedelta(seconds=1), tmp_path / "artifacts"
        )
        assert not await repository.delete_prune_target(
            targets[0], closed + timedelta(seconds=1), tmp_path / "artifacts"
        )
        async with database.session_factory() as session:
            assert not list(await session.scalars(select(IncidentRow)))
            assert not list(await session.scalars(select(AlertSignalRow)))
            assert not list(await session.scalars(select(CurrentAlertObservationRow)))


@pytest.mark.parametrize(
    "change",
    [None, "unknown", "new_firing", "aba", "unreviewed_clear", "catalog", "rules"],
)
async def test_resolved_unassociated_intake_requires_current_review_and_confirm_recheck(
    tmp_path: Path, change: str | None
) -> None:
    clock = [FRESH_NOW]
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        resolved = replace(
            occurrence(CRASH, 1),
            status=AlertSignalStatus.RESOLVED,
            ends_at=CanonicalAlertTimestamp(
                FRESH_NOW.strftime("%Y-%m-%dT%H:%M:%S.000000000Z")
            ),
        )
        await repository.apply_alert_occurrences((resolved,))
        cutoff = FRESH_NOW + timedelta(days=8)
        assert await repository.list_prune_targets(cutoff, tmp_path) == ()
        await sample(repository, clock[0])
        targets = await repository.list_prune_targets(cutoff, tmp_path)
        assert len(targets) == 1 and isinstance(targets[0], ResolvedAlertPruneTarget)
        if change == "unknown":
            await repository.save_current_alert_observation(
                CurrentAlertObservation(
                    target=TARGET,
                    catalog_version=CATALOG.version,
                    facts=None,
                    summary=CurrentAlertSummary(reason=ObservationReason.UNAVAILABLE),
                )
            )
        elif change == "new_firing":
            await repository.apply_alert_occurrences((occurrence(CRASH, 2),))
        elif change == "aba":
            await repository.apply_alert_occurrences((occurrence(CRASH, 1),))
            await repository.apply_alert_occurrences((resolved,))
        elif change in ("unreviewed_clear", "catalog", "rules"):
            replacement = await healthy_observation(clock[0])
            if change == "catalog":
                replacement = replacement.model_copy(
                    update={"catalog_version": "different"}
                )
            if change == "rules":
                replacement = replacement.model_copy(
                    update={
                        "summary": replacement.summary.model_copy(update={"rules": ()})
                    }
                )
            revision = await repository.save_current_alert_observation(replacement)
            if change != "unreviewed_clear":
                await repository.reconcile_episode_diagnosis(
                    TARGET,
                    CATALOG,
                    None,
                    BUDGET,
                    sample_started_at=clock[0],
                    observation_revision=revision,
                )
        if change:
            assert await repository.list_prune_targets(cutoff, tmp_path) == ()
            with pytest.raises(RecoveryConsistencyError):
                await repository.delete_prune_target(targets[0], cutoff, tmp_path)
        else:
            assert await repository.delete_prune_target(targets[0], cutoff, tmp_path)
            async with database.session_factory() as session:
                assert not list(await session.scalars(select(AlertSignalRow)))
                assert not list(
                    await session.scalars(select(CurrentAlertObservationRow))
                )


@pytest.mark.parametrize(
    "fault,other_incident,clock_backwards",
    [
        ("target_drift", False, False),
        ("workload_failed", False, False),
        ("target_drift", True, True),
    ],
)
async def test_failed_verification_invalidates_sample_and_restarts_target_window(
    tmp_path: Path,
    credential: tuple[str, str],
    fault: str,
    other_incident: bool,
    clock_backwards: bool,
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()
        result = await applied_result(harness)
        run = cast(
            RepairWorkflowRunSnapshot,
            await harness.repository.get_workflow_run_snapshot(harness.run_id),
        )
        assert run.execution is not None
        await harness.repository.report_execution(
            run.execution.id, result, now=harness.now
        )
        incident_id = (
            await open_episode(harness.repository)
            if other_incident
            else harness.incident_id
        )
        await advance_window(harness.repository, harness.clock, 10)
        harness.clock[0] += timedelta(seconds=30)
        sampled_at = harness.now()
        revision = await harness.repository.save_current_alert_observation(
            await healthy_observation(sampled_at)
        )
        kube = RecoveryFixture()
        if fault == "target_drift":
            kube.deployment.metadata.generation = 5
        else:
            kube.deployment.status.conditions = [
                V1DeploymentCondition(
                    type="Progressing",
                    status="False",
                    reason="ProgressDeadlineExceeded",
                )
            ]
        if clock_backwards:
            harness.clock[0] -= timedelta(seconds=1)
        await observe(harness, harness.run_id, kube)
        harness.clock[0] = sampled_at
        verified = await harness.repository.get_incident_detail(
            harness.incident_id, run_id=harness.run_id, event_limit=100
        )
        assert verified is not None and verified.repair is not None
        assert verified.repair.verification is not None
        assert verified.repair.verification.outcome == fault
        await harness.repository.reconcile_episode_diagnosis(
            TARGET,
            CATALOG,
            None,
            BUDGET,
            sample_started_at=sampled_at,
            observation_revision=revision,
        )
        detail = await harness.repository.get_incident_detail(
            incident_id, run_id=None, event_limit=100
        )
        assert detail is not None
        assert detail.incident.lifecycle_status is IncidentLifecycleStatus.OPEN
        await advance_window(harness.repository, harness.clock, 10)
        detail = await harness.repository.get_incident_detail(
            incident_id, run_id=None, event_limit=100
        )
        assert detail is not None
        assert detail.incident.lifecycle_status is IncidentLifecycleStatus.OPEN
        await advance_window(harness.repository, harness.clock, 1)
        detail = await harness.repository.get_incident_detail(
            incident_id, run_id=None, event_limit=100
        )
        assert detail is not None
        assert detail.incident.lifecycle_status is IncidentLifecycleStatus.CLOSED
        closed = [
            item
            for item in await harness.repository.list_incident_events(
                incident_id, after_id=0, limit=100
            )
            if item.event_type == "incident.closed"
        ]
        assert len(closed) == 1 and closed[0].payload["basis"] == "observed_stable"


async def test_observing_verification_interruption_requires_a_new_window_after_recovery(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()
        result = await applied_result(harness)
        run = cast(
            RepairWorkflowRunSnapshot,
            await harness.repository.get_workflow_run_snapshot(harness.run_id),
        )
        assert run.execution is not None
        await harness.repository.report_execution(
            run.execution.id, result, now=harness.now
        )
        await advance_window(harness.repository, harness.clock, 5)
        kube = RecoveryFixture()
        kube.deployment.status.available_replicas = 0
        interrupted_at = harness.now()

        async def tick(seconds: float) -> None:
            detail = await harness.repository.get_incident_detail(
                harness.incident_id, run_id=harness.run_id, event_limit=100
            )
            assert detail is not None and detail.repair is not None
            assert detail.repair.verification is not None
            if harness.now() == interrupted_at:
                assert detail.repair.verification.outcome == "observing"
                assert detail.repair.verification.reason == "rollout_pending"
                kube.deployment.status.available_replicas = 1
            harness.clock[0] += timedelta(seconds=seconds)
            kube.now = harness.now()
            await harness.repository.apply_alert_occurrences(
                (), watchdog_received_at=harness.now()
            )
            await sample(harness.repository, harness.now())

        kube.now = harness.now()
        service = MonitoringFixture(harness.clock).service()
        try:
            await verify_recovery(
                harness.run_id,
                repository=harness.repository,
                adapter=kube.adapter(),
                prometheus=service,
                credential=diagnostic_credential(),
                now=harness.now,
                sleep=tick,
            )
        finally:
            await service.close()
        verified = await harness.repository.get_incident_detail(
            harness.incident_id, run_id=harness.run_id, event_limit=100
        )
        assert verified is not None and verified.repair is not None
        assert verified.repair.verification is not None
        assert verified.repair.verification.outcome == "recovered"
        await advance_window(harness.repository, harness.clock, 7)
        detail = await harness.repository.get_incident_detail(
            harness.incident_id, run_id=None, event_limit=100
        )
        assert detail is not None
        assert detail.incident.lifecycle_status is IncidentLifecycleStatus.OPEN
        await advance_window(harness.repository, harness.clock, 1)
        detail = await harness.repository.get_incident_detail(
            harness.incident_id, run_id=None, event_limit=100
        )
        assert detail is not None
        assert detail.incident.lifecycle_status is IncidentLifecycleStatus.CLOSED


@pytest.mark.parametrize("interruption", [None, "unknown", "clock_backwards", "reopen"])
async def test_verified_closure_requires_this_open_period_and_uninterrupted_recovery(
    tmp_path: Path,
    credential: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
    interruption: str | None,
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await finish_source(harness, recovered=True)
        if interruption in ("unknown", "clock_backwards"):
            completed_at = harness.now()
            harness.clock[0] += timedelta(
                seconds=-1 if interruption == "clock_backwards" else 1
            )
            await harness.repository.save_current_alert_observation(
                CurrentAlertObservation(
                    target=TARGET,
                    catalog_version=CATALOG.version,
                    facts=None,
                    summary=CurrentAlertSummary(reason=ObservationReason.UNAVAILABLE),
                )
            )
            harness.clock[0] = completed_at + timedelta(seconds=1)
        await advance_window(harness.repository, harness.clock, 11)
        events = await harness.repository.list_incident_events(
            harness.incident_id, after_id=0, limit=100
        )
        closed = [item for item in events if item.event_type == "incident.closed"]
        assert len(closed) == 1
        assert closed[0].payload["basis"] == (
            "observed_stable"
            if interruption in ("unknown", "clock_backwards")
            else "recovery_verified"
        )
        if interruption == "reopen":
            container = cast(RuntimeContainer, harness.app.state.container)
            monkeypatch.setattr(container.incidents, "_model", lambda: MODEL)
            result = await harness.client.post(
                f"/api/v1/incidents/{harness.incident_id}/runs",
                json={},
                headers=harness.headers,
            )
            assert result.status_code == 202, result.text
            from tests.unit.persistence.test_episode_diagnosis import fail_run

            await fail_run(
                harness.repository, UUID(result.json()["runId"]), harness.now()
            )
            await advance_window(harness.repository, harness.clock, 11)
            events = await harness.repository.list_incident_events(
                harness.incident_id, after_id=0, limit=100
            )
            assert [
                item.payload["basis"]
                for item in events
                if item.event_type == "incident.closed"
            ] == ["recovery_verified", "observed_stable"]


@pytest.mark.parametrize("operation", ["rerun", "rollback", "apply"])
async def test_closed_authenticated_actions_reopen_only_supported_paths_and_preserve_history(
    tmp_path: Path,
    credential: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        execution_id = await finish_source(harness, recovered=True)
        await advance_window(harness.repository, harness.clock, 11)
        path = f"/api/v1/incidents/{harness.incident_id}"
        container = cast(RuntimeContainer, harness.app.state.container)
        monkeypatch.setattr(container.incidents, "_model", lambda: MODEL)
        before = (await harness.client.get(path)).json()
        assert before["incident"]["lifecycleStatus"] == "CLOSED"
        assert before["actions"]["prepare"] == "not_applicable"
        assert before["actions"]["refresh"] == "not_applicable"
        body = (
            {}
            if operation == "rerun"
            else {
                "sourceRunId": str(harness.run_id),
                **(
                    {"sourceExecutionId": str(execution_id)}
                    if operation == "rollback"
                    else {}
                ),
            }
        )
        result = await harness.client.post(
            f"{path}/{'runs' if operation == 'rerun' else 'repair-runs'}",
            json=body,
            headers=harness.headers,
        )
        assert result.status_code == (409 if operation == "apply" else 202), result.text
        if operation == "apply":
            assert result.json()["error"]["code"] == "repair_source_invalid"
        after = (
            await harness.client.get(path, params={"runId": str(harness.run_id)})
        ).json()
        assert after["selectedRun"] == before["selectedRun"]
        assert after["verification"] == before["verification"]
        assert after["incident"]["lifecycleStatus"] == (
            "CLOSED" if operation == "apply" else "OPEN"
        )
        events = await harness.repository.list_incident_events(
            harness.incident_id, after_id=0, limit=100
        )
        reopened = [item for item in events if item.event_type == "incident.reopened"]
        assert len(reopened) == (0 if operation == "apply" else 1)
        for item in reopened:
            assert item.run_id is None
            validated_stream_item(item)


async def test_same_uid_open_episode_rejects_rerun_with_a_distinct_conflict(
    tmp_path: Path, credential: tuple[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        repository = harness.repository
        await repository.apply_alert_occurrences((occurrence(CRASH, 11),))
        revision = await repository.save_current_alert_observation(
            await observation(harness.now())
        )
        runs = await repository.reconcile_episode_diagnosis(
            TARGET,
            CATALOG,
            MODEL,
            BUDGET,
            sample_started_at=harness.now(),
            observation_revision=revision,
        )
        assert len(runs) == 1
        await diagnose_run(repository, runs[0], CurrentTargetFixture(), harness.now())
        async with harness.database.session_factory() as session:
            original = (
                await session.scalars(select(RunRow).where(RunRow.id == str(runs[0])))
            ).one()
            incident_id = original.incident_id
        await advance_window(repository, harness.clock, 11)
        await repository.apply_alert_occurrences(
            (occurrence(CRASH, 12, harness.now()),)
        )
        revision = await repository.save_current_alert_observation(
            await observation(harness.now())
        )
        await repository.reconcile_episode_diagnosis(
            TARGET,
            CATALOG,
            None,
            BUDGET,
            sample_started_at=harness.now(),
            observation_revision=revision,
        )
        container = cast(RuntimeContainer, harness.app.state.container)
        monkeypatch.setattr(container.incidents, "_model", lambda: MODEL)
        path = f"/api/v1/incidents/{incident_id}"
        before = (await harness.client.get(path)).json()
        assert before["actions"]["rerun"] == "incident_reopen_conflict"
        result = await harness.client.post(
            f"{path}/runs", json={}, headers=harness.headers
        )
        assert (
            result.status_code == 409
            and result.json()["error"]["code"] == "incident_reopen_conflict"
        )
        async with harness.database.session_factory() as session:
            assert (
                len(
                    list(
                        await session.scalars(
                            select(RunRow).where(RunRow.incident_id == incident_id)
                        )
                    )
                )
                == 1
            )


@pytest.mark.parametrize("occupant", ["waiting", "new_run", "foreign_unknown"])
async def test_final_closure_respects_live_run_approval_and_exact_target_execution(
    tmp_path: Path,
    credential: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
    occupant: str,
) -> None:
    from k8s_incident_agent.execution.contracts import ExecutionResult
    from k8s_incident_agent.persistence.models import ExecutionRow

    async with approval_harness(tmp_path, credential) as harness:
        incident_id = harness.incident_id
        if occupant == "foreign_unknown":
            await harness.approve()
            command = await harness.repository.claim_execution(now=harness.now)
            assert command is not None
            await harness.repository.report_execution(
                command.execution_id,
                ExecutionResult(outcome="UNKNOWN", error="outcome_unknown"),
                now=harness.now,
            )
            incident_id = await open_episode(harness.repository)
        elif occupant == "new_run":
            await finish_source(harness, recovered=True)
        await advance_window(harness.repository, harness.clock, 10)
        if occupant == "new_run":
            container = cast(RuntimeContainer, harness.app.state.container)
            monkeypatch.setattr(container.incidents, "_model", lambda: MODEL)
            response = await harness.client.post(
                f"/api/v1/incidents/{incident_id}/runs",
                json={},
                headers=harness.headers,
            )
            assert response.status_code == 202, response.text
        await advance_window(harness.repository, harness.clock, 1)
        detail = await harness.repository.get_incident_detail(
            incident_id, run_id=None, event_limit=100
        )
        assert (
            detail is not None
            and detail.incident.lifecycle_status is IncidentLifecycleStatus.OPEN
        )
        assert not [
            item
            for item in await harness.repository.list_incident_events(
                incident_id, after_id=0, limit=100
            )
            if item.event_type == "incident.closed"
        ]
        if occupant == "foreign_unknown":
            async with harness.database.session_factory() as session:
                execution = (await session.scalars(select(ExecutionRow))).one()
                assert (
                    execution.status == "UNKNOWN"
                    and execution.target_released_at is None
                )
