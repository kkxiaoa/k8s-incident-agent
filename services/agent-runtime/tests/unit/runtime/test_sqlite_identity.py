import os
import sqlite3
from pathlib import Path

import pytest

from k8s_incident_agent.runtime.paths import FilesystemIdentity
from k8s_incident_agent.runtime.sqlite_identity import (
    capture_open_file_descriptors,
    identify_new_database_descriptor,
)


def test_opened_sqlite_connection_is_bound_to_the_expected_inode(
    tmp_path: Path,
) -> None:
    database = tmp_path / "incidents.sqlite3"
    database.touch(mode=0o600)
    expected = FilesystemIdentity.from_stat(database.stat())
    baseline = capture_open_file_descriptors()

    connection = sqlite3.connect(database)
    try:
        opened = identify_new_database_descriptor(baseline, expected)
        opened.require_identity()
    finally:
        connection.close()


def test_opened_sqlite_connection_rejects_an_aba_path_replacement(
    tmp_path: Path,
) -> None:
    database = tmp_path / "incidents.sqlite3"
    database.touch(mode=0o600)
    expected = FilesystemIdentity.from_stat(database.stat())
    expected_path = tmp_path / "expected.sqlite3"
    replacement_path = tmp_path / "replacement.sqlite3"
    baseline = capture_open_file_descriptors()

    database.rename(expected_path)
    database.write_bytes(b"")
    database.chmod(0o600)
    connection = sqlite3.connect(database)
    try:
        database.rename(replacement_path)
        expected_path.rename(database)

        with pytest.raises(RuntimeError, match="database file identity"):
            identify_new_database_descriptor(baseline, expected)
    finally:
        connection.close()

    assert os.stat(database).st_ino == expected.inode
    assert replacement_path.exists()


def test_opened_sqlite_connection_allows_a_reused_descriptor_number(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    database = tmp_path / "incidents.sqlite3"
    database.touch(mode=0o600)
    expected = FilesystemIdentity.from_stat(database.stat())
    baseline = capture_open_file_descriptors()
    connection = sqlite3.connect(database)
    current = capture_open_file_descriptors()
    database_descriptors = tuple(
        descriptor
        for descriptor, identity in current.items()
        if identity == expected and baseline.get(descriptor) != identity
    )
    assert len(database_descriptors) == 1
    descriptor = database_descriptors[0]
    reused_baseline = {**baseline, descriptor: FilesystemIdentity(0, 0, 0)}

    monkeypatch.setattr(
        "k8s_incident_agent.runtime.sqlite_identity.capture_open_file_descriptors",
        lambda: current,
    )
    try:
        opened = identify_new_database_descriptor(reused_baseline, expected)
        assert opened.descriptor == descriptor
    finally:
        connection.close()
