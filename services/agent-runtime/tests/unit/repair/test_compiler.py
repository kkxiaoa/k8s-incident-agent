from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest

from k8s_incident_agent.diagnosis.contracts import ValidatedDiagnosis
from k8s_incident_agent.domain.contracts import KubernetesTarget
from k8s_incident_agent.domain.models import (
    DiagnosisValidationSnapshot,
    PersistedEvidence,
    RunEvent,
)
from k8s_incident_agent.repair.compiler import (
    RepairPreparationError,
    compile_repair_proposal,
    require_exact_repair_proposal,
    resolve_evidence_bound_change,
)
from k8s_incident_agent.repair.contracts import JsonPatchOperation

NOW = datetime(2026, 9, 6, 12, 0, tzinfo=UTC)
RUN_ID = uuid4()
INCIDENT_ID = uuid4()
TARGET = KubernetesTarget(
    cluster="k8s-incident-agent",
    namespace="k8s-incident-scenarios",
    api_version="apps/v1",
    kind="Deployment",
    name="image-pull-backoff",
)
CURRENT_IMAGE = "registry.invalid/k8s-incident-agent/missing:v2"
PREVIOUS_IMAGE = "registry.k8s.io/e2e-test-images/agnhost:2.53"


def _evidence(
    evidence_id: UUID,
    kind: str,
    payload: dict[str, object],
    *,
    uid: str = "deployment-uid",
    truncated: bool = False,
    run_id: UUID = RUN_ID,
) -> PersistedEvidence:
    return PersistedEvidence(
        id=evidence_id,
        run_id=run_id,
        tool_call_id=f"call-{kind}",
        tool_name=f"get_{kind}",
        evidence_kind=kind,
        target_ref={
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "namespace": "k8s-incident-scenarios",
            "name": "image-pull-backoff",
            "uid": uid,
        },
        observed_at=NOW,
        payload=payload,  # type: ignore[arg-type]
        truncated=truncated,
        redacted=False,
        event=RunEvent(
            id=1,
            incident_id=INCIDENT_ID,
            run_id=RUN_ID,
            event_key=f"tool:call-{kind}:evidence",
            event_type="evidence.recorded",
            occurred_at=NOW,
            payload={},
        ),
    )


def _pull_failure_payloads(
    *,
    failing_container: str = "workload",
    failing_image: str = CURRENT_IMAGE,
    owner_uid: str = "rs-new",
) -> tuple[dict[str, object], dict[str, object]]:
    source_workload: dict[str, object] = {
        "resourceVersion": "42",
        "selector": {"matchLabels": {"app": "image-pull"}},
    }
    pods: dict[str, object] = {
        "sourceWorkload": source_workload,
        "pods": [
            {
                "apiVersion": "v1",
                "kind": "Pod",
                "namespace": "k8s-incident-scenarios",
                "name": "image-pull-pod",
                "uid": "pod-uid",
                "resourceVersion": "44",
                "owner": {
                    "apiVersion": "apps/v1",
                    "kind": "ReplicaSet",
                    "name": "image-pull-new",
                    "uid": owner_uid,
                    "controller": True,
                },
                "phase": "Pending",
                "conditions": [],
                "containers": [
                    {
                        "name": failing_container,
                        "image": failing_image,
                        "imageId": None,
                        "restartCount": 0,
                        "state": {
                            "status": "waiting",
                            "reason": "ImagePullBackOff",
                            "message": "Image pull failed.",
                        },
                    }
                ],
            }
        ],
    }
    events: dict[str, object] = {
        "sourceWorkload": source_workload,
        "associatedReplicaSetCount": 1,
        "associatedPodCount": 1,
        "events": [
            {
                "apiVersion": "events.k8s.io/v1",
                "kind": "Event",
                "namespace": "k8s-incident-scenarios",
                "name": "image-pull-pod.failed",
                "uid": "event-uid",
                "resourceVersion": "45",
                "regarding": {
                    "apiVersion": "v1",
                    "kind": "Pod",
                    "namespace": "k8s-incident-scenarios",
                    "name": "image-pull-pod",
                    "uid": "pod-uid",
                },
                "type": "Warning",
                "reason": "Failed",
                "action": None,
                "note": "Failed to pull image.",
                "eventTime": NOW.isoformat(),
                "seriesCount": 3,
                "reportingController": "kubelet",
            }
        ],
    }
    return pods, events


