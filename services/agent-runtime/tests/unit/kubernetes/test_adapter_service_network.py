from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import cast

import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    V1Endpoint,
    V1EndpointConditions,
    V1EndpointSlice,
    V1EndpointSliceList,
    V1ListMeta,
    V1ObjectMeta,
    V1OwnerReference,
    V1Pod,
    V1PodCondition,
    V1PodList,
    V1PodStatus,
    V1Service,
    V1ServiceSpec,
)

from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.client import KubernetesClients
from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    KubernetesErrorCode,
)
from k8s_incident_agent.scenarios.contracts import ScenarioTarget

TARGET = ScenarioTarget(
    cluster="k8s-incident-agent",
    namespace="k8s-incident-scenarios",
    api_version="v1",
    kind="Service",
    name="service-selector-mismatch",
)
OBSERVED_AT = datetime(2026, 9, 4, 8, 0, tzinfo=UTC)
ASSOCIATION_LABEL = "k8s-incident-agent.io/service"
MONITORING_LABEL = "k8s-incident-agent.io/monitor-selector"


class _CoreApi:
    def __init__(self, service: object, pods: list[V1Pod]) -> None:
        self.service = service
        self.pods = pods
        self.service_calls: list[tuple[str, str, dict[str, object]]] = []
        self.pod_calls: list[tuple[str, dict[str, object]]] = []

    async def read_namespaced_service(
        self,
        name: str,
        namespace: str,
        **kwargs: object,
    ) -> object:
        self.service_calls.append((name, namespace, kwargs))
        return self.service

    async def list_namespaced_pod(
        self,
        namespace: str,
        **kwargs: object,
    ) -> object:
        self.pod_calls.append((namespace, kwargs))
        return V1PodList(metadata=V1ListMeta(_continue=None), items=self.pods)


class _DiscoveryApi:
    def __init__(self, endpoint_slices: list[V1EndpointSlice]) -> None:
        self.endpoint_slices = endpoint_slices
        self.calls: list[tuple[str, dict[str, object]]] = []

    async def list_namespaced_endpoint_slice(
        self,
        namespace: str,
        **kwargs: object,
    ) -> object:
        self.calls.append((namespace, kwargs))
        return V1EndpointSliceList(
            metadata=V1ListMeta(_continue=None),
            items=self.endpoint_slices,
        )


def _service(
    *,
    selector: dict[str, str] | None = None,
    service_type: str = "ClusterIP",
    cluster_ip: str | None = "10.96.0.20",
    monitoring_enabled: bool = True,
    publish_not_ready: bool = False,
) -> V1Service:
    labels = {MONITORING_LABEL: "true"} if monitoring_enabled else {}
    return V1Service(
        api_version="v1",
        kind="Service",
        metadata=V1ObjectMeta(
            namespace=TARGET.namespace,
            name=TARGET.name,
            uid="service-uid",
            resource_version="17",
            labels=labels,
        ),
        spec=V1ServiceSpec(
            type=service_type,
            cluster_ip=cluster_ip,
            external_name=(
                "outside.example" if service_type == "ExternalName" else None
            ),
            selector={"app": "expected"} if selector is None else selector,
            publish_not_ready_addresses=publish_not_ready,
        ),
    )


def _pod(
    name: str,
    *,
    app: str = "actual",
    association: str = TARGET.name,
    ready: str = "True",
) -> V1Pod:
    return V1Pod(
        api_version="v1",
        kind="Pod",
        metadata=V1ObjectMeta(
            namespace=TARGET.namespace,
            name=name,
            uid=f"{name}-uid",
            resource_version="21",
            labels={ASSOCIATION_LABEL: association, "app": app, "ignored": "value"},
        ),
        status=V1PodStatus(conditions=[V1PodCondition(type="Ready", status=ready)]),
    )


