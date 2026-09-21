from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from datetime import timedelta
from typing import Annotated, Any, NotRequired, cast

from langchain.agents import create_agent  # pyright: ignore[reportUnknownVariableType]
from langchain.agents.middleware import (
    AgentMiddleware,
    AgentState,
    InputAgentState,
    ModelCallLimitMiddleware,
    ModelRequest,
    ModelResponse,
    OutputAgentState,
    ToolCallLimitMiddleware,
    hook_config,
)
from langchain.agents.middleware.model_call_limit import (
    ModelCallLimitExceededError,
)
from langchain.agents.middleware.tool_call_limit import ToolCallLimitExceededError
from langchain.agents.middleware.types import OmitFromInput, PrivateStateAttr
from langchain.agents.structured_output import StructuredOutputError, ToolStrategy
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool
from langgraph.graph.state import (  # pyright: ignore[reportMissingTypeStubs]
    CompiledStateGraph,
)
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.runtime import Runtime
from langgraph.types import Command

from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.diagnosis.contracts import DiagnosisCandidate
from k8s_incident_agent.diagnosis.policy_contracts import (
    DIAGNOSTIC_TOOL_NAMES,
    DiagnosticPanel,
    DiagnosticPanelName,
)
from k8s_incident_agent.diagnosis.prompt import build_diagnostic_system_prompt
from k8s_incident_agent.domain.models import JsonValue
from k8s_incident_agent.repair.contracts import RepairAction

_DEFAULT_MAX_MODEL_CALLS = 12
_DEFAULT_MAX_TOOL_CALLS = 12
_FINAL_RESPONSE_TOOL_NAME = DiagnosisCandidate.__name__
_UNPARSABLE_TOOL_CALL_HINT = (
    "The previous tool call arguments were not valid JSON and were discarded. "
    "Send the call again as well-formed JSON, keeping every identifier exactly "
    "as the tool results gave it."
)
_FINAL_ONLY_HINT = (
    "Budget notice: only the final structured response remains. Deliver the "
    "diagnosis from the Evidence already collected; further tool calls are refused."
)
type _DiagnosisPayload = dict[str, JsonValue]


class _CheckpointSafeDiagnosisState(AgentState[_DiagnosisPayload]):
    model_calls: NotRequired[Annotated[int, OmitFromInput]]
    tool_calls: NotRequired[Annotated[int, OmitFromInput]]
    terminal_error_code: NotRequired[str]
    terminal_error_retryable: NotRequired[bool]
    unparsable_call_repairs: NotRequired[Annotated[int, PrivateStateAttr]]


type _DiagnosticAgentGraph = CompiledStateGraph[
    _CheckpointSafeDiagnosisState,
    DiagnosticToolContext,
    InputAgentState,
    OutputAgentState[_DiagnosisPayload],
]


class StructuredDiagnosisError(RuntimeError):
    code = "structured_output_invalid"

    def __init__(self) -> None:
        super().__init__("The model did not return a valid structured diagnosis")


class ModelUpstreamError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("The model provider failed")


class DiagnosticDeadlineExceededError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("The persisted diagnostic deadline was exceeded")


