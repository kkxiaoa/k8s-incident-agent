"""Persist the public read-rate window."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260915_0012"
down_revision: str | Sequence[str] | None = "20260914_0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "public_demo_budgets",
        sa.Column("category", sa.String(), primary_key=True),
        sa.Column("used", sa.Integer(), nullable=False),
        sa.Column("window_started_at", sa.Integer(), nullable=False),
        sa.CheckConstraint("used >= 0", name="used"),
    )


def downgrade() -> None:
    op.drop_table("public_demo_budgets")
