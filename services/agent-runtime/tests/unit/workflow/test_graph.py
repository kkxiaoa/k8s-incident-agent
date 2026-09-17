from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol, cast, override
from uuid import uuid4

import pytest
from langchain.agents.middleware.model_call_limit import (
    ModelCallLimitExceededError,
)
from langchain.agents.middleware.tool_call_limit import ToolCallLimitExceededError
from langchain_core.language_models.base import LanguageModelInput
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langchain_core.runnables import Runnable
from langchain_core.runnables.config import RunnableConfig
from langchain_core.tools import BaseTool
from pydantic import PrivateAttr
from tests.factories import prometheus_query_service_stub

from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.diagnosis.policy import DiagnosticPolicy
from k8s_incident_agent.diagnosis.policy_contracts import DiagnosticPanel
from k8s_incident_agent.domain.contracts import IncidentSource
from k8s_incident_agent.domain.models import (
    AgentRunSnapshot,
    DiagnosisValidationSnapshot,
    DiagnosisWorkflowRunSnapshot,
    IncidentStatus,
    ModelSnapshot,
    RunBudget,
    RunEvent,
    RunRecord,
    RunStatus,
    TerminalRecord,
    ToolFailureRecord,
)
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredential
from k8s_incident_agent.kubernetes.errors import KubernetesErrorCode
from k8s_incident_agent.kubernetes.tools import FatalDiagnosticToolError
from k8s_incident_agent.monitoring.errors import MonitoringErrorCode
from k8s_incident_agent.monitoring.tools import FatalPrometheusToolError
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.scenarios.contracts import ScenarioTarget
from k8s_incident_agent.workflow.checkpoint import open_checkpoint_store
from k8s_incident_agent.workflow.graph import (
    GraphDependencies,
    IncidentGraph,
    classify_diagnosis_failure,
)
from k8s_incident_agent.workflow.graph import (
    build_incident_graph as _build_incident_graph,
)

NOW = datetime(2026, 8, 24, 9, 0, tzinfo=UTC)
TEST_POLICY = DiagnosticPolicy(
    tool_names=("get_workload", "get_pods", "get_events", "query_prometheus"),
    required_evidence=frozenset({"workload"}),
    prometheus_panels=(
        DiagnosticPanel(
            "image-pull-affected-pods",
            "Affected pods",
            "pods",
            "Registered purpose.",
            "target",
            "higher_is_worse",
        ),
    ),
    trigger_panel_id="image-pull-affected-pods",
)

_OCCURRED_AT = datetime(2026, 9, 2, 8, 30, tzinfo=UTC)


class _SubgraphView(Protocol):
    checkpointer: object | None


class _ToolCallingFakeModel(FakeMessagesListChatModel):
    _model_calls: int = PrivateAttr(default=0)

    @property
    def model_calls(self) -> int:
        return self._model_calls

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
    async def _agenerate(self, *args: Any, **kwargs: Any) -> Any:
        self._model_calls += 1
        return await super()._agenerate(*args, **kwargs)


class _WorkflowRepository:
    def __init__(self, snapshot: DiagnosisWorkflowRunSnapshot) -> None:
        self.snapshot = snapshot
        self.started_at: datetime | None = None
        self.terminals: list[TerminalRecord] = []
        self.validation_snapshot = DiagnosisValidationSnapshot(
            evidence_by_id={},
            tool_failures=(),
            unresolved_tool_failures=(),
        )

    async def get_workflow_run_snapshot(
        self,
        run_id: object,
    ) -> DiagnosisWorkflowRunSnapshot:
        assert run_id == self.snapshot.id
        return self.snapshot

    async def start_run(self, run_id: object, started_at: datetime) -> RunRecord:
        assert run_id == self.snapshot.id
        self.started_at = started_at
        return RunRecord(
            id=self.snapshot.id,
            incident_id=self.snapshot.incident_id,
            status=RunStatus.RUNNING,
            incident_status=IncidentStatus.TRIAGING,
            started_at=started_at,
            event=RunEvent(
                id=1,
                incident_id=self.snapshot.incident_id,
                run_id=self.snapshot.id,
                event_key="run.started",
                event_type="run.started",
                occurred_at=started_at,
                payload={},
            ),
        )

    async def persist_terminal(self, terminal: TerminalRecord) -> object:
        self.terminals.append(terminal)
        return object()

    async def get_diagnosis_validation_snapshot(
        self,
        run_id: object,
    ) -> DiagnosisValidationSnapshot:
        assert run_id == self.snapshot.id
        return self.validation_snapshot


