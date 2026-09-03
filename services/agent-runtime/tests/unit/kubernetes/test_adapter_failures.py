from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any, cast

import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    EventsV1Event,
    EventsV1EventList,
    V1Container,
    V1Deployment,
    V1DeploymentSpec,
    V1LabelSelector,
    V1ListMeta,
    V1ObjectMeta,
    V1ObjectReference,
    V1OwnerReference,
    V1Pod,
    V1PodList,
    V1PodSpec,
    V1PodTemplateSpec,
    V1ReplicaSet,
    V1ReplicaSetList,
)
from kubernetes.aio.client.exceptions import (  # pyright: ignore[reportMissingTypeStubs]
    ApiException,
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
    api_version="apps/v1",
    kind="Deployment",
    name="image-pull-backoff",
)


def _deployment() -> V1Deployment:
    return V1Deployment(
        api_version="apps/v1",
        kind="Deployment",
        metadata=V1ObjectMeta(
            namespace=TARGET.namespace,
            name=TARGET.name,
            uid="deployment-uid",
            resource_version="42",
        ),
        spec=V1DeploymentSpec(
            replicas=1,
            selector=V1LabelSelector(match_labels={"app": "bad"}),
            template=V1PodTemplateSpec(
                spec=V1PodSpec(
                    containers=[
                        V1Container(
                            name="app",
                            image="bad:v1",
                            image_pull_policy="Always",
                        )
                    ]
                )
            ),
        ),
    )


def _owner(kind: str, name: str, uid: str) -> V1OwnerReference:
    return V1OwnerReference(
        api_version="apps/v1",
        kind=kind,
        name=name,
        uid=uid,
        controller=True,
    )


def _replica_set(
    index: int,
    *,
    owner_uid: str = "deployment-uid",
    api_version: str = "apps/v1",
    kind: str = "ReplicaSet",
) -> V1ReplicaSet:
    return V1ReplicaSet(
        api_version=api_version,
        kind=kind,
        metadata=V1ObjectMeta(
            namespace=TARGET.namespace,
            name=f"rs-{index}",
            uid=f"rs-{index}",
            resource_version=f"rs-rv-{index}",
            owner_references=[_owner("Deployment", TARGET.name, owner_uid)],
        ),
    )


def _pod(
    index: int,
    *,
    owner_uid: str = "rs-0",
    api_version: str = "v1",
    kind: str = "Pod",
) -> V1Pod:
    return V1Pod(
        api_version=api_version,
        kind=kind,
        metadata=V1ObjectMeta(
            namespace=TARGET.namespace,
            name=f"pod-{index}",
            uid=f"pod-{index}",
            resource_version=f"pod-rv-{index}",
            owner_references=[_owner("ReplicaSet", "rs-0", owner_uid)],
        ),
        spec=V1PodSpec(containers=[V1Container(name="app")]),
    )


def _event(index: int, *, note: str | None = None) -> EventsV1Event:
    return EventsV1Event(
        api_version="events.k8s.io/v1",
        kind="Event",
        metadata=V1ObjectMeta(
            namespace=TARGET.namespace,
            name=f"event-{index}",
            uid=f"event-{index}",
            resource_version=f"event-rv-{index}",
        ),
        regarding=V1ObjectReference(
            api_version="v1",
            kind="Pod",
            namespace=TARGET.namespace,
            name="pod-0",
            uid="pod-0",
        ),
        event_time=datetime(2026, 8, 21, 10, 0, index % 60, tzinfo=UTC),
        note=note,
    )


class _AppsApi:
    def __init__(
        self,
        *,
        deployment: object | BaseException | None = None,
        replica_sets: object | BaseException | None = None,
    ) -> None:
        self.deployment = _deployment() if deployment is None else deployment
        self.replica_sets = (
            V1ReplicaSetList(metadata=V1ListMeta(), items=[])
            if replica_sets is None
            else replica_sets
        )
        self.read_calls = 0
        self.list_calls = 0

    async def read_namespaced_deployment(self, **_: object) -> object:
        self.read_calls += 1
        if isinstance(self.deployment, BaseException):
            raise self.deployment
        return self.deployment

    async def list_namespaced_replica_set(self, **_: object) -> object:
        self.list_calls += 1
        if isinstance(self.replica_sets, BaseException):
            raise self.replica_sets
        return self.replica_sets


