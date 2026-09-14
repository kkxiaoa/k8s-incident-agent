from pathlib import Path
from uuid import UUID

from tests.unit.repair.test_repair_preparation import KubernetesFixture
from tests.unit.routes.test_approvals import applied_result, approval_harness
from tests.unit.routes.test_operator import credential as credential
from tests.unit.workflow.test_repair_preparation import dependencies, supervisor

from k8s_incident_agent.domain.models import RepairWorkflowRunSnapshot, RunStatus
from k8s_incident_agent.workflow.graph import build_incident_graph


async def test_committed_approval_recovers_a_parked_checkpoint_without_notification_or_model(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        worker = supervisor(
            harness.repository, harness.saver, KubernetesFixture(), harness.now
        )
        await worker.start()
        await worker.close()
        approval = await harness.approve()
        worker = supervisor(
            harness.repository, harness.saver, KubernetesFixture(), harness.now
        )
        await worker.start()
        await worker.close()
        state = await harness.saver.aget_tuple(
            {"configurable": {"thread_id": str(harness.run_id)}}
        )
        assert state is not None
        run = await harness.repository.get_workflow_run_snapshot(harness.run_id)
        assert isinstance(run, RepairWorkflowRunSnapshot) and run.approval is not None
        assert (
            run.run_status is RunStatus.RUNNING
            and str(run.approval.id) == approval["id"]
        )
        graph = build_incident_graph(
            dependencies(
                harness.repository, harness.saver, KubernetesFixture(), harness.now
            ),
            run,
        )
        assert not (
            await graph.aget_state({"configurable": {"thread_id": str(run.id)}})
        ).next  # pyright: ignore[reportUnknownMemberType]
        result = await applied_result(harness)
        assert run.execution is not None
        await harness.repository.report_execution(
            run.execution.id, result, now=harness.now
        )
        worker = supervisor(
            harness.repository, harness.saver, KubernetesFixture(), harness.now
        )
        await worker.start()
        await worker.close()
        after = await harness.repository.get_workflow_run_snapshot(harness.run_id)
        assert (
            isinstance(after, RepairWorkflowRunSnapshot) and after.execution is not None
        )
        assert (
            after.execution.id == run.execution.id
            and after.execution.status == "APPLIED"
        )
        assert after.proposal_id == UUID(harness.body["proposalId"])
        assert await harness.repository.claim_execution(now=harness.now) is None


async def test_business_approval_survives_a_missing_checkpoint(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()
        await harness.saver.adelete_thread(str(harness.run_id))
        worker = supervisor(
            harness.repository, harness.saver, KubernetesFixture(), harness.now
        )
        await worker.start()
        await worker.close()
        run = await harness.repository.get_workflow_run_snapshot(harness.run_id)
        assert isinstance(run, RepairWorkflowRunSnapshot) and run.execution is not None
        assert run.run_status is RunStatus.RUNNING and run.execution.status == "PENDING"
        assert run.proposal_id == UUID(harness.body["proposalId"])
