"""Persist bounded recovery progress without extending the execution deadline."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260914_0010"
down_revision: str | Sequence[str] | None = "20260913_0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_DEPENDENTS = (
    "executions",
    "approvals",
    "run_events",
    "evidence",
    "diagnoses",
    "repair_proposals",
    "alert_signals",
    "agent_runs",
)
_OLD_STATUSES = "'RECEIVED', 'TRIAGING', 'DIAGNOSED', 'PATCH_READY', 'DRY_RUN_PASSED', 'WAITING_APPROVAL', 'APPLYING', 'VERIFYING', 'REJECTED', 'INSUFFICIENT_EVIDENCE', 'STALE_RESOURCE', 'FAILED'"


def _rebuild(*, upgrade: bool) -> None:
    connection = op.get_bind()
    # SQLite table rebuilds require temporarily empty referencing tables. All
    # snapshots, DDL and restoration stay inside the existing migration transaction.
    for table in _DEPENDENTS:
        connection.exec_driver_sql(
            f'CREATE TEMP TABLE "_verify_{table}" AS SELECT * FROM "{table}"'
        )
        connection.exec_driver_sql(f'DELETE FROM "{table}"')
    with op.batch_alter_table("incidents") as batch:
        batch.drop_constraint("ck_incidents_status", type_="check")
        statuses = _OLD_STATUSES + (", 'RESOLVED'" if upgrade else "")
        batch.create_check_constraint("ck_incidents_status", f"status IN ({statuses})")
    with op.batch_alter_table("executions") as batch:
        batch.drop_index("uq_executions_occupied_target")
        if upgrade:
            batch.add_column(
                sa.Column("target_released_at", sa.DateTime(timezone=True))
            )
            batch.create_check_constraint(
                "ck_executions_target_release",
                "target_released_at IS NULL OR (status = 'APPLIED' AND reported_at IS NOT NULL)",
            )
        else:
            batch.drop_constraint("ck_executions_target_release", type_="check")
            batch.drop_column("target_released_at")
        batch.create_index(
            "uq_executions_occupied_target",
            ["cluster", "namespace", "kind", "resource_name"],
            unique=True,
            sqlite_where=sa.text(
                ("target_released_at IS NULL AND " if upgrade else "")
                + "status IN ('PENDING', 'CLAIMED', 'APPLIED', 'UNKNOWN')"
            ),
        )
    for table in reversed(_DEPENDENTS):
        columns = [
            row[1]
            for row in connection.exec_driver_sql(f'PRAGMA table_info("{table}")')
            if row[1] != "target_released_at"
        ]
        names = ", ".join(f'"{column}"' for column in columns)
        connection.exec_driver_sql(
            f'INSERT INTO "{table}" ({names}) SELECT {names} FROM "_verify_{table}"'
        )
        connection.exec_driver_sql(f'DROP TABLE "_verify_{table}"')
    if connection.exec_driver_sql("PRAGMA foreign_key_check").first() is not None:
        raise RuntimeError("Verification migration found invalid references")


def upgrade() -> None:
    _rebuild(upgrade=True)
    op.create_table(
        "verifications",
        sa.Column(
            "execution_id",
            sa.String(),
            sa.ForeignKey("executions.id"),
            primary_key=True,
        ),
        sa.Column("record_json", sa.Text(), nullable=False),
    )


def downgrade() -> None:
    connection = op.get_bind()
    if (
        connection.execute(sa.text("SELECT COUNT(*) FROM verifications")).scalar_one()
        or connection.execute(
            sa.text("SELECT COUNT(*) FROM incidents WHERE status = 'RESOLVED'")
        ).scalar_one()
    ):
        raise RuntimeError("Verification downgrade cannot discard recovery facts")
    op.drop_table("verifications")
    _rebuild(upgrade=False)