def _snapshot(*, model_id: str = "deepseek-v4-flash") -> DiagnosisWorkflowRunSnapshot:
    return DiagnosisWorkflowRunSnapshot(
        id=uuid4(),
        incident_id=uuid4(),
        source=IncidentSource(
            type="scenario",
            ref="image-pull-backoff",
            revision="1",
        ),
        run_status=RunStatus.QUEUED,
        trigger_summary="The target Deployment is unavailable.",
        target=ScenarioTarget(
            cluster="k8s-incident-agent",
            namespace="k8s-incident-scenarios",
            api_version="apps/v1",
            kind="Deployment",
            name="image-pull-backoff",
        ),
        model=ModelSnapshot(
            provider="deepseek",
            model_id=model_id,
            thinking_mode=False,
            prompt_version="stage1-v1",
        ),
        budget=RunBudget(
            max_model_calls=8,
            max_tool_calls=6,
            timeout_seconds=180,
        ),
        started_at=None,
        occurred_at=_OCCURRED_AT,
    )


def build_incident_graph(
    dependencies: GraphDependencies,
    run: DiagnosisWorkflowRunSnapshot,
) -> IncidentGraph:
    return _build_incident_graph(dependencies, run, TEST_POLICY)


def _credential() -> DiagnosticCredential:
    return DiagnosticCredential(
        kubeconfig_path=Path("/unused/diagnostic.kubeconfig"),
        context_name="kind-k8s-incident-agent",
        server_url="https://127.0.0.1:6443",
        expires_at=NOW + timedelta(hours=1),
        _kubeconfig={},
    )


def _context(run: DiagnosisWorkflowRunSnapshot) -> DiagnosticToolContext:
    return DiagnosticToolContext(
        run=AgentRunSnapshot(
            id=run.id,
            started_at=NOW,
            timeout_seconds=run.budget.timeout_seconds,
        ),
        target=run.target,
        credential=_credential(),
        adapter=cast(KubernetesEvidenceAdapter, object()),
        repository=cast(IncidentRepository, object()),
        now=lambda: NOW,
        prometheus=prometheus_query_service_stub(),
        occurred_at=_OCCURRED_AT,
    )


def _dependencies(
    saver: object,
    repository: _WorkflowRepository,
    model: _ToolCallingFakeModel,
    *,
    model_id: str = "deepseek-v4-flash",
) -> GraphDependencies:
    return GraphDependencies(
        repository=cast(IncidentRepository, repository),
        checkpointer=cast(Any, saver),
        model=model,
        model_snapshot=ModelSnapshot(
            provider="deepseek",
            model_id=model_id,
            thinking_mode=False,
            prompt_version="stage1-v1",
        ),
        credential=_credential(),
        adapter=cast(KubernetesEvidenceAdapter, object()),
        prometheus=prometheus_query_service_stub(),
        now=lambda: NOW,
    )


def _insufficient_response() -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": "DiagnosisCandidate",
                "args": {
                    "outcome": "insufficient_evidence",
                    "summary": "A system failure prevented complete observation.",
                    "root_causes": [],
                    "missing_information": ["A successful read is still required."],
                },
                "id": "call-structured",
                "type": "tool_call",
            }
        ],
    )


@pytest.mark.asyncio
async def test_graph_has_exact_domain_topology_and_direct_agent_subgraph(
    tmp_path: Path,
) -> None:
    run = _snapshot()
    repository = _WorkflowRepository(run)
    model = _ToolCallingFakeModel(responses=[AIMessage(content="unused")])
    async with open_checkpoint_store(tmp_path / "checkpoints.sqlite3") as saver:
        graph = build_incident_graph(_dependencies(saver, repository, model), run)

        regular_nodes = {
            name
            for name, node in graph.nodes.items()
            if name != "__start__" and not node.is_error_handler
        }
        subgraphs = cast(
            list[tuple[str, _SubgraphView]],
            list(
                graph.get_subgraphs()  # pyright: ignore[reportUnknownMemberType, reportUnknownArgumentType]
            ),
        )
        edges = {
            (edge.source, edge.target)
            for edge in graph.get_graph().edges
            if not edge.conditional
        }

    assert regular_nodes == {
        "start_run",
        "triage_target",
        "diagnose",
        "validate_diagnosis",
        "validate_repair_schema",
        "validate_repair_policy",
        "validate_repair_diff",
        "validate_repair_dry_run",
        "persist_terminal_state",
    }
    assert edges == {
        ("__start__", "start_run"),
        ("start_run", "triage_target"),
        ("triage_target", "diagnose"),
        ("diagnose", "validate_diagnosis"),
        ("validate_diagnosis", "validate_repair_schema"),
        ("validate_repair_schema", "validate_repair_policy"),
        ("validate_repair_policy", "validate_repair_diff"),
        ("validate_repair_diff", "validate_repair_dry_run"),
        ("validate_repair_dry_run", "persist_terminal_state"),
        ("persist_terminal_state", "__end__"),
    }
    assert len(subgraphs) == 1
    assert subgraphs[0][0] == "diagnose"
    assert subgraphs[0][1].checkpointer is None


