from __future__ import annotations

import asyncio
from datetime import timedelta
from pathlib import Path
from typing import Any, cast
from uuid import UUID

import pytest
from tests.recovery_fixtures import MonitoringFixture, RecoveryFixture
from tests.unit.persistence.test_repair_persistence import BUDGET, MODEL
from tests.unit.repair.test_repair_preparation import (
    credential as diagnostic_credential,
)
from tests.unit.routes.test_approvals import applied_result, approval_harness
from tests.unit.routes.test_operator import credential as credential
from tests.unit.workflow.test_repair_preparation import dependencies

from k8s_incident_agent.diagnosis.policy import DiagnosticPolicyResolver
from k8s_incident_agent.domain.models import RepairWorkflowRunSnapshot, RunStatus
from k8s_incident_agent.repair.verification import verify_recovery
from k8s_incident_agent.workflow import graph as graph_module
from k8s_incident_agent.workflow import supervisor as supervisor_module
from k8s_incident_agent.workflow.supervisor import RunSupervisor


@pytest.mark.parametrize("checkpoint", ["parked", "missing", "ended"])
async def test_supervisor_resumes_applied_progress_without_model_patch_or_new_deadline(
    tmp_path: Path,
    credential: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
    checkpoint: str,
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()
        kube, metrics = RecoveryFixture(), MonitoringFixture(harness.clock)
        service = metrics.service()
        paused = asyncio.Event()
        block = True
        started = harness.now()

        async def tick(seconds: float) -> None:
            harness.clock[0] += timedelta(seconds=seconds)
            kube.now = harness.now()
            await harness.repository.apply_alert_occurrences(
                (), None, BUDGET, watchdog_received_at=harness.now()
            )
            if block and harness.now() >= started + timedelta(seconds=20):
                paused.set()
                await asyncio.Event().wait()

        async def verifier(run_id: UUID, **kwargs: Any) -> None:
            await verify_recovery(run_id, **kwargs, sleep=tick)

        def unavailable_model() -> None:
            raise AssertionError("Recovery must not consult a diagnostic model")

        def worker() -> RunSupervisor:
            return RunSupervisor(
                repository=harness.repository,
                checkpointer=harness.saver,
                model=unavailable_model,
                model_snapshot=MODEL,
                credential=diagnostic_credential(),
                adapter=kube.adapter(),
                prometheus=service,
                policies=cast(DiagnosticPolicyResolver, object()),
                now=harness.now,
            )

        monkeypatch.setattr(graph_module, "verify_recovery", verifier)
        monkeypatch.setattr(supervisor_module, "_SHUTDOWN_GRACE_SECONDS", 0)
        if checkpoint == "ended":
            before = worker()
            await before.start()
            # Let the real approval branch finish while execution is still PENDING.
            async with asyncio.timeout(5):
                while True:
                    run = await harness.repository.get_workflow_run_snapshot(
                        harness.run_id
                    )
                    graph = graph_module.build_incident_graph(
                        dependencies(
                            harness.repository, harness.saver, kube, harness.now
                        ),
                        run,
                    )
                    if not (
                        await graph.aget_state(  # pyright: ignore[reportUnknownMemberType]
                            {"configurable": {"thread_id": str(harness.run_id)}}
                        )
                    ).next:
                        break
                    await asyncio.sleep(0.01)
            await before.close()
        result = await applied_result(harness)
        initial = cast(
            RepairWorkflowRunSnapshot,
            await harness.repository.get_workflow_run_snapshot(harness.run_id),
        )
        assert initial.execution is not None
        await harness.repository.report_execution(
            initial.execution.id, result, now=harness.now
        )
        if checkpoint == "missing":
            await harness.saver.adelete_thread(str(harness.run_id))
        await tick(0)
        first = worker()
        try:
            await first.start()
            async with asyncio.timeout(8):
                await paused.wait()
        finally:
            await first.close()
        interrupted = cast(
            RepairWorkflowRunSnapshot,
            await harness.repository.get_workflow_run_snapshot(harness.run_id),
        )
        assert (
            interrupted.verification is not None
            and interrupted.verification.sample_count == 4
        )
        assert interrupted.run_status is RunStatus.RUNNING
        block = False
        # Process downtime breaks the sampled-health window, not the original deadline.
        await tick(10)
        restarted = worker()
        try:
            await restarted.start()
            async with asyncio.timeout(8):
                while True:
                    after = cast(
                        RepairWorkflowRunSnapshot,
                        await harness.repository.get_workflow_run_snapshot(
                            harness.run_id
                        ),
                    )
                    if after.run_status is not RunStatus.RUNNING:
                        break
                    await asyncio.sleep(0.01)
        finally:
            await restarted.close()
            await service.close()
        assert (
            after.run_status is RunStatus.COMPLETED and after.verification is not None
        )
        assert after.verification.outcome == "recovered"
        assert (
            after.verification.deadline_at
            == interrupted.verification.deadline_at
            == started + timedelta(minutes=10)
        )
        assert after.verification.completed_at == started + timedelta(seconds=90)
        assert after.proposal_id == initial.proposal_id
        assert (
            after.execution is not None and after.execution.id == initial.execution.id
        )
        assert await harness.repository.claim_execution(now=harness.now) is None
