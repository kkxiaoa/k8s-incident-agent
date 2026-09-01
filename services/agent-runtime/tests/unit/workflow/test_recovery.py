from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Awaitable, Callable, Sequence
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast, override

import pytest
from alembic import command
from alembic.config import Config
from langchain_core.callbacks import (
    AsyncCallbackManagerForLLMRun,
    CallbackManagerForLLMRun,
)
from langchain_core.language_models.base import LanguageModelInput
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatResult
from langchain_core.runnables import Runnable
from langchain_core.runnables.config import RunnableConfig
from langchain_core.tools import BaseTool
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from pydantic import PrivateAttr
from sqlalchemy import func, select
from tests.factories import normalized_trigger

from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.domain.models import (
    AgentRunSnapshot,
    EvidenceRecord,
    ModelSnapshot,
    PersistedEvidence,
    RunBudget,
    RunStatus,
    TerminalRecord,
    WorkflowRunSnapshot,
)
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.contracts import WorkloadObservation
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredential
from k8s_incident_agent.persistence.database import (
    BusinessDatabase,
    create_business_database,
)
from k8s_incident_agent.persistence.models import EvidenceRow, RunEventRow, RunRow
from k8s_incident_agent.persistence.repositories import IncidentRepository, evidence_id
from k8s_incident_agent.runtime.paths import RuntimePaths
from k8s_incident_agent.scenarios.contracts import ScenarioTarget
from k8s_incident_agent.workflow.checkpoint import open_checkpoint_store
from k8s_incident_agent.workflow.graph import (
    GraphDependencies,
    IncidentGraph,
    build_incident_graph,
)
from k8s_incident_agent.workflow.supervisor import RunSupervisor

SERVICE_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 24, 9, 0, tzinfo=UTC)


class _ToolCallingModel(FakeMessagesListChatModel):
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


class _FailingToolCallingModel(_ToolCallingModel):
    @override
    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        del messages, stop, run_manager, kwargs
        self._calls += 1
        raise RuntimeError("sensitive provider failure")


class _ScriptedToolCallingModel(_ToolCallingModel):
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


class _BlockingToolCallingModel(_ToolCallingModel):
    _entered: asyncio.Event = PrivateAttr(default_factory=asyncio.Event)
    _cancelled: asyncio.Event = PrivateAttr(default_factory=asyncio.Event)

    @property
    def entered(self) -> asyncio.Event:
        return self._entered

    @property
    def cancelled(self) -> asyncio.Event:
        return self._cancelled

    @override
    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        del messages, stop, run_manager, kwargs
        self._calls += 1
        self._entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self._cancelled.set()
            raise
        raise AssertionError("blocking model unexpectedly completed")


class _Clock:
    def __init__(self, value: datetime) -> None:
        self.value = value

    def __call__(self) -> datetime:
        return self.value


class _WorkloadAdapter:
    def __init__(self) -> None:
        self.calls = 0

    async def read_workload(self, target: ScenarioTarget) -> WorkloadObservation:
        assert target == _scenario().target
        self.calls += 1
        return WorkloadObservation.model_validate(
            {
                "evidenceKind": "workload",
                "targetRef": {
                    "apiVersion": "apps/v1",
                    "kind": "Deployment",
                    "namespace": target.namespace,
                    "name": target.name,
                    "uid": "deployment-uid",
                },
                "observedAt": NOW,
                "payload": {
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
                },
                "truncated": False,
                "redacted": False,
            }
        )


class _PauseAfterEvidenceRepository:
    def __init__(self, delegate: IncidentRepository) -> None:
        self._delegate = delegate
        self.committed = asyncio.Event()
        self.release = asyncio.Event()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)

    async def record_evidence(self, evidence: EvidenceRecord) -> PersistedEvidence:
        persisted = await self._delegate.record_evidence(evidence)
        self.committed.set()
        await self.release.wait()
        return persisted


def _scenario():
    return normalized_trigger()