def _endpoint_slice(
    *,
    name: str | None = None,
    service_uid: str = "service-uid",
    ready: bool | None = False,
    endpoint_count: int = 1,
) -> V1EndpointSlice:
    slice_name = name or f"{TARGET.name}-abcde"
    return V1EndpointSlice(
        api_version="discovery.k8s.io/v1",
        kind="EndpointSlice",
        metadata=V1ObjectMeta(
            namespace=TARGET.namespace,
            name=slice_name,
            uid=f"{slice_name}-uid",
            resource_version="23",
            labels={"kubernetes.io/service-name": TARGET.name},
            owner_references=[
                V1OwnerReference(
                    api_version="v1",
                    kind="Service",
                    name=TARGET.name,
                    uid=service_uid,
                    controller=True,
                )
            ],
        ),
        address_type="IPv4",
        endpoints=[
            V1Endpoint(
                addresses=[f"10.244.{index // 250}.{index % 250 + 1}"],
                conditions=V1EndpointConditions(
                    ready=ready,
                    serving=False,
                    terminating=False,
                ),
            )
            for index in range(endpoint_count)
        ],
    )


def _adapter(
    service: object,
    pods: list[V1Pod],
    endpoint_slices: list[V1EndpointSlice],
    *,
    clock: Callable[[], datetime] = lambda: OBSERVED_AT,
) -> tuple[KubernetesEvidenceAdapter, _CoreApi, _DiscoveryApi]:
    core_api = _CoreApi(service, pods)
    discovery_api = _DiscoveryApi(endpoint_slices)
    clients = cast(
        KubernetesClients,
        SimpleNamespace(
            apps_api=object(),
            core_api=core_api,
            discovery_api=discovery_api,
            events_api=object(),
            storage_api=object(),
            timeout_seconds=10.0,
            cluster_id=TARGET.cluster,
            diagnostic_namespace=TARGET.namespace,
        ),
    )
    return KubernetesEvidenceAdapter(clients, clock=clock), core_api, discovery_api


@pytest.mark.asyncio
async def test_projects_selector_mismatch_without_addresses_or_unrelated_labels() -> (
    None
):
    adapter, core_api, discovery_api = _adapter(
        _service(),
        [_pod("candidate-b"), _pod("candidate-a", ready="False")],
        [_endpoint_slice()],
    )

    observation = await adapter.read_service_network(TARGET)

    assert core_api.service_calls == [
        (TARGET.name, TARGET.namespace, {"_request_timeout": 10.0})
    ]
    assert core_api.pod_calls == [
        (
            TARGET.namespace,
            {
                "limit": 100,
                "timeout_seconds": 10,
                "_request_timeout": 10.0,
                "label_selector": f"{ASSOCIATION_LABEL}={TARGET.name}",
            },
        )
    ]
    assert discovery_api.calls == [
        (
            TARGET.namespace,
            {
                "limit": 100,
                "timeout_seconds": 10,
                "_request_timeout": 10.0,
                "label_selector": f"kubernetes.io/service-name={TARGET.name}",
            },
        )
    ]
    document = observation.model_dump(mode="json", by_alias=True)
    assert document["targetRef"] == {
        "apiVersion": "v1",
        "kind": "Service",
        "namespace": TARGET.namespace,
        "name": TARGET.name,
        "uid": "service-uid",
    }
    assert document["payload"]["summary"] == {
        "state": "selector_mismatch",
        "candidateCount": 2,
        "selectorMatchCount": 0,
        "endpointSliceCount": 1,
        "readyEndpointCount": 0,
    }
    assert [pod["podRef"]["name"] for pod in document["payload"]["candidatePods"]] == [
        "candidate-a",
        "candidate-b",
    ]
    assert all(
        pod["selectorLabels"] == {"app": "actual"}
        for pod in document["payload"]["candidatePods"]
    )
    assert "addresses" not in str(document)
    assert "ignored" not in str(document)


