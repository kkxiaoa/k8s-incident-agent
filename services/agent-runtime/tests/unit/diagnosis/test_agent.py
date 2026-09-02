from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast, override
from uuid import UUID, uuid4

import pytest
from langchain.agents.middleware.model_call_limit import ModelCallLimitExceededError
from langchain.agents.middleware.tool_call_limit import ToolCallLimitExceededError
from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.base import LanguageModelInput
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.outputs import ChatResult
from langchain_core.runnables import Runnable
from langchain_core.tools import BaseTool, tool
from pydantic import PrivateAttr
from tests.factories import prometheus_query_service_stub

from k8s_incident_agent.diagnosis.agent import (
    DiagnosticDeadlineExceededError,
    StructuredDiagnosisError,
    build_diagnostic_agent,
)
from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.diagnosis.contracts import DiagnosisCandidate
from k8s_incident_agent.domain.models import AgentRunSnapshot
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredential
from k8s_incident_agent.kubernetes.errors import KubernetesErrorCode
from k8s_incident_agent.kubernetes.tools import FatalDiagnosticToolError
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.scenarios.contracts import ScenarioTarget

TOOL_NAMES = ("get_workload", "get_pods", "get_events", "query_prometheus")
PANEL_IDS = ("image-pull-affected-pods", "image-pull-waiting-containers")
NOW = datetime(2026, 8, 24, 9, 0, tzinfo=UTC)


def _new_bound_tool_names() -> list[tuple[str, ...]]:
    return []


def _new_tool_choices() -> list[str | None]:
    return []


def _new_requests() -> list[list[BaseMessage]]:
    return []


@dataclass
class _ModelCapture:
    bound_tool_names: list[tuple[str, ...]] = field(
        default_factory=_new_bound_tool_names
    )
    tool_choices: list[str | None] = field(default_factory=_new_tool_choices)
    requests: list[list[BaseMessage]] = field(default_factory=_new_requests)


class _ToolCallingFakeModel(FakeMessagesListChatModel):
    _capture: _ModelCapture = PrivateAttr(default_factory=_ModelCapture)

    @property
    def capture(self) -> _ModelCapture:
        return self._capture

    @override
    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type | Callable[..., Any] | BaseTool],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable[LanguageModelInput, AIMessage]:
        del kwargs
        self._capture.bound_tool_names.append(
            tuple(_tool_name(bound) for bound in tools)
        )
        self._capture.tool_choices.append(tool_choice)
        return cast("Runnable[LanguageModelInput, AIMessage]", self)

    @override
    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        self._capture.requests.append(messages)
        return super()._generate(
            messages,
            stop=stop,
            run_manager=run_manager,
            **kwargs,
        )


def _tool_name(candidate: dict[str, Any] | type | Callable[..., Any] | BaseTool) -> str:
    if isinstance(candidate, BaseTool):
        return candidate.name
    if isinstance(candidate, dict):
        mapping = cast(dict[str, Any], candidate)
        function = mapping.get("function")
        if isinstance(function, dict):
            function_mapping = cast(dict[str, Any], function)
            if isinstance(function_mapping.get("name"), str):
                return cast(str, function_mapping["name"])
    named_candidate = cast(object, candidate)
    return str(getattr(named_candidate, "__name__", type(named_candidate).__name__))


class _AgentRunner:
    def __init__(self, graph: object) -> None:
        self._graph = cast(Any, graph)

    @property
    def checkpointer(self) -> object | None:
        return cast(object | None, self._graph.checkpointer)

    async def ainvoke(
        self,
        input: dict[str, object],
        *,
        context: DiagnosticToolContext | None = None,
    ) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._graph.ainvoke(
                input,
                context=context or _context(),
            ),
        )


def _runner(graph: object) -> _AgentRunner:
    return _AgentRunner(graph)


def _context(
    *,
    now: datetime = NOW,
    timeout_seconds: int = 180,
) -> DiagnosticToolContext:
    return DiagnosticToolContext(
        run=AgentRunSnapshot(
            id=uuid4(),
            started_at=NOW,
            timeout_seconds=timeout_seconds,
        ),
        target=ScenarioTarget(
            cluster="k8s-incident-agent",
            namespace="k8s-incident-scenarios",
            api_version="apps/v1",
            kind="Deployment",
            name="image-pull-backoff",
        ),
        credential=DiagnosticCredential(
            kubeconfig_path=Path("/unused/diagnostic.kubeconfig"),
            context_name="kind-k8s-incident-agent",
            server_url="https://127.0.0.1:6443",
            expires_at=NOW + timedelta(hours=1),
            _kubeconfig={},
        ),
        adapter=cast(KubernetesEvidenceAdapter, object()),
        repository=cast(IncidentRepository, object()),
        now=lambda: now,
        prometheus=prometheus_query_service_stub(),
    )


def _tool_call(name: str, call_id: str) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": {}, "id": call_id, "type": "tool_call"}],
    )


def _structured_response(
    candidate: DiagnosisCandidate,
    call_id: str = "call-structured",
) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": "DiagnosisCandidate",
                "args": candidate.model_dump(mode="json"),
                "id": call_id,
                "type": "tool_call",
            }
        ],
    )


