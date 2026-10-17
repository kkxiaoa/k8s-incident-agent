import asyncio
from datetime import timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import pytest
from sqlalchemy import func, select
from tests.factories import normalized_trigger
from tests.unit.monitoring.test_reconciliation import (
    CurrentMonitoringFixture,
    CurrentTargetFixture,
)
from tests.unit.persistence.test_repair_persistence import (
    BUDGET,
    MODEL,
    _database,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.repair.test_repair_preparation import FRESH_NOW, TARGET

from k8s_incident_agent.application.reconciliation import AlertReconciler
from k8s_incident_agent.kubernetes.errors import KubernetesErrorCode
from k8s_incident_agent.monitoring.contracts import CurrentAlertState, ObservationReason
from k8s_incident_agent.persistence.models import CurrentAlertObservationRow, RunRow
from k8s_incident_agent.persistence.repositories import IncidentRepository


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
                adapter=fixture.adapter(),
                prometheus=service,
                now=lambda: FRESH_NOW,
            )
            await failed.reconcile()
            fixture.error = None
            restarted = AlertReconciler(
                repository=IncidentRepository(database.session_factory),
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
                await restarted.close()
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
