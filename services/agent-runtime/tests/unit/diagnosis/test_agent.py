from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence
from contextlib import suppress
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
from tests.unit.routes.test_operator import credential as credential

from k8s_incident_agent.diagnosis.agent import (
    DiagnosticDeadlineExceededError,
    StructuredDiagnosisError,
    build_diagnostic_agent,
)
from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.diagnosis.contracts import DiagnosisCandidate
from k8s_incident_agent.diagnosis.policy_contracts import DiagnosticPanel
from k8s_incident_agent.domain.models import (
    AgentRunSnapshot,
)
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredential
from k8s_incident_agent.kubernetes.errors import KubernetesErrorCode
from k8s_incident_agent.kubernetes.tools import FatalDiagnosticToolError
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.scenarios.contracts import ScenarioTarget

TOOL_NAMES = ("get_workload", "get_pods", "get_events", "query_prometheus")
PANELS = (
    DiagnosticPanel(
        "image-pull-affected-pods",
        "Affected pods",
        "pods",
        "Registered purpose.",
        "target",
        "higher_is_worse",
    ),
    DiagnosticPanel(
        "image-pull-available-replicas",
        "Available replicas",
        "replicas",
        "Registered purpose.",
        "target",
        "higher_is_worse",
    ),
)
REQUIRED_EVIDENCE = ("workload",)
NOW = datetime(2026, 8, 24, 9, 0, tzinfo=UTC)

_OCCURRED_AT = datetime(2026, 9, 2, 8, 30, tzinfo=UTC)


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
        occurred_at=_OCCURRED_AT,
    )


def _tool_call(name: str, call_id: str) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": {}, "id": call_id, "type": "tool_call"}],
    )


def _unparsable_structured_response(
    call_id: str = "call-unparsable",
) -> AIMessage:
    # What DeepSeek actually produced in a live evaluation run: a structured tool call
    # whose arguments are truncated mid-JSON. LangChain routes it to
    # invalid_tool_calls, which the agent factory never inspects.
    return AIMessage(
        content="",
        tool_calls=[],
        invalid_tool_calls=[
            {
                "name": "DiagnosisCandidate",
                "args": '{"outcome": "diagnosed", "summary": "truncated',
                "id": call_id,
                "error": "Expecting ',' delimiter: line 1 column 1281 (char 1280)",
                "type": "invalid_tool_call",
            }
        ],
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


def _schema_rejected_response(
    evidence_id: str = "00000000-0000-0000-0000-000000000004",
    call_id: str = "call-rejected",
) -> AIMessage:
    # Well-formed JSON the schema still refuses: the summary runs past its limit.
    args = _diagnosed_candidate(evidence_id).model_dump(mode="json")
    args["summary"] = "s" * 1100
    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": "DiagnosisCandidate",
                "args": args,
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
        build_diagnostic_agent(
            model,
            tools,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
        )
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
        build_diagnostic_agent(
            model,
            tools,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
        )
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
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
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
        build_diagnostic_agent(
            model,
            tools,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
        )
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
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
        )
    )

    with pytest.raises(ModelCallLimitExceededError):
        await agent.ainvoke(
            {"messages": [{"role": "user", "content": "Diagnose the target."}]}
        )

    # The last model round only offers the final response; an evidence call it
    # still emits is refused before any read happens.
    assert calls == []
    assert model.capture.bound_tool_names == [("DiagnosisCandidate",)]


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
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
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
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
        )
    )
    with pytest.raises(ToolCallLimitExceededError):
        await rejected.ainvoke(
            {"messages": [{"role": "user", "content": "Diagnose the target."}]}
        )


def test_agent_rejects_tools_outside_registry_order() -> None:
    calls: list[str] = []
    tools = _build_tools(calls)
    model = _ToolCallingFakeModel(
        responses=[_structured_response(_diagnosed_candidate(str(uuid4())))]
    )

    with pytest.raises(ValueError, match="ordered subset"):
        build_diagnostic_agent(
            model,
            (tools[1], tools[0]),
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=(),
            trigger_panel_id=None,
        )


@pytest.mark.asyncio
async def test_plain_model_answer_fails_closed_without_structured_response() -> None:
    calls: list[str] = []
    tools = _build_tools(calls)
    model = _ToolCallingFakeModel(responses=[AIMessage(content="A fluent fallback")])
    agent = _runner(
        build_diagnostic_agent(
            model,
            tools,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
        )
    )

    with pytest.raises(StructuredDiagnosisError) as error:
        await agent.ainvoke(
            {"messages": [{"role": "user", "content": "Diagnose the target."}]}
        )

    assert error.value.code == "structured_output_invalid"
    assert calls == []


