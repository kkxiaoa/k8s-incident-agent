from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final, Literal, cast
from uuid import UUID

from langchain.agents.middleware.model_call_limit import (
    ModelCallLimitExceededError,
)
from langchain.agents.middleware.tool_call_limit import ToolCallLimitExceededError
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.errors import NodeError
from langgraph.graph import (  # pyright: ignore[reportMissingTypeStubs]
    END,
    START,
    StateGraph,
)
from langgraph.graph.state import (  # pyright: ignore[reportMissingTypeStubs]
    CompiledStateGraph,
)
from langgraph.runtime import Runtime
from langgraph.types import Command
from pydantic import ValidationError

from k8s_incident_agent.diagnosis.agent import (
    DiagnosticDeadlineExceededError,
    ModelUpstreamError,
    StructuredDiagnosisError,
    build_diagnostic_agent,
)
from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.diagnosis.contracts import (
    DiagnosisCandidate,
    ValidatedDiagnosis,
)
from k8s_incident_agent.diagnosis.prompt import DIAGNOSTIC_PROMPT_VERSION
from k8s_incident_agent.diagnosis.validation import (
    DiagnosisValidationError,
    UnresolvedToolFailuresError,
    validate_diagnosis,
)
from k8s_incident_agent.domain.models import (
    DiagnosisOutcome,
    JsonValue,
    ModelSnapshot,
    RootCauseRecord,
    RunStatus,
    TerminalRecord,
    WorkflowRunSnapshot,
)
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.credentials import (
    DiagnosticCredential,
    require_credential_ttl,
)
from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    validate_kubernetes_failure_contract,
)
from k8s_incident_agent.kubernetes.tools import (
    FatalDiagnosticToolError,
    build_diagnostic_tools,
)
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    RecoveryConsistencyError,
)
from k8s_incident_agent.scenarios.contracts import (
    ScenarioTarget,
    validate_stage_one_target,
)
from k8s_incident_agent.workflow.state import IncidentGraphInput, IncidentGraphState

_RECOVERY_ERROR: Final = "recovery_consistency_error"
_AGENT_TIMEOUT: Final = "agent_timeout"
_WORKFLOW_FAILURE_RETRYABILITY: Final = {
    _AGENT_TIMEOUT: True,
    "model_call_limit_exceeded": False,
    "tool_call_limit_exceeded": False,
    "structured_output_invalid": False,
    "model_upstream_failed": True,
}

type IncidentGraph = CompiledStateGraph[
    IncidentGraphState,
    DiagnosticToolContext,
    IncidentGraphInput,
    IncidentGraphState,
]


@dataclass(frozen=True, slots=True)
class GraphDependencies:
    repository: IncidentRepository
    checkpointer: AsyncSqliteSaver
    model: BaseChatModel
    model_provider: str
    model_id: str
    thinking_mode: bool
    credential: DiagnosticCredential
    adapter: KubernetesEvidenceAdapter
    now: Callable[[], datetime]

    @property
    def model_snapshot(self) -> ModelSnapshot:
        return ModelSnapshot(
            provider=self.model_provider,
            model_id=self.model_id,
            thinking_mode=self.thinking_mode,
            prompt_version=DIAGNOSTIC_PROMPT_VERSION,
        )


