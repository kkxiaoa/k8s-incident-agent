from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from itertools import pairwise
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

WATCHDOG_STALE_AFTER = timedelta(minutes=6)


class MetricWindow(StrEnum):
    FIFTEEN_MINUTES = "15m"
    ONE_HOUR = "1h"
    SIX_HOURS = "6h"
    SEVEN_DAYS = "7d"
    FIFTEEN_DAYS = "15d"

    @property
    def duration(self) -> timedelta:
        return {
            MetricWindow.FIFTEEN_MINUTES: timedelta(minutes=15),
            MetricWindow.ONE_HOUR: timedelta(hours=1),
            MetricWindow.SIX_HOURS: timedelta(hours=6),
            MetricWindow.SEVEN_DAYS: timedelta(days=7),
            MetricWindow.FIFTEEN_DAYS: timedelta(days=15),
        }[self]


class MetricQueryState(StrEnum):
    OK = "ok"
    NO_DATA = "no_data"
    STALE = "stale"
    PARTIAL = "partial"
    QUERY_ERROR = "query_error"
    MONITORING_UNAVAILABLE = "monitoring_unavailable"


class MetricRiskDirection(StrEnum):
    HIGHER_IS_WORSE = "higher_is_worse"
    LOWER_IS_WORSE = "lower_is_worse"
    NEUTRAL = "neutral"


class MetricSeriesBinding(StrEnum):
    """How the panel's series are attributed to the Incident target.

    ``target`` aggregates the whole target into one label-free series; ``pod``
    and ``pod_container`` keep one series per Pod (``pod``/``uid``) or per regular
    container (``+container``) as owned at each sampling time, optionally split
    by a ``series`` label such as ``usage``/``limit`` or a probe type.
    """

    TARGET = "target"
    POD = "pod"
    POD_CONTAINER = "pod_container"


class MetricTimeAnchor(StrEnum):
    """Which fixed moment ends the data window; callers never send timestamps."""

    CURRENT = "current"
    OCCURRENCE = "occurrence"
    RUN = "run"


SERIES_LABEL_NAMES = frozenset({"pod", "uid", "container", "series"})
_SERIES_LABELS_BY_BINDING: dict[MetricSeriesBinding, tuple[frozenset[str], ...]] = {
    MetricSeriesBinding.TARGET: (frozenset(),),
    MetricSeriesBinding.POD: (frozenset({"pod", "uid"}),),
    MetricSeriesBinding.POD_CONTAINER: (
        frozenset({"pod", "uid", "container"}),
        frozenset({"pod", "uid", "container", "series"}),
    ),
}
MAX_PANEL_SERIES = 8


class MetricPanelSignalRole(StrEnum):
    TRIGGER = "trigger"
    CONTEXT = "context"


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


class MetricMarkerKind(StrEnum):
    ALERT_FIRING = "alert_firing"
    ALERT_RESOLVED = "alert_resolved"
    RUN_STARTED = "run_started"
    RUN_COMPLETED = "run_completed"


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


class RecoveryMonitoring(_MonitoringContract):
    checked_at: datetime
    chain_healthy: bool
    target_healthy: bool
    oldest_target_sample_at: datetime | None
    oldest_rule_evaluation_at: datetime | None
    active_alerts: list[str] = Field(max_length=8)


class MetricSeries(_MonitoringContract):
    labels: dict[str, str] = Field(max_length=4)
    samples: list[MetricSample] = Field(min_length=1, max_length=512)

    @field_validator("labels")
    @classmethod
    def require_attribution_labels(cls, value: dict[str, str]) -> dict[str, str]:
        for name, label_value in value.items():
            if name not in SERIES_LABEL_NAMES:
                raise ValueError("Metric series carries an unknown label")
            if not label_value or len(label_value) > 253:
                raise ValueError("Metric series label value is invalid")
        return value

    @field_validator("samples")
    @classmethod
    def require_increasing_samples(
        cls, value: list[MetricSample]
    ) -> list[MetricSample]:
        if any(
            current.timestamp <= previous.timestamp
            for previous, current in pairwise(value)
        ):
            raise ValueError("Metric series samples must increase in time")
        return value


