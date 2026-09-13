from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import datetime, timedelta
from pathlib import Path
from typing import cast
from uuid import UUID, uuid4

import pytest
from langchain_core.language_models import BaseChatModel
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command
from sqlalchemy import delete, select, text
from sqlalchemy.exc import IntegrityError
from tests.factories import prometheus_query_service_stub
from tests.unit.persistence.test_repair_persistence import (
    BUDGET,
    MODEL,
    _database,  # pyright: ignore[reportPrivateUsage]
)
from tests.unit.repair.test_repair_preparation import (
    FRESH_NOW,
    KubernetesFixture,
    ValidatorFixture,
    create_preparation,
    credential,
    seed_source,
)

from k8s_incident_agent.diagnosis.policy import DiagnosticPolicyResolver
from k8s_incident_agent.domain.models import RepairWorkflowRunSnapshot, RunStatus
from k8s_incident_agent.kubernetes.errors import KubernetesErrorCode
from k8s_incident_agent.persistence.models import RunRow
from k8s_incident_agent.persistence.repositories import (
    ActiveRunExistsError,
    IncidentRepository,
    RepairSourceInvalidError,
)
from k8s_incident_agent.repair.client import PatchValidator
from k8s_incident_agent.repair.preparation import prepare_repair
from k8s_incident_agent.workflow.checkpoint import open_checkpoint_store
from k8s_incident_agent.workflow.graph import GraphDependencies, build_incident_graph
from k8s_incident_agent.workflow.supervisor import RunSupervisor


def dependencies(
    repository: IncidentRepository,
    checkpointer: AsyncSqliteSaver,
    fixture: KubernetesFixture,
    now: Callable[[], datetime],
) -> GraphDependencies:
    return GraphDependencies(
        repository=repository,
        checkpointer=checkpointer,
        model=None,
        model_snapshot=MODEL,
        credential=credential(),
        adapter=fixture.adapter(),
        prometheus=prometheus_query_service_stub(),
        now=now,
        patch_validator=cast(PatchValidator, ValidatorFixture()),
    )


def supervisor(
    repository: IncidentRepository,
    saver: AsyncSqliteSaver,
    fixture: KubernetesFixture,
    now: Callable[[], datetime],
) -> RunSupervisor:
    def unavailable_model() -> BaseChatModel | None:
        raise AssertionError(
            "A repair Run cannot access model availability or construct a model"
        )

    return RunSupervisor(
        repository=repository,
        checkpointer=saver,
        model=unavailable_model,
        model_snapshot=MODEL,
        credential=credential(),
        adapter=fixture.adapter(),
        prometheus=prometheus_query_service_stub(),
        policies=cast(DiagnosticPolicyResolver, object()),
        now=now,
        patch_validator=cast(PatchValidator, ValidatorFixture()),
    )


async def settled(
    repository: IncidentRepository, run_id: UUID
) -> RepairWorkflowRunSnapshot:
    async with asyncio.timeout(3):
        while True:
            run = await repository.get_workflow_run_snapshot(run_id)
            assert isinstance(run, RepairWorkflowRunSnapshot)
            if run.run_status not in (RunStatus.QUEUED, RunStatus.RUNNING):
                return run
            await asyncio.sleep(0.01)


async def test_restart_uses_persisted_preparation_deadline(tmp_path: Path) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, source_id = await seed_source(repository)
        run = await create_preparation(repository, incident_id, source_id)
        async with open_checkpoint_store(tmp_path / "checkpoint.sqlite3") as saver:
            graph = build_incident_graph(
                dependencies(repository, saver, KubernetesFixture(), lambda: FRESH_NOW),
                run,
            )
            await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                {"run_id": str(run.id)},
                {"configurable": {"thread_id": str(run.id)}},
                interrupt_before=["prepare_repair"],
                durability="sync",
            )
        async with open_checkpoint_store(tmp_path / "checkpoint.sqlite3") as saver:
            worker = supervisor(
                repository,
                saver,
                KubernetesFixture(),
                lambda: FRESH_NOW + timedelta(seconds=61),
            )
            await worker.start()
            await worker.close()
        detail = await repository.get_incident_detail(
            incident_id, run_id=run.id, event_limit=100
        )
        assert detail is not None and detail.run.error_code == "repair_timeout"
        assert (
            detail.run.started_at == FRESH_NOW
            and detail.repair is None
            and detail.evidence == ()
        )


