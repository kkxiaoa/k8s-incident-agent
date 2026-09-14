from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from typing import Any, cast

import pytest
from tests.recovery_fixtures import RecoveryFixture
from tests.unit.kubernetes.test_adapter_rollout_history import TARGET
from tests.unit.repair.test_repair_preparation import PREVIOUS

from k8s_incident_agent.execution.contracts import ExecutionReceipt
from k8s_incident_agent.kubernetes.errors import KubernetesBoundaryError
from k8s_incident_agent.repair.contracts import RepairProposal
from k8s_incident_agent.repair.verification_policy import workload_ready


@pytest.mark.parametrize(
    "fault",
    [
        None,
        "replicas",
        "updated_replicas",
        "available_replicas",
        "old_replicas",
        "old_pod",
        "owner_uid",
        "other_template",
        "pod_image",
        "ready",
        "waiting",
        "terminating",
        "deployment_terminating",
        "observed_generation",
        "zero",
        "generation",
        "image",
    ],
)
async def test_real_sdk_projection_cannot_count_old_or_incomplete_rollouts_as_ready(
    fault: str | None,
) -> None:
    fixture = RecoveryFixture()
    if fault in ("replicas", "updated_replicas", "available_replicas"):
        setattr(fixture.deployment.status, fault, 2 if fault == "replicas" else 0)
    elif fault == "old_replicas":
        fixture.replicas[0].spec.replicas = 1
    elif fault == "old_pod":
        fixture.pod.metadata.owner_references[0].uid = "rs-new"
    elif fault == "owner_uid":
        fixture.replicas[1].metadata.owner_references[0].uid = "other-deployment"
    elif fault == "other_template":
        fixture.replicas[1].spec.template.spec.containers[0].args = ["changed-argument"]
    elif fault == "pod_image":
        fixture.pod.spec.containers[0].image = "different-image"
    elif fault == "ready":
        fixture.pod.status.conditions[0].status = "False"
    elif fault == "waiting":
        fixture.pod.status.container_statuses[0].state.running = None
    elif fault == "terminating":
        fixture.pod.metadata.deletion_timestamp = fixture.now
    elif fault == "deployment_terminating":
        fixture.deployment.metadata.deletion_timestamp = fixture.now
    elif fault == "observed_generation":
        fixture.deployment.status.observed_generation = 3
    elif fault == "zero":
        fixture.deployment.spec.replicas = 0
    elif fault == "generation":
        fixture.deployment.metadata.generation = 5
    elif fault == "image":
        fixture.deployment.spec.template.spec.containers[0].image = "different-image"
    result = await fixture.adapter().read_recovery_workload(TARGET, "workload")
    receipt = ExecutionReceipt(
        uid="deployment-uid",
        resource_version="applied-rv",
        generation=4,
        before_generation=3,
    )
    assert workload_ready(
        result,
        cast(RepairProposal, SimpleNamespace(replacement_image=PREVIOUS)),
        receipt,
    ) is (fault is None)
    if fault is None:
        assert (
            result.current_replica_set is not None
            and result.current_replica_set.uid == "rs-old"
        )
        assert "changed-argument" not in result.model_dump_json()


async def test_invalid_integer_and_ambiguous_owner_are_not_normalized_to_health() -> (
    None
):
    fixture = RecoveryFixture()
    fixture.deployment.status.observed_generation = True
    with pytest.raises(KubernetesBoundaryError):
        await fixture.adapter().read_recovery_workload(TARGET, "workload")


async def test_current_logs_are_owner_bound_clipped_after_execution_and_redacted() -> (
    None
):
    fixture = RecoveryFixture()
    fixture.now += timedelta(seconds=60)
    since = fixture.now - timedelta(seconds=60)
    requests: list[dict[str, Any]] = []

    class Content:
        def __init__(self) -> None:
            self.data = (
                (since - timedelta(seconds=1)).isoformat()
                + " ignored old line\n"
                + since.isoformat()
                + " Authorization: Bearer synthetic-log-credential\n"
                + fixture.now.isoformat()
                + " error is only auxiliary text\n"
            ).encode()

        async def read(self, size: int) -> bytes:
            result, self.data = self.data[:size], self.data[size:]
            return result

    async def read_log(**kwargs: Any) -> Any:
        requests.append(kwargs)
        return SimpleNamespace(
            status=200, content=Content(), headers={}, release=lambda: None
        )

    fixture.read_namespaced_pod_log = read_log  # type: ignore[attr-defined]
    adapter = fixture.adapter()
    workload = await adapter.read_recovery_workload(TARGET, "workload")
    logs = await adapter.read_recovery_logs(TARGET, "workload", workload, since)
    assert logs.error is None and logs.redacted
    encoded = logs.model_dump_json()
    assert (
        "ignored old line" not in encoded and "synthetic-log-credential" not in encoded
    )
    assert "error is only auxiliary text" in encoded
    assert (
        requests[0]["name"] == "recovered-pod"
        and requests[0]["container"] == "workload"
    )
    assert requests[0]["previous"] is False and requests[0]["since_seconds"] == 60
    assert requests[0]["follow"] is False and requests[0]["tail_lines"] == 80
