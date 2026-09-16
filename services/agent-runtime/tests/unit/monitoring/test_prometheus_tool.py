from __future__ import annotations

import json
from collections.abc import AsyncGenerator, Awaitable, Callable, Sequence
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
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
from sqlalchemy import func, select
from tests.factories import agent_run_snapshot, normalized_trigger

from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.diagnosis.tool_execution import (
    DiagnosticToolFatalError,
    observation_limit_output,
)
from k8s_incident_agent.domain.models import AgentRunSnapshot, ModelSnapshot, RunBudget
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredential
from k8s_incident_agent.monitoring.contracts import (
    MetricPanelPayload,
    MetricPanelResult,
    MetricQueryState,
    MetricRiskDirection,
    MetricSample,
    MetricTargetRef,
    MetricWindow,
    PrometheusObservation,
)
from k8s_incident_agent.monitoring.errors import (
    MonitoringBoundaryError,
    MonitoringErrorCode,
)
from k8s_incident_agent.monitoring.service import PrometheusQueryService
from k8s_incident_agent.monitoring.tools import (
    FatalPrometheusToolError,
    build_prometheus_tool,
)
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
NOW = datetime(2026, 9, 2, 9, 0, tzinfo=UTC)
PANEL_ID = "image-pull-affected-pods"
TARGET = ScenarioTarget(
    cluster="k8s-incident-agent",
    namespace="k8s-incident-scenarios",
    api_version="apps/v1",
    kind="Deployment",
    name="image-pull-backoff",
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


def _credential() -> DiagnosticCredential:
    return DiagnosticCredential(
        kubeconfig_path=Path("/unused/diagnostic.kubeconfig"),
        context_name="kind-k8s-incident-agent",
        server_url="https://127.0.0.1:6443",
        expires_at=NOW + timedelta(hours=1),
        _kubeconfig={},
    )


def _observation(
    panel_id: str = PANEL_ID,
    window: MetricWindow = MetricWindow.FIFTEEN_MINUTES,
) -> PrometheusObservation:
    return PrometheusObservation(
        evidence_kind="metrics",
        target_ref=MetricTargetRef(
            cluster=TARGET.cluster,
            namespace=cast(str, TARGET.namespace),
            api_version=TARGET.api_version,
            kind=TARGET.kind,
            name=TARGET.name,
        ),
        observed_at=NOW,
        payload=MetricPanelPayload(
            result=MetricPanelResult(
                panel_id=panel_id,
                title="Affected pods",
                unit="pods",
                threshold=1.0,
                risk_direction=MetricRiskDirection.HIGHER_IS_WORSE,
                window=window,
                state=MetricQueryState.OK,
                queried_at=NOW,
                latest_sample_at=NOW,
                current_value=1.0,
                samples=[MetricSample(timestamp=NOW, value=1.0)],
            )
        ),
    )


class _Prometheus:
    def __init__(
        self,
        *,
        error: MonitoringBoundaryError | None = None,
        before_query: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self.error = error
        self.before_query = before_query
        self.calls: list[tuple[ScenarioTarget, str, MetricWindow]] = []

    async def observe_panel(
        self,
        *,
        target: ScenarioTarget,
        panel_id: str,
        window: MetricWindow,
    ) -> PrometheusObservation:
        self.calls.append((target, panel_id, window))
        if self.before_query is not None:
            await self.before_query()
        if self.error is not None:
            raise self.error
        return _observation(panel_id, window)


async def _context(
    repository: IncidentRepository,
    prometheus: _Prometheus,
) -> DiagnosticToolContext:
    created = await repository.create_incident_and_run(
        normalized_trigger(),
        ModelSnapshot(
            provider="deepseek",
            model_id="deepseek-v4-flash",
            thinking_mode=False,
            prompt_version="stage2-crashloop-v1",
        ),
        RunBudget(max_model_calls=8, max_tool_calls=6, timeout_seconds=180),
    )
    await repository.start_run(created.run_id, NOW)
    snapshot = await agent_run_snapshot(repository, created.run_id)
    assert isinstance(snapshot, AgentRunSnapshot)
    return DiagnosticToolContext(
        run=snapshot,
        target=TARGET,
        credential=_credential(),
        adapter=cast(KubernetesEvidenceAdapter, object()),
        repository=repository,
        now=lambda: NOW + timedelta(seconds=30),
        prometheus=cast(PrometheusQueryService, prometheus),
    )


async def _invoke(
    tools: Sequence[BaseTool],
    context: DiagnosticToolContext,
    *,
    tool_call_id: str,
    panel_id: str = PANEL_ID,
    window: str = "15m",
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
                                "name": "query_prometheus",
                                "args": {"panel_id": panel_id, "window": window},
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
    parsed = json.loads(message.content)
    assert isinstance(parsed, dict)
    return cast(dict[str, object], parsed)


def test_registry_exposes_only_panel_and_window_to_the_model() -> None:
    tool = build_prometheus_tool()

    assert tool.name == "query_prometheus"
    assert set(tool.args) == {"panel_id", "window"}


@pytest.mark.asyncio
async def test_success_records_started_before_query_and_replays_without_requery(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        events_before_query: list[str] = []

        async def capture_events() -> None:
            async with database.session_factory() as session:
                rows = await session.scalars(
                    select(RunEventRow).order_by(RunEventRow.id)
                )
                events_before_query.extend(row.event_type for row in rows)

        prometheus = _Prometheus(before_query=capture_events)
        context = await _context(repository, prometheus)
        tools = (build_prometheus_tool(),)

        first = await _invoke(tools, context, tool_call_id="call-metrics")
        replay = await _invoke(tools, context, tool_call_id="call-metrics")

        assert events_before_query[-1] == "tool.started"
        assert prometheus.calls == [(TARGET, PANEL_ID, MetricWindow.FIFTEEN_MINUTES)]
        assert replay == first
        assert first["evidenceId"] == str(evidence_id(context.run.id, "call-metrics"))
        assert first["evidenceKind"] == "metrics"
        assert "queryTemplate" not in json.dumps(first)
        assert "promql" not in json.dumps(first).casefold()
        async with database.session_factory() as session:
            evidence_count = await session.scalar(
                select(func.count()).select_from(EvidenceRow)
            )
            started = await session.scalar(
                select(RunEventRow).where(RunEventRow.event_type == "tool.started")
            )
        assert evidence_count == 1
        assert started is not None
        assert json.loads(started.payload_json)["callIdentity"] == {
            "panelId": PANEL_ID,
            "window": "15m",
        }


@pytest.mark.asyncio
async def test_success_replay_rejects_changed_panel_arguments(tmp_path: Path) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        prometheus = _Prometheus()
        context = await _context(repository, prometheus)
        tools = (build_prometheus_tool(),)
        await _invoke(tools, context, tool_call_id="call-metrics")

        with pytest.raises(DiagnosticToolFatalError) as error:
            await _invoke(
                tools,
                context,
                tool_call_id="call-metrics",
                panel_id="image-pull-available-replicas",
            )

        assert error.value.code == "recovery_consistency_error"
        assert len(prometheus.calls) == 1


@pytest.mark.asyncio
async def test_retryable_failure_is_persisted_and_replayed_without_requery(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        prometheus = _Prometheus(
            error=MonitoringBoundaryError(MonitoringErrorCode.REQUEST_TIMEOUT)
        )
        context = await _context(repository, prometheus)
        tools = (build_prometheus_tool(),)

        first = await _invoke(tools, context, tool_call_id="call-timeout")
        replay = await _invoke(tools, context, tool_call_id="call-timeout")

        assert (
            first
            == replay
            == {
                "code": "monitoring_request_timeout",
                "retryable": True,
                "message": "Prometheus request timed out",
            }
        )
        assert len(prometheus.calls) == 1


@pytest.mark.asyncio
async def test_failure_replay_rejects_changed_query_arguments(tmp_path: Path) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        prometheus = _Prometheus(
            error=MonitoringBoundaryError(MonitoringErrorCode.REQUEST_TIMEOUT)
        )
        context = await _context(repository, prometheus)
        tools = (build_prometheus_tool(),)
        await _invoke(tools, context, tool_call_id="call-timeout")

        with pytest.raises(DiagnosticToolFatalError) as error:
            await _invoke(
                tools,
                context,
                tool_call_id="call-timeout",
                panel_id="image-pull-available-replicas",
            )

        assert error.value.code == "recovery_consistency_error"
        assert len(prometheus.calls) == 1


@pytest.mark.asyncio
async def test_success_with_different_query_identity_does_not_resolve_failure(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        prometheus = _Prometheus(
            error=MonitoringBoundaryError(MonitoringErrorCode.REQUEST_TIMEOUT)
        )
        context = await _context(repository, prometheus)
        tools = (build_prometheus_tool(),)
        await _invoke(tools, context, tool_call_id="call-timeout")

        prometheus.error = None
        await _invoke(
            tools,
            context,
            tool_call_id="call-success",
            panel_id="image-pull-available-replicas",
        )

        snapshot = await repository.get_diagnosis_validation_snapshot(context.run.id)
        assert [
            failure.tool_call_id for failure in snapshot.unresolved_tool_failures
        ] == ["call-timeout"]


@pytest.mark.asyncio
async def test_success_with_matching_query_identity_resolves_retryable_failure(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        prometheus = _Prometheus(
            error=MonitoringBoundaryError(MonitoringErrorCode.REQUEST_TIMEOUT)
        )
        context = await _context(repository, prometheus)
        tools = (build_prometheus_tool(),)
        await _invoke(tools, context, tool_call_id="call-timeout")

        prometheus.error = None
        await _invoke(tools, context, tool_call_id="call-success")

        snapshot = await repository.get_diagnosis_validation_snapshot(context.run.id)
        assert snapshot.unresolved_tool_failures == ()


@pytest.mark.asyncio
async def test_nonretryable_failure_is_terminal_and_replayed_without_requery(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        prometheus = _Prometheus(
            error=MonitoringBoundaryError(MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID)
        )
        context = await _context(repository, prometheus)
        tools = (build_prometheus_tool(),)

        for _ in range(2):
            with pytest.raises(FatalPrometheusToolError) as error:
                await _invoke(tools, context, tool_call_id="call-invalid")
            assert error.value.code is MonitoringErrorCode.UPSTREAM_CONTRACT_INVALID

        assert len(prometheus.calls) == 1


@pytest.mark.asyncio
async def test_third_query_of_the_same_panel_and_window_is_refused(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        prometheus = _Prometheus()
        context = await _context(repository, prometheus)
        tools = (build_prometheus_tool(),)

        first = await _invoke(tools, context, tool_call_id="call-1")
        second = await _invoke(tools, context, tool_call_id="call-2")
        refused = await _invoke(tools, context, tool_call_id="call-3")
        other_window = await _invoke(tools, context, tool_call_id="call-4", window="1h")

        assert first["evidenceId"] != second["evidenceId"]
        assert refused == observation_limit_output("query_prometheus")
        assert "evidenceId" in other_window
        assert [call[2].value for call in prometheus.calls] == ["15m", "15m", "1h"]
        assert (
            await repository.get_tool_outcome(
                context.run.id,
                "call-3",
                "query_prometheus",
                {"panelId": PANEL_ID, "window": "15m"},
            )
            is None
        )