@pytest.mark.asyncio
async def test_final_reserve_narrows_tools_when_one_tool_call_remains() -> None:
    calls: list[str] = []
    tools = _build_tools(calls)
    candidate = _diagnosed_candidate("00000000-0000-0000-0000-000000000001")
    model = _ToolCallingFakeModel(
        responses=[
            _tool_call("get_workload", "call-workload"),
            _structured_response(candidate),
        ]
    )
    agent = _runner(
        build_diagnostic_agent(
            model,
            tools,
            max_model_calls=8,
            max_tool_calls=2,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
        )
    )

    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": "Diagnose the target."}]}
    )

    assert calls == ["get_workload"]
    assert result["structured_response"] == candidate.model_dump(mode="json")
    assert result["tool_calls"] == 2
    assert set(model.capture.bound_tool_names[0]) == {*TOOL_NAMES, "DiagnosisCandidate"}
    assert model.capture.bound_tool_names[1] == ("DiagnosisCandidate",)
    first_system, second_system = (
        str(request[0].content) for request in model.capture.requests
    )
    assert "Budget notice" not in first_system
    assert second_system.startswith(first_system)
    assert "Budget notice" in second_system


@pytest.mark.asyncio
async def test_parallel_evidence_batch_that_spends_the_final_reserve_fails_closed() -> (
    None
):
    calls: list[str] = []
    tools = _build_tools(calls)
    model = _ToolCallingFakeModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": name,
                        "args": {},
                        "id": f"call-{name}",
                        "type": "tool_call",
                    }
                    for name in ("get_workload", "get_pods", "get_events")
                ],
            )
        ]
    )
    agent = _runner(
        build_diagnostic_agent(
            model,
            tools,
            max_model_calls=8,
            max_tool_calls=3,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
        )
    )

    with pytest.raises(ToolCallLimitExceededError):
        await agent.ainvoke(
            {"messages": [{"role": "user", "content": "Diagnose the target."}]}
        )

    assert calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("max_tool_calls", "expected_calls"),
    [(2, ["get_workload"]), (1, [])],
)
async def test_mixed_final_and_evidence_batch_is_checked_as_a_whole(
    max_tool_calls: int,
    expected_calls: list[str],
) -> None:
    calls: list[str] = []
    tools = _build_tools(calls)
    candidate = _diagnosed_candidate("00000000-0000-0000-0000-000000000001")
    model = _ToolCallingFakeModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "get_workload",
                        "args": {},
                        "id": "call-workload",
                        "type": "tool_call",
                    },
                    {
                        "name": "DiagnosisCandidate",
                        "args": candidate.model_dump(mode="json"),
                        "id": "call-structured",
                        "type": "tool_call",
                    },
                ],
            )
        ]
    )
    agent = _runner(
        build_diagnostic_agent(
            model,
            tools,
            max_model_calls=8,
            max_tool_calls=max_tool_calls,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
        )
    )

    if expected_calls:
        result = await agent.ainvoke(
            {"messages": [{"role": "user", "content": "Diagnose the target."}]}
        )
        assert result["structured_response"] == candidate.model_dump(mode="json")
        assert result["tool_calls"] == 2
    else:
        with pytest.raises(ToolCallLimitExceededError):
            await agent.ainvoke(
                {"messages": [{"role": "user", "content": "Diagnose the target."}]}
            )
    assert calls == expected_calls


@pytest.mark.asyncio
async def test_a_schema_rejected_diagnosis_is_handed_back_once() -> None:
    # Only the narrative overran its budget; the cluster claims and their Evidence
    # were sound, so losing the Run over it discards a complete investigation.
    evidence_id = "00000000-0000-0000-0000-000000000004"
    model = _ToolCallingFakeModel(
        responses=[
            _schema_rejected_response(evidence_id),
            _structured_response(_diagnosed_candidate(evidence_id)),
        ]
    )
    agent = _runner(
        build_diagnostic_agent(
            model,
            _build_tools([]),
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
        )
    )

    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": "Diagnose the target."}]}
    )

    validated = DiagnosisCandidate.model_validate(result["structured_response"])
    assert validated.root_causes[0].evidence_ids == [UUID(evidence_id)]
    assert len(model.capture.requests) == 2
    assert result["model_calls"] == 2


