import sqlite3
import stat
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from k8s_incident_agent.persistence.database import (
    DatabaseSchemaNotCurrentError,
    create_business_database,
    require_alembic_head,
)
from k8s_incident_agent.runtime.lock import (
    RuntimeLock,
    RuntimeLockUnavailableError,
)
from k8s_incident_agent.runtime.paths import RuntimePaths

SERVICE_ROOT = Path(__file__).resolve().parents[3]

EXPECTED_COLUMNS = {
    "incidents": (
        "id",
        "scenario_id",
        "scenario_version",
        "display_name",
        "trigger_summary",
        "cluster",
        "namespace",
        "api_version",
        "kind",
        "resource_name",
        "status",
        "created_at",
        "updated_at",
    ),
    "agent_runs": (
        "id",
        "incident_id",
        "status",
        "model_provider",
        "model_id",
        "thinking_mode",
        "prompt_version",
        "max_model_calls",
        "max_tool_calls",
        "timeout_seconds",
        "model_calls",
        "tool_calls",
        "input_tokens",
        "output_tokens",
        "error_code",
        "error_retryable",
        "created_at",
        "started_at",
        "completed_at",
        "updated_at",
    ),
    "run_events": (
        "id",
        "incident_id",
        "run_id",
        "event_key",
        "event_type",
        "schema_version",
        "occurred_at",
        "payload_json",
    ),
    "evidence": (
        "id",
        "run_id",
        "tool_call_id",
        "tool_name",
        "evidence_kind",
        "target_ref_json",
        "observed_at",
        "payload_json",
        "truncated",
        "redacted",
    ),
    "diagnoses": (
        "id",
        "run_id",
        "outcome",
        "summary",
        "root_causes_json",
        "missing_information_json",
        "redacted",
        "created_at",
    ),
}

EXPECTED_FOREIGN_KEYS: dict[str, set[tuple[str, str, str]]] = {
    "incidents": set(),
    "agent_runs": {("incident_id", "incidents", "id")},
    "run_events": {
        ("incident_id", "incidents", "id"),
        ("run_id", "agent_runs", "id"),
    },
    "evidence": {("run_id", "agent_runs", "id")},
    "diagnoses": {("run_id", "agent_runs", "id")},
}

EXPECTED_UNIQUE_KEYS: dict[str, set[tuple[str, ...]]] = {
    "incidents": set(),
    "agent_runs": {("incident_id",)},
    "run_events": {("run_id", "event_key")},
    "evidence": {("run_id", "tool_call_id")},
    "diagnoses": {("run_id",)},
}

EXPECTED_QUERY_INDEXES: dict[str, set[tuple[str, ...]]] = {
    "incidents": {("created_at", "id")},
    "agent_runs": {("status",)},
    "run_events": {("incident_id", "id")},
    "evidence": set(),
    "diagnoses": set(),
}


def _alembic_config(paths: RuntimePaths) -> Config:
    config = Config(str(SERVICE_ROOT / "alembic.ini"))
    config.attributes["runtime_paths"] = paths
    return config


def _index_columns(connection: sqlite3.Connection, index_name: str) -> tuple[str, ...]:
    rows = connection.execute(f'PRAGMA index_info("{index_name}")').fetchall()
    return tuple(str(row[2]) for row in rows)


def _schema_snapshot(database: Path) -> dict[str, Any]:
    with sqlite3.connect(database) as connection:
        tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' "
                "AND name NOT LIKE 'sqlite_%' "
                "AND name != 'alembic_version'"
            )
        }
        columns: dict[str, tuple[str, ...]] = {}
        foreign_keys: dict[str, set[tuple[str, str, str]]] = {}
        unique_keys: dict[str, set[tuple[str, ...]]] = {}
        query_indexes: dict[str, set[tuple[str, ...]]] = {}
        for table in sorted(tables):
            columns[table] = tuple(
                str(row[1])
                for row in connection.execute(f'PRAGMA table_info("{table}")')
            )
            foreign_keys[table] = {
                (str(row[3]), str(row[2]), str(row[4]))
                for row in connection.execute(f'PRAGMA foreign_key_list("{table}")')
            }
            unique_keys[table] = set()
            query_indexes[table] = set()
            for index in connection.execute(f'PRAGMA index_list("{table}")'):
                index_columns = _index_columns(connection, str(index[1]))
                if str(index[3]) == "u":
                    unique_keys[table].add(index_columns)
                elif str(index[3]) == "c":
                    query_indexes[table].add(index_columns)
        return {
            "tables": tables,
            "columns": columns,
            "foreign_keys": foreign_keys,
            "unique_keys": unique_keys,
            "query_indexes": query_indexes,
        }