class _CoreApi:
    def __init__(self, pods: object | BaseException | None = None) -> None:
        self.pods = V1PodList(metadata=V1ListMeta(), items=[]) if pods is None else pods
        self.calls = 0

    async def list_namespaced_pod(self, **_: object) -> object:
        self.calls += 1
        if isinstance(self.pods, BaseException):
            raise self.pods
        return self.pods


class _EventsApi:
    def __init__(self, events: object | BaseException | None = None) -> None:
        self.events = (
            EventsV1EventList(metadata=V1ListMeta(), items=[])
            if events is None
            else events
        )
        self.calls = 0

    async def list_namespaced_event(self, **_: object) -> object:
        self.calls += 1
        if isinstance(self.events, BaseException):
            raise self.events
        return self.events


def _adapter(
    apps_api: _AppsApi,
    *,
    core_api: _CoreApi | None = None,
    events_api: _EventsApi | None = None,
) -> KubernetesEvidenceAdapter:
    clients = cast(
        KubernetesClients,
        SimpleNamespace(
            apps_api=apps_api,
            core_api=core_api or _CoreApi(),
            discovery_api=object(),
            events_api=events_api or _EventsApi(),
            timeout_seconds=10.0,
            cluster_id=TARGET.cluster,
            diagnostic_namespace=TARGET.namespace,
        ),
    )
    return KubernetesEvidenceAdapter(
        clients,
        clock=lambda: datetime(2026, 8, 21, 10, 30, tzinfo=UTC),
    )


@pytest.mark.asyncio
async def test_only_target_deployment_get_maps_404_to_resource_not_found() -> None:
    apps_api = _AppsApi(deployment=ApiException(status=404, reason="secret-body"))

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(apps_api).read_workload(TARGET)

    assert error.value.code is KubernetesErrorCode.RESOURCE_NOT_FOUND
    assert error.value.retryable is False
    assert "secret-body" not in repr(error.value)
    assert apps_api.read_calls == 1


@pytest.mark.asyncio
async def test_list_404_keeps_the_existing_upstream_contract_classification() -> None:
    apps_api = _AppsApi(replica_sets=ApiException(status=404))

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(apps_api).read_pods(TARGET)

    assert error.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
async def test_timeout_is_mapped_once_without_an_implicit_retry() -> None:
    apps_api = _AppsApi(deployment=TimeoutError("sensitive timeout detail"))

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(apps_api).read_workload(TARGET)

    assert error.value.code is KubernetesErrorCode.REQUEST_TIMEOUT
    assert apps_api.read_calls == 1
    assert "sensitive timeout detail" not in repr(error.value)


@pytest.mark.asyncio
async def test_wrong_sdk_response_type_is_rejected() -> None:
    apps_api = _AppsApi(deployment={"kind": "Deployment"})

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(apps_api).read_workload(TARGET)

    assert error.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
async def test_replica_set_with_incompatible_type_fields_is_rejected() -> None:
    apps_api = _AppsApi(
        replica_sets=V1ReplicaSetList(
            metadata=V1ListMeta(),
            items=[_replica_set(0, api_version="v1", kind="Pod")],
        )
    )

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(apps_api).read_pods(TARGET)

    assert error.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
async def test_events_reject_a_pod_with_incompatible_type_fields() -> None:
    apps_api = _AppsApi(
        replica_sets=V1ReplicaSetList(
            metadata=V1ListMeta(),
            items=[_replica_set(0)],
        )
    )
    core_api = _CoreApi(
        V1PodList(
            metadata=V1ListMeta(),
            items=[_pod(0, api_version="apps/v1", kind="ReplicaSet")],
        )
    )

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(apps_api, core_api=core_api).read_events(TARGET)

    assert error.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.parametrize(
    ("field", "value"),
    (("api_version", "v1"), ("kind", "Secret")),
)
@pytest.mark.asyncio
async def test_events_reject_incompatible_nonempty_type_meta(
    field: str,
    value: str,
) -> None:
    event = _event(0)
    setattr(cast(Any, event), field, value)
    apps_api = _AppsApi(
        replica_sets=V1ReplicaSetList(
            metadata=V1ListMeta(),
            items=[_replica_set(0)],
        )
    )
    core_api = _CoreApi(V1PodList(metadata=V1ListMeta(), items=[_pod(0)]))
    events_api = _EventsApi(EventsV1EventList(metadata=V1ListMeta(), items=[event]))

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(
            apps_api,
            core_api=core_api,
            events_api=events_api,
        ).read_events(TARGET)

    assert error.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
