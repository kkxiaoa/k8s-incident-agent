from __future__ import annotations

import hashlib
from datetime import datetime
from typing import Final, cast
from uuid import UUID, uuid5

from pydantic import ValidationError

from k8s_incident_agent.diagnosis.contracts import ValidatedDiagnosis
from k8s_incident_agent.domain.contracts import KubernetesTarget
from k8s_incident_agent.domain.models import (
    DiagnosisValidationSnapshot,
    JsonValue,
)
from k8s_incident_agent.kubernetes.contracts import (
    RolloutHistoryPayload,
    TargetRef,
    WorkloadPayload,
)
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.repair.contracts import (
    EvidenceBoundImageChange,
    JsonPatchOperation,
    RepairAction,
    RepairDiff,
    RepairProposal,
)

_REPAIR_NAMESPACE: Final = UUID("4a999af4-1b9c-5d42-a967-c45b79f38a47")


class RepairPreparationError(RuntimeError):
    retryable = False

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(f"Repair {code.removeprefix('repair_').replace('_', ' ')}")


def resolve_evidence_bound_change(
    diagnosis: ValidatedDiagnosis,
    snapshot: DiagnosisValidationSnapshot,
    *,
    run_id: UUID,
    target: KubernetesTarget,
    allowed_action: RepairAction | None,
) -> EvidenceBoundImageChange:
    intent = diagnosis.repair_intent
    if intent is None:
        raise RepairPreparationError("repair_schema_invalid")
    if allowed_action != "set_container_image" or intent.action != allowed_action:
        raise RepairPreparationError("repair_policy_denied")
    if intent.target != target or target.namespace is None:
        raise RepairPreparationError("repair_policy_denied")
    cited_ids = {
        evidence_id
        for root_cause in diagnosis.root_causes
        if root_cause.code == "image_invalid_registry"
        for evidence_id in root_cause.evidence_ids
    }
    requested_ids = set(intent.evidence_ids)
    if not requested_ids.issubset(cited_ids):
        raise RepairPreparationError("repair_policy_denied")
    try:
        evidence = tuple(
            snapshot.evidence_by_id[value] for value in intent.evidence_ids
        )
    except KeyError:
        raise RepairPreparationError("repair_policy_denied") from None
    if (
        len(evidence) != 2
        or {item.evidence_kind for item in evidence} != {"workload", "rollout_history"}
        or any(
            item.run_id != run_id or item.truncated or item.redacted
            for item in evidence
        )
    ):
        raise RepairPreparationError("repair_policy_denied")
    by_kind = {item.evidence_kind: item for item in evidence}
    workload_evidence = by_kind["workload"]
    rollout_evidence = by_kind["rollout_history"]
    try:
        workload_ref = TargetRef.model_validate(workload_evidence.target_ref)
        rollout_ref = TargetRef.model_validate(rollout_evidence.target_ref)
        workload = WorkloadPayload.model_validate(workload_evidence.payload)
        rollout = RolloutHistoryPayload.model_validate(rollout_evidence.payload)
    except ValidationError:
        raise RepairPreparationError("repair_policy_denied") from None
    expected_ref = (
        target.api_version,
        target.kind,
        target.namespace,
        target.name,
    )
    if (
        (
            workload_ref.api_version,
            workload_ref.kind,
            workload_ref.namespace,
            workload_ref.name,
        )
        != expected_ref
        or (
            rollout_ref.api_version,
            rollout_ref.kind,
            rollout_ref.namespace,
            rollout_ref.name,
        )
        != expected_ref
        or workload_ref.uid != rollout_ref.uid
        or workload.workload.resource_version
        != rollout.source_workload.resource_version
    ):
        raise RepairPreparationError("repair_policy_denied")
    containers = [
        container
        for container in workload.workload.containers
        if container.name == intent.container_name
    ]
    if len(containers) != 1 or containers[0].source_index is None:
        raise RepairPreparationError("repair_policy_denied")
    current_image = containers[0].image
    if not rollout.revisions:
        raise RepairPreparationError("repair_policy_denied")
    current_revision = rollout.revisions[0]
    current_containers = [
        container
        for container in current_revision.containers
        if container.name == intent.container_name
    ]
    if len(current_containers) != 1 or current_containers[0].image != current_image:
        raise RepairPreparationError("repair_policy_denied")
    prior_revisions = rollout.revisions[1:]
    if not prior_revisions:
        raise RepairPreparationError("repair_policy_denied")
    prior_containers = [
        container
        for container in prior_revisions[0].containers
        if container.name == intent.container_name
    ]
    if (
        len(prior_containers) != 1
        or prior_containers[0].image != intent.replacement_image
        or intent.replacement_image == current_image
    ):
        raise RepairPreparationError("repair_policy_denied")
    try:
        return EvidenceBoundImageChange(
            run_id=run_id,
            action="set_container_image",
            target=target,
            target_uid=workload_ref.uid,
            target_resource_version=workload.workload.resource_version,
            container_index=containers[0].source_index,
            container_name=intent.container_name,
            current_image=current_image,
            replacement_image=intent.replacement_image,
            evidence_ids=sorted(intent.evidence_ids, key=str),
        )
    except ValidationError:
        raise RepairPreparationError("repair_policy_denied") from None