@pytest.mark.asyncio
async def test_normalizes_null_endpoints_from_empty_endpoint_slice() -> None:
    endpoint_slice = _endpoint_slice()
    endpoint_slice.endpoints = None
    adapter, _, _ = _adapter(
        _service(),
        [_pod("candidate")],
        [endpoint_slice],
    )

    observation = await adapter.read_service_network(TARGET)

    assert observation.payload.summary.state == "selector_mismatch"
    assert observation.payload.summary.endpoint_slice_count == 1
    assert observation.payload.summary.ready_endpoint_count == 0
    assert observation.payload.endpoint_slices[0].endpoint_count == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("service", "pods", "slices", "expected_state"),
    [
        (
            _service(monitoring_enabled=False),
            [_pod("candidate")],
            [],
            "monitoring_not_enabled",
        ),
        (
            _service(service_type="ExternalName", cluster_ip=None),
            [_pod("candidate")],
            [],
            "external_name",
        ),
        (_service(cluster_ip="None"), [_pod("candidate")], [], "headless"),
        (
            _service(publish_not_ready=True),
            [_pod("candidate")],
            [],
            "publish_not_ready",
        ),
        (_service(selector={}), [_pod("candidate")], [], "no_selector"),
        (_service(), [], [], "no_candidates"),
        (_service(), [_pod("candidate", app="expected")], [], "endpoints_unready"),
        (
            _service(),
            [_pod("candidate", app="expected")],
            [_endpoint_slice(ready=True)],
            "endpoints_ready",
        ),
    ],
)
async def test_classifies_exclusions_and_non_mismatch_states(
    service: V1Service,
    pods: list[V1Pod],
    slices: list[V1EndpointSlice],
    expected_state: str,
) -> None:
    adapter, _, _ = _adapter(service, pods, slices)

    observation = await adapter.read_service_network(TARGET)

    assert observation.payload.summary.state == expected_state


@pytest.mark.asyncio
async def test_external_name_state_does_not_project_the_dns_address() -> None:
    adapter, _, _ = _adapter(
        _service(service_type="ExternalName", cluster_ip=None),
        [_pod("candidate")],
        [],
    )

    observation = await adapter.read_service_network(TARGET)
    document = observation.model_dump(mode="json", by_alias=True)

    assert observation.payload.summary.state == "external_name"
    assert "outside.example" not in str(document)
    assert "externalName" not in document["payload"]["service"]


@pytest.mark.asyncio
async def test_rejects_endpoint_slice_owned_by_another_service() -> None:
    adapter, _, _ = _adapter(
        _service(),
        [_pod("candidate")],
        [_endpoint_slice(service_uid="other-service-uid")],
    )

    with pytest.raises(KubernetesBoundaryError) as captured:
        await adapter.read_service_network(TARGET)

    assert captured.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
async def test_rejects_candidate_budget_before_persisting_evidence() -> None:
    adapter, _, _ = _adapter(
        _service(),
        [_pod(f"candidate-{index}") for index in range(33)],
        [],
    )

    with pytest.raises(KubernetesBoundaryError) as captured:
        await adapter.read_service_network(TARGET)

    assert captured.value.code is KubernetesErrorCode.RESULT_BUDGET_EXCEEDED


@pytest.mark.asyncio
async def test_rejects_service_selector_label_budget() -> None:
    adapter, _, _ = _adapter(
        _service(selector={f"key-{index}": "value" for index in range(17)}),
        [_pod("candidate")],
        [],
    )

    with pytest.raises(KubernetesBoundaryError) as captured:
        await adapter.read_service_network(TARGET)

    assert captured.value.code is KubernetesErrorCode.RESULT_BUDGET_EXCEEDED


@pytest.mark.asyncio
async def test_rejects_endpoint_slice_budget() -> None:
    adapter, _, _ = _adapter(
        _service(),
        [_pod("candidate")],
        [_endpoint_slice(name=f"slice-{index}") for index in range(65)],
    )

    with pytest.raises(KubernetesBoundaryError) as captured:
        await adapter.read_service_network(TARGET)

    assert captured.value.code is KubernetesErrorCode.RESULT_BUDGET_EXCEEDED


@pytest.mark.asyncio
async def test_rejects_total_endpoint_budget() -> None:
    adapter, _, _ = _adapter(
        _service(),
        [_pod("candidate")],
        [_endpoint_slice(endpoint_count=257)],
    )

    with pytest.raises(KubernetesBoundaryError) as captured:
        await adapter.read_service_network(TARGET)

    assert captured.value.code is KubernetesErrorCode.RESULT_BUDGET_EXCEEDED
