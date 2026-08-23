from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from typing import Any, cast

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
)
from langchain.agents.structured_output import ToolStrategy
from langchain_core.language_models import BaseChatModel
from langchain_core.tools import BaseTool
from langgraph.graph.state import (  # pyright: ignore[reportMissingTypeStubs]
    CompiledStateGraph,
)
from langgraph.runtime import Runtime

from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.diagnosis.contracts import DiagnosisCandidate
from k8s_incident_agent.diagnosis.prompt import build_diagnostic_system_prompt
from k8s_incident_agent.domain.models import JsonValue

_DEFAULT_MAX_MODEL_CALLS = 8
_DEFAULT_MAX_TOOL_CALLS = 6
_DIAGNOSTIC_TOOL_NAMES = ("get_workload", "get_pods", "get_events")

type _DiagnosisPayload = dict[str, JsonValue]
type _DiagnosticAgentGraph = CompiledStateGraph[
    AgentState[_DiagnosisPayload],
    DiagnosticToolContext,
    InputAgentState,
    OutputAgentState[_DiagnosisPayload],
]


class StructuredDiagnosisError(RuntimeError):
    code = "structured_output_invalid"

    def __init__(self) -> None:
        super().__init__("The model did not return a valid structured diagnosis")


class _CheckpointSafeDiagnosisMiddleware(
    AgentMiddleware[AgentState[_DiagnosisPayload], DiagnosticToolContext]
):
    def wrap_model_call(
        self,
        request: ModelRequest[DiagnosticToolContext],
        handler: Callable[[ModelRequest[DiagnosticToolContext]], ModelResponse[Any]],
    ) -> ModelResponse[Any]:
        return _checkpoint_safe_response(handler(request))

    async def awrap_model_call(
        self,
        request: ModelRequest[DiagnosticToolContext],
        handler: Callable[
            [ModelRequest[DiagnosticToolContext]], Awaitable[ModelResponse[Any]]
        ],
    ) -> ModelResponse[Any]:
        return _checkpoint_safe_response(await handler(request))

    def after_agent(
        self,
        state: AgentState[_DiagnosisPayload],
        runtime: Runtime[DiagnosticToolContext],
    ) -> None:
        del runtime
        response = state.get("structured_response")
        if not isinstance(response, dict):
            raise StructuredDiagnosisError
        try:
            DiagnosisCandidate.model_validate(response)
        except ValueError:
            raise StructuredDiagnosisError from None


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


def build_diagnostic_agent(
    model: BaseChatModel,
    tools: Sequence[BaseTool],
    *,
    max_model_calls: int = _DEFAULT_MAX_MODEL_CALLS,
    max_tool_calls: int = _DEFAULT_MAX_TOOL_CALLS,
) -> _DiagnosticAgentGraph:
    """Build the one-shot read-only diagnosis graph embedded by the orchestrator."""
    tool_names = tuple(tool.name for tool in tools)
    if tool_names != _DIAGNOSTIC_TOOL_NAMES:
        raise ValueError(
            "diagnosis requires exactly the three diagnostic read tools in registry order"
        )

    system_prompt = build_diagnostic_system_prompt(
        max_model_calls=max_model_calls,
        max_tool_calls=max_tool_calls,
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
