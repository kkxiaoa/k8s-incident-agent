from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from typing import cast
from uuid import UUID

from pydantic import ValidationError

from k8s_incident_agent.domain.contracts import KubernetesTarget, RepairHistorySelection
from k8s_incident_agent.domain.models import (
    EvidenceRecord,
    JsonValue,
    PersistedEvidence,
    RepairOperation,
    RepairWorkflowRunSnapshot,
    ToolFailureRecord,
)
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.contracts import (
    EventsObservation,
    PodsObservation,
    RolloutHistoryObservation,
    WorkloadObservation,
)
from k8s_incident_agent.kubernetes.credentials import (
    DiagnosticCredentialLease,
    require_credential_window,
)
from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    validate_kubernetes_failure_contract,
)
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    RecoveryConsistencyError,
)
from k8s_incident_agent.repair.client import PatchValidator
from k8s_incident_agent.repair.compiler import (
    RepairPreparationError,
    compile_repair_proposal,
)
from k8s_incident_agent.repair.contracts import EvidenceBoundImageChange, RepairProposal
from k8s_incident_agent.repair.eligibility import proves_invalid_image_reference
from k8s_incident_agent.repair.history import image_history_candidates
from k8s_incident_agent.repair.records import PreparedRepairRecord
from k8s_incident_agent.repair.rollback import resolve_rollback_change


def resolve_fresh_change(
    *,
    run_id: UUID,
    source: RepairProposal,
    selection: RepairHistorySelection | None,
    workload: WorkloadObservation,
    history: RolloutHistoryObservation,
    pods: PodsObservation,
    events: EventsObservation,
    evidence_ids: list[UUID],
) -> tuple[EvidenceBoundImageChange, RepairHistorySelection]:
    observations = (workload, history, pods, events)
    if any(item.truncated or item.redacted for item in observations):
        raise RepairPreparationError("repair_policy_denied")
    expected_ref = workload.target_ref
    if (
        any(item.target_ref != expected_ref for item in observations)
        or expected_ref.uid != source.target_uid
        or (
            expected_ref.api_version,
            expected_ref.kind,
            expected_ref.namespace,
            expected_ref.name,
        )
        != (
            source.target.api_version,
            source.target.kind,
            source.target.namespace,
            source.target.name,
        )
        or any(
            payload.source_workload.resource_version
            != workload.payload.workload.resource_version
            for payload in (history.payload, pods.payload, events.payload)
        )
    ):
        raise RepairPreparationError("stale_resource")
    containers = [
        item
        for item in workload.payload.workload.containers
        if item.name == source.container_name
    ]
    if (
        len(containers) != 1
        or containers[0].image != source.current_image
        or containers[0].source_index is None
    ):
        raise RepairPreparationError("stale_resource")
    revisions = history.payload.revisions
    if not revisions or not any(
        item.name == source.container_name and item.image == source.current_image
        for item in revisions[0].containers
    ):
        raise RepairPreparationError("stale_resource")
    if not proves_invalid_image_reference(
        workload=workload.payload,
        pods=(pods.payload,),
        events=(events.payload,),
        container_name=source.container_name,
        replica_set_uid=revisions[0].replica_set_ref.uid,
    ):
        raise RepairPreparationError("stale_resource")
    candidates = [
        (revision, image)
        for revision, image in image_history_candidates(
            history.payload, source.container_name, source.current_image
        )
        if (
            (selection is None and image == source.replacement_image)
            or (
                selection is not None
                and revision.revision == selection.revision
                and revision.replica_set_ref.uid == selection.replica_set_uid
            )
        )
    ]
    if len(candidates) != 1:
        raise RepairPreparationError("repair_no_candidate")
    revision, replacement_image = candidates[0]
    chosen = RepairHistorySelection(
        revision=revision.revision, replica_set_uid=revision.replica_set_ref.uid
    )
    return EvidenceBoundImageChange(
        run_id=run_id,
        action="set_container_image",
        target=source.target,
        target_uid=expected_ref.uid,
        target_resource_version=workload.payload.workload.resource_version,
        container_index=containers[0].source_index,
        container_name=source.container_name,
        current_image=source.current_image,
        replacement_image=replacement_image,
        evidence_ids=sorted(evidence_ids, key=str),
    ), chosen


