from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
import stat
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from langchain_core.runnables.config import RunnableConfig
from langgraph.checkpoint.base import CheckpointMetadata, empty_checkpoint

from k8s_incident_agent.config import Settings
from k8s_incident_agent.runtime import cli
from k8s_incident_agent.runtime.backup import (
    BACKUP_MANIFEST,
    RuntimeBackupError,
    backup_runtime_data,
)
from k8s_incident_agent.runtime.lock import RuntimeLock
from k8s_incident_agent.runtime.paths import RuntimePaths
from k8s_incident_agent.workflow.checkpoint import open_checkpoint_store

SERVICE_ROOT = Path(__file__).resolve().parents[3]
RUN_ID = UUID("00000000-0000-4000-8000-000000000001")
NOW = datetime(2030, 1, 15, 12, 0, tzinfo=UTC)


def _alembic_config(paths: RuntimePaths) -> Config:
    config = Config(str(SERVICE_ROOT / "alembic.ini"))
    config.attributes["runtime_paths"] = paths
    return config


def _settings(paths: RuntimePaths) -> Settings:
    return Settings.model_validate({"RUNTIME_DATA_DIR": paths})


def _script() -> ScriptDirectory:
    return ScriptDirectory.from_config(Config(str(SERVICE_ROOT / "alembic.ini")))


def _head() -> str:
    head = _script().get_current_head()
    assert head is not None
    return head


def _previous_revision() -> str:
    head = _script().get_revision(_head())
    assert head is not None and isinstance(head.down_revision, str)
    return head.down_revision


def _dump(database: Path) -> list[str]:
    with closing(sqlite3.connect(database)) as connection:
        return list(connection.iterdump())


async def _seeded_paths(tmp_path: Path, revision: str = "head") -> RuntimePaths:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), revision)
    with closing(sqlite3.connect(paths.business_database)) as connection:
        connection.execute(
            "INSERT INTO monitoring_source_state VALUES (1, '2030-01-15 11:59:00')"
        )
        connection.commit()
    config: RunnableConfig = {
        "configurable": {"thread_id": str(RUN_ID), "checkpoint_ns": ""}
    }
    metadata = cast(CheckpointMetadata, {"source": "input", "step": -1, "parents": {}})
    async with open_checkpoint_store(paths.checkpoint_database) as saver:
        await saver.aput(config, empty_checkpoint(), metadata, {})
    paths.run_artifacts.mkdir(mode=0o700, exist_ok=True)
    nested = paths.run_artifacts / str(RUN_ID) / "nested"
    nested.mkdir(mode=0o700, parents=True)
    (paths.run_artifacts / str(RUN_ID)).chmod(0o700)
    artifact = nested / "trace.json"
    artifact.write_text('{"step": 1}', encoding="utf-8")
    artifact.chmod(0o600)
    return paths


def _destination(tmp_path: Path) -> Path:
    destination = tmp_path / "backups"
    destination.mkdir()
    return destination


def _backups(destination: Path) -> list[str]:
    return sorted(path.name for path in destination.iterdir())


async def test_backup_copies_databases_and_artifacts_consistently(
    tmp_path: Path,
) -> None:
    paths = await _seeded_paths(tmp_path)
    destination = _destination(tmp_path)

    result = backup_runtime_data(_settings(paths), destination, NOW)

    backup = destination / result.name
    assert result.name == "20300115T120000Z"
    assert result.alembic_head == _head()
    assert result.removed == ()
    assert _dump(backup / "incidents.sqlite3") == _dump(paths.business_database)
    assert _dump(backup / "checkpoints.sqlite3") == _dump(paths.checkpoint_database)
    copied = backup / "runs" / str(RUN_ID) / "nested" / "trace.json"
    assert copied.read_text(encoding="utf-8") == '{"step": 1}'
    manifest = json.loads((backup / BACKUP_MANIFEST).read_text(encoding="utf-8"))
    assert manifest["alembicHead"] == _head()
    assert {item["path"] for item in manifest["files"]} == {
        "incidents.sqlite3",
        "checkpoints.sqlite3",
        f"runs/{RUN_ID}/nested/trace.json",
    }
    assert result.size == sum(item["size"] for item in manifest["files"])
    for item in manifest["files"]:
        content = (backup / item["path"]).read_bytes()
        assert item["size"] == len(content)
        assert item["sha256"] == hashlib.sha256(content).hexdigest()
    assert stat.S_IMODE(backup.stat().st_mode) == 0o700
    assert all(
        stat.S_IMODE(path.stat().st_mode) == (0o700 if path.is_dir() else 0o600)
        for path in backup.rglob("*")
    )
    assert not list(backup.glob("*-wal")) and not list(backup.glob("*-shm"))


