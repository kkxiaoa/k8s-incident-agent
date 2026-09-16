from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any, cast, override
from uuid import UUID, uuid4

import pytest
from langchain.agents.middleware.model_call_limit import (
    ModelCallLimitExceededError,
)
from langchain.agents.middleware.tool_call_limit import ToolCallLimitExceededError
from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.base import LanguageModelInput
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, AnyMessage, BaseMessage, HumanMessage
from langchain_core.outputs import ChatResult
from langchain_core.runnables import Runnable
from langchain_core.runnables.config import RunnableConfig
from langchain_core.tools import BaseTool, tool
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import (  # pyright: ignore[reportMissingTypeStubs]
    END,
    START,
    StateGraph,
)
from langgraph.graph.message import (  # pyright: ignore[reportMissingTypeStubs]
    add_messages,
)
from langgraph.graph.state import (  # pyright: ignore[reportMissingTypeStubs]
    CompiledStateGraph,
)
from pydantic import PrivateAttr
from tests.factories import prometheus_query_service_stub
from typing_extensions import TypedDict

from k8s_incident_agent.diagnosis.agent import build_diagnostic_agent
from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.diagnosis.contracts import DiagnosisCandidate
from k8s_incident_agent.diagnosis.policy import DiagnosticPolicy
from k8s_incident_agent.diagnosis.policy_contracts import DiagnosticPanel
from k8s_incident_agent.domain.contracts import IncidentSource
from k8s_incident_agent.domain.models import (
    AgentRunSnapshot,
    DiagnosisWorkflowRunSnapshot,
    ModelSnapshot,
    RunBudget,
    RunRecord,
    RunStatus,
    TerminalRecord,
)
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredential
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.scenarios.contracts import ScenarioTarget
from k8s_incident_agent.workflow.checkpoint import open_checkpoint_store
from k8s_incident_agent.workflow.graph import GraphDependencies, build_incident_graph

NOW = datetime(2026, 8, 24, 9, 0, tzinfo=UTC)
EVIDENCE_ID = "00000000-0000-0000-0000-000000000001"
TEST_POLICY = DiagnosticPolicy(
    tool_names=("get_workload", "get_pods", "get_events", "query_prometheus"),
    required_evidence=frozenset({"workload"}),
    prometheus_panels=(
        DiagnosticPanel("image-pull-affected-pods", "Affected pods", "pods"),
    ),
    trigger_panel_id="image-pull-affected-pods",
)


class _BudgetState(TypedDict, total=False):
    messages: Annotated[list[AnyMessage], add_messages]
    structured_response: dict[str, object]
    model_calls: int
    tool_calls: int


class _ToolCallingFakeModel(FakeMessagesListChatModel):
    _calls: int = PrivateAttr(default=0)

    @property
    def calls(self) -> int:
        return self._calls

    @override
    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type | Callable[..., Any] | BaseTool],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable[LanguageModelInput, AIMessage]:
        del tools, tool_choice, kwargs
        return cast("Runnable[LanguageModelInput, AIMessage]", self)

    @override
    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        self._calls += 1
        return super()._generate(
            messages,
            stop=stop,
            run_manager=run_manager,
            **kwargs,
        )


def _tool_call(name: str, call_id: str) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": {}, "id": call_id, "type": "tool_call"}],
    )


def _structured_response(candidate: DiagnosisCandidate) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": "DiagnosisCandidate",
                "args": candidate.model_dump(mode="json"),
                "id": "call-structured",
                "type": "tool_call",
            }
        ],
    )


def _tools() -> tuple[BaseTool, BaseTool, BaseTool, BaseTool]:
    @tool("get_workload")
    async def get_workload() -> dict[str, str]:
        """Read normalized workload evidence."""
        return {"evidenceId": EVIDENCE_ID}

    @tool("get_pods")
    async def get_pods() -> dict[str, str]:
        """Read normalized pod evidence."""
        return {"evidenceId": EVIDENCE_ID}

    @tool("get_events")
    async def get_events() -> dict[str, str]:
        """Read normalized event evidence."""
        return {"evidenceId": EVIDENCE_ID}

    @tool("query_prometheus")
    async def query_prometheus(panel_id: str, window: str) -> dict[str, str]:
        """Read one catalog-owned Prometheus panel."""
        del panel_id, window
        return {"evidenceId": EVIDENCE_ID}

    return get_workload, get_pods, get_events, query_prometheus


