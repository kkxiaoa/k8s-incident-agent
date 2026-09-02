from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from langchain_core.runnables.config import RunnableConfig
from langgraph.checkpoint.base import CheckpointMetadata, empty_checkpoint
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from sqlalchemy import func, select, text
from tests.factories import normalized_trigger

import k8s_incident_agent.runtime.deletion as deletion_module
import k8s_incident_agent.runtime.retention as retention_module
from k8s_incident_agent.config import Settings
from k8s_incident_agent.domain.models import (
    DiagnosisOutcome,
    EvidenceRecord,
    ModelSnapshot,
    RootCauseRecord,
    RunBudget,
    TerminalRecord,
)
from k8s_incident_agent.persistence.database import (
    BusinessDatabase,
    create_business_database,
)
from k8s_incident_agent.persistence.models import (
    DiagnosisRow,
    EvidenceRow,
    IncidentRow,
    RunEventRow,
    RunRow,
)
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    PersistenceOperationError,
    RecoveryConsistencyError,
)
from k8s_incident_agent.runtime.lock import (
    RuntimeLock,
    RuntimeLockUnavailableError,
)
from k8s_incident_agent.runtime.paths import RuntimePaths
from k8s_incident_agent.runtime.retention import confirm_prune, preview_prune
from k8s_incident_agent.workflow.checkpoint import open_checkpoint_store

SERVICE_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2030, 1, 15, 12, 0, tzinfo=UTC)
CUTOFF = NOW - timedelta(days=7)


def _alembic_config(paths: RuntimePaths) -> Config:
    config = Config(str(SERVICE_ROOT / "alembic.ini"))
    config.attributes["runtime_paths"] = paths
    return config


def _settings(paths: RuntimePaths) -> Settings:
    return Settings.model_validate(
        {
            "RUNTIME_DATA_DIR": paths,
            "RUNTIME_RETENTION_DAYS": 7,
        }
    )


def _scenario():
    return normalized_trigger()


def _model() -> ModelSnapshot:
    return ModelSnapshot(
        provider="deepseek",
        model_id="deepseek-v4-flash",
        thinking_mode=False,
        prompt_version="stage1-v1",
    )


def _budget() -> RunBudget:
    return RunBudget(max_model_calls=8, max_tool_calls=6, timeout_seconds=180)


async def _open_database(paths: RuntimePaths) -> BusinessDatabase:
    return await create_business_database(paths)


async def _create_failed_run(
    repository: IncidentRepository,
    completed_at: datetime,
) -> tuple[UUID, UUID]:
    created = await repository.create_incident_and_run(
        _scenario(),
        _model(),
        _budget(),
    )
    await repository.persist_terminal(
        TerminalRecord(
            run_id=created.run_id,
            completed_at=completed_at,
            outcome=None,
            summary=None,
            root_causes=(),
            missing_information=(),
            redacted=False,
            error_code="model_upstream_failed",
            error_retryable=True,
            model_calls=None,
            tool_calls=None,
            input_tokens=None,
            output_tokens=None,
        )
    )
    return created.incident_id, created.run_id


async def _create_diagnosed_run(
    repository: IncidentRepository,
    completed_at: datetime,
) -> tuple[UUID, UUID]:
    created = await repository.create_incident_and_run(
        _scenario(),
        _model(),
        _budget(),
    )
    await repository.start_run(created.run_id, completed_at - timedelta(days=2))
    await repository.record_tool_started(created.run_id, "call-1", "get_pods")
    evidence = await repository.record_evidence(
        EvidenceRecord(
            run_id=created.run_id,
            tool_call_id="call-1",
            tool_name="get_pods",
            evidence_kind="pod_waiting_state",
            target_ref={"name": "image-pull-backoff"},
            observed_at=completed_at - timedelta(days=1),
            payload={"waitingReason": "ImagePullBackOff"},
            truncated=False,
            redacted=False,
        )
    )
    await repository.persist_terminal(
        TerminalRecord(
            run_id=created.run_id,
            completed_at=completed_at,
            outcome=DiagnosisOutcome.DIAGNOSED,
            summary="The image cannot be pulled.",
            root_causes=(
                RootCauseRecord(
                    code="image_pull_failure",
                    statement="The configured image does not exist.",
                    confidence="high",
                    evidence_ids=(evidence.id,),
                ),
            ),
            missing_information=(),
            redacted=False,
            error_code=None,
            error_retryable=None,
            model_calls=2,
            tool_calls=1,
            input_tokens=100,
            output_tokens=50,
        )
    )
    return created.incident_id, created.run_id


