import asyncio
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, cast
from urllib.parse import parse_qs

import pytest
from sqlalchemy import func, select
from tests.factories import normalized_trigger
from tests.recovery_fixtures import RecoveryFixture
from tests.unit.monitoring.test_reconciliation import (
    CurrentMonitoringFixture,
    CurrentTargetFixture,
)
from tests.unit.persistence.test_episode_diagnosis import CATALOG
from tests.unit.persistence.test_repair_persistence import (
    BUDGET,
    MODEL,
    _database,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.repair.test_explicit_rollback import observe
from tests.unit.repair.test_repair_preparation import FRESH_NOW, TARGET
from tests.unit.routes.test_approvals import applied_result, approval_harness
from tests.unit.routes.test_operator import credential as credential

from k8s_incident_agent.application.reconciliation import AlertReconciler
from k8s_incident_agent.domain.contracts import KubernetesTarget
from k8s_incident_agent.domain.models import (
    IncidentLifecycleStatus,
    RepairWorkflowRunSnapshot,
)
from k8s_incident_agent.kubernetes.errors import KubernetesErrorCode
from k8s_incident_agent.monitoring.contracts import CurrentAlertState, ObservationReason
from k8s_incident_agent.persistence.models import (
    CurrentAlertObservationRow,
    IncidentRow,
    RunRow,
)
from k8s_incident_agent.persistence.repositories import (
    AlertObservationRevision,
    IncidentRepository,
    RepositoryError,
)


async def _diagnose(
    repository: IncidentRepository,
    target: KubernetesTarget,
    started_at: datetime,
    revision: AlertObservationRevision,
) -> None:
    await repository.reconcile_episode_diagnosis(
        target,
        CATALOG,
        None,
        BUDGET,
        sample_started_at=started_at,
        observation_revision=revision,
    )


@pytest.mark.parametrize(
    ("microsecond", "fault"),
    [
        (0, None),
        (123_000, None),
        (123_456, None),
        (123_600, None),
        (999_999, None),
        (123_456, "clock_backwards"),
        (999_999, "future_created"),
    ],
)
async def test_reconciler_keeps_wall_clock_precision_and_uses_millisecond_promql(
    tmp_path: Path, microsecond: int, fault: str | None
) -> None:
    now = FRESH_NOW.replace(microsecond=microsecond)
    clock = [now]
    fixture = CurrentTargetFixture(now)
    original = fixture.read_namespaced_deployment

    async def read(**kwargs: Any) -> object:
        if fixture.reads == 1 and fault == "clock_backwards":
            clock[0] -= timedelta(microseconds=1)
            fixture.now = clock[0]
        return await original(**kwargs)

    fixture.read_namespaced_deployment = read
    if fault == "future_created":
        fixture.deployment.metadata.creation_timestamp = now + timedelta(microseconds=1)
    monitoring = CurrentMonitoringFixture(clock)
    service = monitoring.service()
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        await repository.create_incident_and_run(normalized_trigger(), MODEL, BUDGET)
        reconciler = AlertReconciler(
            repository=repository,
            diagnose=lambda target, started_at, revision: _diagnose(
                repository, target, started_at, revision
            ),
            adapter=fixture.adapter(),
            prometheus=service,
            now=lambda: clock[0],
        )
        try:
            await reconciler.reconcile()
        finally:
            await service.close()
        observation = await repository.get_current_alert_observation(TARGET)
        assert observation is not None and observation.facts is not None
        assert observation.facts.observed_at == clock[0]
        assert observation.summary.observed_at == now
        assert observation.summary.received_at == clock[0]
        assert observation.summary.state is (
            CurrentAlertState.CLEAR if fault is None else CurrentAlertState.UNKNOWN
        )
        assert observation.summary.complete is (fault is None)
        assert observation.summary.reason is (
            None if fault is None else ObservationReason.CLOCK_INVALID
        )
    expected_at = now.replace(microsecond=(microsecond // 1000) * 1000)
    forms = [
        parse_qs(request.content.decode())
        for request in monitoring.requests
        if not request.url.path.endswith("rules")
    ]
    assert forms and any("end" in form for form in forms)
    assert all(
        form.get("time", form.get("end", []))[0] == f"{expected_at.timestamp():.3f}"
        for form in forms
    )


@pytest.mark.parametrize(
    "fault",
    [
        None,
        "uid",
        "generation",
        "replicas",
        "missing_created",
        "future_created",
        "permission",
        "clock_backwards",
    ],
)
async def test_reconciler_persists_current_health_and_never_creates_or_updates_a_run(
    tmp_path: Path, fault: str | None
) -> None:
    async with _database(tmp_path) as database:
        clock = [FRESH_NOW]
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        created = await repository.create_incident_and_run(
            normalized_trigger(), MODEL, BUDGET
        )
        fixture = CurrentTargetFixture()
        original = fixture.read_namespaced_deployment

        async def read(**kwargs: Any) -> object:
            if fixture.reads == 1:
                if fault == "uid":
                    fixture.deployment.metadata.uid = "new-deployment-uid"
                elif fault == "generation":
                    fixture.deployment.metadata.generation += 1
                elif fault == "replicas":
                    fixture.deployment.status.available_replicas = 0
                elif fault == "clock_backwards":
                    clock[0] -= timedelta(seconds=1)
            return await original(**kwargs)

        fixture.read_namespaced_deployment = read
        if fault == "missing_created":
            fixture.deployment.metadata.creation_timestamp = None
        elif fault == "future_created":
            fixture.deployment.metadata.creation_timestamp = FRESH_NOW + timedelta(
                seconds=1
            )
        elif fault == "permission":
            fixture.error = KubernetesErrorCode.PERMISSION_DENIED
        monitoring = CurrentMonitoringFixture(clock)
        service = monitoring.service()
        reconciler = AlertReconciler(
            repository=repository,
            diagnose=lambda target, started_at, revision: _diagnose(
                repository, target, started_at, revision
            ),
            adapter=fixture.adapter(),
            prometheus=service,
            now=lambda: clock[0],
        )
        before = await repository.get_incident_detail(
            created.incident_id, run_id=None, event_limit=100
        )
        try:
            assert await reconciler.reconcile() == 1
        finally:
            await service.close()
        observed = await repository.get_current_alert_observation(TARGET)
        assert observed is not None
        assert observed.summary.state is (
            CurrentAlertState.CLEAR if fault is None else CurrentAlertState.UNKNOWN
        )
        assert observed.summary.target_healthy is (True if fault is None else None)
        if fault == "permission":
            assert observed.summary.reason is ObservationReason.PERMISSION_DENIED
        detail = await repository.get_incident_detail(
            created.incident_id, run_id=None, event_limit=100
        )
        assert before is not None and detail is not None
        assert detail.incident.updated_at == before.incident.updated_at
        assert detail.run == before.run
        async with database.session_factory() as session:
            assert await session.scalar(select(func.count()).select_from(RunRow)) == 1
            assert (
                await session.scalar(
                    select(func.count()).select_from(CurrentAlertObservationRow)
                )
                == 1
            )


async def test_reconciliation_recovers_durable_work_after_missing_wake_and_dependency_recovery(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: FRESH_NOW)
        await repository.create_incident_and_run(normalized_trigger(), MODEL, BUDGET)
        fixture = CurrentTargetFixture()
        fixture.error = KubernetesErrorCode.PERMISSION_DENIED
        service = CurrentMonitoringFixture().service()
        try:
            failed = AlertReconciler(
                repository=repository,
                diagnose=lambda target, started_at, revision: _diagnose(
                    repository, target, started_at, revision
                ),
                adapter=fixture.adapter(),
                prometheus=service,
                now=lambda: FRESH_NOW,
            )
            await failed.reconcile()
            fixture.error = None
            restarted = AlertReconciler(
                repository=IncidentRepository(database.session_factory),
                diagnose=lambda target, started_at, revision: _diagnose(
                    repository, target, started_at, revision
                ),
                adapter=fixture.adapter(),
                prometheus=service,
                now=lambda: FRESH_NOW,
            )
            await restarted.start()
            try:
                async with asyncio.timeout(2):
                    while True:
                        observation = await repository.get_current_alert_observation(
                            TARGET
                        )
                        if observation and observation.summary.complete:
                            break
                        await asyncio.sleep(0.001)
            finally:
                closing = asyncio.create_task(restarted.close())
                done, _ = await asyncio.wait({closing}, timeout=3)
                if not done:
                    closing.cancel()
                    await asyncio.gather(closing, return_exceptions=True)
                    pytest.fail("reconciler shutdown did not finish")
                await closing
            assert observation.summary.state is CurrentAlertState.CLEAR
        finally:
            await service.close()


async def test_concurrent_pass_and_repeated_wake_cannot_duplicate_reads(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: FRESH_NOW)
        await repository.create_incident_and_run(normalized_trigger(), MODEL, BUDGET)
        fixture = CurrentTargetFixture()
        original = fixture.read_namespaced_deployment
        entered = asyncio.Event()
        release = asyncio.Event()

        async def blocked(**kwargs: Any) -> object:
            entered.set()
            await release.wait()
            return await original(**kwargs)

        fixture.read_namespaced_deployment = blocked
        monitoring = CurrentMonitoringFixture()
        service = monitoring.service()
        reconciler = AlertReconciler(
            repository=repository,
            diagnose=lambda target, started_at, revision: _diagnose(
                repository, target, started_at, revision
            ),
            adapter=fixture.adapter(),
            prometheus=service,
            now=lambda: FRESH_NOW,
        )
        await reconciler.start()
        try:
            await asyncio.wait_for(entered.wait(), 2)
            assert await reconciler.reconcile() == 0
            for _ in range(100):
                reconciler.request_reconciliation()
            release.set()
            async with asyncio.timeout(2):
                while fixture.reads < 2:
                    await asyncio.sleep(0.001)
            await asyncio.sleep(0.02)
            assert fixture.reads == 2
            assert (
                len(
                    [
                        request
                        for request in monitoring.requests
                        if request.url.path.endswith("rules")
                    ]
                )
                == 2
            )
        finally:
            await reconciler.close()
            await service.close()


async def test_exhausted_pass_budget_persists_unknown_and_leaves_unattempted_target_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: FRESH_NOW)
        await repository.create_incident_and_run(normalized_trigger(), MODEL, BUDGET)
        await repository.create_incident_and_run(
            normalized_trigger("z-target"), MODEL, BUDGET
        )
        fixture = CurrentTargetFixture()
        entered = asyncio.Event()

        async def blocked(**_kwargs: Any) -> object:
            entered.set()
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

        fixture.read_namespaced_deployment = blocked
        original_timeout = asyncio.timeout

        def bounded_timeout(delay: float | None) -> asyncio.Timeout:
            return original_timeout(0.03 if delay == 20 else delay)

        monkeypatch.setattr(asyncio, "timeout", bounded_timeout)
        service = CurrentMonitoringFixture().service()
        try:
            reconciler = AlertReconciler(
                repository=repository,
                diagnose=lambda target, started_at, revision: _diagnose(
                    repository, target, started_at, revision
                ),
                adapter=fixture.adapter(),
                prometheus=service,
                now=lambda: FRESH_NOW,
            )
            assert await reconciler.reconcile() == 1
            assert entered.is_set()
            observation = await repository.get_current_alert_observation(TARGET)
            assert (
                observation is not None
                and observation.summary.reason is ObservationReason.BUDGET_EXCEEDED
            )
            assert not observation.summary.complete
            assert (await repository.reconciliation_targets())[0].name == "z-target"
        finally:
            await service.close()


@pytest.mark.parametrize(
    "interruption", [None, "callback", "cancel", "restart", "rules"]
)
async def test_reconciler_preserves_only_uninterrupted_healthy_sampling(
    tmp_path: Path, interruption: str | None
) -> None:
    from tests.unit.persistence.test_incident_lifecycle import open_episode

    clock = [FRESH_NOW]
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        incident_id = await open_episode(repository)
        fixture = CurrentTargetFixture(clock[0])
        service = CurrentMonitoringFixture(clock).service()
        fail_callback = False

        async def diagnose(
            target: KubernetesTarget,
            started_at: datetime,
            revision: AlertObservationRevision,
        ) -> None:
            if fail_callback:
                raise RepositoryError
            await _diagnose(repository, target, started_at, revision)

        def reconciler() -> AlertReconciler:
            return AlertReconciler(
                repository=repository,
                diagnose=diagnose,
                adapter=fixture.adapter(),
                prometheus=service,
                now=lambda: clock[0],
            )

        current = reconciler()

        async def tick() -> None:
            clock[0] += timedelta(seconds=30)
            fixture.now = clock[0]
            await current.reconcile()

        try:
            for _ in range(5):
                await tick()
            if interruption in ("cancel", "rules"):
                entered = asyncio.Event()

                async def blocked(**_kwargs: Any) -> object:
                    entered.set()
                    await asyncio.Event().wait()
                    raise AssertionError("unreachable")

                original = fixture.read_namespaced_deployment
                original_rules = service.read_reconciliation_rules
                if interruption == "cancel":
                    fixture.read_namespaced_deployment = blocked
                else:

                    async def blocked_rules() -> dict[str, Any]:
                        await blocked()
                        return {}

                    service.read_reconciliation_rules = blocked_rules
                task = asyncio.create_task(tick())
                await asyncio.wait_for(entered.wait(), 2)
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
                fixture.read_namespaced_deployment = original
                service.read_reconciliation_rules = original_rules
            elif interruption == "callback":
                fail_callback = True
                with pytest.raises(RepositoryError):
                    await tick()
                fail_callback = False
            elif interruption == "restart":
                current = reconciler()
            for _ in range(6):
                await tick()
            detail = await repository.get_incident_detail(
                incident_id, run_id=None, event_limit=100
            )
            assert detail is not None
            assert detail.incident.lifecycle_status == (
                "CLOSED" if interruption is None else "OPEN"
            )
            if interruption is not None:
                for _ in range(5):
                    await tick()
                detail = await repository.get_incident_detail(
                    incident_id, run_id=None, event_limit=100
                )
                assert (
                    detail is not None and detail.incident.lifecycle_status == "CLOSED"
                )
        finally:
            await service.close()


@pytest.mark.parametrize("phase", ["before_save", "after_save"])
async def test_reconciler_keeps_verification_interruption_cursor_from_sample_start(
    tmp_path: Path,
    credential: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
    phase: str,
) -> None:
    from tests.unit.persistence.test_incident_lifecycle import open_episode

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
            if phase == "before_save"
            else harness.incident_id
        )
        fixture = CurrentTargetFixture(harness.now())
        adapter = fixture.adapter()
        read_target = adapter.read_current_target
        interrupt = False

        async def fail_verification() -> None:
            nonlocal interrupt
            interrupt = False
            kube = RecoveryFixture()
            kube.deployment.metadata.generation = 5
            await observe(harness, harness.run_id, kube)
            detail = await harness.repository.get_incident_detail(
                harness.incident_id, run_id=harness.run_id, event_limit=100
            )
            assert detail is not None and detail.repair is not None
            assert detail.repair.verification is not None
            assert detail.repair.verification.outcome == "target_drift"

        async def read(target: KubernetesTarget):
            facts = await read_target(target)
            if interrupt and phase == "before_save":
                await fail_verification()
            return facts

        monkeypatch.setattr(adapter, "read_current_target", read)

        async def diagnose(
            target: KubernetesTarget,
            started_at: datetime,
            revision: AlertObservationRevision,
        ) -> None:
            if interrupt and phase == "after_save":
                await fail_verification()
            await _diagnose(harness.repository, target, started_at, revision)

        service = CurrentMonitoringFixture(harness.clock).service()
        reconciler = AlertReconciler(
            repository=harness.repository,
            adapter=adapter,
            prometheus=service,
            now=harness.now,
            diagnose=diagnose,
        )

        async def tick() -> None:
            harness.clock[0] += timedelta(seconds=30)
            fixture.now = harness.now()
            await reconciler.reconcile()

        try:
            for _ in range(10):
                await tick()
            interrupt = True
            await tick()
            detail = await harness.repository.get_incident_detail(
                incident_id, run_id=None, event_limit=100
            )
            assert detail is not None
            assert detail.incident.lifecycle_status is IncidentLifecycleStatus.OPEN
            for _ in range(10):
                await tick()
            detail = await harness.repository.get_incident_detail(
                incident_id, run_id=None, event_limit=100
            )
            assert detail is not None
            assert detail.incident.lifecycle_status is IncidentLifecycleStatus.OPEN
            await tick()
            detail = await harness.repository.get_incident_detail(
                incident_id, run_id=None, event_limit=100
            )
            assert detail is not None
            assert detail.incident.lifecycle_status is IncidentLifecycleStatus.CLOSED
        finally:
            await service.close()


async def test_target_timeout_does_not_discard_another_targets_stable_window(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from tests.unit.persistence.test_episode_diagnosis import (
        CRASH,
        observation,
        occurrence,
    )
    from tests.unit.persistence.test_incident_lifecycle import open_episode

    clock = [FRESH_NOW]
    other = TARGET.model_copy(update={"name": "z-target"})
    fixture = CurrentTargetFixture(clock[0])
    other_fixture = CurrentTargetFixture(clock[0])
    other_fixture.deployment.metadata.name = other.name
    other_fixture.deployment.metadata.uid = "other-deployment-uid"
    for replica in other_fixture.replicas:
        for owner in replica.metadata.owner_references:
            owner.name = other.name
            owner.uid = other_fixture.deployment.metadata.uid
    adapter = fixture.adapter()
    other_adapter = other_fixture.adapter()
    original_read = adapter.read_current_target
    fail_other = False

    async def read(target: KubernetesTarget):
        if target == other:
            if fail_other:
                await asyncio.Event().wait()
            return await other_adapter.read_current_target(target)
        return await original_read(target)

    monkeypatch.setattr(adapter, "read_current_target", read)
    original_timeout = asyncio.timeout

    def bounded_timeout(delay: float | None) -> asyncio.Timeout:
        return original_timeout(0.2 if delay == 20 else delay)

    monkeypatch.setattr(asyncio, "timeout", bounded_timeout)
    service = CurrentMonitoringFixture(clock).service()
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory, now=lambda: clock[0])
        first_id = await open_episode(repository)
        signal = occurrence(CRASH, 2)
        await repository.apply_alert_occurrences(
            (
                replace(
                    signal, trigger=signal.trigger.model_copy(update={"target": other})
                ),
            )
        )
        other_observation = (await observation()).model_copy(
            update={
                "target": other,
                "facts": await other_adapter.read_current_target(other),
            }
        )
        revision = await repository.save_current_alert_observation(other_observation)
        await repository.reconcile_episode_diagnosis(
            other,
            CATALOG,
            None,
            BUDGET,
            sample_started_at=clock[0],
            observation_revision=revision,
        )
        async with database.session_factory() as session:
            other_id = (
                await session.scalars(
                    select(IncidentRow.id).where(
                        IncidentRow.resource_name == other.name
                    )
                )
            ).one()
        reconciler = AlertReconciler(
            repository=repository,
            adapter=adapter,
            prometheus=service,
            now=lambda: clock[0],
            diagnose=lambda target, started_at, revision: _diagnose(
                repository, target, started_at, revision
            ),
        )

        async def tick() -> None:
            clock[0] += timedelta(seconds=30)
            fixture.now = other_fixture.now = clock[0]
            assert await reconciler.reconcile() == 2

        try:
            await tick()
            await tick()
            fail_other = True
            for _ in range(9):
                await tick()
            first = await repository.get_incident_detail(
                first_id, run_id=None, event_limit=100
            )
            assert first is not None and first.incident.lifecycle_status == "CLOSED"
            async with database.session_factory() as session:
                second = await session.get(IncidentRow, other_id)
                assert second is not None and second.lifecycle_status == "OPEN"
            fail_other = False
            for _ in range(10):
                await tick()
            async with database.session_factory() as session:
                second = await session.get(IncidentRow, other_id)
                assert second is not None and second.lifecycle_status == "OPEN"
            await tick()
            async with database.session_factory() as session:
                second = await session.get(IncidentRow, other_id)
                assert second is not None and second.lifecycle_status == "CLOSED"
        finally:
            await service.close()
