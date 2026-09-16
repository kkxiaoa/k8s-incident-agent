from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import cast

import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    Configuration,
    EventsV1Event,
    EventsV1EventList,
    V1ListMeta,
    V1ObjectMeta,
    V1ObjectReference,
    V1PersistentVolumeClaim,
    V1PersistentVolumeClaimCondition,
    V1PersistentVolumeClaimSpec,
    V1PersistentVolumeClaimStatus,
    V1StorageClass,
    V1VolumeResourceRequirements,
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
    api_version="v1",
    kind="PersistentVolumeClaim",
    name="pvc-binding-pending",
)
OBSERVED_AT = datetime(2026, 9, 4, 8, 0, tzinfo=UTC)


def _claim(
    storage_class_name: str | None,
    *,
    phase: str = "Pending",
    selected_node: str | None = None,
) -> V1PersistentVolumeClaim:
    annotations = (
        None
        if selected_node is None
        else {"volume.kubernetes.io/selected-node": selected_node}
    )
    return V1PersistentVolumeClaim(
        api_version="v1",
        kind="PersistentVolumeClaim",
        metadata=V1ObjectMeta(
            namespace=TARGET.namespace,
            name=TARGET.name,
            uid="claim-uid",
            resource_version="42",
            annotations=annotations,
        ),
        spec=V1PersistentVolumeClaimSpec(
            access_modes=["ReadWriteOnce"],
            resources=V1VolumeResourceRequirements(requests={"storage": "1Mi"}),
            storage_class_name=storage_class_name,
            volume_name="must-not-be-projected",
        ),
        status=V1PersistentVolumeClaimStatus(
            phase=phase,
            conditions=[
                V1PersistentVolumeClaimCondition(
                    type="FileSystemResizePending",
                    status="False",
                    reason="WaitingForConsumer",
                    message="must-not-be-projected",
                )
            ],
        ),
    )


def _storage_class(
    name: str,
    *,
    binding_mode: str | None = "WaitForFirstConsumer",
) -> V1StorageClass:
    return V1StorageClass(
        api_version="storage.k8s.io/v1",
        kind="StorageClass",
        metadata=V1ObjectMeta(
            name=name,
            uid="storage-class-uid",
            resource_version="84",
            annotations={
                "storageclass.kubernetes.io/is-default-class": "TRUE",
                "storage.example/secret": "must-not-be-projected",
            },
        ),
        provisioner="example.csi.invalid",
        parameters={"secretName": "must-not-be-projected"},
        volume_binding_mode=binding_mode,
    )


def _event(
    name: str,
    uid: str,
    *,
    regarding_name: str = TARGET.name,
    regarding_uid: str = "claim-uid",
    occurred_at: datetime,
) -> EventsV1Event:
    configuration = Configuration()
    configuration.client_side_validation = False
    return EventsV1Event(
        api_version="events.k8s.io/v1",
        kind="Event",
        metadata=V1ObjectMeta(
            namespace=TARGET.namespace,
            name=name,
            uid=uid,
            resource_version=f"rv-{uid}",
        ),
        regarding=V1ObjectReference(
            api_version="v1",
            kind="PersistentVolumeClaim",
            namespace=TARGET.namespace,
            name=regarding_name,
            uid=regarding_uid,
        ),
        event_time=occurred_at,
        type="Warning",
        reason="ProvisioningFailed",
        action="Provisioning",
        note="storageclass token=secret was not found",
        reporting_controller="persistentvolume-controller",
        deprecated_count=2,
        local_vars_configuration=configuration,
    )


class _CoreApi:
    def __init__(self, claim: object) -> None:
        self.claim = claim
        self.calls: list[tuple[str, str, dict[str, object]]] = []

    async def read_namespaced_persistent_volume_claim(
        self,
        name: str,
        namespace: str,
        **kwargs: object,
    ) -> object:
        self.calls.append((name, namespace, kwargs))
        if isinstance(self.claim, Exception):
            raise self.claim
        return self.claim