async def prepare_repair(
    run: RepairWorkflowRunSnapshot,
    *,
    repository: IncidentRepository,
    adapter: KubernetesEvidenceAdapter,
    credential: DiagnosticCredentialLease,
    validator: PatchValidator | None,
    now: Callable[[], datetime],
) -> PreparedRepairRecord:
    if run.started_at is None:
        raise RecoveryConsistencyError
    deadline = run.started_at + timedelta(seconds=run.timeout_seconds)
    try:
        remaining = (deadline - now()).total_seconds()
        if remaining <= 0:
            raise TimeoutError
        async with asyncio.timeout(remaining):
            workload, workload_id = await _read_evidence(
                run,
                repository,
                credential,
                deadline,
                now,
                "get_workload",
                adapter.read_workload,
                WorkloadObservation,
            )
            if run.operation is RepairOperation.ROLLBACK:
                source = await repository.get_rollback_source(run.id)
                if not run.started_at <= workload.observed_at <= now() < deadline:
                    raise RecoveryConsistencyError
                change = resolve_rollback_change(
                    run_id=run.id,
                    source=source,
                    workload=workload,
                    evidence_id=workload_id,
                )
                selection = None
            else:
                change, selection = await _prepare_apply_change(
                    run,
                    workload,
                    workload_id,
                    repository=repository,
                    adapter=adapter,
                    credential=credential,
                    deadline=deadline,
                    now=now,
                )
            checked_at = now()
            proposal = compile_repair_proposal(
                change,
                schema_checked_at=checked_at,
                policy_checked_at=checked_at,
                diff_checked_at=checked_at,
            )
            if validator is None:
                raise RepairPreparationError("patch_validator_upstream_failed")
            validation = await validator.validate(proposal, deadline=deadline)
            if now() >= deadline:
                raise TimeoutError
            return PreparedRepairRecord(
                run_id=run.id,
                recorded_at=now(),
                proposal=proposal,
                validation=validation,
                selection=selection,
                error_code=validation.error.code if validation.error else None,
                error_retryable=validation.error.retryable
                if validation.error
                else None,
            )
    except TimeoutError:
        code, retryable = "repair_timeout", True
    except RepairPreparationError as error:
        code = error.code
        retryable = code == "patch_validator_upstream_failed"
    except KubernetesBoundaryError as error:
        code, retryable = error.code.value, error.retryable
    return PreparedRepairRecord(
        run_id=run.id,
        recorded_at=now(),
        proposal=None,
        validation=None,
        selection=None,
        error_code=code,
        error_retryable=retryable,
    )


async def _prepare_apply_change(
    run: RepairWorkflowRunSnapshot,
    workload: WorkloadObservation,
    workload_id: UUID,
    *,
    repository: IncidentRepository,
    adapter: KubernetesEvidenceAdapter,
    credential: DiagnosticCredentialLease,
    deadline: datetime,
    now: Callable[[], datetime],
) -> tuple[EvidenceBoundImageChange, RepairHistorySelection]:
    assert run.started_at is not None
    source = await repository.get_repair_source_proposal(run.id)
    history, history_id = await _read_evidence(
        run,
        repository,
        credential,
        deadline,
        now,
        "get_rollout_history",
        adapter.read_rollout_history,
        RolloutHistoryObservation,
    )
    pods, _ = await _read_evidence(
        run,
        repository,
        credential,
        deadline,
        now,
        "get_pods",
        adapter.read_pods,
        PodsObservation,
    )
    events, _ = await _read_evidence(
        run,
        repository,
        credential,
        deadline,
        now,
        "get_events",
        adapter.read_events,
        EventsObservation,
    )
    if any(
        not run.started_at <= observation.observed_at <= now() < deadline
        for observation in (workload, history, pods, events)
    ):
        raise RecoveryConsistencyError
    return resolve_fresh_change(
        run_id=run.id,
        source=source,
        selection=run.selection,
        workload=workload,
        history=history,
        pods=pods,
        events=events,
        evidence_ids=[workload_id, history_id],
    )


async def _read_evidence[
    T: (
        WorkloadObservation,
        RolloutHistoryObservation,
        PodsObservation,
        EventsObservation,
    )
](
    run: RepairWorkflowRunSnapshot,
    repository: IncidentRepository,
    credential: DiagnosticCredentialLease,
    deadline: datetime,
    now: Callable[[], datetime],
    tool_name: str,
    reader: Callable[[KubernetesTarget], Awaitable[T]],
    observation_type: type[T],
) -> tuple[T, UUID]:
    tool_call_id = f"repair:{tool_name}"
    outcome = await repository.get_tool_outcome(run.id, tool_call_id, tool_name)
    if isinstance(outcome, ToolFailureRecord):
        code = validate_kubernetes_failure_contract(
            outcome.error_code, retryable=outcome.retryable
        )
        raise KubernetesBoundaryError(code)
    if isinstance(outcome, PersistedEvidence):
        try:
            observation = observation_type.model_validate(
                {
                    "evidence_kind": outcome.evidence_kind,
                    "target_ref": outcome.target_ref,
                    "observed_at": outcome.observed_at,
                    "payload": outcome.payload,
                    "truncated": outcome.truncated,
                    "redacted": outcome.redacted,
                }
            )
        except ValidationError:
            raise RecoveryConsistencyError from None
        return observation, outcome.id
    await repository.record_tool_started(run.id, tool_call_id, tool_name)
    try:
        require_credential_window(
            credential, max(0.0, (deadline - now()).total_seconds()) + 60, now()
        )
        observation = await reader(run.target)
    except KubernetesBoundaryError as error:
        await repository.record_tool_failure(
            ToolFailureRecord(
                run_id=run.id,
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                error_code=error.code.value,
                retryable=error.retryable,
                occurred_at=now(),
            )
        )
        raise
    persisted = await repository.record_evidence(
        EvidenceRecord(
            run_id=run.id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            evidence_kind=observation.evidence_kind,
            target_ref=cast(
                dict[str, JsonValue],
                observation.target_ref.model_dump(mode="json", by_alias=True),
            ),
            observed_at=observation.observed_at,
            payload=cast(
                dict[str, JsonValue],
                observation.payload.model_dump(mode="json", by_alias=True),
            ),
            truncated=observation.truncated,
            redacted=observation.redacted,
        )
    )
    return observation, persisted.id
