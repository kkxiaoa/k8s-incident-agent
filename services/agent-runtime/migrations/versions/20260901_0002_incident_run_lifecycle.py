"""Cut over to source-neutral Incidents and one-to-many Agent Runs."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260901_0002"
down_revision: str | Sequence[str] | None = "20260814_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_BUSINESS_TABLES = (
    "diagnoses",
    "evidence",
    "run_events",
    "agent_runs",
    "incidents",
)


def upgrade() -> None:
    _require_empty_business_tables("Incident/Run lifecycle upgrade")
    _drop_stage_one_tables()
    _create_stage_one_six_tables()


def downgrade() -> None:
    _require_empty_business_tables("Incident/Run lifecycle downgrade")
    _drop_stage_one_six_tables()
    _create_stage_one_tables()


def _require_empty_business_tables(operation: str) -> None:
    connection = op.get_bind()
    for table_name in _BUSINESS_TABLES:
        row_count = connection.execute(
            sa.text(f"SELECT COUNT(*) FROM {table_name}")
        ).scalar_one()
        if row_count != 0:
            raise RuntimeError(
                f"{operation} requires an empty business database; "
                "use the explicit runtime reset-stage-one-data command"
            )


def _drop_stage_one_tables() -> None:
    op.drop_table("diagnoses")
    op.drop_table("evidence")
    op.drop_index("ix_run_events_incident_id_id", table_name="run_events")
    op.drop_table("run_events")
    op.drop_index("ix_agent_runs_status", table_name="agent_runs")
    op.drop_table("agent_runs")
    op.drop_index("ix_incidents_created_at_id", table_name="incidents")
    op.drop_table("incidents")


def _drop_stage_one_six_tables() -> None:
    op.drop_table("diagnoses")
    op.drop_table("evidence")
    op.drop_index("ix_run_events_run_id_id", table_name="run_events")
    op.drop_table("run_events")
    op.drop_index("ix_agent_runs_status", table_name="agent_runs")
    op.drop_index("uq_agent_runs_active_incident_id", table_name="agent_runs")
    op.drop_table("agent_runs")
    op.drop_index("ix_incidents_created_at_id", table_name="incidents")
    op.drop_table("incidents")


def _create_stage_one_six_tables() -> None:
    op.create_table(
        "incidents",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("trigger_source", sa.String(), nullable=False),
        sa.Column("trigger_ref", sa.String(), nullable=True),
        sa.Column("trigger_revision", sa.String(), nullable=True),
        sa.Column("display_name", sa.String(), nullable=False),
        sa.Column("trigger_summary", sa.Text(), nullable=False),
        sa.Column("cluster", sa.String(), nullable=False),
        sa.Column("namespace", sa.String(), nullable=True),
        sa.Column("api_version", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("resource_name", sa.String(), nullable=False),
        sa.Column("status", sa.String(length=21), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('RECEIVED', 'TRIAGING', 'DIAGNOSED', "
            "'INSUFFICIENT_EVIDENCE', 'FAILED')",
            name="ck_incidents_status",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_incidents"),
    )
    op.create_index("ix_incidents_created_at_id", "incidents", ["created_at", "id"])

    op.create_table(
        "agent_runs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("incident_id", sa.String(length=36), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=9), nullable=False),
        sa.Column("model_provider", sa.String(), nullable=False),
        sa.Column("model_id", sa.String(), nullable=False),
        sa.Column("thinking_mode", sa.Boolean(), nullable=False),
        sa.Column("prompt_version", sa.String(), nullable=False),
        sa.Column("max_model_calls", sa.Integer(), nullable=False),
        sa.Column("max_tool_calls", sa.Integer(), nullable=False),
        sa.Column("timeout_seconds", sa.Integer(), nullable=False),
        sa.Column("model_calls", sa.Integer(), nullable=True),
        sa.Column("tool_calls", sa.Integer(), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("error_code", sa.String(), nullable=True),
        sa.Column("error_retryable", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("attempt >= 1", name="ck_agent_runs_attempt"),
        sa.CheckConstraint(
            "status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')",
            name="ck_agent_runs_status",
        ),
        sa.ForeignKeyConstraint(
            ["incident_id"],
            ["incidents.id"],
            name="fk_agent_runs_incident_id_incidents",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_agent_runs"),
        sa.UniqueConstraint(
            "incident_id",
            "attempt",
            name="uq_agent_runs_incident_id_attempt",
        ),
    )
    op.create_index("ix_agent_runs_status", "agent_runs", ["status"])
    op.create_index(
        "uq_agent_runs_active_incident_id",
        "agent_runs",
        ["incident_id"],
        unique=True,
        sqlite_where=sa.text("status IN ('QUEUED', 'RUNNING')"),
    )

    op.create_table(
        "run_events",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("event_key", sa.String(), nullable=False),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload_json", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ["run_id"], ["agent_runs.id"], name="fk_run_events_run_id_agent_runs"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_run_events"),
        sa.UniqueConstraint(
            "run_id", "event_key", name="uq_run_events_run_id_event_key"
        ),
        sqlite_autoincrement=True,
    )
    op.create_index("ix_run_events_run_id_id", "run_events", ["run_id", "id"])
    _create_run_owned_tables()


def _create_stage_one_tables() -> None:
    op.create_table(
        "incidents",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scenario_id", sa.String(), nullable=False),
        sa.Column("scenario_version", sa.Integer(), nullable=False),
        sa.Column("display_name", sa.String(), nullable=False),
        sa.Column("trigger_summary", sa.Text(), nullable=False),
        sa.Column("cluster", sa.String(), nullable=False),
        sa.Column("namespace", sa.String(), nullable=False),
        sa.Column("api_version", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("resource_name", sa.String(), nullable=False),
        sa.Column("status", sa.String(length=21), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('RECEIVED', 'TRIAGING', 'DIAGNOSED', "
            "'INSUFFICIENT_EVIDENCE', 'FAILED')",
            name="ck_incidents_status",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_incidents"),
    )
    op.create_index("ix_incidents_created_at_id", "incidents", ["created_at", "id"])
    op.create_table(
        "agent_runs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("incident_id", sa.String(length=36), nullable=False),
        sa.Column("status", sa.String(length=9), nullable=False),
        sa.Column("model_provider", sa.String(), nullable=False),
        sa.Column("model_id", sa.String(), nullable=False),
        sa.Column("thinking_mode", sa.Boolean(), nullable=False),
        sa.Column("prompt_version", sa.String(), nullable=False),
        sa.Column("max_model_calls", sa.Integer(), nullable=False),
        sa.Column("max_tool_calls", sa.Integer(), nullable=False),
        sa.Column("timeout_seconds", sa.Integer(), nullable=False),
        sa.Column("model_calls", sa.Integer(), nullable=True),
        sa.Column("tool_calls", sa.Integer(), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("error_code", sa.String(), nullable=True),
        sa.Column("error_retryable", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')",
            name="ck_agent_runs_status",
        ),
        sa.ForeignKeyConstraint(
            ["incident_id"],
            ["incidents.id"],
            name="fk_agent_runs_incident_id_incidents",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_agent_runs"),
        sa.UniqueConstraint("incident_id", name="uq_agent_runs_incident_id"),
    )
    op.create_index("ix_agent_runs_status", "agent_runs", ["status"])
    op.create_table(
        "run_events",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("incident_id", sa.String(length=36), nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("event_key", sa.String(), nullable=False),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload_json", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ["incident_id"],
            ["incidents.id"],
            name="fk_run_events_incident_id_incidents",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"], ["agent_runs.id"], name="fk_run_events_run_id_agent_runs"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_run_events"),
        sa.UniqueConstraint(
            "run_id", "event_key", name="uq_run_events_run_id_event_key"
        ),
        sqlite_autoincrement=True,
    )
    op.create_index("ix_run_events_incident_id_id", "run_events", ["incident_id", "id"])
    _create_run_owned_tables()


def _create_run_owned_tables() -> None:
    op.create_table(
        "evidence",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("tool_call_id", sa.String(), nullable=False),
        sa.Column("tool_name", sa.String(), nullable=False),
        sa.Column("evidence_kind", sa.String(), nullable=False),
        sa.Column("target_ref_json", sa.Text(), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload_json", sa.Text(), nullable=False),
        sa.Column("truncated", sa.Boolean(), nullable=False),
        sa.Column("redacted", sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(
            ["run_id"], ["agent_runs.id"], name="fk_evidence_run_id_agent_runs"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_evidence"),
        sa.UniqueConstraint(
            "run_id", "tool_call_id", name="uq_evidence_run_id_tool_call_id"
        ),
    )
    op.create_table(
        "diagnoses",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("outcome", sa.String(length=21), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("root_causes_json", sa.Text(), nullable=False),
        sa.Column("missing_information_json", sa.Text(), nullable=False),
        sa.Column("redacted", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "outcome IN ('diagnosed', 'insufficient_evidence')",
            name="ck_diagnoses_outcome",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"], ["agent_runs.id"], name="fk_diagnoses_run_id_agent_runs"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_diagnoses"),
        sa.UniqueConstraint("run_id", name="uq_diagnoses_run_id"),
    )
