"""Offline integration of the target-bounded investigation through the real graph.

Only the model and the Kubernetes upstream are replaced. The policy comes from the
production catalogs, tool calls run through the production tools, the repository
persists into a temporary SQLite database, and the diagnosis passes the production
validator.
"""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator, Callable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast, override
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from langchain_core.language_models.base import LanguageModelInput
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.runnables import Runnable
from langchain_core.runnables.config import RunnableConfig
from langchain_core.tools import BaseTool
from pydantic import PrivateAttr
from sqlalchemy import select
from tests.factories import prometheus_query_service_stub

from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.diagnosis.policy import DiagnosticPolicyCatalog
from k8s_incident_agent.diagnosis.tool_execution import observation_limit_output
from k8s_incident_agent.domain.contracts import (
    IncidentSource,
    KubernetesTarget,
    NormalizedIncidentTrigger,
)
from k8s_incident_agent.domain.models import (
    AgentRunSnapshot,
    DiagnosisWorkflowRunSnapshot,
    ModelSnapshot,
    RunBudget,
    RunStatus,
)
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.contracts import (
    ReplicaSummary,
    Selector,
    ServiceCandidatePod,
    ServiceDetail,
    ServiceNetworkObservation,
    ServiceNetworkPayload,
    ServiceNetworkSummary,
    TargetRef,
    WorkloadDetail,
    WorkloadObservation,
    WorkloadPayload,
)
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredential
from k8s_incident_agent.monitoring.catalog import load_alert_catalog
from k8s_incident_agent.persistence.database import (
    BusinessDatabase,
    create_business_database,
)
from k8s_incident_agent.persistence.models import DiagnosisRow, EvidenceRow, RunRow
from k8s_incident_agent.persistence.repositories import IncidentRepository, evidence_id
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT, RuntimePaths
from k8s_incident_agent.scenarios.catalog import load_scenario_catalog
from k8s_incident_agent.workflow.checkpoint import open_checkpoint_store
from k8s_incident_agent.workflow.graph import GraphDependencies, build_incident_graph

SERVICE_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 9, 16, 9, 0, tzinfo=UTC)
NAMESPACE = "k8s-incident-scenarios"
DEPLOYMENT_TOOLS = (
    "get_workload",
    "get_rollout_history",
    "get_pods",
    "get_events",
    "get_container_logs",
    "query_prometheus",
)


class _CapturingModel(FakeMessagesListChatModel):
    _bound_tool_names: list[tuple[str, ...]] = PrivateAttr(
        default_factory=list[tuple[str, ...]]
    )

    @property
    def bound_tool_names(self) -> list[tuple[str, ...]]:
        return self._bound_tool_names

    @override
    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type | Callable[..., Any] | BaseTool],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable[LanguageModelInput, AIMessage]:
        del tool_choice, kwargs
        self._bound_tool_names.append(
            tuple(
                bound.name if isinstance(bound, BaseTool) else str(bound)
                for bound in tools
            )
        )
        return cast("Runnable[LanguageModelInput, AIMessage]", self)


class _Adapter:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def read_workload(self, target: KubernetesTarget) -> WorkloadObservation:
        self.calls.append("get_workload")
        return WorkloadObservation(
            evidence_kind="workload",
            target_ref=TargetRef(
                api_version="apps/v1",
                kind="Deployment",
                namespace=NAMESPACE,
                name=target.name,
                uid="deployment-uid",
            ),
            observed_at=NOW + timedelta(seconds=len(self.calls)),
            payload=WorkloadPayload(
                workload=WorkloadDetail(
                    resource_version=str(len(self.calls)),
                    generation=1,
                    observed_generation=1,
                    replicas=ReplicaSummary(desired=1, updated=1, ready=0, available=0),
                    selector=Selector(match_labels={"app": target.name}),
                    containers=[],
                    conditions=[],
                )
            ),
            truncated=False,
            redacted=False,
        )

    async def read_service_network(
        self,
        target: KubernetesTarget,
    ) -> ServiceNetworkObservation:
        self.calls.append("get_service_network")
        return ServiceNetworkObservation(
            evidence_kind="service_network",
            target_ref=TargetRef(
                api_version="v1",
                kind="Service",
                namespace=NAMESPACE,
                name=target.name,
                uid="service-uid",
            ),
            observed_at=NOW,
            payload=ServiceNetworkPayload(
                service=ServiceDetail(
                    resource_version="1",
                    service_type="ClusterIP",
                    cluster_ip="10.96.0.10",
                    selector=Selector(match_labels={"app": "wrong"}),
                    monitoring_enabled=True,
                    publish_not_ready_addresses=False,
                ),
                summary=ServiceNetworkSummary(
                    state="selector_mismatch",
                    candidate_count=1,
                    selector_match_count=0,
                    endpoint_slice_count=0,
                    ready_endpoint_count=0,
                ),
                candidate_pods=[
                    ServiceCandidatePod(
                        pod_ref=TargetRef(
                            api_version="v1",
                            kind="Pod",
                            namespace=NAMESPACE,
                            name="backend-0",
                            uid="pod-uid",
                        ),
                        resource_version="1",
                        selector_labels={"app": "backend"},
                        matches_selector=False,
                        ready=True,
                    )
                ],
                endpoint_slices=[],
            ),
            truncated=False,
            redacted=False,
        )


