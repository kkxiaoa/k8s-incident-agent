from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

from k8s_incident_agent.domain.contracts import KubernetesTarget

DiagnosticTarget = KubernetesTarget
type ServiceNetworkState = Literal[
    "selector_mismatch",
    "endpoints_unready",
    "endpoints_ready",
    "monitoring_not_enabled",
    "external_name",
    "headless",
    "publish_not_ready",
    "no_selector",
    "no_candidates",
]


class _EvidenceContract(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        populate_by_name=True,
        strict=True,
    )


class TargetRef(_EvidenceContract):
    api_version: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    namespace: str = Field(min_length=1)
    name: str = Field(min_length=1)
    uid: str = Field(min_length=1)


class Selector(_EvidenceContract):
    match_labels: dict[str, str]


class ReplicaSummary(_EvidenceContract):
    desired: int = Field(ge=0)
    updated: int = Field(ge=0)
    ready: int = Field(ge=0)
    available: int = Field(ge=0)


class ConditionSummary(_EvidenceContract):
    type: str = Field(min_length=1)
    status: str = Field(min_length=1)
    reason: str | None


class ExecProbeHandler(_EvidenceContract):
    type: Literal["exec"]


class GrpcProbeHandler(_EvidenceContract):
    type: Literal["grpc"]
    port: int = Field(ge=1, le=65535)


class HttpGetProbeHandler(_EvidenceContract):
    type: Literal["http_get"]
    path: str = Field(min_length=1)
    port: int | str
    scheme: Literal["HTTP", "HTTPS"]


class TcpSocketProbeHandler(_EvidenceContract):
    type: Literal["tcp_socket"]
    port: int | str


type ProbeHandler = Annotated[
    ExecProbeHandler | GrpcProbeHandler | HttpGetProbeHandler | TcpSocketProbeHandler,
    Field(discriminator="type"),
]


class ContainerProbe(_EvidenceContract):
    probe_kind: Literal["startup", "readiness", "liveness"]
    handler: ProbeHandler
    initial_delay_seconds: int = Field(ge=0)
    period_seconds: int = Field(ge=1)
    timeout_seconds: int = Field(ge=1)
    success_threshold: int = Field(ge=1)
    failure_threshold: int = Field(ge=1)


class WorkloadContainer(_EvidenceContract):
    name: str = Field(min_length=1)
    image: str
    image_pull_policy: str = Field(min_length=1)
    command: list[str]
    args: list[str]
    probes: list[ContainerProbe] = Field(default_factory=list[ContainerProbe])


class WorkloadDetail(_EvidenceContract):
    resource_version: str = Field(min_length=1)
    generation: int | None = Field(ge=0)
    observed_generation: int | None = Field(ge=0)
    replicas: ReplicaSummary
    selector: Selector
    containers: list[WorkloadContainer]
    conditions: list[ConditionSummary]


class WorkloadPayload(_EvidenceContract):
    workload: WorkloadDetail


class SourceWorkload(_EvidenceContract):
    resource_version: str = Field(min_length=1)
    selector: Selector


class OwnerSummary(_EvidenceContract):
    api_version: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    name: str = Field(min_length=1)
    uid: str = Field(min_length=1)
    controller: bool


class ContainerStateSummary(_EvidenceContract):
    status: Literal["waiting", "running", "terminated", "unknown"]
    reason: str | None
    message: str | None


class PodContainer(_EvidenceContract):
    name: str = Field(min_length=1)
    image: str
    image_id: str | None
    restart_count: int = Field(ge=0)
    state: ContainerStateSummary


class PodSummary(_EvidenceContract):
    api_version: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    namespace: str = Field(min_length=1)
    name: str = Field(min_length=1)
    uid: str = Field(min_length=1)
    resource_version: str = Field(min_length=1)
    owner: OwnerSummary
    phase: str | None
    conditions: list[ConditionSummary]
    containers: list[PodContainer]


class PodsPayload(_EvidenceContract):
    source_workload: SourceWorkload
    pods: list[PodSummary]


class RegardingSummary(_EvidenceContract):
    api_version: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    namespace: str = Field(min_length=1)
    name: str = Field(min_length=1)
    uid: str = Field(min_length=1)


class EventSummary(_EvidenceContract):
    api_version: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    namespace: str = Field(min_length=1)
    name: str = Field(min_length=1)
    uid: str = Field(min_length=1)
    resource_version: str = Field(min_length=1)
    regarding: RegardingSummary
    type: str | None
    reason: str | None
    action: str | None
    note: str | None
    event_time: str | None
    series_count: int = Field(ge=1)
    reporting_controller: str | None


