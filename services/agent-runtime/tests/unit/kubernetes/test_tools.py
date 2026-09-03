from __future__ import annotations

import json
from collections.abc import AsyncGenerator, Awaitable, Callable, Sequence
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from itertools import permutations
from pathlib import Path
from typing import cast

import pytest
from alembic import command
from alembic.config import Config
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import BaseTool
from langgraph.graph import (  # pyright: ignore[reportMissingTypeStubs]
    END,
    START,
    MessagesState,
    StateGraph,
)
from langgraph.prebuilt import ToolNode
from sqlalchemy import select
from tests.factories import (
    agent_run_snapshot,
    normalized_trigger,
    prometheus_query_service_stub,
)

from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.domain.models import (
    AgentRunSnapshot,
    ModelSnapshot,
    RunBudget,
)
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.contracts import (
    ContainerLogsObservation,
    ContainerLogsPayload,
    EventsObservation,
    EventsPayload,
    PodsObservation,
    PodsPayload,
    ReplicaSummary,
    Selector,
    ServiceCandidatePod,
    ServiceDetail,
    ServiceNetworkObservation,
    ServiceNetworkPayload,
    ServiceNetworkSummary,
    SourceWorkload,
    TargetRef,
    WorkloadDetail,
    WorkloadObservation,
    WorkloadPayload,
)
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredential
from k8s_incident_agent.kubernetes.tools import build_diagnostic_tools
from k8s_incident_agent.persistence.database import (
    BusinessDatabase,
    create_business_database,
)
from k8s_incident_agent.persistence.models import EvidenceRow, RunEventRow
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    evidence_id,
)
from k8s_incident_agent.runtime.paths import RuntimePaths
from k8s_incident_agent.scenarios.contracts import ScenarioTarget

SERVICE_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 21, 10, 0, tzinfo=UTC)
DEPLOYMENT_TOOL_NAMES = (
    "get_workload",
    "get_pods",
    "get_events",
    "get_container_logs",
)
TOOL_NAMES = (*DEPLOYMENT_TOOL_NAMES, "get_service_network")
TARGET = ScenarioTarget(
    cluster="k8s-incident-agent",
    namespace="k8s-incident-scenarios",
    api_version="apps/v1",
    kind="Deployment",
    name="image-pull-backoff",
)
SERVICE_TARGET = ScenarioTarget(
    cluster="k8s-incident-agent",
    namespace="k8s-incident-scenarios",
    api_version="v1",
    kind="Service",
    name="service-selector-mismatch",
)


def _alembic_config(paths: RuntimePaths) -> Config:
    config = Config(str(SERVICE_ROOT / "alembic.ini"))
    config.attributes["runtime_paths"] = paths
    return config


@asynccontextmanager
async def _database(tmp_path: Path) -> AsyncGenerator[BusinessDatabase]:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await create_business_database(paths)
    try:
        yield database
    finally:
        await database.dispose()


def _scenario(target: ScenarioTarget = TARGET):
    return normalized_trigger(target.name).model_copy(update={"target": target})


def _credential() -> DiagnosticCredential:
    return DiagnosticCredential(
        kubeconfig_path=Path("/ignored/diagnostic.kubeconfig"),
        context_name="kind-k8s-incident-agent",
        server_url="https://127.0.0.1:6443",
        expires_at=NOW + timedelta(hours=1),
        _kubeconfig={},
    )


