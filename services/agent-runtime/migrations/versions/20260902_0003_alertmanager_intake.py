"""Add the Alertmanager occurrence projection and advance event schema."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260902_0003"
down_revision: str | Sequence[str] | None = "20260901_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_STAGE_ONE_SIX_TABLES = (
    "diagnoses",
    "evidence",
    "run_events",
    "agent_runs",
    "incidents",
)


def upgrade() -> None:
    _require_empty_tables(_STAGE_ONE_SIX_TABLES, "Alertmanager intake upgrade")
    with op.batch_alter_table("incidents") as batch:
        batch.alter_column(
            "trigger_ref",
            existing_type=sa.String(),
            nullable=False,
        )
        batch.alter_column(
            "trigger_revision",
            existing_type=sa.String(),
            nullable=False,
        )
        batch.create_check_constraint(
            "ck_incidents_trigger_source",
            "trigger_source IN ('scenario', 'alertmanager')",
        )
    op.create_table(
        "alert_signals",
        sa.Column("incident_id", sa.String(length=36), nullable=False),
        sa.Column("fingerprint", sa.String(length=16), nullable=False),
        sa.Column("starts_at", sa.String(length=30), nullable=False),
        sa.Column("status", sa.String(length=8), nullable=False),
        sa.Column("ends_at", sa.String(length=30), nullable=True),
        sa.CheckConstraint(
            "status IN ('FIRING', 'RESOLVED')",
            name="ck_alert_signals_status",
        ),
        sa.CheckConstraint(
            "(status = 'FIRING' AND ends_at IS NULL) OR "
            "(status = 'RESOLVED' AND ends_at IS NOT NULL)",
            name="ck_alert_signals_status_ends_at",
        ),
        sa.CheckConstraint(
            "ends_at IS NULL OR ends_at >= starts_at",
            name="ck_alert_signals_ends_at",
        ),
        sa.ForeignKeyConstraint(
            ["incident_id"],
            ["incidents.id"],
            name="fk_alert_signals_incident_id_incidents",
        ),
        sa.PrimaryKeyConstraint("incident_id", name="pk_alert_signals"),
        sa.UniqueConstraint(
            "fingerprint",
            "starts_at",
            name="uq_alert_signals_fingerprint_starts_at",
        ),
    )


def downgrade() -> None:
    _require_empty_tables(
        ("alert_signals", *_STAGE_ONE_SIX_TABLES),
        "Alertmanager intake downgrade",
    )
    op.drop_table("alert_signals")
    with op.batch_alter_table("incidents") as batch:
        batch.drop_constraint(
            "ck_incidents_trigger_source",
            type_="check",
        )
        batch.alter_column(
            "trigger_revision",
            existing_type=sa.String(),
            nullable=True,
        )
        batch.alter_column(
            "trigger_ref",
            existing_type=sa.String(),
            nullable=True,
        )


def _require_empty_tables(table_names: tuple[str, ...], operation: str) -> None:
    connection = op.get_bind()
    for table_name in table_names:
        row_count = connection.execute(
            sa.text(f"SELECT COUNT(*) FROM {table_name}")
        ).scalar_one()
        if row_count != 0:
            raise RuntimeError(
                f"{operation} requires an empty business database; "
                "use the explicit data reset"
            )
