from collections.abc import Sequence
from datetime import datetime
from enum import Enum

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy import (
    Enum as SqlEnum,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from k8s_incident_agent.domain.models import (
    AlertSignalStatus,
    DiagnosisOutcome,
    IncidentLifecycleStatus,
    IncidentStatus,
    RepairOperation,
    RunKind,
    RunStatus,
)

_NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_name)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


def _enum_values(enum_type: type[Enum]) -> Sequence[str]:
    return [str(member.value) for member in enum_type]


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=_NAMING_CONVENTION)


class OperatorSessionRow(Base):
    __tablename__ = "operator_sessions"
    __table_args__ = (
        CheckConstraint("length(token_hash) = 64", name="token_hash"),
        CheckConstraint("expires_at > created_at", name="expiry"),
    )

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    operator_ref: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)
    expires_at: Mapped[int] = mapped_column(Integer, nullable=False)
    revoked: Mapped[bool] = mapped_column(Boolean, nullable=False)


class PublicDemoBudgetRow(Base):
    __tablename__ = "public_demo_budgets"
    __table_args__ = (CheckConstraint("used >= 0", name="used"),)

    category: Mapped[str] = mapped_column(String, primary_key=True)
    used: Mapped[int] = mapped_column(Integer, nullable=False)
    window_started_at: Mapped[int] = mapped_column(Integer, nullable=False)


