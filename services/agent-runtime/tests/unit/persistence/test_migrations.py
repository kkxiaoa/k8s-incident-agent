import json
import sqlite3
import stat
from pathlib import Path
from typing import Any

import pytest
from alembic import command, op
from alembic.config import Config
from alembic.operations import BatchOperations
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from tests.unit.routes.test_approvals import applied_result, approval_harness
from tests.unit.routes.test_operator import credential as credential

from k8s_incident_agent.execution.contracts import ExecutionReceipt, ExecutionResult
from k8s_incident_agent.persistence.database import (
    DatabaseSchemaNotCurrentError,
    create_business_database,
    require_alembic_head,
)
from k8s_incident_agent.runtime.lock import (
    RuntimeLock,
    RuntimeLockUnavailableError,
)
from k8s_incident_agent.runtime.paths import FilesystemIdentity, RuntimePaths

SERVICE_ROOT = Path(__file__).resolve().parents[3]


@pytest.mark.parametrize("fail_ddl", [False, True])
async def test_rollback_migration_preserves_ledger_and_releases_only_known_apply_failures(
    tmp_path: Path,
    credential: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
    fail_ddl: bool,
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()
        first = await harness.repository.claim_execution(now=harness.now)
        assert first
        await harness.repository.report_execution(
            first.execution_id,
            ExecutionResult(outcome="REJECTED", error="permission_denied"),
            now=harness.now,
        )
        other_incident, body = await harness.another_proposal()
        response = await harness.client.post(
            f"/api/v1/incidents/{other_incident}/approvals",
            json=body,
            headers=harness.headers,
        )
        assert response.status_code == 200
        second = await harness.repository.claim_execution(now=harness.now)
        assert second
        await harness.repository.report_execution(
            second.execution_id,
            ExecutionResult(
                outcome="APPLIED",
                receipt=ExecutionReceipt(
                    uid=second.change.target_uid,
                    resource_version="after-rv",
                    generation=4,
                    before_generation=3,
                ),
            ),
            now=harness.now,
        )
        context = await harness.repository.get_verification_context(
            second.change.run_id
        )
        assert context
        paths = RuntimePaths.prepare(tmp_path / "runtime")
        config = _alembic_config(paths)
        command.downgrade(config, "20260914_0010")
        schema = _schema_snapshot(paths.business_database)
        tables = (*schema["tables"], "alembic_version")
        with sqlite3.connect(paths.business_database) as connection:
            before = {
                table: connection.execute(
                    f'SELECT * FROM "{table}" ORDER BY rowid'
                ).fetchall()
                for table in tables
            }
            assert connection.execute(
                "SELECT target_released_at FROM executions WHERE id = ?",
                (str(first.execution_id),),
            ).fetchone() == (None,)
        original = BatchOperations.create_index

        def interrupted_index(
            self: BatchOperations, name: str, *args: Any, **kwargs: Any
        ) -> Any:
            if name == "uq_executions_occupied_target":
                raise RuntimeError("test rollback DDL interruption")
            return original(self, name, *args, **kwargs)

        if fail_ddl:
            monkeypatch.setattr(BatchOperations, "create_index", interrupted_index)
            with pytest.raises(RuntimeError, match="test rollback DDL interruption"):
                command.upgrade(config, "head")
            assert _schema_snapshot(paths.business_database) == schema
        else:
            command.upgrade(config, "head")
        with sqlite3.connect(paths.business_database) as connection:
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
            for table in tables:
                if not fail_ddl and table in ("executions", "alembic_version"):
                    continue
                assert (
                    connection.execute(
                        "SELECT "
                        + (
                            ",".join(schema["columns"][table])
                            if table != "alembic_version"
                            else "version_num"
                        )
                        + f' FROM "{table}" ORDER BY rowid'
                    ).fetchall()
                    == before[table]
                )
            assert connection.execute(
                "SELECT target_released_at IS NULL FROM executions WHERE id = ?",
                (str(first.execution_id),),
            ).fetchone() == (int(fail_ddl),)
            assert connection.execute(
                "SELECT target_released_at FROM executions WHERE id = ?",
                (str(second.execution_id),),
            ).fetchone() == (None,)
        if not fail_ddl:
            assert (
                await harness.repository.get_verification_context(second.change.run_id)
                == context
            )
            assert await harness.repository.get_incident_detail(
                harness.incident_id, run_id=harness.run_id, event_limit=100
            )


@pytest.mark.parametrize("fail_ddl", [False, True])
async def test_verification_upgrade_preserves_applied_ledger_and_transactional_ddl(
    tmp_path: Path,
    credential: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
    fail_ddl: bool,
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        await harness.approve()
        result = await applied_result(harness)
        detail = await harness.repository.get_incident_detail(
            harness.incident_id, run_id=harness.run_id, event_limit=100
        )
        assert (
            detail is not None
            and detail.repair is not None
            and detail.repair.execution is not None
        )
        await harness.repository.report_execution(
            detail.repair.execution.id, result, now=harness.now
        )
        paths = RuntimePaths.prepare(tmp_path / "runtime")
        config = _alembic_config(paths)
        command.downgrade(config, "20260913_0009")
        schema = _schema_snapshot(paths.business_database)
        with sqlite3.connect(paths.business_database) as connection:
            before = {
                table: connection.execute(
                    f'SELECT * FROM "{table}" ORDER BY rowid'
                ).fetchall()
                for table in schema["tables"]
            }
        original = op.create_table

        def interrupted_create(name: str, *columns: Any, **kwargs: Any) -> Any:
            if name == "verifications":
                raise RuntimeError("test verification DDL interruption")
            return original(name, *columns, **kwargs)

        if fail_ddl:
            monkeypatch.setattr(op, "create_table", interrupted_create)
            with pytest.raises(
                RuntimeError, match="test verification DDL interruption"
            ):
                command.upgrade(config, "head")
            assert _schema_snapshot(paths.business_database) == schema
        else:
            command.upgrade(config, "head")
        with sqlite3.connect(paths.business_database) as connection:
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
            for table, values in before.items():
                names = ",".join(f'"{column}"' for column in schema["columns"][table])
                assert (
                    connection.execute(
                        f'SELECT {names} FROM "{table}" ORDER BY rowid'
                    ).fetchall()
                    == values
                )
        if not fail_ddl:
            context = await harness.repository.get_verification_context(harness.run_id)
            assert context is not None and context.record.started_at == harness.now()
            with pytest.raises(RuntimeError, match="cannot discard recovery facts"):
                command.downgrade(config, "20260913_0009")


@pytest.mark.parametrize("fail_ddl", [False, True])
async def test_approval_upgrade_preserves_nonempty_source_waiting_and_rolls_back_failure(
    tmp_path: Path,
    credential: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
    fail_ddl: bool,
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        paths = RuntimePaths.prepare(tmp_path / "runtime")
        config = _alembic_config(paths)
        command.downgrade(config, "20260913_0008")
        tables = (
            "incidents",
            "agent_runs",
            "repair_proposals",
            "run_events",
            "evidence",
            "operator_sessions",
        )
        schema = _schema_snapshot(paths.business_database)
        with sqlite3.connect(paths.business_database) as connection:
            before = {
                table: connection.execute(
                    f'SELECT * FROM "{table}" ORDER BY rowid'
                ).fetchall()
                for table in tables
            }
        original = op.create_table

        def interrupted_create(table_name: str, *columns: Any, **kwargs: Any) -> Any:
            if table_name == "executions":
                raise RuntimeError("test migration interruption")
            return original(table_name, *columns, **kwargs)

        if fail_ddl:
            monkeypatch.setattr(op, "create_table", interrupted_create)
            with pytest.raises(RuntimeError, match="test migration interruption"):
                command.upgrade(config, "head")
        else:
            command.upgrade(config, "head")
        with sqlite3.connect(paths.business_database) as connection:
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
            assert {
                table: connection.execute(
                    "SELECT "
                    + ",".join(schema["columns"][table])
                    + f' FROM "{table}" ORDER BY rowid'
                ).fetchall()
                for table in tables
            } == before
            assert connection.execute(
                "SELECT version_num FROM alembic_version"
            ).fetchone() == ("20260913_0008" if fail_ddl else "20260919_0013",)
            if fail_ddl:
                assert (
                    connection.execute(
                        "SELECT name FROM sqlite_master WHERE name IN ('approvals', 'executions')"
                    ).fetchall()
                    == []
                )
        if not fail_ddl:
            assert (await harness.approve())["decision"] == "approve"


EXPECTED_COLUMNS = {
    "public_demo_budgets": ("category", "used", "window_started_at"),
    "verifications": ("execution_id", "record_json"),
    "approvals": (
        "id",
        "run_id",
        "proposal_id",
        "proposal_digest",
        "validation_digest",
        "decision",
        "actor",
        "decided_at",
        "expires_at",
    ),
    "executions": (
        "id",
        "approval_id",
        "run_id",
        "cluster",
        "namespace",
        "kind",
        "resource_name",
        "status",
        "start_before",
        "claimed_at",
        "reported_at",
        "result_json",
        "late_result_json",
        "target_released_at",
    ),
    "operator_sessions": (
        "token_hash",
        "operator_ref",
        "created_at",
        "expires_at",
        "revoked",
    ),
    "incidents": (
        "id",
        "trigger_source",
        "trigger_ref",
        "trigger_revision",
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
        "attempt",
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
        "kind",
        "operation",
        "source_run_id",
        "request_source",
        "operator_ref",
        "selection_revision",
        "selection_replica_set_uid",
        "waiting_expires_at",
        "end_reason",
    ),
    "alert_signals": (
        "incident_id",
        "fingerprint",
        "starts_at",
        "status",
        "ends_at",
    ),
    "monitoring_source_state": (
        "singleton_id",
        "last_watchdog_received_at",
    ),
    "run_events": (
        "id",
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
        # SQLite appends an added column, so this one follows created_at.
        "recommendations_json",
    ),
    "repair_proposals": (
        "id",
        "run_id",
        "schema_version",
        "proposal_json",
        "validation_json",
        "created_at",
    ),
}

EXPECTED_FOREIGN_KEYS: dict[str, set[tuple[str, str, str]]] = {
    "public_demo_budgets": set(),
    "verifications": {("execution_id", "executions", "id")},
    "approvals": {
        ("run_id", "agent_runs", "id"),
        ("proposal_id", "repair_proposals", "id"),
    },
    "executions": {("approval_id", "approvals", "id"), ("run_id", "agent_runs", "id")},
    "operator_sessions": set(),
    "incidents": set(),
    "agent_runs": {
        ("incident_id", "incidents", "id"),
        ("source_run_id", "agent_runs", "id"),
    },
    "run_events": {("run_id", "agent_runs", "id")},
    "evidence": {("run_id", "agent_runs", "id")},
    "diagnoses": {("run_id", "agent_runs", "id")},
    "repair_proposals": {("run_id", "agent_runs", "id")},
    "alert_signals": {("incident_id", "incidents", "id")},
    "monitoring_source_state": set(),
}

EXPECTED_UNIQUE_KEYS: dict[str, set[tuple[str, ...]]] = {
    "public_demo_budgets": set(),
    "verifications": set(),
    "approvals": {("run_id",), ("proposal_id",)},
    "executions": {
        ("approval_id",),
        ("run_id",),
        ("cluster", "namespace", "kind", "resource_name"),
    },
    "operator_sessions": set(),
    "incidents": set(),
    "agent_runs": {("incident_id",), ("incident_id", "attempt")},
    "run_events": {("run_id", "event_key")},
    "evidence": {("run_id", "tool_call_id")},
    "diagnoses": {("run_id",)},
    "repair_proposals": {("run_id",)},
    "alert_signals": {("fingerprint", "starts_at")},
    "monitoring_source_state": set(),
}

EXPECTED_QUERY_INDEXES: dict[str, set[tuple[str, ...]]] = {
    "public_demo_budgets": set(),
    "verifications": set(),
    "approvals": set(),
    "executions": set(),
    "operator_sessions": set(),
    "incidents": {("created_at", "id")},
    "agent_runs": {("status",)},
    "run_events": {("run_id", "id")},
    "evidence": set(),
    "diagnoses": set(),
    "repair_proposals": set(),
    "alert_signals": set(),
    "monitoring_source_state": set(),
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
                if int(index[2]) == 1 and str(index[3]) != "pk":
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


def test_migration_round_trip_produces_the_exact_typed_run_schema(
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

    with sqlite3.connect(paths.business_database) as connection:
        connection.execute("INSERT INTO public_demo_budgets VALUES ('reads', 24, 0)")
    command.downgrade(config, "base")
    assert _schema_snapshot(paths.business_database)["tables"] == set()

    command.upgrade(config, "head")
    assert _schema_snapshot(paths.business_database) == first_schema


def test_repair_migration_canonicalizes_retained_public_events(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    config = _alembic_config(paths)
    command.upgrade(config, "20260902_0004")
    with sqlite3.connect(paths.business_database) as connection:
        connection.execute(
            "INSERT INTO incidents "
            "(id, trigger_source, trigger_ref, trigger_revision, display_name, "
            "trigger_summary, cluster, namespace, api_version, kind, resource_name, "
            "status, created_at, updated_at) VALUES "
            "('incident-id', 'scenario', 'scenario', '1', 'display', 'trigger', "
            "'cluster', 'namespace', 'apps/v1', 'Deployment', 'name', 'RECEIVED', "
            "'2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z')"
        )
        connection.execute(
            "INSERT INTO agent_runs "
            "(id, incident_id, attempt, status, model_provider, model_id, "
            "thinking_mode, prompt_version, max_model_calls, max_tool_calls, "
            "timeout_seconds, created_at, updated_at) VALUES "
            "('run-id', 'incident-id', 1, 'QUEUED', 'deepseek', "
            "'deepseek-v4-flash', 0, 'stage2-v1', 8, 6, 180, "
            "'2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z')"
        )
        connection.execute(
            "INSERT INTO run_events "
            "(run_id, event_key, event_type, schema_version, occurred_at, "
            "payload_json) VALUES "
            "('run-id', 'incident.created', 'incident.created', 3, "
            "'2026-09-07T00:00:00Z', "
            '\'{"schemaVersion": 3, "runId": "run-id", '
            '"incidentId": "incident-id"}\')'
        )
        connection.execute(
            "INSERT INTO alert_signals "
            "(incident_id, fingerprint, starts_at, status, ends_at) VALUES "
            "('incident-id', '0123456789abcdef', "
            "'2026-09-07T00:00:00.000000000Z', 'FIRING', NULL)"
        )
        connection.execute(
            "INSERT INTO evidence "
            "(id, run_id, tool_call_id, tool_name, evidence_kind, "
            "target_ref_json, observed_at, payload_json, truncated, redacted) "
            "VALUES ('evidence-id', 'run-id', 'tool-call-id', 'get_workload', "
            "'workload', '{}', '2026-09-07T00:00:00Z', '{}', 0, 0)"
        )
        connection.execute(
            "INSERT INTO diagnoses "
            "(id, run_id, outcome, summary, root_causes_json, "
            "missing_information_json, redacted, created_at) VALUES "
            "('diagnosis-id', 'run-id', 'diagnosed', 'summary', '[]', '[]', 0, "
            "'2026-09-07T00:00:00Z')"
        )

    command.upgrade(config, "20260907_0005")

    with sqlite3.connect(paths.business_database) as connection:
        row = connection.execute(
            "SELECT schema_version, payload_json FROM run_events"
        ).fetchone()
        retained = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in (
                "incidents",
                "agent_runs",
                "alert_signals",
                "run_events",
                "evidence",
                "diagnoses",
            )
        }
    assert row == (
        4,
        json.dumps(
            {
                "incidentId": "incident-id",
                "runId": "run-id",
                "schemaVersion": 4,
            },
            separators=(",", ":"),
            sort_keys=True,
        ),
    )
    assert retained == {
        "incidents": 1,
        "agent_runs": 1,
        "alert_signals": 1,
        "run_events": 1,
        "evidence": 1,
        "diagnoses": 1,
    }


def test_repair_migration_rejects_invalid_event_before_ddl(tmp_path: Path) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    config = _alembic_config(paths)
    command.upgrade(config, "20260902_0004")
    with sqlite3.connect(paths.business_database) as connection:
        connection.execute(
            "INSERT INTO incidents "
            "(id, trigger_source, trigger_ref, trigger_revision, display_name, "
            "trigger_summary, cluster, namespace, api_version, kind, resource_name, "
            "status, created_at, updated_at) VALUES "
            "('incident-id', 'scenario', 'scenario', '1', 'display', 'trigger', "
            "'cluster', 'namespace', 'apps/v1', 'Deployment', 'name', 'RECEIVED', "
            "'2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z')"
        )
        connection.execute(
            "INSERT INTO agent_runs "
            "(id, incident_id, attempt, status, model_provider, model_id, "
            "thinking_mode, prompt_version, max_model_calls, max_tool_calls, "
            "timeout_seconds, created_at, updated_at) VALUES "
            "('run-id', 'incident-id', 1, 'QUEUED', 'deepseek', "
            "'deepseek-v4-flash', 0, 'stage2-v1', 8, 6, 180, "
            "'2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z')"
        )
        connection.execute(
            "INSERT INTO run_events "
            "(run_id, event_key, event_type, schema_version, occurred_at, "
            "payload_json) VALUES "
            "('run-id', 'incident.created', 'incident.created', 3, "
            "'2026-09-07T00:00:00Z', '{\"schemaVersion\":2}')"
        )

    with pytest.raises(RuntimeError, match="payload schema version"):
        command.upgrade(config, "head")

    snapshot = _schema_snapshot(paths.business_database)
    assert "repair_proposals" not in snapshot["tables"]
    with sqlite3.connect(paths.business_database) as connection:
        assert connection.execute(
            "SELECT version_num FROM alembic_version"
        ).fetchone() == ("20260902_0004",)
        incident_sql = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'incidents'"
        ).fetchone()[0]
    assert "WAITING_APPROVAL" not in incident_sql


def test_repair_migration_downgrade_rejects_nonterminal_diagnosis_event(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    config = _alembic_config(paths)
    command.upgrade(config, "20260907_0005")
    with sqlite3.connect(paths.business_database) as connection:
        connection.execute(
            "INSERT INTO incidents "
            "(id, trigger_source, trigger_ref, trigger_revision, display_name, "
            "trigger_summary, cluster, namespace, api_version, kind, resource_name, "
            "status, created_at, updated_at) VALUES "
            "('incident-id', 'scenario', 'scenario', '1', 'display', 'trigger', "
            "'cluster', 'namespace', 'apps/v1', 'Deployment', 'name', 'FAILED', "
            "'2026-09-07T00:00:00Z', '2026-09-07T00:01:00Z')"
        )
        connection.execute(
            "INSERT INTO agent_runs "
            "(id, incident_id, attempt, status, model_provider, model_id, "
            "thinking_mode, prompt_version, max_model_calls, max_tool_calls, "
            "timeout_seconds, model_calls, tool_calls, error_code, error_retryable, "
            "created_at, started_at, completed_at, updated_at) VALUES "
            "('run-id', 'incident-id', 1, 'FAILED', 'deepseek', "
            "'deepseek-v4-flash', 0, 'stage2-repair-v1', 8, 6, 180, 2, 2, "
            "'recovery_consistency_error', 0, '2026-09-07T00:00:00Z', "
            "'2026-09-07T00:00:10Z', '2026-09-07T00:01:00Z', "
            "'2026-09-07T00:01:00Z')"
        )
        connection.execute(
            "INSERT INTO run_events "
            "(run_id, event_key, event_type, schema_version, occurred_at, "
            "payload_json) VALUES "
            "('run-id', 'diagnosis.completed', 'diagnosis.completed', 4, "
            "'2026-09-07T00:00:30Z', "
            '\'{"schemaVersion":4,"runStatus":"RUNNING"}\')'
        )

    with pytest.raises(RuntimeError, match="repair projections to be empty"):
        command.downgrade(config, "20260902_0004")

    with sqlite3.connect(paths.business_database) as connection:
        assert connection.execute(
            "SELECT version_num FROM alembic_version"
        ).fetchone() == ("20260907_0005",)


def test_repair_migration_downgrade_rejects_local_gate_failure(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    config = _alembic_config(paths)
    command.upgrade(config, "20260907_0005")
    with sqlite3.connect(paths.business_database) as connection:
        connection.execute(
            "INSERT INTO incidents "
            "(id, trigger_source, trigger_ref, trigger_revision, display_name, "
            "trigger_summary, cluster, namespace, api_version, kind, resource_name, "
            "status, created_at, updated_at) VALUES "
            "('incident-id', 'scenario', 'scenario', '1', 'display', 'trigger', "
            "'cluster', 'namespace', 'apps/v1', 'Deployment', 'name', 'FAILED', "
            "'2026-09-07T00:00:00Z', '2026-09-07T00:01:00Z')"
        )
        connection.execute(
            "INSERT INTO agent_runs "
            "(id, incident_id, attempt, status, model_provider, model_id, "
            "thinking_mode, prompt_version, max_model_calls, max_tool_calls, "
            "timeout_seconds, error_code, error_retryable, created_at, started_at, "
            "completed_at, updated_at) VALUES "
            "('run-id', 'incident-id', 1, 'FAILED', 'deepseek', "
            "'deepseek-v4-flash', 0, 'stage2-v1', 8, 6, 180, "
            "'repair_policy_denied', 0, '2026-09-07T00:00:00Z', "
            "'2026-09-07T00:00:10Z', '2026-09-07T00:01:00Z', "
            "'2026-09-07T00:01:00Z')"
        )

    with pytest.raises(
        RuntimeError,
        match="repair projections to be empty",
    ):
        command.downgrade(config, "20260902_0004")

    with sqlite3.connect(paths.business_database) as connection:
        assert connection.execute(
            "SELECT version_num FROM alembic_version"
        ).fetchone() == ("20260907_0005",)


def test_stage_one_six_upgrade_rejects_nonempty_stage_one_before_ddl(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    config = _alembic_config(paths)
    command.upgrade(config, "20260814_0001")
    with sqlite3.connect(paths.business_database) as connection:
        connection.execute(
            "INSERT INTO incidents "
            "(id, scenario_id, scenario_version, display_name, trigger_summary, "
            "cluster, namespace, api_version, kind, resource_name, status, "
            "created_at, updated_at) VALUES "
            "('incident-id', 'scenario', 1, 'display', 'trigger', 'cluster', "
            "'namespace', 'apps/v1', 'Deployment', 'name', 'RECEIVED', "
            "'2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')"
        )

    with pytest.raises(RuntimeError, match="requires an empty business database"):
        command.upgrade(config, "head")

    assert (
        "scenario_id"
        in _schema_snapshot(paths.business_database)["columns"]["incidents"]
    )
    with sqlite3.connect(paths.business_database) as connection:
        assert connection.execute(
            "SELECT version_num FROM alembic_version"
        ).fetchone() == ("20260814_0001",)


def test_stage_two_downgrade_rejects_nonempty_head_before_ddl(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    config = _alembic_config(paths)
    command.upgrade(config, "head")
    with sqlite3.connect(paths.business_database) as connection:
        connection.execute(
            "INSERT INTO incidents "
            "(id, trigger_source, trigger_ref, trigger_revision, display_name, "
            "trigger_summary, cluster, namespace, api_version, kind, resource_name, "
            "status, created_at, updated_at) VALUES "
            "('incident-id', 'scenario', 'scenario', '1', 'display', 'trigger', "
            "'cluster', NULL, 'apps/v1', 'Deployment', 'name', 'RECEIVED', "
            "'2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')"
        )

    with pytest.raises(RuntimeError, match="requires an empty business database"):
        command.downgrade(config, "20260814_0001")

    assert (
        "trigger_source"
        in _schema_snapshot(paths.business_database)["columns"]["incidents"]
    )
    with sqlite3.connect(paths.business_database) as connection:
        assert connection.execute(
            "SELECT version_num FROM alembic_version"
        ).fetchone() == ("20260919_0013",)


def test_stage_two_upgrade_rejects_nonempty_stage_one_six_before_ddl(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    config = _alembic_config(paths)
    command.upgrade(config, "20260901_0002")
    with sqlite3.connect(paths.business_database) as connection:
        connection.execute(
            "INSERT INTO incidents "
            "(id, trigger_source, trigger_ref, trigger_revision, display_name, "
            "trigger_summary, cluster, namespace, api_version, kind, resource_name, "
            "status, created_at, updated_at) VALUES "
            "('incident-id', 'scenario', 'scenario', '1', 'display', 'trigger', "
            "'cluster', NULL, 'apps/v1', 'Deployment', 'name', 'RECEIVED', "
            "'2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')"
        )

    with pytest.raises(RuntimeError, match="requires an empty business database"):
        command.upgrade(config, "head")

    snapshot = _schema_snapshot(paths.business_database)
    assert "alert_signals" not in snapshot["tables"]
    with sqlite3.connect(paths.business_database) as connection:
        assert connection.execute(
            "SELECT version_num FROM alembic_version"
        ).fetchone() == ("20260901_0002",)


def test_migration_uses_the_shared_runtime_lock(tmp_path: Path) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    lock = RuntimeLock(paths.runtime_lock)
    lock.acquire()
    try:
        with pytest.raises(RuntimeLockUnavailableError):
            command.upgrade(_alembic_config(paths), "head")
    finally:
        lock.release()


def test_reset_migration_uses_only_the_provided_in_memory_connection(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    root_identity = FilesystemIdentity.from_stat(paths.root.stat())
    lock = RuntimeLock(paths.runtime_lock)
    config = _alembic_config(paths)
    config.attributes["caller_runtime_lock"] = lock
    config.attributes["expected_runtime_root_identity"] = root_identity
    engine = create_engine("sqlite://")

    lock.acquire()
    try:
        with engine.connect() as connection:
            config.attributes["reset_connection"] = connection
            command.upgrade(config, "20260902_0003")
            assert (
                connection.scalar(text("SELECT version_num FROM alembic_version"))
                == "20260902_0003"
            )
            assert all(
                not str(row[2])
                for row in connection.exec_driver_sql("PRAGMA database_list")
            )
    finally:
        engine.dispose()
        lock.release()

    assert not paths.business_database.exists()
    assert not Path(f"{paths.business_database}-wal").exists()
    assert not Path(f"{paths.business_database}-shm").exists()


def test_reset_migration_rejects_a_connection_without_the_caller_lock(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    root_identity = FilesystemIdentity.from_stat(paths.root.stat())
    lock = RuntimeLock(paths.runtime_lock)
    config = _alembic_config(paths)
    config.attributes["caller_runtime_lock"] = lock
    config.attributes["expected_runtime_root_identity"] = root_identity
    engine = create_engine("sqlite://")
    try:
        with engine.connect() as connection:
            config.attributes["reset_connection"] = connection
            with pytest.raises(RuntimeError, match="Runtime lock is not held"):
                command.upgrade(config, "20260902_0003")
            assert (
                connection.scalar(
                    text(
                        "SELECT COUNT(*) FROM sqlite_schema "
                        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
                    )
                )
                == 0
            )
    finally:
        engine.dispose()

    assert not paths.business_database.exists()
    assert not Path(f"{paths.business_database}-wal").exists()
    assert not Path(f"{paths.business_database}-shm").exists()


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
                    "(id, trigger_source, trigger_ref, trigger_revision, display_name, "
                    "trigger_summary, cluster, namespace, api_version, kind, "
                    "resource_name, status, created_at, updated_at) VALUES "
                    "('incident-id', 'scenario', 'image-pull-backoff', '1', "
                    "'Image pull failure', "
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
                "(id, trigger_source, trigger_ref, trigger_revision, display_name, "
                "trigger_summary, cluster, namespace, api_version, kind, "
                "resource_name, status, created_at, updated_at) VALUES "
                "('invalid', 'scenario', 'scenario', '1', 'display', 'trigger', 'cluster', "
                "'namespace', 'apps/v1', 'Deployment', 'name', 'UNKNOWN', "
                "'2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')"
            )

        connection.execute(
            "INSERT INTO incidents "
            "(id, trigger_source, trigger_ref, trigger_revision, display_name, trigger_summary, "
            "cluster, namespace, api_version, kind, resource_name, status, "
            "created_at, updated_at) VALUES "
            "('incident-id', 'scenario', 'scenario', '1', 'display', 'trigger', 'cluster', "
            "'namespace', 'apps/v1', 'Deployment', 'name', 'RECEIVED', "
            "'2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')"
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO agent_runs "
                "(id, incident_id, attempt, status, model_provider, model_id, "
                "thinking_mode, prompt_version, max_model_calls, max_tool_calls, "
                "timeout_seconds, created_at, updated_at) VALUES "
                "('invalid-run', 'incident-id', 1, 'UNKNOWN', 'deepseek', "
                "'deepseek-v4-flash', 0, 'stage1-v1', 8, 6, 180, "
                "'2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')"
            )

        connection.execute(
            "INSERT INTO agent_runs "
            "(id, incident_id, attempt, status, model_provider, model_id, thinking_mode, "
            "prompt_version, max_model_calls, max_tool_calls, timeout_seconds, "
            "created_at, updated_at) VALUES "
            "('run-id', 'incident-id', 1, 'QUEUED', 'deepseek', "
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
