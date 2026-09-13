"""Persist repair sources, controlled history selection and waiting deadlines."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260913_0008"
down_revision: str | Sequence[str] | None = "20260911_0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # SQLite supports a nullable REFERENCES column without rebuilding retained rows.
    op.execute(
        "ALTER TABLE agent_runs ADD COLUMN source_run_id VARCHAR "
        "REFERENCES agent_runs(id)"
    )
    for column in (
        sa.Column("request_source", sa.String(), nullable=True),
        sa.Column("operator_ref", sa.String(), nullable=True),
        sa.Column("selection_revision", sa.Integer(), nullable=True),
        sa.Column("selection_replica_set_uid", sa.String(), nullable=True),
        sa.Column("waiting_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("end_reason", sa.String(), nullable=True),
    ):
        op.add_column("agent_runs", column)


def downgrade() -> None:
    if (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT COUNT(*) FROM agent_runs WHERE source_run_id IS NOT NULL "
                "OR request_source IS NOT NULL OR waiting_expires_at IS NOT NULL"
            )
        )
        .scalar_one()
    ):
        raise RuntimeError("Repair preparation downgrade would discard request facts")
    for name in (
        "end_reason",
        "waiting_expires_at",
        "selection_replica_set_uid",
        "selection_revision",
        "operator_ref",
        "request_source",
        "source_run_id",
    ):
        op.drop_column("agent_runs", name)
