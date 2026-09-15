from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

import pytest
from tests.recovery_fixtures import RecoveryFixture
from tests.unit.repair import test_repair_preparation as preparation_fixtures
from tests.unit.repair.test_explicit_rollback import finish_source, prepare_rollback
from tests.unit.routes.test_approvals import approval_harness
from tests.unit.routes.test_operator import credential as credential

from k8s_incident_agent.execution.contracts import ExecutionResult


@pytest.mark.parametrize(
    ("operation", "outcome"),
    [
        ("apply", "EXPIRED"),
        ("rollback", "EXPIRED"),
        ("apply", "REJECTED"),
        ("apply", "STALE_RESOURCE"),
    ],
)
async def test_known_unwritten_execution_can_prepare_a_new_unapproved_run(
    tmp_path: Path,
    credential: tuple[str, str],
    operation: Literal["apply", "rollback"],
    outcome: Literal["EXPIRED", "REJECTED", "STALE_RESOURCE"],
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        run_id = harness.run_id
        if operation == "rollback":
            source_execution_id = await finish_source(harness)
            run_id, _ = await prepare_rollback(
                harness, source_execution_id, RecoveryFixture()
            )
        path = f"/api/v1/incidents/{harness.incident_id}"
        waiting = (await harness.client.get(path, params={"runId": str(run_id)})).json()
        approved = await harness.client.post(
            harness.path,
            headers=harness.headers,
            json={
                "runId": str(run_id),
                "proposalId": waiting["repair"]["id"],
                "proposalDigest": waiting["repair"]["digest"],
                "decision": "approve",
            },
        )
        assert approved.status_code == 200, approved.text
        if outcome == "EXPIRED":
            harness.clock[0] += timedelta(seconds=30)
            assert await harness.repository.claim_execution(now=harness.now) is None
        else:
            command = await harness.repository.claim_execution(now=harness.now)
            assert command is not None
            await harness.repository.report_execution(
                command.execution_id,
                ExecutionResult(outcome=outcome, error="precondition_failed"),
                now=harness.now,
            )
        finished = (
            await harness.client.get(path, params={"runId": str(run_id)})
        ).json()
        assert finished["approval"]["execution"]["status"] == outcome
        assert finished["actions"]["refresh"] is None
        assert finished["actions"]["edit"] == (
            "not_applicable" if operation == "rollback" else None
        )
        assert finished["actions"]["rerun"] == "diagnosis_unavailable"
        created = await harness.client.post(
            f"{path}/repair-runs",
            headers=harness.headers,
            json=finished["actions"]["preparationSource"],
        )
        assert created.status_code == 202, created.text
        new_run_id = created.json()["runId"]
        assert new_run_id != str(run_id)
        fresh = (await harness.client.get(path, params={"runId": new_run_id})).json()
        assert fresh["selectedRun"]["operation"] == operation
        assert (
            fresh["selectedRun"]["sourceRunId"]
            == finished["actions"]["preparationSource"]["sourceRunId"]
        )
        assert fresh["approval"] is None
        assert fresh["repair"] is None
        original = (
            await harness.client.get(path, params={"runId": str(run_id)})
        ).json()
        assert original["approval"] == finished["approval"]


async def test_detail_projects_exact_preparation_without_model_dependency(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        path = f"/api/v1/incidents/{harness.incident_id}"
        detail = (await harness.client.get(path)).json()
        actions = detail["actions"]
        assert actions["approve"] is None and actions["reject"] is None
        assert actions["refresh"] is None and actions["edit"] is None
        assert actions["prepare"] == "not_applicable"
        assert actions["rerun"] == "diagnosis_unavailable"
        assert actions["preparationSource"] == {
            "sourceRunId": str(harness.run_id),
            "sourceExecutionId": None,
        }
        assert actions["historyCandidates"]
        assert all(
            isinstance(item["revision"], str) for item in actions["historyCandidates"]
        )
        source_id = detail["selectedRun"]["sourceRunId"]
        historical = (
            await harness.client.get(path, params={"runId": source_id})
        ).json()
        assert historical["selectedRun"]["id"] == source_id
        assert historical["actions"]["prepare"] == "active_run"
        assert historical["actions"]["approve"] == "not_applicable"
        await harness.approve()
        applied = (await harness.client.get(path)).json()
        assert applied["actions"]["rerun"] == "execution_held"
        assert applied["actions"]["approve"] == "not_applicable"


@pytest.mark.parametrize("enabled", [True, False])
async def test_detail_exposes_disabled_and_expired_decisions_but_can_refresh(
    tmp_path: Path, credential: tuple[str, str], enabled: bool
) -> None:
    async with approval_harness(tmp_path, credential, enabled=enabled) as harness:
        harness.clock[0] += timedelta(minutes=16)
        detail = (
            await harness.client.get(f"/api/v1/incidents/{harness.incident_id}")
        ).json()
        expected = "proposal_expired" if enabled else "execution_disabled"
        assert detail["actions"]["approve"] == expected
        assert detail["actions"]["reject"] == expected
        assert detail["actions"]["refresh"] is None
        assert detail["actions"]["edit"] is None


async def test_cross_incident_target_occupancy_blocks_only_approval(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        another_id, _ = await harness.another_proposal()
        await harness.approve()
        detail = (await harness.client.get(f"/api/v1/incidents/{another_id}")).json()
        assert detail["actions"]["rerun"] != "execution_held"
        assert detail["actions"]["approve"] == "target_occupied"
        assert detail["actions"]["reject"] is None
        assert detail["actions"]["refresh"] is None


async def test_rollback_and_failed_refresh_project_the_original_trusted_source(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        execution_id = await finish_source(harness)
        path = f"/api/v1/incidents/{harness.incident_id}"
        source = (await harness.client.get(path)).json()
        assert source["actions"]["rollback"] is None
        kube = RecoveryFixture()
        kube.deployment.metadata.generation = 8
        run_id, _ = await prepare_rollback(harness, execution_id, kube)
        detail = (await harness.client.get(path, params={"runId": str(run_id)})).json()
        assert detail["selectedRun"]["status"] == "FAILED"
        assert detail["repair"] is None
        assert detail["actions"]["refresh"] is None
        assert detail["actions"]["edit"] == "not_applicable"
        assert detail["actions"]["rollback"] == "not_applicable"
        assert detail["actions"]["preparationSource"] == {
            "sourceRunId": str(harness.run_id),
            "sourceExecutionId": str(execution_id),
        }


async def test_sdk_history_int64_revision_reaches_the_browser_without_float_rounding(
    tmp_path: Path, credential: tuple[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    class LargeRevisions(preparation_fixtures.KubernetesFixture):
        def __init__(self, now: datetime = preparation_fixtures.FRESH_NOW) -> None:
            super().__init__(now)
            for index, replica in enumerate(self.replicas):
                replica.metadata.annotations["deployment.kubernetes.io/revision"] = str(
                    (1 << 63) - 1 - index
                )

    monkeypatch.setattr(preparation_fixtures, "KubernetesFixture", LargeRevisions)
    async with approval_harness(tmp_path, credential) as harness:
        path = f"/api/v1/incidents/{harness.incident_id}"
        latest = (await harness.client.get(path)).json()
        source = (
            await harness.client.get(
                path, params={"runId": latest["selectedRun"]["sourceRunId"]}
            )
        ).json()
        assert (
            source["actions"]["historyCandidates"][0]["revision"]
            == "9223372036854775806"
        )
