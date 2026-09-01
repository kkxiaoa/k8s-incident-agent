import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Self
from uuid import UUID

REPOSITORY_ROOT = Path(__file__).resolve().parents[5]
PRIVATE_DIRECTORY_MODE = 0o700
PRIVATE_FILE_MODE = 0o600


@dataclass(frozen=True, slots=True)
class RuntimePaths:
    root: Path
    business_database: Path
    checkpoint_database: Path
    diagnostic_kubeconfig: Path
    runtime_lock: Path
    run_artifacts: Path

    def run_artifact_directory(self, run_id: UUID) -> Path:
        expected_artifact_root = self.root / "runs"
        if self.run_artifacts != expected_artifact_root:
            raise ValueError(
                "Runtime artifact directory does not match the fixed layout"
            )
        return self.run_artifacts / str(run_id)

    @classmethod
    def prepare(cls, root: Path) -> Self:
        if not root.is_absolute():
            raise ValueError("RUNTIME_DATA_DIR must be absolute")

        normalized_root = Path(os.path.normpath(root))
        broad_roots = {
            Path(normalized_root.anchor),
            Path(os.path.normpath(Path.home())),
            REPOSITORY_ROOT,
        }
        if normalized_root in broad_roots:
            raise ValueError("RUNTIME_DATA_DIR must be a dedicated directory")

        _reject_symlink_components(normalized_root)
        try:
            root_stat = normalized_root.lstat()
        except FileNotFoundError:
            normalized_root.mkdir(parents=True, mode=PRIVATE_DIRECTORY_MODE)
            normalized_root.chmod(PRIVATE_DIRECTORY_MODE)
            _reject_symlink_components(normalized_root)
            root_stat = normalized_root.lstat()

        if (
            not stat.S_ISDIR(root_stat.st_mode)
            or stat.S_IMODE(root_stat.st_mode) != PRIVATE_DIRECTORY_MODE
        ):
            raise ValueError("RUNTIME_DATA_DIR must be a private directory")

        paths = cls(
            root=normalized_root,
            business_database=normalized_root / "incidents.sqlite3",
            checkpoint_database=normalized_root / "checkpoints.sqlite3",
            diagnostic_kubeconfig=normalized_root / "diagnostic.kubeconfig",
            runtime_lock=normalized_root / "runtime.lock",
            run_artifacts=normalized_root / "runs",
        )
        for target in (
            paths.business_database,
            paths.checkpoint_database,
            paths.diagnostic_kubeconfig,
            paths.runtime_lock,
            *sqlite_sidecars(paths.business_database),
            *sqlite_sidecars(paths.checkpoint_database),
        ):
            validate_existing_private_file(target)
        _validate_existing_private_directory(paths.run_artifacts)
        return paths


@dataclass(frozen=True, slots=True)
class FilesystemIdentity:
    device: int
    inode: int
    mode: int

    @classmethod
    def from_stat(cls, value: os.stat_result) -> "FilesystemIdentity":
        return cls(device=value.st_dev, inode=value.st_ino, mode=value.st_mode)

    def matches(self, value: os.stat_result) -> bool:
        return self == self.from_stat(value)


def require_filesystem_identity(
    path: Path,
    expected: FilesystemIdentity,
) -> None:
    try:
        current = path.lstat()
    except FileNotFoundError:
        raise RuntimeError("Runtime filesystem identity changed") from None
    if not expected.matches(current):
        raise RuntimeError("Runtime filesystem identity changed")


def sqlite_sidecars(database: Path) -> tuple[Path, Path]:
    return Path(f"{database}-wal"), Path(f"{database}-shm")


def _reject_symlink_components(path: Path) -> None:
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        try:
            component_stat = current.lstat()
        except FileNotFoundError:
            break
        if stat.S_ISLNK(component_stat.st_mode):
            raise ValueError("RUNTIME_DATA_DIR must not traverse symbolic links")


def validate_existing_private_file(path: Path) -> None:
    try:
        path_stat = path.lstat()
    except FileNotFoundError:
        return
    if (
        not stat.S_ISREG(path_stat.st_mode)
        or stat.S_IMODE(path_stat.st_mode) != PRIVATE_FILE_MODE
    ):
        raise ValueError("Runtime artifact must be a private regular file")


def _validate_existing_private_directory(path: Path) -> None:
    try:
        path_stat = path.lstat()
    except FileNotFoundError:
        return
    if (
        not stat.S_ISDIR(path_stat.st_mode)
        or stat.S_IMODE(path_stat.st_mode) != PRIVATE_DIRECTORY_MODE
    ):
        raise ValueError("Runtime artifact directory must be private")
