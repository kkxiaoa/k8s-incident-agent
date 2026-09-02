import os
import shutil
import sqlite3
from collections.abc import Callable, Mapping
from contextlib import closing
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import CheckpointMetadata, empty_checkpoint
from sqlalchemy import Connection

import k8s_incident_agent.runtime.deletion as deletion_module
import k8s_incident_agent.runtime.reset as reset_module
from k8s_incident_agent.config import Settings
from k8s_incident_agent.runtime.lock import (
    RuntimeLock,
    RuntimeLockUnavailableError,
)
from k8s_incident_agent.runtime.paths import FilesystemIdentity, RuntimePaths
from k8s_incident_agent.runtime.reset import (
    ResetOutcome,
    ResetPlan,
    ResetState,
    StageOneResetError,
    confirm_stage_one_data,
    preview_stage_one_data,
    reset_plan_digest,
)
from k8s_incident_agent.runtime.sqlite_identity import OpenDatabaseDescriptor
from k8s_incident_agent.workflow.checkpoint import open_checkpoint_store

SERVICE_ROOT = Path(__file__).resolve().parents[3]
INCIDENT_ID = UUID("00000000-0000-4000-8000-000000000001")
RUN_ID = UUID("00000000-0000-4000-8000-000000000002")
OTHER_RUN_ID = UUID("00000000-0000-4000-8000-000000000003")
_UNMATCHED_PLAN_DIGEST = f"sha256:{'0' * 64}"


def _alembic_config(paths: RuntimePaths) -> Config:
    config = Config(str(SERVICE_ROOT / "alembic.ini"))
    config.attributes["runtime_paths"] = paths
    return config


def _settings(paths: RuntimePaths) -> Settings:
    settings = Settings.model_validate({"RUNTIME_DATA_DIR": paths.root})
    assert settings.runtime_paths == paths
    return settings


def _plan_digest(paths: RuntimePaths) -> str:
    return reset_plan_digest(preview_stage_one_data(_settings(paths)))


def _confirm_current_plan(paths: RuntimePaths) -> reset_module.ResetResult:
    settings = _settings(paths)
    return confirm_stage_one_data(settings, _plan_digest(paths))


@pytest.fixture(autouse=True)
def isolate_runtime_environment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    fallback_root = tmp_path / "environment-fallback-runtime"
    monkeypatch.setenv("RUNTIME_DATA_DIR", str(fallback_root))


def _seed_old_database(paths: RuntimePaths, run_id: UUID = RUN_ID) -> None:
    command.upgrade(_alembic_config(paths), "20260814_0001")
    timestamp = "2026-09-01 08:00:00.000000"
    with closing(sqlite3.connect(paths.business_database)) as connection, connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute(
            "INSERT INTO incidents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                str(INCIDENT_ID),
                "image-pull-backoff",
                1,
                "Image pull failure",
                "The target Deployment is unavailable.",
                "k8s-incident-agent",
                "k8s-incident-scenarios",
                "apps/v1",
                "Deployment",
                "image-pull-backoff",
                "FAILED",
                timestamp,
                timestamp,
            ),
        )
        connection.execute(
            "INSERT INTO agent_runs VALUES "
            "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                str(run_id),
                str(INCIDENT_ID),
                "FAILED",
                "deepseek",
                "deepseek-v4-flash",
                0,
                "stage1-v1",
                8,
                6,
                180,
                1,
                1,
                10,
                2,
                "resource_not_found",
                0,
                timestamp,
                timestamp,
                timestamp,
                timestamp,
            ),
        )
        connection.execute(
            "INSERT INTO run_events "
            "(incident_id, run_id, event_key, event_type, schema_version, "
            "occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                str(INCIDENT_ID),
                str(run_id),
                "run-created",
                "incident.created",
                1,
                timestamp,
                "{}",
            ),
        )
        connection.execute(
            "INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "00000000-0000-4000-8000-000000000004",
                str(run_id),
                "call-1",
                "get_pods",
                "kubernetes.pods",
                "{}",
                timestamp,
                "{}",
                0,
                0,
            ),
        )
        connection.execute(
            "INSERT INTO diagnoses VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "00000000-0000-4000-8000-000000000005",
                str(run_id),
                "insufficient_evidence",
                "No diagnosis.",
                "[]",
                "[]",
                0,
                timestamp,
            ),
        )


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


def _seed_artifact(paths: RuntimePaths, run_id: UUID) -> Path:
    paths.run_artifacts.mkdir(mode=0o700, exist_ok=True)
    run_directory = paths.run_artifacts / str(run_id)
    run_directory.mkdir(mode=0o700)
    nested = run_directory / "nested"
    nested.mkdir(mode=0o700)
    artifact = nested / "trace.json"
    artifact.write_text("{}", encoding="utf-8")
    artifact.chmod(0o600)
    return artifact


def _persist_wal_update(paths: RuntimePaths, statements: tuple[str, ...]) -> None:
    sidecars = (
        Path(f"{paths.business_database}-wal"),
        Path(f"{paths.business_database}-shm"),
    )
    with closing(sqlite3.connect(paths.business_database)) as connection:
        assert connection.execute("PRAGMA journal_mode = WAL").fetchone() == ("wal",)
        connection.execute("PRAGMA wal_autocheckpoint = 0")
        for statement in statements:
            connection.execute(statement)
        connection.commit()
        main_bytes = paths.business_database.read_bytes()
        sidecar_bytes = {sidecar: sidecar.read_bytes() for sidecar in sidecars}

    paths.business_database.write_bytes(main_bytes)
    paths.business_database.chmod(0o600)
    for sidecar, content in sidecar_bytes.items():
        sidecar.write_bytes(content)
        sidecar.chmod(0o600)


