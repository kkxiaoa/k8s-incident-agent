from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any, cast

import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    V1Container,
    V1ContainerState,
    V1ContainerStateRunning,
    V1ContainerStateTerminated,
    V1ContainerStateWaiting,
    V1ContainerStatus,
    V1Deployment,
    V1DeploymentSpec,
    V1LabelSelector,
    V1ListMeta,
    V1ObjectMeta,
    V1OwnerReference,
    V1Pod,
    V1PodCondition,
    V1PodList,
    V1PodSpec,
    V1PodStatus,
    V1PodTemplateSpec,
    V1ReplicaSet,
    V1ReplicaSetList,
)

from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.client import KubernetesClients
from k8s_incident_agent.scenarios.contracts import ScenarioTarget

TARGET = ScenarioTarget(
    cluster="k8s-incident-agent",
    namespace="k8s-incident-scenarios",
    api_version="apps/v1",
    kind="Deployment",
    name="image-pull-backoff",
)
OBSERVED_AT = datetime(2026, 8, 21, 9, 15, tzinfo=UTC)


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
            selector=V1LabelSelector(match_labels={"tier": "worker", "app": "bad"}),
            template=V1PodTemplateSpec(
                spec=V1PodSpec(containers=[V1Container(name="app")])
            ),
        ),
    )


def _owner(
    kind: str, name: str, uid: str, *, controller: bool = True
) -> V1OwnerReference:
    return V1OwnerReference(
        api_version="apps/v1",
        kind=kind,
        name=name,
        uid=uid,
        controller=controller,
    )


def _replica_set(
    name: str,
    uid: str,
    owner_uid: str,
    *,
    api_version: str | None = "apps/v1",
    kind: str | None = "ReplicaSet",
) -> V1ReplicaSet:
    return V1ReplicaSet(
        api_version=api_version,
        kind=kind,
        metadata=V1ObjectMeta(
            namespace=TARGET.namespace,
            name=name,
            uid=uid,
            resource_version=f"rv-{uid}",
            owner_references=[_owner("Deployment", TARGET.name, owner_uid)],
        ),
    )


def _container_status(
    name: str,
    state: V1ContainerState | None,
    *,
    image_id: str = "",
) -> V1ContainerStatus:
    return V1ContainerStatus(
        name=name,
        image=f"registry.invalid/{name}:v1",
        image_id=image_id,
        ready=False,
        restart_count=2,
        state=state,
    )


def _pod(
    name: str,
    uid: str,
    owner_uid: str,
    *,
    container_statuses: list[V1ContainerStatus] | None = None,
    api_version: str | None = "v1",
    kind: str | None = "Pod",
) -> V1Pod:
    return V1Pod(
        api_version=api_version,
        kind=kind,
        metadata=V1ObjectMeta(
            namespace=TARGET.namespace,
            name=name,
            uid=uid,
            resource_version=f"rv-{uid}",
            owner_references=[_owner("ReplicaSet", "rs-owned", owner_uid)],
        ),
        spec=V1PodSpec(containers=[V1Container(name="app")]),
        status=V1PodStatus(
            phase="Pending",
            conditions=[V1PodCondition(type="PodScheduled", status="True")],
            container_statuses=container_statuses,
        ),
    )


class _AppsApi:
    def __init__(self, pages: dict[str | None, V1ReplicaSetList]) -> None:
        self.pages = pages
        self.list_calls: list[dict[str, object]] = []
        self.read_calls = 0

    async def read_namespaced_deployment(self, **_: object) -> V1Deployment:
        self.read_calls += 1
        return _deployment()

    async def list_namespaced_replica_set(
        self,
        namespace: str,
        **kwargs: object,
    ) -> V1ReplicaSetList:
        self.list_calls.append(kwargs)
        return self.pages[cast(str | None, kwargs.get("_continue"))]


class _CoreApi:
    def __init__(self, pages: dict[str | None, V1PodList]) -> None:
        self.pages = pages
        self.list_calls: list[dict[str, object]] = []

    async def list_namespaced_pod(
        self,
        namespace: str,
        **kwargs: object,
    ) -> V1PodList:
        self.list_calls.append(kwargs)
        return self.pages[cast(str | None, kwargs.get("_continue"))]


def _adapter(
    apps_api: _AppsApi,
    core_api: _CoreApi,
) -> KubernetesEvidenceAdapter:
    clients = cast(
        KubernetesClients,
        SimpleNamespace(
            apps_api=apps_api,
            core_api=core_api,
            events_api=object(),
            timeout_seconds=10.0,
            cluster_id=TARGET.cluster,
            diagnostic_namespace=TARGET.namespace,
        ),
    )
    return KubernetesEvidenceAdapter(clients, clock=lambda: OBSERVED_AT)


