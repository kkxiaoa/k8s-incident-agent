from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import cast

import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    V1Container,
    V1Deployment,
    V1DeploymentSpec,
    V1LabelSelector,
    V1ListMeta,
    V1ObjectMeta,
    V1OwnerReference,
    V1PodSpec,
    V1PodTemplateSpec,
    V1ReplicaSet,
    V1ReplicaSetList,
    V1ReplicaSetSpec,
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
OBSERVED_AT = datetime(2026, 9, 6, 9, 30, tzinfo=UTC)


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
            selector=V1LabelSelector(
                match_labels={"tier": "worker", "app": "image-pull"}
            ),
            template=V1PodTemplateSpec(
                spec=V1PodSpec(
                    containers=[
                        V1Container(
                            name="workload",
                            image="registry.invalid/workload:v2",
                            image_pull_policy="Always",
                        )
                    ]
                )
            ),
        ),
    )


def _owner(uid: str, *, name: str = TARGET.name) -> V1OwnerReference:
    return V1OwnerReference(
        api_version="apps/v1",
        kind="Deployment",
        name=name,
        uid=uid,
        controller=True,
    )


def _replica_set(
    name: str,
    uid: str,
    revision: str | None,
    containers: list[tuple[str, str]],
    *,
    owner_uid: str = "deployment-uid",
    owner_name: str = TARGET.name,
    api_version: str | None = "apps/v1",
    kind: str | None = "ReplicaSet",
) -> V1ReplicaSet:
    annotations = (
        None if revision is None else {"deployment.kubernetes.io/revision": revision}
    )
    return V1ReplicaSet(
        api_version=api_version,
        kind=kind,
        metadata=V1ObjectMeta(
            namespace=TARGET.namespace,
            name=name,
            uid=uid,
            resource_version=f"rv-{uid}",
            annotations=annotations,
            owner_references=[_owner(owner_uid, name=owner_name)],
        ),
        spec=V1ReplicaSetSpec(
            replicas=1,
            selector=V1LabelSelector(match_labels={"app": "image-pull"}),
            template=V1PodTemplateSpec(
                spec=V1PodSpec(
                    containers=[
                        V1Container(name=container_name, image=image)
                        for container_name, image in containers
                    ]
                )
            ),
        ),
    )


class _AppsApi:
    def __init__(self, replica_sets: object) -> None:
        self.replica_sets = replica_sets
        self.read_calls: list[dict[str, object]] = []
        self.list_calls: list[dict[str, object]] = []

    async def read_namespaced_deployment(self, **kwargs: object) -> V1Deployment:
        self.read_calls.append(kwargs)
        return _deployment()

    async def list_namespaced_replica_set(self, **kwargs: object) -> object:
        self.list_calls.append(kwargs)
        if isinstance(self.replica_sets, BaseException):
            raise self.replica_sets
        return self.replica_sets


class _CoreApi:
    def __init__(self) -> None:
        self.list_calls = 0

    async def list_namespaced_pod(self, **_: object) -> object:
        self.list_calls += 1
        raise AssertionError("rollout history must not list Pods")


def _adapter(apps_api: _AppsApi, core_api: _CoreApi) -> KubernetesEvidenceAdapter:
    clients = cast(
        KubernetesClients,
        SimpleNamespace(
            apps_api=apps_api,
            core_api=core_api,
            discovery_api=object(),
            events_api=object(),
            storage_api=object(),
            timeout_seconds=10.0,
            cluster_id=TARGET.cluster,
            diagnostic_namespace=TARGET.namespace,
        ),
    )
    return KubernetesEvidenceAdapter(clients, clock=lambda: OBSERVED_AT)


