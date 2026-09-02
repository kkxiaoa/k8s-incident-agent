from __future__ import annotations

from collections.abc import AsyncGenerator, Sequence
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

import pytest
from alembic import command
from alembic.config import Config
from langchain.tools import ToolRuntime
from langchain_core.tools import BaseTool
from sqlalchemy import select
from tests.factories import (
    agent_run_snapshot,
    normalized_trigger,
    prometheus_query_service_stub,
)

from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.domain.models import EvidenceRecord, ModelSnapshot, RunBudget
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.contracts import (
    EventsObservation,
    PodsObservation,
    WorkloadObservation,
)
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredential
from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    KubernetesErrorCode,
)
from k8s_incident_agent.kubernetes.tools import (
    FatalDiagnosticToolError,
    build_diagnostic_tools,
)
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.persistence.database import (
    BusinessDatabase,
    create_business_database,
)
from k8s_incident_agent.persistence.models import RunEventRow, RunRow
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.runtime.paths import RuntimePaths
from k8s_incident_agent.scenarios.contracts import ScenarioTarget

SERVICE_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 21, 11, 0, tzinfo=UTC)
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


class _SequencedAdapter:
    def __init__(
        self,
        outcomes: Sequence[KubernetesErrorCode | None] = (),
    ) -> None:
        self.calls: list[str] = []
        self._outcomes = list(outcomes)

    async def read_workload(self, target: ScenarioTarget) -> WorkloadObservation:
        call_index = self._start("get_workload", target)
        return WorkloadObservation.model_validate(
            _observation_document("workload", call_index)
        )

    async def read_pods(self, target: ScenarioTarget) -> PodsObservation:
        call_index = self._start("get_pods", target)
        return PodsObservation.model_validate(_observation_document("pods", call_index))

    async def read_events(self, target: ScenarioTarget) -> EventsObservation:
        call_index = self._start("get_events", target)
        return EventsObservation.model_validate(
            _observation_document("events", call_index)
        )

    def _start(self, tool_name: str, target: ScenarioTarget) -> int:
        assert target == TARGET
        self.calls.append(tool_name)
        if self._outcomes:
            outcome = self._outcomes.pop(0)
            if outcome is not None:
                raise KubernetesBoundaryError(outcome)
        return len(self.calls)


def _observation_document(
    evidence_kind: str,
    call_index: int,
) -> dict[str, object]:
    common: dict[str, object] = {
        "evidenceKind": evidence_kind,
        "targetRef": {
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "namespace": TARGET.namespace,
            "name": TARGET.name,
            "uid": "deployment-uid",
        },
        "observedAt": NOW + timedelta(seconds=call_index),
        "truncated": False,
        "redacted": False,
    }
    source_workload = {
        "resourceVersion": str(call_index),
        "selector": {"matchLabels": {"app": "broken-image"}},
    }
    if evidence_kind == "workload":
        common["payload"] = {
            "workload": {
                **source_workload,
                "generation": 1,
                "observedGeneration": 1,
                "replicas": {
                    "desired": 1,
                    "updated": 1,
                    "ready": 0,
                    "available": 0,
                },
                "containers": [],
                "conditions": [],
            }
        }
    elif evidence_kind == "pods":
        common["payload"] = {"sourceWorkload": source_workload, "pods": []}
    elif evidence_kind == "events":
        common["payload"] = {
            "sourceWorkload": source_workload,
            "associatedReplicaSetCount": 0,
            "associatedPodCount": 0,
            "events": [],
        }
    else:
        raise AssertionError("Unsupported evidence kind")
    return common


def _scenario():
    return normalized_trigger()


