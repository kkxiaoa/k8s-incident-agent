"""Consistent copies of a stopped Runtime's data, taken before a restricted upgrade."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from alembic.util import CommandError

from k8s_incident_agent.config import Settings
from k8s_incident_agent.persistence.database import alembic_script_directory
from k8s_incident_agent.runtime.artifacts import (
    open_private_directory,
    snapshot_safe_artifact_tree,
)
from k8s_incident_agent.runtime.lock import RuntimeLock, RuntimeLockUnavailableError
from k8s_incident_agent.runtime.paths import PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE

RETAINED_BACKUPS = 3
BACKUP_MANIFEST = "backup.json"
_BACKUP_NAME = re.compile(r"\d{8}T\d{6}Z")
_STAGING_NAME = re.compile(r"\.\d{8}T\d{6}Z\.partial")
_NEW_FILE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW
_COPY_BUFFER_SIZE = 1024 * 1024


class RuntimeBackupError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__("Runtime backup failed safely")
        self.code = code


@dataclass(frozen=True, slots=True)
class BackupResult:
    name: str
    alembic_head: str | None
    files: int
    size: int
    removed: tuple[str, ...]


def backup_runtime_data(
    settings: Settings,
    destination: Path,
    now: datetime,
) -> BackupResult:
    if now.utcoffset() != timedelta(0) or not destination.is_absolute():
        raise RuntimeBackupError("destination_invalid")
    try:
        if not stat.S_ISDIR(destination.lstat().st_mode):
            raise RuntimeBackupError("destination_invalid")
    except FileNotFoundError:
        raise RuntimeBackupError("destination_invalid") from None
    paths = settings.runtime_paths
    # Holding the Runtime's own lock proves no Runtime process can write meanwhile.
    lock = RuntimeLock(paths.runtime_lock)
    try:
        lock.acquire()
    except RuntimeLockUnavailableError:
        raise RuntimeBackupError("runtime_in_use") from None
    except (OSError, ValueError):
        raise RuntimeBackupError("runtime_data_invalid") from None
    try:
        name = now.strftime("%Y%m%dT%H%M%SZ")
        target = destination / name
        if os.path.lexists(target):
            raise RuntimeBackupError("backup_exists")
        _remove_stale_staging(destination)
        staging = destination / f".{name}.partial"
        staging.mkdir(mode=PRIVATE_DIRECTORY_MODE)
        try:
            files = [
                _copy_database(database, staging / database.name)
                for database in (paths.business_database, paths.checkpoint_database)
                if database.exists()
            ]
            head = _alembic_head(staging / paths.business_database.name)
            _require_known_revision(head)
            files.extend(_copy_artifacts(paths.run_artifacts, staging))
            manifest = {"alembicHead": head, "files": files}
            _write_private(
                staging / BACKUP_MANIFEST,
                json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode(),
            )
            _sync_directory(staging)
            os.rename(staging, target)
            _sync_directory(destination)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        return BackupResult(
            name=name,
            alembic_head=head,
            files=len(files),
            size=sum(int(item["size"]) for item in files),
            removed=_apply_retention(destination, name),
        )
    except RuntimeBackupError:
        raise
    except (OSError, sqlite3.Error, ValueError, RuntimeError) as error:
        raise RuntimeBackupError("backup_failed") from error
    finally:
        lock.release()


def _copy_database(source: Path, target: Path) -> dict[str, str | int]:
    os.close(os.open(target, _NEW_FILE_FLAGS, PRIVATE_FILE_MODE))
    # The online backup API copies one transactionally consistent image, WAL content included.
    with (
        closing(sqlite3.connect(source)) as origin,
        closing(sqlite3.connect(target)) as copy,
    ):
        origin.backup(copy)
        if copy.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise RuntimeBackupError("integrity_failed")
        # A self-contained file: no WAL sidecar has to travel with the copy.
        copy.execute("PRAGMA journal_mode = DELETE")
    return _describe(target, target.name)


def _alembic_head(database: Path) -> str | None:
    if not database.exists():
        return None
    with closing(sqlite3.connect(f"file:{database}?mode=ro", uri=True)) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        if "alembic_version" not in tables:
            return None
        rows = connection.execute("SELECT version_num FROM alembic_version").fetchall()
    if len(rows) != 1 or not isinstance(rows[0][0], str):
        raise RuntimeBackupError("schema_invalid")
    return rows[0][0]


def _require_known_revision(head: str | None) -> None:
    # Data from a newer release cannot be migrated by this one; stopping before the
    # upgrade keeps an incompatible downgrade from replacing the running version.
    if head is None:
        return
    try:
        alembic_script_directory().get_revision(head)
    except CommandError:
        raise RuntimeBackupError("schema_unknown") from None


def _copy_artifacts(root: Path, staging: Path) -> list[dict[str, str | int]]:
    if not root.exists():
        return []
    directory_fd = open_private_directory(root)
    try:
        target_root = staging / root.name
        target_root.mkdir(mode=PRIVATE_DIRECTORY_MODE)
        files: list[dict[str, str | int]] = []
        for entry in snapshot_safe_artifact_tree(directory_fd):
            target = target_root / entry.relative_path
            if stat.S_ISDIR(entry.identity.mode):
                target.mkdir(mode=PRIVATE_DIRECTORY_MODE)
                continue
            source_fd = os.open(
                entry.relative_path,
                os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
                dir_fd=directory_fd,
            )
            try:
                if not entry.identity.matches(os.fstat(source_fd)):
                    raise RuntimeBackupError("artifact_changed")
                target_fd = os.open(target, _NEW_FILE_FLAGS, PRIVATE_FILE_MODE)
                try:
                    while chunk := os.read(source_fd, _COPY_BUFFER_SIZE):
                        os.write(target_fd, chunk)
                    os.fsync(target_fd)
                finally:
                    os.close(target_fd)
            finally:
                os.close(source_fd)
            files.append(_describe(target, f"{root.name}/{entry.relative_path}"))
        return files
    finally:
        os.close(directory_fd)


def _describe(path: Path, relative: str) -> dict[str, str | int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(_COPY_BUFFER_SIZE):
            digest.update(chunk)
            size += len(chunk)
    return {"path": relative, "sha256": digest.hexdigest(), "size": size}


def _write_private(path: Path, content: bytes) -> None:
    file_descriptor = os.open(path, _NEW_FILE_FLAGS, PRIVATE_FILE_MODE)
    try:
        os.write(file_descriptor, content)
        os.fsync(file_descriptor)
    finally:
        os.close(file_descriptor)


def _sync_directory(path: Path) -> None:
    directory_fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _remove_stale_staging(destination: Path) -> None:
    # Only an interrupted run of this command leaves these; the lock excludes a live one.
    with os.scandir(destination) as entries:
        stale = [
            entry.path
            for entry in entries
            if _STAGING_NAME.fullmatch(entry.name)
            and entry.is_dir(follow_symlinks=False)
        ]
    for path in stale:
        shutil.rmtree(path)


def _apply_retention(destination: Path, kept: str) -> tuple[str, ...]:
    with os.scandir(destination) as entries:
        complete = sorted(
            entry.name
            for entry in entries
            if _BACKUP_NAME.fullmatch(entry.name)
            and entry.is_dir(follow_symlinks=False)
            and _has_manifest(Path(entry.path))
        )
    # Names follow the node clock; one set back must not delete the copy just taken.
    removed = tuple(name for name in complete[:-RETAINED_BACKUPS] if name != kept)
    for name in removed:
        shutil.rmtree(destination / name)
    return removed


def _has_manifest(directory: Path) -> bool:
    try:
        return stat.S_ISREG((directory / BACKUP_MANIFEST).lstat().st_mode)
    except FileNotFoundError:
        return False