class _StorageApi:
    def __init__(self, storage_class: object) -> None:
        self.storage_class = storage_class
        self.calls: list[tuple[str, dict[str, object]]] = []

    async def read_storage_class(self, name: str, **kwargs: object) -> object:
        self.calls.append((name, kwargs))
        if isinstance(self.storage_class, Exception):
            raise self.storage_class
        return self.storage_class


class _EventsApi:
    def __init__(self, events: list[EventsV1Event]) -> None:
        self.events = events
        self.calls: list[tuple[str, dict[str, object]]] = []

    async def list_namespaced_event(
        self,
        namespace: str,
        **kwargs: object,
    ) -> EventsV1EventList:
        self.calls.append((namespace, kwargs))
        return EventsV1EventList(metadata=V1ListMeta(), items=self.events)


def _adapter(
    claim: object,
    storage_class: object,
    events: list[EventsV1Event] | None = None,
) -> tuple[KubernetesEvidenceAdapter, _CoreApi, _StorageApi, _EventsApi]:
    core_api = _CoreApi(claim)
    storage_api = _StorageApi(storage_class)
    events_api = _EventsApi(events or [])
    clients = cast(
        KubernetesClients,
        SimpleNamespace(
            apps_api=object(),
            core_api=core_api,
            discovery_api=object(),
            events_api=events_api,
            storage_api=storage_api,
            timeout_seconds=10.0,
            cluster_id=TARGET.cluster,
            diagnostic_namespace=TARGET.namespace,
        ),
    )
    return (
        KubernetesEvidenceAdapter(clients, clock=lambda: OBSERVED_AT),
        core_api,
        storage_api,
        events_api,
    )


@pytest.mark.asyncio
async def test_read_pvc_storage_projects_only_exact_referenced_resources() -> None:
    class_name = "delayed-storage"
    earlier = _event(
        "event-a",
        "event-a-uid",
        occurred_at=datetime(2026, 9, 4, 7, 0, tzinfo=UTC),
    )
    later = _event(
        "event-z",
        "event-z-uid",
        occurred_at=datetime(2026, 9, 4, 7, 30, tzinfo=UTC),
    )
    unrelated = _event(
        "unrelated",
        "unrelated-uid",
        regarding_name="other-claim",
        regarding_uid="other-uid",
        occurred_at=datetime(2026, 9, 4, 6, 0, tzinfo=UTC),
    )
    adapter, core_api, storage_api, events_api = _adapter(
        _claim(class_name),
        _storage_class(class_name),
        [later, unrelated, earlier],
    )

    observation = await adapter.read_pvc_storage(TARGET)
    document = observation.model_dump(mode="json", by_alias=True)

    assert core_api.calls == [
        (TARGET.name, TARGET.namespace, {"_request_timeout": 10.0})
    ]
    assert storage_api.calls == [(class_name, {"_request_timeout": 10.0})]
    assert events_api.calls == [
        (
            TARGET.namespace,
            {"limit": 100, "timeout_seconds": 10, "_request_timeout": 10.0},
        )
    ]
    assert document["targetRef"] == {
        "apiVersion": "v1",
        "kind": "PersistentVolumeClaim",
        "namespace": TARGET.namespace,
        "name": TARGET.name,
        "uid": "claim-uid",
    }
    assert document["payload"] == {
        "persistentVolumeClaim": {
            "resourceVersion": "42",
            "phase": "Pending",
            "requestedStorageClass": {
                "mode": "explicit",
                "name": class_name,
            },
            "conditions": [
                {
                    "type": "FileSystemResizePending",
                    "status": "False",
                    "reason": "WaitingForConsumer",
                    "message": None,
                    "lastTransitionTime": None,
                }
            ],
        },
        "storageClassLookup": {
            "state": "found",
            "storageClass": {
                "name": class_name,
                "uid": "storage-class-uid",
                "resourceVersion": "84",
                "provisioner": "example.csi.invalid",
                "volumeBindingMode": "WaitForFirstConsumer",
                "isDefault": True,
            },
        },
        "events": [
            document["payload"]["events"][0],
            document["payload"]["events"][1],
        ],
    }
    assert [event["name"] for event in document["payload"]["events"]] == [
        "event-a",
        "event-z",
    ]
    assert "must-not-be-projected" not in str(document)
    assert "secret" not in str(document)
    assert observation.redacted is True


