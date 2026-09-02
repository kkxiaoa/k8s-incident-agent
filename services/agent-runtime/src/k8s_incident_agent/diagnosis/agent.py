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
from langchain.agents.middleware.types import OmitFromInput
from langchain.agents.structured_output import StructuredOutputError, ToolStrategy
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool
from langgraph.graph.state import (  # pyright: ignore[reportMissingTypeStubs]
    CompiledStateGraph,
)
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.runtime import Runtime
from langgraph.types import Command

from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.diagnosis.contracts import DiagnosisCandidate
from k8s_incident_agent.diagnosis.prompt import build_diagnostic_system_prompt
from k8s_incident_agent.diagnosis.tool_execution import DIAGNOSTIC_TOOL_NAMES
from k8s_incident_agent.domain.models import JsonValue

_DEFAULT_MAX_MODEL_CALLS = 8
_DEFAULT_MAX_TOOL_CALLS = 6
type _DiagnosisPayload = dict[str, JsonValue]


class _CheckpointSafeDiagnosisState(AgentState[_DiagnosisPayload]):
    model_calls: NotRequired[Annotated[int, OmitFromInput]]
    tool_calls: NotRequired[Annotated[int, OmitFromInput]]
    terminal_error_code: NotRequired[str]
    terminal_error_retryable: NotRequired[bool]


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
    state_schema = _CheckpointSafeDiagnosisState

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
            return _checkpoint_safe_response(handler(request))
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
            response = await _run_before_deadline(
                request.runtime.context,
                lambda: handler(request),
            )
            return _checkpoint_safe_response(response)
        except DiagnosticDeadlineExceededError:
            raise
        except (StructuredDiagnosisError, StructuredOutputError):
            raise StructuredDiagnosisError from None
        except Exception:
            raise ModelUpstreamError from None

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
    prometheus_panel_ids: Sequence[str],
) -> _DiagnosticAgentGraph:
    """Build the one-shot read-only diagnosis graph embedded by the orchestrator."""
    tool_names = tuple(tool.name for tool in tools)
    if tool_names != DIAGNOSTIC_TOOL_NAMES:
        raise ValueError(
            "diagnosis requires exactly the four diagnostic read tools in registry order"
        )

    system_prompt = build_diagnostic_system_prompt(
        max_model_calls=max_model_calls,
        max_tool_calls=max_tool_calls,
        prometheus_panel_ids=prometheus_panel_ids,
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
            _CheckpointSafeDiagnosisMiddleware(),
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