class EventsPayload(_EvidenceContract):
    source_workload: SourceWorkload
    associated_replica_set_count: int = Field(ge=0)
    associated_pod_count: int = Field(ge=0)
    events: list[EventSummary]


class ContainerLogLine(_EvidenceContract):
    timestamp: datetime
    message: str

    @field_validator("timestamp")
    @classmethod
    def normalize_timestamp(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Log timestamp must include a timezone")
        return value.astimezone(UTC)


class ContainerLogSnapshot(_EvidenceContract):
    source: Literal["current", "previous"]
    status: Literal[
        "available",
        "no_logs_in_window",
        "container_not_started",
        "previous_unavailable",
    ]
    lines: list[ContainerLogLine]

    @model_validator(mode="after")
    def require_source_status_consistency(self) -> ContainerLogSnapshot:
        unavailable_status = (
            "container_not_started"
            if self.source == "current"
            else "previous_unavailable"
        )
        if self.status not in {
            "available",
            "no_logs_in_window",
            unavailable_status,
        }:
            raise ValueError("Log status does not match its source")
        if (self.status == "available") is not bool(self.lines):
            raise ValueError("Log status does not match line availability")
        return self


class ContainerLogSummary(_EvidenceContract):
    pod_ref: TargetRef
    owner: OwnerSummary
    container: str = Field(min_length=1)
    restart_count: int = Field(ge=1)
    snapshots: list[ContainerLogSnapshot] = Field(min_length=2, max_length=2)

    @field_validator("snapshots")
    @classmethod
    def require_current_and_previous(
        cls,
        value: list[ContainerLogSnapshot],
    ) -> list[ContainerLogSnapshot]:
        if {snapshot.source for snapshot in value} != {"current", "previous"}:
            raise ValueError("Logs require one current and one previous snapshot")
        return value


class ContainerLogsPayload(_EvidenceContract):
    source_workload: SourceWorkload
    containers: list[ContainerLogSummary]


class ServiceDetail(_EvidenceContract):
    resource_version: str = Field(min_length=1)
    service_type: Literal["ClusterIP", "NodePort", "LoadBalancer", "ExternalName"]
    cluster_ip: str | None
    selector: Selector | None
    monitoring_enabled: bool
    publish_not_ready_addresses: bool


class ServiceCandidatePod(_EvidenceContract):
    pod_ref: TargetRef
    resource_version: str = Field(min_length=1)
    selector_labels: dict[str, str | None]
    matches_selector: bool
    ready: bool | None


class EndpointSliceSummary(_EvidenceContract):
    endpoint_slice_ref: TargetRef
    resource_version: str = Field(min_length=1)
    address_type: Literal["IPv4", "IPv6", "FQDN"]
    endpoint_count: int = Field(ge=0)
    ready_count: int = Field(ge=0)
    not_ready_count: int = Field(ge=0)
    unknown_ready_count: int = Field(ge=0)
    serving_count: int = Field(ge=0)
    terminating_count: int = Field(ge=0)


class ServiceNetworkSummary(_EvidenceContract):
    state: ServiceNetworkState
    candidate_count: int = Field(ge=0)
    selector_match_count: int = Field(ge=0)
    endpoint_slice_count: int = Field(ge=0)
    ready_endpoint_count: int = Field(ge=0)


class ServiceNetworkPayload(_EvidenceContract):
    service: ServiceDetail
    summary: ServiceNetworkSummary
    candidate_pods: list[ServiceCandidatePod]
    endpoint_slices: list[EndpointSliceSummary]


class _Observation(_EvidenceContract):
    target_ref: TargetRef
    observed_at: datetime
    truncated: bool
    redacted: bool

    @field_validator("observed_at")
    @classmethod
    def normalize_observed_at(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Observation time must include a timezone")
        return value.astimezone(UTC)


class WorkloadObservation(_Observation):
    evidence_kind: Literal["workload"]
    payload: WorkloadPayload


class PodsObservation(_Observation):
    evidence_kind: Literal["pods"]
    payload: PodsPayload


class EventsObservation(_Observation):
    evidence_kind: Literal["events"]
    payload: EventsPayload


class ContainerLogsObservation(_Observation):
    evidence_kind: Literal["container_logs"]
    payload: ContainerLogsPayload


class ServiceNetworkObservation(_Observation):
    evidence_kind: Literal["service_network"]
    payload: ServiceNetworkPayload