@pytest.mark.asyncio
async def test_missing_referenced_storage_class_is_successful_evidence() -> None:
    adapter, _, storage_api, _ = _adapter(
        _claim("missing-storage"),
        ApiException(status=404),
    )

    observation = await adapter.read_pvc_storage(TARGET)

    assert storage_api.calls == [("missing-storage", {"_request_timeout": 10.0})]
    assert observation.payload.storage_class_lookup.state == "not_found"
    assert observation.payload.storage_class_lookup.storage_class is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("storage_class_name", "mode"),
    [(None, "default"), ("", "none")],
)
async def test_default_and_explicit_empty_class_never_enumerate_storage_classes(
    storage_class_name: str | None,
    mode: str,
) -> None:
    adapter, _, storage_api, _ = _adapter(
        _claim(storage_class_name),
        AssertionError("StorageClass must not be read"),
    )

    observation = await adapter.read_pvc_storage(TARGET)

    assert storage_api.calls == []
    request = observation.payload.persistent_volume_claim.requested_storage_class
    assert request.mode == mode
    assert request.name is None
    assert observation.payload.storage_class_lookup.state == "not_requested"


@pytest.mark.asyncio
async def test_omitted_storage_class_binding_mode_normalizes_to_immediate() -> None:
    class_name = "implicit-immediate"
    adapter, _, _, _ = _adapter(
        _claim(class_name),
        _storage_class(class_name, binding_mode=None),
    )

    observation = await adapter.read_pvc_storage(TARGET)

    storage_class = observation.payload.storage_class_lookup.storage_class
    assert storage_class is not None
    assert storage_class.volume_binding_mode == "Immediate"


@pytest.mark.asyncio
@pytest.mark.parametrize("selected_node", [None, "kind-control-plane"])
async def test_wffc_consumer_scheduling_state_is_not_projected(
    selected_node: str | None,
) -> None:
    class_name = "delayed-storage"
    adapter, _, _, _ = _adapter(
        _claim(class_name, selected_node=selected_node),
        _storage_class(class_name),
    )

    observation = await adapter.read_pvc_storage(TARGET)
    document = observation.model_dump(mode="json", by_alias=True)

    storage_class = observation.payload.storage_class_lookup.storage_class
    assert storage_class is not None
    assert storage_class.volume_binding_mode == "WaitForFirstConsumer"
    assert "selected-node" not in str(document)


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["Pending", "Bound", "Lost"])
async def test_pvc_phase_preserves_the_kubernetes_contract(phase: str) -> None:
    adapter, _, _, _ = _adapter(
        _claim("storage", phase=phase),
        _storage_class("storage"),
    )

    observation = await adapter.read_pvc_storage(TARGET)

    assert observation.payload.persistent_volume_claim.phase == phase


@pytest.mark.asyncio
async def test_storage_class_permission_denial_preserves_failure_semantics() -> None:
    adapter, _, _, _ = _adapter(
        _claim("storage"),
        ApiException(status=403),
    )

    with pytest.raises(KubernetesBoundaryError) as captured:
        await adapter.read_pvc_storage(TARGET)

    assert captured.value.code is KubernetesErrorCode.PERMISSION_DENIED


@pytest.mark.asyncio
async def test_same_uid_with_different_pvc_identity_fails_closed() -> None:
    mismatched = _event(
        "mismatched",
        "event-uid",
        regarding_name="other-name",
        occurred_at=datetime(2026, 9, 4, 7, 0, tzinfo=UTC),
    )
    adapter, _, _, _ = _adapter(
        _claim("storage"),
        _storage_class("storage"),
        [mismatched],
    )

    with pytest.raises(KubernetesBoundaryError) as captured:
        await adapter.read_pvc_storage(TARGET)

    assert captured.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID
