from __future__ import annotations

import os
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
from k8s_incident_agent.runtime.artifacts import (
    ArtifactTreeEntry,
    open_private_directory,
    snapshot_safe_artifact_tree,
)
from k8s_incident_agent.runtime.deletion import (
    require_no_incomplete_deletion_claims,
    rmtree_identity_bound_directory,
)
from k8s_incident_agent.runtime.lock import RuntimeLock
from k8s_incident_agent.runtime.paths import (
    FilesystemIdentity,
    RuntimePaths,
)
from k8s_incident_agent.workflow.checkpoint import open_checkpoint_store


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
        artifact_root_fd, directory_name, directory_identity, tree = validated
        rmtree_identity_bound_directory(
            artifact_root_fd,
            directory_name,
            directory_identity,
            tree,
        )


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
) -> Generator[
    tuple[
        int,
        str,
        FilesystemIdentity,
        tuple[ArtifactTreeEntry, ...],
    ]
    | None
]:
    expected_directory = paths.run_artifact_directory(run_id)
    if artifact_directory != expected_directory:
        raise ValueError("Prune target does not match its fixed artifact directory")

    try:
        artifact_root_fd = open_private_directory(paths.run_artifacts)
    except FileNotFoundError:
        yield None
        return

    try:
        require_no_incomplete_deletion_claims(artifact_root_fd)
        try:
            directory_fd = open_private_directory(
                str(run_id),
                dir_fd=artifact_root_fd,
            )
        except FileNotFoundError:
            yield None
            return
        try:
            directory_identity = FilesystemIdentity.from_stat(os.fstat(directory_fd))
            tree = snapshot_safe_artifact_tree(directory_fd)
        finally:
            os.close(directory_fd)
        yield artifact_root_fd, str(run_id), directory_identity, tree
    finally:
        os.close(artifact_root_fd)
