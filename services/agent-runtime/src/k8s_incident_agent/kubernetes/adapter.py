from __future__ import annotations

import math
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, Protocol, cast

from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    EventsV1Event,
    EventsV1EventList,
    EventsV1EventSeries,
    V1Container,
    V1ContainerState,
    V1ContainerStateRunning,
    V1ContainerStateTerminated,
    V1ContainerStateWaiting,
    V1ContainerStatus,
    V1Deployment,
    V1DeploymentCondition,
    V1DeploymentSpec,
    V1DeploymentStatus,
    V1Endpoint,
    V1EndpointConditions,
    V1EndpointSlice,
    V1EndpointSliceList,
    V1LabelSelector,
    V1ListMeta,
    V1ObjectMeta,
    V1ObjectReference,
    V1OwnerReference,
    V1Pod,
    V1PodCondition,
    V1PodList,
    V1PodSpec,
    V1PodStatus,
    V1PodTemplateSpec,
    V1ReplicaSet,
    V1ReplicaSetList,
    V1Service,
    V1ServiceSpec,
)
from kubernetes.aio.client.exceptions import (  # pyright: ignore[reportMissingTypeStubs]
    ApiException,
)

from k8s_incident_agent.domain.models import JsonValue
from k8s_incident_agent.kubernetes.access import require_diagnostic_target_scope
from k8s_incident_agent.kubernetes.client import KubernetesClients
from k8s_incident_agent.kubernetes.contracts import (
    ConditionSummary,
    ContainerLogLine,
    ContainerLogSnapshot,
    ContainerLogsObservation,
    ContainerLogsPayload,
    ContainerLogSummary,
    ContainerStateSummary,
    DiagnosticTarget,
    EndpointSliceSummary,
    EventsObservation,
    EventsPayload,
    EventSummary,
    OwnerSummary,
    PodContainer,
    PodsObservation,
    PodsPayload,
    PodSummary,
    RegardingSummary,
    ReplicaSummary,
    Selector,
    ServiceCandidatePod,
    ServiceDetail,
    ServiceNetworkObservation,
    ServiceNetworkPayload,
    ServiceNetworkState,
    ServiceNetworkSummary,
    SourceWorkload,
    TargetRef,
    WorkloadContainer,
    WorkloadDetail,
    WorkloadObservation,
    WorkloadPayload,
)
from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    KubernetesErrorCode,
    map_kubernetes_exception,
)
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.security.sanitizer import sanitize_untrusted_text

CANONICAL_PAYLOAD_LIMIT_BYTES = 64 * 1024
LIST_PAGE_LIMIT = 100
LIST_MAX_PAGES = 5
REPLICA_SET_LIMIT = 100
POD_LIMIT = 100
EVENT_LIMIT = 200
SERVICE_CANDIDATE_POD_LIMIT = 32
SERVICE_ENDPOINT_SLICE_LIMIT = 64
SERVICE_ENDPOINT_LIMIT = 256
SERVICE_SELECTOR_LABEL_LIMIT = 16
LOG_CONTAINER_LIMIT = 4
LOG_LINE_LIMIT = 80
LOG_RESPONSE_LIMIT_BYTES = 4 * 1024
LOG_SINCE_SECONDS = 10 * 60
LOG_LINE_MAX_CODE_POINTS = 512
WORKLOAD_ARGUMENT_LIMIT = 16
WORKLOAD_ARGUMENT_MAX_CODE_POINTS = 512

SERVICE_ASSOCIATION_LABEL = "k8s-incident-agent.io/service"
SERVICE_MONITORING_LABEL = "k8s-incident-agent.io/monitor-selector"
ENDPOINT_SLICE_SERVICE_LABEL = "kubernetes.io/service-name"