class _CheckpointSafeDiagnosisMiddleware(
    AgentMiddleware[_CheckpointSafeDiagnosisState, DiagnosticToolContext]
):
    """Deadline, checkpoint-safe output and the deterministic final-response reserve.

    The SDK limit middlewares count attempts and fail the Run once a batch exceeds
    the thread limit. This middleware runs before them: it keeps the last tool call
    and the last model call for the structured response so a legal investigation can
    still be delivered, and refuses any batch that would spend that reserve on
    evidence reads.
    """

    state_schema = _CheckpointSafeDiagnosisState

    def __init__(self, *, max_model_calls: int, max_tool_calls: int) -> None:
        super().__init__()
        self._max_model_calls = max_model_calls
        self._max_tool_calls = max_tool_calls

    @hook_config(can_jump_to=["end"])
    def before_agent(
        self,
        state: _CheckpointSafeDiagnosisState,
        runtime: Runtime[DiagnosticToolContext],
    ) -> dict[str, object] | None:
        del runtime
        error_code = state.get("terminal_error_code")
        error_retryable = state.get("terminal_error_retryable")
        if error_code is None and error_retryable is None:
            return None
        if (
            not isinstance(error_code, str)
            or not error_code
            or not isinstance(error_retryable, bool)
        ):
            raise StructuredDiagnosisError
        return {"jump_to": "end"}

    def wrap_model_call(
        self,
        request: ModelRequest[DiagnosticToolContext],
        handler: Callable[[ModelRequest[DiagnosticToolContext]], ModelResponse[Any]],
    ) -> ModelResponse[Any]:
        try:
            _require_remaining_time(request.runtime.context)
            return _checkpoint_safe_response(handler(self._reserve_final(request)))
        except DiagnosticDeadlineExceededError:
            raise
        except (StructuredDiagnosisError, StructuredOutputError):
            raise StructuredDiagnosisError from None
        except Exception:
            raise ModelUpstreamError from None

    async def awrap_model_call(
        self,
        request: ModelRequest[DiagnosticToolContext],
        handler: Callable[
            [ModelRequest[DiagnosticToolContext]], Awaitable[ModelResponse[Any]]
        ],
    ) -> ModelResponse[Any]:
        try:
            reserved = self._reserve_final(request)
            response = await _run_before_deadline(
                request.runtime.context,
                lambda: handler(reserved),
            )
            return _checkpoint_safe_response(response)
        except DiagnosticDeadlineExceededError:
            raise
        except (StructuredDiagnosisError, StructuredOutputError):
            raise StructuredDiagnosisError from None
        except Exception:
            raise ModelUpstreamError from None

    @hook_config(can_jump_to=["model"])
    def after_model(
        self,
        state: _CheckpointSafeDiagnosisState,
        runtime: Runtime[DiagnosticToolContext],
    ) -> dict[str, object] | None:
        del runtime
        self._require_batch_within_reserve(state)
        return self._reprompt_unparsable_response(state)

    @hook_config(can_jump_to=["model"])
    async def aafter_model(
        self,
        state: _CheckpointSafeDiagnosisState,
        runtime: Runtime[DiagnosticToolContext],
    ) -> dict[str, object] | None:
        del runtime
        self._require_batch_within_reserve(state)
        return self._reprompt_unparsable_response(state)

    def _reprompt_unparsable_response(
        self,
        state: _CheckpointSafeDiagnosisState,
    ) -> dict[str, object] | None:
        """Hand structurally broken tool calls back for one more attempt.

        A tool call whose arguments are not valid JSON reaches
        `invalid_tool_calls`, which the SDK never inspects. When a batch carries
        nothing else the Run ends there: with no diagnosis if the final response
        broke, and with no Evidence if an investigation call did. Only the break
        in the JSON is handed back; a call that parses is answered by the tool
        boundary or by `validate_diagnosis` against this Run's Evidence, which
        the retried response has to satisfy exactly as the first one did.

        Jumping from here skips the remaining `after_model` hooks, including the
        one that charges the call, so the charge is carried in this update.
        Without it the reserve reads a stale count and hands the repaired call a
        full tool surface instead of the final-response-only turn it is owed.
        """
        values = cast(dict[str, object], state)
        message = _last_ai_message(values)
        if message is None or message.tool_calls:
            return None
        # A call with no id or no name cannot be answered without inventing one.
        broken = [
            call
            for call in message.invalid_tool_calls
            if call.get("id") and call.get("name")
        ]
        if not broken:
            return None
        # One repair per Run. Anything but an exact zero declines, so a counter
        # restored corrupt from the checkpoint store can never reissue one.
        repairs = values.get("unparsable_call_repairs", 0)
        if type(repairs) is not int or repairs != 0:
            return None
        # The broken call is not charged yet: the hook that charges it runs after
        # this one. With no call left after it, a repair would only trade the
        # accurate terminal error for a call-limit one.
        charged = _model_calls_used(values) + 1
        if charged >= self._max_model_calls:
            return None
        return {
            "jump_to": "model",
            "unparsable_call_repairs": 1,
            "thread_model_call_count": charged,
            "messages": [
                ToolMessage(
                    content=_UNPARSABLE_TOOL_CALL_HINT,
                    tool_call_id=str(call["id"]),
                    name=str(call["name"]),
                )
                for call in broken
            ],
        }

    def _reserve_final(
        self,
        request: ModelRequest[DiagnosticToolContext],
    ) -> ModelRequest[DiagnosticToolContext]:
        state = cast(dict[str, object], request.state)
        if (
            self._max_tool_calls - _tool_calls_used(state) > 1
            and self._max_model_calls - _model_calls_used(state) > 1
        ):
            return request
        system = request.system_message
        content = system.text if system is not None else ""
        return request.override(
            tools=[],
            system_message=SystemMessage(content=f"{content}\n\n{_FINAL_ONLY_HINT}"),
        )

    def _require_batch_within_reserve(
        self,
        state: _CheckpointSafeDiagnosisState,
    ) -> None:
        values = cast(dict[str, object], state)
        message = _last_ai_message(values)
        if message is None:
            return
        evidence_calls = [
            call
            for call in message.tool_calls
            if call["name"] != _FINAL_RESPONSE_TOOL_NAME
        ]
        if not evidence_calls:
            return
        tool_calls_used = _tool_calls_used(values)
        attempted = tool_calls_used + len(message.tool_calls)
        # Evidence reads may never spend the last tool call reserved for the final
        # response, whether or not the same batch also carries that response.
        if len(evidence_calls) > self._max_tool_calls - tool_calls_used - 1:
            raise ToolCallLimitExceededError(
                thread_count=attempted,
                run_count=attempted,
                thread_limit=self._max_tool_calls,
                run_limit=None,
            )
        model_calls_used = _model_calls_used(values) + 1
        if model_calls_used >= self._max_model_calls:
            raise ModelCallLimitExceededError(
                thread_count=model_calls_used + 1,
                run_count=model_calls_used + 1,
                thread_limit=self._max_model_calls,
                run_limit=None,
            )

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command[Any]],
    ) -> ToolMessage | Command[Any]:
        context = cast(
            DiagnosticToolContext,
            request.runtime.context,  # pyright: ignore[reportUnknownMemberType]
        )
        _require_remaining_time(context)
        return handler(request)

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[
            [ToolCallRequest],
            Awaitable[ToolMessage | Command[Any]],
        ],
    ) -> ToolMessage | Command[Any]:
        context = cast(
            DiagnosticToolContext,
            request.runtime.context,  # pyright: ignore[reportUnknownMemberType]
        )
        return await _run_before_deadline(
            context,
            lambda: handler(request),
        )

    def after_agent(
        self,
        state: _CheckpointSafeDiagnosisState,
        runtime: Runtime[DiagnosticToolContext],
    ) -> dict[str, int]:
        del runtime
        if "terminal_error_code" in state or "terminal_error_retryable" in state:
            return {}
        response = state.get("structured_response")
        if not isinstance(response, dict):
            raise StructuredDiagnosisError
        try:
            DiagnosisCandidate.model_validate(response)
        except ValueError:
            raise StructuredDiagnosisError from None
        raw_tool_counts: object = state.get("thread_tool_call_count")
        model_calls = state.get("thread_model_call_count")
        if not isinstance(raw_tool_counts, dict):
            raise StructuredDiagnosisError
        tool_counts = cast(dict[object, object], raw_tool_counts)
        tool_calls = tool_counts.get("__all__")
        if (
            not isinstance(model_calls, int)
            or isinstance(model_calls, bool)
            or model_calls < 0
            or not isinstance(tool_calls, int)
            or isinstance(tool_calls, bool)
            or tool_calls < 0
        ):
            raise StructuredDiagnosisError
        return {"model_calls": model_calls, "tool_calls": tool_calls}


