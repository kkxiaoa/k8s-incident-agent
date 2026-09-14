from __future__ import annotations

import asyncio
from datetime import timedelta
from pathlib import Path
from typing import Any, cast

import pytest
from sqlalchemy import event
from sqlalchemy.exc import OperationalError
from tests.recovery_fixtures import MonitoringFixture, RecoveryFixture
from tests.unit.persistence.test_repair_persistence import BUDGET
from tests.unit.repair.test_repair_preparation import (
    credential as diagnostic_credential,
)
from tests.unit.routes.test_approvals import applied_result, approval_harness
from tests.unit.routes.test_operator import credential as credential

from k8s_incident_agent.domain.models import RepairWorkflowRunSnapshot, RunStatus
from k8s_incident_agent.persistence import repositories as repository_module
from k8s_incident_agent.persistence.repositories import (
    IncidentDetailRecord,
    PersistenceOperationError,
    RunListPage,
)
from k8s_incident_agent.repair.verification import verify_recovery
from k8s_incident_agent.repair.verification_contracts import VerificationObservation
from k8s_incident_agent.repair.verification_policy import (
    advance_verification,
    workload_ready,
)


@pytest.mark.parametrize("reader", ["workflow", "detail", "history"])
async def test_verification_audit_is_atomic_idempotent_and_readers_keep_one_snapshot(
    tmp_path: Path,
    credential: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
    reader: str,
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
        started = harness.now()
        kube, metrics = RecoveryFixture(), MonitoringFixture(harness.clock)

        async def tick(seconds: float) -> None:
            harness.clock[0] += timedelta(seconds=seconds)
            kube.now = harness.now()
            await harness.repository.apply_alert_occurrences(
                (), None, BUDGET, watchdog_received_at=harness.now()
            )
            if harness.now() == started + timedelta(seconds=60):
                raise asyncio.CancelledError

        await tick(0)
        service = metrics.service()
        try:
            with pytest.raises(asyncio.CancelledError):
                await verify_recovery(
                    harness.run_id,
                    repository=harness.repository,
                    adapter=kube.adapter(),
                    prometheus=service,
                    credential=diagnostic_credential(),
                    now=harness.now,
                    sleep=tick,
                )
            context = await harness.repository.get_verification_context(harness.run_id)
            assert context is not None and context.record.sample_count == 12
            workload = await kube.adapter().read_recovery_workload(
                context.proposal.target, context.proposal.container_name
            )
            monitoring = await service.observe_recovery(
                target=context.proposal.target,
                container_name=context.proposal.container_name,
                pod_uids=tuple(pod.uid for pod in workload.pods),
                applied_at=started,
            )
        finally:
            await service.close()
        observation = VerificationObservation(
            observed_at=harness.now(),
            workload=workload,
            monitoring=monitoring,
            watchdog_received_at=harness.now(),
            occurrence_resolved=None,
        )
        updated = advance_verification(
            context.record,
            observation,
            context.previous,
            context.proposal,
            context.receipt,
            harness.now(),
            workload_is_ready=workload_ready(
                workload, context.proposal, context.receipt
            ),
        )
        assert updated.outcome == "recovered"

        def fail_audit(
            _connection: object,
            _cursor: object,
            statement: str,
            parameters: object,
            _context: object,
            _many: bool,
        ) -> None:
            if statement.startswith(
                "INSERT INTO run_events"
            ) and "repair.verification_updated" in str(parameters):
                raise OperationalError(
                    statement,
                    None,
                    RuntimeError("test verification audit interruption"),
                )

        event.listen(
            harness.database.engine.sync_engine, "before_cursor_execute", fail_audit
        )
        try:
            with pytest.raises(PersistenceOperationError):
                await harness.repository.persist_verification(
                    harness.run_id, context.record, updated, observation
                )
        finally:
            event.remove(
                harness.database.engine.sync_engine, "before_cursor_execute", fail_audit
            )
        before = await harness.repository.get_incident_detail(
            harness.incident_id, run_id=harness.run_id, event_limit=100
        )
        assert before is not None and before.repair is not None
        assert (
            before.run_creation_blocked and before.repair.verification == context.record
        )
        reached, release = asyncio.Event(), asyncio.Event()
        original = repository_module._load_repair_ledger  # pyright: ignore[reportPrivateUsage]
        hold_once = True

        async def paused_ledger(*args: Any, **kwargs: Any) -> Any:
            nonlocal hold_once
            if hold_once:
                hold_once = False
                reached.set()
                await release.wait()
            return await original(*args, **kwargs)

        monkeypatch.setattr(repository_module, "_load_repair_ledger", paused_ledger)
        read_task = asyncio.create_task(
            harness.repository.get_workflow_run_snapshot(harness.run_id)
            if reader == "workflow"
            else harness.repository.list_run_records(
                harness.incident_id, limit=20, before_attempt=None
            )
            if reader == "history"
            else harness.repository.get_incident_detail(
                harness.incident_id, run_id=harness.run_id, event_limit=100
            )
        )
        try:
            async with asyncio.timeout(5):
                await reached.wait()
                await harness.repository.persist_verification(
                    harness.run_id, context.record, updated, observation
                )
                release.set()
                snapshot = await read_task
        finally:
            release.set()
            await asyncio.gather(read_task, return_exceptions=True)
        assert snapshot is not None
        assert (
            snapshot.run_status
            if isinstance(snapshot, RepairWorkflowRunSnapshot)
            else snapshot.items[0].status
            if isinstance(snapshot, RunListPage)
            else cast(IncidentDetailRecord, snapshot).run.status
        ) is RunStatus.RUNNING
        await harness.repository.persist_verification(
            harness.run_id, context.record, updated, observation
        )
        after = await harness.repository.get_incident_detail(
            harness.incident_id, run_id=harness.run_id, event_limit=100
        )
        assert after is not None and after.repair is not None
        assert (
            after.run.status is RunStatus.COMPLETED and not after.run_creation_blocked
        )
        assert after.repair.verification == updated
        assert len(after.evidence) == len(before.evidence) + 1
