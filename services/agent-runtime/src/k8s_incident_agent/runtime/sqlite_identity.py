from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from k8s_incident_agent.runtime.paths import FilesystemIdentity

_FILE_DESCRIPTOR_DIRECTORIES = (Path("/proc/self/fd"), Path("/dev/fd"))


@dataclass(frozen=True, slots=True)
class OpenDatabaseDescriptor:
    descriptor: int
    identity: FilesystemIdentity

    def require_identity(self) -> None:
        try:
            current = os.fstat(self.descriptor)
        except OSError:
            raise RuntimeError("SQLite database descriptor was closed") from None
        if not self.identity.matches(current):
            raise RuntimeError("SQLite database file identity changed")


def capture_open_file_descriptors() -> dict[int, FilesystemIdentity]:
    descriptor_directory = _descriptor_directory()
    try:
        names = os.listdir(descriptor_directory)
    except OSError as error:
        raise RuntimeError("Open file descriptors cannot be inspected") from error
    descriptors: dict[int, FilesystemIdentity] = {}
    for name in names:
        try:
            descriptor = int(name)
        except ValueError:
            continue
        try:
            descriptor_stat = os.fstat(descriptor)
        except OSError:
            continue
        descriptors[descriptor] = FilesystemIdentity.from_stat(descriptor_stat)
    return descriptors


def identify_new_database_descriptor(
    baseline: Mapping[int, FilesystemIdentity],
    expected_identity: FilesystemIdentity,
) -> OpenDatabaseDescriptor:
    matches: list[int] = []
    for descriptor, current_identity in capture_open_file_descriptors().items():
        if (
            current_identity == expected_identity
            and baseline.get(descriptor) != current_identity
        ):
            matches.append(descriptor)
    if len(matches) != 1:
        raise RuntimeError("SQLite connection database file identity is unproven")
    opened = OpenDatabaseDescriptor(matches[0], expected_identity)
    opened.require_identity()
    return opened


def _descriptor_directory() -> Path:
    for path in _FILE_DESCRIPTOR_DIRECTORIES:
        if path.is_dir():
            return path
    raise RuntimeError("Open file descriptor inspection is unavailable")