def _file_state(path: Path) -> tuple[int, int, int, int, bytes]:
    value = path.stat()
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_mtime_ns,
        path.read_bytes(),
    )


def _file_identity(path: Path) -> tuple[int, int, int]:
    value = path.stat()
    return value.st_dev, value.st_ino, value.st_mode


def _head_and_counts(paths: RuntimePaths) -> tuple[str, dict[str, int]]:
    with closing(sqlite3.connect(paths.business_database)) as connection:
        head = str(
            connection.execute("SELECT version_num FROM alembic_version").fetchone()[0]
        )
        tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_schema WHERE type = 'table'"
            )
        }
        counts = {
            table_name: int(
                connection.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0]
            )
            for table_name in (
                "incidents",
                "agent_runs",
                "run_events",
                "evidence",
                "diagnoses",
                "alert_signals",
            )
            if table_name in tables
        }
    return head, counts


def test_reset_plan_digest_covers_every_authorized_plan_field() -> None:
    plan = ResetPlan(
        state=ResetState.STAGE_ONE,
        source_head="20260814_0001",
        target_head="20260902_0003",
        business_files=("incidents.sqlite3",),
        checkpoint_files=("checkpoints.sqlite3",),
        run_ids=(RUN_ID,),
        artifact_run_ids=(RUN_ID,),
        row_counts=(("incidents", 1),),
    )
    variants = (
        replace(plan, state=ResetState.DELETION_COMPLETE),
        replace(plan, source_head=None),
        replace(plan, target_head="replacement-head"),
        replace(plan, business_files=()),
        replace(plan, checkpoint_files=()),
        replace(plan, run_ids=(OTHER_RUN_ID,)),
        replace(plan, artifact_run_ids=(OTHER_RUN_ID,)),
        replace(plan, row_counts=(("incidents", 2),)),
    )

    digest = reset_plan_digest(plan)

    assert digest.startswith("sha256:")
    assert len(digest) == len("sha256:") + 64
    assert digest == reset_plan_digest(plan)
    assert all(reset_plan_digest(variant) != digest for variant in variants)


