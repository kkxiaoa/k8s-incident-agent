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
    DiagnosisOutcome,
    IncidentStatus,
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


class IncidentRow(Base):
    __tablename__ = "incidents"
    __table_args__ = (
        CheckConstraint(
            "status IN ('RECEIVED', 'TRIAGING', 'DIAGNOSED', "
            "'INSUFFICIENT_EVIDENCE', 'FAILED')",
            name="status",
        ),
        Index("ix_incidents_created_at_id", "created_at", "id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    trigger_source: Mapped[str] = mapped_column(String, nullable=False)
    trigger_ref: Mapped[str | None] = mapped_column(String)
    trigger_revision: Mapped[str | None] = mapped_column(String)
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    trigger_summary: Mapped[str] = mapped_column(Text, nullable=False)
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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )


class RunRow(Base):
    __tablename__ = "agent_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')",
            name="status",
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
            sqlite_where=text("status IN ('QUEUED', 'RUNNING')"),
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
    model_provider: Mapped[str] = mapped_column(String, nullable=False)
    model_id: Mapped[str] = mapped_column(String, nullable=False)
    thinking_mode: Mapped[bool] = mapped_column(Boolean, nullable=False)
    prompt_version: Mapped[str] = mapped_column(String, nullable=False)
    max_model_calls: Mapped[int] = mapped_column(Integer, nullable=False)
    max_tool_calls: Mapped[int] = mapped_column(Integer, nullable=False)
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
        Index("ix_run_events_run_id_id", "run_id", "id"),
        {"sqlite_autoincrement": True},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("agent_runs.id"), nullable=False)
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
    redacted: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
