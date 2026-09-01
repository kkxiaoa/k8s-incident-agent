from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Final, cast
from uuid import UUID

from langchain_core.language_models import BaseChatModel
from langchain_core.runnables.config import RunnableConfig
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import StateSnapshot
from pydantic import ValidationError

from k8s_incident_agent.diagnosis.context import DiagnosticToolContext
from k8s_incident_agent.domain.contracts import KubernetesTarget
from k8s_incident_agent.domain.models import (
    AgentRunSnapshot,
    ModelSnapshot,
    RunStatus,
    TerminalRecord,
    WorkflowRunSnapshot,
)
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredentialLease
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    RecoveryConsistencyError,
)
from k8s_incident_agent.workflow.failures import require_terminal_error_contract
from k8s_incident_agent.workflow.graph import (
    GraphDependencies,
    IncidentGraph,
    build_incident_graph,
    classify_diagnosis_failure,
)

_SHUTDOWN_GRACE_SECONDS: Final = 5.0
_ACTIVE_RUN_STATUSES: Final = frozenset({RunStatus.QUEUED, RunStatus.RUNNING})
_WORKFLOW_NODES: Final = frozenset(
    {
        "start_run",
        "triage_target",
        "diagnose",
        "validate_diagnosis",
        "persist_terminal_state",
    }
)
_MODEL_BOUNDARY_NODES: Final = frozenset({"start_run", "triage_target", "diagnose"})
_IDENTITY_FIELDS: Final = frozenset({"incident_id", "trigger_summary", "target"})