async def _context(
    repository: IncidentRepository,
    adapter: _SequencedAdapter,
    *,
    credential_expires_at: datetime = NOW + timedelta(hours=1),
) -> DiagnosticToolContext:
    created = await repository.create_incident_and_run(
        _scenario(),
        ModelSnapshot(
            provider="deepseek",
            model_id="deepseek-v4-flash",
            thinking_mode=False,
            prompt_version="stage1-v1",
        ),
        RunBudget(max_model_calls=8, max_tool_calls=6, timeout_seconds=180),
    )
    await repository.start_run(created.run_id, NOW)
    return DiagnosticToolContext(
        run=await agent_run_snapshot(repository, created.run_id),
        target=TARGET,
        credential=DiagnosticCredential(
            kubeconfig_path=Path("/ignored/diagnostic.kubeconfig"),
            context_name="kind-k8s-incident-agent",
            server_url="https://127.0.0.1:6443",
            expires_at=credential_expires_at,
            _kubeconfig={},
        ),
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
async def test_success_replay_returns_persisted_evidence_without_kubernetes(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        adapter = _SequencedAdapter()
        context = await _context(repository, adapter)
        tools = build_diagnostic_tools()

        first = await _invoke(tools, context, "get_pods", "call-1")
        replayed = await _invoke(tools, context, "get_pods", "call-1")
        reobserved = await _invoke(tools, context, "get_pods", "call-2")

        assert replayed == first
        assert reobserved["evidenceId"] != first["evidenceId"]
        assert adapter.calls == ["get_pods", "get_pods"]


@pytest.mark.asyncio
async def test_replay_rejects_evidence_outside_the_normalized_tool_contract(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        adapter = _SequencedAdapter()
        context = await _context(repository, adapter)
        await repository.record_tool_started(
            context.run.id,
            "call-invalid",
            "get_pods",
        )
        await repository.record_evidence(
            EvidenceRecord(
                run_id=context.run.id,
                tool_call_id="call-invalid",
                tool_name="get_pods",
                evidence_kind="pods",
                target_ref={
                    "apiVersion": "apps/v1",
                    "kind": "Deployment",
                    "namespace": TARGET.namespace,
                    "name": TARGET.name,
                    "uid": "deployment-uid",
                },
                observed_at=NOW,
                payload={"notPods": []},
                truncated=False,
                redacted=False,
            )
        )

        with pytest.raises(FatalDiagnosticToolError) as invalid:
            await _invoke(
                build_diagnostic_tools(),
                context,
                "get_pods",
                "call-invalid",
            )

        assert invalid.value.code is KubernetesErrorCode.RECOVERY_CONSISTENCY_ERROR
        assert adapter.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "retryable_code",
    (
        KubernetesErrorCode.REQUEST_TIMEOUT,
        KubernetesErrorCode.UPSTREAM_UNAVAILABLE,
    ),
)
async def test_retryable_failure_replays_and_only_new_call_id_retries(
    tmp_path: Path,
    retryable_code: KubernetesErrorCode,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        adapter = _SequencedAdapter((retryable_code, None))
        context = await _context(repository, adapter)
        tools = build_diagnostic_tools()

        first = await _invoke(tools, context, "get_events", "call-1")
        replayed = await _invoke(tools, context, "get_events", "call-1")
        recovered = await _invoke(tools, context, "get_events", "call-2")

        assert first == {
            "code": retryable_code.value,
            "retryable": True,
            "message": str(KubernetesBoundaryError(retryable_code)),
        }
        assert replayed == first
        assert recovered["evidenceKind"] == "events"
        assert adapter.calls == ["get_events", "get_events"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fatal_code",
    (
        KubernetesErrorCode.AUTHENTICATION_FAILED,
        KubernetesErrorCode.PERMISSION_DENIED,
        KubernetesErrorCode.RESOURCE_NOT_FOUND,
        KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID,
        KubernetesErrorCode.RESULT_BUDGET_EXCEEDED,
    ),
)
async def test_fatal_failure_is_persisted_and_rethrown_on_replay(
    tmp_path: Path,
    fatal_code: KubernetesErrorCode,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        adapter = _SequencedAdapter((fatal_code,))
        context = await _context(repository, adapter)
        tools = build_diagnostic_tools()

        with pytest.raises(FatalDiagnosticToolError) as first:
            await _invoke(tools, context, "get_workload", "call-1")
        with pytest.raises(FatalDiagnosticToolError) as replayed:
            await _invoke(tools, context, "get_workload", "call-1")

        assert first.value.code is fatal_code
        assert first.value.retryable is False
        assert replayed.value.code is fatal_code
        assert adapter.calls == ["get_workload"]
        async with database.session_factory() as session:
            failed = await session.scalar(
                select(RunEventRow).where(RunEventRow.event_type == "tool.failed")
            )
        assert failed is not None


@pytest.mark.asyncio
async def test_insufficient_credential_ttl_fails_before_kubernetes_and_replays(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        adapter = _SequencedAdapter()
        context = await _context(
            repository,
            adapter,
            credential_expires_at=NOW + timedelta(seconds=200),
        )
        tools = build_diagnostic_tools()

        with pytest.raises(FatalDiagnosticToolError) as first:
            await _invoke(tools, context, "get_pods", "call-ttl")
        with pytest.raises(FatalDiagnosticToolError) as replayed:
            await _invoke(tools, context, "get_pods", "call-ttl")

        assert first.value.code is KubernetesErrorCode.AUTHENTICATION_FAILED
        assert replayed.value.code is KubernetesErrorCode.AUTHENTICATION_FAILED
        assert adapter.calls == []
        async with database.session_factory() as session:
            events = list(
                await session.scalars(select(RunEventRow).order_by(RunEventRow.id))
            )
        assert [event.event_type for event in events[-2:]] == [
            "tool.started",
            "tool.failed",
        ]


@pytest.mark.asyncio
async def test_same_call_id_with_different_tool_fails_closed_without_new_read(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        adapter = _SequencedAdapter()
        context = await _context(repository, adapter)
        tools = build_diagnostic_tools()
        await _invoke(tools, context, "get_workload", "call-1")

        with pytest.raises(FatalDiagnosticToolError) as conflict:
            await _invoke(tools, context, "get_events", "call-1")

        assert conflict.value.code is KubernetesErrorCode.RECOVERY_CONSISTENCY_ERROR
        assert adapter.calls == ["get_workload"]


@pytest.mark.asyncio
async def test_success_and_failure_outcome_conflict_fails_closed(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        adapter = _SequencedAdapter()
        context = await _context(repository, adapter)
        tools = build_diagnostic_tools()
        await _invoke(tools, context, "get_workload", "call-1")

        async with database.session_factory() as session, session.begin():
            run = await session.get(RunRow, str(context.run.id))
            assert run is not None
            failure_time = NOW + timedelta(seconds=40)
            session.add(
                RunEventRow(
                    run_id=str(context.run.id),
                    event_key="tool:call-1:failed",
                    event_type="tool.failed",
                    schema_version=3,
                    occurred_at=failure_time,
                    payload_json=canonical_json(
                        {
                            "schemaVersion": 3,
                            "incidentId": run.incident_id,
                            "runId": str(context.run.id),
                            "occurredAt": "2026-08-21T11:00:40Z",
                            "toolCallId": "call-1",
                            "toolName": "get_workload",
                            "errorCode": "request_timeout",
                            "retryable": True,
                        }
                    ),
                )
            )

        with pytest.raises(FatalDiagnosticToolError) as conflict:
            await _invoke(tools, context, "get_workload", "call-1")

        assert conflict.value.code is KubernetesErrorCode.RECOVERY_CONSISTENCY_ERROR
        assert adapter.calls == ["get_workload"]
