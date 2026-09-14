from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
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
from langgraph.types import Command, interrupt
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
from k8s_incident_agent.diagnosis.policy import DiagnosticPolicy
from k8s_incident_agent.diagnosis.tool_execution import DiagnosticToolFatalError
from k8s_incident_agent.diagnosis.validation import (
    DiagnosisValidationError,
    UnresolvedToolFailuresError,
    validate_diagnosis,
)
from k8s_incident_agent.domain.contracts import KubernetesTarget
from k8s_incident_agent.domain.models import (
    DiagnosisOutcome,
    DiagnosisWorkflowRunSnapshot,
    JsonValue,
    ModelSnapshot,
    RepairWorkflowRunSnapshot,
    RootCauseRecord,
    RunStatus,
    TerminalRecord,
)
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.credentials import (
    DiagnosticCredentialLease,
    require_credential_window,
)
from k8s_incident_agent.kubernetes.errors import KubernetesBoundaryError
from k8s_incident_agent.kubernetes.tools import (
    build_diagnostic_tools,
)
from k8s_incident_agent.model.availability import DiagnosisUnavailableError
from k8s_incident_agent.monitoring.service import PrometheusQueryService
from k8s_incident_agent.monitoring.tools import build_prometheus_tool
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    RecoveryConsistencyError,
)
from k8s_incident_agent.repair.client import PatchValidator
from k8s_incident_agent.repair.compiler import (
    RepairPreparationError,
    compile_repair_proposal,
    require_exact_repair_proposal,
    resolve_evidence_bound_change,
)
from k8s_incident_agent.repair.contracts import (
    EvidenceBoundImageChange,
    PatchValidationResponse,
    RepairProposal,
)
from k8s_incident_agent.repair.preparation import prepare_repair
from k8s_incident_agent.repair.records import RepairTerminalRecord
from k8s_incident_agent.scenarios.contracts import validate_supported_target
from k8s_incident_agent.workflow.failures import require_terminal_error_contract
from k8s_incident_agent.workflow.state import IncidentGraphInput, IncidentGraphState

_RECOVERY_ERROR: Final = "recovery_consistency_error"
_AGENT_TIMEOUT: Final = "agent_timeout"

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
    model: BaseChatModel | None
    model_snapshot: ModelSnapshot
    credential: DiagnosticCredentialLease
    adapter: KubernetesEvidenceAdapter
    prometheus: PrometheusQueryService
    now: Callable[[], datetime]
    patch_validator: PatchValidator | None = None