@dataclass(frozen=True, slots=True)
class _Outcome:
    status: RunStatus
    error_code: str | None
    tool_calls: int | None
    diagnosis_outcome: str | None
    evidence_tool_call_ids: list[str]
    tool_messages: list[dict[str, object]]
    bound_tool_names: list[tuple[str, ...]]
    adapter_calls: list[str]


def _trigger(scenario_id: str, revision: str, kind: str) -> NormalizedIncidentTrigger:
    return NormalizedIncidentTrigger(
        source=IncidentSource(type="scenario", ref=scenario_id, revision=revision),
        display_name=scenario_id,
        trigger_summary="The target is unhealthy.",
        target=KubernetesTarget(
            cluster="k8s-incident-agent",
            namespace=NAMESPACE,
            api_version="apps/v1" if kind == "Deployment" else "v1",
            kind=kind,
            name=scenario_id,
        ),
    )


def _model_snapshot() -> ModelSnapshot:
    return ModelSnapshot(
        provider="deepseek",
        model_id="deepseek-flash",
        thinking_mode=False,
        prompt_version="stage3-dc2-target-investigation-v6",
    )


def _credential() -> DiagnosticCredential:
    return DiagnosticCredential(
        kubeconfig_path=Path("/unused/diagnostic.kubeconfig"),
        context_name="kind-k8s-incident-agent",
        server_url="https://127.0.0.1:6443",
        expires_at=NOW + timedelta(hours=1),
        _kubeconfig={},
    )


def _tool_call(name: str, call_id: str) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": {}, "id": call_id, "type": "tool_call"}],
    )


def _diagnosed(run_id: UUID, cited_call_ids: Sequence[str]) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": "DiagnosisCandidate",
                "args": {
                    "outcome": "diagnosed",
                    "summary": "The cited observations explain the symptom.",
                    "root_causes": [
                        {
                            "code": "observed_failure",
                            "statement": "The observed configuration causes the failure.",
                            "confidence": "high",
                            "evidence_ids": [
                                str(evidence_id(run_id, call_id))
                                for call_id in cited_call_ids
                            ],
                        }
                    ],
                    "missing_information": [],
                },
                "id": "call-structured",
                "type": "tool_call",
            }
        ],
    )


@asynccontextmanager
async def _database(
    tmp_path: Path,
) -> AsyncGenerator[tuple[RuntimePaths, BusinessDatabase]]:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    config = Config(str(SERVICE_ROOT / "alembic.ini"))
    config.attributes["runtime_paths"] = paths
    command.upgrade(config, "head")
    database = await create_business_database(paths)
    try:
        yield paths, database
    finally:
        await database.dispose()