def _snapshot(
    *,
    rollout_uid: str = "deployment-uid",
    rollout_resource_version: str = "42",
    workload_truncated: bool = False,
    current_image: str = CURRENT_IMAGE,
    fault: dict[str, str] | None = None,
    fault_run_id: UUID = RUN_ID,
    fault_truncated: bool = False,
    record_fault: bool = True,
) -> tuple[DiagnosisValidationSnapshot, UUID, UUID]:
    workload_id = uuid4()
    rollout_id = uuid4()
    workload = _evidence(
        workload_id,
        "workload",
        {
            "workload": {
                "resourceVersion": "42",
                "generation": 3,
                "observedGeneration": 3,
                "replicas": {
                    "desired": 1,
                    "updated": 1,
                    "ready": 0,
                    "available": 0,
                },
                "selector": {"matchLabels": {"app": "image-pull"}},
                "containers": [
                    {
                        "name": "telemetry",
                        "image": "registry.example/telemetry:v2",
                        "imagePullPolicy": "IfNotPresent",
                        "command": [],
                        "args": [],
                        "probes": [],
                        "sourceIndex": 1,
                    },
                    {
                        "name": "workload",
                        "image": current_image,
                        "imagePullPolicy": "Always",
                        "command": [],
                        "args": [],
                        "probes": [],
                        "sourceIndex": 0,
                    },
                ],
                "conditions": [],
            }
        },
        truncated=workload_truncated,
    )
    rollout = _evidence(
        rollout_id,
        "rollout_history",
        {
            "sourceWorkload": {
                "resourceVersion": rollout_resource_version,
                "selector": {"matchLabels": {"app": "image-pull"}},
            },
            "revisions": [
                {
                    "revision": 3,
                    "replicaSetRef": {
                        "apiVersion": "apps/v1",
                        "kind": "ReplicaSet",
                        "namespace": "k8s-incident-scenarios",
                        "name": "image-pull-new",
                        "uid": "rs-new",
                    },
                    "containers": [{"name": "workload", "image": current_image}],
                },
                {
                    "revision": 2,
                    "replicaSetRef": {
                        "apiVersion": "apps/v1",
                        "kind": "ReplicaSet",
                        "namespace": "k8s-incident-scenarios",
                        "name": "image-pull-old",
                        "uid": "rs-old",
                    },
                    "containers": [{"name": "workload", "image": PREVIOUS_IMAGE}],
                },
            ],
        },
        uid=rollout_uid,
    )
    evidence_by_id = {workload_id: workload, rollout_id: rollout}
    if record_fault:
        pods_payload, events_payload = _pull_failure_payloads(
            **{"failing_image": current_image, **(fault or {})}
        )
        pods_id, events_id = uuid4(), uuid4()
        evidence_by_id[pods_id] = _evidence(
            pods_id,
            "pods",
            pods_payload,
            run_id=fault_run_id,
            truncated=fault_truncated,
        )
        evidence_by_id[events_id] = _evidence(
            events_id,
            "events",
            events_payload,
            run_id=fault_run_id,
            truncated=fault_truncated,
        )
    return (
        DiagnosisValidationSnapshot(
            evidence_by_id=evidence_by_id,
            tool_failures=(),
            unresolved_tool_failures=(),
        ),
        workload_id,
        rollout_id,
    )


