"""Persist the latest valid managed monitoring Watchdog arrival."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260902_0004"
down_revision: str | Sequence[str] | None = "20260902_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "monitoring_source_state",
        sa.Column("singleton_id", sa.Integer(), nullable=False),
        sa.Column(
            "last_watchdog_received_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.CheckConstraint(
            "singleton_id = 1",
            name="ck_monitoring_source_state_singleton",
        ),
        sa.PrimaryKeyConstraint(
            "singleton_id",
            name="pk_monitoring_source_state",
        ),
    )


def downgrade() -> None:
    row_count = op.get_bind().execute(
        sa.text("SELECT COUNT(*) FROM monitoring_source_state")
    ).scalar_one()
    if row_count != 0:
        raise RuntimeError(
            "Monitoring health downgrade requires an empty monitoring source state"
        )
    op.drop_table("monitoring_source_state")
