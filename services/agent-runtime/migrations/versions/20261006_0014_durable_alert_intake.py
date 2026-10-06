"""Persist unassigned notifications and events owned directly by an Incident."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20261006_0014"
down_revision: str | Sequence[str] | None = "20260919_0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_SIGNAL_SOURCE_COLUMNS = (
    "trigger_ref",
    "trigger_revision",
    "display_name",
    "trigger_summary",
    "cluster",
    "namespace",
    "api_version",
    "kind",
    "resource_name",
)
_RECEIPT_COLUMNS = (
    "first_received_at",
    "last_received_at",
    "resolved_received_at",
)


def upgrade() -> None:
    op.add_column(
        "incidents",
        sa.Column(
            "lifecycle_status",
            sa.String(6),
            sa.CheckConstraint(
                "lifecycle_status IN ('OPEN', 'CLOSED')",
                name=op.f("ck_incidents_lifecycle_status"),
            ),
            nullable=True,
        ),
    )
    for name in _SIGNAL_SOURCE_COLUMNS:
        op.add_column(
            "alert_signals",
            sa.Column(
                name,
                sa.Text() if name == "trigger_summary" else sa.String(),
                nullable=True,
            ),
        )
    for name in _RECEIPT_COLUMNS:
        op.add_column(
            "alert_signals", sa.Column(name, sa.DateTime(timezone=True), nullable=True)
        )
    connection = op.get_bind()
    # Receipt times were never recorded; business progress is not their clock.
    connection.execute(
        sa.text(
            "UPDATE alert_signals SET "
            + ", ".join(
                f"{name} = (SELECT {name} FROM incidents "
                "WHERE incidents.id = alert_signals.incident_id)"
                for name in _SIGNAL_SOURCE_COLUMNS
            )
        )
    )
    with op.batch_alter_table("alert_signals") as batch:
        batch.drop_constraint("pk_alert_signals", type_="primary")
        batch.drop_constraint("uq_alert_signals_fingerprint_starts_at", type_="unique")
        batch.create_primary_key("pk_alert_signals", ["fingerprint", "starts_at"])
        batch.alter_column("incident_id", existing_type=sa.String(36), nullable=True)
        for name in _SIGNAL_SOURCE_COLUMNS:
            if name != "namespace":
                batch.alter_column(name, existing_type=sa.String(), nullable=False)
        batch.drop_constraint("ck_alert_signals_status_ends_at", type_="check")
        batch.create_check_constraint(
            "ck_alert_signals_status_ends_at",
            "status != 'RESOLVED' OR ends_at IS NOT NULL",
        )
        batch.create_index("ix_alert_signals_incident_id", ["incident_id"])

    sequence = _event_sequence()
    with op.batch_alter_table(
        "run_events", table_kwargs={"sqlite_autoincrement": True}
    ) as batch:
        batch.alter_column("run_id", existing_type=sa.String(36), nullable=True)
        batch.add_column(sa.Column("incident_id", sa.String(36), nullable=True))
        batch.create_foreign_key(
            "fk_run_events_incident_id_incidents", "incidents", ["incident_id"], ["id"]
        )
        batch.create_check_constraint(
            "ck_run_events_owner",
            "(run_id IS NOT NULL AND incident_id IS NULL) OR "
            "(run_id IS NULL AND incident_id IS NOT NULL)",
        )
        batch.create_index("ix_run_events_incident_id_id", ["incident_id", "id"])
    _restore_event_sequence(sequence)


def downgrade() -> None:
    connection = op.get_bind()
    unsafe = connection.execute(
        sa.text(
            "SELECT EXISTS(SELECT 1 FROM incidents WHERE lifecycle_status IS NOT NULL) "
            "OR EXISTS(SELECT 1 FROM run_events WHERE incident_id IS NOT NULL) "
            "OR EXISTS(SELECT 1 FROM alert_signals s LEFT JOIN incidents i "
            "ON i.id = s.incident_id WHERE s.incident_id IS NULL "
            "OR (s.status = 'FIRING' AND s.ends_at IS NOT NULL) OR "
            + " OR ".join(f"s.{name} IS NOT NULL" for name in _RECEIPT_COLUMNS)
            + " OR "
            + " OR ".join(
                f"s.{name} IS NOT i.{name}" for name in _SIGNAL_SOURCE_COLUMNS
            )
            + ") OR EXISTS(SELECT 1 FROM alert_signals GROUP BY incident_id "
            "HAVING COUNT(*) > 1)"
        )
    ).scalar_one()
    if unsafe:
        raise RuntimeError(
            "Durable alert intake downgrade would discard recorded facts; "
            "restore the consistent backup taken before upgrade while Runtime is stopped"
        )

    sequence = _event_sequence()
    with op.batch_alter_table(
        "run_events", table_kwargs={"sqlite_autoincrement": True}
    ) as batch:
        batch.drop_index("ix_run_events_incident_id_id")
        batch.drop_constraint("ck_run_events_owner", type_="check")
        batch.drop_constraint("fk_run_events_incident_id_incidents", type_="foreignkey")
        batch.drop_column("incident_id")
        batch.alter_column("run_id", existing_type=sa.String(36), nullable=False)
    _restore_event_sequence(sequence)
    with op.batch_alter_table("alert_signals") as batch:
        batch.drop_index("ix_alert_signals_incident_id")
        batch.drop_constraint("pk_alert_signals", type_="primary")
        batch.create_primary_key("pk_alert_signals", ["incident_id"])
        batch.alter_column("incident_id", existing_type=sa.String(36), nullable=False)
        batch.create_unique_constraint(
            "uq_alert_signals_fingerprint_starts_at", ["fingerprint", "starts_at"]
        )
        batch.drop_constraint("ck_alert_signals_status_ends_at", type_="check")
        batch.create_check_constraint(
            "ck_alert_signals_status_ends_at",
            "(status = 'FIRING' AND ends_at IS NULL) OR "
            "(status = 'RESOLVED' AND ends_at IS NOT NULL)",
        )
        for name in (*_SIGNAL_SOURCE_COLUMNS, *_RECEIPT_COLUMNS):
            batch.drop_column(name)
    op.drop_column("incidents", "lifecycle_status")


def _event_sequence() -> int:
    return (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT COALESCE(MAX(seq), 0) FROM sqlite_sequence WHERE name = 'run_events'"
            )
        )
        .scalar_one()
    )


def _restore_event_sequence(previous: int) -> None:
    # Rebuilding a table must not reuse IDs of events already removed by retention.
    connection = op.get_bind()
    connection.execute(
        sa.text(
            "UPDATE sqlite_sequence SET seq = MAX(seq, :seq) WHERE name = 'run_events'"
        ),
        {"seq": previous},
    )
    connection.execute(
        sa.text(
            "INSERT INTO sqlite_sequence(name, seq) SELECT 'run_events', :seq "
            "WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name = 'run_events')"
        ),
        {"seq": previous},
    )
