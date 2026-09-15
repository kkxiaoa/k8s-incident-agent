from __future__ import annotations

import copy
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    V1DeploymentCondition,
)
from sqlalchemy import func, select
from tests.execution.test_worker import (
    KubernetesTransport,
    RawResponse,
    adapter,
    deployment,
)
from tests.recovery_fixtures import MonitoringFixture, RecoveryFixture
from tests.unit.persistence.test_repair_persistence import BUDGET
from tests.unit.repair.test_repair_preparation import CURRENT, PREVIOUS
from tests.unit.repair.test_repair_preparation import (
    credential as diagnostic_credential,
)
from tests.unit.routes.test_approvals import (
    ApprovalHarness,
    applied_result,
    approval_harness,
)
from tests.unit.routes.test_operator import credential as credential
from tests.unit.workflow.test_repair_preparation import (
    dependencies,
    settled,
    supervisor,
)

from k8s_incident_agent.domain.models import RepairWorkflowRunSnapshot, RunStatus
from k8s_incident_agent.execution.contracts import ExecutionResult
from k8s_incident_agent.execution.worker import validate_execution_command
from k8s_incident_agent.persistence.models import ExecutionRow, RunRow
from k8s_incident_agent.persistence.repositories import RecoveryConsistencyError
from k8s_incident_agent.repair.compiler import compile_repair_proposal
from k8s_incident_agent.repair.contracts import (
    PatchValidationChange,
    PatchValidationRequest,
    PatchValidationResponse,
    RepairProposal,
)
from k8s_incident_agent.repair.preparation import prepare_repair
from k8s_incident_agent.repair.validator import PatchValidationService
from k8s_incident_agent.repair.verification import verify_recovery
from k8s_incident_agent.workflow.graph import build_incident_graph


async def observe(
    harness: ApprovalHarness, run_id: UUID, kube: RecoveryFixture
) -> None:
    async def tick(seconds: float) -> None:
        harness.clock[0] += timedelta(seconds=seconds)
        kube.now = harness.now()
        await harness.repository.apply_alert_occurrences(
            (), None, BUDGET, watchdog_received_at=harness.now()
        )

    await tick(0)
    metrics = MonitoringFixture(harness.clock).service()
    try:
        await verify_recovery(
            run_id,
            repository=harness.repository,
            adapter=kube.adapter(),
            prometheus=metrics,
            credential=diagnostic_credential(),
            now=harness.now,
            sleep=tick,
        )
    finally:
        await metrics.close()


async def finish_source(harness: ApprovalHarness, *, recovered: bool = False) -> UUID:
    await harness.approve()
    result = await applied_result(harness)
    run = cast(
        RepairWorkflowRunSnapshot,
        await harness.repository.get_workflow_run_snapshot(harness.run_id),
    )
    assert run.execution is not None
    await harness.repository.report_execution(run.execution.id, result, now=harness.now)
    kube = RecoveryFixture()
    if not recovered:
        kube.deployment.status.conditions = [
            V1DeploymentCondition(
                type="Progressing",
                status="False",
                reason="ProgressDeadlineExceeded",
            )
        ]
    await observe(harness, harness.run_id, kube)
    return run.execution.id


class RollbackValidator:
    def __init__(self, harness: ApprovalHarness, kube: RecoveryFixture) -> None:
        self.kube = kube
        self.patches: list[dict[str, Any]] = []
        self.service = PatchValidationService(
            apps_api=self,
            authorization_api=object(),
            cluster_id="k8s-incident-agent",
            namespace="k8s-incident-scenarios",
            timeout_seconds=10,
            now=harness.now,
        )

    async def read_namespaced_deployment(self, **_: object) -> object:
        return self.kube.deployment

    async def patch_namespaced_deployment(self, **kwargs: Any) -> object:
        self.patches.append(kwargs)
        after = copy.deepcopy(self.kube.deployment)
        after.spec.template.spec.containers[0].image = kwargs["body"][-1]["value"]
        return after

    async def validate(
        self, proposal: RepairProposal, *, deadline: datetime
    ) -> PatchValidationResponse:
        return await self.service.validate(
            PatchValidationRequest(
                proposal_id=proposal.id,
                proposal_digest=proposal.digest,
                change=PatchValidationChange.from_proposal(proposal),
                deadline=deadline,
            )
        )