_LABEL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9](?:[-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?$")
_DNS_LABEL_PATTERN = re.compile(r"^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$")
_SENSITIVE_ARGUMENT_PATTERN = re.compile(
    r"^--?[A-Za-z0-9_.-]*(?:token|password|api[_-]?key|authorization|cookie)"
    r"[A-Za-z0-9_.-]*$",
    re.IGNORECASE,
)


class _AppsApi(Protocol):
    def read_namespaced_deployment(
        self,
        name: str,
        namespace: str,
        **kwargs: object,
    ) -> Awaitable[object]: ...

    def list_namespaced_replica_set(
        self,
        namespace: str,
        **kwargs: object,
    ) -> Awaitable[object]: ...


class _CoreApi(Protocol):
    def read_namespaced_service(
        self,
        name: str,
        namespace: str,
        **kwargs: object,
    ) -> Awaitable[object]: ...

    def list_namespaced_pod(
        self,
        namespace: str,
        **kwargs: object,
    ) -> Awaitable[object]: ...

    def read_namespaced_pod_log(
        self,
        name: str,
        namespace: str,
        **kwargs: object,
    ) -> Awaitable[object]: ...


class _DiscoveryApi(Protocol):
    def list_namespaced_endpoint_slice(
        self,
        namespace: str,
        **kwargs: object,
    ) -> Awaitable[object]: ...


class _EventsApi(Protocol):
    def list_namespaced_event(
        self,
        namespace: str,
        **kwargs: object,
    ) -> Awaitable[object]: ...


class _ListView(Protocol):
    metadata: object
    items: object


class _DeploymentView(Protocol):
    api_version: object
    kind: object
    metadata: object
    spec: object
    status: object


class _MetadataView(Protocol):
    namespace: object
    name: object
    uid: object
    resource_version: object
    generation: object
    owner_references: object
    labels: object


class _DeploymentSpecView(Protocol):
    replicas: object
    selector: object
    template: object


class _PodTemplateView(Protocol):
    spec: object


class _PodSpecView(Protocol):
    containers: object


class _SelectorView(Protocol):
    match_expressions: object
    match_labels: object


class _DeploymentStatusView(Protocol):
    observed_generation: object
    updated_replicas: object
    ready_replicas: object
    available_replicas: object
    conditions: object


class _ConditionView(Protocol):
    type: object
    status: object
    reason: object


class _WorkloadContainerView(Protocol):
    name: object
    image: object
    image_pull_policy: object
    command: object
    args: object


class _ReplicaSetView(Protocol):
    api_version: object
    kind: object
    metadata: object


class _OwnerReferenceView(Protocol):
    api_version: object
    kind: object
    name: object
    uid: object
    controller: object


class _PodView(Protocol):
    api_version: object
    kind: object
    metadata: object
    spec: object
    status: object


class _ServiceView(Protocol):
    api_version: object
    kind: object
    metadata: object
    spec: object


class _ServiceSpecView(Protocol):
    type: object
    cluster_ip: object
    selector: object
    publish_not_ready_addresses: object


class _EndpointSliceView(Protocol):
    api_version: object
    kind: object
    metadata: object
    address_type: object
    endpoints: object


class _EndpointView(Protocol):
    conditions: object


class _EndpointConditionsView(Protocol):
    ready: object
    serving: object
    terminating: object


class _PodStatusView(Protocol):
    phase: object
    conditions: object
    container_statuses: object


class _ContainerStatusView(Protocol):
    name: object
    image: object
    image_id: object
    restart_count: object
    state: object


class _ContainerStateView(Protocol):
    waiting: object
    running: object
    terminated: object


class _ContainerStateDetailView(Protocol):
    reason: object
    message: object


class _LogResponseView(Protocol):
    status: object
    content: _LogContentView

    def release(self) -> None: ...


class _LogContentView(Protocol):
    def read(self, size: int) -> Awaitable[bytes]: ...


class _EventView(Protocol):
    api_version: object
    kind: object
    metadata: object
    regarding: object
    type: object
    reason: object
    action: object
    note: object
    event_time: object
    series: object
    deprecated_count: object
    reporting_controller: object


class _EventSeriesView(Protocol):
    count: object


class _ObjectReferenceView(Protocol):
    api_version: object
    kind: object
    namespace: object
    name: object
    uid: object


@dataclass(frozen=True, slots=True)
class _DeploymentContext:
    deployment: V1Deployment
    target_ref: TargetRef
    resource_version: str
    uid: str
    selector: Selector
    label_selector: str


@dataclass(frozen=True, slots=True)
class _AssociatedPod:
    pod: V1Pod
    owner: _OwnerReferenceView


@dataclass(frozen=True, slots=True)
class _ContainerLogTarget:
    pod_name: str
    pod_uid: str
    owner: OwnerSummary
    container_name: str
    restart_count: int


@dataclass(frozen=True, slots=True)
class _Associations:
    workload: _DeploymentContext
    replica_sets: tuple[V1ReplicaSet, ...]
    pods: tuple[_AssociatedPod, ...]
    references_by_uid: dict[str, RegardingSummary]


@dataclass(slots=True)
class _SanitizationState:
    truncated: bool = False
    redacted: bool = False

    def required(self, value: object) -> str:
        if not isinstance(value, str) or not value:
            raise _contract_error()
        text = value
        return self._sanitize(text)

    def optional(self, value: object) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str):
            raise _contract_error()
        text = value
        return self._sanitize(text)

    def _sanitize(self, value: str) -> str:
        result = sanitize_untrusted_text(value)
        self.truncated = self.truncated or result.truncated
        self.redacted = self.redacted or result.redacted
        return result.value


class KubernetesEvidenceAdapter:
    def __init__(
        self,
        clients: KubernetesClients,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._apps_api = cast(_AppsApi, clients.apps_api)
        self._core_api = cast(_CoreApi, clients.core_api)
        self._events_api = cast(_EventsApi, clients.events_api)
        self._discovery_api = cast(_DiscoveryApi, clients.discovery_api)
        self._timeout_seconds = clients.timeout_seconds
        self._cluster_id = clients.cluster_id
        self._diagnostic_namespace = clients.diagnostic_namespace
        self._server_timeout_seconds = max(1, math.ceil(clients.timeout_seconds))
        self._clock = clock or _utc_now

    async def read_workload(
        self,
        target: DiagnosticTarget,
    ) -> WorkloadObservation:
        try:
            state = _SanitizationState()
            workload = await self._read_deployment(target, state)
            payload = WorkloadPayload(workload=_project_workload(workload, state))
            _enforce_payload_budget(payload)
            return WorkloadObservation(
                evidence_kind="workload",
                target_ref=workload.target_ref,
                observed_at=_observation_time(self._clock),
                payload=payload,
                truncated=state.truncated,
                redacted=state.redacted,
            )
        except KubernetesBoundaryError:
            raise
        except Exception as error:
            raise map_kubernetes_exception(error) from None

    async def read_pods(
        self,
        target: DiagnosticTarget,
    ) -> PodsObservation:
        try:
            state = _SanitizationState()
            associations = await self._read_associations(target, state)
            payload = PodsPayload(
                source_workload=_source_workload(associations.workload),
                pods=sorted(
                    (
                        _project_pod(associated, state)
                        for associated in associations.pods
                    ),
                    key=lambda pod: (pod.namespace, pod.name, pod.uid),
                ),
            )
            _enforce_payload_budget(payload)
            return PodsObservation(
                evidence_kind="pods",
                target_ref=associations.workload.target_ref,
                observed_at=_observation_time(self._clock),
                payload=payload,
                truncated=state.truncated,
                redacted=state.redacted,
            )
        except KubernetesBoundaryError:
            raise
        except Exception as error:
            raise map_kubernetes_exception(error) from None

    async def read_events(
        self,
        target: DiagnosticTarget,
    ) -> EventsObservation:
        try:
            state = _SanitizationState()
            associations = await self._read_associations(target, state)
            namespace = cast(str, target.namespace)
            events = await self._list_events(namespace)
            projected_events: list[EventSummary] = []
            for event in events:
                regarding = _event_regarding(event)
                expected_regarding = associations.references_by_uid.get(regarding.uid)
                if expected_regarding is None:
                    continue
                if regarding != expected_regarding:
                    raise _contract_error()
                projected_events.append(
                    _project_event(
                        event,
                        regarding,
                        expected_namespace=namespace,
                        state=state,
                    )
                )
                if len(projected_events) > EVENT_LIMIT:
                    raise _budget_error()
            projected_events.sort(
                key=lambda event: (
                    event.event_time or "",
                    event.namespace,
                    event.name,
                    event.uid,
                )
            )
            payload = EventsPayload(
                source_workload=_source_workload(associations.workload),
                associated_replica_set_count=len(associations.replica_sets),
                associated_pod_count=len(associations.pods),
                events=projected_events,
            )
            _enforce_payload_budget(payload)
            return EventsObservation(
                evidence_kind="events",
                target_ref=associations.workload.target_ref,
                observed_at=_observation_time(self._clock),
                payload=payload,
                truncated=state.truncated,
                redacted=state.redacted,
            )
        except KubernetesBoundaryError:
            raise
        except Exception as error:
            raise map_kubernetes_exception(error) from None

    async def read_container_logs(
        self,
        target: DiagnosticTarget,
    ) -> ContainerLogsObservation:
        try:
            state = _SanitizationState()
            associations = await self._read_associations(target, state)
            log_targets = _crash_loop_log_targets(associations)
            if len(log_targets) > LOG_CONTAINER_LIMIT:
                raise _budget_error()
            containers: list[ContainerLogSummary] = []
            for log_target in log_targets:
                snapshots = [
                    await self._read_container_log_snapshot(
                        cast(str, target.namespace),
                        log_target,
                        source,
                        state,
                    )
                    for source in ("current", "previous")
                ]
                containers.append(
                    ContainerLogSummary(
                        pod_ref=TargetRef(
                            api_version="v1",
                            kind="Pod",
                            namespace=cast(str, target.namespace),
                            name=log_target.pod_name,
                            uid=log_target.pod_uid,
                        ),
                        owner=log_target.owner,
                        container=log_target.container_name,
                        restart_count=log_target.restart_count,
                        snapshots=snapshots,
                    )
                )

            if log_targets:
                rebound = await self._read_associations(target, state)
                rebound_identities = _associated_container_identities(rebound)
                if any(
                    _log_target_identity(item) not in rebound_identities
                    for item in log_targets
                ):
                    raise _contract_error()

            payload = ContainerLogsPayload(
                source_workload=_source_workload(associations.workload),
                containers=containers,
            )
            _enforce_payload_budget(payload)
            return ContainerLogsObservation(
                evidence_kind="container_logs",
                target_ref=associations.workload.target_ref,
                observed_at=_observation_time(self._clock),
                payload=payload,
                truncated=state.truncated,
                redacted=state.redacted,
            )
        except KubernetesBoundaryError:
            raise
        except Exception as error:
            raise map_kubernetes_exception(error) from None

    async def read_service_network(
        self,
        target: DiagnosticTarget,
    ) -> ServiceNetworkObservation:
        try:
            state = _SanitizationState()
            namespace = require_diagnostic_target_scope(
                target,
                cluster_id=self._cluster_id,
                diagnostic_namespace=self._diagnostic_namespace,
            )
            if target.api_version != "v1" or target.kind != "Service":
                raise _contract_error()
            service = await self._read_service(target.name, namespace)
            service_detail, target_ref, raw_selector = _project_service(
                service,
                target,
                state,
            )
            candidate_pods = await self._list_service_candidate_pods(
                namespace,
                target.name,
            )
            if len(candidate_pods) > SERVICE_CANDIDATE_POD_LIMIT:
                raise _budget_error()
            candidates = sorted(
                (
                    _project_service_candidate_pod(
                        pod,
                        namespace=namespace,
                        service_name=target.name,
                        selector=raw_selector,
                        state=state,
                    )
                    for pod in candidate_pods
                ),
                key=lambda pod: (pod.pod_ref.name, pod.pod_ref.uid),
            )
            endpoint_slices = await self._list_service_endpoint_slices(
                namespace,
                target.name,
            )
            if len(endpoint_slices) > SERVICE_ENDPOINT_SLICE_LIMIT:
                raise _budget_error()
            projected_slices = sorted(
                (
                    _project_endpoint_slice(
                        endpoint_slice,
                        service_ref=target_ref,
                        expected_namespace=namespace,
                    )
                    for endpoint_slice in endpoint_slices
                ),
                key=lambda item: (
                    item.endpoint_slice_ref.name,
                    item.endpoint_slice_ref.uid,
                ),
            )
            endpoint_count = sum(item.endpoint_count for item in projected_slices)
            if endpoint_count > SERVICE_ENDPOINT_LIMIT:
                raise _budget_error()
            ready_endpoint_count = sum(item.ready_count for item in projected_slices)
            selector_match_count = sum(
                candidate.matches_selector for candidate in candidates
            )
            payload = ServiceNetworkPayload(
                service=service_detail,
                summary=ServiceNetworkSummary(
                    state=_service_network_state(
                        service_detail,
                        candidate_count=len(candidates),
                        selector_match_count=selector_match_count,
                        ready_endpoint_count=ready_endpoint_count,
                    ),
                    candidate_count=len(candidates),
                    selector_match_count=selector_match_count,
                    endpoint_slice_count=len(projected_slices),
                    ready_endpoint_count=ready_endpoint_count,
                ),
                candidate_pods=candidates,
                endpoint_slices=projected_slices,
            )
            _enforce_payload_budget(payload)
            return ServiceNetworkObservation(
                evidence_kind="service_network",
                target_ref=target_ref,
                observed_at=_observation_time(self._clock),
                payload=payload,
                truncated=state.truncated,
                redacted=state.redacted,
            )
        except KubernetesBoundaryError:
            raise
        except Exception as error:
            raise map_kubernetes_exception(error) from None

    async def _read_service(self, name: str, namespace: str) -> V1Service:
        try:
            response = await self._core_api.read_namespaced_service(
                name=name,
                namespace=namespace,
                _request_timeout=self._timeout_seconds,
            )
        except Exception as error:
            raise map_kubernetes_exception(error, resource_not_found=True) from None
        if not isinstance(response, V1Service):
            raise _contract_error()
        return response

    async def _list_service_candidate_pods(
        self,
        namespace: str,
        service_name: str,
    ) -> list[V1Pod]:
        return await self._list_pods(
            namespace,
            f"{SERVICE_ASSOCIATION_LABEL}={service_name}",
        )

    async def _list_service_endpoint_slices(
        self,
        namespace: str,
        service_name: str,
    ) -> list[V1EndpointSlice]:
        discovery_api = self._discovery_api

        async def fetch(continue_token: str | None) -> object:
            kwargs = self._list_kwargs(continue_token)
            kwargs["label_selector"] = f"{ENDPOINT_SLICE_SERVICE_LABEL}={service_name}"
            try:
                return await discovery_api.list_namespaced_endpoint_slice(
                    namespace=namespace,
                    **kwargs,
                )
            except Exception as error:
                raise map_kubernetes_exception(error) from None

        return await _collect_pages(
            fetch,
            list_type=V1EndpointSliceList,
            item_type=V1EndpointSlice,
        )

    async def _read_container_log_snapshot(
        self,
        namespace: str,
        target: _ContainerLogTarget,
        source: str,
        state: _SanitizationState,
    ) -> ContainerLogSnapshot:
        previous = source == "previous"
        try:
            response = await self._core_api.read_namespaced_pod_log(
                name=target.pod_name,
                namespace=namespace,
                container=target.container_name,
                follow=False,
                insecure_skip_tls_verify_backend=False,
                limit_bytes=LOG_RESPONSE_LIMIT_BYTES,
                previous=previous,
                since_seconds=LOG_SINCE_SECONDS,
                tail_lines=LOG_LINE_LIMIT,
                timestamps=True,
                _preload_content=False,
                _request_timeout=self._timeout_seconds,
            )
        except Exception as error:
            raise map_kubernetes_exception(error, resource_not_found=True) from None

        response_view = cast(_LogResponseView, response)
        status = response_view.status
        release = getattr(response_view, "release", None)
        if (
            not isinstance(status, int)
            or isinstance(status, bool)
            or not callable(release)
        ):
            raise _contract_error()
        try:
            if status == 400:
                return ContainerLogSnapshot(
                    source=cast(Literal["current", "previous"], source),
                    status=(
                        "previous_unavailable" if previous else "container_not_started"
                    ),
                    lines=[],
                )
            if status != 200:
                raise map_kubernetes_exception(
                    _api_status_exception(status),
                    resource_not_found=True,
                )
            raw = await _read_bounded_log_body(response_view)
        finally:
            release()
        lines = _normalize_log_lines(raw, state)
        return ContainerLogSnapshot(
            source=cast(Literal["current", "previous"], source),
            status="available" if lines else "no_logs_in_window",
            lines=lines,
        )

    async def _read_associations(
        self,
        target: DiagnosticTarget,
        state: _SanitizationState,
    ) -> _Associations:
        workload = await self._read_deployment(target, state)
        namespace = cast(str, target.namespace)
        references_by_uid: dict[str, RegardingSummary] = {}
        _remember_reference(
            references_by_uid,
            RegardingSummary(
                api_version=workload.target_ref.api_version,
                kind=workload.target_ref.kind,
                namespace=workload.target_ref.namespace,
                name=workload.target_ref.name,
                uid=workload.target_ref.uid,
            ),
        )
        replica_sets = await self._list_replica_sets(
            namespace,
            workload.label_selector,
        )
        associated_replica_sets: list[V1ReplicaSet] = []
        replica_set_uids: set[str] = set()
        for replica_set in replica_sets:
            replica_set_view = cast(_ReplicaSetView, replica_set)
            _validate_list_item_type_meta(
                replica_set_view.api_version,
                replica_set_view.kind,
                expected_api_version="apps/v1",
                expected_kind="ReplicaSet",
            )
            metadata = _metadata(replica_set_view.metadata)
            if _required_string(metadata.namespace) != target.namespace:
                raise _contract_error()
            owner = _controller_owner(
                metadata,
                expected_api_version="apps/v1",
                expected_kind="Deployment",
                expected_uids={workload.uid},
            )
            if owner is None:
                continue
            reference = _resource_reference(
                api_version="apps/v1",
                kind="ReplicaSet",
                metadata=metadata,
                expected_namespace=namespace,
            )
            _remember_reference(references_by_uid, reference)
            associated_replica_sets.append(replica_set)
            replica_set_uids.add(reference.uid)
            if len(associated_replica_sets) > REPLICA_SET_LIMIT:
                raise _budget_error()

        pods = await self._list_pods(namespace, workload.label_selector)
        associated_pods: list[_AssociatedPod] = []
        for pod in pods:
            pod_view = cast(_PodView, pod)
            _validate_list_item_type_meta(
                pod_view.api_version,
                pod_view.kind,
                expected_api_version="v1",
                expected_kind="Pod",
            )
            metadata = _metadata(pod_view.metadata)
            if _required_string(metadata.namespace) != target.namespace:
                raise _contract_error()
            owner = _controller_owner(
                metadata,
                expected_api_version="apps/v1",
                expected_kind="ReplicaSet",
                expected_uids=replica_set_uids,
            )
            if owner is None:
                continue
            reference = _resource_reference(
                api_version="v1",
                kind="Pod",
                metadata=metadata,
                expected_namespace=namespace,
            )
            _remember_reference(references_by_uid, reference)
            associated_pods.append(_AssociatedPod(pod=pod, owner=owner))
            if len(associated_pods) > POD_LIMIT:
                raise _budget_error()

        return _Associations(
            workload=workload,
            replica_sets=tuple(associated_replica_sets),
            pods=tuple(associated_pods),
            references_by_uid=references_by_uid,
        )

    async def _read_deployment(
        self,
        target: DiagnosticTarget,
        state: _SanitizationState,
    ) -> _DeploymentContext:
        if target.api_version != "apps/v1" or target.kind != "Deployment":
            raise _contract_error()
        namespace = require_diagnostic_target_scope(
            target,
            cluster_id=self._cluster_id,
            diagnostic_namespace=self._diagnostic_namespace,
        )
        try:
            response = await self._apps_api.read_namespaced_deployment(
                name=target.name,
                namespace=namespace,
                _request_timeout=self._timeout_seconds,
            )
        except Exception as error:
            raise map_kubernetes_exception(
                error,
                resource_not_found=True,
            ) from None
        if not isinstance(response, V1Deployment):
            raise _contract_error()
        return _deployment_context(response, target, state)

    async def _list_replica_sets(
        self,
        namespace: str,
        label_selector: str,
    ) -> list[V1ReplicaSet]:
        async def fetch(continue_token: str | None) -> object:
            kwargs = self._list_kwargs(continue_token)
            kwargs["label_selector"] = label_selector
            try:
                return await self._apps_api.list_namespaced_replica_set(
                    namespace=namespace,
                    **kwargs,
                )
            except Exception as error:
                raise map_kubernetes_exception(error) from None

        return await _collect_pages(
            fetch,
            list_type=V1ReplicaSetList,
            item_type=V1ReplicaSet,
        )

    async def _list_pods(
        self,
        namespace: str,
        label_selector: str,
    ) -> list[V1Pod]:
        async def fetch(continue_token: str | None) -> object:
            kwargs = self._list_kwargs(continue_token)
            kwargs["label_selector"] = label_selector
            try:
                return await self._core_api.list_namespaced_pod(
                    namespace=namespace,
                    **kwargs,
                )
            except Exception as error:
                raise map_kubernetes_exception(error) from None

        return await _collect_pages(
            fetch,
            list_type=V1PodList,
            item_type=V1Pod,
        )

    async def _list_events(self, namespace: str) -> list[EventsV1Event]:
        async def fetch(continue_token: str | None) -> object:
            kwargs = self._list_kwargs(continue_token)
            try:
                return await self._events_api.list_namespaced_event(
                    namespace=namespace,
                    **kwargs,
                )
            except Exception as error:
                raise map_kubernetes_exception(error) from None

        return await _collect_pages(
            fetch,
            list_type=EventsV1EventList,
            item_type=EventsV1Event,
        )

    def _list_kwargs(self, continue_token: str | None) -> dict[str, object]:
        kwargs: dict[str, object] = {
            "limit": LIST_PAGE_LIMIT,
            "timeout_seconds": self._server_timeout_seconds,
            "_request_timeout": self._timeout_seconds,
        }
        if continue_token is not None:
            kwargs["_continue"] = continue_token
        return kwargs


async def _collect_pages[Item](
    fetch: Callable[[str | None], Awaitable[object]],
    *,
    list_type: type[object],
    item_type: type[Item],
) -> list[Item]:
    collected: list[Item] = []
    continue_token: str | None = None
    for page_index in range(LIST_MAX_PAGES):
        response = await fetch(continue_token)
        if not isinstance(response, list_type):
            raise _contract_error()
        response_view = cast(_ListView, response)
        metadata = response_view.metadata
        items = response_view.items
        if not isinstance(metadata, V1ListMeta) or not isinstance(items, list):
            raise _contract_error()
        item_values = cast(list[object], items)
        if not all(isinstance(item, item_type) for item in item_values):
            raise _contract_error()
        collected.extend(cast(list[Item], item_values))
        raw_continue = getattr(metadata, "_continue", None)
        if raw_continue is None or raw_continue == "":
            return collected
        if not isinstance(raw_continue, str):
            raise _contract_error()
        if page_index == LIST_MAX_PAGES - 1:
            raise _budget_error()
        continue_token = raw_continue
    raise _budget_error()


def _project_service(
    service: V1Service,
    target: DiagnosticTarget,
    state: _SanitizationState,
) -> tuple[ServiceDetail, TargetRef, dict[str, str]]:
    service_view = cast(_ServiceView, service)
    if service_view.api_version != "v1" or service_view.kind != "Service":
        raise _contract_error()
    metadata = _metadata(service_view.metadata)
    namespace = _required_string(metadata.namespace)
    name = _required_string(metadata.name)
    if namespace != target.namespace or name != target.name:
        raise _contract_error()
    target_ref = TargetRef(
        api_version="v1",
        kind="Service",
        namespace=namespace,
        name=name,
        uid=_required_string(metadata.uid),
    )
    spec = service_view.spec
    if not isinstance(spec, V1ServiceSpec):
        raise _contract_error()
    spec_view = cast(_ServiceSpecView, spec)
    service_type = _required_string(spec_view.type)
    if service_type not in {"ClusterIP", "NodePort", "LoadBalancer", "ExternalName"}:
        raise _contract_error()
    selector, raw_selector = _project_service_selector(spec_view.selector, state)
    labels = _metadata_labels(metadata)
    monitoring_value = labels.get(SERVICE_MONITORING_LABEL)
    if monitoring_value is not None and not _valid_label_value(monitoring_value):
        raise _contract_error()
    publish_not_ready = spec_view.publish_not_ready_addresses
    if publish_not_ready is None:
        publish_not_ready = False
    if not isinstance(publish_not_ready, bool):
        raise _contract_error()
    return (
        ServiceDetail(
            resource_version=_required_string(metadata.resource_version),
            service_type=cast(
                Literal["ClusterIP", "NodePort", "LoadBalancer", "ExternalName"],
                service_type,
            ),
            cluster_ip=state.optional(spec_view.cluster_ip),
            selector=selector,
            monitoring_enabled=monitoring_value == "true",
            publish_not_ready_addresses=publish_not_ready,
        ),
        target_ref,
        raw_selector,
    )


def _project_service_selector(
    value: object,
    state: _SanitizationState,
) -> tuple[Selector | None, dict[str, str]]:
    if value is None:
        return None, {}
    if not isinstance(value, dict):
        raise _contract_error()
    labels = cast(dict[object, object], value)
    if not labels:
        return None, {}
    if len(labels) > SERVICE_SELECTOR_LABEL_LIMIT:
        raise _budget_error()
    raw_selector: dict[str, str] = {}
    projected_selector: dict[str, str] = {}
    for raw_key, raw_value in sorted(
        labels.items(),
        key=lambda item: _required_string(item[0]),
    ):
        key = _required_string(raw_key)
        label_value = _required_string(raw_value, allow_empty=True)
        if not _valid_label_key(key) or not _valid_label_value(label_value):
            raise _contract_error()
        raw_selector[key] = label_value
        normalized = state.required(f"{key}={label_value}")
        projected_key, separator, projected_value = normalized.partition("=")
        if not separator:
            raise _contract_error()
        projected_selector[projected_key] = projected_value
    return Selector(match_labels=projected_selector), raw_selector


def _project_service_candidate_pod(
    pod: V1Pod,
    *,
    namespace: str,
    service_name: str,
    selector: dict[str, str],
    state: _SanitizationState,
) -> ServiceCandidatePod:
    pod_view = cast(_PodView, pod)
    _validate_list_item_type_meta(
        pod_view.api_version,
        pod_view.kind,
        expected_api_version="v1",
        expected_kind="Pod",
    )
    metadata = _metadata(pod_view.metadata)
    if _required_string(metadata.namespace) != namespace:
        raise _contract_error()
    labels = _metadata_labels(metadata)
    if labels.get(SERVICE_ASSOCIATION_LABEL) != service_name:
        raise _contract_error()
    selector_labels: dict[str, str | None] = {}
    for key in selector:
        raw_value = labels.get(key)
        if raw_value is None:
            selector_labels[key] = None
            continue
        if not _valid_label_value(raw_value):
            raise _contract_error()
        selector_labels[key] = state.required(raw_value)
    status = pod_view.status
    if status is not None and not isinstance(status, V1PodStatus):
        raise _contract_error()
    return ServiceCandidatePod(
        pod_ref=TargetRef(
            api_version="v1",
            kind="Pod",
            namespace=namespace,
            name=_required_string(metadata.name),
            uid=_required_string(metadata.uid),
        ),
        resource_version=_required_string(metadata.resource_version),
        selector_labels=selector_labels,
        matches_selector=bool(selector)
        and all(labels.get(key) == value for key, value in selector.items()),
        ready=_pod_ready_condition(status),
    )


def _pod_ready_condition(status: V1PodStatus | None) -> bool | None:
    if status is None:
        return None
    raw_conditions = cast(_PodStatusView, status).conditions
    if raw_conditions is None:
        return None
    if not isinstance(raw_conditions, list):
        raise _contract_error()
    ready: bool | None = None
    ready_seen = False
    for condition in cast(list[object], raw_conditions):
        if not isinstance(condition, V1PodCondition):
            raise _contract_error()
        condition_view = cast(_ConditionView, condition)
        if condition_view.type != "Ready":
            continue
        if ready_seen:
            raise _contract_error()
        ready_seen = True
        raw_status = _required_string(condition_view.status)
        if raw_status == "True":
            ready = True
        elif raw_status == "False":
            ready = False
        elif raw_status != "Unknown":
            raise _contract_error()
    return ready


def _project_endpoint_slice(
    endpoint_slice: V1EndpointSlice,
    *,
    service_ref: TargetRef,
    expected_namespace: str,
) -> EndpointSliceSummary:
    endpoint_slice_view = cast(_EndpointSliceView, endpoint_slice)
    _validate_list_item_type_meta(
        endpoint_slice_view.api_version,
        endpoint_slice_view.kind,
        expected_api_version="discovery.k8s.io/v1",
        expected_kind="EndpointSlice",
    )
    metadata = _metadata(endpoint_slice_view.metadata)
    if _required_string(metadata.namespace) != expected_namespace:
        raise _contract_error()
    labels = _metadata_labels(metadata)
    if labels.get(ENDPOINT_SLICE_SERVICE_LABEL) != service_ref.name:
        raise _contract_error()
    owner = _controller_owner(
        metadata,
        expected_api_version="v1",
        expected_kind="Service",
        expected_uids={service_ref.uid},
    )
    if owner is None or _required_string(owner.name) != service_ref.name:
        raise _contract_error()
    address_type = _required_string(endpoint_slice_view.address_type)
    if address_type not in {"IPv4", "IPv6", "FQDN"}:
        raise _contract_error()
    raw_endpoints = endpoint_slice_view.endpoints
    if not isinstance(raw_endpoints, list) or not all(
        isinstance(endpoint, V1Endpoint)
        for endpoint in cast(list[object], raw_endpoints)
    ):
        raise _contract_error()
    endpoints = cast(list[V1Endpoint], raw_endpoints)
    ready_count = 0
    not_ready_count = 0
    unknown_ready_count = 0
    serving_count = 0
    terminating_count = 0
    for endpoint in endpoints:
        conditions = cast(_EndpointView, endpoint).conditions
        if conditions is None:
            unknown_ready_count += 1
            continue
        if not isinstance(conditions, V1EndpointConditions):
            raise _contract_error()
        conditions_view = cast(_EndpointConditionsView, conditions)
        ready = _optional_bool(conditions_view.ready)
        serving = _optional_bool(conditions_view.serving)
        terminating = _optional_bool(conditions_view.terminating)
        if ready is True:
            ready_count += 1
        elif ready is False:
            not_ready_count += 1
        else:
            unknown_ready_count += 1
        serving_count += serving is True
        terminating_count += terminating is True
    return EndpointSliceSummary(
        endpoint_slice_ref=TargetRef(
            api_version="discovery.k8s.io/v1",
            kind="EndpointSlice",
            namespace=expected_namespace,
            name=_required_string(metadata.name),
            uid=_required_string(metadata.uid),
        ),
        resource_version=_required_string(metadata.resource_version),
        address_type=cast(Literal["IPv4", "IPv6", "FQDN"], address_type),
        endpoint_count=len(endpoints),
        ready_count=ready_count,
        not_ready_count=not_ready_count,
        unknown_ready_count=unknown_ready_count,
        serving_count=serving_count,
        terminating_count=terminating_count,
    )


def _service_network_state(
    service: ServiceDetail,
    *,
    candidate_count: int,
    selector_match_count: int,
    ready_endpoint_count: int,
) -> ServiceNetworkState:
    if not service.monitoring_enabled:
        return "monitoring_not_enabled"
    if service.service_type == "ExternalName":
        return "external_name"
    if service.cluster_ip == "None":
        return "headless"
    if service.publish_not_ready_addresses:
        return "publish_not_ready"
    if service.selector is None:
        return "no_selector"
    if candidate_count == 0:
        return "no_candidates"
    if ready_endpoint_count > 0:
        return "endpoints_ready"
    if selector_match_count == 0:
        return "selector_mismatch"
    return "endpoints_unready"


def _deployment_context(
    deployment: V1Deployment,
    target: DiagnosticTarget,
    state: _SanitizationState,
) -> _DeploymentContext:
    deployment_view = cast(_DeploymentView, deployment)
    if deployment_view.api_version != "apps/v1" or deployment_view.kind != "Deployment":
        raise _contract_error()
    metadata = _metadata(deployment_view.metadata)
    namespace = _required_string(metadata.namespace)
    name = _required_string(metadata.name)
    if namespace != target.namespace or name != target.name:
        raise _contract_error()
    uid = _required_string(metadata.uid)
    resource_version = _required_string(metadata.resource_version)
    spec = deployment_view.spec
    if not isinstance(spec, V1DeploymentSpec):
        raise _contract_error()
    spec_view = cast(_DeploymentSpecView, spec)
    selector, rendered_selector = _selector(spec_view.selector, state)
    return _DeploymentContext(
        deployment=deployment,
        target_ref=TargetRef(
            api_version="apps/v1",
            kind="Deployment",
            namespace=namespace,
            name=name,
            uid=uid,
        ),
        resource_version=resource_version,
        uid=uid,
        selector=selector,
        label_selector=rendered_selector,
    )


def _selector(
    value: object,
    state: _SanitizationState,
) -> tuple[Selector, str]:
    if not isinstance(value, V1LabelSelector):
        raise _contract_error()
    selector_view = cast(_SelectorView, value)
    if selector_view.match_expressions:
        raise _contract_error()
    match_labels = selector_view.match_labels
    if not isinstance(match_labels, dict) or not match_labels:
        raise _contract_error()
    raw_labels: dict[str, str] = {}
    normalized_labels: dict[str, str] = {}
    label_values = cast(dict[object, object], match_labels)
    for raw_key, raw_value in sorted(
        label_values.items(),
        key=lambda item: _required_string(item[0]),
    ):
        key = _required_string(raw_key)
        label_value = _required_string(raw_value, allow_empty=True)
        if not _valid_label_key(key) or not _valid_label_value(label_value):
            raise _contract_error()
        raw_labels[key] = label_value
        sanitized_entry = state.required(f"{key}={label_value}")
        sanitized_key, separator, sanitized_value = sanitized_entry.partition("=")
        if not separator:
            raise _contract_error()
        normalized_labels[sanitized_key] = sanitized_value
    return (
        Selector(match_labels=normalized_labels),
        ",".join(f"{key}={value}" for key, value in raw_labels.items()),
    )


def _project_workload(
    context: _DeploymentContext,
    state: _SanitizationState,
) -> WorkloadDetail:
    deployment = context.deployment
    deployment_view = cast(_DeploymentView, deployment)
    metadata = _metadata(deployment_view.metadata)
    spec = deployment_view.spec
    if not isinstance(spec, V1DeploymentSpec):
        raise _contract_error()
    spec_view = cast(_DeploymentSpecView, spec)
    pod_spec = _deployment_pod_spec(spec)
    containers_value = pod_spec.containers
    if not isinstance(containers_value, list):
        raise _contract_error()
    containers = sorted(
        (
            _project_workload_container(container, state)
            for container in cast(list[V1Container], containers_value)
        ),
        key=lambda container: container.name,
    )
    status = deployment_view.status
    if status is not None and not isinstance(status, V1DeploymentStatus):
        raise _contract_error()
    status_view = None if status is None else cast(_DeploymentStatusView, status)
    raw_conditions: object = (
        []
        if status_view is None or status_view.conditions is None
        else status_view.conditions
    )
    if not isinstance(raw_conditions, list):
        raise _contract_error()
    condition_values = cast(list[object], raw_conditions)
    if not all(
        isinstance(condition, V1DeploymentCondition) for condition in condition_values
    ):
        raise _contract_error()
    conditions = cast(list[V1DeploymentCondition], condition_values)
    projected_conditions = sorted(
        (_project_sdk_condition(condition, state) for condition in conditions),
        key=lambda condition: (
            condition.type,
            condition.status,
            condition.reason or "",
        ),
    )
    return WorkloadDetail(
        resource_version=context.resource_version,
        generation=_optional_nonnegative_int(metadata.generation),
        observed_generation=(
            None
            if status_view is None
            else _optional_nonnegative_int(status_view.observed_generation)
        ),
        replicas=ReplicaSummary(
            desired=_nonnegative_int(spec_view.replicas),
            updated=_zero_if_missing(
                None if status_view is None else status_view.updated_replicas
            ),
            ready=_zero_if_missing(
                None if status_view is None else status_view.ready_replicas
            ),
            available=_zero_if_missing(
                None if status_view is None else status_view.available_replicas
            ),
        ),
        selector=context.selector,
        containers=containers,
        conditions=projected_conditions,
    )


def _deployment_pod_spec(spec: V1DeploymentSpec) -> _PodSpecView:
    spec_view = cast(_DeploymentSpecView, spec)
    template = spec_view.template
    if not isinstance(template, V1PodTemplateSpec):
        raise _contract_error()
    template_view = cast(_PodTemplateView, template)
    pod_spec = template_view.spec
    if not isinstance(pod_spec, V1PodSpec):
        raise _contract_error()
    pod_spec_view = cast(_PodSpecView, pod_spec)
    containers = pod_spec_view.containers
    if not isinstance(containers, list):
        raise _contract_error()
    container_values = cast(list[object], containers)
    if not all(isinstance(container, V1Container) for container in container_values):
        raise _contract_error()
    return pod_spec_view


def _project_workload_container(
    container: V1Container,
    state: _SanitizationState,
) -> WorkloadContainer:
    container_view = cast(_WorkloadContainerView, container)
    command, redact_next = _project_workload_arguments(
        container_view.command,
        state,
    )
    arguments, _ = _project_workload_arguments(
        container_view.args,
        state,
        redact_value=redact_next,
    )
    return WorkloadContainer(
        name=_required_string(container_view.name),
        image=state.required(container_view.image),
        image_pull_policy=_required_string(container_view.image_pull_policy),
        command=command,
        args=arguments,
    )


def _project_workload_arguments(
    value: object,
    state: _SanitizationState,
    *,
    redact_value: bool = False,
) -> tuple[list[str], bool]:
    if value is None:
        return [], redact_value
    if not isinstance(value, list):
        raise _contract_error()
    raw_values = cast(list[object], value)
    if len(raw_values) > WORKLOAD_ARGUMENT_LIMIT:
        raise _budget_error()
    arguments: list[str] = []
    for item in raw_values:
        if not isinstance(item, str):
            raise _contract_error()
        if redact_value:
            arguments.append("[REDACTED]")
            state.redacted = True
            redact_value = _SENSITIVE_ARGUMENT_PATTERN.fullmatch(item) is not None
            continue
        sanitized = sanitize_untrusted_text(
            item,
            max_code_points=WORKLOAD_ARGUMENT_MAX_CODE_POINTS,
        )
        state.truncated = state.truncated or sanitized.truncated
        state.redacted = state.redacted or sanitized.redacted
        arguments.append(sanitized.value)
        redact_value = _SENSITIVE_ARGUMENT_PATTERN.fullmatch(item) is not None
    return arguments, redact_value


def _source_workload(context: _DeploymentContext) -> SourceWorkload:
    return SourceWorkload(
        resource_version=context.resource_version,
        selector=context.selector,
    )


def _resource_reference(
    *,
    api_version: str,
    kind: str,
    metadata: _MetadataView,
    expected_namespace: str,
) -> RegardingSummary:
    namespace = _required_string(metadata.namespace)
    if namespace != expected_namespace:
        raise _contract_error()
    return RegardingSummary(
        api_version=api_version,
        kind=kind,
        namespace=namespace,
        name=_required_string(metadata.name),
        uid=_required_string(metadata.uid),
    )


def _remember_reference(
    references_by_uid: dict[str, RegardingSummary],
    reference: RegardingSummary,
) -> None:
    if reference.uid in references_by_uid:
        raise _contract_error()
    references_by_uid[reference.uid] = reference


def _controller_owner(
    metadata: _MetadataView,
    *,
    expected_api_version: str,
    expected_kind: str,
    expected_uids: set[str],
) -> _OwnerReferenceView | None:
    raw_owners: object = (
        [] if metadata.owner_references is None else metadata.owner_references
    )
    if not isinstance(raw_owners, list):
        raise _contract_error()
    owner_values = cast(list[object], raw_owners)
    if not all(isinstance(owner, V1OwnerReference) for owner in owner_values):
        raise _contract_error()
    for owner in cast(list[V1OwnerReference], owner_values):
        owner_view = cast(_OwnerReferenceView, owner)
        api_version = _required_string(owner_view.api_version)
        kind = _required_string(owner_view.kind)
        _required_string(owner_view.name)
        uid = _required_string(owner_view.uid)
        controller = owner_view.controller
        if controller is not None and not isinstance(controller, bool):
            raise _contract_error()
        if (
            controller is True
            and api_version == expected_api_version
            and kind == expected_kind
            and uid in expected_uids
        ):
            return owner_view
    return None


def _project_pod(
    associated: _AssociatedPod,
    state: _SanitizationState,
) -> PodSummary:
    pod = associated.pod
    pod_view = cast(_PodView, pod)
    metadata = _metadata(pod_view.metadata)
    status = pod_view.status
    if status is not None and not isinstance(status, V1PodStatus):
        raise _contract_error()
    status_view = None if status is None else cast(_PodStatusView, status)
    raw_conditions: object = (
        []
        if status_view is None or status_view.conditions is None
        else status_view.conditions
    )
    raw_container_statuses: object = (
        []
        if status_view is None or status_view.container_statuses is None
        else status_view.container_statuses
    )
    if not isinstance(raw_conditions, list) or not isinstance(
        raw_container_statuses, list
    ):
        raise _contract_error()
    condition_values = cast(list[object], raw_conditions)
    container_status_values = cast(list[object], raw_container_statuses)
    if not all(isinstance(condition, V1PodCondition) for condition in condition_values):
        raise _contract_error()
    if not all(
        isinstance(container_status, V1ContainerStatus)
        for container_status in container_status_values
    ):
        raise _contract_error()
    conditions = cast(list[V1PodCondition], condition_values)
    container_statuses = cast(list[V1ContainerStatus], container_status_values)
    projected_conditions = sorted(
        (_project_sdk_condition(condition, state) for condition in conditions),
        key=lambda condition: (
            condition.type,
            condition.status,
            condition.reason or "",
        ),
    )
    containers = sorted(
        (_project_pod_container(container, state) for container in container_statuses),
        key=lambda container: container.name,
    )
    owner = associated.owner
    return PodSummary(
        api_version="v1",
        kind="Pod",
        namespace=_required_string(metadata.namespace),
        name=_required_string(metadata.name),
        uid=_required_string(metadata.uid),
        resource_version=_required_string(metadata.resource_version),
        owner=OwnerSummary(
            api_version=_required_string(owner.api_version),
            kind=_required_string(owner.kind),
            name=_required_string(owner.name),
            uid=_required_string(owner.uid),
            controller=owner.controller is True,
        ),
        phase=state.optional(None if status_view is None else status_view.phase),
        conditions=projected_conditions,
        containers=containers,
    )


def _crash_loop_log_targets(
    associations: _Associations,
) -> list[_ContainerLogTarget]:
    targets: list[_ContainerLogTarget] = []
    for associated in associations.pods:
        pod_view = cast(_PodView, associated.pod)
        metadata = _metadata(pod_view.metadata)
        status = pod_view.status
        if status is None:
            continue
        if not isinstance(status, V1PodStatus):
            raise _contract_error()
        raw_statuses = cast(_PodStatusView, status).container_statuses
        if raw_statuses is None:
            continue
        if not isinstance(raw_statuses, list) or not all(
            isinstance(item, V1ContainerStatus)
            for item in cast(list[object], raw_statuses)
        ):
            raise _contract_error()
        spec_names = _pod_container_names(associated.pod)
        owner = associated.owner
        owner_summary = OwnerSummary(
            api_version=_required_string(owner.api_version),
            kind=_required_string(owner.kind),
            name=_required_string(owner.name),
            uid=_required_string(owner.uid),
            controller=owner.controller is True,
        )
        for container_status in cast(list[V1ContainerStatus], raw_statuses):
            container_view = cast(_ContainerStatusView, container_status)
            name = _required_string(container_view.name)
            if name not in spec_names:
                raise _contract_error()
            state = container_view.state
            if not isinstance(state, V1ContainerState):
                continue
            waiting = cast(_ContainerStateView, state).waiting
            if not isinstance(waiting, V1ContainerStateWaiting):
                continue
            reason = cast(_ContainerStateDetailView, waiting).reason
            restart_count = _nonnegative_int(container_view.restart_count)
            if reason == "CrashLoopBackOff" and restart_count > 0:
                targets.append(
                    _ContainerLogTarget(
                        pod_name=_required_string(metadata.name),
                        pod_uid=_required_string(metadata.uid),
                        owner=owner_summary,
                        container_name=name,
                        restart_count=restart_count,
                    )
                )
    targets.sort(
        key=lambda target: (
            target.pod_name,
            target.pod_uid,
            target.container_name,
        )
    )
    return targets


def _pod_container_names(pod: V1Pod) -> frozenset[str]:
    pod_view = cast(_PodView, pod)
    spec = pod_view.spec
    if not isinstance(spec, V1PodSpec):
        raise _contract_error()
    raw_containers = cast(_PodSpecView, spec).containers
    if not isinstance(raw_containers, list) or not all(
        isinstance(item, V1Container) for item in cast(list[object], raw_containers)
    ):
        raise _contract_error()
    names = [
        _required_string(cast(_WorkloadContainerView, container).name)
        for container in cast(list[V1Container], raw_containers)
    ]
    if len(set(names)) != len(names):
        raise _contract_error()
    return frozenset(names)


def _associated_container_identities(
    associations: _Associations,
) -> frozenset[tuple[str, str, str, str]]:
    identities: set[tuple[str, str, str, str]] = set()
    for associated in associations.pods:
        metadata = _metadata(cast(_PodView, associated.pod).metadata)
        pod_name = _required_string(metadata.name)
        pod_uid = _required_string(metadata.uid)
        owner_uid = _required_string(associated.owner.uid)
        for container_name in _pod_container_names(associated.pod):
            identity = (pod_name, pod_uid, owner_uid, container_name)
            if identity in identities:
                raise _contract_error()
            identities.add(identity)
    return frozenset(identities)


def _log_target_identity(target: _ContainerLogTarget) -> tuple[str, str, str, str]:
    return (
        target.pod_name,
        target.pod_uid,
        target.owner.uid,
        target.container_name,
    )


def _project_pod_container(
    container: V1ContainerStatus,
    state: _SanitizationState,
) -> PodContainer:
    container_view = cast(_ContainerStatusView, container)
    image_id = container_view.image_id
    return PodContainer(
        name=_required_string(container_view.name),
        image=state.required(container_view.image),
        image_id=(None if image_id in (None, "") else state.optional(image_id)),
        restart_count=_nonnegative_int(container_view.restart_count),
        state=_container_state(container_view.state, state),
    )


def _container_state(
    value: object,
    state: _SanitizationState,
) -> ContainerStateSummary:
    if value is None:
        return ContainerStateSummary(status="unknown", reason=None, message=None)
    if not isinstance(value, V1ContainerState):
        raise _contract_error()
    value_view = cast(_ContainerStateView, value)
    waiting = value_view.waiting
    running = value_view.running
    terminated = value_view.terminated
    alternatives = [
        waiting is not None,
        running is not None,
        terminated is not None,
    ]
    if sum(alternatives) > 1:
        raise _contract_error()
    if waiting is not None:
        if not isinstance(waiting, V1ContainerStateWaiting):
            raise _contract_error()
        waiting_view = cast(_ContainerStateDetailView, waiting)
        return ContainerStateSummary(
            status="waiting",
            reason=state.optional(waiting_view.reason),
            message=state.optional(waiting_view.message),
        )
    if running is not None:
        if not isinstance(running, V1ContainerStateRunning):
            raise _contract_error()
        return ContainerStateSummary(status="running", reason=None, message=None)
    if terminated is not None:
        if not isinstance(terminated, V1ContainerStateTerminated):
            raise _contract_error()
        terminated_view = cast(_ContainerStateDetailView, terminated)
        return ContainerStateSummary(
            status="terminated",
            reason=state.optional(terminated_view.reason),
            message=state.optional(terminated_view.message),
        )
    return ContainerStateSummary(status="unknown", reason=None, message=None)


def _event_regarding(event: EventsV1Event) -> RegardingSummary:
    event_view = cast(_EventView, event)
    regarding = event_view.regarding
    if not isinstance(regarding, V1ObjectReference):
        raise _contract_error()
    regarding_view = cast(_ObjectReferenceView, regarding)
    return RegardingSummary(
        api_version=_required_string(regarding_view.api_version),
        kind=_required_string(regarding_view.kind),
        namespace=_required_string(regarding_view.namespace),
        name=_required_string(regarding_view.name),
        uid=_required_string(regarding_view.uid),
    )


def _project_event(
    event: EventsV1Event,
    regarding: RegardingSummary,
    *,
    expected_namespace: str,
    state: _SanitizationState,
) -> EventSummary:
    event_view = cast(_EventView, event)
    _validate_list_item_type_meta(
        event_view.api_version,
        event_view.kind,
        expected_api_version="events.k8s.io/v1",
        expected_kind="Event",
    )
    metadata = _metadata(event_view.metadata)
    namespace = _required_string(metadata.namespace)
    if namespace != expected_namespace:
        raise _contract_error()
    return EventSummary(
        api_version="events.k8s.io/v1",
        kind="Event",
        namespace=namespace,
        name=_required_string(metadata.name),
        uid=_required_string(metadata.uid),
        resource_version=_required_string(metadata.resource_version),
        regarding=regarding,
        type=state.optional(event_view.type),
        reason=state.optional(event_view.reason),
        action=state.optional(event_view.action),
        note=state.optional(event_view.note),
        event_time=_optional_rfc3339(event_view.event_time),
        series_count=_event_series_count(event),
        reporting_controller=state.optional(event_view.reporting_controller),
    )


def _event_series_count(event: EventsV1Event) -> int:
    event_view = cast(_EventView, event)
    if event_view.series is not None:
        if not isinstance(event_view.series, EventsV1EventSeries):
            raise _contract_error()
        series_view = cast(_EventSeriesView, event_view.series)
        return _positive_int(series_view.count)
    if event_view.deprecated_count is not None:
        return _positive_int(event_view.deprecated_count)
    return 1


def _project_sdk_condition(
    condition: V1DeploymentCondition | V1PodCondition,
    state: _SanitizationState,
) -> ConditionSummary:
    condition_view = cast(_ConditionView, condition)
    return _project_condition(
        condition_view.type,
        condition_view.status,
        condition_view.reason,
        state,
    )


def _project_condition(
    condition_type: object,
    status: object,
    reason: object,
    state: _SanitizationState,
) -> ConditionSummary:
    return ConditionSummary(
        type=state.required(condition_type),
        status=state.required(status),
        reason=state.optional(reason),
    )


def _metadata(value: object) -> _MetadataView:
    if not isinstance(value, V1ObjectMeta):
        raise _contract_error()
    return cast(_MetadataView, value)


def _metadata_labels(metadata: _MetadataView) -> dict[str, str]:
    value = metadata.labels
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise _contract_error()
    raw_labels = cast(dict[object, object], value)
    labels: dict[str, str] = {}
    for raw_key, raw_value in raw_labels.items():
        key = _required_string(raw_key)
        label_value = _required_string(raw_value, allow_empty=True)
        if not _valid_label_key(key) or not _valid_label_value(label_value):
            raise _contract_error()
        labels[key] = label_value
    return labels


def _validate_list_item_type_meta(
    api_version: object,
    kind: object,
    *,
    expected_api_version: str,
    expected_kind: str,
) -> None:
    # List endpoints and their SDK item classes establish GVK when Kubernetes
    # omits TypeMeta; a conflicting value still indicates contract drift.
    if api_version not in (None, expected_api_version) or kind not in (
        None,
        expected_kind,
    ):
        raise _contract_error()


def _required_string(value: object, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value):
        raise _contract_error()
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise _contract_error()
    return value


def _nonnegative_int(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise _contract_error()
    return value


def _optional_nonnegative_int(value: object) -> int | None:
    if value is None:
        return None
    return _nonnegative_int(value)


def _optional_bool(value: object) -> bool | None:
    if value is None:
        return None
    if not isinstance(value, bool):
        raise _contract_error()
    return value


def _zero_if_missing(value: object) -> int:
    return 0 if value is None else _nonnegative_int(value)


def _positive_int(value: object) -> int:
    parsed = _nonnegative_int(value)
    if parsed == 0:
        raise _contract_error()
    return parsed


def _valid_label_key(value: str) -> bool:
    prefix, separator, name = value.rpartition("/")
    if not separator:
        return _valid_label_name(value)
    if not prefix or len(prefix) > 253 or not _valid_label_name(name):
        return False
    return all(_DNS_LABEL_PATTERN.fullmatch(part) for part in prefix.split("."))


def _valid_label_name(value: str) -> bool:
    return len(value) <= 63 and _LABEL_NAME_PATTERN.fullmatch(value) is not None


def _valid_label_value(value: str) -> bool:
    return value == "" or _valid_label_name(value)


def _optional_rfc3339(value: object) -> str | None:
    if value is None:
        return None
    if (
        not isinstance(value, datetime)
        or value.tzinfo is None
        or value.utcoffset() is None
    ):
        raise _contract_error()
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


async def _read_bounded_log_body(response: _LogResponseView) -> bytes:
    content = response.content
    remaining = LOG_RESPONSE_LIMIT_BYTES + 1
    chunks: list[bytes] = []
    while remaining > 0:
        chunk = await content.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    raw = b"".join(chunks)
    if len(raw) > LOG_RESPONSE_LIMIT_BYTES:
        raise _budget_error()
    return raw


def _normalize_log_lines(
    raw: bytes,
    state: _SanitizationState,
) -> list[ContainerLogLine]:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise _contract_error() from None
    raw_lines = text.splitlines()
    if len(raw_lines) > LOG_LINE_LIMIT:
        raise _budget_error()
    parsed_lines: list[tuple[datetime, str]] = []
    for index, raw_line in enumerate(raw_lines):
        timestamp, separator, message = raw_line.partition(" ")
        try:
            parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            if parsed.tzinfo is None or parsed.utcoffset() is None:
                raise ValueError
        except ValueError:
            if index == 0 and len(raw) == LOG_RESPONSE_LIMIT_BYTES:
                state.truncated = True
                continue
            raise _contract_error() from None
        if not separator:
            message = ""
        parsed_lines.append((parsed, message))

    if parsed_lines:
        sanitized_block = sanitize_untrusted_text(
            "\n".join(message for _, message in parsed_lines),
            max_code_points=CANONICAL_PAYLOAD_LIMIT_BYTES,
        )
        if sanitized_block.truncated:
            raise _budget_error()
        state.redacted = state.redacted or sanitized_block.redacted
        sanitized_messages = sanitized_block.value.split("\n")
        if len(sanitized_messages) != len(parsed_lines):
            raise _contract_error()
    else:
        sanitized_messages = []

    normalized: list[ContainerLogLine] = []
    for (parsed, _), message in zip(parsed_lines, sanitized_messages, strict=True):
        if len(message) > LOG_LINE_MAX_CODE_POINTS:
            message = message[:LOG_LINE_MAX_CODE_POINTS]
            state.truncated = True
        normalized.append(
            ContainerLogLine(
                timestamp=parsed,
                message=message,
            )
        )
    if len(raw) == LOG_RESPONSE_LIMIT_BYTES:
        state.truncated = True
    return normalized


def _api_status_exception(status: int) -> ApiException:
    return ApiException(status=status)


def _observation_time(clock: Callable[[], datetime]) -> datetime:
    value = clock()
    if value.tzinfo is None or value.utcoffset() is None:
        raise _contract_error()
    return value.astimezone(UTC)


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _enforce_payload_budget(
    payload: (
        WorkloadPayload
        | PodsPayload
        | EventsPayload
        | ContainerLogsPayload
        | ServiceNetworkPayload
    ),
) -> None:
    value = cast(JsonValue, payload.model_dump(mode="json", by_alias=True))
    if len(canonical_json(value).encode("utf-8")) > CANONICAL_PAYLOAD_LIMIT_BYTES:
        raise _budget_error()


def _contract_error() -> KubernetesBoundaryError:
    return KubernetesBoundaryError(KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID)


def _budget_error() -> KubernetesBoundaryError:
    return KubernetesBoundaryError(KubernetesErrorCode.RESULT_BUDGET_EXCEEDED)