def test_migration_round_trip_produces_the_exact_stage_one_schema(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    config = _alembic_config(paths)

    command.upgrade(config, "head")
    first_schema = _schema_snapshot(paths.business_database)

    assert first_schema == {
        "tables": set(EXPECTED_COLUMNS),
        "columns": EXPECTED_COLUMNS,
        "foreign_keys": EXPECTED_FOREIGN_KEYS,
        "unique_keys": EXPECTED_UNIQUE_KEYS,
        "query_indexes": EXPECTED_QUERY_INDEXES,
    }
    assert stat.S_IMODE(paths.business_database.stat().st_mode) == 0o600
    assert stat.S_IMODE(paths.runtime_lock.stat().st_mode) == 0o600
    command.check(config)

    command.downgrade(config, "base")
    assert _schema_snapshot(paths.business_database)["tables"] == set()

    command.upgrade(config, "head")
    assert _schema_snapshot(paths.business_database) == first_schema


def test_migration_uses_the_shared_runtime_lock(tmp_path: Path) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    lock = RuntimeLock(paths.runtime_lock)
    lock.acquire()
    try:
        with pytest.raises(RuntimeLockUnavailableError):
            command.upgrade(_alembic_config(paths), "head")
    finally:
        lock.release()


@pytest.mark.asyncio
async def test_business_database_enables_sqlite_safety_and_accepts_head(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")

    database = await create_business_database(paths)
    try:
        await require_alembic_head(database)
        async with database.engine.connect() as connection:
            assert await connection.scalar(text("PRAGMA foreign_keys")) == 1
            assert await connection.scalar(text("PRAGMA journal_mode")) == "wal"

            with pytest.raises(IntegrityError):
                await connection.execute(
                    text(
                        "INSERT INTO evidence "
                        "(id, run_id, tool_call_id, tool_name, evidence_kind, "
                        "target_ref_json, observed_at, payload_json, truncated, redacted) "
                        "VALUES ('evidence-id', 'missing-run', 'tool-call', 'get_pods', "
                        "'pods', '{}', '2026-08-15T00:00:00Z', '{}', 0, 0)"
                    )
                )
            await connection.rollback()

            await connection.execute(
                text(
                    "INSERT INTO incidents "
                    "(id, scenario_id, scenario_version, display_name, "
                    "trigger_summary, cluster, namespace, api_version, kind, "
                    "resource_name, status, created_at, updated_at) VALUES "
                    "('incident-id', 'image-pull-backoff', 1, 'Image pull failure', "
                    "'Deployment unavailable', 'k8s-incident-agent', "
                    "'k8s-incident-scenarios', 'apps/v1', 'Deployment', "
                    "'image-pull-backoff', 'RECEIVED', "
                    "'2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')"
                )
            )
            await connection.commit()

            for artifact in (
                paths.business_database,
                Path(f"{paths.business_database}-wal"),
                Path(f"{paths.business_database}-shm"),
            ):
                assert artifact.is_file()
                assert stat.S_IMODE(artifact.stat().st_mode) == 0o600
    finally:
        await database.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize("schema_state", ["empty", "outdated"])
async def test_business_database_rejects_non_head_schema(
    tmp_path: Path,
    schema_state: str,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / schema_state)
    if schema_state == "outdated":
        with sqlite3.connect(paths.business_database) as connection:
            connection.execute(
                "CREATE TABLE alembic_version "
                "(version_num VARCHAR(32) NOT NULL PRIMARY KEY)"
            )
            connection.execute(
                "INSERT INTO alembic_version (version_num) VALUES ('outdated')"
            )
        paths.business_database.chmod(0o600)

    database = await create_business_database(paths)
    try:
        with pytest.raises(DatabaseSchemaNotCurrentError):
            await require_alembic_head(database)
    finally:
        await database.dispose()


def test_migration_rejects_values_outside_domain_statuses(tmp_path: Path) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    command.upgrade(_alembic_config(paths), "head")

    with sqlite3.connect(paths.business_database) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO incidents "
                "(id, scenario_id, scenario_version, display_name, "
                "trigger_summary, cluster, namespace, api_version, kind, "
                "resource_name, status, created_at, updated_at) VALUES "
                "('invalid', 'scenario', 1, 'display', 'trigger', 'cluster', "
                "'namespace', 'apps/v1', 'Deployment', 'name', 'UNKNOWN', "
                "'2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')"
            )

        connection.execute(
            "INSERT INTO incidents "
            "(id, scenario_id, scenario_version, display_name, trigger_summary, "
            "cluster, namespace, api_version, kind, resource_name, status, "
            "created_at, updated_at) VALUES "
            "('incident-id', 'scenario', 1, 'display', 'trigger', 'cluster', "
            "'namespace', 'apps/v1', 'Deployment', 'name', 'RECEIVED', "
            "'2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')"
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO agent_runs "
                "(id, incident_id, status, model_provider, model_id, "
                "thinking_mode, prompt_version, max_model_calls, max_tool_calls, "
                "timeout_seconds, created_at, updated_at) VALUES "
                "('invalid-run', 'incident-id', 'UNKNOWN', 'deepseek', "
                "'deepseek-v4-flash', 0, 'stage1-v1', 8, 6, 180, "
                "'2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')"
            )

        connection.execute(
            "INSERT INTO agent_runs "
            "(id, incident_id, status, model_provider, model_id, thinking_mode, "
            "prompt_version, max_model_calls, max_tool_calls, timeout_seconds, "
            "created_at, updated_at) VALUES "
            "('run-id', 'incident-id', 'QUEUED', 'deepseek', "
            "'deepseek-v4-flash', 0, 'stage1-v1', 8, 6, 180, "
            "'2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')"
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO diagnoses "
                "(id, run_id, outcome, summary, root_causes_json, "
                "missing_information_json, redacted, created_at) VALUES "
                "('diagnosis-id', 'run-id', 'unknown', 'summary', '[]', '[]', 0, "
                "'2026-08-15T00:00:00Z')"
            )
