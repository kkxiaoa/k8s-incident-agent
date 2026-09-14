from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import datetime
from uuid import UUID

from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.contracts import RecoveryLogs
from k8s_incident_agent.kubernetes.credentials import (
    DiagnosticCredentialLease,
    require_credential_window,
)
from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    KubernetesErrorCode,
)
from k8s_incident_agent.monitoring.errors import (
    MonitoringBoundaryError,
    MonitoringErrorCode,
)
from k8s_incident_agent.monitoring.service import PrometheusQueryService
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    RepairVerificationContext,
)
from k8s_incident_agent.repair.verification_contracts import (
    MAX_OBSERVATION_BYTES,
    MAX_VERIFICATION_SAMPLES,
    SAMPLE_INTERVAL_SECONDS,
    VerificationObservation,
)
from k8s_incident_agent.repair.verification_policy import (
    advance_verification,
    finish_verification_timeout,
    workload_ready,
)


async def verify_recovery(
    run_id: UUID,
    *,
    repository: IncidentRepository,
    adapter: KubernetesEvidenceAdapter,
    prometheus: PrometheusQueryService,
    credential: DiagnosticCredentialLease,
    now: Callable[[], datetime],
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> None:
    while (context := await repository.get_verification_context(run_id)) is not None:
        record = context.record
        at = now()
        remaining = (record.deadline_at - at).total_seconds()
        if remaining <= 0:
            await repository.persist_verification(
                run_id, record, finish_verification_timeout(record, at), None
            )
            return
        if record.sample_count >= MAX_VERIFICATION_SAMPLES:
            await sleep(remaining)
            continue
        if record.last_observed_at is not None:
            delay = (
                SAMPLE_INTERVAL_SECONDS - (at - record.last_observed_at).total_seconds()
            )
            if delay > 0:
                await sleep(min(delay, remaining))
                continue
        observation, workload_is_ready = await _observe(
            context,
            adapter,
            prometheus,
            credential,
            at,
            min(SAMPLE_INTERVAL_SECONDS, remaining),
        )
        updated = advance_verification(
            record,
            observation,
            context.previous,
            context.proposal,
            context.receipt,
            now(),
            workload_is_ready=workload_is_ready,
        )
        if updated.outcome != "observing" and observation.workload is not None:
            pod_count = len(observation.workload.pods)
            try:
                async with asyncio.timeout(
                    min(2, max(0, (record.deadline_at - now()).total_seconds()))
                ):
                    logs = await adapter.read_recovery_logs(
                        context.proposal.target,
                        context.proposal.container_name,
                        observation.workload,
                        record.started_at,
                    )
            except TimeoutError:
                logs = RecoveryLogs(
                    containers=[],
                    not_sampled_pods=len(observation.workload.pods),
                    error=KubernetesErrorCode.REQUEST_TIMEOUT,
                    redacted=False,
                    truncated=False,
                )
            observation = observation.model_copy(update={"logs": logs})
            if (
                len(observation.model_dump_json(by_alias=True).encode())
                > MAX_OBSERVATION_BYTES
            ):
                observation = observation.model_copy(
                    update={
                        "logs": RecoveryLogs(
                            containers=[],
                            not_sampled_pods=pod_count,
                            error=KubernetesErrorCode.RESULT_BUDGET_EXCEEDED,
                            redacted=False,
                            truncated=False,
                        )
                    }
                )
        await repository.persist_verification(run_id, record, updated, observation)
        if updated.outcome != "observing":
            return


async def _observe(
    context: RepairVerificationContext,
    adapter: KubernetesEvidenceAdapter,
    prometheus: PrometheusQueryService,
    credential: DiagnosticCredentialLease,
    at: datetime,
    timeout: float,
) -> tuple[VerificationObservation, bool]:
    workload = None
    ready = False
    monitoring = None
    kubernetes_error = None
    monitoring_error = None
    try:
        async with asyncio.timeout(timeout):
            require_credential_window(credential, now=at, required_seconds=timeout)
            workload = await adapter.read_recovery_workload(
                context.proposal.target, context.proposal.container_name
            )
            ready = workload_ready(workload, context.proposal, context.receipt)
            if ready:
                monitoring = await prometheus.observe_recovery(
                    target=context.proposal.target,
                    container_name=context.proposal.container_name,
                    pod_uids=tuple(pod.uid for pod in workload.pods),
                    applied_at=context.record.started_at,
                )
    except KubernetesBoundaryError as error:
        kubernetes_error = error.code
    except MonitoringBoundaryError as error:
        monitoring_error = error.code
    except TimeoutError:
        if workload is None:
            kubernetes_error = KubernetesErrorCode.REQUEST_TIMEOUT
        else:
            monitoring_error = MonitoringErrorCode.REQUEST_TIMEOUT
    observation = VerificationObservation(
        observed_at=at,
        workload=workload,
        monitoring=monitoring,
        watchdog_received_at=context.watchdog_received_at,
        occurrence_resolved=context.occurrence_resolved,
        kubernetes_error=kubernetes_error,
        monitoring_error=monitoring_error,
    )
    if len(observation.model_dump_json(by_alias=True).encode()) > MAX_OBSERVATION_BYTES:
        return (
            VerificationObservation(
                observed_at=at,
                workload=None,
                monitoring=None,
                watchdog_received_at=context.watchdog_received_at,
                occurrence_resolved=context.occurrence_resolved,
                kubernetes_error=KubernetesErrorCode.RESULT_BUDGET_EXCEEDED,
            ),
            False,
        )
    return observation, ready
