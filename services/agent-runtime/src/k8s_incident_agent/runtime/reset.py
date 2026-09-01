from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import stat
from collections.abc import Callable, Generator, Iterable
from contextlib import closing, contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid4

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine

from k8s_incident_agent.config import Settings
from k8s_incident_agent.runtime.artifacts import (
    ArtifactTreeEntry,
    open_private_directory,
    snapshot_safe_artifact_tree,
)
from k8s_incident_agent.runtime.cutover import (
    RESET_STAGING_DIRECTORY_PREFIX,
    require_runtime_cutover_complete,
)
from k8s_incident_agent.runtime.deletion import (
    rename_noreplace,
    rmtree_identity_bound_directory,
    unlink_identity_bound_file,
)
from k8s_incident_agent.runtime.lock import (
    RuntimeLock,
    RuntimeLockUnavailableError,
)
from k8s_incident_agent.runtime.paths import (
    PRIVATE_DIRECTORY_MODE,
    PRIVATE_FILE_MODE,
    FilesystemIdentity,
    RuntimePaths,
    require_filesystem_identity,
)
from k8s_incident_agent.runtime.sqlite_identity import (
    capture_open_file_descriptors,
    identify_new_database_descriptor,
)

_SERVICE_ROOT = Path(__file__).resolve().parents[3]
_SOURCE_HEAD = "20260814_0001"
_TARGET_HEAD = "20260901_0002"
_BUSINESS_TABLES = (
    "incidents",
    "agent_runs",
    "run_events",
    "evidence",
    "diagnoses",
)
_EXPECTED_BUSINESS_TABLES = frozenset((*_BUSINESS_TABLES, "alembic_version"))
_EXPECTED_CHECKPOINT_TABLES = frozenset(("checkpoints", "writes"))
_BUSINESS_DELETE_ORDER = (
    "incidents.sqlite3-wal",
    "incidents.sqlite3-shm",
    "incidents.sqlite3",
)
_CHECKPOINT_DELETE_ORDER = (
    "checkpoints.sqlite3-wal",
    "checkpoints.sqlite3-shm",
    "checkpoints.sqlite3",
)
_DATABASE_OPEN_FLAGS = os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW
_SNAPSHOT_SOURCE_FLAGS = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
_COPY_BUFFER_SIZE = 1024 * 1024

type _ResetPhase = Literal[
    "preflight",
    "artifact_delete",
    "checkpoint_delete",
    "business_delete",
    "migration",
]


class ResetState(StrEnum):
    STAGE_ONE = "stage_one"
    DELETION_COMPLETE = "deletion_complete"
    EMPTY_DATABASE = "empty_database"
    ALREADY_COMPLETE = "already_complete"


class ResetOutcome(StrEnum):
    RESET = "reset"
    MIGRATED = "migrated"
    ALREADY_COMPLETE = "already_complete"


class StageOneResetError(RuntimeError):
    def __init__(self, code: str, phase: _ResetPhase) -> None:
        super().__init__("Stage 1 data reset failed safely")
        self.code = code
        self.phase = phase


@dataclass(frozen=True, slots=True)
class ResetPlan:
    state: ResetState
    source_head: str | None
    target_head: str
    business_files: tuple[str, ...]
    checkpoint_files: tuple[str, ...]
    run_ids: tuple[UUID, ...]
    artifact_run_ids: tuple[UUID, ...]
    row_counts: tuple[tuple[str, int], ...]