@pytest.mark.asyncio
async def test_read_rollout_history_is_owner_bound_sorted_and_minimal() -> None:
    faulty = _replica_set(
        "image-pull-backoff-new",
        "rs-new",
        "3",
        [
            ("workload", "registry.invalid/k8s-incident-agent/missing:v1"),
            ("telemetry", "registry.example/telemetry:v2"),
        ],
    )
    healthy = _replica_set(
        "image-pull-backoff-old",
        "rs-old",
        "1",
        [
            ("workload", "registry.k8s.io/e2e-test-images/agnhost:2.53"),
            ("telemetry", "registry.example/telemetry:v1"),
        ],
        api_version=None,
        kind=None,
    )
    stale_owner = _replica_set(
        "image-pull-backoff-stale",
        "rs-stale",
        "99",
        [("workload", "registry.example/stale:v99")],
        owner_uid="recreated-deployment-uid",
    )
    apps_api = _AppsApi(
        V1ReplicaSetList(
            metadata=V1ListMeta(),
            items=[healthy, stale_owner, faulty],
        )
    )
    core_api = _CoreApi()

    observation = await _adapter(apps_api, core_api).read_rollout_history(TARGET)

    assert apps_api.read_calls == [
        {
            "name": TARGET.name,
            "namespace": TARGET.namespace,
            "_request_timeout": 10.0,
        }
    ]
    assert apps_api.list_calls == [
        {
            "namespace": TARGET.namespace,
            "label_selector": "app=image-pull,tier=worker",
            "limit": 100,
            "timeout_seconds": 10,
            "_request_timeout": 10.0,
        }
    ]
    assert core_api.list_calls == 0
    assert observation.evidence_kind == "rollout_history"
    assert observation.target_ref.uid == "deployment-uid"
    assert observation.payload.source_workload.resource_version == "42"
    assert [item.revision for item in observation.payload.revisions] == [3, 1]
    assert [item.replica_set_ref.uid for item in observation.payload.revisions] == [
        "rs-new",
        "rs-old",
    ]
    assert [
        (container.name, container.image)
        for container in observation.payload.revisions[0].containers
    ] == [
        ("telemetry", "registry.example/telemetry:v2"),
        ("workload", "registry.invalid/k8s-incident-agent/missing:v1"),
    ]
    assert observation.truncated is False
    assert observation.redacted is False


@pytest.mark.asyncio
async def test_read_rollout_history_returns_explicit_empty_history() -> None:
    unrelated = _replica_set(
        "unrelated",
        "rs-unrelated",
        "1",
        [("workload", "registry.example/unrelated:v1")],
        owner_uid="other-deployment-uid",
    )
    apps_api = _AppsApi(V1ReplicaSetList(metadata=V1ListMeta(), items=[unrelated]))

    observation = await _adapter(apps_api, _CoreApi()).read_rollout_history(TARGET)

    assert observation.payload.revisions == []
    assert observation.payload.source_workload.resource_version == "42"


@pytest.mark.asyncio
async def test_read_rollout_history_rejects_duplicate_revisions() -> None:
    replica_sets = [
        _replica_set("first", "rs-first", "2", [("workload", "good:v1")]),
        _replica_set("second", "rs-second", "2", [("workload", "bad:v2")]),
    ]

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(
            _AppsApi(V1ReplicaSetList(metadata=V1ListMeta(), items=replica_sets)),
            _CoreApi(),
        ).read_rollout_history(TARGET)

    assert error.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
async def test_read_rollout_history_rejects_ambiguous_container_names() -> None:
    ambiguous = _replica_set(
        "ambiguous",
        "rs-ambiguous",
        "2",
        [("workload", "good:v1"), ("workload", "bad:v2")],
    )

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(
            _AppsApi(V1ReplicaSetList(metadata=V1ListMeta(), items=[ambiguous])),
            _CoreApi(),
        ).read_rollout_history(TARGET)

    assert error.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "revision",
    [None, "", "0", "01", "+1", "-1", "bad", "9223372036854775808"],
)
async def test_read_rollout_history_rejects_untrusted_revisions(
    revision: str | None,
) -> None:
    replica_set = _replica_set(
        "untrusted",
        "rs-untrusted",
        revision,
        [("workload", "registry.example/workload:v1")],
    )

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(
            _AppsApi(V1ReplicaSetList(metadata=V1ListMeta(), items=[replica_set])),
            _CoreApi(),
        ).read_rollout_history(TARGET)

    assert error.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
async def test_read_rollout_history_rejects_owner_name_drift() -> None:
    drifted = _replica_set(
        "drifted",
        "rs-drifted",
        "2",
        [("workload", "registry.example/workload:v2")],
        owner_name="another-deployment",
    )

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(
            _AppsApi(V1ReplicaSetList(metadata=V1ListMeta(), items=[drifted])),
            _CoreApi(),
        ).read_rollout_history(TARGET)

    assert error.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
async def test_read_rollout_history_preserves_permission_failure() -> None:
    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(
            _AppsApi(ApiException(status=403)), _CoreApi()
        ).read_rollout_history(TARGET)

    assert error.value.code is KubernetesErrorCode.PERMISSION_DENIED