def _budget_graph(
    saver: AsyncSqliteSaver,
    model: _ToolCallingFakeModel,
    *,
    max_model_calls: int,
    max_tool_calls: int,
) -> CompiledStateGraph[
    _BudgetState,
    DiagnosticToolContext,
    _BudgetState,
    _BudgetState,
]:
    agent = build_diagnostic_agent(
        model,
        _tools(),
        max_model_calls=max_model_calls,
        max_tool_calls=max_tool_calls,
        required_evidence=("workload",),
        prometheus_panels=(
            DiagnosticPanel("image-pull-affected-pods", "Affected pods", "pods"),
        ),
        trigger_panel_id="image-pull-affected-pods",
    )
    builder = StateGraph(_BudgetState, context_schema=DiagnosticToolContext)
    builder.add_node(  # pyright: ignore[reportUnknownMemberType]
        "diagnose", agent
    )
    builder.add_edge(START, "diagnose")
    builder.add_edge("diagnose", END)
    return builder.compile(  # pyright: ignore[reportUnknownMemberType]
        checkpointer=saver
    )


def _context(
    *,
    run_id: UUID | None = None,
    started_at: datetime = NOW,
    timeout_seconds: int = 180,
    repository: object | None = None,
) -> DiagnosticToolContext:
    return DiagnosticToolContext(
        run=AgentRunSnapshot(
            id=run_id or uuid4(),
            started_at=started_at,
            timeout_seconds=timeout_seconds,
        ),
        target=_target(),
        credential=_credential(),
        adapter=cast(KubernetesEvidenceAdapter, object()),
        repository=cast(IncidentRepository, repository or object()),
        now=lambda: NOW,
        prometheus=prometheus_query_service_stub(),
    )


def _target() -> ScenarioTarget:
    return ScenarioTarget(
        cluster="k8s-incident-agent",
        namespace="k8s-incident-scenarios",
        api_version="apps/v1",
        kind="Deployment",
        name="image-pull-backoff",
    )


def _credential() -> DiagnosticCredential:
    return DiagnosticCredential(
        kubeconfig_path=Path("/unused/diagnostic.kubeconfig"),
        context_name="kind-k8s-incident-agent",
        server_url="https://127.0.0.1:6443",
        expires_at=NOW + timedelta(hours=1),
        _kubeconfig={},
    )


@pytest.mark.asyncio
async def test_model_call_counter_survives_checkpoint_reopen(tmp_path: Path) -> None:
    checkpoint_path = tmp_path / "checkpoints.sqlite3"
    config: RunnableConfig = {"configurable": {"thread_id": "model-budget"}}
    first_model = _ToolCallingFakeModel(
        responses=[_tool_call("get_workload", "call-workload")]
    )
    async with open_checkpoint_store(checkpoint_path) as saver:
        graph = _budget_graph(
            saver,
            first_model,
            max_model_calls=1,
            max_tool_calls=6,
        )
        with pytest.raises(ModelCallLimitExceededError):
            await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                {"messages": [HumanMessage(content="Diagnose the target.")]},
                config,
                context=_context(),
                durability="sync",
            )
    assert first_model.calls == 1

    rebuilt_model = _ToolCallingFakeModel(
        responses=[_tool_call("get_workload", "unexpected-call")]
    )
    async with open_checkpoint_store(checkpoint_path) as saver:
        rebuilt_graph = _budget_graph(
            saver,
            rebuilt_model,
            max_model_calls=1,
            max_tool_calls=6,
        )
        with pytest.raises(ModelCallLimitExceededError):
            await rebuilt_graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                None,
                config,
                context=_context(),
                durability="sync",
            )

    assert rebuilt_model.calls == 0