def _model_snapshot() -> ModelSnapshot:
    return ModelSnapshot(
        provider="deepseek",
        model_id="deepseek-v4-flash",
        thinking_mode=False,
        prompt_version="stage1-v1",
    )


def _budget() -> RunBudget:
    return RunBudget(max_model_calls=8, max_tool_calls=6, timeout_seconds=180)


def _credential() -> DiagnosticCredential:
    return DiagnosticCredential(
        kubeconfig_path=Path("/unused/diagnostic.kubeconfig"),
        context_name="kind-k8s-incident-agent",
        server_url="https://127.0.0.1:6443",
        expires_at=NOW + timedelta(hours=1),
        _kubeconfig={},
    )


def _alembic_config(paths: RuntimePaths) -> Config:
    config = Config(str(SERVICE_ROOT / "alembic.ini"))
    config.attributes["runtime_paths"] = paths
    return config


@asynccontextmanager
async def _open_database(paths: RuntimePaths) -> AsyncGenerator[BusinessDatabase]:
    database = await create_business_database(paths)
    try:
        yield database
    finally:
        await database.dispose()


def _dependencies(
    repository: IncidentRepository,
    saver: object,
    model: _ToolCallingModel,
    *,
    adapter: object | None = None,
    credential: DiagnosticCredential | None = None,
    now: Callable[[], datetime] | None = None,
) -> GraphDependencies:
    return GraphDependencies(
        repository=repository,
        checkpointer=cast(Any, saver),
        model=model,
        model_snapshot=_model_snapshot(),
        credential=credential or _credential(),
        adapter=cast(KubernetesEvidenceAdapter, adapter or object()),
        now=now or (lambda: NOW),
    )


def _context(
    run: WorkflowRunSnapshot,
    repository: IncidentRepository,
    *,
    adapter: object | None = None,
    credential: DiagnosticCredential | None = None,
    now: Callable[[], datetime] | None = None,
) -> DiagnosticToolContext:
    return DiagnosticToolContext(
        run=AgentRunSnapshot(
            id=run.id,
            started_at=run.started_at or NOW,
            timeout_seconds=run.budget.timeout_seconds,
        ),
        target=run.target,
        credential=credential or _credential(),
        adapter=cast(KubernetesEvidenceAdapter, adapter or object()),
        repository=repository,
        now=now or (lambda: NOW),
    )


def _supervisor(
    repository: IncidentRepository,
    saver: object,
    model: _ToolCallingModel,
    *,
    adapter: object | None = None,
    credential: DiagnosticCredential | None = None,
    model_id: str = "deepseek-v4-flash",
    now: datetime = NOW,
) -> RunSupervisor:
    return RunSupervisor(
        repository=repository,
        checkpointer=cast(Any, saver),
        model=model,
        model_snapshot=ModelSnapshot(
            provider="deepseek",
            model_id=model_id,
            thinking_mode=False,
            prompt_version="stage1-v1",
        ),
        credential=credential or _credential(),
        adapter=cast(KubernetesEvidenceAdapter, adapter or object()),
        now=lambda: now,
    )


def _thread_config(run_id: object) -> RunnableConfig:
    return {"configurable": {"thread_id": str(run_id)}}


async def _wait_for_terminal(
    repository: IncidentRepository,
    run_id: object,
) -> WorkflowRunSnapshot:
    async with asyncio.timeout(2):
        while True:
            snapshot = await repository.get_workflow_run_snapshot(cast(Any, run_id))
            if snapshot.run_status not in {RunStatus.QUEUED, RunStatus.RUNNING}:
                return snapshot
            await asyncio.sleep(0)


async def _event_count(
    database: BusinessDatabase,
    run_id: object,
    event_key: str,
) -> int:
    async with database.session_factory() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(RunEventRow)
            .where(
                RunEventRow.run_id == str(run_id),
                RunEventRow.event_key == event_key,
            )
        )
    assert count is not None
    return count