class MetricPanelResult(_MonitoringContract):
    panel_id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=160)
    unit: str = Field(min_length=1, max_length=32)
    purpose: str = Field(min_length=1, max_length=320)
    threshold: float | None
    risk_direction: MetricRiskDirection
    series_binding: MetricSeriesBinding
    window: MetricWindow
    anchor: MetricTimeAnchor
    state: MetricQueryState
    queried_at: datetime
    range_start: datetime
    range_end: datetime
    latest_sample_at: datetime | None
    current_value: float | None
    series: list[MetricSeries] = Field(max_length=MAX_PANEL_SERIES)

    @field_validator("threshold")
    @classmethod
    def require_finite_threshold(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("Metric threshold must be finite")
        return value

    @field_validator("queried_at", "range_start", "range_end", "latest_sample_at")
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
        if (
            self.risk_direction is MetricRiskDirection.HIGHER_IS_WORSE
            and self.threshold is None
        ):
            raise ValueError("Higher-is-worse results require a static threshold")
        if (
            self.risk_direction is MetricRiskDirection.NEUTRAL
            and self.threshold is not None
        ):
            raise ValueError("Neutral results cannot carry a risk threshold")
        if (
            self.range_end - self.range_start != self.window.duration
            or self.range_end > self.queried_at
        ):
            raise ValueError("Metric data window does not match the query window")
        has_series = bool(self.series)
        has_latest = self.latest_sample_at is not None
        has_current = self.current_value is not None
        single_series = self.series_binding is MetricSeriesBinding.TARGET
        if self.state in {
            MetricQueryState.NO_DATA,
            MetricQueryState.QUERY_ERROR,
            MetricQueryState.MONITORING_UNAVAILABLE,
        }:
            if has_series or has_latest or has_current:
                raise ValueError("Empty metric states cannot contain samples")
        elif self.state is MetricQueryState.PARTIAL:
            if has_series is not has_latest or (
                has_current is not (has_series and single_series)
            ):
                raise ValueError("Partial metric state must be consistently populated")
        elif not (has_series and has_latest and has_current is single_series):
            raise ValueError("Observed metric states require samples")
        if not has_series:
            return self
        allowed = _SERIES_LABELS_BY_BINDING[self.series_binding]
        identities = [frozenset(item.labels.items()) for item in self.series]
        if (
            len(set(identities)) != len(identities)
            or (single_series and len(self.series) != 1)
            or any(frozenset(item.labels) not in allowed for item in self.series)
        ):
            raise ValueError("Metric series do not match the panel binding")
        if any(
            sample.timestamp < self.range_start or sample.timestamp > self.range_end
            for item in self.series
            for sample in item.samples
        ):
            raise ValueError("Metric samples fall outside the data window")
        latest = max(item.samples[-1].timestamp for item in self.series)
        if self.latest_sample_at != latest:
            raise ValueError("Latest metric timestamp must match the final sample")
        if single_series and self.current_value != self.series[0].samples[-1].value:
            raise ValueError("Current value must match the final target sample")
        return self


class MonitoringPanelReference(_MonitoringContract):
    panel_id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=160)
    unit: str = Field(min_length=1, max_length=32)
    purpose: str = Field(min_length=1, max_length=320)
    series_binding: MetricSeriesBinding
    recommended_window: MetricWindow
    risk_direction: MetricRiskDirection
    signal_role: MetricPanelSignalRole
    threshold_duration: str | None = Field(
        pattern=r"^[1-9][0-9]*(?:ms|s|m|h)$",
    )


class IncidentMonitoringPanels(_MonitoringContract):
    schema_version: Literal[4] = 4
    panels: tuple[MonitoringPanelReference, ...] = Field(max_length=8)


class MetricMarker(_MonitoringContract):
    kind: MetricMarkerKind
    occurred_at: datetime
    run_attempt: int | None = Field(default=None, ge=1)

    @field_validator("occurred_at")
    @classmethod
    def require_utc_occurred_at(cls, value: datetime) -> datetime:
        if value.utcoffset() != timedelta(0):
            raise ValueError("Metric marker timestamp must use UTC")
        return value.astimezone(UTC)

    @model_validator(mode="after")
    def require_marker_shape(self) -> MetricMarker:
        is_run = self.kind in {
            MetricMarkerKind.RUN_STARTED,
            MetricMarkerKind.RUN_COMPLETED,
        }
        if is_run != (self.run_attempt is not None):
            raise ValueError("Metric marker run attempt does not match its kind")
        return self


class IncidentMetricPanel(_MonitoringContract):
    schema_version: Literal[2] = 2
    result: MetricPanelResult
    markers: tuple[MetricMarker, ...] = Field(max_length=102)
    markers_truncated: bool


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


