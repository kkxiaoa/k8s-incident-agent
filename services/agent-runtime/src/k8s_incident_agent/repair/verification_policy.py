from __future__ import annotations

from datetime import datetime, timedelta
from typing import cast

from k8s_incident_agent.execution.contracts import ExecutionReceipt
from k8s_incident_agent.kubernetes.contracts import RecoveryWorkload
from k8s_incident_agent.monitoring.contracts import WATCHDOG_STALE_AFTER
from k8s_incident_agent.repair.contracts import RepairProposal
from k8s_incident_agent.repair.verification_contracts import (
    HEALTHY_WINDOW_SECONDS,
    MAX_VERIFICATION_SAMPLES,
    SAMPLE_INTERVAL_SECONDS,
    VerificationObservation,
    VerificationOutcome,
    VerificationReason,
    VerificationRecord,
)


def workload_ready(
    workload: RecoveryWorkload, proposal: RepairProposal, receipt: ExecutionReceipt
) -> bool:
    return (
        workload.target_ref.uid == receipt.uid
        and workload.generation == receipt.generation
        and workload.observed_generation == receipt.generation
        and workload.image == proposal.replacement_image
        and not workload.terminating
        and not workload.rollout_failed
        and workload.desired > 0
        and workload.updated
        == workload.available
        == workload.replicas
        == workload.desired
        and workload.old_replicas == workload.old_pods == 0
        and workload.current_replica_set is not None
        and len(workload.pods) == workload.desired
        and len({pod.uid for pod in workload.pods}) == len(workload.pods)
        and all(
            pod.ready
            and not pod.terminating
            and pod.container_state == "running"
            and pod.image == proposal.replacement_image
            and pod.restart_count is not None
            for pod in workload.pods
        )
    )


def advance_verification(
    record: VerificationRecord,
    observation: VerificationObservation,
    previous: VerificationObservation | None,
    proposal: RepairProposal,
    receipt: ExecutionReceipt,
    completed_at: datetime,
    *,
    workload_is_ready: bool,
) -> VerificationRecord:
    if record.outcome != "observing" or record.sample_count >= MAX_VERIFICATION_SAMPLES:
        raise ValueError("Verification cannot accept more observations")
    at = observation.observed_at
    if not record.started_at <= at < record.deadline_at or (
        record.last_observed_at is not None
        and at < record.last_observed_at + timedelta(seconds=SAMPLE_INTERVAL_SECONDS)
    ):
        raise ValueError("Verification observation time is inconsistent")
    reason: VerificationReason | None = None
    outcome: VerificationOutcome = "observing"
    workload = observation.workload
    if workload is None:
        reason = "sample_missing"
    elif (
        workload.target_ref.uid != receipt.uid
        or workload.image != proposal.replacement_image
        or (
            workload.generation is not None
            and workload.generation != receipt.generation
        )
        or workload.terminating
    ):
        outcome, reason = "target_drift", "target_drift"
    elif workload.desired == 0 or (
        workload.observed_generation == receipt.generation and workload.rollout_failed
    ):
        outcome, reason = "workload_failed", "workload_unhealthy"
    elif not workload_is_ready:
        reason = "rollout_pending"
    else:
        monitoring = observation.monitoring
        received = observation.watchdog_received_at
        if (
            monitoring is None
            or not monitoring.chain_healthy
            or received is None
            or not at - WATCHDOG_STALE_AFTER <= received <= at
        ):
            reason = "monitoring_unavailable"
        elif not monitoring.target_healthy:
            reason = "metrics_missing_or_stale"
        elif monitoring.active_alerts:
            reason = "alerts_active"
        elif observation.occurrence_resolved is False:
            reason = "occurrence_not_resolved"
    healthy_since = record.healthy_since if reason is None else None
    if reason is None:
        old_pods = (
            {pod.uid: pod.restart_count for pod in previous.workload.pods}
            if previous is not None and previous.workload is not None
            else {}
        )
        new_pods = (
            {pod.uid: pod.restart_count for pod in workload.pods} if workload else {}
        )
        gap = (
            record.last_observed_at is None
            or at - record.last_observed_at
            > timedelta(seconds=SAMPLE_INTERVAL_SECONDS + 1)
        )
        if gap or old_pods != new_pods:
            healthy_since = at
            if previous is not None and record.healthy_since is not None:
                reason = (
                    "sample_gap"
                    if gap or old_pods.keys() != new_pods.keys()
                    else "workload_unhealthy"
                )
        elif healthy_since is None:
            healthy_since = at
        if at - healthy_since >= timedelta(seconds=HEALTHY_WINDOW_SECONDS):
            outcome = "recovered"
    updated = VerificationRecord(
        **record.model_dump(
            exclude={
                "sample_count",
                "last_observed_at",
                "healthy_since",
                "outcome",
                "reason",
                "completed_at",
            }
        ),
        sample_count=record.sample_count + 1,
        last_observed_at=at,
        healthy_since=healthy_since,
        outcome=outcome,
        reason=reason,
        completed_at=completed_at if outcome != "observing" else None,
    )
    return (
        finish_verification_timeout(updated, completed_at)
        if completed_at >= record.deadline_at
        else updated
    )


def finish_verification_timeout(
    record: VerificationRecord, now: datetime
) -> VerificationRecord:
    reason = record.reason or "deadline_exceeded"
    outcome = cast(
        VerificationOutcome,
        {
            "rollout_pending": "workload_failed",
            "workload_unhealthy": "workload_failed",
            "sample_missing": "insufficient_evidence",
            "sample_gap": "insufficient_evidence",
            "metrics_missing_or_stale": "insufficient_evidence",
            "monitoring_unavailable": "monitoring_unavailable",
            "target_drift": "target_drift",
        }.get(reason, "timeout"),
    )
    return VerificationRecord(
        **record.model_dump(exclude={"completed_at", "outcome", "reason"}),
        completed_at=now,
        outcome=outcome,
        reason=reason,
    )
