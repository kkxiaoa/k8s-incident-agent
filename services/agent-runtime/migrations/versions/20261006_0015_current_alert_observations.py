"""Keep one bounded current alert observation per Kubernetes target."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20261006_0015"
down_revision: str | Sequence[str] | None = "20261006_0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "current_alert_observations",
        sa.Column("cluster", sa.String(), nullable=False),
        sa.Column("namespace", sa.String(), nullable=False),
        sa.Column("api_version", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("resource_name", sa.String(), nullable=False),
        sa.Column("checked_order", sa.Integer(), nullable=False),
        sa.Column("observation_json", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint(
            "cluster", "namespace", "api_version", "kind", "resource_name"
        ),
    )
    op.create_index(
        "ix_current_alert_observations_checked_order",
        "current_alert_observations",
        ["checked_order"],
    )


def downgrade() -> None:
    if op.get_bind().scalar(sa.text("SELECT count(*) FROM current_alert_observations")):
        raise RuntimeError(
            "Current observations require restoring the consistent pre-upgrade backup"
        )
    op.drop_table("current_alert_observations")