async def _row_count(database: BusinessDatabase, model: Any) -> int:
    async with database.session_factory() as session:
        count = await session.scalar(select(func.count()).select_from(model))
    assert count is not None
    return count


def _tool_call_response() -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": "get_workload",
                "args": {},
                "id": "call-workload",
                "type": "tool_call",
            }
        ],
    )


def _diagnosed_response(run_id: object) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": "DiagnosisCandidate",
                "args": {
                    "outcome": "diagnosed",
                    "summary": "The workload observation shows zero available replicas.",
                    "root_causes": [
                        {
                            "code": "workload_unavailable",
                            "statement": (
                                "The Deployment reports zero available replicas."
                            ),
                            "confidence": "high",
                            "evidence_ids": [
                                str(evidence_id(cast(Any, run_id), "call-workload"))
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


async def _record_workload_evidence(
    repository: IncidentRepository,
    run_id: object,
) -> None:
    await repository.record_tool_started(
        cast(Any, run_id),
        "call-workload",
        "get_workload",
    )
    await repository.record_evidence(
        EvidenceRecord(
            run_id=cast(Any, run_id),
            tool_call_id="call-workload",
            tool_name="get_workload",
            evidence_kind="workload",
            target_ref={"kind": "Deployment", "name": "image-pull-backoff"},
            observed_at=NOW,
            payload={"availableReplicas": 0},
            truncated=False,
            redacted=False,
        )
    )


def _fail_checkpoint_when(
    monkeypatch: pytest.MonkeyPatch,
    saver: AsyncSqliteSaver,
    predicate: Callable[[RunnableConfig, dict[str, Any], dict[str, Any]], bool],
) -> Callable[[], bool]:
    original = cast(Callable[..., Awaitable[RunnableConfig]], saver.aput)
    failed = False

    async def controlled_aput(
        config: RunnableConfig,
        checkpoint: dict[str, Any],
        metadata: dict[str, Any],
        new_versions: dict[str, Any],
    ) -> RunnableConfig:
        nonlocal failed
        if not failed and predicate(config, checkpoint, metadata):
            failed = True
            raise OSError("controlled checkpoint failure")
        return await original(config, checkpoint, metadata, new_versions)

    monkeypatch.setattr(saver, "aput", controlled_aput)
    return lambda: failed


def _checkpoint_namespace(config: RunnableConfig) -> object:
    configurable = config.get("configurable")
    if configurable is None:
        return None
    return configurable.get("checkpoint_ns")


async def _checkpoint_before_diagnose(
    repository: IncidentRepository,
    saver: AsyncSqliteSaver,
    run: WorkflowRunSnapshot,
) -> IncidentGraph:
    graph = build_incident_graph(
        _dependencies(
            repository,
            saver,
            _FailingToolCallingModel(responses=[]),
        ),
        run,
    )
    await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
        {"run_id": str(run.id)},
        _thread_config(run.id),
        context=_context(run, repository),
        interrupt_before=["diagnose"],
        durability="sync",
    )
    return graph


@pytest.mark.asyncio
async def test_input_checkpoint_barrier_precedes_business_start(tmp_path: Path) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model_snapshot(), _budget()
        )
        run = await repository.get_workflow_run_snapshot(created.run_id)
        model = _FailingToolCallingModel(responses=[])
        config = _thread_config(run.id)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            graph = build_incident_graph(_dependencies(repository, saver, model), run)

            await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                {"run_id": str(run.id)},
                config,
                context=_context(run, repository),
                interrupt_before=["start_run"],
                durability="sync",
            )

            queued = await repository.get_workflow_run_snapshot(run.id)
            barrier = await graph.aget_state(config)
            assert queued.run_status is RunStatus.QUEUED
            assert queued.started_at is None
            assert await _event_count(database, run.id, "run.started") == 0
            assert barrier.values == {"run_id": str(run.id), "messages": []}
            assert barrier.next == ("start_run",)

            await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                None,
                config,
                context=_context(run, repository),
                interrupt_after=["start_run"],
                durability="sync",
            )

        running = await repository.get_workflow_run_snapshot(run.id)
        assert running.run_status is RunStatus.RUNNING
        assert running.started_at == NOW
        assert await _event_count(database, run.id, "run.started") == 1


