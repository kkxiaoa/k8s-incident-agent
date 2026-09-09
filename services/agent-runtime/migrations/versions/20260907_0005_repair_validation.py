"""Persist repair validation and advance the public event schema."""

from __future__ import annotations

import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260907_0005"
down_revision: str | Sequence[str] | None = "20260902_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OLD_INCIDENT_STATUSES = (
    "'RECEIVED', 'TRIAGING', 'DIAGNOSED', 'INSUFFICIENT_EVIDENCE', 'FAILED'"
)
_REPAIR_INCIDENT_STATUSES = (
    "'RECEIVED', 'TRIAGING', 'DIAGNOSED', 'PATCH_READY', "
    "'DRY_RUN_PASSED', 'WAITING_APPROVAL', 'INSUFFICIENT_EVIDENCE', "
    "'STALE_RESOURCE', 'FAILED'"
)


def upgrade() -> None:
    _validate_event_schema(3)
    _detach_incident_dependents()
    with op.batch_alter_table("incidents") as batch:
        batch.drop_constraint("ck_incidents_status", type_="check")
        batch.create_check_constraint(
            "ck_incidents_status",
            f"status IN ({_REPAIR_INCIDENT_STATUSES})",
        )
    _restore_incident_dependents()
    op.create_table(
        "repair_proposals",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("proposal_json", sa.Text(), nullable=False),
        sa.Column("validation_json", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "schema_version = 1",
            name="ck_repair_proposals_schema_version",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["agent_runs.id"],
            name="fk_repair_proposals_run_id_agent_runs",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_repair_proposals"),
        sa.UniqueConstraint("run_id", name="uq_repair_proposals_run_id"),
    )
    _rewrite_event_schema(3, 4)


def downgrade() -> None:
    connection = op.get_bind()
    proposal_count = connection.execute(
        sa.text("SELECT COUNT(*) FROM repair_proposals")
    ).scalar_one()
    repair_status_count = connection.execute(
        sa.text(
            "SELECT COUNT(*) FROM incidents WHERE status IN "
            "('PATCH_READY', 'DRY_RUN_PASSED', 'WAITING_APPROVAL', "
            "'STALE_RESOURCE')"
        )
    ).scalar_one()
    repair_event_count = connection.execute(
        sa.text(
            "SELECT COUNT(*) FROM run_events WHERE "
            "event_key = 'diagnosis.completed' OR event_type IN "
            "('repair.patch_ready', 'repair.dry_run_passed', "
            "'repair.waiting_approval')"
        )
    ).scalar_one()
    repair_failure_count = connection.execute(
        sa.text(
            "SELECT COUNT(*) FROM agent_runs WHERE error_code IN "
            "('repair_schema_invalid', 'repair_policy_denied', "
            "'repair_diff_invalid', 'stale_resource', "
            "'patch_validator_authentication_failed', "
            "'patch_validator_replay_rejected', "
            "'patch_validator_permission_denied', "
            "'patch_validator_admission_denied', "
            "'patch_validator_timeout', 'patch_validator_upstream_failed', "
            "'patch_validator_contract_invalid')"
        )
    ).scalar_one()
    if any(
        count != 0
        for count in (
            proposal_count,
            repair_status_count,
            repair_event_count,
            repair_failure_count,
        )
    ):
        raise RuntimeError(
            "Repair validation downgrade requires repair projections to be empty"
        )
    _rewrite_event_schema(4, 3)
    op.drop_table("repair_proposals")
    _detach_incident_dependents()
    with op.batch_alter_table("incidents") as batch:
        batch.drop_constraint("ck_incidents_status", type_="check")
        batch.create_check_constraint(
            "ck_incidents_status",
            f"status IN ({_OLD_INCIDENT_STATUSES})",
        )
    _restore_incident_dependents()


def _detach_incident_dependents() -> None:
    connection = op.get_bind()
    if connection.dialect.name != "sqlite":
        return
    for table in (
        "agent_runs",
        "alert_signals",
        "run_events",
        "evidence",
        "diagnoses",
    ):
        connection.exec_driver_sql(
            f'CREATE TEMP TABLE "_task11_{table}" AS SELECT * FROM "{table}"'
        )
    for table in (
        "run_events",
        "evidence",
        "diagnoses",
        "agent_runs",
        "alert_signals",
    ):
        connection.exec_driver_sql(f'DELETE FROM "{table}"')


def _restore_incident_dependents() -> None:
    connection = op.get_bind()
    if connection.dialect.name != "sqlite":
        return
    for table in (
        "agent_runs",
        "alert_signals",
        "run_events",
        "evidence",
        "diagnoses",
    ):
        connection.exec_driver_sql(
            f'INSERT INTO "{table}" SELECT * FROM "_task11_{table}"'
        )
        connection.exec_driver_sql(f'DROP TABLE "_task11_{table}"')


def _rewrite_event_schema(source: int, target: int) -> None:
    connection = op.get_bind()
    rows = connection.execute(
        sa.text("SELECT id, schema_version, payload_json FROM run_events ORDER BY id")
    ).mappings()
    for row in rows:
        if row["schema_version"] != source:
            raise RuntimeError("Run event schema version is inconsistent")
        try:
            payload = json.loads(row["payload_json"])
        except (TypeError, json.JSONDecodeError):
            raise RuntimeError("Run event payload is not valid JSON") from None
        if not isinstance(payload, dict) or payload.get("schemaVersion") != source:
            raise RuntimeError("Run event payload schema version is inconsistent")
        payload["schemaVersion"] = target
        canonical = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        connection.execute(
            sa.text(
                "UPDATE run_events SET schema_version = :schema_version, "
                "payload_json = :payload_json WHERE id = :id"
            ),
            {
                "schema_version": target,
                "payload_json": canonical,
                "id": row["id"],
            },
        )


def _validate_event_schema(source: int) -> None:
    connection = op.get_bind()
    rows = connection.execute(
        sa.text("SELECT schema_version, payload_json FROM run_events ORDER BY id")
    ).mappings()
    for row in rows:
        if row["schema_version"] != source:
            raise RuntimeError("Run event schema version is inconsistent")
        try:
            payload = json.loads(row["payload_json"])
        except (TypeError, json.JSONDecodeError):
            raise RuntimeError("Run event payload is not valid JSON") from None
        if not isinstance(payload, dict) or payload.get("schemaVersion") != source:
            raise RuntimeError("Run event payload schema version is inconsistent")
