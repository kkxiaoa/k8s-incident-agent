"""Distinguish diagnostic and repair runs without changing retained outcomes."""

from __future__ import annotations

import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260911_0006"
down_revision: str | Sequence[str] | None = "20260907_0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_MODEL_COLUMNS = (
    "model_provider",
    "model_id",
    "thinking_mode",
    "prompt_version",
    "max_model_calls",
    "max_tool_calls",
)
_DEPENDENTS = ("run_events", "evidence", "diagnoses", "repair_proposals")
_KIND_FIELDS = (
    "(kind = 'diagnosis' AND operation IS NULL "
    "AND status != 'WAITING_APPROVAL' "
    "AND model_provider IS NOT NULL AND model_id IS NOT NULL "
    "AND thinking_mode IS NOT NULL AND prompt_version IS NOT NULL "
    "AND max_model_calls IS NOT NULL AND max_tool_calls IS NOT NULL) OR "
    "(kind = 'repair' AND operation IS NOT NULL "
    "AND operation IN ('apply', 'rollback') "
    "AND model_provider IS NULL AND model_id IS NULL "
    "AND thinking_mode IS NULL AND prompt_version IS NULL "
    "AND max_model_calls IS NULL AND max_tool_calls IS NULL "
    "AND model_calls IS NULL AND tool_calls IS NULL "
    "AND input_tokens IS NULL AND output_tokens IS NULL)"
)


def upgrade() -> None:
    _require_drained()
    _validate_events(4)
    _detach_dependents()
    with op.batch_alter_table("agent_runs") as batch:
        batch.alter_column("status", type_=sa.String(16))
        batch.add_column(
            sa.Column("kind", sa.String(), nullable=False, server_default="diagnosis")
        )
        batch.add_column(sa.Column("operation", sa.String(), nullable=True))
        for name in _MODEL_COLUMNS:
            batch.alter_column(name, nullable=True)
        batch.drop_constraint("ck_agent_runs_status", type_="check")
        batch.create_check_constraint(
            "ck_agent_runs_status",
            "status IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED')",
        )
        batch.create_check_constraint(
            "ck_agent_runs_kind", "kind IN ('diagnosis', 'repair')"
        )
        batch.create_check_constraint("ck_agent_runs_kind_fields", _KIND_FIELDS)
        batch.drop_index("uq_agent_runs_active_incident_id")
        batch.create_index(
            "uq_agent_runs_active_incident_id",
            ["incident_id"],
            unique=True,
            sqlite_where=sa.text("status IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL')"),
        )
    _restore_dependents()
    _rewrite_events(5)


def downgrade() -> None:
    connection = op.get_bind()
    if connection.execute(
        sa.text("SELECT COUNT(*) FROM agent_runs WHERE kind != 'diagnosis'")
    ).scalar_one():
        raise RuntimeError("Typed Run downgrade cannot discard repair runs")
    _require_drained()
    _validate_events(5)
    _detach_dependents()
    with op.batch_alter_table("agent_runs") as batch:
        batch.alter_column("status", type_=sa.String(9))
        batch.drop_constraint("ck_agent_runs_kind_fields", type_="check")
        batch.drop_constraint("ck_agent_runs_kind", type_="check")
        batch.drop_constraint("ck_agent_runs_status", type_="check")
        batch.create_check_constraint(
            "ck_agent_runs_status",
            "status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')",
        )
        batch.drop_index("uq_agent_runs_active_incident_id")
        batch.create_index(
            "uq_agent_runs_active_incident_id",
            ["incident_id"],
            unique=True,
            sqlite_where=sa.text("status IN ('QUEUED', 'RUNNING')"),
        )
        for name in _MODEL_COLUMNS:
            batch.alter_column(name, nullable=False)
        batch.drop_column("operation")
        batch.drop_column("kind")
    _restore_dependents()
    _rewrite_events(4)


def _require_drained() -> None:
    active = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT COUNT(*) FROM agent_runs WHERE status IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL')"
            )
        )
        .scalar_one()
    )
    if active:
        raise RuntimeError("Drain active runs before changing the Run schema")


def _validate_events(version: int) -> None:
    rows = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT e.schema_version, e.payload_json, e.run_id, r.incident_id "
                "FROM run_events e JOIN agent_runs r ON r.id = e.run_id ORDER BY e.id"
            )
        )
        .mappings()
    )
    for row in rows:
        try:
            payload = json.loads(row["payload_json"])
        except (TypeError, json.JSONDecodeError):
            raise RuntimeError("Run event payload is not valid JSON") from None
        if (
            row["schema_version"] != version
            or not isinstance(payload, dict)
            or payload.get("schemaVersion") != version
            or payload.get("runId") != row["run_id"]
            or payload.get("incidentId") != row["incident_id"]
            or (version == 5 and payload.get("runKind") != "diagnosis")
            or (version == 4 and "runKind" in payload)
        ):
            raise RuntimeError("Run event schema or ownership is inconsistent")
    if op.get_bind().exec_driver_sql("PRAGMA foreign_key_check").first() is not None:
        raise RuntimeError("Business database contains invalid references")


def _detach_dependents() -> None:
    connection = op.get_bind()
    for table in _DEPENDENTS:
        connection.exec_driver_sql(
            f'CREATE TEMP TABLE "_typed_runs_{table}" AS SELECT * FROM "{table}"'
        )
        connection.exec_driver_sql(f'DELETE FROM "{table}"')


def _restore_dependents() -> None:
    connection = op.get_bind()
    for table in _DEPENDENTS:
        connection.exec_driver_sql(
            f'INSERT INTO "{table}" SELECT * FROM "_typed_runs_{table}"'
        )
        connection.exec_driver_sql(f'DROP TABLE "_typed_runs_{table}"')


def _rewrite_events(version: int) -> None:
    connection = op.get_bind()
    rows = connection.execute(
        sa.text("SELECT id, payload_json FROM run_events ORDER BY id")
    ).mappings()
    for row in rows:
        payload = json.loads(row["payload_json"])
        payload["schemaVersion"] = version
        if version == 5:
            payload["runKind"] = "diagnosis"
        else:
            del payload["runKind"]
        connection.execute(
            sa.text(
                "UPDATE run_events SET schema_version = :version, payload_json = :payload WHERE id = :id"
            ),
            {
                "version": version,
                "payload": json.dumps(
                    payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True
                ),
                "id": row["id"],
            },
        )