class IncidentRow(Base):
    __tablename__ = "incidents"
    __table_args__ = (
        CheckConstraint(
            "trigger_source IN ('scenario', 'alertmanager')",
            name="trigger_source",
        ),
        CheckConstraint(
            "status IN ('RECEIVED', 'TRIAGING', 'DIAGNOSED', "
            "'PATCH_READY', 'DRY_RUN_PASSED', 'WAITING_APPROVAL', "
            "'APPLYING', 'VERIFYING', 'RESOLVED', 'REJECTED', "
            "'INSUFFICIENT_EVIDENCE', 'STALE_RESOURCE', 'FAILED')",
            name="status",
        ),
        Index("ix_incidents_created_at_id", "created_at", "id"),
        Index(
            "uq_incidents_open_target_group",
            "cluster",
            "namespace",
            "api_version",
            "kind",
            "resource_name",
            "target_uid",
            "correlation_group",
            unique=True,
            sqlite_where=text(
                "lifecycle_status = 'OPEN' AND target_uid IS NOT NULL AND correlation_group IS NOT NULL"
            ),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    trigger_source: Mapped[str] = mapped_column(String, nullable=False)
    trigger_ref: Mapped[str] = mapped_column(String, nullable=False)
    trigger_revision: Mapped[str] = mapped_column(String, nullable=False)
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    trigger_summary: Mapped[str] = mapped_column(Text, nullable=False)
    target_uid: Mapped[str | None] = mapped_column(String)
    correlation_group: Mapped[str | None] = mapped_column(String)
    pending_diagnosis_json: Mapped[str | None] = mapped_column(Text)
    healthy_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_healthy_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    health_interrupted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cluster: Mapped[str] = mapped_column(String, nullable=False)
    namespace: Mapped[str | None] = mapped_column(String)
    api_version: Mapped[str] = mapped_column(String, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    resource_name: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[IncidentStatus] = mapped_column(
        SqlEnum(
            IncidentStatus,
            name="incident_status",
            native_enum=False,
            create_constraint=False,
            validate_strings=True,
            values_callable=_enum_values,
        ),
        nullable=False,
    )
    lifecycle_status: Mapped[IncidentLifecycleStatus | None] = mapped_column(
        SqlEnum(
            IncidentLifecycleStatus,
            name="lifecycle_status",
            native_enum=False,
            create_constraint=True,
            validate_strings=True,
            values_callable=_enum_values,
        )
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )


class AlertSignalRow(Base):
    __tablename__ = "alert_signals"
    __table_args__ = (
        CheckConstraint(
            "status IN ('FIRING', 'RESOLVED')",
            name="status",
        ),
        CheckConstraint(
            "status != 'RESOLVED' OR ends_at IS NOT NULL",
            name="status_ends_at",
        ),
        CheckConstraint(
            "ends_at IS NULL OR ends_at >= starts_at",
            name="ends_at",
        ),
        Index("ix_alert_signals_incident_id", "incident_id"),
    )

    incident_id: Mapped[str | None] = mapped_column(
        ForeignKey("incidents.id"),
    )
    fingerprint: Mapped[str] = mapped_column(String(16), primary_key=True)
    starts_at: Mapped[str] = mapped_column(String(30), primary_key=True)
    trigger_ref: Mapped[str] = mapped_column(String, nullable=False)
    trigger_revision: Mapped[str] = mapped_column(String, nullable=False)
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    trigger_summary: Mapped[str] = mapped_column(Text, nullable=False)
    cluster: Mapped[str] = mapped_column(String, nullable=False)
    namespace: Mapped[str | None] = mapped_column(String)
    api_version: Mapped[str] = mapped_column(String, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    resource_name: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[AlertSignalStatus] = mapped_column(
        SqlEnum(
            AlertSignalStatus,
            name="alert_signal_status",
            native_enum=False,
            create_constraint=False,
            validate_strings=True,
            values_callable=_enum_values,
        ),
        nullable=False,
    )
    ends_at: Mapped[str | None] = mapped_column(String(30))
    first_received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_received_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    association_reason: Mapped[str | None] = mapped_column(String)


class MonitoringSourceStateRow(Base):
    __tablename__ = "monitoring_source_state"
    __table_args__ = (CheckConstraint("singleton_id = 1", name="singleton"),)

    singleton_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    last_watchdog_received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )


class CurrentAlertObservationRow(Base):
    __tablename__ = "current_alert_observations"
    __table_args__ = (
        Index("ix_current_alert_observations_checked_order", "checked_order"),
    )

    cluster: Mapped[str] = mapped_column(String, primary_key=True)
    namespace: Mapped[str] = mapped_column(String, primary_key=True)
    api_version: Mapped[str] = mapped_column(String, primary_key=True)
    kind: Mapped[str] = mapped_column(String, primary_key=True)
    resource_name: Mapped[str] = mapped_column(String, primary_key=True)
    checked_order: Mapped[int] = mapped_column(Integer, nullable=False)
    signal_revision: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    reconciled_signal_revision: Mapped[int | None] = mapped_column(Integer)
    observation_json: Mapped[str] = mapped_column(Text, nullable=False)


class RunRow(Base):
    __tablename__ = "agent_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED')",
            name="status",
        ),
        CheckConstraint("kind IN ('diagnosis', 'repair')", name="kind"),
        CheckConstraint(
            "(kind = 'diagnosis' AND operation IS NULL "
            "AND status != 'WAITING_APPROVAL' "
            "AND model_provider IS NOT NULL AND model_id IS NOT NULL "
            "AND thinking_mode IS NOT NULL AND prompt_version IS NOT NULL "
            "AND max_model_calls IS NOT NULL AND max_tool_calls IS NOT NULL) OR "
            "(kind = 'repair' AND operation IS NOT NULL "
            "AND operation IN ('apply', 'rollback') "
            "AND model_provider IS NULL AND model_id IS NULL "
            "AND thinking_mode IS NULL AND prompt_version IS NULL "
            "AND max_model_calls IS NULL AND max_tool_calls IS NULL "
            "AND model_calls IS NULL AND tool_calls IS NULL "
            "AND input_tokens IS NULL AND output_tokens IS NULL)",
            name="kind_fields",
        ),
        CheckConstraint("attempt >= 1", name="attempt"),
        UniqueConstraint(
            "incident_id",
            "attempt",
            name="uq_agent_runs_incident_id_attempt",
        ),
        Index(
            "uq_agent_runs_active_incident_id",
            "incident_id",
            unique=True,
            sqlite_where=text("status IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL')"),
        ),
        Index("ix_agent_runs_status", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    incident_id: Mapped[str] = mapped_column(ForeignKey("incidents.id"), nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[RunStatus] = mapped_column(
        SqlEnum(
            RunStatus,
            name="run_status",
            native_enum=False,
            create_constraint=False,
            validate_strings=True,
            values_callable=_enum_values,
        ),
        nullable=False,
    )
    kind: Mapped[RunKind] = mapped_column(
        SqlEnum(
            RunKind,
            native_enum=False,
            validate_strings=True,
            values_callable=_enum_values,
        ),
        nullable=False,
        server_default="diagnosis",
    )
    operation: Mapped[RepairOperation | None] = mapped_column(
        SqlEnum(
            RepairOperation,
            native_enum=False,
            validate_strings=True,
            values_callable=_enum_values,
        ),
    )
    source_run_id: Mapped[str | None] = mapped_column(ForeignKey("agent_runs.id"))
    request_source: Mapped[str | None] = mapped_column(String)
    diagnosis_trigger_json: Mapped[str | None] = mapped_column(Text)
    operator_ref: Mapped[str | None] = mapped_column(String)
    selection_revision: Mapped[int | None] = mapped_column(Integer)
    selection_replica_set_uid: Mapped[str | None] = mapped_column(String)
    waiting_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    end_reason: Mapped[str | None] = mapped_column(String)
    model_provider: Mapped[str | None] = mapped_column(String)
    model_id: Mapped[str | None] = mapped_column(String)
    thinking_mode: Mapped[bool | None] = mapped_column(Boolean)
    prompt_version: Mapped[str | None] = mapped_column(String)
    max_model_calls: Mapped[int | None] = mapped_column(Integer)
    max_tool_calls: Mapped[int | None] = mapped_column(Integer)
    timeout_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    model_calls: Mapped[int | None] = mapped_column(Integer)
    tool_calls: Mapped[int | None] = mapped_column(Integer)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    error_code: Mapped[str | None] = mapped_column(String)
    error_retryable: Mapped[bool | None] = mapped_column(Boolean)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )


class RunEventRow(Base):
    __tablename__ = "run_events"
    __table_args__ = (
        UniqueConstraint("run_id", "event_key", name="uq_run_events_run_id_event_key"),
        CheckConstraint(
            "(run_id IS NOT NULL AND incident_id IS NULL) OR "
            "(run_id IS NULL AND incident_id IS NOT NULL)",
            name="owner",
        ),
        Index("ix_run_events_run_id_id", "run_id", "id"),
        Index("ix_run_events_incident_id_id", "incident_id", "id"),
        {"sqlite_autoincrement": True},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str | None] = mapped_column(ForeignKey("agent_runs.id"))
    incident_id: Mapped[str | None] = mapped_column(ForeignKey("incidents.id"))
    event_key: Mapped[str] = mapped_column(String, nullable=False)
    event_type: Mapped[str] = mapped_column(String, nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    payload_json: Mapped[str] = mapped_column(Text, nullable=False)


class EvidenceRow(Base):
    __tablename__ = "evidence"
    __table_args__ = (
        UniqueConstraint(
            "run_id", "tool_call_id", name="uq_evidence_run_id_tool_call_id"
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("agent_runs.id"), nullable=False)
    tool_call_id: Mapped[str] = mapped_column(String, nullable=False)
    tool_name: Mapped[str] = mapped_column(String, nullable=False)
    evidence_kind: Mapped[str] = mapped_column(String, nullable=False)
    target_ref_json: Mapped[str] = mapped_column(Text, nullable=False)
    observed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    payload_json: Mapped[str] = mapped_column(Text, nullable=False)
    truncated: Mapped[bool] = mapped_column(Boolean, nullable=False)
    redacted: Mapped[bool] = mapped_column(Boolean, nullable=False)


class DiagnosisRow(Base):
    __tablename__ = "diagnoses"
    __table_args__ = (
        CheckConstraint(
            "outcome IN ('diagnosed', 'insufficient_evidence')",
            name="outcome",
        ),
        UniqueConstraint("run_id", name="uq_diagnoses_run_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("agent_runs.id"), nullable=False)
    outcome: Mapped[DiagnosisOutcome] = mapped_column(
        SqlEnum(
            DiagnosisOutcome,
            name="diagnosis_outcome",
            native_enum=False,
            create_constraint=False,
            validate_strings=True,
            values_callable=_enum_values,
        ),
        nullable=False,
    )
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    root_causes_json: Mapped[str] = mapped_column(Text, nullable=False)
    missing_information_json: Mapped[str] = mapped_column(Text, nullable=False)
    # NULL marks a Run recorded before recommendations existed.
    recommendations_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    redacted: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )


class RepairProposalRow(Base):
    __tablename__ = "repair_proposals"
    __table_args__ = (
        CheckConstraint("schema_version = 1", name="schema_version"),
        UniqueConstraint("run_id", name="uq_repair_proposals_run_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("agent_runs.id"), nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    proposal_json: Mapped[str] = mapped_column(Text, nullable=False)
    validation_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )


class ApprovalRow(Base):
    __tablename__ = "approvals"
    __table_args__ = (
        UniqueConstraint("run_id", name="uq_approvals_run_id"),
        UniqueConstraint("proposal_id", name="uq_approvals_proposal_id"),
        CheckConstraint("decision IN ('approve', 'reject')", name="decision"),
        CheckConstraint("expires_at > decided_at", name="expiry"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("agent_runs.id"), nullable=False)
    proposal_id: Mapped[str] = mapped_column(
        ForeignKey("repair_proposals.id"), nullable=False
    )
    proposal_digest: Mapped[str] = mapped_column(String(71), nullable=False)
    validation_digest: Mapped[str] = mapped_column(String(71), nullable=False)
    decision: Mapped[str] = mapped_column(String, nullable=False)
    actor: Mapped[str] = mapped_column(String, nullable=False)
    decided_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )


class ExecutionRow(Base):
    __tablename__ = "executions"
    __table_args__ = (
        UniqueConstraint("approval_id", name="uq_executions_approval_id"),
        UniqueConstraint("run_id", name="uq_executions_run_id"),
        CheckConstraint(
            "status IN ('PENDING', 'CLAIMED', 'APPLIED', 'EXPIRED', "
            "'STALE_RESOURCE', 'REJECTED', 'UNKNOWN')",
            name="status",
        ),
        CheckConstraint(
            "target_released_at IS NULL OR status = 'EXPIRED' OR "
            "(status IN ('APPLIED', 'REJECTED', 'STALE_RESOURCE') AND reported_at IS NOT NULL)",
            name="target_release",
        ),
        Index(
            "uq_executions_occupied_target",
            "cluster",
            "namespace",
            "kind",
            "resource_name",
            unique=True,
            sqlite_where=text("target_released_at IS NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    approval_id: Mapped[str] = mapped_column(ForeignKey("approvals.id"), nullable=False)
    run_id: Mapped[str] = mapped_column(ForeignKey("agent_runs.id"), nullable=False)
    cluster: Mapped[str] = mapped_column(String, nullable=False)
    namespace: Mapped[str] = mapped_column(String, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    resource_name: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False)
    start_before: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    result_json: Mapped[str | None] = mapped_column(Text)
    late_result_json: Mapped[str | None] = mapped_column(Text)
    target_released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class VerificationRow(Base):
    __tablename__ = "verifications"

    execution_id: Mapped[str] = mapped_column(
        ForeignKey("executions.id"), primary_key=True
    )
    record_json: Mapped[str] = mapped_column(Text, nullable=False)