async def _row_count(
    paths: RuntimePaths,
    row_type: type[object],
) -> int:
    database = await _open_database(paths)
    try:
        async with database.session_factory() as session:
            count = await session.scalar(select(func.count()).select_from(row_type))
        assert isinstance(count, int)
        return count
    finally:
        await database.dispose()


async def _seed_checkpoint(paths: RuntimePaths, run_id: UUID) -> None:
    config: RunnableConfig = {
        "configurable": {"thread_id": str(run_id), "checkpoint_ns": ""}
    }
    metadata = cast(
        CheckpointMetadata,
        {"source": "input", "step": -1, "parents": {}},
    )
    async with open_checkpoint_store(paths.checkpoint_database) as saver:
        await saver.aput(config, empty_checkpoint(), metadata, {})


async def _has_checkpoint(paths: RuntimePaths, run_id: UUID) -> bool:
    config: RunnableConfig = {"configurable": {"thread_id": str(run_id)}}
    async with open_checkpoint_store(paths.checkpoint_database) as saver:
        return await saver.aget_tuple(config) is not None


def _write_artifact(paths: RuntimePaths, run_id: UUID) -> Path:
    paths.run_artifacts.mkdir(mode=0o700, exist_ok=True)
    directory = paths.run_artifacts / str(run_id)
    directory.mkdir(mode=0o700)
    artifact = directory / "trace.json"
    artifact.write_text("{}", encoding="utf-8")
    artifact.chmod(0o600)
    return directory