def _diagnosed_candidate(evidence_id: str) -> DiagnosisCandidate:
    return DiagnosisCandidate.model_validate(
        {
            "outcome": "diagnosed",
            "summary": "The cited observations support a diagnosis.",
            "root_causes": [
                {
                    "code": "observed_failure",
                    "statement": "The observations identify a concrete failure.",
                    "confidence": "high",
                    "evidence_ids": [evidence_id],
                }
            ],
            "missing_information": [],
        }
    )


def _build_tools(
    calls: list[str],
    *,
    fatal_tool: str | None = None,
    retryable_events: bool = False,
) -> tuple[BaseTool, BaseTool, BaseTool, BaseTool]:
    event_attempts = 0

    @tool("get_workload")
    async def get_workload() -> dict[str, object]:
        """Read normalized workload evidence."""
        calls.append("get_workload")
        if fatal_tool == "get_workload":
            raise FatalDiagnosticToolError(KubernetesErrorCode.PERMISSION_DENIED)
        return {"evidenceId": "00000000-0000-0000-0000-000000000001"}

    @tool("get_pods")
    async def get_pods() -> dict[str, object]:
        """Read normalized pod evidence."""
        calls.append("get_pods")
        if fatal_tool == "get_pods":
            raise FatalDiagnosticToolError(KubernetesErrorCode.PERMISSION_DENIED)
        return {"evidenceId": "00000000-0000-0000-0000-000000000002"}

    @tool("get_events")
    async def get_events() -> dict[str, object]:
        """Read normalized event evidence."""
        nonlocal event_attempts
        event_attempts += 1
        calls.append("get_events")
        if fatal_tool == "get_events":
            raise FatalDiagnosticToolError(KubernetesErrorCode.PERMISSION_DENIED)
        if retryable_events and event_attempts == 1:
            return {
                "code": "request_timeout",
                "retryable": True,
                "message": "Kubernetes request timed out",
            }
        return {"evidenceId": "00000000-0000-0000-0000-000000000003"}

    @tool("query_prometheus")
    async def query_prometheus(panel_id: str, window: str) -> dict[str, object]:
        """Read one catalog-owned Prometheus panel."""
        del panel_id, window
        calls.append("query_prometheus")
        return {"evidenceId": "00000000-0000-0000-0000-000000000004"}

    return get_workload, get_pods, get_events, query_prometheus


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "order",
    [
        ("get_events", "get_workload", "get_pods"),
        ("get_pods", "get_events", "get_workload"),
    ],
)
async def test_agent_executes_different_read_tool_trajectories_and_returns_schema(
    order: tuple[str, ...],
) -> None:
    calls: list[str] = []
    tools = _build_tools(calls)
    evidence_id = str(uuid4())
    model = _ToolCallingFakeModel(
        responses=[
            *[_tool_call(name, f"call-{index}") for index, name in enumerate(order)],
            _structured_response(_diagnosed_candidate(evidence_id)),
        ]
    )
    agent = _runner(
        build_diagnostic_agent(model, tools, prometheus_panel_ids=PANEL_IDS)
    )

    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": "Diagnose the public target."}]}
    )

    assert calls == list(order)
    assert result["structured_response"] == _diagnosed_candidate(
        evidence_id
    ).model_dump(mode="json")
    assert result["model_calls"] == 4
    assert result["tool_calls"] == 4
    assert agent.checkpointer is None
    assert model.capture.bound_tool_names
    assert set(model.capture.bound_tool_names[-1]) == {
        *TOOL_NAMES,
        "DiagnosisCandidate",
    }
    assert set(model.capture.tool_choices) == {"any"}
    assert "untrusted" in str(model.capture.requests[0][0].content).lower()


@pytest.mark.asyncio
async def test_fatal_tool_failure_propagates_without_model_retry() -> None:
    calls: list[str] = []
    tools = _build_tools(calls, fatal_tool="get_workload")
    model = _ToolCallingFakeModel(responses=[_tool_call("get_workload", "call-fatal")])
    agent = _runner(
        build_diagnostic_agent(model, tools, prometheus_panel_ids=PANEL_IDS)
    )

    with pytest.raises(FatalDiagnosticToolError) as error:
        await agent.ainvoke(
            {"messages": [{"role": "user", "content": "Diagnose the target."}]}
        )

    assert error.value.code is KubernetesErrorCode.PERMISSION_DENIED
    assert calls == ["get_workload"]
    assert len(model.capture.requests) == 1


