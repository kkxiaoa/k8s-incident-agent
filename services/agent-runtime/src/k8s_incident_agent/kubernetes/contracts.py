from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Final, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

from k8s_incident_agent.domain.contracts import KubernetesTarget
from k8s_incident_agent.kubernetes.errors import KubernetesErrorCode

DiagnosticTarget = KubernetesTarget
MAX_DEPLOYMENT_REVISION: Final = (1 << 63) - 1
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
    message: str | None = None
    last_transition_time: str | None = None


class ResourceValues(_EvidenceContract):
    cpu_cores: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    memory_bytes: float | None = Field(default=None, ge=0, allow_inf_nan=False)


class ContainerResources(_EvidenceContract):
    requests: ResourceValues
    limits: ResourceValues


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
    source_index: int | None = Field(default=None, ge=0, le=255)
    resources: ContainerResources | None = None


class WorkloadDetail(_EvidenceContract):
    resource_version: str = Field(min_length=1)
    generation: int | None = Field(ge=0)
    observed_generation: int | None = Field(ge=0)
    replicas: ReplicaSummary
    selector: Selector
    containers: list[WorkloadContainer]
    conditions: list[ConditionSummary]

    @model_validator(mode="after")
    def require_unambiguous_source_indexes(self) -> Self:
        indexes = [container.source_index for container in self.containers]
        if any(index is not None for index in indexes) and (
            any(index is None for index in indexes)
            or len(set(indexes)) != len(indexes)
            or set(indexes) != set(range(len(indexes)))
        ):
            raise ValueError("Workload container source indexes are ambiguous")
        return self


class WorkloadPayload(_EvidenceContract):
    workload: WorkloadDetail


class SourceWorkload(_EvidenceContract):
    resource_version: str = Field(min_length=1)
    selector: Selector


class RolloutContainer(_EvidenceContract):
    name: str = Field(min_length=1)
    image: str = Field(min_length=1)


class RolloutRevision(_EvidenceContract):
    revision: int = Field(ge=1, le=MAX_DEPLOYMENT_REVISION)
    replica_set_ref: TargetRef
    containers: list[RolloutContainer] = Field(min_length=1)

    @model_validator(mode="after")
    def require_replica_set_identity_and_sorted_containers(self) -> Self:
        names = [container.name for container in self.containers]
        if (
            self.replica_set_ref.api_version != "apps/v1"
            or self.replica_set_ref.kind != "ReplicaSet"
            or names != sorted(names)
            or len(set(names)) != len(names)
        ):
            raise ValueError("Rollout revision contract is invalid")
        return self


class RolloutHistoryPayload(_EvidenceContract):
    source_workload: SourceWorkload
    revisions: list[RolloutRevision] = Field(max_length=100)

    @model_validator(mode="after")
    def require_unique_descending_revisions(self) -> Self:
        revisions = [item.revision for item in self.revisions]
        replica_set_uids = [item.replica_set_ref.uid for item in self.revisions]
        if (
            revisions != sorted(revisions, reverse=True)
            or len(set(revisions)) != len(revisions)
            or len(set(replica_set_uids)) != len(replica_set_uids)
        ):
            raise ValueError("Rollout history ordering or identity is ambiguous")
        return self


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
    started_at: str | None = None
    finished_at: str | None = None
    exit_code: int | None = None


class PodContainer(_EvidenceContract):
    name: str = Field(min_length=1)
    image: str
    image_id: str | None
    restart_count: int | None = Field(ge=0)
    state: ContainerStateSummary
    last_state: ContainerStateSummary | None = None
    configured_resources: ContainerResources | None = None


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


class RecoveryPod(_EvidenceContract):
    name: str = Field(min_length=1, max_length=253)
    uid: str = Field(min_length=1, max_length=253)
    ready: bool
    terminating: bool
    image: str | None
    container_state: Literal["waiting", "running", "terminated", "unknown"]
    waiting_reason: str | None
    restart_count: int | None = Field(ge=0)


class RecoveryWorkload(_EvidenceContract):
    target_ref: TargetRef
    generation: int | None = Field(ge=0)
    observed_generation: int | None = Field(ge=0)
    image: str | None
    desired: int = Field(ge=0)
    updated: int = Field(ge=0)
    available: int = Field(ge=0)
    replicas: int = Field(ge=0)
    terminating: bool
    rollout_failed: bool
    current_replica_set: TargetRef | None
    old_replicas: int = Field(ge=0)
    old_pods: int = Field(ge=0)
    pods: list[RecoveryPod] = Field(max_length=32)


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
    last_observed_time: str | None = None
    container: str | None = None


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


type LogSelectionReason = Literal[
    "crash_loop", "current_termination", "recent_termination", "probe_failure"
]


class ContainerLogSummary(_EvidenceContract):
    pod_ref: TargetRef
    owner: OwnerSummary
    container: str = Field(min_length=1)
    restart_count: int = Field(ge=0)
    selection_reason: LogSelectionReason | None = None
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


class RecoveryLog(_EvidenceContract):
    pod_name: str
    pod_uid: str
    snapshot: ContainerLogSnapshot


class RecoveryLogs(_EvidenceContract):
    containers: list[RecoveryLog] = Field(max_length=2)
    not_sampled_pods: int = Field(ge=0)
    error: KubernetesErrorCode | None
    redacted: bool
    truncated: bool


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


class RequestedStorageClass(_EvidenceContract):
    mode: Literal["explicit", "default", "none"]
    name: str | None

    @model_validator(mode="after")
    def require_name_only_for_explicit_request(self) -> Self:
        if (self.mode == "explicit") is not (self.name is not None):
            raise ValueError("StorageClass request mode does not match its name")
        return self


class PersistentVolumeClaimDetail(_EvidenceContract):
    resource_version: str = Field(min_length=1)
    phase: Literal["Pending", "Bound", "Lost"]
    requested_storage_class: RequestedStorageClass
    conditions: list[ConditionSummary]


class StorageClassDetail(_EvidenceContract):
    name: str = Field(min_length=1)
    uid: str = Field(min_length=1)
    resource_version: str = Field(min_length=1)
    provisioner: str = Field(min_length=1)
    volume_binding_mode: Literal["Immediate", "WaitForFirstConsumer"]
    is_default: bool


class StorageClassLookup(_EvidenceContract):
    state: Literal["found", "not_found", "not_requested"]
    storage_class: StorageClassDetail | None

    @model_validator(mode="after")
    def require_storage_class_only_when_found(self) -> Self:
        if (self.state == "found") is not (self.storage_class is not None):
            raise ValueError("StorageClass lookup state does not match its result")
        return self


class PvcStoragePayload(_EvidenceContract):
    persistent_volume_claim: PersistentVolumeClaimDetail
    storage_class_lookup: StorageClassLookup
    events: list[EventSummary]


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


class RolloutHistoryObservation(_Observation):
    evidence_kind: Literal["rollout_history"]
    payload: RolloutHistoryPayload

    @model_validator(mode="after")
    def require_deployment_scope(self) -> Self:
        if (
            self.target_ref.api_version != "apps/v1"
            or self.target_ref.kind != "Deployment"
            or any(
                item.replica_set_ref.namespace != self.target_ref.namespace
                for item in self.payload.revisions
            )
        ):
            raise ValueError("Rollout history target scope is invalid")
        return self


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


class PvcStorageObservation(_Observation):
    evidence_kind: Literal["pvc_storage"]
    payload: PvcStoragePayload