@pytest.mark.asyncio
async def test_queued_input_checkpoint_recovers_with_rebuilt_supervisor(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model_snapshot(), _budget()
        )
        run = await repository.get_workflow_run_snapshot(created.run_id)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            graph = build_incident_graph(
                _dependencies(
                    repository,
                    saver,
                    _FailingToolCallingModel(responses=[]),
                ),
                run,
            )
            await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                {"run_id": str(run.id)},
                _thread_config(run.id),
                context=_context(run, repository),
                interrupt_before=["start_run"],
                durability="sync",
            )

    model = _FailingToolCallingModel(responses=[])
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            supervisor = _supervisor(repository, saver, model)
            await supervisor.start()
            terminal = await _wait_for_terminal(repository, created.run_id)
            await supervisor.close()

        assert terminal.run_status is RunStatus.FAILED
        assert model.calls == 1
        assert await _event_count(database, created.run_id, "run.started") == 1
        async with database.session_factory() as session:
            run_row = await session.get(RunRow, str(created.run_id))
            assert run_row is not None
            assert run_row.error_code == "model_upstream_failed"
            assert run_row.error_retryable is True


@pytest.mark.asyncio
async def test_partial_input_checkpoint_recovers_after_barrier_write_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model_snapshot(), _budget()
        )
        run = await repository.get_workflow_run_snapshot(created.run_id)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            graph = build_incident_graph(
                _dependencies(
                    repository,
                    saver,
                    _FailingToolCallingModel(responses=[]),
                ),
                run,
            )
            did_fail = _fail_checkpoint_when(
                monkeypatch,
                saver,
                lambda config, checkpoint, metadata: (
                    _checkpoint_namespace(config) == ""
                    and metadata.get("source") == "loop"
                    and metadata.get("step") == 0
                ),
            )
            with pytest.raises(OSError, match="controlled checkpoint failure"):
                await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                    {"run_id": str(run.id)},
                    _thread_config(run.id),
                    context=_context(run, repository),
                    interrupt_before=["start_run"],
                    durability="sync",
                )

            queued = await repository.get_workflow_run_snapshot(run.id)
            partial = await graph.aget_state(_thread_config(run.id))
            assert did_fail()
            assert queued.run_status is RunStatus.QUEUED
            assert partial.metadata is not None
            assert partial.metadata.get("source") == "input"
            assert partial.metadata.get("step") == -1
            assert partial.next == ()
            assert tuple(task.name for task in partial.tasks) == ("__start__",)

    model = _FailingToolCallingModel(responses=[])
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            supervisor = _supervisor(repository, saver, model)
            await supervisor.start()
            terminal = await _wait_for_terminal(repository, created.run_id)
            await supervisor.close()

        assert terminal.run_status is RunStatus.FAILED
        assert model.calls == 1
        assert await _event_count(database, created.run_id, "run.started") == 1
        async with database.session_factory() as session:
            run_row = await session.get(RunRow, str(created.run_id))
            assert run_row is not None
            assert run_row.error_code == "model_upstream_failed"


