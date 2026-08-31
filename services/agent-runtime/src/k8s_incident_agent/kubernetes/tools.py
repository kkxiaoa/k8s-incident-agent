from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from typing import Literal, cast

from langchain.tools import BaseTool, ToolRuntime, tool
from pydantic import BaseModel, ConfigDict, ValidationError

from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.domain.models import (
    EvidenceRecord,
    JsonValue,
    PersistedEvidence,
    ToolFailureRecord,
)
from k8s_incident_agent.kubernetes.contracts import (
    DeploymentTarget,
    EventsObservation,
    PodsObservation,
    WorkloadObservation,
)
from k8s_incident_agent.kubernetes.credentials import require_credential_window
from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    KubernetesErrorCode,
    validate_kubernetes_failure_contract,
)
from k8s_incident_agent.persistence.repositories import RecoveryConsistencyError

type DiagnosticObservation = WorkloadObservation | PodsObservation | EventsObservation
type ObservationReader = Callable[[DeploymentTarget], Awaitable[DiagnosticObservation]]
type EvidenceKind = Literal["workload", "pods", "events"]


class ToolFailureEnvelope(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )
    code: KubernetesErrorCode
    retryable: Literal[True]
    message: str


class FatalDiagnosticToolError(RuntimeError):
    def __init__(self, code: KubernetesErrorCode) -> None:
        self.code = code
        self.retryable = False
        super().__init__(str(KubernetesBoundaryError(code)))


@tool("get_workload")
async def _get_workload(
    runtime: ToolRuntime[DiagnosticToolContext, object],
) -> dict[str, JsonValue]:
    """Observe the target Deployment's normalized workload state."""
    return await _execute_tool(
        runtime,
        tool_name="get_workload",
        evidence_kind="workload",
        reader=runtime.context.adapter.read_workload,
    )


@tool("get_pods")
async def _get_pods(
    runtime: ToolRuntime[DiagnosticToolContext, object],
) -> dict[str, JsonValue]:
    """Observe normalized Pods associated with the target Deployment."""
    return await _execute_tool(
        runtime,
        tool_name="get_pods",
        evidence_kind="pods",
        reader=runtime.context.adapter.read_pods,
    )


@tool("get_events")
async def _get_events(
    runtime: ToolRuntime[DiagnosticToolContext, object],
) -> dict[str, JsonValue]:
    """Observe normalized Events associated with the target Deployment."""
    return await _execute_tool(
        runtime,
        tool_name="get_events",
        evidence_kind="events",
        reader=runtime.context.adapter.read_events,
    )


def build_diagnostic_tools() -> tuple[BaseTool, BaseTool, BaseTool]:
    return _get_workload, _get_pods, _get_events


async def _execute_tool(
    runtime: ToolRuntime[DiagnosticToolContext, object],
    *,
    tool_name: str,
    evidence_kind: EvidenceKind,
    reader: ObservationReader,
) -> dict[str, JsonValue]:
    context = runtime.context
    tool_call_id = runtime.tool_call_id
    if tool_call_id is None or not tool_call_id:
        raise FatalDiagnosticToolError(KubernetesErrorCode.RECOVERY_CONSISTENCY_ERROR)

    try:
        outcome = await context.repository.get_tool_outcome(
            context.run.id,
            tool_call_id,
            tool_name,
        )
    except RecoveryConsistencyError:
        raise FatalDiagnosticToolError(
            KubernetesErrorCode.RECOVERY_CONSISTENCY_ERROR
        ) from None
    if isinstance(outcome, PersistedEvidence):
        return _success_output(outcome, evidence_kind)
    if isinstance(outcome, ToolFailureRecord):
        return _replay_failure(outcome)

    try:
        await context.repository.record_tool_started(
            context.run.id,
            tool_call_id,
            tool_name,
        )
    except RecoveryConsistencyError:
        raise FatalDiagnosticToolError(
            KubernetesErrorCode.RECOVERY_CONSISTENCY_ERROR
        ) from None

    boundary_now = context.now()
    required_ttl_seconds = _required_credential_ttl(context, boundary_now)
    try:
        require_credential_window(
            context.credential,
            required_ttl_seconds,
            boundary_now,
        )
    except KubernetesBoundaryError as error:
        return await _record_failure(
            context,
            tool_call_id,
            tool_name,
            error,
            occurred_at=boundary_now,
        )

    try:
        observation = await reader(context.target)
    except KubernetesBoundaryError as error:
        return await _record_failure(
            context,
            tool_call_id,
            tool_name,
            error,
            occurred_at=context.now(),
        )
    try:
        persisted = await context.repository.record_evidence(
            _evidence_record(context, tool_call_id, tool_name, observation)
        )
    except RecoveryConsistencyError:
        raise FatalDiagnosticToolError(
            KubernetesErrorCode.RECOVERY_CONSISTENCY_ERROR
        ) from None
    return _success_output(persisted, evidence_kind)