@pytest.mark.asyncio
async def test_confirm_rejects_a_changed_plan_before_any_deletion(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    _seed_old_database(paths)
    await _seed_checkpoint(paths, RUN_ID)
    artifact = _seed_artifact(paths, RUN_ID)
    approved_digest = _plan_digest(paths)
    with closing(sqlite3.connect(paths.business_database)) as connection, connection:
        connection.execute("DELETE FROM evidence")
    preserved = {
        path: _file_state(path)
        for path in (paths.business_database, paths.checkpoint_database, artifact)
    }

    with pytest.raises(StageOneResetError) as error:
        confirm_stage_one_data(_settings(paths), approved_digest)

    assert error.value.code == "reset_plan_changed"
    assert error.value.phase == "preflight"
    assert {path: _file_state(path) for path in preserved} == preserved
    assert _head_and_counts(paths)[1]["evidence"] == 0
    assert _plan_digest(paths) != approved_digest


@pytest.mark.asyncio
async def test_preview_then_confirm_resets_only_old_stage_one_data(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    _seed_old_database(paths)
    await _seed_checkpoint(paths, RUN_ID)
    artifact = _seed_artifact(paths, RUN_ID)
    paths.diagnostic_kubeconfig.write_text("preserved credential", encoding="utf-8")
    paths.diagnostic_kubeconfig.chmod(0o600)
    unknown = paths.root / "operator-note.txt"
    unknown.write_text("preserved note", encoding="utf-8")
    unknown.chmod(0o600)
    business_targets = (
        paths.business_database.with_name("incidents.sqlite3-wal"),
        paths.business_database.with_name("incidents.sqlite3-shm"),
        paths.business_database,
    )
    checkpoint_targets = (
        paths.checkpoint_database.with_name("checkpoints.sqlite3-wal"),
        paths.checkpoint_database.with_name("checkpoints.sqlite3-shm"),
        paths.checkpoint_database,
    )
    database_identities_before = {
        paths.business_database: _file_identity(paths.business_database),
        paths.checkpoint_database: _file_identity(paths.checkpoint_database),
    }
    preserved_before = {
        path: _file_state(path)
        for path in (
            artifact,
            paths.diagnostic_kubeconfig,
            unknown,
            paths.runtime_lock,
        )
    }

    preview = preview_stage_one_data(_settings(paths))
    inspected_business_targets = tuple(
        path for path in business_targets if path.exists()
    )
    inspected_checkpoint_targets = tuple(
        path for path in checkpoint_targets if path.exists()
    )

    assert preview.state is ResetState.STAGE_ONE
    assert preview.source_head == "20260814_0001"
    assert preview.target_head == "20260902_0003"
    assert preview.business_files == tuple(
        path.name for path in inspected_business_targets
    )
    assert preview.checkpoint_files == tuple(
        path.name for path in inspected_checkpoint_targets
    )
    assert preview.run_ids == (RUN_ID,)
    assert preview.artifact_run_ids == (RUN_ID,)
    assert dict(preview.row_counts) == {
        "incidents": 1,
        "agent_runs": 1,
        "run_events": 1,
        "evidence": 1,
        "diagnoses": 1,
    }
    assert {
        path: _file_identity(path) for path in database_identities_before
    } == database_identities_before
    assert {path: _file_state(path) for path in preserved_before} == preserved_before
    assert preview_stage_one_data(_settings(paths)) == preview

    old_database_inode = paths.business_database.stat().st_ino
    started_at = datetime.now(UTC)
    result = _confirm_current_plan(paths)
    observed_at = datetime.now(UTC)

    assert result.plan == preview
    assert result.outcome is ResetOutcome.RESET
    assert result.new_head == "20260902_0003"
    assert started_at <= result.completed_at <= observed_at
    assert result.deleted_business_files == preview.business_files
    assert result.deleted_checkpoint_files == preview.checkpoint_files
    assert result.deleted_artifact_run_ids == (RUN_ID,)
    assert paths.business_database.stat().st_ino != old_database_inode
    assert _head_and_counts(paths) == (
        "20260902_0003",
        {
            "incidents": 0,
            "agent_runs": 0,
            "run_events": 0,
            "evidence": 0,
            "diagnoses": 0,
            "alert_signals": 0,
        },
    )
    assert not paths.checkpoint_database.exists()
    assert list(paths.run_artifacts.iterdir()) == []
    assert (
        _file_state(paths.diagnostic_kubeconfig)
        == preserved_before[paths.diagnostic_kubeconfig]
    )
    assert _file_state(unknown) == preserved_before[unknown]
    assert _file_state(paths.runtime_lock) == preserved_before[paths.runtime_lock]

    repeated = _confirm_current_plan(paths)
    assert repeated.outcome is ResetOutcome.ALREADY_COMPLETE
    assert repeated.deleted_business_files == ()
    assert repeated.deleted_checkpoint_files == ()
    assert repeated.deleted_artifact_run_ids == ()


def test_reset_rejects_a_held_runtime_lock_without_creating_database(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    runtime_lock = RuntimeLock(paths.runtime_lock)
    runtime_lock.acquire()
    try:
        with pytest.raises(StageOneResetError) as error:
            preview_stage_one_data(_settings(paths))
    finally:
        runtime_lock.release()

    assert error.value.code == "runtime_in_use"
    assert error.value.phase == "preflight"
    assert not paths.business_database.exists()


def test_reset_rejects_incomplete_private_staging_before_deletion(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    _seed_old_database(paths)
    artifact = _seed_artifact(paths, RUN_ID)
    database_before = _file_state(paths.business_database)
    staging = paths.root / ".runtime-reset-stage-interrupted"
    staging.mkdir(mode=0o700)
    partial = staging / "incidents.sqlite3"
    partial.write_bytes(b"partial private migration")
    partial.chmod(0o600)

    with pytest.raises(StageOneResetError) as error:
        confirm_stage_one_data(_settings(paths), _UNMATCHED_PLAN_DIGEST)

    assert error.value.code == "reset_rejected"
    assert error.value.phase == "preflight"
    assert _file_state(paths.business_database) == database_before
    assert artifact.exists()
    assert partial.read_bytes() == b"partial private migration"


def test_reset_rejects_orphan_artifact_before_any_deletion(tmp_path: Path) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    _seed_old_database(paths)
    orphan = _seed_artifact(paths, OTHER_RUN_ID)
    database_before = _file_state(paths.business_database)

    with pytest.raises(StageOneResetError) as error:
        confirm_stage_one_data(_settings(paths), _UNMATCHED_PLAN_DIGEST)

    assert error.value.code == "reset_rejected"
    assert error.value.phase == "preflight"
    assert _file_state(paths.business_database) == database_before
    assert orphan.exists()


@pytest.mark.asyncio
async def test_reset_rejects_checkpoint_for_unknown_run_before_deletion(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    _seed_old_database(paths)
    await _seed_checkpoint(paths, OTHER_RUN_ID)
    database_before = _file_state(paths.business_database)
    checkpoint_before = _file_state(paths.checkpoint_database)

    with pytest.raises(StageOneResetError) as error:
        confirm_stage_one_data(_settings(paths), _UNMATCHED_PLAN_DIGEST)

    assert error.value.code == "reset_rejected"
    assert _file_state(paths.business_database) == database_before
    assert _file_state(paths.checkpoint_database) == checkpoint_before


@pytest.mark.parametrize("with_empty_database", [False, True])
def test_reset_resumes_allowed_empty_cutover_states(
    tmp_path: Path,
    with_empty_database: bool,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    if with_empty_database:
        paths.business_database.touch(mode=0o600)

    preview = preview_stage_one_data(_settings(paths))
    result = _confirm_current_plan(paths)

    assert preview.state is (
        ResetState.EMPTY_DATABASE
        if with_empty_database
        else ResetState.DELETION_COMPLETE
    )
    assert result.outcome is ResetOutcome.MIGRATED
    assert _head_and_counts(paths)[0] == "20260902_0003"


def test_new_nonempty_database_is_not_a_reset_target(tmp_path: Path) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    with closing(sqlite3.connect(paths.business_database)) as connection, connection:
        connection.execute(
            "INSERT INTO incidents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                str(INCIDENT_ID),
                "scenario",
                "image-pull-backoff",
                "1",
                "Image pull failure",
                "Unavailable.",
                "k8s-incident-agent",
                "k8s-incident-scenarios",
                "apps/v1",
                "Deployment",
                "image-pull-backoff",
                "FAILED",
                "2026-09-01 08:00:00.000000",
                "2026-09-01 08:00:00.000000",
            ),
        )
    database_before = _file_state(paths.business_database)

    with pytest.raises(StageOneResetError) as error:
        confirm_stage_one_data(_settings(paths), _UNMATCHED_PLAN_DIGEST)

    assert error.value.code == "reset_rejected"
    assert _file_state(paths.business_database) == database_before


@pytest.mark.asyncio
async def test_artifact_failure_preserves_old_identity_and_can_retry(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    _seed_old_database(paths)
    await _seed_checkpoint(paths, RUN_ID)
    artifact = _seed_artifact(paths, RUN_ID)
    real_rmtree = deletion_module.shutil.rmtree

    def fail_rmtree(
        path: str,
        *,
        dir_fd: int | None = None,
    ) -> None:
        assert dir_fd is not None
        try:
            os.stat("target/nested/trace.json", dir_fd=dir_fd)
        except FileNotFoundError:
            real_rmtree(path, dir_fd=dir_fd)
        else:
            raise OSError("injected artifact failure")

    monkeypatch.setattr(deletion_module.shutil, "rmtree", fail_rmtree)
    with pytest.raises(StageOneResetError) as error:
        _confirm_current_plan(paths)

    assert error.value.phase == "artifact_delete"
    assert paths.business_database.exists()
    assert paths.checkpoint_database.exists()
    assert artifact.exists()

    monkeypatch.setattr(deletion_module.shutil, "rmtree", real_rmtree)
    assert _confirm_current_plan(paths).outcome is ResetOutcome.RESET


def test_migration_failure_leaves_deletion_complete_for_retry(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    real_upgrade = reset_module.command.upgrade

    def fail_upgrade(_config: Config, _revision: str) -> None:
        raise RuntimeError("injected migration failure")

    monkeypatch.setattr(reset_module.command, "upgrade", fail_upgrade)
    with pytest.raises(StageOneResetError) as error:
        _confirm_current_plan(paths)

    assert error.value.code == "migration_failed"
    assert error.value.phase == "migration"
    assert not paths.business_database.exists()
    assert (
        preview_stage_one_data(_settings(paths)).state is ResetState.DELETION_COMPLETE
    )
    assert not any(
        path.name.startswith(".runtime-reset-stage-") for path in paths.root.iterdir()
    )

    monkeypatch.setattr(reset_module.command, "upgrade", real_upgrade)
    assert _confirm_current_plan(paths).outcome is ResetOutcome.MIGRATED


@pytest.mark.asyncio
async def test_checkpoint_delete_failure_preserves_old_database_and_can_retry(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    _seed_old_database(paths)
    await _seed_checkpoint(paths, RUN_ID)
    old_database_identity = _file_identity(paths.business_database)
    real_unlink = reset_module.unlink_identity_bound_file

    def fail_checkpoint_main(
        parent_fd: int,
        name: str,
        expected_identity: reset_module.FilesystemIdentity,
    ) -> None:
        if name == "checkpoints.sqlite3":
            raise OSError("injected checkpoint failure")
        real_unlink(parent_fd, name, expected_identity)

    monkeypatch.setattr(
        reset_module,
        "unlink_identity_bound_file",
        fail_checkpoint_main,
    )
    with pytest.raises(StageOneResetError) as error:
        _confirm_current_plan(paths)

    assert error.value.phase == "checkpoint_delete"
    assert _file_identity(paths.business_database) == old_database_identity
    assert paths.checkpoint_database.exists()

    monkeypatch.setattr(reset_module, "unlink_identity_bound_file", real_unlink)
    assert _confirm_current_plan(paths).outcome is ResetOutcome.RESET


def test_business_main_delete_failure_retains_identity_and_can_retry(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    _seed_old_database(paths)
    old_database_identity = _file_identity(paths.business_database)
    real_unlink = reset_module.unlink_identity_bound_file

    def fail_business_main(
        parent_fd: int,
        name: str,
        expected_identity: reset_module.FilesystemIdentity,
    ) -> None:
        if name == "incidents.sqlite3":
            raise OSError("injected business database failure")
        real_unlink(parent_fd, name, expected_identity)

    monkeypatch.setattr(
        reset_module,
        "unlink_identity_bound_file",
        fail_business_main,
    )
    with pytest.raises(StageOneResetError) as error:
        _confirm_current_plan(paths)

    assert error.value.phase == "business_delete"
    assert _file_identity(paths.business_database) == old_database_identity
    assert preview_stage_one_data(_settings(paths)).state is ResetState.STAGE_ONE

    monkeypatch.setattr(reset_module, "unlink_identity_bound_file", real_unlink)
    assert _confirm_current_plan(paths).outcome is ResetOutcome.RESET


@pytest.mark.asyncio
async def test_external_state_reappearing_after_checkpoint_delete_preserves_old_database(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    _seed_old_database(paths)
    await _seed_checkpoint(paths, RUN_ID)
    old_database_identity = _file_identity(paths.business_database)
    real_unlink = reset_module.unlink_identity_bound_file

    def unlink_then_reintroduce_artifact(
        parent_fd: int,
        name: str,
        expected_identity: reset_module.FilesystemIdentity,
    ) -> None:
        real_unlink(parent_fd, name, expected_identity)
        if name == "checkpoints.sqlite3":
            _seed_artifact(paths, OTHER_RUN_ID)

    monkeypatch.setattr(
        reset_module,
        "unlink_identity_bound_file",
        unlink_then_reintroduce_artifact,
    )

    with pytest.raises(StageOneResetError) as error:
        _confirm_current_plan(paths)

    assert error.value.phase == "business_delete"
    assert _file_identity(paths.business_database) == old_database_identity
    assert paths.run_artifact_directory(OTHER_RUN_ID).exists()


def test_partial_private_migration_state_is_discarded_before_retry(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    real_upgrade = reset_module.command.upgrade

    def fail_after_partial_ddl(config: Config, revision: str) -> None:
        assert revision == "20260902_0003"
        connection = config.attributes["reset_connection"]
        assert isinstance(connection, Connection)
        connection.exec_driver_sql("CREATE TABLE unexpected (id INTEGER PRIMARY KEY)")
        raise RuntimeError("injected partial migration failure")

    monkeypatch.setattr(reset_module.command, "upgrade", fail_after_partial_ddl)
    with pytest.raises(StageOneResetError) as error:
        _confirm_current_plan(paths)

    assert error.value.code == "migration_failed"
    assert not paths.business_database.exists()
    assert (
        preview_stage_one_data(_settings(paths)).state is ResetState.DELETION_COMPLETE
    )
    assert not any(
        path.name.startswith(".runtime-reset-stage-") for path in paths.root.iterdir()
    )

    monkeypatch.setattr(reset_module.command, "upgrade", real_upgrade)
    assert _confirm_current_plan(paths).outcome is ResetOutcome.MIGRATED


@pytest.mark.asyncio
async def test_empty_new_head_with_old_checkpoint_is_rejected_without_deletion(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")
    await _seed_checkpoint(paths, RUN_ID)
    business_identity = _file_identity(paths.business_database)
    checkpoint_identity = _file_identity(paths.checkpoint_database)

    with pytest.raises(StageOneResetError) as error:
        confirm_stage_one_data(_settings(paths), _UNMATCHED_PLAN_DIGEST)

    assert error.value.code == "reset_rejected"
    assert _file_identity(paths.business_database) == business_identity
    assert _file_identity(paths.checkpoint_database) == checkpoint_identity


def test_missing_business_main_with_sidecar_is_rejected_without_deletion(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    sidecar = paths.business_database.with_name("incidents.sqlite3-wal")
    sidecar.touch(mode=0o600)
    sidecar_identity = _file_identity(sidecar)

    with pytest.raises(StageOneResetError) as error:
        confirm_stage_one_data(_settings(paths), _UNMATCHED_PLAN_DIGEST)

    assert error.value.code == "reset_rejected"
    assert _file_identity(sidecar) == sidecar_identity
    assert not paths.business_database.exists()


def test_partial_unknown_database_is_rejected_without_deletion(tmp_path: Path) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    with closing(sqlite3.connect(paths.business_database)) as connection, connection:
        connection.execute("CREATE TABLE incidents (id TEXT PRIMARY KEY)")
    paths.business_database.chmod(0o600)
    database_identity = _file_identity(paths.business_database)

    with pytest.raises(StageOneResetError) as error:
        confirm_stage_one_data(_settings(paths), _UNMATCHED_PLAN_DIGEST)

    assert error.value.code == "reset_rejected"
    assert _file_identity(paths.business_database) == database_identity


def test_unsafe_nested_artifact_is_rejected_before_any_deletion(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    _seed_old_database(paths)
    artifact = _seed_artifact(paths, RUN_ID)
    external = tmp_path / "external-artifact"
    external.write_text("preserved", encoding="utf-8")
    unsafe_link = artifact.parent / "unsafe-link"
    unsafe_link.symlink_to(external)
    database_identity = _file_identity(paths.business_database)

    with pytest.raises(StageOneResetError) as error:
        confirm_stage_one_data(_settings(paths), _UNMATCHED_PLAN_DIGEST)

    assert error.value.code == "reset_rejected"
    assert _file_identity(paths.business_database) == database_identity
    assert unsafe_link.is_symlink()
    assert external.read_text(encoding="utf-8") == "preserved"


def test_business_replaced_before_artifact_delete_preserves_artifact(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    replacement_paths = RuntimePaths.prepare(tmp_path / "replacement-runtime")
    _seed_old_database(paths)
    _seed_old_database(replacement_paths, OTHER_RUN_ID)
    artifact = _seed_artifact(paths, RUN_ID)
    approved_digest = _plan_digest(paths)
    moved_database = paths.root / "expected-incidents.sqlite3"
    replacement_identity = _file_identity(replacement_paths.business_database)
    real_inspect = cast(
        Callable[[object, frozenset[UUID]], object],
        vars(reset_module)["_inspect_artifacts"],
    )
    inspect_calls = 0

    def replace_after_artifact_resnapshot(
        reset_context: object,
        allowed_run_ids: frozenset[UUID],
    ) -> object:
        nonlocal inspect_calls
        result = real_inspect(reset_context, allowed_run_ids)
        inspect_calls += 1
        if inspect_calls == 2:
            paths.business_database.rename(moved_database)
            replacement_paths.business_database.rename(paths.business_database)
        return result

    monkeypatch.setattr(
        reset_module,
        "_inspect_artifacts",
        replace_after_artifact_resnapshot,
    )

    with pytest.raises(StageOneResetError) as error:
        confirm_stage_one_data(_settings(paths), approved_digest)

    assert error.value.phase == "artifact_delete"
    assert artifact.exists()
    assert moved_database.exists()
    assert _file_identity(paths.business_database) == replacement_identity


def test_replaced_artifact_directory_is_not_deleted(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    _seed_old_database(paths)
    _seed_artifact(paths, RUN_ID)
    approved_digest = _plan_digest(paths)
    old_database_identity = _file_identity(paths.business_database)
    moved_directory = paths.root / "moved-run-artifacts"
    real_snapshot = reset_module.snapshot_safe_artifact_tree
    snapshot_calls = 0

    def replace_during_resnapshot(
        directory_fd: int,
    ) -> tuple[reset_module.ArtifactTreeEntry, ...]:
        nonlocal snapshot_calls
        run_directory = paths.run_artifact_directory(RUN_ID)
        if FilesystemIdentity.from_stat(os.fstat(directory_fd)) == (
            FilesystemIdentity.from_stat(run_directory.stat())
        ):
            snapshot_calls += 1
            if snapshot_calls == 2:
                run_directory.rename(moved_directory)
                replacement = paths.run_artifact_directory(RUN_ID)
                replacement.mkdir(mode=0o700)
                replacement_file = replacement / "replacement.txt"
                replacement_file.write_text("preserved", encoding="utf-8")
                replacement_file.chmod(0o600)
        return real_snapshot(directory_fd)

    monkeypatch.setattr(
        reset_module,
        "snapshot_safe_artifact_tree",
        replace_during_resnapshot,
    )
    with pytest.raises(StageOneResetError) as error:
        confirm_stage_one_data(_settings(paths), approved_digest)

    assert error.value.phase == "artifact_delete"
    assert _file_identity(paths.business_database) == old_database_identity
    claims = tuple(
        path
        for path in paths.run_artifacts.iterdir()
        if path.name.startswith(".runtime-delete-")
    )
    assert len(claims) == 1
    assert (claims[0] / "target" / "replacement.txt").exists()
    assert moved_directory.exists()


def test_artifact_delete_failure_does_not_overwrite_a_replacement(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    _seed_old_database(paths)
    _seed_artifact(paths, RUN_ID)
    old_database_identity = _file_identity(paths.business_database)
    real_rmtree = deletion_module.shutil.rmtree

    def fail_after_replacement(
        path: str,
        *,
        dir_fd: int | None = None,
    ) -> None:
        assert dir_fd is not None
        try:
            os.stat("target/nested/trace.json", dir_fd=dir_fd)
        except FileNotFoundError:
            real_rmtree(path, dir_fd=dir_fd)
            return
        replacement = paths.run_artifact_directory(RUN_ID)
        replacement.write_text("preserved", encoding="utf-8")
        replacement.chmod(0o600)
        raise OSError("injected artifact failure")

    monkeypatch.setattr(deletion_module.shutil, "rmtree", fail_after_replacement)

    with pytest.raises(StageOneResetError) as error:
        _confirm_current_plan(paths)

    assert error.value.phase == "artifact_delete"
    assert paths.run_artifact_directory(RUN_ID).read_text(encoding="utf-8") == (
        "preserved"
    )
    claims = tuple(
        path
        for path in paths.run_artifacts.iterdir()
        if path.name.startswith(".runtime-delete-")
    )
    assert len(claims) == 1
    assert (claims[0] / "target" / "nested" / "trace.json").exists()
    assert _file_identity(paths.business_database) == old_database_identity


def test_artifact_replaced_at_atomic_claim_is_not_deleted(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    _seed_old_database(paths)
    _seed_artifact(paths, RUN_ID)
    old_database_identity = _file_identity(paths.business_database)
    moved_directory = paths.root / "moved-run-artifacts"
    real_rename = deletion_module.os.rename
    replaced = False

    def replace_at_claim(
        source: str,
        destination: str,
        *,
        src_dir_fd: int | None = None,
        dst_dir_fd: int | None = None,
    ) -> None:
        nonlocal replaced
        if source == str(RUN_ID) and not replaced:
            replaced = True
            real_rename(paths.run_artifact_directory(RUN_ID), moved_directory)
            replacement = paths.run_artifact_directory(RUN_ID)
            replacement.mkdir(mode=0o700)
            replacement_file = replacement / "replacement.txt"
            replacement_file.write_text("preserved", encoding="utf-8")
            replacement_file.chmod(0o600)
        real_rename(
            source,
            destination,
            src_dir_fd=src_dir_fd,
            dst_dir_fd=dst_dir_fd,
        )

    monkeypatch.setattr(deletion_module.os, "rename", replace_at_claim)

    with pytest.raises(StageOneResetError) as error:
        _confirm_current_plan(paths)

    assert error.value.phase == "artifact_delete"
    assert _file_identity(paths.business_database) == old_database_identity
    claims = tuple(
        path
        for path in paths.run_artifacts.iterdir()
        if path.name.startswith(".runtime-delete-")
    )
    assert len(claims) == 1
    assert (claims[0] / "target" / "replacement.txt").exists()
    assert moved_directory.exists()


@pytest.mark.asyncio
async def test_checkpoint_replaced_at_atomic_claim_is_not_deleted(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    _seed_old_database(paths)
    await _seed_checkpoint(paths, RUN_ID)
    old_database_identity = _file_identity(paths.business_database)
    moved_checkpoint = paths.root / "moved-checkpoints.sqlite3"
    replacement_bytes = b"operator replacement"
    real_rename = deletion_module.os.rename
    replaced = False

    def replace_at_claim(
        source: str,
        destination: str,
        *,
        src_dir_fd: int | None = None,
        dst_dir_fd: int | None = None,
    ) -> None:
        nonlocal replaced
        if source == "checkpoints.sqlite3" and not replaced:
            replaced = True
            real_rename(
                source,
                moved_checkpoint.name,
                src_dir_fd=src_dir_fd,
                dst_dir_fd=src_dir_fd,
            )
            paths.checkpoint_database.write_bytes(replacement_bytes)
            paths.checkpoint_database.chmod(0o600)
        real_rename(
            source,
            destination,
            src_dir_fd=src_dir_fd,
            dst_dir_fd=dst_dir_fd,
        )

    monkeypatch.setattr(deletion_module.os, "rename", replace_at_claim)

    with pytest.raises(StageOneResetError) as error:
        _confirm_current_plan(paths)

    assert error.value.phase == "checkpoint_delete"
    assert _file_identity(paths.business_database) == old_database_identity
    claims = tuple(
        path
        for path in paths.root.iterdir()
        if path.name.startswith(".runtime-delete-")
    )
    assert len(claims) == 1
    assert (claims[0] / "target").read_bytes() == replacement_bytes
    assert not paths.checkpoint_database.exists()
    assert moved_checkpoint.exists()


def test_business_preflight_rejects_main_aba_before_snapshot_copy(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    replacement_paths = RuntimePaths.prepare(tmp_path / "replacement-runtime")
    _seed_old_database(paths)
    _seed_old_database(replacement_paths, OTHER_RUN_ID)
    expected_identity = _file_identity(paths.business_database)
    moved_expected = paths.root / "expected-incidents.sqlite3"
    opened_replacement = paths.root / "opened-replacement.sqlite3"
    real_open = reset_module.os.open
    source_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    replaced = False

    def open_replacement(
        name: str,
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        nonlocal replaced
        if name == "incidents.sqlite3" and flags == source_flags and not replaced:
            replaced = True
            paths.business_database.rename(moved_expected)
            replacement_paths.business_database.rename(paths.business_database)
            descriptor = real_open(name, flags, mode, dir_fd=dir_fd)
            paths.business_database.rename(opened_replacement)
            moved_expected.rename(paths.business_database)
            return descriptor
        return real_open(name, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(reset_module.os, "open", open_replacement)

    with pytest.raises(StageOneResetError) as error:
        preview_stage_one_data(_settings(paths))

    assert error.value.code == "reset_rejected"
    assert _file_identity(paths.business_database) == expected_identity
    assert opened_replacement.exists()


def test_business_preview_reads_wal_without_mutating_the_public_family(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    _seed_old_database(paths)
    _persist_wal_update(
        paths,
        (
            f"UPDATE diagnoses SET run_id = '{OTHER_RUN_ID}'",
            f"UPDATE evidence SET run_id = '{OTHER_RUN_ID}'",
            f"UPDATE run_events SET run_id = '{OTHER_RUN_ID}'",
            f"UPDATE agent_runs SET id = '{OTHER_RUN_ID}'",
        ),
    )
    family = (
        paths.business_database,
        Path(f"{paths.business_database}-wal"),
        Path(f"{paths.business_database}-shm"),
    )
    before = {path: _file_state(path) for path in family}

    preview = preview_stage_one_data(_settings(paths))

    assert preview.run_ids == (OTHER_RUN_ID,)
    assert {path: _file_state(path) for path in family} == before


def test_business_preflight_rejects_a_wal_aba_after_main_is_proven(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    replacement_paths = RuntimePaths.prepare(tmp_path / "replacement-runtime")
    _seed_old_database(paths)
    shutil.copy2(paths.business_database, replacement_paths.business_database)
    replacement_paths.business_database.chmod(0o600)
    _persist_wal_update(
        paths,
        ("UPDATE incidents SET display_name = 'expected WAL'",),
    )
    _persist_wal_update(
        replacement_paths,
        (
            f"UPDATE diagnoses SET run_id = '{OTHER_RUN_ID}'",
            f"UPDATE evidence SET run_id = '{OTHER_RUN_ID}'",
            f"UPDATE run_events SET run_id = '{OTHER_RUN_ID}'",
            f"UPDATE agent_runs SET id = '{OTHER_RUN_ID}'",
        ),
    )
    expected_wal_identity = _file_identity(Path(f"{paths.business_database}-wal"))
    moved_sidecars = (
        paths.root / "expected-incidents.sqlite3-wal",
        paths.root / "expected-incidents.sqlite3-shm",
    )
    source_sidecars = (
        Path(f"{replacement_paths.business_database}-wal"),
        Path(f"{replacement_paths.business_database}-shm"),
    )
    target_sidecars = (
        Path(f"{paths.business_database}-wal"),
        Path(f"{paths.business_database}-shm"),
    )
    real_identify = reset_module.identify_new_database_descriptor
    real_user_tables = cast(
        Callable[[sqlite3.Connection], frozenset[str]],
        vars(reset_module)["_user_tables"],
    )
    replaced = False
    injected = False

    def restore_expected_sidecars() -> None:
        nonlocal replaced
        if not replaced:
            return
        for target, moved in zip(target_sidecars, moved_sidecars, strict=True):
            if target.exists():
                target.unlink()
            if moved.exists():
                moved.rename(target)
        replaced = False

    def replace_after_main_proof(
        baseline: Mapping[int, FilesystemIdentity],
        expected: FilesystemIdentity,
    ) -> OpenDatabaseDescriptor:
        nonlocal injected, replaced
        opened = real_identify(baseline, expected)
        if not injected:
            injected = True
            for target, moved, source in zip(
                target_sidecars,
                moved_sidecars,
                source_sidecars,
                strict=True,
            ):
                target.rename(moved)
                shutil.copy2(source, target)
                target.chmod(0o600)
            replaced = True
        return opened

    def read_schema_then_restore(
        connection: sqlite3.Connection,
    ) -> frozenset[str]:
        result = real_user_tables(connection)
        restore_expected_sidecars()
        return result

    monkeypatch.setattr(
        reset_module,
        "identify_new_database_descriptor",
        replace_after_main_proof,
    )
    monkeypatch.setattr(reset_module, "_user_tables", read_schema_then_restore)

    try:
        with pytest.raises(StageOneResetError) as error:
            preview_stage_one_data(_settings(paths))
    finally:
        restore_expected_sidecars()

    assert error.value.code == "reset_rejected"
    assert injected
    assert _file_identity(Path(f"{paths.business_database}-wal")) == (
        expected_wal_identity
    )


def test_database_replaced_after_migration_is_not_reported_complete(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    replacement_paths = RuntimePaths.prepare(tmp_path / "replacement-runtime")
    command.upgrade(_alembic_config(replacement_paths), "head")
    moved_database = paths.root / "migrated-incidents.sqlite3"
    real_preflight = cast(
        Callable[[object], object],
        vars(reset_module)["_preflight"],
    )
    replaced = False

    def replace_before_final_preflight(
        reset_context: object,
    ) -> object:
        nonlocal replaced
        if not replaced and paths.business_database.exists():
            try:
                head, _counts = _head_and_counts(paths)
            except sqlite3.DatabaseError:
                pass
            else:
                if head == "20260902_0003":
                    replaced = True
                    paths.business_database.rename(moved_database)
                    replacement_paths.business_database.rename(paths.business_database)
        return real_preflight(reset_context)

    monkeypatch.setattr(reset_module, "_preflight", replace_before_final_preflight)

    with pytest.raises(StageOneResetError) as error:
        _confirm_current_plan(paths)

    assert error.value.code == "migration_failed"
    assert moved_database.exists()
    assert paths.business_database.exists()


def test_migration_keeps_the_original_lock_continuously_held(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    real_upgrade = reset_module.command.upgrade

    def assert_lock_then_upgrade(config: Config, revision: str) -> None:
        caller_lock = config.attributes["caller_runtime_lock"]
        assert isinstance(caller_lock, RuntimeLock)
        caller_lock.require_held(paths.runtime_lock)
        contender = RuntimeLock(paths.runtime_lock)
        with pytest.raises(RuntimeLockUnavailableError):
            contender.acquire()
        real_upgrade(config, revision)

    monkeypatch.setattr(reset_module.command, "upgrade", assert_lock_then_upgrade)

    assert _confirm_current_plan(paths).outcome is ResetOutcome.MIGRATED


def test_runtime_root_path_replacement_blocks_migration(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    moved_root = tmp_path / "moved-runtime"
    real_upgrade = reset_module.command.upgrade

    def replace_root_then_upgrade(config: Config, revision: str) -> None:
        paths.root.rename(moved_root)
        paths.root.mkdir(mode=0o700)
        marker = paths.root / "replacement-marker"
        marker.write_text("preserved", encoding="utf-8")
        marker.chmod(0o600)
        real_upgrade(config, revision)

    monkeypatch.setattr(reset_module.command, "upgrade", replace_root_then_upgrade)
    with pytest.raises(StageOneResetError) as error:
        _confirm_current_plan(paths)

    assert error.value.code == "migration_failed"
    assert (paths.root / "replacement-marker").read_text(encoding="utf-8") == (
        "preserved"
    )
    assert not (moved_root / "incidents.sqlite3").exists()
    assert not any(
        path.name.startswith(".runtime-reset-stage-") for path in moved_root.iterdir()
    )


def test_public_database_created_during_private_migration_is_not_modified(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    real_upgrade = reset_module.command.upgrade
    replacement_state: tuple[int, int, int, int, bytes] | None = None

    def create_replacement_after_private_upgrade(
        config: Config,
        revision: str,
    ) -> None:
        nonlocal replacement_state
        assert not paths.business_database.exists()
        connection = config.attributes["reset_connection"]
        assert isinstance(connection, Connection)
        real_upgrade(config, revision)
        with closing(sqlite3.connect(paths.business_database)) as replacement:
            replacement.execute("CREATE TABLE operator_data (value TEXT NOT NULL)")
            replacement.execute("INSERT INTO operator_data VALUES ('preserved')")
            replacement.commit()
        paths.business_database.chmod(0o600)
        replacement_state = _file_state(paths.business_database)

    monkeypatch.setattr(
        reset_module.command,
        "upgrade",
        create_replacement_after_private_upgrade,
    )
    with pytest.raises(StageOneResetError) as error:
        _confirm_current_plan(paths)

    assert error.value.code == "migration_failed"
    assert replacement_state is not None
    assert _file_state(paths.business_database) == replacement_state
    with closing(sqlite3.connect(paths.business_database)) as replacement:
        assert replacement.execute("SELECT value FROM operator_data").fetchone() == (
            "preserved",
        )
    assert not Path(f"{paths.business_database}-wal").exists()
    assert not Path(f"{paths.business_database}-shm").exists()
    assert not any(
        path.name.startswith(".runtime-reset-stage-") for path in paths.root.iterdir()
    )