async def prepare_rollback(
    harness: ApprovalHarness,
    source_execution_id: UUID,
    kube: RecoveryFixture,
) -> tuple[UUID, RollbackValidator]:
    response = await harness.client.post(
        f"/api/v1/incidents/{harness.incident_id}/repair-runs",
        json={
            "sourceRunId": str(harness.run_id),
            "sourceExecutionId": str(source_execution_id),
        },
        headers=harness.headers,
    )
    assert response.status_code == 202, response.text
    run_id = UUID(response.json()["runId"])
    run = cast(
        RepairWorkflowRunSnapshot,
        await harness.repository.get_workflow_run_snapshot(run_id),
    )
    validator = RollbackValidator(harness, kube)
    kube.now = harness.now()
    graph = build_incident_graph(
        replace(
            dependencies(harness.repository, harness.saver, kube, harness.now),
            patch_validator=validator,
        ),
        run,
    )
    await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
        {"run_id": str(run_id)},
        {"configurable": {"thread_id": str(run_id)}},
        durability="sync",
    )
    return run_id, validator


@pytest.mark.parametrize("recovered", [False, True])
async def test_terminal_execution_gets_fresh_inverse_approval_and_separate_recovery(
    tmp_path: Path,
    credential: tuple[str, str],
    recovered: bool,
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        source_execution = await finish_source(harness, recovered=recovered)
        source = await harness.repository.get_incident_detail(
            harness.incident_id, run_id=harness.run_id, event_limit=100
        )
        assert source and source.repair and source.repair.approval
        kube = RecoveryFixture()
        kube.deployment.metadata.resource_version = "new-status-rv"
        kube.replicas = []  # A trustworthy execution does not depend on retained ReplicaSets.
        run_id, validator = await prepare_rollback(harness, source_execution, kube)
        detail = await harness.client.get(
            f"/api/v1/incidents/{harness.incident_id}?runId={run_id}"
        )
        assert detail.status_code == 200, detail.text
        body = detail.json()
        assert body["selectedRun"]["operation"] == "rollback"
        assert body["selectedRun"]["status"] == "WAITING_APPROVAL"
        assert body["diagnosis"] is None
        assert body["repair"]["sourceExecutionId"] == str(source_execution)
        assert len(body["repair"]["evidenceIds"]) == 1
        assert {item["evidenceKind"] for item in body["evidence"]} == {"workload"}
        assert body["approval"] is None
        assert body["repair"]["digest"] != source.repair.proposal.digest
        assert len(validator.patches) == 1 and validator.patches[0]["dry_run"] == "All"
        assert body["repair"]["patch"] == [
            {
                "op": "test",
                "path": "/metadata/uid",
                "value": source.repair.proposal.target_uid,
            },
            {
                "op": "test",
                "path": "/metadata/resourceVersion",
                "value": "new-status-rv",
            },
            {
                "op": "test",
                "path": "/spec/template/spec/containers/0/name",
                "value": "workload",
            },
            {
                "op": "test",
                "path": "/spec/template/spec/containers/0/image",
                "value": PREVIOUS,
            },
            {
                "op": "replace",
                "path": "/spec/template/spec/containers/0/image",
                "value": CURRENT,
            },
        ]
        assert await harness.repository.claim_execution(now=harness.now) is None
        approved = await harness.client.post(
            harness.path,
            headers=harness.headers,
            json={
                "runId": str(run_id),
                "proposalId": body["repair"]["id"],
                "proposalDigest": body["repair"]["digest"],
                "decision": "approve",
            },
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["id"] != str(source.repair.approval.id)
        command = await harness.repository.claim_execution(now=harness.now)
        assert command is not None and command.execution_id != source_execution
        proposal = validate_execution_command(
            command, cluster_id="k8s-incident-agent", now=harness.now()
        )
        before, after = deployment(proposal), deployment(proposal, patched=True)
        before["metadata"]["generation"], after["metadata"]["generation"] = 4, 5
        transport = KubernetesTransport(RawResponse(before), RawResponse(after))
        async with adapter(transport) as client:
            result = await client.apply(
                proposal, start_before=command.start_before, now=harness.now
            )
        assert result.outcome == "APPLIED"
        assert [item["method"] for item in transport.calls] == ["GET", "PATCH"]
        await harness.repository.report_execution(
            command.execution_id, result, now=harness.now
        )
        restored = RecoveryFixture()
        restored.deployment.metadata.generation = (
            restored.deployment.status.observed_generation
        ) = 5
        restored.deployment.spec.template.spec.containers[0].image = CURRENT
        restored.replicas[1].spec.template.spec.containers[0].image = CURRENT
        restored.pod.spec.containers[0].image = restored.pod.status.container_statuses[
            0
        ].image = CURRENT
        if not recovered:
            restored.deployment.status.conditions = [
                V1DeploymentCondition(
                    type="Progressing",
                    status="False",
                    reason="ProgressDeadlineExceeded",
                )
            ]
        if recovered:
            await observe(harness, run_id, restored)
        else:
            restored.now = harness.now()
            worker = supervisor(
                harness.repository, harness.saver, restored, harness.now
            )
            try:
                await worker.start()
                resumed = await settled(harness.repository, run_id)
                assert resumed.run_status is RunStatus.COMPLETED
            finally:
                await worker.close()
        response = await harness.client.get(
            f"/api/v1/incidents/{harness.incident_id}?runId={run_id}"
        )
        assert response.status_code == 200, response.text
        result_body = response.json()
        assert result_body["incident"]["status"] == "ROLLED_BACK"
        assert result_body["selectedRun"]["status"] == "COMPLETED"
        assert result_body["verification"]["outcome"] == (
            "recovered" if recovered else "workload_failed"
        )
        assert (
            await harness.client.post(
                f"/api/v1/incidents/{harness.incident_id}/repair-runs",
                headers=harness.headers,
                json={
                    "sourceRunId": str(run_id),
                    "sourceExecutionId": str(command.execution_id),
                },
            )
        ).status_code == 409
        retained = await harness.repository.get_incident_detail(
            harness.incident_id, run_id=harness.run_id, event_limit=100
        )
        assert retained and retained.repair == source.repair


@pytest.mark.parametrize(
    "drift", ["uid", "image", "container", "generation", "missing_generation"]
)
async def test_rollback_does_not_overwrite_later_resource_intent(
    tmp_path: Path,
    credential: tuple[str, str],
    drift: str,
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        source = await finish_source(harness)
        kube = RecoveryFixture()
        if drift == "uid":
            kube.deployment.metadata.uid = "replacement-object"
        elif drift == "image":
            kube.deployment.spec.template.spec.containers[
                0
            ].image = "operator:new-image"
        elif drift == "container":
            kube.deployment.spec.template.spec.containers[0].name = "other-container"
        else:
            kube.deployment.metadata.generation = (
                None if drift == "missing_generation" else 5
            )
        run_id, validator = await prepare_rollback(harness, source, kube)
        run = await harness.repository.get_workflow_run_snapshot(run_id)
        assert run and run.run_status is RunStatus.FAILED
        detail = await harness.client.get(
            f"/api/v1/incidents/{harness.incident_id}?runId={run_id}"
        )
        assert detail.status_code == 200, detail.text
        assert detail.json()["selectedRun"]["error"]["code"] == "stale_resource"
        assert detail.json()["repair"] is None
        assert validator.patches == []


@pytest.mark.parametrize("outcome", ["REJECTED", "STALE_RESOURCE", "UNKNOWN"])
async def test_failed_inverse_keeps_target_occupied_and_cannot_be_rollback_source(
    tmp_path: Path,
    credential: tuple[str, str],
    outcome: str,
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        source = await finish_source(harness)
        run_id, _ = await prepare_rollback(harness, source, RecoveryFixture())
        detail = await harness.client.get(
            f"/api/v1/incidents/{harness.incident_id}?runId={run_id}"
        )
        body = detail.json()["repair"]
        approved = await harness.client.post(
            harness.path,
            headers=harness.headers,
            json={
                "runId": str(run_id),
                "proposalId": body["id"],
                "proposalDigest": body["digest"],
                "decision": "approve",
            },
        )
        assert approved.status_code == 200, approved.text
        command = await harness.repository.claim_execution(now=harness.now)
        assert command
        result = ExecutionResult.model_validate(
            {
                "outcome": outcome,
                "error": "outcome_unknown"
                if outcome == "UNKNOWN"
                else "precondition_failed",
            }
        )
        await harness.repository.report_execution(
            command.execution_id, result, now=harness.now
        )
        response = await harness.client.get(
            f"/api/v1/incidents/{harness.incident_id}?runId={run_id}"
        )
        assert response.status_code == 200, response.text
        assert response.json()["selectedRun"]["status"] == "FAILED"
        assert response.json()["verification"] is None
        assert response.json()["actions"]["rerun"] == "execution_held"
        assert response.json()["actions"]["refresh"] is not None
        assert response.json()["actions"]["edit"] == "not_applicable"
        assert response.json()["actions"]["rollback"] == "not_applicable"
        assert (
            await harness.repository.list_prune_targets(
                harness.now() + timedelta(days=8),
                tmp_path / "artifacts",
            )
            == ()
        )
        async with harness.database.session_factory() as session:
            row = await session.get(ExecutionRow, str(command.execution_id))
            assert row and row.target_released_at is None
        assert (
            await harness.client.post(
                f"/api/v1/incidents/{harness.incident_id}/repair-runs",
                headers=harness.headers,
                json={
                    "sourceRunId": str(harness.run_id),
                    "sourceExecutionId": str(source),
                },
            )
        ).status_code == 409
        other_incident, other_approval = await harness.another_proposal()
        assert (
            await harness.client.post(
                f"/api/v1/incidents/{other_incident}/approvals",
                headers=harness.headers,
                json=other_approval,
            )
        ).status_code == 409
        async with harness.database.session_factory() as session:
            assert len((await session.scalars(select(ExecutionRow))).all()) == 2


@pytest.mark.parametrize(
    "source_state",
    ["unconfirmed", "unknown", "late_applied", "wrong_id", "cross_incident"],
)
async def test_only_the_exact_confirmed_same_incident_execution_is_a_source(
    tmp_path: Path,
    credential: tuple[str, str],
    source_state: str,
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        if source_state in ("wrong_id", "cross_incident"):
            execution_id = await finish_source(harness)
        else:
            await harness.approve()
            command = await harness.repository.claim_execution(now=harness.now)
            assert command
            execution_id = command.execution_id
            if source_state != "unconfirmed":
                await harness.repository.report_execution(
                    execution_id,
                    ExecutionResult(outcome="UNKNOWN", error="outcome_unknown"),
                    now=harness.now,
                )
            if source_state == "late_applied":
                from k8s_incident_agent.execution.contracts import ExecutionReceipt

                await harness.repository.report_execution(
                    execution_id,
                    ExecutionResult(
                        outcome="APPLIED",
                        receipt=ExecutionReceipt(
                            uid=command.change.target_uid,
                            resource_version="late-rv",
                            generation=4,
                            before_generation=3,
                        ),
                    ),
                    now=harness.now,
                )
        incident_id = harness.incident_id
        if source_state == "wrong_id":
            execution_id = uuid4()
        if source_state == "cross_incident":
            incident_id, _ = await harness.another_proposal()
        async with harness.database.session_factory() as session:
            before = await session.scalar(select(func.count()).select_from(RunRow))
        response = await harness.client.post(
            f"/api/v1/incidents/{incident_id}/repair-runs",
            headers=harness.headers,
            json={
                "sourceRunId": str(harness.run_id),
                "sourceExecutionId": str(execution_id),
            },
        )
        assert response.status_code == 409, response.text
        async with harness.database.session_factory() as session:
            assert (
                await session.scalar(select(func.count()).select_from(RunRow)) == before
            )


@pytest.mark.parametrize("tamper", ["before_image", "source_execution", "fresh_rv"])
async def test_inverse_proposal_must_match_saved_workload_and_exact_before_state(
    tmp_path: Path,
    credential: tuple[str, str],
    tamper: str,
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        source = await finish_source(harness)
        response = await harness.client.post(
            f"/api/v1/incidents/{harness.incident_id}/repair-runs",
            headers=harness.headers,
            json={"sourceRunId": str(harness.run_id), "sourceExecutionId": str(source)},
        )
        assert response.status_code == 202
        run_id = UUID(response.json()["runId"])
        await harness.repository.start_run(run_id, harness.now())
        run = cast(
            RepairWorkflowRunSnapshot,
            await harness.repository.get_workflow_run_snapshot(run_id),
        )
        kube = RecoveryFixture()
        kube.now = harness.now()
        prepared = await prepare_repair(
            run,
            repository=harness.repository,
            adapter=kube.adapter(),
            credential=diagnostic_credential(),
            validator=RollbackValidator(harness, kube),
            now=harness.now,
        )
        assert prepared.proposal and prepared.validation
        field, value = {
            "before_image": ("replacement_image", "operator:unapproved"),
            "source_execution": ("source_execution_id", uuid4()),
            "fresh_rv": ("target_resource_version", "another-rv"),
        }[tamper]
        forged = compile_repair_proposal(
            prepared.proposal.change.model_copy(update={field: value}),
            schema_checked_at=harness.now(),
            policy_checked_at=harness.now(),
            diff_checked_at=harness.now(),
        )
        invalid = replace(
            prepared,
            proposal=forged,
            validation=prepared.validation.model_copy(
                update={"proposal_digest": forged.digest}
            ),
        )
        with pytest.raises(RecoveryConsistencyError):
            await harness.repository.persist_prepared_repair(invalid)
        await harness.repository.persist_prepared_repair(prepared)
        assert (
            await harness.repository.get_workflow_run_snapshot(run_id)
        ).run_status is RunStatus.WAITING_APPROVAL  # type: ignore[union-attr]


async def test_expired_inverse_requires_a_new_run_and_cannot_choose_another_image(
    tmp_path: Path,
    credential: tuple[str, str],
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        source = await finish_source(harness)
        request = {"sourceRunId": str(harness.run_id), "sourceExecutionId": str(source)}
        path = f"/api/v1/incidents/{harness.incident_id}/repair-runs"
        for extra in (
            {"selection": {"revision": "1", "replicaSetUid": "rs-old"}},
            {"image": CURRENT},
            {"actor": "forged"},
        ):
            assert (
                await harness.client.post(
                    path, headers=harness.headers, json={**request, **extra}
                )
            ).status_code == 422
        assert (await harness.client.post(path, json=request)).status_code == 403
        run_id, _ = await prepare_rollback(harness, source, RecoveryFixture())
        detail = await harness.client.get(
            f"/api/v1/incidents/{harness.incident_id}?runId={run_id}"
        )
        proposal = detail.json()["repair"]
        old_decision = {
            "runId": str(run_id),
            "proposalId": proposal["id"],
            "proposalDigest": proposal["digest"],
            "decision": "approve",
        }
        harness.clock[0] += timedelta(minutes=16)
        assert (
            await harness.client.post(
                harness.path, headers=harness.headers, json=old_decision
            )
        ).status_code == 409
        refreshed = await harness.client.post(
            path,
            headers=harness.headers,
            json={**request, "replacesRunId": str(run_id)},
        )
        assert refreshed.status_code == 202, refreshed.text
        assert refreshed.json()["runId"] != str(run_id)
        old = cast(
            RepairWorkflowRunSnapshot,
            await harness.repository.get_workflow_run_snapshot(run_id),
        )
        assert old.end_reason == "expired" and old.run_status is RunStatus.COMPLETED
        assert await harness.repository.claim_execution(now=harness.now) is None
