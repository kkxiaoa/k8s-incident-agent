from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import pytest
from alembic import command
from alembic.config import Config
from langchain.tools import ToolRuntime
from langchain_core.tools import BaseTool
from tests.factories import (
    agent_run_snapshot,
    normalized_trigger,
    prometheus_query_service_stub,
)

from k8s_incident_agent.config import Settings
from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.domain.models import ModelSnapshot, RunBudget
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.client import create_kubernetes_clients
from k8s_incident_agent.kubernetes.credentials import (
    load_diagnostic_credential,
    require_credential_window,
)
from k8s_incident_agent.kubernetes.tools import build_diagnostic_tools
from k8s_incident_agent.persistence.database import create_business_database
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT, RuntimePaths
from k8s_incident_agent.scenarios.contracts import ScenarioTarget

pytestmark = pytest.mark.live_kind
SERVICE_ROOT = Path(__file__).resolve().parents[2]

_OCCURRED_AT = datetime(2026, 9, 2, 8, 30, tzinfo=UTC)


def _target() -> ScenarioTarget:
    scenario_path = (
        REPOSITORY_ROOT / "scenarios" / "image-pull-backoff" / "scenario.json"
    )
    document = cast(object, json.loads(scenario_path.read_text(encoding="utf-8")))
    assert isinstance(document, dict)
    scenario = cast(dict[str, object], document)
    return ScenarioTarget.model_validate(scenario["target"])


def _alembic_config(paths: RuntimePaths) -> Config:
    config = Config(str(SERVICE_ROOT / "alembic.ini"))
    config.attributes["runtime_paths"] = paths
    return config


async def _invoke(
    tools: tuple[BaseTool, ...],
    context: DiagnosticToolContext,
    tool_name: str,
    tool_call_id: str,
) -> dict[str, object]:
    tool = next(candidate for candidate in tools if candidate.name == tool_name)
    runtime = ToolRuntime[DiagnosticToolContext, dict[str, object]](
        state={},
        context=context,
        config={},
        stream_writer=lambda _chunk: None,
        tool_call_id=tool_call_id,
        store=None,
        tools=list(tools),
    )
    result = await tool.ainvoke({"runtime": runtime})
    assert isinstance(result, dict)
    untyped = cast(dict[object, object], result)
    assert all(isinstance(key, str) for key in untyped)
    return {cast(str, key): value for key, value in untyped.items()}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "order",
    (
        ("get_workload", "get_rollout_history", "get_pods", "get_events"),
        ("get_pods", "get_events", "get_workload", "get_rollout_history"),
        ("get_events", "get_rollout_history", "get_workload", "get_pods"),
    ),
)
async def test_fixed_kind_tools_persist_four_fresh_observations(
    tmp_path: Path,
    order: tuple[str, str, str, str],
) -> None:
    settings = Settings()  # pyright: ignore[reportCallIssue]
    started_at = datetime.now(UTC)
    credential = load_diagnostic_credential(settings.runtime_paths, started_at)
    require_credential_window(credential, 240, started_at)
    clients = await create_kubernetes_clients(
        credential,
        timeout_seconds=settings.kubernetes_timeout_seconds,
        cluster_id=settings.kubernetes_cluster_id,
        diagnostic_namespace=settings.kubernetes_diagnostic_namespace,
    )
    try:
        paths = RuntimePaths.prepare(tmp_path / "runtime")
        command.upgrade(_alembic_config(paths), "head")
        database = await create_business_database(paths)
        try:
            target = _target()
            repository = IncidentRepository(database.session_factory)
            created = await repository.create_incident_and_run(
                normalized_trigger(),
                ModelSnapshot(
                    provider="deepseek",
                    model_id=settings.model_name,
                    thinking_mode=False,
                    prompt_version="stage1-v1",
                ),
                RunBudget(max_model_calls=8, max_tool_calls=6, timeout_seconds=180),
            )
            await repository.start_run(created.run_id, started_at)
            context = DiagnosticToolContext(
                run=await agent_run_snapshot(repository, created.run_id),
                target=target,
                credential=credential,
                adapter=KubernetesEvidenceAdapter(clients),
                repository=repository,
                now=lambda: datetime.now(UTC),
                prometheus=prometheus_query_service_stub(),
                occurred_at=_OCCURRED_AT,
            )
            tools = build_diagnostic_tools()

            results = [
                await _invoke(tools, context, tool_name, f"call-{index}")
                for index, tool_name in enumerate(order, start=1)
            ]

            assert [result["evidenceKind"] for result in results] == [
                name.removeprefix("get_") for name in order
            ]
            assert len({result["evidenceId"] for result in results}) == 4
        finally:
            await database.dispose()
    finally:
        await clients.close()