@pytest.mark.asyncio
async def test_absolute_deadline_cancels_inflight_tool_call() -> None:
    entered = asyncio.Event()
    cancelled = asyncio.Event()

    @tool("get_workload")
    async def get_workload() -> dict[str, object]:
        """Block while reading workload evidence."""
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
        raise AssertionError("blocking tool unexpectedly completed")

    @tool("get_pods")
    async def get_pods() -> dict[str, object]:
        """Read pod evidence."""
        return {"evidenceId": "00000000-0000-0000-0000-000000000002"}

    @tool("get_events")
    async def get_events() -> dict[str, object]:
        """Read event evidence."""
        return {"evidenceId": "00000000-0000-0000-0000-000000000003"}

    @tool("query_prometheus")
    async def query_prometheus(panel_id: str, window: str) -> dict[str, object]:
        """Read one catalog-owned Prometheus panel."""
        del panel_id, window
        return {"evidenceId": "00000000-0000-0000-0000-000000000004"}

    model = _ToolCallingFakeModel(
        responses=[_tool_call("get_workload", "call-workload")]
    )
    agent = _runner(
        build_diagnostic_agent(
            model,
            (get_workload, get_pods, get_events, query_prometheus),
            prometheus_panel_ids=PANEL_IDS,
        )
    )

    with pytest.raises(DiagnosticDeadlineExceededError):
        async with asyncio.timeout(1):
            await agent.ainvoke(
                {"messages": [{"role": "user", "content": "Diagnose."}]},
                context=_context(
                    now=NOW + timedelta(milliseconds=900),
                    timeout_seconds=1,
                ),
            )

    assert entered.is_set()
    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_retryable_failure_can_use_a_new_call_before_structured_output() -> None:
    calls: list[str] = []
    tools = _build_tools(calls, retryable_events=True)
    evidence_id = "00000000-0000-0000-0000-000000000003"
    model = _ToolCallingFakeModel(
        responses=[
            _tool_call("get_events", "call-timeout"),
            _tool_call("get_events", "call-retry"),
            _structured_response(_diagnosed_candidate(evidence_id)),
        ]
    )
    agent = _runner(
        build_diagnostic_agent(model, tools, prometheus_panel_ids=PANEL_IDS)
    )

    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": "Diagnose the target."}]}
    )

    tool_messages = [
        message for message in result["messages"] if isinstance(message, ToolMessage)
    ]
    assert calls == ["get_events", "get_events"]
    assert [message.tool_call_id for message in tool_messages[:2]] == [
        "call-timeout",
        "call-retry",
    ]
    validated = DiagnosisCandidate.model_validate(result["structured_response"])
    assert validated.root_causes[0].evidence_ids == [UUID(evidence_id)]


@pytest.mark.asyncio
async def test_model_call_limit_raises_instead_of_returning_fallback_text() -> None:
    calls: list[str] = []
    tools = _build_tools(calls)
    model = _ToolCallingFakeModel(
        responses=[_tool_call("get_workload", "call-workload")]
    )
    agent = _runner(
        build_diagnostic_agent(
            model,
            tools,
            max_model_calls=1,
            prometheus_panel_ids=PANEL_IDS,
        )
    )

    with pytest.raises(ModelCallLimitExceededError):
        await agent.ainvoke(
            {"messages": [{"role": "user", "content": "Diagnose the target."}]}
        )

    assert calls == ["get_workload"]


@pytest.mark.asyncio
async def test_locked_tool_limit_counts_the_structured_response_call() -> None:
    calls: list[str] = []
    tools = _build_tools(calls)
    candidate = _diagnosed_candidate(str(uuid4()))
    responses: list[BaseMessage] = [
        _tool_call("get_workload", "call-workload"),
        _structured_response(candidate),
    ]

    accepted = _runner(
        build_diagnostic_agent(
            _ToolCallingFakeModel(responses=responses),
            tools,
            max_model_calls=2,
            max_tool_calls=2,
            prometheus_panel_ids=PANEL_IDS,
        )
    )
    result = await accepted.ainvoke(
        {"messages": [{"role": "user", "content": "Diagnose the target."}]}
    )
    assert result["structured_response"] == candidate.model_dump(mode="json")

    rejected = _runner(
        build_diagnostic_agent(
            _ToolCallingFakeModel(responses=responses),
            tools,
            max_model_calls=2,
            max_tool_calls=1,
            prometheus_panel_ids=PANEL_IDS,
        )
    )
    with pytest.raises(ToolCallLimitExceededError):
        await rejected.ainvoke(
            {"messages": [{"role": "user", "content": "Diagnose the target."}]}
        )


def test_agent_rejects_any_registry_other_than_the_four_read_tools() -> None:
    calls: list[str] = []
    tools = _build_tools(calls)
    model = _ToolCallingFakeModel(
        responses=[_structured_response(_diagnosed_candidate(str(uuid4())))]
    )

    with pytest.raises(ValueError, match="exactly the four diagnostic read tools"):
        build_diagnostic_agent(
            model,
            tools[:3],
            prometheus_panel_ids=PANEL_IDS,
        )


@pytest.mark.asyncio
async def test_plain_model_answer_fails_closed_without_structured_response() -> None:
    calls: list[str] = []
    tools = _build_tools(calls)
    model = _ToolCallingFakeModel(responses=[AIMessage(content="A fluent fallback")])
    agent = _runner(
        build_diagnostic_agent(model, tools, prometheus_panel_ids=PANEL_IDS)
    )

    with pytest.raises(StructuredDiagnosisError) as error:
        await agent.ainvoke(
            {"messages": [{"role": "user", "content": "Diagnose the target."}]}
        )

    assert error.value.code == "structured_output_invalid"
    assert calls == []