@pytest.mark.asyncio
async def test_queued_terminal_checkpoint_preserves_original_error_on_restart(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    short_credential = DiagnosticCredential(
        kubeconfig_path=Path("/unused/diagnostic.kubeconfig"),
        context_name="kind-k8s-incident-agent",
        server_url="https://127.0.0.1:6443",
        expires_at=NOW + timedelta(seconds=1),
        _kubeconfig={},
    )
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model_snapshot(), _budget()
        )
        run = await repository.get_workflow_run_snapshot(created.run_id)
        first_model = _FailingToolCallingModel(responses=[])
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            graph = build_incident_graph(
                _dependencies(
                    repository,
                    saver,
                    first_model,
                    credential=short_credential,
                ),
                run,
            )
            await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                {"run_id": str(run.id)},
                _thread_config(run.id),
                context=_context(
                    run,
                    repository,
                    credential=short_credential,
                ),
                interrupt_before=["persist_terminal_state"],
                durability="sync",
            )
            checkpoint = await graph.aget_state(_thread_config(run.id))

        queued = await repository.get_workflow_run_snapshot(run.id)
        assert queued.run_status is RunStatus.QUEUED
        assert checkpoint.next == ("persist_terminal_state",)
        assert checkpoint.values["terminal_error_code"] == "authentication_failed"
        assert first_model.calls == 0

    second_model = _FailingToolCallingModel(responses=[])
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            supervisor = _supervisor(
                repository,
                saver,
                second_model,
                model_id="deepseek-v5-flash",
            )
            await supervisor.start()
            terminal = await _wait_for_terminal(repository, created.run_id)
            await supervisor.close()

        assert terminal.run_status is RunStatus.FAILED
        assert second_model.calls == 0
        async with database.session_factory() as session:
            run_row = await session.get(RunRow, str(created.run_id))
            assert run_row is not None
            assert run_row.error_code == "authentication_failed"
            assert run_row.error_retryable is False


@pytest.mark.asyncio
async def test_expired_running_checkpoint_stops_before_diagnose(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model_snapshot(), _budget()
        )
        run = await repository.get_workflow_run_snapshot(created.run_id)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            await _checkpoint_before_diagnose(repository, saver, run)

    model = _FailingToolCallingModel(responses=[])
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            supervisor = _supervisor(
                repository,
                saver,
                model,
                now=NOW + timedelta(seconds=_budget().timeout_seconds),
            )
            await supervisor.start()
            terminal = await _wait_for_terminal(repository, created.run_id)
            await supervisor.close()

        assert terminal.run_status is RunStatus.FAILED
        assert model.calls == 0
        async with database.session_factory() as session:
            run_row = await session.get(RunRow, str(created.run_id))
            assert run_row is not None
            assert run_row.error_code == "agent_timeout"
            assert run_row.error_retryable is True
            assert run_row.model_calls is None
            assert run_row.tool_calls is None


@pytest.mark.asyncio
async def test_model_call_uses_remaining_absolute_deadline_after_barrier_delay(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    clock = _Clock(NOW)
    budget = RunBudget(max_model_calls=8, max_tool_calls=6, timeout_seconds=1)
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model_snapshot(), budget
        )
        run = await repository.get_workflow_run_snapshot(created.run_id)
        model = _BlockingToolCallingModel(responses=[])
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            graph = build_incident_graph(
                _dependencies(
                    repository,
                    saver,
                    model,
                    now=clock,
                ),
                run,
            )
            context = _context(run, repository, now=clock)
            await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                {"run_id": str(run.id)},
                _thread_config(run.id),
                context=context,
                interrupt_before=["start_run"],
                durability="sync",
            )
            clock.value = NOW + timedelta(milliseconds=990)
            async with asyncio.timeout(1):
                await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                    None,
                    _thread_config(run.id),
                    context=context,
                    durability="sync",
                )

        terminal = await repository.get_workflow_run_snapshot(run.id)
        assert terminal.run_status is RunStatus.FAILED
        assert model.calls == 1
        assert model.entered.is_set()
        assert model.cancelled.is_set()
        async with database.session_factory() as session:
            run_row = await session.get(RunRow, str(created.run_id))
            assert run_row is not None
            assert run_row.error_code == "agent_timeout"
            assert run_row.error_retryable is True