async def _run_diagnosis(
    tmp_path: Path,
    *,
    trigger: NormalizedIncidentTrigger,
    responses_for: Callable[[UUID], list[BaseMessage]],
) -> _Outcome:
    policies = DiagnosticPolicyCatalog(
        scenarios=load_scenario_catalog(REPOSITORY_ROOT / "scenarios"),
        alerts=load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog"),
    )
    adapter = _Adapter()
    async with _database(tmp_path) as (paths, database):
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            trigger,
            _model_snapshot(),
            RunBudget(max_model_calls=12, max_tool_calls=12, timeout_seconds=180),
        )
        run = await repository.get_workflow_run_snapshot(created.run_id)
        assert isinstance(run, DiagnosisWorkflowRunSnapshot)
        policy = policies.resolve(run.source, run.target)
        model = _CapturingModel(responses=responses_for(run.id))
        config: RunnableConfig = {"configurable": {"thread_id": str(run.id)}}
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            graph = build_incident_graph(
                GraphDependencies(
                    repository=repository,
                    checkpointer=saver,
                    model=model,
                    model_snapshot=_model_snapshot(),
                    credential=_credential(),
                    adapter=cast(KubernetesEvidenceAdapter, adapter),
                    prometheus=prometheus_query_service_stub(),
                    now=lambda: NOW,
                ),
                run,
                policy,
            )
            await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                {"run_id": str(run.id)},
                config,
                context=DiagnosticToolContext(
                    run=AgentRunSnapshot(
                        id=run.id, started_at=NOW, timeout_seconds=180
                    ),
                    target=run.target,
                    credential=_credential(),
                    adapter=cast(KubernetesEvidenceAdapter, adapter),
                    repository=repository,
                    now=lambda: NOW,
                    prometheus=prometheus_query_service_stub(),
                ),
                durability="sync",
            )
            state = await graph.aget_state(  # pyright: ignore[reportUnknownMemberType]
                config
            )
        async with database.session_factory() as session:
            row = await session.get(RunRow, str(run.id))
            assert row is not None
            diagnosis = await session.scalar(
                select(DiagnosisRow).where(DiagnosisRow.run_id == str(run.id))
            )
            evidence_rows = list(
                await session.scalars(
                    select(EvidenceRow).where(EvidenceRow.run_id == str(run.id))
                )
            )
        messages = cast(list[object], cast(dict[str, object], state.values)["messages"])
        return _Outcome(
            status=row.status,
            error_code=row.error_code,
            tool_calls=row.tool_calls,
            diagnosis_outcome=None if diagnosis is None else diagnosis.outcome.value,
            evidence_tool_call_ids=sorted(item.tool_call_id for item in evidence_rows),
            tool_messages=[
                cast(dict[str, object], json.loads(str(message.content)))
                for message in messages
                if isinstance(message, ToolMessage)
                and message.name != "DiagnosisCandidate"
            ],
            bound_tool_names=model.bound_tool_names,
            adapter_calls=adapter.calls,
        )


@pytest.mark.asyncio
async def test_deployment_incident_reads_twice_then_is_refused_and_still_diagnoses(
    tmp_path: Path,
) -> None:
    # A CrashLoop scenario now offers the whole Deployment capability; the model
    # re-reads the workload once (admitted), is refused the third read, and still
    # delivers a diagnosis anchored on the identity Evidence alone.
    outcome = await _run_diagnosis(
        tmp_path,
        trigger=_trigger("crash-loop-backoff", "2", "Deployment"),
        responses_for=lambda run_id: [
            _tool_call("get_workload", "call-1"),
            _tool_call("get_workload", "call-2"),
            _tool_call("get_workload", "call-3"),
            _diagnosed(run_id, ["call-1"]),
        ],
    )

    assert outcome.status is RunStatus.COMPLETED
    assert outcome.error_code is None
    assert outcome.diagnosis_outcome == "diagnosed"
    assert outcome.adapter_calls == ["get_workload", "get_workload"]
    assert outcome.evidence_tool_call_ids == ["call-1", "call-2"]
    assert outcome.tool_calls == 4
    assert outcome.tool_messages[2] == observation_limit_output("get_workload")
    assert set(outcome.bound_tool_names[0]) == {*DEPLOYMENT_TOOLS, "DiagnosisCandidate"}


@pytest.mark.asyncio
async def test_service_incident_registers_only_the_service_capability(
    tmp_path: Path,
) -> None:
    outcome = await _run_diagnosis(
        tmp_path,
        trigger=_trigger("service-selector-mismatch", "1", "Service"),
        responses_for=lambda run_id: [
            _tool_call("get_service_network", "call-1"),
            _diagnosed(run_id, ["call-1"]),
        ],
    )

    assert outcome.status is RunStatus.COMPLETED
    assert outcome.diagnosis_outcome == "diagnosed"
    assert outcome.adapter_calls == ["get_service_network"]
    assert outcome.bound_tool_names[0] == (
        "get_service_network",
        "query_prometheus",
        "DiagnosisCandidate",
    )
