import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast
from uuid import UUID, uuid4

import pytest
from langchain_core.language_models import BaseChatModel
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from k8s_incident_agent.domain.models import (
    ModelSnapshot,
    RunBudget,
    RunStatus,
    WorkflowRunSnapshot,
)
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredential
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.scenarios.contracts import ScenarioTarget
from k8s_incident_agent.workflow import supervisor as supervisor_module
from k8s_incident_agent.workflow.supervisor import RunSupervisor

NOW = datetime(2026, 8, 24, 9, 0, tzinfo=UTC)


class _BlockingTerminalRepository:
    def __init__(self, run: WorkflowRunSnapshot) -> None:
        self.run = run
        self.release = asyncio.Event()
        self.entered = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.snapshot_calls = 0

    async def list_recoverable_run_ids(self) -> tuple[UUID, ...]:
        return (self.run.id,)

    async def get_workflow_run_snapshot(
        self,
        run_id: UUID,
    ) -> WorkflowRunSnapshot:
        assert run_id == self.run.id
        self.snapshot_calls += 1
        self.entered.set()
        try:
            await self.release.wait()
        except asyncio.CancelledError:
            self.cancelled.set()
            raise
        return self.run


def _terminal_snapshot() -> WorkflowRunSnapshot:
    return WorkflowRunSnapshot(
        id=uuid4(),
        incident_id=uuid4(),
        run_status=RunStatus.FAILED,
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
            model_id="deepseek-v4-flash",
            thinking_mode=False,
            prompt_version="stage1-v1",
        ),
        budget=RunBudget(
            max_model_calls=8,
            max_tool_calls=6,
            timeout_seconds=180,
        ),
        started_at=NOW,
    )


def _supervisor(
    repository: _BlockingTerminalRepository,
) -> RunSupervisor:
    return RunSupervisor(
        repository=cast(IncidentRepository, repository),
        checkpointer=cast(AsyncSqliteSaver, object()),
        model=cast(BaseChatModel, object()),
        model_snapshot=ModelSnapshot(
            provider="deepseek",
            model_id="deepseek-v4-flash",
            thinking_mode=False,
            prompt_version="stage1-v1",
        ),
        credential=DiagnosticCredential(
            kubeconfig_path=Path("/unused/diagnostic.kubeconfig"),
            context_name="kind-k8s-incident-agent",
            server_url="https://127.0.0.1:6443",
            expires_at=NOW + timedelta(hours=1),
            _kubeconfig={},
        ),
        adapter=cast(KubernetesEvidenceAdapter, object()),
        now=lambda: NOW,
    )


@pytest.mark.asyncio
async def test_registry_deduplicates_same_run_while_task_is_active() -> None:
    repository = _BlockingTerminalRepository(_terminal_snapshot())
    supervisor = _supervisor(repository)

    await supervisor.start()
    await repository.entered.wait()
    await supervisor.schedule(repository.run.id)
    await asyncio.sleep(0)

    assert repository.snapshot_calls == 1

    repository.release.set()
    await supervisor.close()


@pytest.mark.asyncio
async def test_close_stops_scheduling_and_cancels_after_grace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = _BlockingTerminalRepository(_terminal_snapshot())
    supervisor = _supervisor(repository)
    monkeypatch.setattr(supervisor_module, "_SHUTDOWN_GRACE_SECONDS", 0)

    await supervisor.start()
    await repository.entered.wait()
    await supervisor.close()

    assert repository.cancelled.is_set()
    with pytest.raises(RuntimeError, match="not accepting"):
        await supervisor.schedule(repository.run.id)