@pytest.mark.asyncio
@pytest.mark.parametrize("mismatch", ["model", "prompt"])
async def test_running_checkpoint_rejects_changed_model_identity(
    tmp_path: Path,
    mismatch: str,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model_snapshot(), _budget()
        )
        run = await repository.get_workflow_run_snapshot(created.run_id)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            await _checkpoint_before_diagnose(repository, saver, run)
        if mismatch == "prompt":
            async with database.session_factory() as session, session.begin():
                run_row = await session.get(RunRow, str(created.run_id))
                assert run_row is not None
                run_row.prompt_version = "stage1-v0"

    model = _FailingToolCallingModel(responses=[])
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            supervisor = _supervisor(
                repository,
                saver,
                model,
                model_id=(
                    "deepseek-v5-flash" if mismatch == "model" else "deepseek-v4-flash"
                ),
            )
            await supervisor.start()
            terminal = await _wait_for_terminal(repository, created.run_id)
            await supervisor.close()

        assert terminal.run_status is RunStatus.FAILED
        assert model.calls == 0
        async with database.session_factory() as session:
            run_row = await session.get(RunRow, str(created.run_id))
            assert run_row is not None
            assert run_row.error_code == "recovery_consistency_error"
            assert run_row.error_retryable is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "resume_node",
    ["validate_diagnosis", "persist_terminal_state"],
)
async def test_changed_model_does_not_block_post_model_checkpoint(
    tmp_path: Path,
    resume_node: str,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model_snapshot(), _budget()
        )
        await repository.start_run(created.run_id, NOW)
        await _record_workload_evidence(repository, created.run_id)
        run = await repository.get_workflow_run_snapshot(created.run_id)
        first_model = _ScriptedToolCallingModel(
            responses=[_diagnosed_response(created.run_id)]
        )
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            graph = build_incident_graph(
                _dependencies(repository, saver, first_model),
                run,
            )
            await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                {"run_id": str(run.id)},
                _thread_config(run.id),
                context=_context(run, repository),
                interrupt_before=[resume_node],
                durability="sync",
            )
            checkpoint = await graph.aget_state(_thread_config(run.id))

        assert checkpoint.next == (resume_node,)
        assert first_model.calls == 1

    second_model = _FailingToolCallingModel(responses=[])
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            supervisor = _supervisor(
                repository,
                saver,
                second_model,
                model_id="deepseek-v5-flash",
            )
            await supervisor.start()
            terminal = await _wait_for_terminal(repository, created.run_id)
            await supervisor.close()

        assert terminal.run_status is RunStatus.COMPLETED
        assert second_model.calls == 0
        assert await _event_count(database, created.run_id, "run:terminal") == 1


@pytest.mark.asyncio
async def test_expired_post_model_checkpoint_preserves_projected_usage(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model_snapshot(), _budget()
        )
        await repository.start_run(created.run_id, NOW)
        await _record_workload_evidence(repository, created.run_id)
        run = await repository.get_workflow_run_snapshot(created.run_id)
        first_model = _ScriptedToolCallingModel(
            responses=[_diagnosed_response(created.run_id)]
        )
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            graph = build_incident_graph(
                _dependencies(repository, saver, first_model),
                run,
            )
            await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                {"run_id": str(run.id)},
                _thread_config(run.id),
                context=_context(run, repository),
                interrupt_before=["validate_diagnosis"],
                durability="sync",
            )
            checkpoint = await graph.aget_state(_thread_config(run.id))

        assert checkpoint.next == ("validate_diagnosis",)
        assert checkpoint.values["model_calls"] == 1
        assert checkpoint.values["tool_calls"] == 1
        assert first_model.calls == 1

    second_model = _FailingToolCallingModel(responses=[])
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            supervisor = _supervisor(
                repository,
                saver,
                second_model,
                now=NOW + timedelta(seconds=_budget().timeout_seconds),
            )
            await supervisor.start()
            terminal = await _wait_for_terminal(repository, created.run_id)
            await supervisor.close()

        assert terminal.run_status is RunStatus.FAILED
        assert second_model.calls == 0
        async with database.session_factory() as session:
            run_row = await session.get(RunRow, str(created.run_id))
            assert run_row is not None
            assert run_row.error_code == "agent_timeout"
            assert run_row.error_retryable is True
            assert run_row.model_calls == 1
            assert run_row.tool_calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("incident_id", "00000000-0000-0000-0000-000000000001"),
        ("trigger_summary", "A different persisted trigger."),
        (
            "target",
            {
                "cluster": "k8s-incident-agent",
                "namespace": "k8s-incident-scenarios",
                "api_version": "apps/v1",
                "kind": "Deployment",
                "name": "different-target",
            },
        ),
    ],
)
async def test_running_checkpoint_rejects_mismatched_business_identity(
    tmp_path: Path,
    field: str,
    value: object,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model_snapshot(), _budget()
        )
        run = await repository.get_workflow_run_snapshot(created.run_id)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            graph = await _checkpoint_before_diagnose(repository, saver, run)
            await graph.aupdate_state(  # pyright: ignore[reportUnknownMemberType]
                _thread_config(run.id),
                {field: value},
                as_node="triage_target",
            )

    model = _FailingToolCallingModel(responses=[])
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            supervisor = _supervisor(repository, saver, model)
            await supervisor.start()
            terminal = await _wait_for_terminal(repository, created.run_id)
            await supervisor.close()

        assert terminal.run_status is RunStatus.FAILED
        assert model.calls == 0
        async with database.session_factory() as session:
            run_row = await session.get(RunRow, str(created.run_id))
            assert run_row is not None
            assert run_row.error_code == "recovery_consistency_error"


