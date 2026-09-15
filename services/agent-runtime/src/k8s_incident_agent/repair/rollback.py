from dataclasses import dataclass
from uuid import UUID

from k8s_incident_agent.execution.contracts import ExecutionReceipt
from k8s_incident_agent.kubernetes.contracts import WorkloadObservation
from k8s_incident_agent.repair.compiler import RepairPreparationError
from k8s_incident_agent.repair.contracts import EvidenceBoundImageChange, RepairProposal


@dataclass(frozen=True, slots=True)
class RollbackSource:
    proposal: RepairProposal
    execution_id: UUID
    receipt: ExecutionReceipt


def resolve_rollback_change(
    *,
    run_id: UUID,
    source: RollbackSource,
    workload: WorkloadObservation,
    evidence_id: UUID,
) -> EvidenceBoundImageChange:
    if workload.truncated or workload.redacted:
        raise RepairPreparationError("repair_policy_denied")
    proposal = source.proposal
    ref, current = workload.target_ref, workload.payload.workload
    containers = [
        item for item in current.containers if item.name == proposal.container_name
    ]
    if (
        (ref.api_version, ref.kind, ref.namespace, ref.name, ref.uid)
        != (
            proposal.target.api_version,
            proposal.target.kind,
            proposal.target.namespace,
            proposal.target.name,
            proposal.target_uid,
        )
        or current.generation != source.receipt.generation
        or len(containers) != 1
        or containers[0].source_index != proposal.container_index
        or containers[0].image != proposal.replacement_image
    ):
        raise RepairPreparationError("stale_resource")
    return EvidenceBoundImageChange(
        run_id=run_id,
        action=proposal.action,
        target=proposal.target,
        target_uid=ref.uid,
        target_resource_version=current.resource_version,
        container_index=proposal.container_index,
        container_name=proposal.container_name,
        current_image=proposal.replacement_image,
        replacement_image=proposal.current_image,
        evidence_ids=[evidence_id],
        source_execution_id=source.execution_id,
    )
