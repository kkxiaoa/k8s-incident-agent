from __future__ import annotations

from datetime import datetime, timedelta
from typing import Final, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

from k8s_incident_agent.kubernetes.contracts import RecoveryLogs, RecoveryWorkload
from k8s_incident_agent.kubernetes.errors import KubernetesErrorCode
from k8s_incident_agent.monitoring.contracts import RecoveryMonitoring
from k8s_incident_agent.monitoring.errors import MonitoringErrorCode

SAMPLE_INTERVAL_SECONDS: Final = 5
HEALTHY_WINDOW_SECONDS: Final = 60
VERIFICATION_TIMEOUT_SECONDS: Final = 600
MAX_VERIFICATION_SAMPLES: Final = 120
MAX_OBSERVATION_BYTES: Final = 12 * 1024

type VerificationOutcome = Literal[
    "observing",
    "recovered",
    "workload_failed",
    "monitoring_unavailable",
    "insufficient_evidence",
    "target_drift",
    "timeout",
]
type VerificationReason = Literal[
    "rollout_pending",
    "workload_unhealthy",
    "sample_missing",
    "sample_gap",
    "monitoring_unavailable",
    "metrics_missing_or_stale",
    "alerts_active",
    "occurrence_not_resolved",
    "target_drift",
    "deadline_exceeded",
]


class _VerificationContract(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        strict=True,
        hide_input_in_errors=True,
        alias_generator=to_camel,
        populate_by_name=True,
        json_schema_serialization_defaults_required=True,
    )


class VerificationObservation(_VerificationContract):
    observed_at: datetime
    workload: RecoveryWorkload | None
    monitoring: RecoveryMonitoring | None
    watchdog_received_at: datetime | None
    occurrence_resolved: bool | None
    kubernetes_error: KubernetesErrorCode | None = None
    monitoring_error: MonitoringErrorCode | None = None
    logs: RecoveryLogs | None = None


class VerificationRecord(_VerificationContract):
    execution_id: UUID
    started_at: datetime
    deadline_at: datetime
    completed_at: datetime | None = None
    outcome: VerificationOutcome = "observing"
    reason: VerificationReason | None = None
    sample_count: int = Field(default=0, ge=0, le=MAX_VERIFICATION_SAMPLES)
    last_observed_at: datetime | None = None
    healthy_since: datetime | None = None

    @field_validator(
        "started_at", "deadline_at", "completed_at", "last_observed_at", "healthy_since"
    )
    @classmethod
    def require_utc(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.utcoffset() != timedelta(0):
            raise ValueError("Verification timestamps require UTC")
        return value

    @model_validator(mode="after")
    def require_lifecycle(self) -> Self:
        if (
            self.deadline_at
            != self.started_at + timedelta(seconds=VERIFICATION_TIMEOUT_SECONDS)
            or (self.outcome == "observing") != (self.completed_at is None)
            or (self.sample_count == 0) != (self.last_observed_at is None)
            or (
                self.last_observed_at is not None
                and not self.started_at <= self.last_observed_at < self.deadline_at
            )
            or (
                self.healthy_since is not None
                and (
                    self.last_observed_at is None
                    or not self.started_at
                    <= self.healthy_since
                    <= self.last_observed_at
                )
            )
            or (
                self.completed_at is not None
                and self.completed_at < (self.last_observed_at or self.started_at)
            )
            or (self.outcome not in ("observing", "recovered") and self.reason is None)
            or (
                self.outcome == "recovered"
                and (
                    self.sample_count < 13
                    or self.healthy_since is None
                    or self.last_observed_at is None
                    or self.last_observed_at - self.healthy_since
                    < timedelta(seconds=HEALTHY_WINDOW_SECONDS)
                    or self.reason is not None
                )
            )
        ):
            raise ValueError("Verification lifecycle is inconsistent")
        return self


def verification_sample_key(execution_id: UUID, sample_count: int) -> str:
    return f"verification:{execution_id}:sample:{sample_count}"