def _diagnosis(
    workload_id: UUID,
    rollout_id: UUID,
    *,
    code: str = "image_invalid_registry",
) -> ValidatedDiagnosis:
    return ValidatedDiagnosis.model_validate(
        {
            "outcome": "diagnosed",
            "summary": "The current image cannot be pulled.",
            "root_causes": [
                {
                    "code": code,
                    "statement": "The current image uses a reserved registry.",
                    "confidence": "high",
                    "evidence_ids": [str(workload_id), str(rollout_id)],
                }
            ],
            "missing_information": [],
            "repair_intent": {
                "action": "set_container_image",
                "target": TARGET.model_dump(mode="json"),
                "container_name": "workload",
                "replacement_image": PREVIOUS_IMAGE,
                "evidence_ids": [str(workload_id), str(rollout_id)],
            },
            "redacted": False,
        }
    )


def test_compiler_binds_patch_and_digest_to_same_run_evidence() -> None:
    snapshot, workload_id, rollout_id = _snapshot()
    diagnosis = _diagnosis(workload_id, rollout_id)

    change = resolve_evidence_bound_change(
        diagnosis,
        snapshot,
        run_id=RUN_ID,
        target=TARGET,
        allowed_action="set_container_image",
    )
    proposal = compile_repair_proposal(
        change,
        schema_checked_at=NOW,
        policy_checked_at=NOW,
        diff_checked_at=NOW,
    )

    assert proposal.container_index == 0
    assert [operation.model_dump(mode="json") for operation in proposal.patch] == [
        {"op": "test", "path": "/metadata/uid", "value": "deployment-uid"},
        {
            "op": "test",
            "path": "/metadata/resourceVersion",
            "value": "42",
        },
        {
            "op": "test",
            "path": "/spec/template/spec/containers/0/name",
            "value": "workload",
        },
        {
            "op": "test",
            "path": "/spec/template/spec/containers/0/image",
            "value": CURRENT_IMAGE,
        },
        {
            "op": "replace",
            "path": "/spec/template/spec/containers/0/image",
            "value": PREVIOUS_IMAGE,
        },
    ]
    assert proposal.diff.before == CURRENT_IMAGE
    assert proposal.diff.after == PREVIOUS_IMAGE
    assert proposal.digest.startswith("sha256:")
    assert proposal == compile_repair_proposal(
        change,
        schema_checked_at=NOW,
        policy_checked_at=NOW,
        diff_checked_at=NOW,
    )
    require_exact_repair_proposal(proposal)

    substituted = proposal.model_copy(
        update={
            "patch": [
                *proposal.patch[:-1],
                JsonPatchOperation(
                    op="replace",
                    path="/metadata/uid",
                    value="substituted",
                ),
            ]
        }
    )
    with pytest.raises(ValueError, match="fixed compiler"):
        require_exact_repair_proposal(substituted)


@pytest.mark.parametrize(
    ("snapshot_options", "expected_code"),
    [
        ({"rollout_uid": "recreated-uid"}, "repair_policy_denied"),
        ({"rollout_resource_version": "43"}, "repair_policy_denied"),
        ({"workload_truncated": True}, "repair_policy_denied"),
    ],
)
def test_policy_rejects_evidence_identity_or_budget_drift(
    snapshot_options: dict[str, object],
    expected_code: str,
) -> None:
    snapshot, workload_id, rollout_id = _snapshot(**snapshot_options)  # type: ignore[arg-type]

    with pytest.raises(RepairPreparationError) as captured:
        resolve_evidence_bound_change(
            _diagnosis(workload_id, rollout_id),
            snapshot,
            run_id=RUN_ID,
            target=TARGET,
            allowed_action="set_container_image",
        )

    assert captured.value.code == expected_code