@pytest.mark.asyncio
async def test_running_pre_start_checkpoint_replays_original_started_at_once(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model_snapshot(), _budget()
        )
        queued = await repository.get_workflow_run_snapshot(created.run_id)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            graph = build_incident_graph(
                _dependencies(
                    repository,
                    saver,
                    _FailingToolCallingModel(responses=[]),
                ),
                queued,
            )
            await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                {"run_id": str(queued.id)},
                _thread_config(queued.id),
                context=_context(queued, repository),
                interrupt_before=["start_run"],
                durability="sync",
            )
        await repository.start_run(queued.id, NOW)

    model = _FailingToolCallingModel(responses=[])
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            supervisor = _supervisor(repository, saver, model)
            await supervisor.start()
            terminal = await _wait_for_terminal(repository, created.run_id)
            await supervisor.close()

        assert terminal.run_status is RunStatus.FAILED
        assert terminal.started_at == NOW
        assert model.calls == 1
        assert await _event_count(database, created.run_id, "run.started") == 1


@pytest.mark.asyncio
async def test_running_without_checkpoint_fails_recovery_consistency(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model_snapshot(), _budget()
        )
        await repository.start_run(created.run_id, NOW)

    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        model = _FailingToolCallingModel(responses=[])
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            supervisor = _supervisor(repository, saver, model)
            await supervisor.start()
            terminal = await _wait_for_terminal(repository, created.run_id)
            await supervisor.close()

        assert terminal.run_status is RunStatus.FAILED
        assert model.calls == 0
        async with database.session_factory() as session:
            event = await session.scalar(
                select(RunEventRow).where(
                    RunEventRow.run_id == str(created.run_id),
                    RunEventRow.event_key == "run:terminal",
                )
            )
            assert event is not None
            assert '"errorCode":"recovery_consistency_error"' in event.payload_json


@pytest.mark.asyncio
async def test_terminal_business_state_is_not_scheduled_or_written_twice(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model_snapshot(), _budget()
        )
        await repository.persist_terminal(
            TerminalRecord(
                run_id=created.run_id,
                completed_at=NOW,
                outcome=None,
                summary=None,
                root_causes=(),
                missing_information=(),
                redacted=False,
                error_code="recovery_consistency_error",
                error_retryable=False,
                model_calls=None,
                tool_calls=None,
                input_tokens=None,
                output_tokens=None,
            )
        )
        model = _FailingToolCallingModel(responses=[])
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            supervisor = _supervisor(repository, saver, model)
            await supervisor.start()
            await supervisor.schedule(created.run_id)
            await asyncio.sleep(0)
            await supervisor.close()

        assert model.calls == 0
        assert await _event_count(database, created.run_id, "run:terminal") == 1