class _ObservationAdapter:
    def __init__(
        self,
        before_read: Callable[[str], Awaitable[None]] | None = None,
        *,
        expected_target: ScenarioTarget = TARGET,
    ) -> None:
        self.calls: list[str] = []
        self._before_read = before_read
        self._expected_target = expected_target

    async def read_workload(self, target: ScenarioTarget) -> WorkloadObservation:
        call_index = await self._record("get_workload", target)
        return WorkloadObservation(
            evidence_kind="workload",
            target_ref=_target_ref(),
            observed_at=NOW + timedelta(seconds=call_index),
            payload=WorkloadPayload(
                workload=WorkloadDetail(
                    resource_version=str(call_index),
                    generation=1,
                    observed_generation=1,
                    replicas=ReplicaSummary(
                        desired=1,
                        updated=1,
                        ready=0,
                        available=0,
                    ),
                    selector=Selector(match_labels={"app": "broken-image"}),
                    containers=[],
                    conditions=[],
                )
            ),
            truncated=False,
            redacted=False,
        )

    async def read_pods(self, target: ScenarioTarget) -> PodsObservation:
        call_index = await self._record("get_pods", target)
        return PodsObservation(
            evidence_kind="pods",
            target_ref=_target_ref(),
            observed_at=NOW + timedelta(seconds=call_index),
            payload=PodsPayload(
                source_workload=SourceWorkload(
                    resource_version=str(call_index),
                    selector=Selector(match_labels={"app": "broken-image"}),
                ),
                pods=[],
            ),
            truncated=False,
            redacted=False,
        )

    async def read_events(self, target: ScenarioTarget) -> EventsObservation:
        call_index = await self._record("get_events", target)
        return EventsObservation(
            evidence_kind="events",
            target_ref=_target_ref(),
            observed_at=NOW + timedelta(seconds=call_index),
            payload=EventsPayload(
                source_workload=SourceWorkload(
                    resource_version=str(call_index),
                    selector=Selector(match_labels={"app": "broken-image"}),
                ),
                associated_replica_set_count=0,
                associated_pod_count=0,
                events=[],
            ),
            truncated=False,
            redacted=False,
        )

    async def read_container_logs(
        self,
        target: ScenarioTarget,
    ) -> ContainerLogsObservation:
        call_index = await self._record("get_container_logs", target)
        return ContainerLogsObservation(
            evidence_kind="container_logs",
            target_ref=_target_ref(),
            observed_at=NOW + timedelta(seconds=call_index),
            payload=ContainerLogsPayload(
                source_workload=SourceWorkload(
                    resource_version=str(call_index),
                    selector=Selector(match_labels={"app": "broken-image"}),
                ),
                containers=[],
            ),
            truncated=False,
            redacted=False,
        )

    async def read_service_network(
        self,
        target: ScenarioTarget,
    ) -> ServiceNetworkObservation:
        call_index = await self._record("get_service_network", target)
        service_ref = TargetRef(
            api_version="v1",
            kind="Service",
            namespace=cast(str, SERVICE_TARGET.namespace),
            name=SERVICE_TARGET.name,
            uid="service-uid",
        )
        return ServiceNetworkObservation(
            evidence_kind="service_network",
            target_ref=service_ref,
            observed_at=NOW + timedelta(seconds=call_index),
            payload=ServiceNetworkPayload(
                service=ServiceDetail(
                    resource_version=str(call_index),
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
                            namespace=cast(str, SERVICE_TARGET.namespace),
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

    async def _record(self, tool_name: str, target: ScenarioTarget) -> int:
        assert target == self._expected_target
        self.calls.append(tool_name)
        if self._before_read is not None:
            await self._before_read(tool_name)
        return len(self.calls)


def _target_ref() -> TargetRef:
    return TargetRef(
        api_version="apps/v1",
        kind="Deployment",
        namespace=cast(str, TARGET.namespace),
        name=TARGET.name,
        uid="deployment-uid",
    )


async def _context(
    repository: IncidentRepository,
    adapter: _ObservationAdapter,
    *,
    target: ScenarioTarget = TARGET,
) -> DiagnosticToolContext:
    created = await repository.create_incident_and_run(
        _scenario(target),
        ModelSnapshot(
            provider="deepseek",
            model_id="deepseek-v4-flash",
            thinking_mode=False,
            prompt_version="stage1-v1",
        ),
        RunBudget(max_model_calls=8, max_tool_calls=6, timeout_seconds=180),
    )
    await repository.start_run(created.run_id, NOW)
    snapshot = await agent_run_snapshot(repository, created.run_id)
    assert isinstance(snapshot, AgentRunSnapshot)
    return DiagnosticToolContext(
        run=snapshot,
        target=target,
        credential=_credential(),
        adapter=cast("KubernetesEvidenceAdapter", adapter),
        repository=repository,
        now=lambda: NOW + timedelta(seconds=30),
        prometheus=prometheus_query_service_stub(),
    )


async def _invoke(
    tools: Sequence[BaseTool],
    context: DiagnosticToolContext,
    tool_name: str,
    tool_call_id: str,
) -> dict[str, object]:
    builder = StateGraph(MessagesState, context_schema=DiagnosticToolContext)
    builder.add_node(  # pyright: ignore[reportUnknownMemberType]
        "tools", ToolNode(tools, handle_tool_errors=False)
    )
    builder.add_edge(START, "tools")
    builder.add_edge("tools", END)
    graph = builder.compile()  # pyright: ignore[reportUnknownMemberType]
    result = cast(
        MessagesState,
        await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            {
                "messages": [
                    AIMessage(
                        content="",
                        tool_calls=[
                            {
                                "name": tool_name,
                                "args": {},
                                "id": tool_call_id,
                                "type": "tool_call",
                            }
                        ],
                    )
                ]
            },
            context=context,
        ),
    )
    message = result["messages"][-1]
    assert isinstance(message, ToolMessage)
    assert isinstance(message.content, str)
    parsed = cast(object, json.loads(message.content))
    assert isinstance(parsed, dict)
    untyped = cast(dict[object, object], parsed)
    assert all(isinstance(key, str) for key in untyped)
    return {cast(str, key): value for key, value in untyped.items()}


def test_registry_is_exact_and_runtime_context_is_hidden_from_model() -> None:
    tools = build_diagnostic_tools()

    assert tuple(tool.name for tool in tools) == TOOL_NAMES
    assert all(tool.args == {} for tool in tools)


@pytest.mark.asyncio
@pytest.mark.parametrize("order", tuple(permutations(DEPLOYMENT_TOOL_NAMES)))
async def test_each_tool_is_order_independent(
    tmp_path: Path,
    order: tuple[str, ...],
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        adapter = _ObservationAdapter()
        context = await _context(repository, adapter)
        tools = build_diagnostic_tools()

        results = [
            await _invoke(tools, context, tool_name, f"call-{index}")
            for index, tool_name in enumerate(order, start=1)
        ]

        assert adapter.calls == list(order)
        assert [result["evidenceKind"] for result in results] == [
            name.removeprefix("get_") for name in order
        ]


@pytest.mark.asyncio
async def test_success_records_started_before_read_and_returns_persisted_evidence(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        events_seen_before_read: list[str] = []

        async def capture_events(_tool_name: str) -> None:
            async with database.session_factory() as session:
                rows = await session.scalars(
                    select(RunEventRow).order_by(RunEventRow.id)
                )
                events_seen_before_read.extend(row.event_type for row in rows)

        adapter = _ObservationAdapter(capture_events)
        context = await _context(repository, adapter)
        output = await _invoke(
            build_diagnostic_tools(),
            context,
            "get_workload",
            "call-workload",
        )

        assert events_seen_before_read[-1] == "tool.started"
        assert set(output) == {
            "evidenceId",
            "evidenceKind",
            "targetRef",
            "observedAt",
            "payload",
            "truncated",
            "redacted",
        }
        assert output["evidenceId"] == str(evidence_id(context.run.id, "call-workload"))
        assert output["evidenceKind"] == "workload"
        assert output["payload"] == {
            "workload": {
                "resourceVersion": "1",
                "generation": 1,
                "observedGeneration": 1,
                "replicas": {
                    "desired": 1,
                    "updated": 1,
                    "ready": 0,
                    "available": 0,
                },
                "selector": {"matchLabels": {"app": "broken-image"}},
                "containers": [],
                "conditions": [],
            }
        }

        async with database.session_factory() as session:
            evidence = await session.scalar(select(EvidenceRow))
            events = list(
                await session.scalars(select(RunEventRow).order_by(RunEventRow.id))
            )
        assert evidence is not None
        assert evidence.id == output["evidenceId"]
        assert evidence.payload_json == json.dumps(
            output["payload"],
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        assert [event.event_type for event in events[-2:]] == [
            "tool.started",
            "evidence.recorded",
        ]


@pytest.mark.asyncio
async def test_service_network_tool_persists_and_replays_its_typed_observation(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        adapter = _ObservationAdapter(expected_target=SERVICE_TARGET)
        context = await _context(repository, adapter, target=SERVICE_TARGET)
        tools = build_diagnostic_tools()

        first = await _invoke(
            tools,
            context,
            "get_service_network",
            "call-service-network",
        )
        replay = await _invoke(
            tools,
            context,
            "get_service_network",
            "call-service-network",
        )

        assert adapter.calls == ["get_service_network"]
        assert replay == first
        assert first["evidenceKind"] == "service_network"
        assert first["payload"] == {
            "service": {
                "resourceVersion": "1",
                "serviceType": "ClusterIP",
                "clusterIp": "10.96.0.10",
                "selector": {"matchLabels": {"app": "wrong"}},
                "monitoringEnabled": True,
                "publishNotReadyAddresses": False,
            },
            "summary": {
                "state": "selector_mismatch",
                "candidateCount": 1,
                "selectorMatchCount": 0,
                "endpointSliceCount": 0,
                "readyEndpointCount": 0,
            },
            "candidatePods": [
                {
                    "podRef": {
                        "apiVersion": "v1",
                        "kind": "Pod",
                        "namespace": "k8s-incident-scenarios",
                        "name": "backend-0",
                        "uid": "pod-uid",
                    },
                    "resourceVersion": "1",
                    "selectorLabels": {"app": "backend"},
                    "matchesSelector": False,
                    "ready": True,
                }
            ],
            "endpointSlices": [],
        }


@pytest.mark.asyncio
async def test_new_tool_call_reobserves_without_cross_call_cache(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        adapter = _ObservationAdapter()
        context = await _context(repository, adapter)
        tools = build_diagnostic_tools()

        first = await _invoke(tools, context, "get_workload", "call-1")
        second = await _invoke(tools, context, "get_workload", "call-2")

        assert adapter.calls == ["get_workload", "get_workload"]
        assert first["payload"] != second["payload"]
        assert first["evidenceId"] != second["evidenceId"]