@pytest.mark.asyncio
async def test_a_second_schema_rejection_keeps_its_own_terminal_error() -> None:
    # A repeated rejection is systematic, and retrying to the end of the budget
    # would trade the accurate error for a call-limit one.
    model = _ToolCallingFakeModel(
        responses=[_schema_rejected_response() for _ in range(6)]
    )
    agent = _runner(
        build_diagnostic_agent(
            model,
            _build_tools([]),
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
        )
    )

    with pytest.raises(StructuredDiagnosisError) as error:
        await agent.ainvoke(
            {"messages": [{"role": "user", "content": "Diagnose the target."}]}
        )

    assert error.value.code == "structured_output_invalid"
    assert len(model.capture.requests) == 2


@pytest.mark.asyncio
async def test_the_rejection_handed_back_names_fields_without_their_content() -> None:
    evidence_id = "00000000-0000-0000-0000-000000000004"
    model = _ToolCallingFakeModel(
        responses=[
            _schema_rejected_response(evidence_id),
            _structured_response(_diagnosed_candidate(evidence_id)),
        ]
    )
    agent = _runner(
        build_diagnostic_agent(
            model,
            _build_tools([]),
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
        )
    )

    await agent.ainvoke(
        {"messages": [{"role": "user", "content": "Diagnose the target."}]}
    )

    handed_back = [
        message.text
        for message in model.capture.requests[-1]
        if isinstance(message, ToolMessage)
    ]
    assert any("summary: string_too_long" in text for text in handed_back)
    assert any("max_length 1024" in text for text in handed_back)
    assert not any("s" * 40 in text for text in handed_back)


@pytest.mark.asyncio
async def test_unparsable_structured_output_is_retried_before_the_run_is_lost() -> None:
    # A truncated structured response is a formatting slip, not a claim about the
    # cluster: the budget is untouched and the next attempt usually parses.
    calls: list[str] = []
    tools = _build_tools(calls)
    evidence_id = "00000000-0000-0000-0000-000000000004"
    model = _ToolCallingFakeModel(
        responses=[
            _tool_call("get_events", "call-events"),
            _unparsable_structured_response(),
            _structured_response(_diagnosed_candidate(evidence_id)),
        ]
    )
    agent = _runner(
        build_diagnostic_agent(
            model,
            tools,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
        )
    )

    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": "Diagnose the target."}]}
    )

    validated = DiagnosisCandidate.model_validate(result["structured_response"])
    assert validated.root_causes[0].evidence_ids == [UUID(evidence_id)]


@pytest.mark.asyncio
async def test_unparsable_response_is_repaired_at_most_once() -> None:
    # A slip is transient; a second break in a row is more likely systematic, such
    # as a length cut-off, and retrying it to the end of the budget only delays
    # the failure. The default budget keeps the call limit from ending the loop
    # first, so the cap is what this observes.
    calls: list[str] = []
    tools = _build_tools(calls)
    model = _ToolCallingFakeModel(
        responses=[_unparsable_structured_response() for _ in range(6)]
    )
    agent = _runner(
        build_diagnostic_agent(
            model,
            tools,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
        )
    )

    with pytest.raises(StructuredDiagnosisError):
        await agent.ainvoke(
            {"messages": [{"role": "user", "content": "Diagnose the target."}]}
        )
    assert len(model.capture.requests) == 2


@pytest.mark.asyncio
async def test_a_parsable_or_partly_usable_batch_is_not_handed_back() -> None:
    # Two shapes that must NOT be repaired, each exercising one predicate: a
    # schema failure that parsed at all, and a batch that still carries a usable
    # tool call, whose results let the model continue on its own.
    calls: list[str] = []
    tools = _build_tools(calls)
    unrepairable = {
        "schema": AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "DiagnosisCandidate",
                    "args": {"outcome": "not-a-valid-outcome"},
                    "id": "call-schema",
                    "type": "tool_call",
                }
            ],
        ),
        "alongside_tool_call": AIMessage(
            content="",
            tool_calls=[
                {"name": "get_events", "args": {}, "id": "call-ev", "type": "tool_call"}
            ],
            invalid_tool_calls=[
                {
                    "name": "DiagnosisCandidate",
                    "args": '{"outcome": "diagnosed"',
                    "id": "call-broken",
                    "error": "Expecting ',' delimiter",
                    "type": "invalid_tool_call",
                }
            ],
        ),
    }
    for label, response in unrepairable.items():
        model = _ToolCallingFakeModel(responses=[response])
        agent = _runner(
            build_diagnostic_agent(
                model,
                tools,
                required_evidence=REQUIRED_EVIDENCE,
                prometheus_panels=PANELS,
                trigger_panel_id="image-pull-affected-pods",
            )
        )

        with suppress(StructuredDiagnosisError, ToolCallLimitExceededError):
            await agent.ainvoke(
                {"messages": [{"role": "user", "content": "Diagnose the target."}]}
            )
        # A repair answers the broken call by id, so no request may carry one.
        handed_back = [
            message
            for request in model.capture.requests
            for message in request
            if isinstance(message, ToolMessage)
            and message.tool_call_id == "call-broken"
        ]
        assert handed_back == [], label