@pytest.mark.asyncio
async def test_graph_input_drops_internal_state_injection(tmp_path: Path) -> None:
    run = _snapshot()
    repository = _WorkflowRepository(run)
    model = _ToolCallingFakeModel(responses=[AIMessage(content="unused")])
    config: RunnableConfig = {"configurable": {"thread_id": str(run.id)}}
    async with open_checkpoint_store(tmp_path / "checkpoints.sqlite3") as saver:
        graph = build_incident_graph(_dependencies(saver, repository, model), run)

        await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            cast(
                Any,
                {
                    "run_id": str(run.id),
                    "messages": [AIMessage(content="injected")],
                    "structured_response": {"outcome": "diagnosed"},
                    "model_calls": 999,
                    "tool_calls": 999,
                    "terminal_error_code": "injected",
                    "terminal_error_retryable": True,
                },
            ),
            config,
            context=_context(run),
            interrupt_before=["start_run"],
            durability="sync",
        )
        state = await graph.aget_state(config)

    assert state.values == {"run_id": str(run.id), "messages": []}
    assert state.next == ("start_run",)


@pytest.mark.asyncio
async def test_triage_validates_target_without_model_or_kubernetes_call(
    tmp_path: Path,
) -> None:
    run = _snapshot()
    repository = _WorkflowRepository(run)
    model = _ToolCallingFakeModel(responses=[AIMessage(content="unused")])
    config: RunnableConfig = {"configurable": {"thread_id": str(run.id)}}
    async with open_checkpoint_store(tmp_path / "checkpoints.sqlite3") as saver:
        graph = build_incident_graph(_dependencies(saver, repository, model), run)

        result = await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            {"run_id": str(run.id)},
            config,
            context=_context(run),
            interrupt_after=["triage_target"],
            durability="sync",
        )

    assert repository.started_at == NOW
    assert model.model_calls == 0
    assert result["target"] == run.target.model_dump(mode="json")
    assert len(result["messages"]) == 1
    assert '"occurredAt":"2026-09-02T08:30:00Z"' in result["messages"][0].content


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "persisted_model",
    [
        ModelSnapshot(
            provider="another-provider",
            model_id="deepseek-v4-flash",
            thinking_mode=False,
            prompt_version="stage1-v1",
        ),
        ModelSnapshot(
            provider="deepseek",
            model_id="another-model",
            thinking_mode=False,
            prompt_version="stage1-v1",
        ),
        ModelSnapshot(
            provider="deepseek",
            model_id="deepseek-v4-flash",
            thinking_mode=True,
            prompt_version="stage1-v1",
        ),
        ModelSnapshot(
            provider="deepseek",
            model_id="deepseek-v4-flash",
            thinking_mode=False,
            prompt_version="previous-prompt",
        ),
    ],
    ids=("provider", "model-id", "thinking-mode", "prompt-version"),
)
async def test_model_snapshot_mismatch_fails_before_model_call(
    tmp_path: Path,
    persisted_model: ModelSnapshot,
) -> None:
    run = replace(_snapshot(), model=persisted_model)
    repository = _WorkflowRepository(run)
    model = _ToolCallingFakeModel(responses=[AIMessage(content="unused")])
    config: RunnableConfig = {"configurable": {"thread_id": str(run.id)}}
    async with open_checkpoint_store(tmp_path / "checkpoints.sqlite3") as saver:
        graph = build_incident_graph(_dependencies(saver, repository, model), run)

        await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            {"run_id": str(run.id)},
            config,
            context=_context(run),
            durability="sync",
        )

    assert model.model_calls == 0
    assert repository.started_at is None
    assert len(repository.terminals) == 1
    assert repository.terminals[0].error_code == "recovery_consistency_error"
    assert repository.terminals[0].error_retryable is False


