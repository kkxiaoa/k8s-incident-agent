"""Preserve explicit rollback outcomes and target occupancy after inverse failures."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260914_0011"
down_revision: str | Sequence[str] | None = "20260914_0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_DEPENDENTS = (
    "verifications",
    "executions",
    "approvals",
    "run_events",
    "evidence",
    "diagnoses",
    "repair_proposals",
    "alert_signals",
    "agent_runs",
)
_OLD_STATUSES = "'RECEIVED', 'TRIAGING', 'DIAGNOSED', 'PATCH_READY', 'DRY_RUN_PASSED', 'WAITING_APPROVAL', 'APPLYING', 'VERIFYING', 'RESOLVED', 'REJECTED', 'INSUFFICIENT_EVIDENCE', 'STALE_RESOURCE', 'FAILED'"


def _rebuild(*, upgrade: bool) -> None:
    connection = op.get_bind()
    # Keep referencing rows in the same migration transaction while SQLite
    # rebuilds CHECK constraints with foreign-key enforcement still enabled.
    for table in _DEPENDENTS:
        connection.exec_driver_sql(
            f'CREATE TEMP TABLE "_rollback_{table}" AS SELECT * FROM "{table}"'
        )
        connection.exec_driver_sql(f'DELETE FROM "{table}"')
    if upgrade:
        connection.exec_driver_sql("""
            UPDATE _rollback_executions
            SET target_released_at = (
                SELECT completed_at FROM _rollback_agent_runs
                WHERE id = _rollback_executions.run_id
            )
            WHERE status IN ('EXPIRED', 'REJECTED', 'STALE_RESOURCE')
        """)
        if (
            connection.exec_driver_sql("""
            SELECT 1 FROM _rollback_executions
            WHERE status IN ('EXPIRED', 'REJECTED', 'STALE_RESOURCE')
              AND target_released_at IS NULL LIMIT 1
        """).first()
            is not None
        ):
            raise RuntimeError("Rollback migration found incomplete execution facts")
    else:
        connection.exec_driver_sql("""
            UPDATE _rollback_executions SET target_released_at = NULL
            WHERE status IN ('EXPIRED', 'REJECTED', 'STALE_RESOURCE')
        """)
    with op.batch_alter_table("incidents") as batch:
        batch.drop_constraint("ck_incidents_status", type_="check")
        statuses = _OLD_STATUSES + (", 'ROLLED_BACK'" if upgrade else "")
        batch.create_check_constraint("ck_incidents_status", f"status IN ({statuses})")
    with op.batch_alter_table("executions") as batch:
        batch.drop_index("uq_executions_occupied_target")
        batch.drop_constraint("ck_executions_target_release", type_="check")
        batch.create_check_constraint(
            "ck_executions_target_release",
            "target_released_at IS NULL OR status = 'EXPIRED' OR "
            "(status IN ('APPLIED', 'REJECTED', 'STALE_RESOURCE') AND reported_at IS NOT NULL)"
            if upgrade
            else "target_released_at IS NULL OR (status = 'APPLIED' AND reported_at IS NOT NULL)",
        )
        batch.create_index(
            "uq_executions_occupied_target",
            ["cluster", "namespace", "kind", "resource_name"],
            unique=True,
            sqlite_where=sa.text(
                "target_released_at IS NULL"
                + (
                    ""
                    if upgrade
                    else " AND status IN ('PENDING', 'CLAIMED', 'APPLIED', 'UNKNOWN')"
                )
            ),
        )
    for table in reversed(_DEPENDENTS):
        connection.exec_driver_sql(
            f'INSERT INTO "{table}" SELECT * FROM "_rollback_{table}"'
        )
        connection.exec_driver_sql(f'DROP TABLE "_rollback_{table}"')
    if connection.exec_driver_sql("PRAGMA foreign_key_check").first() is not None:
        raise RuntimeError("Rollback migration found invalid references")


def upgrade() -> None:
    _rebuild(upgrade=True)


def downgrade() -> None:
    connection = op.get_bind()
    if (
        connection.exec_driver_sql(
            "SELECT 1 FROM agent_runs WHERE operation = 'rollback' LIMIT 1"
        ).first()
        is not None
        or connection.exec_driver_sql(
            "SELECT 1 FROM incidents WHERE status = 'ROLLED_BACK' LIMIT 1"
        ).first()
        is not None
    ):
        raise RuntimeError("Rollback downgrade cannot discard inverse execution facts")
    _rebuild(upgrade=False)