@pytest.mark.asyncio
async def test_a_repaired_response_is_charged_to_the_call_budget() -> None:
    # The jump skips the hook that charges the call, so the repair charges it.
    # Otherwise the reserve reads a stale count and the persisted usage undercounts.
    calls: list[str] = []
    tools = _build_tools(calls)
    evidence_id = "00000000-0000-0000-0000-000000000006"
    model = _ToolCallingFakeModel(
        responses=[
            _unparsable_structured_response(),
            _structured_response(_diagnosed_candidate(evidence_id)),
        ]
    )
    agent = _runner(
        build_diagnostic_agent(
            model,
            tools,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
        )
    )

    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": "Diagnose the target."}]}
    )

    assert result["model_calls"] == len(model.capture.requests)


@pytest.mark.asyncio
async def test_a_broken_investigation_call_is_handed_back_too() -> None:
    # The same truncation on an Evidence read ends the Run with no Evidence at
    # all, which is the same loss by a different tool name.
    calls: list[str] = []
    tools = _build_tools(calls)
    evidence_id = "00000000-0000-0000-0000-000000000007"
    model = _ToolCallingFakeModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[],
                invalid_tool_calls=[
                    {
                        "name": "get_events",
                        "args": '{"names": ["a',
                        "id": "call-broken-ev",
                        "error": "Expecting ',' delimiter",
                        "type": "invalid_tool_call",
                    }
                ],
            ),
            _tool_call("get_events", "call-events"),
            _structured_response(_diagnosed_candidate(evidence_id)),
        ]
    )
    agent = _runner(
        build_diagnostic_agent(
            model,
            tools,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
        )
    )

    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": "Diagnose the target."}]}
    )

    assert calls == ["get_events"]
    validated = DiagnosisCandidate.model_validate(result["structured_response"])
    assert validated.root_causes[0].evidence_ids == [UUID(evidence_id)]


@pytest.mark.asyncio
async def test_a_break_on_the_last_permitted_call_keeps_its_own_error() -> None:
    # With no call left, a repair would only jump into the call limit and report
    # the Run as over budget when the truth is that its final response broke.
    calls: list[str] = []
    tools = _build_tools(calls)
    model = _ToolCallingFakeModel(
        responses=[
            _tool_call("get_events", "call-events"),
            _unparsable_structured_response(),
            _structured_response(
                _diagnosed_candidate("00000000-0000-0000-0000-000000000008")
            ),
        ]
    )
    agent = _runner(
        build_diagnostic_agent(
            model,
            tools,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
            max_model_calls=2,
        )
    )

    with pytest.raises(StructuredDiagnosisError):
        await agent.ainvoke(
            {"messages": [{"role": "user", "content": "Diagnose the target."}]}
        )
    assert len(model.capture.requests) == 2


@pytest.mark.asyncio
async def test_a_broken_call_without_a_name_is_not_answered() -> None:
    # Answering it would mean attributing the reply to a tool the model never named.
    calls: list[str] = []
    tools = _build_tools(calls)
    model = _ToolCallingFakeModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[],
                invalid_tool_calls=[
                    {
                        "name": None,
                        "args": '{"x": ',
                        "id": "call-nameless",
                        "error": "Expecting value",
                        "type": "invalid_tool_call",
                    }
                ],
            )
        ]
    )
    agent = _runner(
        build_diagnostic_agent(
            model,
            tools,
            required_evidence=REQUIRED_EVIDENCE,
            prometheus_panels=PANELS,
            trigger_panel_id="image-pull-affected-pods",
        )
    )

    with pytest.raises(StructuredDiagnosisError):
        await agent.ainvoke(
            {"messages": [{"role": "user", "content": "Diagnose the target."}]}
        )
    assert len(model.capture.requests) == 1
