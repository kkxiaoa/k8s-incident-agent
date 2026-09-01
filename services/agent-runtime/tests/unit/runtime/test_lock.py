import stat
from pathlib import Path

import pytest

from k8s_incident_agent.runtime.lock import (
    RuntimeLock,
    RuntimeLockUnavailableError,
)
from k8s_incident_agent.runtime.paths import RuntimePaths


def test_runtime_lock_is_nonblocking_and_file_presence_is_not_ownership(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    first = RuntimeLock(paths.runtime_lock)
    second = RuntimeLock(paths.runtime_lock)

    try:
        first.acquire()
        assert stat.S_IMODE(paths.runtime_lock.stat().st_mode) == 0o600

        with pytest.raises(RuntimeLockUnavailableError):
            second.acquire()

        first.release()
        second.acquire()
    finally:
        first.release()
        second.release()


@pytest.mark.parametrize("unsafe_kind", ["symlink", "mode"])
def test_runtime_lock_rejects_unsafe_existing_files(
    tmp_path: Path,
    unsafe_kind: str,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    if unsafe_kind == "symlink":
        external_file = tmp_path / "external.lock"
        external_file.touch(mode=0o600)
        paths.runtime_lock.symlink_to(external_file)
    else:
        paths.runtime_lock.touch(mode=0o600)
        paths.runtime_lock.chmod(0o644)

    with pytest.raises(ValueError):
        RuntimeLock(paths.runtime_lock).acquire()


def test_runtime_lock_rejects_a_replaced_held_lock_path(tmp_path: Path) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    lock = RuntimeLock(paths.runtime_lock)
    lock.acquire()
    moved_lock = paths.root / "moved.lock"
    paths.runtime_lock.rename(moved_lock)
    paths.runtime_lock.touch(mode=0o600)

    try:
        with pytest.raises(RuntimeError, match="identity changed"):
            lock.require_held(paths.runtime_lock)
    finally:
        lock.release()

    assert moved_lock.exists()
    assert paths.runtime_lock.exists()