def test_policy_rejects_cross_run_evidence() -> None:
    snapshot, workload_id, rollout_id = _snapshot()
    evidence = snapshot.evidence_by_id[rollout_id]
    drifted = PersistedEvidence(
        id=evidence.id,
        run_id=uuid4(),
        tool_call_id=evidence.tool_call_id,
        tool_name=evidence.tool_name,
        evidence_kind=evidence.evidence_kind,
        target_ref=evidence.target_ref,
        observed_at=evidence.observed_at,
        payload=evidence.payload,
        truncated=evidence.truncated,
        redacted=evidence.redacted,
        event=evidence.event,
    )
    drifted_snapshot = DiagnosisValidationSnapshot(
        evidence_by_id={
            workload_id: snapshot.evidence_by_id[workload_id],
            rollout_id: drifted,
        },
        tool_failures=(),
        unresolved_tool_failures=(),
    )

    with pytest.raises(RepairPreparationError, match="policy"):
        resolve_evidence_bound_change(
            _diagnosis(workload_id, rollout_id),
            drifted_snapshot,
            run_id=RUN_ID,
            target=TARGET,
            allowed_action="set_container_image",
        )


@pytest.mark.parametrize(
    "code",
    ["image_invalid_registry", "registry_host_unresolvable", "workload_misconfigured"],
)
def test_policy_decides_from_facts_not_from_the_root_cause_name(code: str) -> None:
    """The same proven facts keep the action whatever the model called them."""

    snapshot, workload_id, rollout_id = _snapshot()

    change = resolve_evidence_bound_change(
        _diagnosis(workload_id, rollout_id, code=code),
        snapshot,
        run_id=RUN_ID,
        target=TARGET,
        allowed_action="set_container_image",
    )

    assert change.container_name == "workload"
    assert change.current_image == CURRENT_IMAGE
    assert change.replacement_image == PREVIOUS_IMAGE


@pytest.mark.parametrize(
    "snapshot_options",
    [
        # Another container's pull failure must not license replacing this one.
        {
            "fault": {
                "failing_container": "telemetry",
                "failing_image": "registry.example/telemetry:v2",
            }
        },
        # Pods left over from an earlier ReplicaSet prove nothing about this revision.
        {"fault": {"owner_uid": "rs-old"}},
        # Without the pull failure itself only the history remains, which is not a fault.
        {"record_fault": False},
        # Observations another Run recorded cannot prove this Run's fault.
        {"fault_run_id": uuid4()},
        # A truncated observation is not a usable proof.
        {"fault_truncated": True},
    ],
)
def test_policy_requires_the_pull_failure_attributed_to_this_container(
    snapshot_options: dict[str, object],
) -> None:
    snapshot, workload_id, rollout_id = _snapshot(**snapshot_options)  # type: ignore[arg-type]

    with pytest.raises(RepairPreparationError) as captured:
        resolve_evidence_bound_change(
            _diagnosis(workload_id, rollout_id),
            snapshot,
            run_id=RUN_ID,
            target=TARGET,
            allowed_action="set_container_image",
        )

    assert captured.value.code == "repair_policy_denied"


def test_policy_rejects_an_intent_no_root_cause_cites() -> None:
    snapshot, workload_id, rollout_id = _snapshot()
    diagnosis = _diagnosis(workload_id, rollout_id)
    uncited = diagnosis.model_copy(
        update={
            "root_causes": [
                diagnosis.root_causes[0].model_copy(
                    update={"evidence_ids": [workload_id]}
                )
            ]
        }
    )

    with pytest.raises(RepairPreparationError) as captured:
        resolve_evidence_bound_change(
            uncited,
            snapshot,
            run_id=RUN_ID,
            target=TARGET,
            allowed_action="set_container_image",
        )

    assert captured.value.code == "repair_policy_denied"


def test_policy_rejects_a_pull_failure_from_an_ordinary_registry() -> None:
    """Credentials, network or rate limits fail the same way and stay out of reach."""

    snapshot, workload_id, rollout_id = _snapshot(
        current_image="registry.example.com/private/workload:v1"
    )

    with pytest.raises(RepairPreparationError) as captured:
        resolve_evidence_bound_change(
            _diagnosis(workload_id, rollout_id),
            snapshot,
            run_id=RUN_ID,
            target=TARGET,
            allowed_action="set_container_image",
        )

    assert captured.value.code == "repair_policy_denied"
