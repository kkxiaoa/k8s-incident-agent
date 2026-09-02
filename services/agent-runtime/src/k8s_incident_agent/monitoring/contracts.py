from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel


class MetricWindow(StrEnum):
    FIFTEEN_MINUTES = "15m"
    ONE_HOUR = "1h"
    SIX_HOURS = "6h"


class MetricQueryState(StrEnum):
    OK = "ok"
    NO_DATA = "no_data"
    STALE = "stale"
    PARTIAL = "partial"
    QUERY_ERROR = "query_error"
    MONITORING_UNAVAILABLE = "monitoring_unavailable"


class MonitoringComponentState(StrEnum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNAVAILABLE = "unavailable"
    STALE = "stale"
    UNKNOWN = "unknown"


class MonitoringOverallState(StrEnum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNAVAILABLE = "unavailable"


class _MonitoringContract(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        serialize_by_alias=True,
        strict=True,
    )


class MetricSample(_MonitoringContract):
    timestamp: datetime
    value: float

    @field_validator("timestamp")
    @classmethod
    def require_utc_timestamp(cls, value: datetime) -> datetime:
        if value.utcoffset() != timedelta(0):
            raise ValueError("Metric sample timestamp must use UTC")
        return value.astimezone(UTC)

    @field_validator("value")
    @classmethod
    def require_finite_value(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("Metric sample value must be finite")
        return value


class MetricPanelResult(_MonitoringContract):
    panel_id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=160)
    unit: str = Field(min_length=1, max_length=32)
    threshold: float
    window: MetricWindow
    state: MetricQueryState
    queried_at: datetime
    latest_sample_at: datetime | None
    current_value: float | None
    samples: list[MetricSample] = Field(max_length=512)

    @field_validator("threshold")
    @classmethod
    def require_finite_threshold(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("Metric threshold must be finite")
        return value

    @field_validator("queried_at", "latest_sample_at")
    @classmethod
    def require_utc_datetime(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.utcoffset() != timedelta(0):
            raise ValueError("Metric result timestamps must use UTC")
        return value.astimezone(UTC)

    @field_validator("current_value")
    @classmethod
    def require_finite_current_value(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("Metric current value must be finite")
        return value

    @model_validator(mode="after")
    def require_state_shape(self) -> MetricPanelResult:
        has_samples = bool(self.samples)
        has_latest = self.latest_sample_at is not None
        has_current = self.current_value is not None
        if self.state in {
            MetricQueryState.NO_DATA,
            MetricQueryState.QUERY_ERROR,
            MetricQueryState.MONITORING_UNAVAILABLE,
        }:
            if has_samples or has_latest or has_current:
                raise ValueError("Empty metric states cannot contain samples")
        elif self.state is MetricQueryState.PARTIAL:
            if len({has_samples, has_latest, has_current}) != 1:
                raise ValueError("Partial metric state must be consistently populated")
        elif not (has_samples and has_latest and has_current):
            raise ValueError("Observed metric states require samples")
        if self.samples and self.latest_sample_at != self.samples[-1].timestamp:
            raise ValueError("Latest metric timestamp must match the final sample")
        return self


class MetricTargetRef(_MonitoringContract):
    cluster: str = Field(min_length=1)
    namespace: str = Field(min_length=1)
    api_version: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    name: str = Field(min_length=1)


class MetricPanelPayload(_MonitoringContract):
    result: MetricPanelResult


class PrometheusObservation(_MonitoringContract):
    evidence_kind: Literal["metrics"]
    target_ref: MetricTargetRef
    observed_at: datetime
    payload: MetricPanelPayload
    truncated: Literal[False] = False
    redacted: Literal[False] = False

    @field_validator("observed_at")
    @classmethod
    def require_utc_observed_at(cls, value: datetime) -> datetime:
        if value.utcoffset() != timedelta(0):
            raise ValueError("Metric observation time must use UTC")
        return value.astimezone(UTC)


class PrometheusHealthSignals(_MonitoringContract):
    checked_at: datetime
    partial: bool
    kube_state_metrics_available: bool
    alertmanager_available: bool
    watchdog_rule_firing: bool

    @field_validator("checked_at")
    @classmethod
    def require_utc_checked_at(cls, value: datetime) -> datetime:
        if value.utcoffset() != timedelta(0):
            raise ValueError("Monitoring health check time must use UTC")
        return value.astimezone(UTC)


class MonitoringHealthSnapshot(_MonitoringContract):
    state: MonitoringOverallState
    checked_at: datetime
    prometheus: MonitoringComponentState
    kube_state_metrics: MonitoringComponentState
    rule_evaluation: MonitoringComponentState
    alertmanager: MonitoringComponentState
    notification: MonitoringComponentState
    watchdog_last_received_at: datetime | None

    @field_validator("checked_at", "watchdog_last_received_at")
    @classmethod
    def require_utc_health_time(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.utcoffset() != timedelta(0):
            raise ValueError("Monitoring health timestamps must use UTC")
        return value.astimezone(UTC)
