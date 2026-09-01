from __future__ import annotations

import errno
import os
import shutil
import stat
from collections.abc import AsyncGenerator, Generator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

from k8s_incident_agent.config import Settings
from k8s_incident_agent.persistence.database import (
    create_business_database,
    require_alembic_head,
)
from k8s_incident_agent.persistence.repositories import (
    IncidentRepository,
    PruneTarget,
)
from k8s_incident_agent.runtime.lock import RuntimeLock
from k8s_incident_agent.runtime.paths import (
    PRIVATE_DIRECTORY_MODE,
    PRIVATE_FILE_MODE,
    RuntimePaths,
)
from k8s_incident_agent.workflow.checkpoint import open_checkpoint_store

_ARTIFACT_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
_RMTREE_AVOIDS_SYMLINK_ATTACKS = shutil.rmtree.avoids_symlink_attacks


@dataclass(frozen=True, slots=True)
class PruneResult:
    deleted_targets: tuple[PruneTarget, ...]


async def preview_prune(
    settings: Settings,
    now: datetime,
) -> tuple[PruneTarget, ...]:
    cutoff = _retention_cutoff(now, settings.runtime_retention_days)
    with _locked_runtime_paths(settings) as paths:
        async with _repository(paths) as repository:
            targets = await repository.list_prune_targets(
                cutoff,
                paths.run_artifacts,
            )
            for target in targets:
                _require_safe_artifact_directories(paths, target)
            return targets


async def confirm_prune(settings: Settings, now: datetime) -> PruneResult:
    cutoff = _retention_cutoff(now, settings.runtime_retention_days)
    with _locked_runtime_paths(settings) as paths:
        async with _repository(paths) as repository:
            targets = await repository.list_prune_targets(
                cutoff,
                paths.run_artifacts,
            )
            if not targets:
                return PruneResult(deleted_targets=())

            deleted_targets: list[PruneTarget] = []
            async with open_checkpoint_store(paths.checkpoint_database) as saver:
                for target in targets:
                    _require_safe_artifact_directories(paths, target)
                    for run_id, artifact_directory in zip(
                        target.run_ids,
                        target.artifact_directories,
                        strict=True,
                    ):
                        _delete_artifact_directory(
                            paths,
                            run_id,
                            artifact_directory,
                        )
                    for run_id in target.run_ids:
                        await saver.adelete_thread(str(run_id))
                    deleted = await repository.delete_prune_target(
                        target,
                        cutoff,
                        paths.run_artifacts,
                    )
                    if deleted:
                        deleted_targets.append(target)
            return PruneResult(deleted_targets=tuple(deleted_targets))


def _retention_cutoff(now: datetime, retention_days: int) -> datetime:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("Retention time must include a UTC offset")
    return now.astimezone(UTC) - timedelta(days=retention_days)


@contextmanager
def _locked_runtime_paths(settings: Settings) -> Generator[RuntimePaths]:
    paths = _validated_runtime_paths(settings.runtime_paths)
    runtime_lock = RuntimeLock(paths.runtime_lock)
    runtime_lock.acquire()
    try:
        yield _validated_runtime_paths(settings.runtime_paths)
    finally:
        runtime_lock.release()


def _validated_runtime_paths(paths: RuntimePaths) -> RuntimePaths:
    prepared = RuntimePaths.prepare(paths.root)
    if prepared != paths:
        raise ValueError("Runtime paths do not match the fixed layout")
    return prepared


@asynccontextmanager
async def _repository(paths: RuntimePaths) -> AsyncGenerator[IncidentRepository]:
    database = await create_business_database(paths)
    try:
        await require_alembic_head(database)
        yield IncidentRepository(database.session_factory)
    finally:
        await database.dispose()


def _delete_artifact_directory(
    paths: RuntimePaths,
    run_id: UUID,
    artifact_directory: Path,
) -> None:
    with _validated_artifact_parent(
        paths,
        run_id,
        artifact_directory,
    ) as validated:
        if validated is None:
            return
        if not _RMTREE_AVOIDS_SYMLINK_ATTACKS:
            raise RuntimeError("Safe descriptor-relative artifact deletion is required")
        artifact_root_fd, directory_name = validated
        shutil.rmtree(directory_name, dir_fd=artifact_root_fd)


def _require_safe_artifact_directories(
    paths: RuntimePaths,
    target: PruneTarget,
) -> None:
    for run_id, artifact_directory in zip(
        target.run_ids,
        target.artifact_directories,
        strict=True,
    ):
        with _validated_artifact_parent(paths, run_id, artifact_directory):
            pass


@contextmanager
def _validated_artifact_parent(
    paths: RuntimePaths,
    run_id: UUID,
    artifact_directory: Path,
) -> Generator[tuple[int, str] | None]:
    expected_directory = paths.run_artifact_directory(run_id)
    if artifact_directory != expected_directory:
        raise ValueError("Prune target does not match its fixed artifact directory")

    try:
        artifact_root_fd = _open_private_directory(paths.run_artifacts)
    except FileNotFoundError:
        yield None
        return

    try:
        try:
            directory_fd = _open_private_directory(
                str(run_id),
                dir_fd=artifact_root_fd,
            )
        except FileNotFoundError:
            yield None
            return
        try:
            _require_safe_artifact_tree(directory_fd)
        finally:
            os.close(directory_fd)
        yield artifact_root_fd, str(run_id)
    finally:
        os.close(artifact_root_fd)


def _open_private_directory(path: Path | str, *, dir_fd: int | None = None) -> int:
    try:
        directory_fd = os.open(path, _ARTIFACT_DIRECTORY_FLAGS, dir_fd=dir_fd)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise ValueError(
                "Run artifact directory must be private and must not be a symbolic link"
            ) from error
        raise
    try:
        _require_private_directory(os.fstat(directory_fd).st_mode)
    except BaseException:
        os.close(directory_fd)
        raise
    return directory_fd


def _require_safe_artifact_tree(directory_fd: int) -> None:
    with os.scandir(directory_fd) as entries:
        for entry in entries:
            entry_stat = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(entry_stat.st_mode):
                child_fd = _open_private_directory(
                    entry.name,
                    dir_fd=directory_fd,
                )
                try:
                    _require_safe_artifact_tree(child_fd)
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(entry_stat.st_mode):
                if stat.S_IMODE(entry_stat.st_mode) != PRIVATE_FILE_MODE:
                    raise ValueError("Run artifact file must be private")
            else:
                raise ValueError("Run artifacts must not contain symbolic links")


def _require_private_directory(mode: int) -> None:
    if not stat.S_ISDIR(mode) or stat.S_IMODE(mode) != PRIVATE_DIRECTORY_MODE:
        raise ValueError("Run artifact directory must be private")