def reset_plan_digest(plan: ResetPlan) -> str:
    canonical_payload = json.dumps(
        {
            "artifactRunIds": [str(run_id) for run_id in plan.artifact_run_ids],
            "businessFiles": list(plan.business_files),
            "checkpointFiles": list(plan.checkpoint_files),
            "rowCounts": [list(row_count) for row_count in plan.row_counts],
            "runIds": [str(run_id) for run_id in plan.run_ids],
            "sourceHead": plan.source_head,
            "state": plan.state.value,
            "targetHead": plan.target_head,
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return f"sha256:{hashlib.sha256(canonical_payload).hexdigest()}"


@dataclass(frozen=True, slots=True)
class ResetResult:
    plan: ResetPlan
    outcome: ResetOutcome
    completed_at: datetime
    new_head: str
    deleted_business_files: tuple[str, ...]
    deleted_checkpoint_files: tuple[str, ...]
    deleted_artifact_run_ids: tuple[UUID, ...]


@dataclass(frozen=True, slots=True)
class _FileSnapshot:
    name: str
    identity: FilesystemIdentity
    size: int | None
    modified_at_ns: int | None
    changed_at_ns: int | None


@dataclass(frozen=True, slots=True)
class _DirectoryMutationState:
    modified_at_ns: int
    changed_at_ns: int


@dataclass(frozen=True, slots=True)
class _StagingDirectory:
    name: str
    descriptor: int
    identity: FilesystemIdentity


class _BusinessState(StrEnum):
    MISSING = "missing"
    EMPTY = "empty"
    STAGE_ONE = "stage_one"
    STAGE_ONE_SIX = "stage_one_six"


@dataclass(frozen=True, slots=True)
class _BusinessInspection:
    state: _BusinessState
    head: str | None
    files: tuple[_FileSnapshot, ...]
    run_ids: tuple[UUID, ...]
    row_counts: tuple[tuple[str, int], ...]


@dataclass(frozen=True, slots=True)
class _CheckpointInspection:
    files: tuple[_FileSnapshot, ...]
    thread_ids: tuple[UUID, ...]


@dataclass(frozen=True, slots=True)
class _ArtifactSnapshot:
    run_id: UUID
    directory_identity: FilesystemIdentity
    tree: tuple[ArtifactTreeEntry, ...]


@dataclass(frozen=True, slots=True)
class _ArtifactInspection:
    root_identity: FilesystemIdentity | None
    runs: tuple[_ArtifactSnapshot, ...]


@dataclass(frozen=True, slots=True)
class _Preflight:
    plan: ResetPlan
    business: _BusinessInspection
    checkpoint: _CheckpointInspection
    artifacts: _ArtifactInspection


@dataclass(slots=True)
class _ResetContext:
    paths: RuntimePaths
    lock: RuntimeLock
    root_fd: int
    root_identity: FilesystemIdentity


def preview_stage_one_data(settings: Settings) -> ResetPlan:
    try:
        with _locked_context(settings) as reset_context:
            return _preflight(reset_context).plan
    except StageOneResetError:
        raise
    except RuntimeLockUnavailableError:
        raise StageOneResetError("runtime_in_use", "preflight") from None
    except Exception as error:
        raise StageOneResetError("reset_rejected", "preflight") from error


def confirm_stage_one_data(
    settings: Settings,
    expected_plan_digest: str,
) -> ResetResult:
    try:
        with _locked_context(settings) as reset_context:
            preflight = _preflight(reset_context)
            if reset_plan_digest(preflight.plan) != expected_plan_digest:
                raise StageOneResetError("reset_plan_changed", "preflight")
            return _confirm_locked(reset_context, preflight)
    except StageOneResetError:
        raise
    except RuntimeLockUnavailableError:
        raise StageOneResetError("runtime_in_use", "preflight") from None
    except Exception as error:
        raise StageOneResetError("reset_rejected", "preflight") from error


@contextmanager
def _locked_context(settings: Settings) -> Generator[_ResetContext]:
    paths = settings.runtime_paths
    prepared = RuntimePaths.prepare(paths.root)
    if prepared != paths:
        raise ValueError("Runtime paths do not match the fixed layout")

    runtime_lock = RuntimeLock(paths.runtime_lock)
    runtime_lock.acquire()
    try:
        root_fd = open_private_directory(paths.root)
        try:
            reset_context = _ResetContext(
                paths=paths,
                lock=runtime_lock,
                root_fd=root_fd,
                root_identity=FilesystemIdentity.from_stat(os.fstat(root_fd)),
            )
            _require_context(reset_context)
            yield reset_context
        finally:
            os.close(root_fd)
    finally:
        runtime_lock.release()


def _require_context(reset_context: _ResetContext) -> None:
    reset_context.lock.require_held(reset_context.paths.runtime_lock)
    descriptor_stat = os.fstat(reset_context.root_fd)
    if not reset_context.root_identity.matches(descriptor_stat):
        raise RuntimeError("Runtime root descriptor identity changed")
    require_filesystem_identity(
        reset_context.paths.root,
        reset_context.root_identity,
    )


def _preflight(reset_context: _ResetContext) -> _Preflight:
    _require_context(reset_context)
    require_runtime_cutover_complete(reset_context.root_fd)
    business = _inspect_business_database(reset_context)
    allowed_run_ids: frozenset[UUID] = (
        frozenset(business.run_ids)
        if business.state is _BusinessState.STAGE_ONE
        else frozenset()
    )
    checkpoint = _inspect_checkpoint_database(reset_context, allowed_run_ids)
    artifacts = _inspect_artifacts(reset_context, allowed_run_ids)
    _require_business_files_unchanged(reset_context, business)

    has_external_state = bool(checkpoint.files or artifacts.runs)
    if business.state is _BusinessState.STAGE_ONE:
        state = ResetState.STAGE_ONE
        business_files = tuple(snapshot.name for snapshot in business.files)
        checkpoint_files = tuple(snapshot.name for snapshot in checkpoint.files)
        artifact_run_ids = tuple(snapshot.run_id for snapshot in artifacts.runs)
    elif business.state is _BusinessState.MISSING:
        if has_external_state:
            raise RuntimeError("Deleted business database has residual Run state")
        state = ResetState.DELETION_COMPLETE
        business_files = ()
        checkpoint_files = ()
        artifact_run_ids = ()
    elif business.state is _BusinessState.EMPTY:
        if has_external_state:
            raise RuntimeError("Empty business database has residual Run state")
        state = ResetState.EMPTY_DATABASE
        business_files = tuple(snapshot.name for snapshot in business.files)
        checkpoint_files = ()
        artifact_run_ids = ()
    else:
        if any(count != 0 for _, count in business.row_counts):
            raise RuntimeError("Stage 1.6 database is not empty")
        if has_external_state:
            raise RuntimeError("Stage 1.6 database has old external Run state")
        state = ResetState.ALREADY_COMPLETE
        business_files = ()
        checkpoint_files = ()
        artifact_run_ids = ()

    plan = ResetPlan(
        state=state,
        source_head=business.head,
        target_head=_TARGET_HEAD,
        business_files=business_files,
        checkpoint_files=checkpoint_files,
        run_ids=business.run_ids,
        artifact_run_ids=artifact_run_ids,
        row_counts=business.row_counts,
    )
    return _Preflight(
        plan=plan,
        business=business,
        checkpoint=checkpoint,
        artifacts=artifacts,
    )


def _inspect_business_database(
    reset_context: _ResetContext,
) -> _BusinessInspection:
    initial_files = _snapshot_files(reset_context, _BUSINESS_DELETE_ORDER)
    main = _snapshot_named(initial_files, "incidents.sqlite3")
    if main is None:
        if initial_files:
            raise RuntimeError("Business database sidecar exists without its database")
        return _BusinessInspection(
            state=_BusinessState.MISSING,
            head=None,
            files=(),
            run_ids=(),
            row_counts=(),
        )

    connection = _snapshot_database(
        reset_context,
        reset_context.paths.business_database,
        initial_files,
        _BUSINESS_DELETE_ORDER,
    )
    with closing(connection):
        user_tables = _user_tables(connection)
        head = _alembic_head(connection, user_tables)
        if head == _SOURCE_HEAD and user_tables == _EXPECTED_BUSINESS_TABLES:
            state = _BusinessState.STAGE_ONE
        elif head == _TARGET_HEAD and user_tables == _EXPECTED_BUSINESS_TABLES:
            state = _BusinessState.STAGE_ONE_SIX
        elif head is None and not user_tables:
            state = _BusinessState.EMPTY
        else:
            raise RuntimeError("Business database is not in an allowed reset state")

        if state in (_BusinessState.STAGE_ONE, _BusinessState.STAGE_ONE_SIX):
            row_counts = tuple(
                (table_name, _row_count(connection, table_name))
                for table_name in _BUSINESS_TABLES
            )
            run_ids = _canonical_uuids(
                row[0]
                for row in connection.execute("SELECT id FROM agent_runs ORDER BY id")
            )
        else:
            row_counts = ()
            run_ids = ()

    files = _snapshot_files(reset_context, _BUSINESS_DELETE_ORDER)
    if files != initial_files:
        raise RuntimeError("Business database changed during inspection")
    current_main = _snapshot_named(files, "incidents.sqlite3")
    if current_main is None or current_main.identity != main.identity:
        raise RuntimeError("Business database identity changed during inspection")
    return _BusinessInspection(
        state=state,
        head=head,
        files=files,
        run_ids=run_ids,
        row_counts=row_counts,
    )


def _inspect_checkpoint_database(
    reset_context: _ResetContext,
    allowed_run_ids: frozenset[UUID],
) -> _CheckpointInspection:
    initial_files = _snapshot_files(reset_context, _CHECKPOINT_DELETE_ORDER)
    main = _snapshot_named(initial_files, "checkpoints.sqlite3")
    if main is None:
        if initial_files:
            raise RuntimeError("Checkpoint sidecar exists without its database")
        return _CheckpointInspection(files=(), thread_ids=())

    connection = _snapshot_database(
        reset_context,
        reset_context.paths.checkpoint_database,
        initial_files,
        _CHECKPOINT_DELETE_ORDER,
    )
    with closing(connection):
        user_tables = _user_tables(connection)
        if not user_tables:
            thread_ids: tuple[UUID, ...] = ()
        elif user_tables == _EXPECTED_CHECKPOINT_TABLES:
            thread_ids = _canonical_uuids(
                row[0]
                for row in connection.execute(
                    "SELECT thread_id FROM checkpoints "
                    "UNION SELECT thread_id FROM writes ORDER BY thread_id"
                )
            )
        else:
            raise RuntimeError("Checkpoint database schema is not recognized")
    if not set(thread_ids).issubset(allowed_run_ids):
        raise RuntimeError("Checkpoint contains an unknown Run identity")
    files = _snapshot_files(reset_context, _CHECKPOINT_DELETE_ORDER)
    if files != initial_files:
        raise RuntimeError("Checkpoint database changed during inspection")
    current_main = _snapshot_named(files, "checkpoints.sqlite3")
    if current_main is None or current_main.identity != main.identity:
        raise RuntimeError("Checkpoint database identity changed during inspection")
    return _CheckpointInspection(files=files, thread_ids=thread_ids)


def _inspect_artifacts(
    reset_context: _ResetContext,
    allowed_run_ids: frozenset[UUID],
) -> _ArtifactInspection:
    _require_context(reset_context)
    try:
        artifact_root_fd = open_private_directory(
            "runs",
            dir_fd=reset_context.root_fd,
        )
    except FileNotFoundError:
        return _ArtifactInspection(root_identity=None, runs=())

    try:
        root_identity = FilesystemIdentity.from_stat(os.fstat(artifact_root_fd))
        snapshots: list[_ArtifactSnapshot] = []
        with os.scandir(artifact_root_fd) as entries:
            ordered_entries = sorted(entries, key=lambda entry: entry.name)
        for entry in ordered_entries:
            run_id = _canonical_uuid(entry.name)
            if run_id not in allowed_run_ids:
                raise RuntimeError("Run artifact has no old business identity")
            entry_stat = entry.stat(follow_symlinks=False)
            if (
                not stat.S_ISDIR(entry_stat.st_mode)
                or stat.S_IMODE(entry_stat.st_mode) != PRIVATE_DIRECTORY_MODE
            ):
                raise ValueError("Run artifact directory must be private")
            directory_fd = open_private_directory(
                entry.name,
                dir_fd=artifact_root_fd,
            )
            try:
                directory_identity = FilesystemIdentity.from_stat(
                    os.fstat(directory_fd)
                )
                if not directory_identity.matches(entry_stat):
                    raise RuntimeError("Run artifact identity changed")
                tree = snapshot_safe_artifact_tree(directory_fd)
            finally:
                os.close(directory_fd)
            snapshots.append(
                _ArtifactSnapshot(
                    run_id=run_id,
                    directory_identity=directory_identity,
                    tree=tree,
                )
            )
        return _ArtifactInspection(
            root_identity=root_identity,
            runs=tuple(snapshots),
        )
    finally:
        os.close(artifact_root_fd)


def _confirm_locked(
    reset_context: _ResetContext,
    preflight: _Preflight,
) -> ResetResult:
    plan = preflight.plan
    if plan.state is ResetState.ALREADY_COMPLETE:
        return ResetResult(
            plan=plan,
            outcome=ResetOutcome.ALREADY_COMPLETE,
            completed_at=datetime.now(UTC),
            new_head=_TARGET_HEAD,
            deleted_business_files=(),
            deleted_checkpoint_files=(),
            deleted_artifact_run_ids=(),
        )

    if plan.state is ResetState.STAGE_ONE:
        _run_phase(
            "artifact_delete",
            lambda: _delete_artifacts(reset_context, preflight),
        )
        _run_phase(
            "checkpoint_delete",
            lambda: _delete_checkpoint_files(reset_context, preflight),
        )
        business_delete_target = _run_phase(
            "business_delete",
            lambda: _require_external_state_deleted(reset_context, preflight),
        )
        _run_phase(
            "business_delete",
            lambda: _delete_business_files(reset_context, business_delete_target),
        )
        _run_phase(
            "migration",
            lambda: _require_cutover_state(
                reset_context,
                ResetState.DELETION_COMPLETE,
            ),
        )
        outcome = ResetOutcome.RESET
    elif plan.state is ResetState.DELETION_COMPLETE:
        current = _preflight(reset_context)
        if (
            current.plan.state is not ResetState.DELETION_COMPLETE
            or current.business != preflight.business
        ):
            raise StageOneResetError("reset_state_changed", "preflight")
        outcome = ResetOutcome.MIGRATED
    else:
        current = _preflight(reset_context)
        if (
            current.plan.state is not ResetState.EMPTY_DATABASE
            or current.business != preflight.business
        ):
            raise StageOneResetError("reset_state_changed", "preflight")
        main = _snapshot_named(current.business.files, "incidents.sqlite3")
        if main is None:
            raise StageOneResetError("reset_state_changed", "preflight")
        _run_phase(
            "business_delete",
            lambda: _delete_business_files(reset_context, current.business),
        )
        _run_phase(
            "migration",
            lambda: _require_cutover_state(
                reset_context,
                ResetState.DELETION_COMPLETE,
            ),
        )
        outcome = ResetOutcome.MIGRATED

    database_identity = _run_phase(
        "migration",
        lambda: _migrate_and_publish_business_database(reset_context),
    )
    final = _run_phase("migration", lambda: _preflight(reset_context))
    final_main = _snapshot_named(final.business.files, "incidents.sqlite3")
    if (
        final.plan.state is not ResetState.ALREADY_COMPLETE
        or final_main is None
        or final_main.identity != database_identity
    ):
        raise StageOneResetError("migration_failed", "migration")

    return ResetResult(
        plan=plan,
        outcome=outcome,
        completed_at=datetime.now(UTC),
        new_head=_TARGET_HEAD,
        deleted_business_files=plan.business_files,
        deleted_checkpoint_files=plan.checkpoint_files,
        deleted_artifact_run_ids=plan.artifact_run_ids,
    )


def _run_phase[T](phase: _ResetPhase, operation: Callable[[], T]) -> T:
    try:
        return operation()
    except StageOneResetError:
        raise
    except Exception as error:
        code = "migration_failed" if phase == "migration" else "reset_failed"
        raise StageOneResetError(code, phase) from error


def _require_external_state_deleted(
    reset_context: _ResetContext,
    preflight: _Preflight,
) -> _BusinessInspection:
    current = _preflight(reset_context)
    if (
        not _same_business_source(current.business, preflight.business)
        or current.checkpoint.files
        or current.artifacts.runs
    ):
        raise RuntimeError("Old external Run state remains before database deletion")
    return current.business


def _same_business_source(
    current: _BusinessInspection,
    expected: _BusinessInspection,
) -> bool:
    return (
        current.state is expected.state
        and current.head == expected.head
        and current.run_ids == expected.run_ids
        and current.row_counts == expected.row_counts
        and current.files == expected.files
    )


def _require_cutover_state(
    reset_context: _ResetContext,
    expected_state: ResetState,
) -> None:
    current = _preflight(reset_context)
    if current.plan.state is not expected_state:
        raise RuntimeError("Reset cutover state changed")


def _delete_artifacts(
    reset_context: _ResetContext,
    preflight: _Preflight,
) -> None:
    _require_business_files_unchanged(reset_context, preflight.business)
    current = _inspect_artifacts(
        reset_context,
        frozenset(preflight.business.run_ids),
    )
    if current != preflight.artifacts:
        raise RuntimeError("Run artifact target changed after preflight")
    if not current.runs:
        return
    artifact_root_fd = open_private_directory(
        "runs",
        dir_fd=reset_context.root_fd,
    )
    try:
        if current.root_identity is None or not current.root_identity.matches(
            os.fstat(artifact_root_fd)
        ):
            raise RuntimeError("Run artifact root identity changed")
        for target in current.runs:
            _require_business_files_unchanged(reset_context, preflight.business)
            _require_context(reset_context)
            rmtree_identity_bound_directory(
                artifact_root_fd,
                str(target.run_id),
                target.directory_identity,
                target.tree,
            )
    finally:
        os.close(artifact_root_fd)

    remaining = _inspect_artifacts(
        reset_context,
        frozenset(preflight.business.run_ids),
    )
    if remaining.runs:
        raise RuntimeError("Run artifact deletion did not complete")


def _delete_checkpoint_files(
    reset_context: _ResetContext,
    preflight: _Preflight,
) -> None:
    _require_business_files_unchanged(reset_context, preflight.business)
    current = _inspect_checkpoint_database(
        reset_context,
        frozenset(preflight.business.run_ids),
    )
    if current != preflight.checkpoint:
        raise RuntimeError("Checkpoint target changed after preflight")
    for file_snapshot in current.files:
        _require_business_files_unchanged(reset_context, preflight.business)
        _unlink_snapshot(reset_context, file_snapshot)
    _require_names_absent(reset_context, _CHECKPOINT_DELETE_ORDER)


def _delete_business_files(
    reset_context: _ResetContext,
    business: _BusinessInspection,
) -> None:
    for file_snapshot in business.files:
        _unlink_snapshot(reset_context, file_snapshot)
    _require_names_absent(reset_context, _BUSINESS_DELETE_ORDER)


def _require_business_files_unchanged(
    reset_context: _ResetContext,
    expected: _BusinessInspection,
) -> None:
    if _snapshot_files(reset_context, _BUSINESS_DELETE_ORDER) != expected.files:
        raise RuntimeError("Business database changed after preflight")


def _migrate_and_publish_business_database(
    reset_context: _ResetContext,
) -> FilesystemIdentity:
    _require_context(reset_context)
    _require_names_absent(reset_context, _BUSINESS_DELETE_ORDER)
    staging = _create_staging_directory(reset_context)
    try:
        staged_database = _build_staged_business_database(reset_context, staging)
        _verify_staged_business_database(reset_context, staging, staged_database)
        _require_context(reset_context)
        _require_names_absent(reset_context, _BUSINESS_DELETE_ORDER)
        _require_staged_file(staging, staged_database)
        rename_noreplace(
            staged_database.name,
            "incidents.sqlite3",
            source_parent_fd=staging.descriptor,
            destination_parent_fd=reset_context.root_fd,
        )
        os.fsync(reset_context.root_fd)
        published_database = _file_snapshot_from_stat(
            staged_database.name,
            os.stat(
                staged_database.name,
                dir_fd=reset_context.root_fd,
                follow_symlinks=False,
            ),
        )
        if (
            published_database.identity != staged_database.identity
            or published_database.size != staged_database.size
            or published_database.modified_at_ns != staged_database.modified_at_ns
        ):
            raise RuntimeError("Published reset database changed during cutover")
        _require_snapshot(reset_context, published_database)
        return published_database.identity
    finally:
        _cleanup_staging_directory(reset_context, staging)


def _build_staged_business_database(
    reset_context: _ResetContext,
    staging: _StagingDirectory,
) -> _FileSnapshot:
    engine = create_engine("sqlite://")
    try:
        with engine.connect() as connection:
            dbapi_connection = connection.connection.dbapi_connection
            if not isinstance(dbapi_connection, sqlite3.Connection):
                raise RuntimeError("SQLite DBAPI connection is unavailable")
            _require_in_memory_database(dbapi_connection)
            dbapi_connection.execute("PRAGMA foreign_keys = ON")

            config = Config(str(_SERVICE_ROOT / "alembic.ini"))
            config.attributes["runtime_paths"] = reset_context.paths
            config.attributes["caller_runtime_lock"] = reset_context.lock
            config.attributes["expected_runtime_root_identity"] = (
                reset_context.root_identity
            )
            config.attributes["reset_connection"] = connection
            command.upgrade(config, _TARGET_HEAD)

            _require_context(reset_context)
            _require_in_memory_database(dbapi_connection)
            _require_target_database(dbapi_connection)
            return _materialize_staged_database(
                reset_context,
                staging,
                dbapi_connection,
            )
    finally:
        engine.dispose()


def _materialize_staged_database(
    reset_context: _ResetContext,
    staging: _StagingDirectory,
    source: sqlite3.Connection,
) -> _FileSnapshot:
    empty_database = _create_empty_staged_file(staging, "incidents.sqlite3")
    staged_path = reset_context.paths.root / staging.name / empty_database.name
    descriptor_baseline = capture_open_file_descriptors()
    uri = f"{staged_path.as_uri()}?mode=rw&cache=private"
    with closing(sqlite3.connect(uri, uri=True, timeout=0)) as destination:
        destination_descriptor = identify_new_database_descriptor(
            descriptor_baseline,
            empty_database.identity,
        )
        destination_descriptor.require_identity()
        journal_mode = destination.execute("PRAGMA journal_mode = OFF").fetchone()
        if journal_mode != ("off",):
            raise RuntimeError("Reset staging database must not use a sidecar journal")
        source.backup(destination)
        destination.commit()
        destination_descriptor.require_identity()
        os.fsync(destination_descriptor.descriptor)
        staged_database = _file_snapshot_from_stat(
            empty_database.name,
            os.fstat(destination_descriptor.descriptor),
        )
    _require_staged_file(staging, staged_database)
    _require_only_staged_database(staging, staged_database.name)
    return staged_database


def _verify_staged_business_database(
    reset_context: _ResetContext,
    staging: _StagingDirectory,
    staged_database: _FileSnapshot,
) -> None:
    _require_staged_file(staging, staged_database)
    staged_path = reset_context.paths.root / staging.name / staged_database.name
    descriptor_baseline = capture_open_file_descriptors()
    uri = f"{staged_path.as_uri()}?mode=ro&immutable=1&cache=private"
    with closing(sqlite3.connect(uri, uri=True, timeout=0)) as connection:
        connection_descriptor = identify_new_database_descriptor(
            descriptor_baseline,
            staged_database.identity,
        )
        connection_descriptor.require_identity()
        connection.execute("PRAGMA query_only = ON")
        _require_target_database(connection)
        integrity = tuple(
            str(row[0]) for row in connection.execute("PRAGMA integrity_check")
        )
        if integrity != ("ok",):
            raise RuntimeError("Reset staging database integrity check failed")
        if (
            _file_snapshot_from_stat(
                staged_database.name,
                os.fstat(connection_descriptor.descriptor),
            )
            != staged_database
        ):
            raise RuntimeError("Reset staging database changed during verification")
    _require_staged_file(staging, staged_database)
    _require_only_staged_database(staging, staged_database.name)


def _require_in_memory_database(connection: sqlite3.Connection) -> None:
    databases = tuple(connection.execute("PRAGMA database_list"))
    if (
        not databases
        or str(databases[0][1]) != "main"
        or any(str(database[2]) for database in databases)
    ):
        raise RuntimeError("Reset migration must use an in-memory database")


def _require_target_database(connection: sqlite3.Connection) -> None:
    user_tables = _user_tables(connection)
    if user_tables != _EXPECTED_BUSINESS_TABLES:
        raise RuntimeError("Reset migration did not create the target schema")
    if _alembic_head(connection, user_tables) != _TARGET_HEAD:
        raise RuntimeError("Reset migration did not reach the target head")
    if any(_row_count(connection, table_name) != 0 for table_name in _BUSINESS_TABLES):
        raise RuntimeError("Reset migration produced nonempty business data")


def _create_empty_staged_file(
    staging: _StagingDirectory,
    name: str,
) -> _FileSnapshot:
    descriptor = os.open(
        name,
        _DATABASE_OPEN_FLAGS,
        PRIVATE_FILE_MODE,
        dir_fd=staging.descriptor,
    )
    try:
        os.fchmod(descriptor, PRIVATE_FILE_MODE)
        snapshot = _file_snapshot_from_stat(name, os.fstat(descriptor))
    finally:
        os.close(descriptor)
    _require_staged_file(staging, snapshot)
    return snapshot


def _require_only_staged_database(
    staging: _StagingDirectory,
    database_name: str,
) -> None:
    with os.scandir(staging.descriptor) as entries:
        names = frozenset(entry.name for entry in entries)
    if names != frozenset((database_name,)):
        raise RuntimeError("Reset staging directory contains unexpected files")


def _snapshot_files(
    reset_context: _ResetContext,
    names: tuple[str, ...],
) -> tuple[_FileSnapshot, ...]:
    snapshots: list[_FileSnapshot] = []
    for name in names:
        try:
            file_stat = os.stat(
                name,
                dir_fd=reset_context.root_fd,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            continue
        snapshot = _file_snapshot_from_stat(name, file_stat)
        _require_snapshot(reset_context, snapshot)
        snapshots.append(snapshot)
    return tuple(snapshots)


def _require_snapshot(
    reset_context: _ResetContext,
    snapshot: _FileSnapshot,
) -> None:
    _require_context(reset_context)
    try:
        current = os.stat(
            snapshot.name,
            dir_fd=reset_context.root_fd,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        raise RuntimeError("Reset target identity changed") from None
    if _file_snapshot_from_stat(snapshot.name, current) != snapshot:
        raise RuntimeError("Reset target identity changed")
    require_filesystem_identity(
        reset_context.paths.root / snapshot.name,
        snapshot.identity,
    )


def _unlink_snapshot(
    reset_context: _ResetContext,
    snapshot: _FileSnapshot,
) -> None:
    _require_context(reset_context)
    unlink_identity_bound_file(
        reset_context.root_fd,
        snapshot.name,
        snapshot.identity,
    )
    _require_name_absent(reset_context, snapshot.name)


def _require_names_absent(
    reset_context: _ResetContext,
    names: tuple[str, ...],
) -> None:
    for name in names:
        _require_name_absent(reset_context, name)


def _require_name_absent(reset_context: _ResetContext, name: str) -> None:
    _require_context(reset_context)
    try:
        os.stat(name, dir_fd=reset_context.root_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    raise RuntimeError("Reset target unexpectedly exists")


def _snapshot_database(
    reset_context: _ResetContext,
    path: Path,
    expected_files: tuple[_FileSnapshot, ...],
    file_names: tuple[str, ...],
) -> sqlite3.Connection:
    main = _snapshot_named(expected_files, path.name)
    if main is None:
        raise RuntimeError("SQLite snapshot requires its main database")
    wal = _snapshot_named(expected_files, f"{path.name}-wal")
    staging = _create_staging_directory(reset_context)
    snapshot_connection = sqlite3.connect(":memory:")
    try:
        initial_root_state = _directory_mutation_state(reset_context.root_fd)
        staged_main = _copy_snapshot_file(reset_context, staging, main)
        staged_wal = (
            _copy_snapshot_file(reset_context, staging, wal)
            if wal is not None
            else None
        )
        if _snapshot_files(reset_context, file_names) != expected_files:
            raise RuntimeError("SQLite database family changed during snapshot")
        use_wal = wal is not None and wal.size not in (None, 0)
        if _directory_mutation_state(reset_context.root_fd) != initial_root_state:
            raise RuntimeError("SQLite database namespace changed during snapshot")

        staged_path = reset_context.paths.root / staging.name / path.name
        uri = f"{staged_path.as_uri()}?mode=ro&cache=private"
        if not use_wal:
            uri += "&immutable=1"
        descriptor_baseline = capture_open_file_descriptors()
        with closing(sqlite3.connect(uri, uri=True, timeout=0)) as source:
            main_descriptor = identify_new_database_descriptor(
                descriptor_baseline,
                staged_main.identity,
            )
            main_descriptor.require_identity()
            source.execute("PRAGMA query_only = ON")
            with closing(
                source.execute("SELECT name FROM sqlite_schema ORDER BY name LIMIT 1")
            ) as cursor:
                cursor.fetchone()
            wal_descriptor = (
                identify_new_database_descriptor(
                    descriptor_baseline,
                    staged_wal.identity,
                )
                if use_wal and staged_wal is not None
                else None
            )
            main_descriptor.require_identity()
            if wal_descriptor is not None:
                wal_descriptor.require_identity()
            source.backup(snapshot_connection)
            main_descriptor.require_identity()
            if wal_descriptor is not None:
                wal_descriptor.require_identity()
            _require_staged_file(staging, staged_main)
            if staged_wal is not None:
                _require_staged_file(staging, staged_wal)
        if _snapshot_files(reset_context, file_names) != expected_files:
            raise RuntimeError("SQLite database family changed during snapshot")
        if _directory_mutation_state(reset_context.root_fd) != initial_root_state:
            raise RuntimeError("SQLite database namespace changed during snapshot")
        snapshot_connection.execute("PRAGMA query_only = ON")
        return snapshot_connection
    except BaseException:
        snapshot_connection.close()
        raise
    finally:
        _cleanup_staging_directory(reset_context, staging)


def _directory_mutation_state(directory_fd: int) -> _DirectoryMutationState:
    directory_stat = os.fstat(directory_fd)
    return _DirectoryMutationState(
        modified_at_ns=directory_stat.st_mtime_ns,
        changed_at_ns=directory_stat.st_ctime_ns,
    )


def _create_staging_directory(
    reset_context: _ResetContext,
) -> _StagingDirectory:
    _require_context(reset_context)
    for _attempt in range(4):
        name = f"{RESET_STAGING_DIRECTORY_PREFIX}{uuid4().hex}"
        try:
            os.mkdir(name, mode=PRIVATE_DIRECTORY_MODE, dir_fd=reset_context.root_fd)
        except FileExistsError:
            continue
        try:
            descriptor = open_private_directory(name, dir_fd=reset_context.root_fd)
        except BaseException:
            os.rmdir(name, dir_fd=reset_context.root_fd)
            raise
        return _StagingDirectory(
            name=name,
            descriptor=descriptor,
            identity=FilesystemIdentity.from_stat(os.fstat(descriptor)),
        )
    raise RuntimeError("Unable to create reset staging directory")


def _copy_snapshot_file(
    reset_context: _ResetContext,
    staging: _StagingDirectory,
    source: _FileSnapshot,
) -> _FileSnapshot:
    _require_context(reset_context)
    source_descriptor = os.open(
        source.name,
        _SNAPSHOT_SOURCE_FLAGS,
        dir_fd=reset_context.root_fd,
    )
    try:
        _require_descriptor_snapshot(source_descriptor, source)
        destination_descriptor = os.open(
            source.name,
            _DATABASE_OPEN_FLAGS,
            PRIVATE_FILE_MODE,
            dir_fd=staging.descriptor,
        )
        try:
            while chunk := os.read(source_descriptor, _COPY_BUFFER_SIZE):
                remaining = memoryview(chunk)
                while remaining:
                    written = os.write(destination_descriptor, remaining)
                    if written <= 0:
                        raise OSError("SQLite snapshot write did not progress")
                    remaining = remaining[written:]
            os.fchmod(destination_descriptor, PRIVATE_FILE_MODE)
            destination_stat = os.fstat(destination_descriptor)
        finally:
            os.close(destination_descriptor)
        _require_descriptor_snapshot(source_descriptor, source)
    finally:
        os.close(source_descriptor)
    staged = _file_snapshot_from_stat(source.name, destination_stat)
    _require_staged_file(staging, staged)
    return staged


def _require_descriptor_snapshot(
    descriptor: int,
    expected: _FileSnapshot,
) -> None:
    if _file_snapshot_from_stat(expected.name, os.fstat(descriptor)) != expected:
        raise RuntimeError("SQLite source file changed during snapshot")


def _require_staged_file(
    staging: _StagingDirectory,
    expected: _FileSnapshot,
) -> None:
    try:
        current = os.stat(
            expected.name,
            dir_fd=staging.descriptor,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        raise RuntimeError("SQLite staging file identity changed") from None
    if _file_snapshot_from_stat(expected.name, current) != expected:
        raise RuntimeError("SQLite staging file identity changed")


def _file_snapshot_from_stat(name: str, value: os.stat_result) -> _FileSnapshot:
    if (
        not stat.S_ISREG(value.st_mode)
        or stat.S_IMODE(value.st_mode) != PRIVATE_FILE_MODE
    ):
        raise ValueError("Reset target must be a private regular file")
    return _FileSnapshot(
        name=name,
        identity=FilesystemIdentity.from_stat(value),
        size=None if name.endswith("-shm") else value.st_size,
        modified_at_ns=None if name.endswith("-shm") else value.st_mtime_ns,
        changed_at_ns=None if name.endswith("-shm") else value.st_ctime_ns,
    )


def _cleanup_staging_directory(
    reset_context: _ResetContext,
    staging: _StagingDirectory,
) -> None:
    try:
        if not staging.identity.matches(os.fstat(staging.descriptor)):
            raise RuntimeError("Reset staging directory identity changed")
        tree = snapshot_safe_artifact_tree(staging.descriptor)
    finally:
        os.close(staging.descriptor)
    rmtree_identity_bound_directory(
        reset_context.root_fd,
        staging.name,
        staging.identity,
        tree,
    )


def _user_tables(connection: sqlite3.Connection) -> frozenset[str]:
    return frozenset(
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_schema "
            "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )
    )


def _alembic_head(
    connection: sqlite3.Connection,
    user_tables: frozenset[str],
) -> str | None:
    if "alembic_version" not in user_tables:
        return None
    versions = tuple(
        str(row[0])
        for row in connection.execute("SELECT version_num FROM alembic_version")
    )
    if len(versions) != 1:
        raise RuntimeError("Business database has an invalid Alembic head")
    return versions[0]


def _row_count(connection: sqlite3.Connection, table_name: str) -> int:
    if table_name not in _BUSINESS_TABLES:
        raise ValueError("Unknown business table")
    row = connection.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()
    if row is None or type(row[0]) is not int or row[0] < 0:
        raise RuntimeError("Business row count is invalid")
    return row[0]


def _canonical_uuids(values: Iterable[object]) -> tuple[UUID, ...]:
    return tuple(sorted((_canonical_uuid(value) for value in values), key=str))


def _canonical_uuid(value: object) -> UUID:
    if not isinstance(value, str):
        raise RuntimeError("Run identity is invalid")
    try:
        parsed = UUID(value)
    except ValueError:
        raise RuntimeError("Run identity is invalid") from None
    if str(parsed) != value:
        raise RuntimeError("Run identity is not canonical")
    return parsed


def _snapshot_named(
    snapshots: tuple[_FileSnapshot, ...],
    name: str,
) -> _FileSnapshot | None:
    return next((snapshot for snapshot in snapshots if snapshot.name == name), None)