def _checkpoint_safe_response(response: ModelResponse[Any]) -> ModelResponse[Any]:
    structured_response = response.structured_response
    if isinstance(structured_response, DiagnosisCandidate):
        structured_response = structured_response.model_dump(mode="json")
    elif structured_response is not None:
        raise StructuredDiagnosisError
    return ModelResponse(
        result=response.result,
        structured_response=structured_response,
    )


def _tool_calls_used(state: dict[str, object]) -> int:
    counts = state.get("thread_tool_call_count")
    if not isinstance(counts, dict):
        return 0
    used = cast(dict[object, object], counts).get("__all__", 0)
    return used if isinstance(used, int) and not isinstance(used, bool) else 0


def _model_calls_used(state: dict[str, object]) -> int:
    used = state.get("thread_model_call_count", 0)
    return used if isinstance(used, int) and not isinstance(used, bool) else 0


def _last_ai_message(state: dict[str, object]) -> AIMessage | None:
    messages = state.get("messages")
    if not isinstance(messages, list):
        return None
    for message in reversed(cast(list[object], messages)):
        if isinstance(message, AIMessage):
            return message
    return None


def _remaining_time(context: DiagnosticToolContext) -> float:
    deadline = context.run.started_at + timedelta(seconds=context.run.timeout_seconds)
    return (deadline - context.now()).total_seconds()