@pytest.mark.asyncio
async def test_triage_rejects_out_of_scope_target_without_kubernetes_call(
    tmp_path: Path,
) -> None:
    scheduled = _snapshot()
    run = replace(
        scheduled,
        target=scheduled.target.model_copy(update={"kind": "StatefulSet"}),
    )
    repository = _WorkflowRepository(run)
    model = _ToolCallingFakeModel(responses=[AIMessage(content="unused")])
    async with open_checkpoint_store(tmp_path / "checkpoints.sqlite3") as saver:
        graph = build_incident_graph(_dependencies(saver, repository, model), run)

        await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            {"run_id": str(run.id)},
            {"configurable": {"thread_id": str(run.id)}},
            context=_context(run),
            durability="sync",
        )

    assert repository.started_at == NOW
    assert model.model_calls == 0
    assert len(repository.terminals) == 1
    assert repository.terminals[0].error_code == "recovery_consistency_error"


@pytest.mark.asyncio
async def test_plain_model_output_persists_structured_failure(tmp_path: Path) -> None:
    run = _snapshot()
    repository = _WorkflowRepository(run)
    model = _ToolCallingFakeModel(responses=[AIMessage(content="fluent fallback")])
    async with open_checkpoint_store(tmp_path / "checkpoints.sqlite3") as saver:
        graph = build_incident_graph(_dependencies(saver, repository, model), run)

        await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            {"run_id": str(run.id)},
            {"configurable": {"thread_id": str(run.id)}},
            context=_context(run),
            durability="sync",
        )

    assert model.model_calls == 1
    assert len(repository.terminals) == 1
    assert repository.terminals[0].error_code == "structured_output_invalid"
    assert repository.terminals[0].error_retryable is False
    assert repository.terminals[0].model_calls is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("code", "retryable"),
    [
        (KubernetesErrorCode.AUTHENTICATION_FAILED, False),
        (KubernetesErrorCode.PERMISSION_DENIED, False),
        (KubernetesErrorCode.RESOURCE_NOT_FOUND, False),
        (KubernetesErrorCode.REQUEST_TIMEOUT, True),
        (KubernetesErrorCode.UPSTREAM_UNAVAILABLE, True),
        (KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID, False),
        (KubernetesErrorCode.RESULT_BUDGET_EXCEEDED, False),
        (KubernetesErrorCode.RECOVERY_CONSISTENCY_ERROR, False),
    ],
)
async def test_unresolved_kubernetes_failure_becomes_matching_terminal_error(
    tmp_path: Path,
    code: KubernetesErrorCode,
    retryable: bool,
) -> None:
    run = _snapshot()
    repository = _WorkflowRepository(run)
    failure = ToolFailureRecord(
        run_id=run.id,
        tool_call_id="call-failed",
        tool_name="get_workload",
        error_code=code.value,
        retryable=retryable,
        occurred_at=NOW,
    )
    repository.validation_snapshot = DiagnosisValidationSnapshot(
        evidence_by_id={},
        tool_failures=(failure,),
        unresolved_tool_failures=(failure,),
    )
    model = _ToolCallingFakeModel(responses=[_insufficient_response()])
    async with open_checkpoint_store(tmp_path / "checkpoints.sqlite3") as saver:
        graph = build_incident_graph(_dependencies(saver, repository, model), run)

        await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            {"run_id": str(run.id)},
            {"configurable": {"thread_id": str(run.id)}},
            context=_context(run),
            durability="sync",
        )

    assert len(repository.terminals) == 1
    assert repository.terminals[0].error_code == code.value
    assert repository.terminals[0].error_retryable is retryable
    assert repository.terminals[0].model_calls == 1
    assert repository.terminals[0].tool_calls == 1


@pytest.mark.parametrize(
    ("error", "expected_code"),
    [
        (
            ModelCallLimitExceededError(
                thread_count=1,
                run_count=1,
                thread_limit=1,
                run_limit=None,
            ),
            "model_call_limit_exceeded",
        ),
        (
            ToolCallLimitExceededError(
                thread_count=2,
                run_count=2,
                thread_limit=1,
                run_limit=None,
            ),
            "tool_call_limit_exceeded",
        ),
        (
            FatalDiagnosticToolError(KubernetesErrorCode.PERMISSION_DENIED),
            "permission_denied",
        ),
        (
            FatalPrometheusToolError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID),
            "prometheus_contract_invalid",
        ),
    ],
)
def test_diagnosis_exceptions_keep_distinct_terminal_codes(
    error: Exception,
    expected_code: str,
) -> None:
    assert classify_diagnosis_failure(error) == (expected_code, False)
