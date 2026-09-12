"""Store revocable operator sessions without credential or token plaintext."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260911_0007"
down_revision: str | Sequence[str] | None = "20260911_0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "operator_sessions",
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("operator_ref", sa.String(), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=False),
        sa.Column("revoked", sa.Boolean(), nullable=False),
        sa.CheckConstraint("length(token_hash) = 64", name="token_hash"),
        sa.CheckConstraint("expires_at > created_at", name="expiry"),
        sa.PrimaryKeyConstraint("token_hash"),
    )


def downgrade() -> None:
    if (
        op.get_bind()
        .execute(sa.text("SELECT COUNT(*) FROM operator_sessions"))
        .scalar_one()
    ):
        raise RuntimeError("Operator session downgrade requires an empty session table")
    op.drop_table("operator_sessions")