def _required_credential_ttl(
    context: DiagnosticToolContext,
    now: datetime,
) -> float:
    deadline = context.run.started_at + timedelta(seconds=context.run.timeout_seconds)
    return max(0.0, (deadline - now).total_seconds()) + 60


def _evidence_record(
    context: DiagnosticToolContext,
    tool_call_id: str,
    tool_name: str,
    observation: DiagnosticObservation,
) -> EvidenceRecord:
    target_ref = cast(
        dict[str, JsonValue],
        observation.target_ref.model_dump(mode="json", by_alias=True),
    )
    payload = cast(
        dict[str, JsonValue],
        observation.payload.model_dump(mode="json", by_alias=True),
    )
    return EvidenceRecord(
        run_id=context.run.id,
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        evidence_kind=observation.evidence_kind,
        target_ref=target_ref,
        observed_at=observation.observed_at,
        payload=payload,
        truncated=observation.truncated,
        redacted=observation.redacted,
    )


async def _record_failure(
    context: DiagnosticToolContext,
    tool_call_id: str,
    tool_name: str,
    error: KubernetesBoundaryError,
    *,
    occurred_at: datetime,
) -> dict[str, JsonValue]:
    try:
        await context.repository.record_tool_failure(
            ToolFailureRecord(
                run_id=context.run.id,
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                error_code=error.code.value,
                retryable=error.retryable,
                occurred_at=occurred_at,
            )
        )
    except RecoveryConsistencyError:
        raise FatalDiagnosticToolError(
            KubernetesErrorCode.RECOVERY_CONSISTENCY_ERROR
        ) from None
    return _failure_output(error.code, error.retryable)


def _replay_failure(failure: ToolFailureRecord) -> dict[str, JsonValue]:
    try:
        code = validate_kubernetes_failure_contract(
            failure.error_code,
            retryable=failure.retryable,
        )
    except ValueError:
        raise FatalDiagnosticToolError(
            KubernetesErrorCode.RECOVERY_CONSISTENCY_ERROR
        ) from None
    return _failure_output(code, failure.retryable)


def _failure_output(
    code: KubernetesErrorCode,
    retryable: bool,
) -> dict[str, JsonValue]:
    if not retryable:
        raise FatalDiagnosticToolError(code)
    envelope = ToolFailureEnvelope(
        code=code,
        retryable=True,
        message=str(KubernetesBoundaryError(code)),
    )
    return cast(
        dict[str, JsonValue],
        envelope.model_dump(mode="json", by_alias=True),
    )


def _success_output(
    evidence: PersistedEvidence,
    evidence_kind: EvidenceKind,
) -> dict[str, JsonValue]:
    document: dict[str, object] = {
        "evidenceKind": evidence.evidence_kind,
        "targetRef": evidence.target_ref,
        "observedAt": evidence.observed_at,
        "payload": evidence.payload,
        "truncated": evidence.truncated,
        "redacted": evidence.redacted,
    }
    try:
        if evidence_kind == "workload":
            observation = WorkloadObservation.model_validate(document)
        elif evidence_kind == "pods":
            observation = PodsObservation.model_validate(document)
        else:
            observation = EventsObservation.model_validate(document)
    except ValidationError:
        raise FatalDiagnosticToolError(
            KubernetesErrorCode.RECOVERY_CONSISTENCY_ERROR
        ) from None
    output = cast(
        dict[str, JsonValue],
        observation.model_dump(mode="json", by_alias=True),
    )
    return {"evidenceId": str(evidence.id), **output}