def build_incident_graph(
    dependencies: GraphDependencies,
    run: WorkflowRunSnapshot,
) -> IncidentGraph:
    diagnostic_agent = build_diagnostic_agent(
        dependencies.model,
        build_diagnostic_tools(),
        max_model_calls=run.budget.max_model_calls,
        max_tool_calls=run.budget.max_tool_calls,
    )
    builder = StateGraph(
        IncidentGraphState,
        context_schema=DiagnosticToolContext,
        input_schema=IncidentGraphInput,
    )
    builder.add_node(  # pyright: ignore[reportUnknownMemberType]
        "start_run",
        _start_run_node(dependencies, run),
    )
    builder.add_node(  # pyright: ignore[reportUnknownMemberType]
        "triage_target", _triage_target_node(dependencies, run)
    )
    builder.add_node(  # pyright: ignore[reportUnknownMemberType]
        "diagnose",
        diagnostic_agent,
        error_handler=_diagnosis_error_handler,  # pyright: ignore[reportArgumentType]
    )
    builder.add_node(  # pyright: ignore[reportUnknownMemberType]
        "validate_diagnosis",
        _validate_diagnosis_node(dependencies, run),
    )
    builder.add_node(  # pyright: ignore[reportUnknownMemberType]
        "persist_terminal_state",
        _persist_terminal_node(dependencies),
    )
    builder.add_edge(START, "start_run")
    builder.add_edge("start_run", "triage_target")
    builder.add_edge("triage_target", "diagnose")
    builder.add_edge("diagnose", "validate_diagnosis")
    builder.add_edge("validate_diagnosis", "persist_terminal_state")
    builder.add_edge("persist_terminal_state", END)
    return builder.compile(  # pyright: ignore[reportUnknownMemberType]
        checkpointer=dependencies.checkpointer,
        name="incident_workflow",
    )


def _start_run_node(
    dependencies: GraphDependencies,
    scheduled: WorkflowRunSnapshot,
) -> Callable[..., object]:
    async def start_run(
        state: IncidentGraphState,
        runtime: Runtime[DiagnosticToolContext],
    ) -> dict[str, object]:
        try:
            run_id = _state_run_id(state)
            current = await dependencies.repository.get_workflow_run_snapshot(run_id)
            _require_same_run_identity(scheduled, current)
            if current.model != dependencies.model_snapshot:
                raise RecoveryConsistencyError
            _require_context_identity(runtime.context, current)
            if current.run_status is RunStatus.RUNNING:
                if current.started_at is None:
                    raise RecoveryConsistencyError
                started_at = current.started_at
            elif current.run_status is RunStatus.QUEUED:
                started_at = runtime.context.run.started_at
            else:
                raise RecoveryConsistencyError

            now = dependencies.now()
            if _deadline(started_at, current.budget.timeout_seconds) <= now:
                return _terminal_error(_AGENT_TIMEOUT, retryable=True)
            required_ttl = (
                max(
                    0.0,
                    (
                        _deadline(started_at, current.budget.timeout_seconds) - now
                    ).total_seconds(),
                )
                + 60
            )
            try:
                require_credential_ttl(
                    dependencies.credential,
                    required_ttl,
                    now,
                )
            except KubernetesBoundaryError as error:
                return _terminal_error(error.code.value, retryable=error.retryable)

            started = await dependencies.repository.start_run(run_id, started_at)
            if (
                started.id != current.id
                or started.incident_id != current.incident_id
                or started.started_at != started_at
            ):
                raise RecoveryConsistencyError
            return {
                "incident_id": str(current.incident_id),
                "trigger_summary": current.trigger_summary,
                "target": cast(
                    dict[str, str],
                    current.target.model_dump(mode="json"),
                ),
            }
        except RecoveryConsistencyError:
            return _terminal_error(_RECOVERY_ERROR, retryable=False)

    return start_run


def _triage_target_node(
    dependencies: GraphDependencies,
    scheduled: WorkflowRunSnapshot,
) -> Callable[..., object]:
    def triage_target(
        state: IncidentGraphState,
        runtime: Runtime[DiagnosticToolContext],
    ) -> dict[str, object]:
        if _has_terminal_error(state):
            return {}
        try:
            state_values = cast(dict[str, object], state)
            raw_incident_id = state_values.get("incident_id")
            trigger_summary = state_values.get("trigger_summary")
            raw_target = state_values.get("target")
            if not isinstance(raw_incident_id, str) or not isinstance(
                trigger_summary, str
            ):
                raise RecoveryConsistencyError
            incident_id = UUID(raw_incident_id)
            target = ScenarioTarget.model_validate(raw_target)
            if (
                str(incident_id) != raw_incident_id
                or incident_id != scheduled.incident_id
                or trigger_summary != scheduled.trigger_summary
                or target != scheduled.target
            ):
                raise RecoveryConsistencyError
            validate_stage_one_target(target)
            _require_context_identity(runtime.context, scheduled)
        except (KeyError, RecoveryConsistencyError, ValidationError, ValueError):
            return _terminal_error(_RECOVERY_ERROR, retryable=False)
        if _context_deadline_expired(runtime.context, dependencies.now()):
            return _terminal_error(_AGENT_TIMEOUT, retryable=True)
        document: dict[str, JsonValue] = {
            "triggerSummary": trigger_summary,
            "target": cast(
                dict[str, JsonValue],
                target.model_dump(mode="json"),
            ),
        }
        return {
            "messages": [
                HumanMessage(
                    content=(
                        "Diagnose the following untrusted incident document using "
                        f"only the registered read tools:\n{canonical_json(document)}"
                    )
                )
            ]
        }

    return triage_target