def build_incident_graph(
    dependencies: GraphDependencies,
    run: DiagnosisWorkflowRunSnapshot | RepairWorkflowRunSnapshot,
    policy: DiagnosticPolicy | None = None,
) -> IncidentGraph:
    builder = StateGraph(
        IncidentGraphState,
        context_schema=DiagnosticToolContext,
        input_schema=IncidentGraphInput,
    )
    if isinstance(run, RepairWorkflowRunSnapshot):

        async def start_repair(state: IncidentGraphState) -> dict[str, object]:
            current = await dependencies.repository.get_workflow_run_snapshot(
                _state_run_id(state)
            )
            if (
                not isinstance(current, RepairWorkflowRunSnapshot)
                or current.id != run.id
            ):
                raise RecoveryConsistencyError
            if current.run_status is RunStatus.QUEUED:
                await dependencies.repository.start_run(current.id, dependencies.now())
            return {}

        async def prepare(state: IncidentGraphState) -> dict[str, object]:
            current = await dependencies.repository.get_workflow_run_snapshot(
                _state_run_id(state)
            )
            if not isinstance(current, RepairWorkflowRunSnapshot):
                raise RecoveryConsistencyError
            if current.run_status is RunStatus.RUNNING and current.approval is None:
                prepared = await prepare_repair(
                    current,
                    repository=dependencies.repository,
                    adapter=dependencies.adapter,
                    credential=dependencies.credential,
                    validator=dependencies.patch_validator,
                    now=dependencies.now,
                )
                await dependencies.repository.persist_prepared_repair(prepared)
                current = await dependencies.repository.get_workflow_run_snapshot(
                    current.id
                )
            if not isinstance(current, RepairWorkflowRunSnapshot):
                raise RecoveryConsistencyError
            return {
                "repair_proposal_id": str(current.proposal_id)
                if current.proposal_id
                else None
            }

        async def await_approval(state: IncidentGraphState) -> dict[str, object]:
            current = await dependencies.repository.get_workflow_run_snapshot(
                _state_run_id(state)
            )
            if not isinstance(current, RepairWorkflowRunSnapshot):
                raise RecoveryConsistencyError
            if current.run_status is not RunStatus.WAITING_APPROVAL:
                return {}
            if current.proposal_id is None or state.get("repair_proposal_id") != str(
                current.proposal_id
            ):
                raise RecoveryConsistencyError
            decision = interrupt(
                {"runId": str(current.id), "proposalId": str(current.proposal_id)}
            )
            resumed = await dependencies.repository.get_workflow_run_snapshot(
                current.id
            )
            if (
                not isinstance(resumed, RepairWorkflowRunSnapshot)
                or resumed.approval is None
                or decision != {"approvalId": str(resumed.approval.id)}
            ):
                raise RecoveryConsistencyError
            return {}

        builder.add_node("start_run", start_repair)  # pyright: ignore[reportUnknownMemberType]
        builder.add_node("prepare_repair", prepare)  # pyright: ignore[reportUnknownMemberType]
        builder.add_node("await_approval", await_approval)  # pyright: ignore[reportUnknownMemberType]
        builder.add_edge(START, "start_run")
        builder.add_edge("start_run", "prepare_repair")
        builder.add_edge("prepare_repair", "await_approval")
        builder.add_edge("await_approval", END)
        return builder.compile(  # pyright: ignore[reportUnknownMemberType]
            checkpointer=dependencies.checkpointer, name="incident_workflow"
        )
    if policy is None:
        raise ValueError("Diagnosis requires its resolved policy")
    if policy.repair_action is not None and dependencies.patch_validator is None:
        raise ValueError("Repair policy requires the Patch Validator boundary")
    registry = {
        tool.name: tool for tool in (*build_diagnostic_tools(), build_prometheus_tool())
    }
    diagnostic_agent = (
        None
        if dependencies.model is None
        else build_diagnostic_agent(
            dependencies.model,
            tuple(registry[name] for name in policy.tool_names),
            max_model_calls=run.budget.max_model_calls,
            max_tool_calls=run.budget.max_tool_calls,
            required_evidence=tuple(sorted(policy.required_evidence)),
            prometheus_panel_ids=policy.prometheus_panel_ids,
            repair_action=policy.repair_action,
        )
    )
    builder.add_node(  # pyright: ignore[reportUnknownMemberType]
        "start_run",
        _start_run_node(dependencies, run),
    )
    builder.add_node(  # pyright: ignore[reportUnknownMemberType]
        "triage_target", _triage_target_node(dependencies, run)
    )
    if diagnostic_agent is None:
        builder.add_node(  # pyright: ignore[reportUnknownMemberType]
            "diagnose",
            _unavailable_diagnosis,
            error_handler=_diagnosis_error_handler,  # pyright: ignore[reportArgumentType]
        )
    else:
        builder.add_node(  # pyright: ignore[reportUnknownMemberType]
            "diagnose",
            diagnostic_agent,
            error_handler=_diagnosis_error_handler,  # pyright: ignore[reportArgumentType]
        )
    builder.add_node(  # pyright: ignore[reportUnknownMemberType]
        "validate_diagnosis",
        _validate_diagnosis_node(dependencies, run, policy),
    )
    builder.add_node(  # pyright: ignore[reportUnknownMemberType]
        "validate_repair_schema",
        _validate_repair_schema_node(dependencies),
    )
    builder.add_node(  # pyright: ignore[reportUnknownMemberType]
        "validate_repair_policy",
        _validate_repair_policy_node(dependencies, run, policy),
    )
    builder.add_node(  # pyright: ignore[reportUnknownMemberType]
        "validate_repair_diff",
        _validate_repair_diff_node(dependencies),
    )
    builder.add_node(  # pyright: ignore[reportUnknownMemberType]
        "validate_repair_dry_run",
        _validate_repair_dry_run_node(dependencies),
    )
    builder.add_node(  # pyright: ignore[reportUnknownMemberType]
        "persist_terminal_state",
        _persist_terminal_node(dependencies),
    )
    builder.add_edge(START, "start_run")
    builder.add_edge("start_run", "triage_target")
    builder.add_edge("triage_target", "diagnose")
    builder.add_edge("diagnose", "validate_diagnosis")
    builder.add_edge("validate_diagnosis", "validate_repair_schema")
    builder.add_edge("validate_repair_schema", "validate_repair_policy")
    builder.add_edge("validate_repair_policy", "validate_repair_diff")
    builder.add_edge("validate_repair_diff", "validate_repair_dry_run")
    builder.add_edge("validate_repair_dry_run", "persist_terminal_state")
    builder.add_edge("persist_terminal_state", END)
    return builder.compile(  # pyright: ignore[reportUnknownMemberType]
        checkpointer=dependencies.checkpointer,
        name="incident_workflow",
    )


