"""Persist exact decisions and single-claim execution facts."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260913_0009"
down_revision: str | Sequence[str] | None = "20260913_0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_DEPENDENTS = (
    "run_events",
    "evidence",
    "diagnoses",
    "repair_proposals",
    "alert_signals",
    "agent_runs",
)
_OLD_STATUSES = (
    "'RECEIVED', 'TRIAGING', 'DIAGNOSED', 'PATCH_READY', 'DRY_RUN_PASSED', "
    "'WAITING_APPROVAL', 'INSUFFICIENT_EVIDENCE', 'STALE_RESOURCE', 'FAILED'"
)


def _incident_status_constraint(statuses: str) -> None:
    connection = op.get_bind()
    # Empty dependents within the migration transaction before rebuilding their
    # referenced table. Restoring all Runs in one INSERT preserves source self-FKs.
    for table in _DEPENDENTS:
        connection.exec_driver_sql(
            f'CREATE TEMP TABLE "_approval_{table}" AS SELECT * FROM "{table}"'
        )
        connection.exec_driver_sql(f'DELETE FROM "{table}"')
    with op.batch_alter_table("incidents") as batch:
        batch.drop_constraint("ck_incidents_status", type_="check")
        batch.create_check_constraint("ck_incidents_status", f"status IN ({statuses})")
    for table in reversed(_DEPENDENTS):
        connection.exec_driver_sql(
            f'INSERT INTO "{table}" SELECT * FROM "_approval_{table}"'
        )
        connection.exec_driver_sql(f'DROP TABLE "_approval_{table}"')
    if connection.exec_driver_sql("PRAGMA foreign_key_check").first() is not None:
        raise RuntimeError("Approval migration found invalid references")


def upgrade() -> None:
    _incident_status_constraint(_OLD_STATUSES + ", 'APPLYING', 'VERIFYING', 'REJECTED'")
    op.create_table(
        "approvals",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "run_id", sa.String(36), sa.ForeignKey("agent_runs.id"), nullable=False
        ),
        sa.Column(
            "proposal_id",
            sa.String(36),
            sa.ForeignKey("repair_proposals.id"),
            nullable=False,
        ),
        sa.Column("proposal_digest", sa.String(71), nullable=False),
        sa.Column("validation_digest", sa.String(71), nullable=False),
        sa.Column("decision", sa.String(), nullable=False),
        sa.Column("actor", sa.String(), nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("run_id", name="uq_approvals_run_id"),
        sa.UniqueConstraint("proposal_id", name="uq_approvals_proposal_id"),
        sa.CheckConstraint("decision IN ('approve', 'reject')", name="decision"),
        sa.CheckConstraint("expires_at > decided_at", name="expiry"),
    )
    op.create_table(
        "executions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "approval_id", sa.String(36), sa.ForeignKey("approvals.id"), nullable=False
        ),
        sa.Column(
            "run_id", sa.String(36), sa.ForeignKey("agent_runs.id"), nullable=False
        ),
        sa.Column("cluster", sa.String(), nullable=False),
        sa.Column("namespace", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("resource_name", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("start_before", sa.DateTime(timezone=True), nullable=False),
        sa.Column("claimed_at", sa.DateTime(timezone=True)),
        sa.Column("reported_at", sa.DateTime(timezone=True)),
        sa.Column("result_json", sa.Text()),
        sa.Column("late_result_json", sa.Text()),
        sa.UniqueConstraint("approval_id", name="uq_executions_approval_id"),
        sa.UniqueConstraint("run_id", name="uq_executions_run_id"),
        sa.CheckConstraint(
            "status IN ('PENDING', 'CLAIMED', 'APPLIED', 'EXPIRED', "
            "'STALE_RESOURCE', 'REJECTED', 'UNKNOWN')",
            name="status",
        ),
    )
    op.create_index(
        "uq_executions_occupied_target",
        "executions",
        ["cluster", "namespace", "kind", "resource_name"],
        unique=True,
        sqlite_where=sa.text("status IN ('PENDING', 'CLAIMED', 'APPLIED', 'UNKNOWN')"),
    )


def downgrade() -> None:
    if op.get_bind().execute(sa.text("SELECT COUNT(*) FROM approvals")).scalar_one():
        raise RuntimeError("Approval downgrade cannot discard decisions")
    op.drop_table("executions")
    op.drop_table("approvals")
    _incident_status_constraint(_OLD_STATUSES)