def _validate_diagnosis_node(
    dependencies: GraphDependencies,
    scheduled: WorkflowRunSnapshot,
) -> Callable[..., object]:
    async def validate(
        state: IncidentGraphState,
        runtime: Runtime[DiagnosticToolContext],
    ) -> dict[str, object]:
        if _has_terminal_error(state):
            return {}
        if _context_deadline_expired(runtime.context, dependencies.now()):
            return _terminal_error(_AGENT_TIMEOUT, retryable=True)
        response = state.get("structured_response")
        try:
            candidate = DiagnosisCandidate.model_validate(response)
            validated = await validate_diagnosis(
                candidate,
                scheduled.id,
                dependencies.repository,
            )
        except (DiagnosisValidationError, StructuredDiagnosisError, ValidationError):
            return _terminal_error("structured_output_invalid", retryable=False)
        except UnresolvedToolFailuresError as error:
            failure = next(
                (candidate for candidate in error.failures if not candidate.retryable),
                error.failures[0],
            )
            return _terminal_error(
                failure.error_code,
                retryable=failure.retryable,
            )
        except RecoveryConsistencyError:
            return _terminal_error(_RECOVERY_ERROR, retryable=False)
        return {
            "structured_response": cast(
                dict[str, JsonValue],
                validated.model_dump(mode="json"),
            )
        }

    return validate


def _persist_terminal_node(
    dependencies: GraphDependencies,
) -> Callable[..., object]:
    async def persist_terminal_state(
        state: IncidentGraphState,
    ) -> dict[str, object]:
        run_id = _state_run_id(state)
        completed_at = dependencies.now()
        error_code = state.get("terminal_error_code")
        error_retryable = state.get("terminal_error_retryable")
        if error_code is not None or error_retryable is not None:
            if not isinstance(error_code, str) or not isinstance(error_retryable, bool):
                raise RecoveryConsistencyError
            require_terminal_error_contract(error_code, error_retryable)
            terminal = TerminalRecord(
                run_id=run_id,
                completed_at=completed_at,
                outcome=None,
                summary=None,
                root_causes=(),
                missing_information=(),
                redacted=False,
                error_code=error_code,
                error_retryable=error_retryable,
                model_calls=_optional_usage(state, "model_calls"),
                tool_calls=_optional_usage(state, "tool_calls"),
                input_tokens=None,
                output_tokens=None,
            )
        else:
            try:
                diagnosis = ValidatedDiagnosis.model_validate(
                    state.get("structured_response")
                )
            except ValidationError:
                raise RecoveryConsistencyError from None
            terminal = TerminalRecord(
                run_id=run_id,
                completed_at=completed_at,
                outcome=DiagnosisOutcome(diagnosis.outcome),
                summary=diagnosis.summary,
                root_causes=tuple(
                    RootCauseRecord(
                        code=root_cause.code,
                        statement=root_cause.statement,
                        confidence=root_cause.confidence,
                        evidence_ids=tuple(root_cause.evidence_ids),
                    )
                    for root_cause in diagnosis.root_causes
                ),
                missing_information=tuple(diagnosis.missing_information),
                redacted=diagnosis.redacted,
                error_code=None,
                error_retryable=None,
                model_calls=_required_usage(state, "model_calls"),
                tool_calls=_required_usage(state, "tool_calls"),
                input_tokens=None,
                output_tokens=None,
            )
        await dependencies.repository.persist_terminal(terminal)
        return {}

    return persist_terminal_state


