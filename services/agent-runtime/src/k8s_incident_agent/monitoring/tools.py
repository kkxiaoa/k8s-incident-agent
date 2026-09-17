from __future__ import annotations

from typing import Annotated, Literal, cast

from langchain.tools import BaseTool, ToolRuntime, tool
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.diagnosis.tool_execution import (
    PROMETHEUS_TOOL_NAME,
    DiagnosticToolFatalError,
    observation_limit_output,
)
from k8s_incident_agent.domain.models import (
    EvidenceRecord,
    JsonValue,
    PersistedEvidence,
    ToolFailureRecord,
)
from k8s_incident_agent.monitoring.contracts import (
    MetricPanelPayload,
    MetricTargetRef,
    MetricTimeAnchor,
    MetricWindow,
    PrometheusObservation,
)
from k8s_incident_agent.monitoring.errors import (
    MonitoringBoundaryError,
    MonitoringErrorCode,
    validate_monitoring_failure_contract,
)
from k8s_incident_agent.monitoring.service import resolve_metric_range
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.persistence.repositories import (
    ObservationLimitExceededError,
    RecoveryConsistencyError,
)


class MonitoringToolFailureEnvelope(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )
    code: MonitoringErrorCode
    retryable: Literal[True]
    message: str


class FatalPrometheusToolError(DiagnosticToolFatalError):
    def __init__(self, code: MonitoringErrorCode) -> None:
        super().__init__(code, str(MonitoringBoundaryError(code)))


@tool(PROMETHEUS_TOOL_NAME)
async def _query_prometheus(
    panel_id: Annotated[str, Field(min_length=1, max_length=128)],
    window: MetricWindow,
    runtime: ToolRuntime[DiagnosticToolContext, object],
    anchor: Literal["current", "occurrence"] = "current",
) -> dict[str, JsonValue]:
    """Read one fixed catalog metric panel for the current Incident target.

    anchor=current ends the window now; anchor=occurrence centres it on the
    Incident onset given in the incident document.
    """
    context = runtime.context
    tool_call_id = runtime.tool_call_id
    if tool_call_id is None or not tool_call_id:
        raise _recovery_error()
    prometheus = context.prometheus
    time_anchor = MetricTimeAnchor(anchor)
    call_identity: dict[str, JsonValue] = {
        "panelId": panel_id,
        "window": window.value,
        "anchor": time_anchor.value,
    }

    try:
        outcome = await context.repository.get_tool_outcome(
            context.run.id,
            tool_call_id,
            PROMETHEUS_TOOL_NAME,
            call_identity,
        )
    except RecoveryConsistencyError:
        raise _recovery_error() from None
    if isinstance(outcome, PersistedEvidence):
        return _success_output(
            outcome, panel_id=panel_id, window=window, anchor=time_anchor
        )
    if isinstance(outcome, ToolFailureRecord):
        return _replay_failure(outcome)

    try:
        await context.repository.record_tool_started(
            context.run.id,
            tool_call_id,
            PROMETHEUS_TOOL_NAME,
            call_identity,
        )
    except ObservationLimitExceededError:
        return observation_limit_output(PROMETHEUS_TOOL_NAME)
    except RecoveryConsistencyError:
        raise _recovery_error() from None

    queried_at = context.now()
    try:
        observation = await prometheus.observe_panel(
            target=context.target,
            panel_id=panel_id,
            window=window,
            metric_range=resolve_metric_range(
                window,
                time_anchor,
                queried_at=queried_at,
                occurred_at=context.occurred_at,
            ),
            queried_at=queried_at,
        )
    except MonitoringBoundaryError as error:
        return await _record_failure(
            context,
            tool_call_id,
            error,
        )
    try:
        persisted = await context.repository.record_evidence(
            _evidence_record(context, tool_call_id, observation)
        )
    except RecoveryConsistencyError:
        raise _recovery_error() from None
    return _success_output(
        persisted, panel_id=panel_id, window=window, anchor=time_anchor
    )


def build_prometheus_tool() -> BaseTool:
    return _query_prometheus


def _evidence_record(
    context: DiagnosticToolContext,
    tool_call_id: str,
    observation: PrometheusObservation,
) -> EvidenceRecord:
    return EvidenceRecord(
        run_id=context.run.id,
        tool_call_id=tool_call_id,
        tool_name=PROMETHEUS_TOOL_NAME,
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


async def _record_failure(
    context: DiagnosticToolContext,
    tool_call_id: str,
    error: MonitoringBoundaryError,
) -> dict[str, JsonValue]:
    try:
        await context.repository.record_tool_failure(
            ToolFailureRecord(
                run_id=context.run.id,
                tool_call_id=tool_call_id,
                tool_name=PROMETHEUS_TOOL_NAME,
                error_code=error.code.value,
                retryable=error.retryable,
                occurred_at=context.now(),
            )
        )
    except RecoveryConsistencyError:
        raise _recovery_error() from None
    return _failure_output(error.code, error.retryable)


def _replay_failure(failure: ToolFailureRecord) -> dict[str, JsonValue]:
    try:
        code = validate_monitoring_failure_contract(
            failure.error_code,
            retryable=failure.retryable,
        )
    except ValueError:
        raise _recovery_error() from None
    return _failure_output(code, failure.retryable)


def _failure_output(
    code: MonitoringErrorCode,
    retryable: bool,
) -> dict[str, JsonValue]:
    if not retryable:
        raise FatalPrometheusToolError(code)
    envelope = MonitoringToolFailureEnvelope(
        code=code,
        retryable=True,
        message=str(MonitoringBoundaryError(code)),
    )
    return cast(
        dict[str, JsonValue],
        envelope.model_dump(mode="json", by_alias=True),
    )


def _success_output(
    evidence: PersistedEvidence,
    *,
    panel_id: str,
    window: MetricWindow,
    anchor: MetricTimeAnchor,
) -> dict[str, JsonValue]:
    try:
        observation = PrometheusObservation(
            evidence_kind=cast(Literal["metrics"], evidence.evidence_kind),
            target_ref=MetricTargetRef.model_validate(evidence.target_ref),
            observed_at=evidence.observed_at,
            payload=MetricPanelPayload.model_validate_json(
                canonical_json(evidence.payload)
            ),
            truncated=cast(Literal[False], evidence.truncated),
            redacted=cast(Literal[False], evidence.redacted),
        )
    except (ValidationError, ValueError):
        raise _recovery_error() from None
    result = observation.payload.result
    if (
        result.panel_id != panel_id
        or result.window is not window
        or result.anchor is not anchor
    ):
        raise _recovery_error()
    output = cast(
        dict[str, JsonValue],
        observation.model_dump(mode="json", by_alias=True),
    )
    return {"evidenceId": str(evidence.id), **output}


def _recovery_error() -> DiagnosticToolFatalError:
    return DiagnosticToolFatalError(
        "recovery_consistency_error",
        "Persisted tool state is inconsistent",
    )