@pytest.mark.asyncio
async def test_tool_call_counter_survives_checkpoint_reopen(tmp_path: Path) -> None:
    checkpoint_path = tmp_path / "checkpoints.sqlite3"
    config: RunnableConfig = {"configurable": {"thread_id": "tool-budget"}}
    candidate = DiagnosisCandidate.model_validate(
        {
            "outcome": "diagnosed",
            "summary": "The workload observation supports a diagnosis.",
            "root_causes": [
                {
                    "code": "workload_failure",
                    "statement": "The workload observation reports a failure.",
                    "confidence": "high",
                    "evidence_ids": [EVIDENCE_ID],
                }
            ],
            "missing_information": [],
        }
    )
    # Two tool calls: one evidence read plus the final response. A second evidence
    # read would spend the reserved final slot, so the runtime refuses it.
    responses: list[BaseMessage] = [
        _tool_call("get_workload", "call-workload"),
        _tool_call("get_pods", "call-pods"),
        _structured_response(candidate),
    ]
    first_model = _ToolCallingFakeModel(responses=responses)
    async with open_checkpoint_store(checkpoint_path) as saver:
        graph = _budget_graph(
            saver,
            first_model,
            max_model_calls=4,
            max_tool_calls=2,
        )
        with pytest.raises(ToolCallLimitExceededError):
            await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                {"messages": [HumanMessage(content="Diagnose the target.")]},
                config,
                context=_context(),
                durability="sync",
            )
    assert first_model.calls == 2

    rebuilt_model = _ToolCallingFakeModel(responses=responses)
    async with open_checkpoint_store(checkpoint_path) as saver:
        rebuilt_graph = _budget_graph(
            saver,
            rebuilt_model,
            max_model_calls=4,
            max_tool_calls=2,
        )
        with pytest.raises(ToolCallLimitExceededError):
            await rebuilt_graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                None,
                config,
                context=_context(),
                durability="sync",
            )

    assert rebuilt_model.calls == 0


class _ExpiredRunRepository:
    def __init__(self, run: DiagnosisWorkflowRunSnapshot) -> None:
        self.run = run
        self.terminals: list[TerminalRecord] = []
        self.start_calls = 0

    async def get_workflow_run_snapshot(
        self, run_id: object
    ) -> DiagnosisWorkflowRunSnapshot:
        assert run_id == self.run.id
        return self.run

    async def start_run(self, run_id: object, started_at: datetime) -> RunRecord:
        del run_id, started_at
        self.start_calls += 1
        raise AssertionError("expired runs must not replay start_run")

    async def persist_terminal(self, terminal: TerminalRecord) -> object:
        self.terminals.append(terminal)
        return object()


@pytest.mark.asyncio
async def test_absolute_deadline_comes_from_persisted_started_at(
    tmp_path: Path,
) -> None:
    started_at = NOW - timedelta(seconds=181)
    run = DiagnosisWorkflowRunSnapshot(
        id=uuid4(),
        incident_id=uuid4(),
        source=IncidentSource(
            type="scenario",
            ref="image-pull-backoff",
            revision="1",
        ),
        run_status=RunStatus.RUNNING,
        trigger_summary="The target Deployment is unavailable.",
        target=_target(),
        model=ModelSnapshot(
            provider="deepseek",
            model_id="deepseek-v4-flash",
            thinking_mode=False,
            prompt_version="stage1-v1",
        ),
        budget=RunBudget(
            max_model_calls=8,
            max_tool_calls=6,
            timeout_seconds=180,
        ),
        started_at=started_at,
    )
    repository = _ExpiredRunRepository(run)
    model = _ToolCallingFakeModel(responses=[AIMessage(content="unused")])
    async with open_checkpoint_store(tmp_path / "checkpoints.sqlite3") as saver:
        graph = build_incident_graph(
            GraphDependencies(
                repository=cast(IncidentRepository, repository),
                checkpointer=saver,
                model=model,
                model_snapshot=ModelSnapshot(
                    provider="deepseek",
                    model_id="deepseek-v4-flash",
                    thinking_mode=False,
                    prompt_version="stage1-v1",
                ),
                credential=_credential(),
                adapter=cast(KubernetesEvidenceAdapter, object()),
                prometheus=prometheus_query_service_stub(),
                now=lambda: NOW,
            ),
            run,
            TEST_POLICY,
        )
        await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            {"run_id": str(run.id)},
            {"configurable": {"thread_id": str(run.id)}},
            context=_context(
                run_id=run.id,
                started_at=started_at,
                timeout_seconds=run.budget.timeout_seconds,
                repository=repository,
            ),
            durability="sync",
        )

    assert repository.start_calls == 0
    assert model.calls == 0
    assert len(repository.terminals) == 1
    assert repository.terminals[0].error_code == "agent_timeout"
    assert repository.terminals[0].model_calls is None
    assert repository.terminals[0].tool_calls is None