async def test_malformed_controller_owner_reference_is_rejected() -> None:
    replica_set = _replica_set(0)
    metadata = cast(V1ObjectMeta, cast(Any, replica_set).metadata)
    owners = cast(
        list[V1OwnerReference],
        cast(Any, metadata).owner_references,
    )
    owners[0].controller = cast(bool, "true")
    apps_api = _AppsApi(
        replica_sets=V1ReplicaSetList(
            metadata=V1ListMeta(),
            items=[replica_set],
        )
    )

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(apps_api).read_pods(TARGET)

    assert error.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
async def test_a_continue_token_after_five_pages_exceeds_the_page_budget() -> None:
    page = V1ReplicaSetList(
        metadata=V1ListMeta(_continue="still-more"),
        items=[],
    )
    apps_api = _AppsApi(replica_sets=page)

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(apps_api).read_pods(TARGET)

    assert error.value.code is KubernetesErrorCode.RESULT_BUDGET_EXCEEDED
    assert apps_api.list_calls == 5


@pytest.mark.asyncio
async def test_more_than_one_hundred_associated_replica_sets_exceeds_budget() -> None:
    apps_api = _AppsApi(
        replica_sets=V1ReplicaSetList(
            metadata=V1ListMeta(),
            items=[_replica_set(index) for index in range(101)],
        )
    )

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(apps_api).read_pods(TARGET)

    assert error.value.code is KubernetesErrorCode.RESULT_BUDGET_EXCEEDED


@pytest.mark.asyncio
async def test_more_than_one_hundred_associated_pods_exceeds_budget() -> None:
    apps_api = _AppsApi(
        replica_sets=V1ReplicaSetList(
            metadata=V1ListMeta(),
            items=[_replica_set(0)],
        )
    )
    core_api = _CoreApi(
        V1PodList(
            metadata=V1ListMeta(),
            items=[_pod(index) for index in range(101)],
        )
    )

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(apps_api, core_api=core_api).read_pods(TARGET)

    assert error.value.code is KubernetesErrorCode.RESULT_BUDGET_EXCEEDED


@pytest.mark.asyncio
async def test_more_than_two_hundred_associated_events_exceeds_budget() -> None:
    apps_api = _AppsApi(
        replica_sets=V1ReplicaSetList(
            metadata=V1ListMeta(),
            items=[_replica_set(0)],
        )
    )
    core_api = _CoreApi(V1PodList(metadata=V1ListMeta(), items=[_pod(0)]))
    events_api = _EventsApi(
        EventsV1EventList(
            metadata=V1ListMeta(),
            items=[_event(index) for index in range(201)],
        )
    )

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(
            apps_api,
            core_api=core_api,
            events_api=events_api,
        ).read_events(TARGET)

    assert error.value.code is KubernetesErrorCode.RESULT_BUDGET_EXCEEDED


@pytest.mark.asyncio
async def test_canonical_payload_larger_than_sixty_four_kib_is_rejected() -> None:
    apps_api = _AppsApi(
        replica_sets=V1ReplicaSetList(
            metadata=V1ListMeta(),
            items=[_replica_set(0)],
        )
    )
    core_api = _CoreApi(V1PodList(metadata=V1ListMeta(), items=[_pod(0)]))
    events_api = _EventsApi(
        EventsV1EventList(
            metadata=V1ListMeta(),
            items=[_event(index, note="x" * 2048) for index in range(40)],
        )
    )

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(
            apps_api,
            core_api=core_api,
            events_api=events_api,
        ).read_events(TARGET)

    assert error.value.code is KubernetesErrorCode.RESULT_BUDGET_EXCEEDED
    assert error.value.retryable is False
