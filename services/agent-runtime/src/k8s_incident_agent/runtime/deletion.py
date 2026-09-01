from __future__ import annotations

import ctypes
import errno
import os
import shutil
import sys
from collections.abc import Callable
from typing import cast
from uuid import uuid4

from k8s_incident_agent.runtime.artifacts import (
    ArtifactTreeEntry,
    open_private_directory,
    snapshot_safe_artifact_tree,
)
from k8s_incident_agent.runtime.cutover import DELETION_CLAIM_DIRECTORY_PREFIX
from k8s_incident_agent.runtime.paths import FilesystemIdentity

_CLAIM_NAME = "target"
_RMTREE_AVOIDS_SYMLINK_ATTACKS = shutil.rmtree.avoids_symlink_attacks
_LINUX_RENAME_NOREPLACE = 1
_DARWIN_RENAME_EXCL = 0x00000004


def require_no_incomplete_deletion_claims(parent_fd: int) -> None:
    with os.scandir(parent_fd) as entries:
        if any(
            entry.name.startswith(DELETION_CLAIM_DIRECTORY_PREFIX) for entry in entries
        ):
            raise RuntimeError("An incomplete identity-bound deletion remains")


def unlink_identity_bound_file(
    parent_fd: int,
    name: str,
    expected_identity: FilesystemIdentity,
) -> None:
    _require_single_component(name)
    claim_name, claim_fd = _create_claim_directory(parent_fd)
    claimed = False
    identity_verified = False
    try:
        os.rename(
            name,
            _CLAIM_NAME,
            src_dir_fd=parent_fd,
            dst_dir_fd=claim_fd,
        )
        claimed = True
        claimed_stat = os.stat(
            _CLAIM_NAME,
            dir_fd=claim_fd,
            follow_symlinks=False,
        )
        if not expected_identity.matches(claimed_stat):
            raise RuntimeError("Deletion target identity changed")
        identity_verified = True
        os.unlink(_CLAIM_NAME, dir_fd=claim_fd)
        claimed = False
    except BaseException:
        if claimed and identity_verified:
            _restore_claimed_directory_entry(
                claim_fd,
                parent_fd,
                name,
            )
        raise
    finally:
        _close_claim_directory(parent_fd, claim_name, claim_fd)


def rmtree_identity_bound_directory(
    parent_fd: int,
    name: str,
    expected_identity: FilesystemIdentity,
    expected_tree: tuple[ArtifactTreeEntry, ...],
) -> None:
    _require_single_component(name)
    if not _RMTREE_AVOIDS_SYMLINK_ATTACKS:
        raise RuntimeError("Safe descriptor-relative artifact deletion is required")

    claim_name, claim_fd = _create_claim_directory(parent_fd)
    claimed = False
    identity_verified = False
    try:
        os.rename(
            name,
            _CLAIM_NAME,
            src_dir_fd=parent_fd,
            dst_dir_fd=claim_fd,
        )
        claimed = True
        directory_fd = open_private_directory(_CLAIM_NAME, dir_fd=claim_fd)
        try:
            if not expected_identity.matches(os.fstat(directory_fd)):
                raise RuntimeError("Deletion target identity changed")
            if snapshot_safe_artifact_tree(directory_fd) != expected_tree:
                raise RuntimeError("Deletion target tree changed")
            identity_verified = True
        finally:
            os.close(directory_fd)

        shutil.rmtree(_CLAIM_NAME, dir_fd=claim_fd)
        claimed = False
    except BaseException:
        if claimed and identity_verified:
            _restore_claimed_directory_entry(
                claim_fd,
                parent_fd,
                name,
            )
        raise
    finally:
        _close_claim_directory(parent_fd, claim_name, claim_fd)


def _create_claim_directory(parent_fd: int) -> tuple[str, int]:
    for _attempt in range(4):
        name = f"{DELETION_CLAIM_DIRECTORY_PREFIX}{uuid4().hex}"
        try:
            os.mkdir(name, mode=0o700, dir_fd=parent_fd)
        except FileExistsError:
            continue
        try:
            return name, open_private_directory(name, dir_fd=parent_fd)
        except BaseException:
            os.rmdir(name, dir_fd=parent_fd)
            raise
    raise RuntimeError("Unable to create an identity-bound deletion claim")


def _restore_claimed_directory_entry(
    claim_fd: int,
    parent_fd: int,
    original_name: str,
) -> None:
    try:
        os.stat(original_name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        try:
            rename_noreplace(
                _CLAIM_NAME,
                original_name,
                source_parent_fd=claim_fd,
                destination_parent_fd=parent_fd,
            )
        except OSError:
            return


def rename_noreplace(
    source: str,
    destination: str,
    *,
    source_parent_fd: int,
    destination_parent_fd: int,
) -> None:
    if sys.platform == "linux":
        symbol = "renameat2"
        flag = _LINUX_RENAME_NOREPLACE
    elif sys.platform == "darwin":
        symbol = "renameatx_np"
        flag = _DARWIN_RENAME_EXCL
    else:
        raise OSError(errno.ENOTSUP, "Atomic no-replace rename is unavailable")

    library = ctypes.CDLL(None, use_errno=True)
    try:
        raw_function = getattr(library, symbol)
    except AttributeError:
        raise OSError(
            errno.ENOTSUP, "Atomic no-replace rename is unavailable"
        ) from None
    function = cast(Callable[[int, bytes, int, bytes, int], int], raw_function)
    ctypes.set_errno(0)
    result = function(
        source_parent_fd,
        os.fsencode(source),
        destination_parent_fd,
        os.fsencode(destination),
        flag,
    )
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, "Atomic no-replace rename failed")


def _close_claim_directory(
    parent_fd: int,
    name: str,
    claim_fd: int,
) -> None:
    active_error = sys.exception()
    os.close(claim_fd)
    try:
        os.rmdir(name, dir_fd=parent_fd)
    except OSError as error:
        if active_error is None or error.errno not in (errno.ENOTEMPTY, errno.EEXIST):
            raise


def _require_single_component(name: str) -> None:
    if not name or name in (".", "..") or os.path.basename(name) != name:
        raise ValueError("Deletion target must be a single path component")