def compile_repair_proposal(
    change: EvidenceBoundImageChange,
    *,
    schema_checked_at: datetime,
    policy_checked_at: datetime,
    diff_checked_at: datetime,
) -> RepairProposal:
    path = f"/spec/template/spec/containers/{change.container_index}/image"
    patch = [
        JsonPatchOperation(op="test", path="/metadata/uid", value=change.target_uid),
        JsonPatchOperation(
            op="test",
            path="/metadata/resourceVersion",
            value=change.target_resource_version,
        ),
        JsonPatchOperation(
            op="test",
            path=(f"/spec/template/spec/containers/{change.container_index}/name"),
            value=change.container_name,
        ),
        JsonPatchOperation(op="test", path=path, value=change.current_image),
        JsonPatchOperation(op="replace", path=path, value=change.replacement_image),
    ]
    diff = RepairDiff(
        path=path,
        before=change.current_image,
        after=change.replacement_image,
    )
    digest = repair_proposal_digest(change, patch)
    try:
        return RepairProposal(
            id=uuid5(_REPAIR_NAMESPACE, f"{change.run_id}:repair-proposal"),
            change=change,
            patch=patch,
            digest=digest,
            diff=diff,
            schema_checked_at=schema_checked_at,
            policy_checked_at=policy_checked_at,
            diff_checked_at=diff_checked_at,
        )
    except ValidationError:
        raise RepairPreparationError("repair_diff_invalid") from None


def require_exact_repair_proposal(proposal: RepairProposal) -> None:
    """Reject a rehydrated proposal that differs from the fixed compiler output."""

    expected = compile_repair_proposal(
        proposal.change,
        schema_checked_at=proposal.schema_checked_at,
        policy_checked_at=proposal.policy_checked_at,
        diff_checked_at=proposal.diff_checked_at,
    )
    if proposal != expected:
        raise ValueError("Repair proposal does not match the fixed compiler")


def repair_proposal_digest(
    change: EvidenceBoundImageChange,
    patch: list[JsonPatchOperation],
) -> str:
    document: dict[str, JsonValue] = {
        "domain": "k8s-incident-agent.repair-proposal.v1",
        "change": cast(
            dict[str, JsonValue],
            change.model_dump(mode="json"),
        ),
        "patch": cast(
            list[JsonValue],
            [operation.model_dump(mode="json") for operation in patch],
        ),
    }
    digest = hashlib.sha256(canonical_json(document).encode()).hexdigest()
    return f"sha256:{digest}"
