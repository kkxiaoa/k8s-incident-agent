from __future__ import annotations

import errno
import os
import stat
from dataclasses import dataclass
from pathlib import Path

from k8s_incident_agent.runtime.paths import (
    PRIVATE_DIRECTORY_MODE,
    PRIVATE_FILE_MODE,
    FilesystemIdentity,
)

_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW


@dataclass(frozen=True, slots=True)
class ArtifactTreeEntry:
    relative_path: str
    identity: FilesystemIdentity


def open_private_directory(
    path: Path | str,
    *,
    dir_fd: int | None = None,
) -> int:
    try:
        directory_fd = os.open(path, _DIRECTORY_FLAGS, dir_fd=dir_fd)
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


def snapshot_safe_artifact_tree(directory_fd: int) -> tuple[ArtifactTreeEntry, ...]:
    return _snapshot_safe_artifact_tree(directory_fd, prefix="")


def _snapshot_safe_artifact_tree(
    directory_fd: int,
    *,
    prefix: str,
) -> tuple[ArtifactTreeEntry, ...]:
    snapshots: list[ArtifactTreeEntry] = []
    with os.scandir(directory_fd) as entries:
        ordered_entries = sorted(entries, key=lambda entry: entry.name)
    for entry in ordered_entries:
        relative_path = f"{prefix}/{entry.name}" if prefix else entry.name
        entry_stat = entry.stat(follow_symlinks=False)
        identity = FilesystemIdentity.from_stat(entry_stat)
        if stat.S_ISDIR(entry_stat.st_mode):
            _require_private_directory(entry_stat.st_mode)
            child_fd = open_private_directory(entry.name, dir_fd=directory_fd)
            try:
                if not identity.matches(os.fstat(child_fd)):
                    raise RuntimeError("Run artifact directory identity changed")
                snapshots.append(ArtifactTreeEntry(relative_path, identity))
                snapshots.extend(
                    _snapshot_safe_artifact_tree(
                        child_fd,
                        prefix=relative_path,
                    )
                )
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(entry_stat.st_mode):
            if stat.S_IMODE(entry_stat.st_mode) != PRIVATE_FILE_MODE:
                raise ValueError("Run artifact file must be private")
            snapshots.append(ArtifactTreeEntry(relative_path, identity))
        else:
            raise ValueError("Run artifacts must not contain symbolic links")
    return tuple(snapshots)


def _require_private_directory(mode: int) -> None:
    if not stat.S_ISDIR(mode) or stat.S_IMODE(mode) != PRIVATE_DIRECTORY_MODE:
        raise ValueError("Run artifact directory must be private")
