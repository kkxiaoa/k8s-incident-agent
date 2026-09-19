"""Persist Evidence-bound recommendations next to the diagnosis."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260919_0013"
down_revision: str | Sequence[str] | None = "20260915_0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Rows written before this revision stay NULL: those Runs produced no
    # recommendations, and the reader is told so rather than shown an empty list.
    op.add_column(
        "diagnoses",
        sa.Column("recommendations_json", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("diagnoses", "recommendations_json")