@pytest.mark.asyncio
async def test_evidence_commit_replays_after_checkpoint_lag_with_rebuilt_runtime(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    first_adapter = _WorkloadAdapter()

    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model_snapshot(), _budget()
        )
        run = await repository.get_workflow_run_snapshot(created.run_id)
        first_model = _ScriptedToolCallingModel(responses=[_tool_call_response()])
        paused_repository = _PauseAfterEvidenceRepository(repository)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            graph = build_incident_graph(
                _dependencies(
                    cast(IncidentRepository, paused_repository),
                    saver,
                    first_model,
                    adapter=first_adapter,
                ),
                run,
            )
            invocation = asyncio.create_task(
                graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                    {"run_id": str(run.id)},
                    _thread_config(run.id),
                    context=_context(
                        run,
                        cast(IncidentRepository, paused_repository),
                        adapter=first_adapter,
                    ),
                    durability="sync",
                )
            )
            await paused_repository.committed.wait()
            invocation.cancel()
            with pytest.raises(asyncio.CancelledError):
                await invocation

        interrupted = await repository.get_workflow_run_snapshot(run.id)
        assert interrupted.run_status is RunStatus.RUNNING
        assert first_model.calls == 1
        assert first_adapter.calls == 1
        assert await _row_count(database, EvidenceRow) == 1

    second_adapter = _WorkloadAdapter()
    second_model = _ScriptedToolCallingModel(
        responses=[_diagnosed_response(created.run_id)]
    )
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            supervisor = _supervisor(
                repository,
                saver,
                second_model,
                adapter=second_adapter,
            )
            await supervisor.start()
            terminal = await _wait_for_terminal(repository, created.run_id)
            await supervisor.close()

        assert terminal.run_status is RunStatus.COMPLETED
        assert second_model.calls == 1
        assert second_adapter.calls == 0
        assert await _row_count(database, EvidenceRow) == 1
        assert await _event_count(database, created.run_id, "run.started") == 1
        assert (
            await _event_count(database, created.run_id, "tool:call-workload:evidence")
            == 1
        )
        assert await _event_count(database, created.run_id, "run:terminal") == 1
        async with database.session_factory() as session:
            run_row = await session.get(RunRow, str(created.run_id))
            assert run_row is not None
            assert run_row.model_calls == 2
            assert run_row.tool_calls == 2


@pytest.mark.asyncio
async def test_terminal_commit_is_not_rewritten_when_checkpoint_save_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    adapter = _WorkloadAdapter()

    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(
            _scenario(), _model_snapshot(), _budget()
        )
        model = _ScriptedToolCallingModel(
            responses=[_tool_call_response(), _diagnosed_response(created.run_id)]
        )
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            did_fail = _fail_checkpoint_when(
                monkeypatch,
                saver,
                lambda config, checkpoint, metadata: (
                    _checkpoint_namespace(config) == ""
                    and metadata.get("source") == "loop"
                    and metadata.get("step") == 5
                ),
            )
            supervisor = _supervisor(
                repository,
                saver,
                model,
                adapter=adapter,
            )
            await supervisor.start()
            terminal = await _wait_for_terminal(repository, created.run_id)
            await supervisor.close()

        assert did_fail()
        assert terminal.run_status is RunStatus.COMPLETED
        assert model.calls == 2
        assert adapter.calls == 1
        assert await _event_count(database, created.run_id, "run:terminal") == 1

    rebuilt_model = _ScriptedToolCallingModel(responses=[])
    async with _open_database(paths) as database:
        repository = IncidentRepository(database.session_factory)
        async with open_checkpoint_store(paths.checkpoint_database) as saver:
            supervisor = _supervisor(repository, saver, rebuilt_model)
            await supervisor.start()
            await supervisor.schedule(created.run_id)
            await asyncio.sleep(0)
            await supervisor.close()

        assert rebuilt_model.calls == 0
        assert await _event_count(database, created.run_id, "run:terminal") == 1