def _start_run_node(
    dependencies: GraphDependencies,
    scheduled: DiagnosisWorkflowRunSnapshot,
) -> Callable[..., object]:
    async def start_run(
        state: IncidentGraphState,
        runtime: Runtime[DiagnosticToolContext],
    ) -> dict[str, object]:
        try:
            run_id = _state_run_id(state)
            current = await dependencies.repository.get_workflow_run_snapshot(run_id)
            if not isinstance(current, DiagnosisWorkflowRunSnapshot):
                raise RecoveryConsistencyError
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
                require_credential_window(
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
    scheduled: DiagnosisWorkflowRunSnapshot,
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
            target = KubernetesTarget.model_validate(raw_target)
            if (
                str(incident_id) != raw_incident_id
                or incident_id != scheduled.incident_id
                or trigger_summary != scheduled.trigger_summary
                or target != scheduled.target
            ):
                raise RecoveryConsistencyError
            validate_supported_target(target)
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
    scheduled: DiagnosisWorkflowRunSnapshot,
    policy: DiagnosticPolicy,
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
        except ValidationError as error:
            code = (
                "repair_schema_invalid"
                if any(
                    details.get("loc", (None,))[0] == "repair_intent"
                    for details in error.errors(include_input=False)
                )
                else "structured_output_invalid"
            )
            return _terminal_error(code, retryable=False)
        try:
            validated = await validate_diagnosis(
                candidate,
                scheduled.id,
                dependencies.repository,
                required_evidence=policy.required_evidence,
            )
        except (DiagnosisValidationError, StructuredDiagnosisError):
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


def _validate_repair_schema_node(
    dependencies: GraphDependencies,
) -> Callable[..., object]:
    def validate_schema(state: IncidentGraphState) -> dict[str, object]:
        if _has_terminal_error(state):
            return {}
        try:
            diagnosis = ValidatedDiagnosis.model_validate(
                state.get("structured_response")
            )
        except ValidationError:
            return _terminal_error(_RECOVERY_ERROR, retryable=False)
        checked_at = dependencies.now().astimezone(UTC)
        update: dict[str, object] = {"diagnosis_completed_at": _rfc3339(checked_at)}
        if diagnosis.repair_intent is not None:
            update["repair_schema_checked_at"] = _rfc3339(checked_at)
        return update

    return validate_schema


def _validate_repair_policy_node(
    dependencies: GraphDependencies,
    scheduled: DiagnosisWorkflowRunSnapshot,
    policy: DiagnosticPolicy,
) -> Callable[..., object]:
    async def validate_policy(state: IncidentGraphState) -> dict[str, object]:
        if _has_terminal_error(state):
            return {}
        try:
            diagnosis = ValidatedDiagnosis.model_validate(
                state.get("structured_response")
            )
            if diagnosis.repair_intent is None:
                return {}
            schema_checked_at = _state_datetime(state, "repair_schema_checked_at")
            snapshot = await dependencies.repository.get_diagnosis_validation_snapshot(
                scheduled.id
            )
            change = resolve_evidence_bound_change(
                diagnosis,
                snapshot,
                run_id=scheduled.id,
                target=scheduled.target,
                allowed_action=policy.repair_action,
            )
            checked_at = dependencies.now().astimezone(UTC)
            if checked_at < schema_checked_at:
                raise RecoveryConsistencyError
        except RepairPreparationError as error:
            return _terminal_error(error.code, retryable=error.retryable)
        except (RecoveryConsistencyError, ValidationError, ValueError):
            return _terminal_error(_RECOVERY_ERROR, retryable=False)
        return {
            "repair_change": cast(
                dict[str, JsonValue],
                change.model_dump(mode="json"),
            ),
            "repair_policy_checked_at": _rfc3339(checked_at),
        }

    return validate_policy


def _validate_repair_diff_node(
    dependencies: GraphDependencies,
) -> Callable[..., object]:
    def validate_diff(state: IncidentGraphState) -> dict[str, object]:
        if _has_terminal_error(state):
            return {}
        try:
            diagnosis = ValidatedDiagnosis.model_validate(
                state.get("structured_response")
            )
            if diagnosis.repair_intent is None:
                return {}
            change = EvidenceBoundImageChange.model_validate_json(
                canonical_json(state.get("repair_change"))
            )
            schema_checked_at = _state_datetime(state, "repair_schema_checked_at")
            policy_checked_at = _state_datetime(state, "repair_policy_checked_at")
            diff_checked_at = dependencies.now().astimezone(UTC)
            proposal = compile_repair_proposal(
                change,
                schema_checked_at=schema_checked_at,
                policy_checked_at=policy_checked_at,
                diff_checked_at=diff_checked_at,
            )
        except RepairPreparationError as error:
            return _terminal_error(error.code, retryable=error.retryable)
        except (RecoveryConsistencyError, ValidationError, ValueError):
            return _terminal_error(_RECOVERY_ERROR, retryable=False)
        return {
            "repair_proposal": cast(
                dict[str, JsonValue],
                proposal.model_dump(mode="json"),
            )
        }

    return validate_diff


def _validate_repair_dry_run_node(
    dependencies: GraphDependencies,
) -> Callable[..., object]:
    async def validate_dry_run(
        state: IncidentGraphState,
        runtime: Runtime[DiagnosticToolContext],
    ) -> dict[str, object]:
        if _has_terminal_error(state):
            return {}
        try:
            diagnosis = ValidatedDiagnosis.model_validate(
                state.get("structured_response")
            )
            if diagnosis.repair_intent is None:
                return {}
            proposal = RepairProposal.model_validate_json(
                canonical_json(state.get("repair_proposal"))
            )
            require_exact_repair_proposal(proposal)
            validator = dependencies.patch_validator
            if validator is None:
                raise RecoveryConsistencyError
            result = await validator.validate(
                proposal,
                deadline=_deadline(
                    runtime.context.run.started_at,
                    runtime.context.run.timeout_seconds,
                ),
            )
        except (RecoveryConsistencyError, ValidationError, ValueError):
            return _terminal_error(_RECOVERY_ERROR, retryable=False)
        update: dict[str, object] = {
            "patch_validation": cast(
                dict[str, JsonValue],
                result.model_dump(mode="json"),
            )
        }
        if result.outcome == "failed":
            if result.error is None:
                return _terminal_error(_RECOVERY_ERROR, retryable=False)
            update.update(
                _terminal_error(
                    result.error.code,
                    retryable=result.error.retryable,
                )
            )
        return update

    return validate_dry_run


def _persist_terminal_node(
    dependencies: GraphDependencies,
) -> Callable[..., object]:
    async def persist_terminal_state(
        state: IncidentGraphState,
    ) -> dict[str, object]:
        run_id = _state_run_id(state)
        completed_at = dependencies.now().astimezone(UTC)
        error_code = state.get("terminal_error_code")
        error_retryable = state.get("terminal_error_retryable")
        if error_code is not None or error_retryable is not None:
            if not isinstance(error_code, str) or not isinstance(error_retryable, bool):
                raise RecoveryConsistencyError
            require_terminal_error_contract(error_code, error_retryable)

        try:
            diagnosis = ValidatedDiagnosis.model_validate(
                state.get("structured_response")
            )
        except ValidationError:
            diagnosis = None
        if (
            diagnosis is not None
            and diagnosis.outcome == "diagnosed"
            and diagnosis.repair_intent is not None
            and "diagnosis_completed_at" in state
        ):
            raw_proposal = state.get("repair_proposal")
            raw_validation = state.get("patch_validation")
            try:
                proposal = (
                    RepairProposal.model_validate_json(canonical_json(raw_proposal))
                    if raw_proposal is not None
                    else None
                )
                validation = (
                    PatchValidationResponse.model_validate_json(
                        canonical_json(raw_validation)
                    )
                    if raw_validation is not None
                    else None
                )
                terminal = RepairTerminalRecord(
                    run_id=run_id,
                    diagnosis_completed_at=_state_datetime(
                        state,
                        "diagnosis_completed_at",
                    ),
                    completed_at=completed_at,
                    diagnosis=diagnosis,
                    proposal=proposal,
                    validation=validation,
                    error_code=error_code,
                    error_retryable=error_retryable,
                    model_calls=_required_usage(state, "model_calls"),
                    tool_calls=_required_usage(state, "tool_calls"),
                )
            except (ValidationError, ValueError):
                raise RecoveryConsistencyError from None
            await dependencies.repository.persist_repair_terminal(terminal)
            return {}

        if error_code is not None or error_retryable is not None:
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
            if diagnosis is None:
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


def _unavailable_diagnosis(state: IncidentGraphState) -> dict[str, object]:
    del state
    raise DiagnosisUnavailableError


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
    if isinstance(error, DiagnosisUnavailableError):
        return "diagnosis_unavailable", True
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
    if isinstance(error, DiagnosticToolFatalError):
        code = error.code
        return (
            code.value if isinstance(code, StrEnum) else code,
            error.retryable,
        )
    return None


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
    scheduled: DiagnosisWorkflowRunSnapshot,
    current: DiagnosisWorkflowRunSnapshot,
) -> None:
    if (
        current.id != scheduled.id
        or current.incident_id != scheduled.incident_id
        or current.source != scheduled.source
        or current.trigger_summary != scheduled.trigger_summary
        or current.target != scheduled.target
        or current.model != scheduled.model
        or current.budget != scheduled.budget
    ):
        raise RecoveryConsistencyError


def _require_context_identity(
    context: DiagnosticToolContext,
    run: DiagnosisWorkflowRunSnapshot,
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


def _state_datetime(state: IncidentGraphState, field: str) -> datetime:
    raw = cast(dict[str, object], state).get(field)
    if not isinstance(raw, str):
        raise RecoveryConsistencyError
    try:
        value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        raise RecoveryConsistencyError from None
    if value.utcoffset() != timedelta(0) or _rfc3339(value) != raw:
        raise RecoveryConsistencyError
    return value.astimezone(UTC)


def _rfc3339(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Datetime must include a timezone")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


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
