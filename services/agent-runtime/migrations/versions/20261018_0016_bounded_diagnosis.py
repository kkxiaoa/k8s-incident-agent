"""Bind continuous faults and retain immutable diagnosis triggers."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20261018_0016"
down_revision: str | Sequence[str] | None = "20261006_0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("incidents", sa.Column("target_uid", sa.String(), nullable=True))
    op.add_column(
        "incidents", sa.Column("correlation_group", sa.String(), nullable=True)
    )
    op.add_column(
        "incidents", sa.Column("pending_diagnosis_json", sa.Text(), nullable=True)
    )
    op.add_column(
        "alert_signals", sa.Column("association_reason", sa.String(), nullable=True)
    )
    op.add_column(
        "agent_runs", sa.Column("diagnosis_trigger_json", sa.Text(), nullable=True)
    )
    op.create_index(
        "uq_incidents_open_target_group",
        "incidents",
        [
            "cluster",
            "namespace",
            "api_version",
            "kind",
            "resource_name",
            "target_uid",
            "correlation_group",
        ],
        unique=True,
        sqlite_where=sa.text(
            "lifecycle_status = 'OPEN' AND target_uid IS NOT NULL AND correlation_group IS NOT NULL"
        ),
    )


def downgrade() -> None:
    connection = op.get_bind()
    if connection.scalar(
        sa.text(
            "SELECT count(*) FROM incidents WHERE target_uid IS NOT NULL OR pending_diagnosis_json IS NOT NULL"
        )
    ) or connection.scalar(
        sa.text(
            "SELECT count(*) FROM agent_runs WHERE diagnosis_trigger_json IS NOT NULL"
        )
    ):
        raise RuntimeError(
            "Diagnosis triggers require restoring the consistent pre-upgrade backup"
        )
    op.drop_index("uq_incidents_open_target_group", table_name="incidents")
    op.drop_column("agent_runs", "diagnosis_trigger_json")
    op.drop_column("alert_signals", "association_reason")
    op.drop_column("incidents", "pending_diagnosis_json")
    op.drop_column("incidents", "correlation_group")
    op.drop_column("incidents", "target_uid")
