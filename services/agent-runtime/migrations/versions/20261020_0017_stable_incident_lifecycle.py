"""Retain stable health boundaries and the last Incident closure."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20261020_0017"
down_revision: str | Sequence[str] | None = "20261018_0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for name in (
        "healthy_since",
        "last_healthy_at",
        "health_interrupted_at",
        "closed_at",
    ):
        op.add_column(
            "incidents", sa.Column(name, sa.DateTime(timezone=True), nullable=True)
        )
    op.add_column(
        "current_alert_observations",
        sa.Column("signal_revision", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "current_alert_observations",
        sa.Column("reconciled_signal_revision", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    connection = op.get_bind()
    if connection.scalar(
        sa.text("SELECT count(*) FROM incidents WHERE closed_at IS NOT NULL")
    ) or connection.scalar(
        sa.text(
            "SELECT count(*) FROM run_events WHERE event_type IN ('incident.closed', 'incident.reopened')"
        )
    ):
        raise RuntimeError(
            "Incident closures require restoring the consistent pre-upgrade backup"
        )
    op.drop_column("current_alert_observations", "reconciled_signal_revision")
    op.drop_column("current_alert_observations", "signal_revision")
    for name in (
        "closed_at",
        "health_interrupted_at",
        "last_healthy_at",
        "healthy_since",
    ):
        op.drop_column("incidents", name)