class RunSupervisor:
    def __init__(
        self,
        *,
        repository: IncidentRepository,
        checkpointer: AsyncSqliteSaver,
        model: BaseChatModel,
        model_snapshot: ModelSnapshot,
        credential: DiagnosticCredentialLease,
        adapter: KubernetesEvidenceAdapter,
        now: Callable[[], datetime],
    ) -> None:
        self._dependencies = GraphDependencies(
            repository=repository,
            checkpointer=checkpointer,
            model=model,
            model_snapshot=model_snapshot,
            credential=credential,
            adapter=adapter,
            now=now,
        )
        self._repository = repository
        self._checkpointer = checkpointer
        self._now = now
        self._tasks: dict[UUID, asyncio.Task[None]] = {}
        self._accepting = False

    async def start(self) -> None:
        self._accepting = True
        try:
            await self.reconcile()
        except BaseException:
            self._accepting = False
            raise

    async def schedule(self, run_id: UUID) -> None:
        if not self._accepting:
            raise RuntimeError("Run supervisor is not accepting work")
        existing = self._tasks.get(run_id)
        if existing is not None and not existing.done():
            return
        task = asyncio.create_task(
            self._execute(run_id),
            name=f"incident-run-{run_id}",
        )
        self._tasks[run_id] = task
        task.add_done_callback(
            lambda completed, scheduled_run_id=run_id: self._task_done(
                scheduled_run_id,
                completed,
            )
        )

    async def reconcile(self) -> None:
        if not self._accepting:
            raise RuntimeError("Run supervisor is not accepting work")
        for run_id in await self._repository.list_recoverable_run_ids():
            await self.schedule(run_id)

    async def close(self) -> None:
        self._accepting = False
        pending = {task for task in self._tasks.values() if not task.done()}
        if not pending:
            return
        _, pending = await asyncio.wait(
            pending,
            timeout=_SHUTDOWN_GRACE_SECONDS,
        )
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    async def _execute(self, run_id: UUID) -> None:
        try:
            snapshot = await self._repository.get_workflow_run_snapshot(run_id)
            if snapshot.run_status not in _ACTIVE_RUN_STATUSES:
                return
            config: RunnableConfig = {"configurable": {"thread_id": str(run_id)}}
            checkpoint = await self._checkpointer.aget_tuple(config)

            if snapshot.run_status is RunStatus.RUNNING and checkpoint is None:
                await self._persist_failure(run_id, "recovery_consistency_error", False)
                return

            graph = build_incident_graph(self._dependencies, snapshot)
            context = self._context(snapshot)
            if snapshot.run_status is RunStatus.QUEUED:
                if checkpoint is None:
                    await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                        {"run_id": str(run_id)},
                        config,
                        context=context,
                        interrupt_before=["start_run"],
                        durability="sync",
                    )
                    barrier_snapshot = await self._repository.get_workflow_run_snapshot(
                        run_id
                    )
                    if barrier_snapshot.run_status is not RunStatus.QUEUED:
                        raise RuntimeError("Checkpoint barrier advanced business state")
                next_node, terminal_error = await self._require_queued_checkpoint(
                    graph,
                    config,
                    snapshot,
                )
            else:
                next_node, terminal_error = await self._require_resumable_checkpoint(
                    graph,
                    config,
                    snapshot,
                )
            if (
                terminal_error is None
                and next_node in _MODEL_BOUNDARY_NODES
                and snapshot.model != self._dependencies.model_snapshot
            ):
                await self._persist_failure(
                    run_id,
                    "recovery_consistency_error",
                    False,
                )
                return
            if (
                terminal_error is None
                and snapshot.run_status is RunStatus.RUNNING
                and next_node in _MODEL_BOUNDARY_NODES
                and self._deadline_expired(snapshot)
            ):
                await self._persist_failure(run_id, "agent_timeout", True)
                return

            await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                None,
                config,
                context=context,
                durability="sync",
            )
            completed = await self._repository.get_workflow_run_snapshot(run_id)
            if completed.run_status in _ACTIVE_RUN_STATUSES:
                await self._persist_failure(run_id, "recovery_consistency_error", False)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            await self._handle_failure(run_id, error)

    def _context(self, run: WorkflowRunSnapshot) -> DiagnosticToolContext:
        started_at = run.started_at or self._now()
        return DiagnosticToolContext(
            run=AgentRunSnapshot(
                id=run.id,
                started_at=started_at,
                timeout_seconds=run.budget.timeout_seconds,
            ),
            target=run.target,
            credential=self._dependencies.credential,
            adapter=self._dependencies.adapter,
            repository=self._repository,
            now=self._now,
        )

    async def _require_queued_checkpoint(
        self,
        graph: IncidentGraph,
        config: RunnableConfig,
        run: WorkflowRunSnapshot,
    ) -> tuple[str, tuple[str, bool] | None]:
        state = await graph.aget_state(  # pyright: ignore[reportUnknownMemberType]
            config
        )
        values = cast(dict[str, object], state.values)
        terminal_error = _checkpoint_terminal_error(values)
        if terminal_error is None:
            _require_pre_start_state(state, run.id)
            return "start_run", None
        next_node = _checkpoint_node(state)
        if (
            next_node == "start_run"
            or set(values)
            != {
                "run_id",
                "messages",
                "terminal_error_code",
                "terminal_error_retryable",
            }
            or values.get("run_id") != str(run.id)
            or values.get("messages") != []
        ):
            raise RuntimeError("Queued terminal checkpoint is not resumable")
        return next_node, terminal_error

    async def _require_resumable_checkpoint(
        self,
        graph: IncidentGraph,
        config: RunnableConfig,
        run: WorkflowRunSnapshot,
    ) -> tuple[str, tuple[str, bool] | None]:
        state = await graph.aget_state(  # pyright: ignore[reportUnknownMemberType]
            config
        )
        values = cast(dict[str, object], state.values)
        if values.get("run_id") != str(run.id):
            raise RuntimeError("Running run checkpoint is not resumable")
        next_node = _checkpoint_node(state)
        terminal_error = _checkpoint_terminal_error(values)
        if next_node == "start_run":
            if terminal_error is not None:
                raise RuntimeError("Pre-start checkpoint contains a terminal error")
            _require_pre_start_state(state, run.id)
            return next_node, None
        identity_fields = _IDENTITY_FIELDS.intersection(values)
        if not identity_fields:
            if (
                terminal_error is None
                or set(values)
                != {
                    "run_id",
                    "messages",
                    "terminal_error_code",
                    "terminal_error_retryable",
                }
                or values.get("messages") != []
            ):
                raise RuntimeError("Running run checkpoint identity is missing")
            return next_node, terminal_error
        if identity_fields != _IDENTITY_FIELDS:
            raise RuntimeError("Running run checkpoint identity is incomplete")
        _require_checkpoint_identity(values, run)
        return next_node, terminal_error

    def _deadline_expired(self, run: WorkflowRunSnapshot) -> bool:
        if run.started_at is None:
            raise RuntimeError("Running run is missing its persisted start time")
        return (
            run.started_at + timedelta(seconds=run.budget.timeout_seconds)
            <= self._now()
        )

    async def _handle_failure(self, run_id: UUID, error: Exception) -> None:
        try:
            current = await self._repository.get_workflow_run_snapshot(run_id)
        except Exception:
            return
        if current.run_status not in _ACTIVE_RUN_STATUSES:
            return
        contract = classify_diagnosis_failure(error)
        code, retryable = contract or ("recovery_consistency_error", False)
        try:
            await self._persist_failure(run_id, code, retryable)
        except Exception:
            return

    async def _persist_failure(
        self,
        run_id: UUID,
        code: str,
        retryable: bool,
    ) -> None:
        await self._repository.persist_terminal(
            TerminalRecord(
                run_id=run_id,
                completed_at=self._now(),
                outcome=None,
                summary=None,
                root_causes=(),
                missing_information=(),
                redacted=False,
                error_code=code,
                error_retryable=retryable,
                model_calls=None,
                tool_calls=None,
                input_tokens=None,
                output_tokens=None,
            )
        )

    def _task_done(
        self,
        run_id: UUID,
        task: asyncio.Task[None],
    ) -> None:
        if self._tasks.get(run_id) is task:
            self._tasks.pop(run_id, None)
        if not task.cancelled():
            task.exception()