def _require_remaining_time(context: DiagnosticToolContext) -> float:
    remaining = _remaining_time(context)
    if remaining <= 0:
        raise DiagnosticDeadlineExceededError
    return remaining


async def _run_before_deadline[T](
    context: DiagnosticToolContext,
    operation: Callable[[], Awaitable[T]],
) -> T:
    timeout = asyncio.timeout(_require_remaining_time(context))
    try:
        async with timeout:
            return await operation()
    except TimeoutError:
        if timeout.expired():
            raise DiagnosticDeadlineExceededError from None
        raise


def build_diagnostic_agent(
    model: BaseChatModel,
    tools: Sequence[BaseTool],
    *,
    max_model_calls: int = _DEFAULT_MAX_MODEL_CALLS,
    max_tool_calls: int = _DEFAULT_MAX_TOOL_CALLS,
    required_evidence: Sequence[str],
    prometheus_panels: Sequence[DiagnosticPanel],
    other_panels: Sequence[DiagnosticPanelName] = (),
    trigger_panel_id: str | None,
    trigger_duration: str | None = None,
    repair_action: RepairAction | None = None,
) -> _DiagnosticAgentGraph:
    """Build the one-shot read-only diagnosis graph embedded by the orchestrator."""
    tool_names = tuple(tool.name for tool in tools)
    if (
        not tool_names
        or len(set(tool_names)) != len(tool_names)
        or any(name not in DIAGNOSTIC_TOOL_NAMES for name in tool_names)
        or tool_names
        != tuple(name for name in DIAGNOSTIC_TOOL_NAMES if name in set(tool_names))
    ):
        raise ValueError("diagnosis tools must be an ordered subset of the registry")

    system_prompt = build_diagnostic_system_prompt(
        max_model_calls=max_model_calls,
        max_tool_calls=max_tool_calls,
        allowed_tool_names=tool_names,
        required_evidence=required_evidence,
        prometheus_panels=prometheus_panels,
        other_panels=other_panels,
        trigger_panel_id=trigger_panel_id,
        trigger_duration=trigger_duration,
        repair_action=repair_action,
    )
    agent_factory = cast(Callable[..., object], create_agent)
    graph = agent_factory(
        model,
        tools=tools,
        system_prompt=system_prompt,
        middleware=(
            ToolCallLimitMiddleware(
                thread_limit=max_tool_calls,
                exit_behavior="error",
            ),
            ModelCallLimitMiddleware(
                thread_limit=max_model_calls,
                exit_behavior="error",
            ),
            _CheckpointSafeDiagnosisMiddleware(
                max_model_calls=max_model_calls,
                max_tool_calls=max_tool_calls,
            ),
        ),
        response_format=ToolStrategy(
            DiagnosisCandidate,
            tool_message_content="Structured diagnosis accepted.",
            handle_errors=False,
        ),
        context_schema=DiagnosticToolContext,
        checkpointer=None,
        name="diagnosis_agent",
    )
    return cast(_DiagnosticAgentGraph, graph)