async def test_a_backup_of_the_running_version_restores_and_migrates_forward(
    tmp_path: Path,
) -> None:
    paths = await _seeded_paths(tmp_path, _previous_revision())
    destination = _destination(tmp_path)
    result = backup_runtime_data(_settings(paths), destination, NOW)
    assert result.alembic_head == _previous_revision()

    restored = RuntimePaths.prepare(tmp_path / "restored")
    for name in ("incidents.sqlite3", "checkpoints.sqlite3"):
        shutil.copy2(destination / result.name / name, restored.root / name)
        (restored.root / name).chmod(0o600)
    command.upgrade(_alembic_config(restored), "head")

    with closing(sqlite3.connect(restored.business_database)) as connection:
        assert connection.execute(
            "SELECT version_num FROM alembic_version"
        ).fetchall() == [(_head(),)]
        assert connection.execute(
            "SELECT singleton_id FROM monitoring_source_state"
        ).fetchall() == [(1,)]


async def test_a_running_runtime_is_never_copied(tmp_path: Path) -> None:
    paths = await _seeded_paths(tmp_path)
    destination = _destination(tmp_path)
    lock = RuntimeLock(paths.runtime_lock)
    lock.acquire()
    try:
        with pytest.raises(RuntimeBackupError) as error:
            backup_runtime_data(_settings(paths), destination, NOW)
    finally:
        lock.release()

    assert error.value.code == "runtime_in_use"
    assert _backups(destination) == []


async def test_data_from_a_newer_release_is_refused_before_any_copy_is_kept(
    tmp_path: Path,
) -> None:
    paths = await _seeded_paths(tmp_path)
    with closing(sqlite3.connect(paths.business_database)) as connection:
        connection.execute("UPDATE alembic_version SET version_num = '20991231_9999'")
        connection.commit()
    destination = _destination(tmp_path)

    with pytest.raises(RuntimeBackupError) as error:
        backup_runtime_data(_settings(paths), destination, NOW)

    assert error.value.code == "schema_unknown"
    assert _backups(destination) == []


async def test_a_lock_that_stops_being_private_after_startup_is_reported_as_invalid_data(
    tmp_path: Path,
) -> None:
    paths = await _seeded_paths(tmp_path)
    paths.runtime_lock.chmod(0o644)
    destination = _destination(tmp_path)

    with pytest.raises(RuntimeBackupError) as error:
        backup_runtime_data(_settings(paths), destination, NOW)

    assert error.value.code == "runtime_data_invalid"
    assert _backups(destination) == []


async def test_a_clock_set_back_never_deletes_the_backup_just_taken(
    tmp_path: Path,
) -> None:
    paths = await _seeded_paths(tmp_path)
    destination = _destination(tmp_path)
    for minutes in (1, 2, 3):
        backup_runtime_data(
            _settings(paths), destination, NOW + timedelta(minutes=minutes)
        )

    result = backup_runtime_data(_settings(paths), destination, NOW)

    assert result.removed == ()
    assert result.name in _backups(destination)
    assert len(_backups(destination)) == 4


async def test_only_the_three_newest_backups_are_kept_and_nothing_else_is_touched(
    tmp_path: Path,
) -> None:
    paths = await _seeded_paths(tmp_path)
    destination = _destination(tmp_path)
    (destination / "operator-notes").mkdir()
    (destination / "20200101T000000Z").mkdir()

    names = [
        backup_runtime_data(
            _settings(paths), destination, NOW + timedelta(minutes=index)
        )
        for index in range(4)
    ]

    assert names[-1].removed == ("20300115T120000Z",)
    assert _backups(destination) == [
        "20200101T000000Z",
        "20300115T120100Z",
        "20300115T120200Z",
        "20300115T120300Z",
        "operator-notes",
    ]


async def test_a_failed_backup_leaves_no_partial_copy_and_keeps_earlier_ones(
    tmp_path: Path,
) -> None:
    paths = await _seeded_paths(tmp_path)
    destination = _destination(tmp_path)
    earlier = backup_runtime_data(_settings(paths), destination, NOW)
    (paths.run_artifacts / str(RUN_ID) / "escape").symlink_to("/etc/passwd")

    with pytest.raises(RuntimeBackupError) as error:
        backup_runtime_data(_settings(paths), destination, NOW + timedelta(hours=1))

    assert error.value.code == "backup_failed"
    assert _backups(destination) == [earlier.name]


async def test_an_interrupted_backup_is_discarded_by_the_next_run(
    tmp_path: Path,
) -> None:
    paths = await _seeded_paths(tmp_path)
    destination = _destination(tmp_path)
    (destination / ".20300115T110000Z.partial").mkdir(mode=0o700)

    result = backup_runtime_data(_settings(paths), destination, NOW)

    assert _backups(destination) == [result.name]


async def test_backup_cli_prints_one_result_line_and_types_its_failures(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    paths = await _seeded_paths(tmp_path)
    destination = _destination(tmp_path)
    monkeypatch.setenv("RUNTIME_DATA_DIR", str(paths.root))

    assert cli.main(["backup", "--destination", str(destination)]) == 0
    output = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert output["alembicHead"] == _head()
    assert output["files"] == 3
    assert (destination / output["backup"] / BACKUP_MANIFEST).is_file()

    assert cli.main(["backup", "--destination", "relative/backups"]) == 1
    failure = json.loads(capsys.readouterr().err)
    assert failure == {"error": {"code": "destination_invalid", "phase": "backup"}}