@pytest.mark.asyncio
async def test_preview_selects_only_terminal_incidents_before_cutoff(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await _open_database(paths)
    try:
        repository = IncidentRepository(database.session_factory)
        _, eligible_run_id = await _create_failed_run(
            repository,
            CUTOFF - timedelta(microseconds=1),
        )
        await _create_failed_run(repository, CUTOFF)
        queued = await repository.create_incident_and_run(
            _scenario(), _model(), _budget()
        )
        async with database.session_factory() as session, session.begin():
            queued_row = await session.get(RunRow, str(queued.run_id))
            assert queued_row is not None
            queued_row.completed_at = CUTOFF - timedelta(days=1)
    finally:
        await database.dispose()

    targets = await preview_prune(_settings(paths), NOW)

    assert [target.run_ids for target in targets] == [(eligible_run_id,)]
    assert targets[0].event_rows == 2
    assert targets[0].evidence_rows == 0
    assert targets[0].diagnosis_rows == 0
    assert targets[0].artifact_directories == (
        paths.run_artifact_directory(eligible_run_id),
    )
    assert targets[0].run_rows == 1
    assert await _row_count(paths, RunRow) == 3


@pytest.mark.asyncio
async def test_preview_fails_closed_on_inconsistent_terminal_run(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await _open_database(paths)
    try:
        repository = IncidentRepository(database.session_factory)
        _, run_id = await _create_failed_run(
            repository,
            CUTOFF - timedelta(days=1),
        )
        async with database.session_factory() as session, session.begin():
            run = await session.get(RunRow, str(run_id))
            assert run is not None
            run.completed_at = None
    finally:
        await database.dispose()

    with pytest.raises(RecoveryConsistencyError):
        await preview_prune(_settings(paths), NOW)


@pytest.mark.asyncio
async def test_preview_does_not_modify_business_checkpoint_or_artifact_data(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await _open_database(paths)
    try:
        repository = IncidentRepository(database.session_factory)
        _, run_id = await _create_diagnosed_run(
            repository,
            CUTOFF - timedelta(days=1),
        )
    finally:
        await database.dispose()
    artifact_directory = _write_artifact(paths, run_id)
    await _seed_checkpoint(paths, run_id)

    targets = await preview_prune(_settings(paths), NOW)

    assert len(targets) == 1
    assert targets[0].event_rows == 5
    assert targets[0].evidence_rows == 1
    assert targets[0].diagnosis_rows == 1
    assert artifact_directory.is_dir()
    assert await _has_checkpoint(paths, run_id)
    assert await _row_count(paths, IncidentRow) == 1
    assert await _row_count(paths, RunRow) == 1
    assert await _row_count(paths, RunEventRow) == 5
    assert await _row_count(paths, EvidenceRow) == 1
    assert await _row_count(paths, DiagnosisRow) == 1


@pytest.mark.asyncio
async def test_confirm_deletes_artifact_checkpoint_and_business_rows_idempotently(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await _open_database(paths)
    try:
        repository = IncidentRepository(database.session_factory)
        _, run_id = await _create_diagnosed_run(
            repository,
            CUTOFF - timedelta(days=1),
        )
    finally:
        await database.dispose()
    artifact_directory = _write_artifact(paths, run_id)
    await _seed_checkpoint(paths, run_id)

    first = await confirm_prune(_settings(paths), NOW)
    second = await confirm_prune(_settings(paths), NOW)

    assert [target.run_ids for target in first.deleted_targets] == [(run_id,)]
    assert second.deleted_targets == ()
    assert not artifact_directory.exists()
    assert not await _has_checkpoint(paths, run_id)
    assert await _row_count(paths, IncidentRow) == 0
    assert await _row_count(paths, RunRow) == 0
    assert await _row_count(paths, RunEventRow) == 0
    assert await _row_count(paths, EvidenceRow) == 0
    assert await _row_count(paths, DiagnosisRow) == 0


@pytest.mark.asyncio
async def test_confirm_prunes_all_runs_only_as_one_incident_aggregate(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await _open_database(paths)
    try:
        repository = IncidentRepository(database.session_factory)
        incident_id, first_run_id = await _create_diagnosed_run(
            repository,
            CUTOFF - timedelta(days=2),
        )
        second = await repository.create_run(incident_id, _model(), _budget())
        assert second is not None
        await repository.persist_terminal(
            TerminalRecord(
                run_id=second.run_id,
                completed_at=CUTOFF - timedelta(days=1),
                outcome=None,
                summary=None,
                root_causes=(),
                missing_information=(),
                redacted=False,
                error_code="model_upstream_failed",
                error_retryable=True,
                model_calls=None,
                tool_calls=None,
                input_tokens=None,
                output_tokens=None,
            )
        )
    finally:
        await database.dispose()

    run_ids = (first_run_id, second.run_id)
    artifacts = tuple(_write_artifact(paths, run_id) for run_id in run_ids)
    for run_id in run_ids:
        await _seed_checkpoint(paths, run_id)

    preview = await preview_prune(_settings(paths), NOW)
    assert len(preview) == 1
    assert preview[0].incident_id == incident_id
    assert preview[0].run_ids == run_ids
    assert preview[0].run_rows == 2
    assert preview[0].event_rows == 7

    result = await confirm_prune(_settings(paths), NOW)

    assert result.deleted_targets == preview
    assert all(not artifact.exists() for artifact in artifacts)
    for run_id in run_ids:
        assert not await _has_checkpoint(paths, run_id)
    assert await _row_count(paths, IncidentRow) == 0
    assert await _row_count(paths, RunRow) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["artifact", "checkpoint"])
async def test_external_cleanup_failure_preserves_business_rows(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    failure: str,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await _open_database(paths)
    try:
        repository = IncidentRepository(database.session_factory)
        _, run_id = await _create_failed_run(
            repository,
            CUTOFF - timedelta(days=1),
        )
    finally:
        await database.dispose()
    artifact_directory = _write_artifact(paths, run_id)
    await _seed_checkpoint(paths, run_id)

    if failure == "artifact":

        def fail_rmtree(_path: str, *, dir_fd: int | None = None) -> None:
            assert dir_fd is not None
            raise PermissionError("artifact is locked")

        monkeypatch.setattr(deletion_module.shutil, "rmtree", fail_rmtree)
    else:

        class _FailingSaver:
            async def adelete_thread(self, _thread_id: str) -> None:
                raise OSError("checkpoint deletion failed")

        @asynccontextmanager
        async def failing_checkpoint_store(
            _path: Path,
        ) -> AsyncGenerator[AsyncSqliteSaver]:
            yield cast(AsyncSqliteSaver, _FailingSaver())

        monkeypatch.setattr(
            retention_module,
            "open_checkpoint_store",
            failing_checkpoint_store,
        )

    with pytest.raises(OSError):
        await confirm_prune(_settings(paths), NOW)

    assert await _row_count(paths, RunRow) == 1
    if failure == "artifact":
        assert artifact_directory.exists()
        assert await _has_checkpoint(paths, run_id)
    else:
        assert not artifact_directory.exists()


@pytest.mark.asyncio
async def test_incomplete_identity_claim_blocks_prune_before_business_delete(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await _open_database(paths)
    try:
        repository = IncidentRepository(database.session_factory)
        _, run_id = await _create_failed_run(
            repository,
            CUTOFF - timedelta(days=1),
        )
    finally:
        await database.dispose()
    artifact_directory = _write_artifact(paths, run_id)
    claim_directory = paths.run_artifacts / ".runtime-delete-interrupted"
    claim_directory.mkdir(mode=0o700)
    artifact_directory.rename(claim_directory / "target")

    with pytest.raises(RuntimeError, match="incomplete identity-bound deletion"):
        await confirm_prune(_settings(paths), NOW)

    assert (claim_directory / "target" / "trace.json").exists()
    assert await _row_count(paths, RunRow) == 1


@pytest.mark.asyncio
async def test_business_delete_failure_rolls_back_all_business_rows(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await _open_database(paths)
    try:
        repository = IncidentRepository(database.session_factory)
        _, run_id = await _create_failed_run(
            repository,
            CUTOFF - timedelta(days=1),
        )
        async with database.engine.begin() as connection:
            await connection.execute(
                text(
                    "CREATE TRIGGER fail_run_delete BEFORE DELETE ON agent_runs "
                    "BEGIN SELECT RAISE(ABORT, 'delete failed'); END"
                )
            )
    finally:
        await database.dispose()
    artifact_directory = _write_artifact(paths, run_id)
    await _seed_checkpoint(paths, run_id)

    with pytest.raises(PersistenceOperationError):
        await confirm_prune(_settings(paths), NOW)

    assert not artifact_directory.exists()
    assert not await _has_checkpoint(paths, run_id)
    assert await _row_count(paths, IncidentRow) == 1
    assert await _row_count(paths, RunRow) == 1
    assert await _row_count(paths, RunEventRow) == 2


@pytest.mark.asyncio
async def test_count_change_before_business_transaction_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await _open_database(paths)
    try:
        repository = IncidentRepository(database.session_factory)
        _, run_id = await _create_failed_run(
            repository,
            CUTOFF - timedelta(days=1),
        )
    finally:
        await database.dispose()
    _write_artifact(paths, run_id)
    await _seed_checkpoint(paths, run_id)
    real_checkpoint_store = retention_module.open_checkpoint_store

    class _MutatingSaver:
        def __init__(self, saver: AsyncSqliteSaver) -> None:
            self._saver = saver

        async def adelete_thread(self, thread_id: str) -> None:
            await self._saver.adelete_thread(thread_id)
            mutation_database = await _open_database(paths)
            try:
                async with (
                    mutation_database.session_factory() as session,
                    session.begin(),
                ):
                    session.add(
                        RunEventRow(
                            run_id=str(run_id),
                            event_key="concurrent-change",
                            event_type="test.concurrent-change",
                            schema_version=3,
                            occurred_at=NOW,
                            payload_json="{}",
                        )
                    )
            finally:
                await mutation_database.dispose()

    @asynccontextmanager
    async def mutating_checkpoint_store(
        path: Path,
    ) -> AsyncGenerator[AsyncSqliteSaver]:
        async with real_checkpoint_store(path) as saver:
            yield cast(AsyncSqliteSaver, _MutatingSaver(saver))

    monkeypatch.setattr(
        retention_module,
        "open_checkpoint_store",
        mutating_checkpoint_store,
    )

    with pytest.raises(RecoveryConsistencyError):
        await confirm_prune(_settings(paths), NOW)

    assert await _row_count(paths, RunRow) == 1
    assert await _row_count(paths, RunEventRow) == 3
    assert not await _has_checkpoint(paths, run_id)


@pytest.mark.asyncio
async def test_symlink_artifact_is_rejected_without_touching_external_target(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await _open_database(paths)
    try:
        repository = IncidentRepository(database.session_factory)
        _, run_id = await _create_failed_run(
            repository,
            CUTOFF - timedelta(days=1),
        )
    finally:
        await database.dispose()
    paths.run_artifacts.mkdir(mode=0o700)
    external = tmp_path / "external"
    external.mkdir(mode=0o700)
    sentinel = external / "sentinel.txt"
    sentinel.write_text("keep", encoding="utf-8")
    sentinel.chmod(0o600)
    paths.run_artifact_directory(run_id).symlink_to(
        external,
        target_is_directory=True,
    )

    with pytest.raises(ValueError):
        await confirm_prune(_settings(paths), NOW)

    assert sentinel.read_text(encoding="utf-8") == "keep"
    assert await _row_count(paths, RunRow) == 1


@pytest.mark.asyncio
async def test_parent_swap_cannot_redirect_artifact_deletion(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await _open_database(paths)
    try:
        repository = IncidentRepository(database.session_factory)
        _, run_id = await _create_failed_run(
            repository,
            CUTOFF - timedelta(days=1),
        )
    finally:
        await database.dispose()
    artifact_directory = _write_artifact(paths, run_id)
    original_artifact_root = tmp_path / "original-runs"
    external_artifact_root = tmp_path / "external-runs"
    external_directory = external_artifact_root / str(run_id)
    external_directory.mkdir(parents=True, mode=0o700)
    sentinel = external_directory / "sentinel.txt"
    sentinel.write_text("keep", encoding="utf-8")
    sentinel.chmod(0o600)
    real_rename = deletion_module.os.rename

    def swap_parent_then_delete(
        source: str,
        destination: str,
        *,
        src_dir_fd: int | None = None,
        dst_dir_fd: int | None = None,
    ) -> None:
        assert source == str(run_id)
        assert src_dir_fd is not None
        real_rename(paths.run_artifacts, original_artifact_root)
        paths.run_artifacts.symlink_to(
            external_artifact_root,
            target_is_directory=True,
        )
        real_rename(
            source,
            destination,
            src_dir_fd=src_dir_fd,
            dst_dir_fd=dst_dir_fd,
        )

    monkeypatch.setattr(
        deletion_module.os,
        "rename",
        swap_parent_then_delete,
    )

    result = await confirm_prune(_settings(paths), NOW)

    assert [target.run_ids for target in result.deleted_targets] == [(run_id,)]
    assert not (original_artifact_root / artifact_directory.name).exists()
    assert sentinel.read_text(encoding="utf-8") == "keep"
    assert await _row_count(paths, RunRow) == 0


@pytest.mark.asyncio
async def test_forged_artifact_root_and_target_path_are_rejected(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    outside = tmp_path / "outside"
    forged_paths = replace(paths, run_artifacts=outside)

    with pytest.raises(ValueError, match="fixed layout"):
        await preview_prune(_settings(forged_paths), NOW)

    database = await _open_database(paths)
    try:
        repository = IncidentRepository(database.session_factory)
        _, run_id = await _create_failed_run(
            repository,
            CUTOFF - timedelta(days=1),
        )
        targets = await repository.list_prune_targets(CUTOFF, paths.run_artifacts)
        mismatched = replace(
            targets[0],
            artifact_directories=(outside / str(run_id),),
        )
        with pytest.raises(RecoveryConsistencyError):
            await repository.delete_prune_target(
                mismatched,
                CUTOFF,
                paths.run_artifacts,
            )
    finally:
        await database.dispose()

    assert await _row_count(paths, RunRow) == 1


@pytest.mark.asyncio
async def test_preview_requires_runtime_lock_and_aware_time(tmp_path: Path) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    settings = _settings(paths)

    with pytest.raises(ValueError, match="UTC offset"):
        await preview_prune(settings, NOW.replace(tzinfo=None))

    runtime_lock = RuntimeLock(paths.runtime_lock)
    runtime_lock.acquire()
    try:
        with pytest.raises(RuntimeLockUnavailableError):
            await preview_prune(settings, NOW)
    finally:
        runtime_lock.release()