async def test_superseded_thread_cannot_change_successor_and_source_fk_allows_aggregate_prune(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, source_id = await seed_source(repository)
        run = await create_preparation(repository, incident_id, source_id)
        async with open_checkpoint_store(tmp_path / "checkpoint.sqlite3") as saver:
            graph = build_incident_graph(
                dependencies(repository, saver, KubernetesFixture(), lambda: FRESH_NOW),
                run,
            )
            config: RunnableConfig = {"configurable": {"thread_id": str(run.id)}}
            await graph.ainvoke({"run_id": str(run.id)}, config, durability="sync")  # pyright: ignore[reportUnknownMemberType]
            successor = await repository.create_repair_run(
                incident_id,
                run.id,
                selection=None,
                replaces_run_id=run.id,
                operator_ref="sandbox-operator",
                now=FRESH_NOW,
            )
            assert successor is not None
            before = await repository.get_incident_detail(
                incident_id, run_id=successor.run_id, event_limit=100
            )
            await graph.ainvoke(None, config, durability="sync")  # pyright: ignore[reportUnknownMemberType]
            after = await repository.get_incident_detail(
                incident_id, run_id=successor.run_id, event_limit=100
            )
            assert (
                after == before
                and after is not None
                and after.run.status is RunStatus.QUEUED
            )
        with pytest.raises(IntegrityError):
            async with database.session_factory() as session, session.begin():
                await session.execute(delete(RunRow).where(RunRow.id == str(source_id)))
        await repository.fail_repair_run(
            successor.run_id, "recovery_consistency_error", False, FRESH_NOW
        )
        cutoff = FRESH_NOW + timedelta(days=365)
        targets = await repository.list_prune_targets(cutoff, tmp_path / "artifacts")
        assert len(targets) == 1 and set(targets[0].run_ids) == {
            source_id,
            run.id,
            successor.run_id,
        }
        assert await repository.delete_prune_target(
            targets[0], cutoff, tmp_path / "artifacts"
        )
        async with database.session_factory() as session:
            assert list(await session.scalars(select(RunRow))) == []
            assert (await session.execute(text("PRAGMA foreign_key_check"))).all() == []


async def test_dynamic_interrupt_survives_restart_without_model_or_new_proposal(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, source_id = await seed_source(repository)
        created = await repository.create_repair_run(
            incident_id,
            source_id,
            selection=None,
            replaces_run_id=None,
            operator_ref="sandbox-operator",
            now=FRESH_NOW,
        )
        assert created is not None
        async with open_checkpoint_store(tmp_path / "checkpoint.sqlite3") as saver:
            worker = supervisor(
                repository, saver, KubernetesFixture(), lambda: FRESH_NOW
            )
            await worker.start()
            waiting = await settled(repository, created.run_id)
            await worker.close()
            assert waiting.run_status is RunStatus.WAITING_APPROVAL
            graph = build_incident_graph(
                dependencies(repository, saver, KubernetesFixture(), lambda: FRESH_NOW),
                waiting,
            )
            state = await graph.aget_state(
                {"configurable": {"thread_id": str(created.run_id)}}
            )  # pyright: ignore[reportUnknownMemberType]
            assert state.tasks[0].interrupts[0].value == {
                "runId": str(created.run_id),
                "proposalId": str(waiting.proposal_id),
            }
        before = await repository.get_incident_detail(
            incident_id, run_id=created.run_id, event_limit=100
        )
        fixture = KubernetesFixture()
        fixture.error = KubernetesErrorCode.PERMISSION_DENIED
        async with open_checkpoint_store(tmp_path / "checkpoint.sqlite3") as saver:
            restarted = supervisor(
                repository, saver, fixture, lambda: FRESH_NOW + timedelta(minutes=10)
            )
            await restarted.start()
            await restarted.close()
            await repository.expire_waiting_repairs(FRESH_NOW + timedelta(minutes=15))
            expired = await repository.get_workflow_run_snapshot(created.run_id)
            assert isinstance(expired, RepairWorkflowRunSnapshot)
            assert (
                expired.run_status is RunStatus.COMPLETED
                and expired.end_reason == "expired"
            )
            assert (
                expired.proposal_id == waiting.proposal_id
                and expired.waiting_expires_at == waiting.waiting_expires_at
            )
        after = await repository.get_incident_detail(
            incident_id, run_id=created.run_id, event_limit=100
        )
        assert before is not None and after is not None
        assert after.repair == before.repair and after.evidence == before.evidence
        assert await repository.list_recoverable_run_ids() == ()


async def test_business_wait_commit_ahead_of_checkpoint_reuses_the_same_proposal(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, source_id = await seed_source(repository)
        created = await repository.create_repair_run(
            incident_id,
            source_id,
            selection=None,
            replaces_run_id=None,
            operator_ref="sandbox-operator",
            now=FRESH_NOW,
        )
        assert created is not None
        run = await repository.get_workflow_run_snapshot(created.run_id)
        assert isinstance(run, RepairWorkflowRunSnapshot)
        async with open_checkpoint_store(tmp_path / "checkpoint.sqlite3") as saver:
            graph = build_incident_graph(
                dependencies(repository, saver, KubernetesFixture(), lambda: FRESH_NOW),
                run,
            )
            await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
                {"run_id": str(run.id)},
                {"configurable": {"thread_id": str(run.id)}},
                interrupt_before=["prepare_repair"],
                durability="sync",
            )
            running = await repository.get_workflow_run_snapshot(run.id)
            assert isinstance(running, RepairWorkflowRunSnapshot)
            prepared = await prepare_repair(
                running,
                repository=repository,
                adapter=KubernetesFixture().adapter(),
                credential=credential(),
                validator=cast(PatchValidator, ValidatorFixture()),
                now=lambda: FRESH_NOW,
            )
            await repository.persist_prepared_repair(prepared)
        fixture = KubernetesFixture()
        fixture.error = KubernetesErrorCode.PERMISSION_DENIED
        async with open_checkpoint_store(tmp_path / "checkpoint.sqlite3") as saver:
            worker = supervisor(
                repository, saver, fixture, lambda: FRESH_NOW + timedelta(minutes=10)
            )
            await worker.start()
            await worker.close()
            waiting = await repository.get_workflow_run_snapshot(run.id)
            assert isinstance(waiting, RepairWorkflowRunSnapshot)
            assert waiting.run_status is RunStatus.WAITING_APPROVAL
            assert (
                prepared.proposal is not None
                and waiting.proposal_id == prepared.proposal.id
            )
            assert waiting.waiting_expires_at == FRESH_NOW + timedelta(minutes=15)
            graph = build_incident_graph(
                dependencies(repository, saver, fixture, lambda: FRESH_NOW), waiting
            )
            state = await graph.aget_state({"configurable": {"thread_id": str(run.id)}})  # pyright: ignore[reportUnknownMemberType]
            assert state.tasks[0].interrupts


@pytest.mark.parametrize("proposal_id", [None, str(uuid4())])
async def test_wait_checkpoint_missing_or_mismatched_proposal_fails_closed(
    tmp_path: Path, proposal_id: str | None
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, source_id = await seed_source(repository)
        run = await create_preparation(repository, incident_id, source_id)
        async with open_checkpoint_store(tmp_path / "checkpoint.sqlite3") as saver:
            graph = build_incident_graph(
                dependencies(repository, saver, KubernetesFixture(), lambda: FRESH_NOW),
                run,
            )
            config: RunnableConfig = {"configurable": {"thread_id": str(run.id)}}
            await graph.ainvoke({"run_id": str(run.id)}, config, durability="sync")  # pyright: ignore[reportUnknownMemberType]
            checkpoint = await saver.aget_tuple(config)
            assert checkpoint is not None and checkpoint.parent_config is not None
            checkpoint.checkpoint["channel_values"]["repair_proposal_id"] = proposal_id
            await saver.aput(
                checkpoint.parent_config, checkpoint.checkpoint, checkpoint.metadata, {}
            )
            parked = await graph.aget_state(config)  # pyright: ignore[reportUnknownMemberType]
            assert parked.tasks[0].interrupts
            worker = supervisor(
                repository, saver, KubernetesFixture(), lambda: FRESH_NOW
            )
            await worker.start()
            await worker.close()
            detail = await repository.get_incident_detail(
                incident_id, run_id=run.id, event_limit=100
            )
            assert detail is not None and detail.run.status is RunStatus.FAILED
            assert (
                detail.run.error_code == "recovery_consistency_error"
                and detail.repair is not None
            )


async def test_unapproved_resume_cannot_leave_waiting_for_execution(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, source_id = await seed_source(repository)
        run = await create_preparation(repository, incident_id, source_id)
        async with open_checkpoint_store(tmp_path / "checkpoint.sqlite3") as saver:
            graph = build_incident_graph(
                dependencies(repository, saver, KubernetesFixture(), lambda: FRESH_NOW),
                run,
            )
            config: RunnableConfig = {"configurable": {"thread_id": str(run.id)}}
            await graph.ainvoke({"run_id": str(run.id)}, config, durability="sync")  # pyright: ignore[reportUnknownMemberType]
            await graph.ainvoke(None, config, durability="sync")  # pyright: ignore[reportUnknownMemberType]
            waiting = await repository.get_workflow_run_snapshot(run.id)
            assert waiting.run_status is RunStatus.WAITING_APPROVAL
            with pytest.raises(Exception, match="Persisted state conflicts"):
                await graph.ainvoke(Command(resume=True), config, durability="sync")  # pyright: ignore[reportUnknownMemberType]
            assert (
                await repository.get_workflow_run_snapshot(run.id)
            ).run_status is RunStatus.WAITING_APPROVAL


async def test_two_tabs_cannot_replace_the_same_waiting_run_or_revive_it(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, source_id = await seed_source(repository)
        run = await create_preparation(repository, incident_id, source_id)
        prepared = await prepare_repair(
            run,
            repository=repository,
            adapter=KubernetesFixture().adapter(),
            credential=credential(),
            validator=cast(PatchValidator, ValidatorFixture()),
            now=lambda: FRESH_NOW,
        )
        await repository.persist_prepared_repair(prepared)
        results = await asyncio.gather(
            repository.create_run(
                incident_id,
                MODEL,
                BUDGET,
                replaces_run_id=run.id,
                operator_ref="sandbox-operator",
            ),
            repository.create_repair_run(
                incident_id,
                run.id,
                selection=None,
                replaces_run_id=run.id,
                operator_ref="sandbox-operator",
                now=FRESH_NOW,
            ),
            return_exceptions=True,
        )
        assert sum(isinstance(item, ActiveRunExistsError) for item in results) == 1
        assert all(
            not isinstance(item, Exception) or isinstance(item, ActiveRunExistsError)
            for item in results
        )
        ended = await repository.get_workflow_run_snapshot(run.id)
        assert (
            isinstance(ended, RepairWorkflowRunSnapshot)
            and ended.run_status is RunStatus.COMPLETED
        )
        assert ended.end_reason in ("superseded", "expired")
        with pytest.raises(ActiveRunExistsError):
            await repository.create_run(
                incident_id, MODEL, BUDGET, replaces_run_id=run.id
            )


async def test_cross_incident_or_missing_source_proposal_is_rejected(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        repository = IncidentRepository(database.session_factory)
        incident_id, source_id = await seed_source(repository)
        other_incident, _ = await seed_source(repository)
        for source in (source_id, uuid4()):
            with pytest.raises(RepairSourceInvalidError):
                await repository.create_repair_run(
                    other_incident,
                    source,
                    selection=None,
                    replaces_run_id=None,
                    operator_ref="sandbox-operator",
                    now=FRESH_NOW,
                )
        assert await repository.list_recoverable_run_ids() == ()
        assert incident_id != other_incident