def _require_pre_start_state(state: StateSnapshot, run_id: UUID) -> None:
    values = cast(dict[str, object], state.values)
    if values != {"run_id": str(run_id), "messages": []}:
        raise RuntimeError("Queued run checkpoint is not at the start boundary")
    metadata = cast(dict[str, object], state.metadata or {})
    tasks = tuple(state.tasks)
    complete_barrier = (
        tuple(state.next) == ("start_run",)
        and metadata.get("source") == "loop"
        and metadata.get("step") == 0
        and _has_pending_task(tasks, "start_run")
        and getattr(tasks[0], "state", None) is None
        and getattr(tasks[0], "result", None) is None
    )
    partial_input = (
        tuple(state.next) == ()
        and metadata.get("source") == "input"
        and metadata.get("step") == -1
        and _has_pending_task(tasks, "__start__")
        and getattr(tasks[0], "state", None) is None
        and getattr(tasks[0], "result", None) == {"run_id": str(run_id)}
    )
    if not complete_barrier and not partial_input:
        raise RuntimeError("Queued run checkpoint is not at the start boundary")


def _checkpoint_node(state: StateSnapshot) -> str:
    next_nodes = tuple(state.next)
    if (
        len(next_nodes) != 1
        or next_nodes[0] not in _WORKFLOW_NODES
        or not _has_pending_task(tuple(state.tasks), next_nodes[0])
    ):
        raise RuntimeError("Run checkpoint is not resumable")
    return next_nodes[0]


def _checkpoint_terminal_error(
    values: dict[str, object],
) -> tuple[str, bool] | None:
    has_code = "terminal_error_code" in values
    has_retryable = "terminal_error_retryable" in values
    if not has_code and not has_retryable:
        return None
    code = values.get("terminal_error_code")
    retryable = values.get("terminal_error_retryable")
    if not isinstance(code, str) or not isinstance(retryable, bool):
        raise RecoveryConsistencyError
    require_terminal_error_contract(code, retryable)
    return code, retryable


def _require_checkpoint_identity(
    values: dict[str, object],
    run: WorkflowRunSnapshot,
) -> None:
    try:
        target = KubernetesTarget.model_validate(values.get("target"))
    except ValidationError:
        raise RuntimeError("Running run checkpoint identity does not match") from None
    if (
        values.get("incident_id") != str(run.incident_id)
        or values.get("trigger_summary") != run.trigger_summary
        or target != run.target
    ):
        raise RuntimeError("Running run checkpoint identity does not match")


def _has_pending_task(tasks: tuple[object, ...], node: str) -> bool:
    if len(tasks) != 1:
        return False
    task = tasks[0]
    return (
        getattr(task, "name", None) == node
        and getattr(task, "error", None) is None
        and getattr(task, "interrupts", None) == ()
    )