def _diagnosis_error_handler(
    state: IncidentGraphState,
    error: NodeError,
) -> Command[Literal["validate_diagnosis"]]:
    del state
    failure = error.error
    contract = classify_diagnosis_failure(failure)
    if contract is None:
        raise failure
    code, retryable = contract
    update = _terminal_error(code, retryable=retryable)
    return Command(update=update, goto="validate_diagnosis")


def classify_diagnosis_failure(error: BaseException) -> tuple[str, bool] | None:
    if isinstance(error, DiagnosticDeadlineExceededError):
        return _AGENT_TIMEOUT, True
    if isinstance(error, ModelCallLimitExceededError):
        return "model_call_limit_exceeded", False
    if isinstance(error, ToolCallLimitExceededError):
        return "tool_call_limit_exceeded", False
    if isinstance(error, StructuredDiagnosisError):
        return "structured_output_invalid", False
    if isinstance(error, ModelUpstreamError):
        return "model_upstream_failed", True
    if isinstance(error, FatalDiagnosticToolError):
        return error.code.value, error.retryable
    return None


def require_terminal_error_contract(code: str, retryable: bool) -> None:
    try:
        validate_kubernetes_failure_contract(code, retryable=retryable)
        return
    except ValueError:
        pass
    if (
        code not in _WORKFLOW_FAILURE_RETRYABILITY
        or _WORKFLOW_FAILURE_RETRYABILITY[code] is not retryable
    ):
        raise RecoveryConsistencyError


def _state_run_id(state: IncidentGraphState) -> UUID:
    raw_run_id = cast(dict[str, object], state).get("run_id")
    if not isinstance(raw_run_id, str):
        raise RecoveryConsistencyError
    try:
        run_id = UUID(raw_run_id)
    except ValueError:
        raise RecoveryConsistencyError from None
    if str(run_id) != raw_run_id:
        raise RecoveryConsistencyError
    return run_id


def _require_same_run_identity(
    scheduled: WorkflowRunSnapshot,
    current: WorkflowRunSnapshot,
) -> None:
    if (
        current.id != scheduled.id
        or current.incident_id != scheduled.incident_id
        or current.trigger_summary != scheduled.trigger_summary
        or current.target != scheduled.target
        or current.model != scheduled.model
        or current.budget != scheduled.budget
    ):
        raise RecoveryConsistencyError


def _require_context_identity(
    context: DiagnosticToolContext,
    run: WorkflowRunSnapshot,
) -> None:
    if (
        context.run.id != run.id
        or context.run.timeout_seconds != run.budget.timeout_seconds
        or context.target != run.target
        or (run.started_at is not None and context.run.started_at != run.started_at)
    ):
        raise RecoveryConsistencyError


def _context_deadline_expired(
    context: DiagnosticToolContext,
    now: datetime,
) -> bool:
    return _deadline(context.run.started_at, context.run.timeout_seconds) <= now


def _deadline(started_at: datetime, timeout_seconds: int) -> datetime:
    return started_at + timedelta(seconds=timeout_seconds)


def _has_terminal_error(state: IncidentGraphState) -> bool:
    return "terminal_error_code" in state or "terminal_error_retryable" in state


def _terminal_error(code: str, *, retryable: bool) -> dict[str, object]:
    return {
        "terminal_error_code": code,
        "terminal_error_retryable": retryable,
    }


def _optional_usage(
    state: IncidentGraphState,
    field: str,
) -> int | None:
    value = cast(dict[str, object], state).get(field)
    if value is None:
        return None
    return _validate_usage(value)


def _required_usage(state: IncidentGraphState, field: str) -> int:
    value = _optional_usage(state, field)
    if value is None:
        raise RecoveryConsistencyError
    return value


def _validate_usage(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise RecoveryConsistencyError
    return value