class FiringHealthAlert(_MonitoringContract):
    alert_id: str = Field(min_length=1, max_length=128)
    active_since: datetime

    @field_validator("active_since")
    @classmethod
    def require_utc_active_since(cls, value: datetime) -> datetime:
        if value.utcoffset() != timedelta(0):
            raise ValueError("Health alert time must use UTC")
        return value.astimezone(UTC)


class PrometheusHealthSignals(_MonitoringContract):
    checked_at: datetime
    partial: bool
    kube_state_metrics_available: bool
    alertmanager_available: bool
    watchdog_rule_firing: bool
    health_rules_evaluating: bool
    firing_health_alerts: tuple[FiringHealthAlert, ...] = Field(max_length=16)

    @field_validator("checked_at")
    @classmethod
    def require_utc_checked_at(cls, value: datetime) -> datetime:
        if value.utcoffset() != timedelta(0):
            raise ValueError("Monitoring health check time must use UTC")
        return value.astimezone(UTC)


class MonitoringHealthAlert(_MonitoringContract):
    alert_id: str = Field(min_length=1, max_length=128)
    display_name: str = Field(min_length=1, max_length=160)
    component: Literal["collection", "rules"]
    active_since: datetime

    @field_validator("active_since")
    @classmethod
    def require_utc_active_since(cls, value: datetime) -> datetime:
        if value.utcoffset() != timedelta(0):
            raise ValueError("Health alert time must use UTC")
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
    health_alerts: tuple[MonitoringHealthAlert, ...] = Field(max_length=16)

    @field_validator("checked_at", "watchdog_last_received_at")
    @classmethod
    def require_utc_health_time(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.utcoffset() != timedelta(0):
            raise ValueError("Monitoring health timestamps must use UTC")
        return value.astimezone(UTC)


class MonitoringOverviewCounts(_MonitoringContract):
    total_incidents: int = Field(ge=0)
    firing_alerts: int = Field(ge=0)
    triaging_incidents: int = Field(ge=0)
    waiting_approval_incidents: int = Field(ge=0)


class MonitoringOverviewFamily(_MonitoringContract):
    source_ref: str = Field(min_length=1, max_length=128)
    display_name: str = Field(min_length=1, max_length=160)
    count: int = Field(ge=1)


class MonitoringOverviewSample(_MonitoringContract):
    timestamp: datetime
    incidents_created: int = Field(ge=0)
    alert_conditions_resolved: int = Field(ge=0)
    # Transitions into a terminal status, which a reopened Incident repeats;
    # it is not the remaining work and never means recovered.
    incidents_settled: int = Field(ge=0)

    @field_validator("timestamp")
    @classmethod
    def require_utc_hour(cls, value: datetime) -> datetime:
        if value.utcoffset() != timedelta(0):
            raise ValueError("Monitoring overview timestamps must use UTC")
        normalized = value.astimezone(UTC)
        if normalized != normalized.replace(minute=0, second=0, microsecond=0):
            raise ValueError("Monitoring overview samples must start on an hour")
        return normalized


class MonitoringOverviewSnapshot(_MonitoringContract):
    schema_version: Literal[3] = 3
    window: Literal["24h"] = "24h"
    generated_at: datetime
    counts: MonitoringOverviewCounts
    families: tuple[MonitoringOverviewFamily, ...] = Field(max_length=64)
    samples: tuple[MonitoringOverviewSample, ...] = Field(
        min_length=24,
        max_length=24,
    )

    @field_validator("generated_at")
    @classmethod
    def require_utc_generated_at(cls, value: datetime) -> datetime:
        if value.utcoffset() != timedelta(0):
            raise ValueError("Monitoring overview generation time must use UTC")
        return value.astimezone(UTC)

    @model_validator(mode="after")
    def require_consistent_overview(self) -> MonitoringOverviewSnapshot:
        timestamps = [sample.timestamp for sample in self.samples]
        if any(
            current - previous != timedelta(hours=1)
            for previous, current in pairwise(timestamps)
        ):
            raise ValueError("Monitoring overview samples must be consecutive")
        current_bucket = self.generated_at.replace(minute=0, second=0, microsecond=0)
        if timestamps[-1] != current_bucket:
            raise ValueError(
                "Monitoring overview samples must end at the current UTC hour"
            )
        if sum(family.count for family in self.families) != self.counts.firing_alerts:
            raise ValueError("Monitoring overview families must cover firing alerts")
        return self