@pytest.mark.asyncio
async def test_read_pods_paginates_filters_owner_uids_and_sorts_results() -> None:
    owned_rs = _replica_set("rs-owned", "rs-uid", "deployment-uid")
    unrelated_rs = _replica_set("rs-other", "other-rs-uid", "other-deployment")
    waiting = V1ContainerState(
        waiting=V1ContainerStateWaiting(
            reason="ImagePullBackOff",
            message="pull failed",
        )
    )
    running = V1ContainerState(running=V1ContainerStateRunning())
    later_pod = _pod(
        "z-pod",
        "pod-z",
        "rs-uid",
        container_statuses=[
            _container_status("sidecar", running, image_id="docker://sidecar"),
            _container_status("app", waiting),
        ],
    )
    earlier_pod = _pod("a-pod", "pod-a", "rs-uid", container_statuses=[])
    unrelated_pod = _pod("ignored", "pod-other", "other-rs-uid")
    apps_api = _AppsApi(
        {
            None: V1ReplicaSetList(
                metadata=V1ListMeta(_continue="rs-next"),
                items=[unrelated_rs],
            ),
            "rs-next": V1ReplicaSetList(
                metadata=V1ListMeta(),
                items=[owned_rs],
            ),
        }
    )
    core_api = _CoreApi(
        {
            None: V1PodList(
                metadata=V1ListMeta(_continue="pod-next"),
                items=[later_pod, unrelated_pod],
            ),
            "pod-next": V1PodList(
                metadata=V1ListMeta(),
                items=[earlier_pod],
            ),
        }
    )

    observation = await _adapter(apps_api, core_api).read_pods(TARGET)

    assert apps_api.read_calls == 1
    assert apps_api.list_calls == [
        {
            "label_selector": "app=bad,tier=worker",
            "limit": 100,
            "timeout_seconds": 10,
            "_request_timeout": 10.0,
        },
        {
            "label_selector": "app=bad,tier=worker",
            "limit": 100,
            "timeout_seconds": 10,
            "_request_timeout": 10.0,
            "_continue": "rs-next",
        },
    ]
    assert core_api.list_calls[1]["_continue"] == "pod-next"
    assert [pod.name for pod in observation.payload.pods] == ["a-pod", "z-pod"]
    z_pod = observation.payload.pods[1]
    assert [container.name for container in z_pod.containers] == ["app", "sidecar"]
    assert z_pod.containers[0].state.status == "waiting"
    assert z_pod.containers[0].state.reason == "ImagePullBackOff"
    assert z_pod.containers[1].state.status == "running"
    assert z_pod.owner.uid == "rs-uid"
    assert observation.payload.source_workload.resource_version == "42"
    assert observation.truncated is False
    assert observation.redacted is False


@pytest.mark.asyncio
async def test_read_pods_accepts_list_items_without_type_meta() -> None:
    replica_set = _replica_set(
        "rs-owned",
        "rs-uid",
        "deployment-uid",
        api_version=None,
        kind=None,
    )
    pod = _pod(
        "pod-owned",
        "pod-uid",
        "rs-uid",
        container_statuses=[],
        api_version=None,
        kind=None,
    )
    apps_api = _AppsApi(
        {
            None: V1ReplicaSetList(
                metadata=V1ListMeta(),
                items=[replica_set],
            )
        }
    )
    core_api = _CoreApi({None: V1PodList(metadata=V1ListMeta(), items=[pod])})

    observation = await _adapter(apps_api, core_api).read_pods(TARGET)

    normalized = observation.payload.pods[0]
    assert normalized.api_version == "v1"
    assert normalized.kind == "Pod"
    assert normalized.owner.api_version == "apps/v1"
    assert normalized.owner.kind == "ReplicaSet"


@pytest.mark.asyncio
async def test_read_pods_normalizes_empty_and_missing_optional_collections() -> None:
    apps_api = _AppsApi(
        {
            None: V1ReplicaSetList(
                metadata=V1ListMeta(),
                items=[_replica_set("rs-owned", "rs-uid", "deployment-uid")],
            )
        }
    )
    pod = _pod("empty-status", "pod-empty", "rs-uid", container_statuses=None)
    pod_status: Any = cast(Any, pod).status
    pod_status.conditions = None
    pod_status.phase = None
    core_api = _CoreApi({None: V1PodList(metadata=V1ListMeta(), items=[pod])})

    observation = await _adapter(apps_api, core_api).read_pods(TARGET)
    normalized = observation.payload.pods[0]

    assert normalized.phase is None
    assert normalized.conditions == []
    assert normalized.containers == []


@pytest.mark.asyncio
async def test_read_pods_normalizes_terminated_and_unknown_container_states() -> None:
    apps_api = _AppsApi(
        {
            None: V1ReplicaSetList(
                metadata=V1ListMeta(),
                items=[_replica_set("rs-owned", "rs-uid", "deployment-uid")],
            )
        }
    )
    pod = _pod(
        "states",
        "pod-states",
        "rs-uid",
        container_statuses=[
            _container_status("unknown", None),
            _container_status(
                "terminated",
                V1ContainerState(
                    terminated=V1ContainerStateTerminated(
                        exit_code=1,
                        reason="Error",
                        message="password=container-secret",
                    )
                ),
            ),
        ],
    )
    core_api = _CoreApi({None: V1PodList(metadata=V1ListMeta(), items=[pod])})

    observation = await _adapter(apps_api, core_api).read_pods(TARGET)
    containers = observation.payload.pods[0].containers

    assert containers[0].state.status == "terminated"
    assert containers[0].state.message == "password=[REDACTED]"
    assert containers[1].state.status == "unknown"
    assert containers[1].state.reason is None
    assert observation.redacted is True


@pytest.mark.asyncio
async def test_read_pods_marks_truncated_container_messages() -> None:
    apps_api = _AppsApi(
        {
            None: V1ReplicaSetList(
                metadata=V1ListMeta(),
                items=[_replica_set("rs-owned", "rs-uid", "deployment-uid")],
            )
        }
    )
    pod = _pod(
        "long-message",
        "pod-long",
        "rs-uid",
        container_statuses=[
            _container_status(
                "app",
                V1ContainerState(waiting=V1ContainerStateWaiting(message="界" * 2049)),
            )
        ],
    )
    core_api = _CoreApi({None: V1PodList(metadata=V1ListMeta(), items=[pod])})

    observation = await _adapter(apps_api, core_api).read_pods(TARGET)

    assert len(observation.payload.pods[0].containers[0].state.message or "") == 2048
    assert observation.truncated is True
