from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, cast

import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    Configuration,
    EventsV1Event,
    EventsV1EventList,
    EventsV1EventSeries,
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
OBSERVED_AT = datetime(2026, 8, 21, 9, 30, tzinfo=UTC)


def _owner(kind: str, name: str, uid: str) -> V1OwnerReference:
    return V1OwnerReference(
        api_version="apps/v1",
        kind=kind,
        name=name,
        uid=uid,
        controller=True,
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
                spec=V1PodSpec(containers=[V1Container(name="app")])
            ),
        ),
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


def _pod(
    name: str,
    uid: str,
    owner_uid: str,
    *,
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
    )


def _event(
    name: str,
    uid: str,
    regarding: V1ObjectReference,
    event_time: datetime | None,
    *,
    api_version: str | None = "events.k8s.io/v1",
    kind: str | None = "Event",
    note: str | None = None,
    series_count: int | None = None,
    deprecated_count: int | None = None,
    include_optional_scalars: bool = True,
) -> EventsV1Event:
    configuration = Configuration()
    configuration.client_side_validation = event_time is not None
    return EventsV1Event(
        api_version=api_version,
        kind=kind,
        metadata=V1ObjectMeta(
            namespace=TARGET.namespace,
            name=name,
            uid=uid,
            resource_version=f"rv-{uid}",
        ),
        regarding=regarding,
        event_time=event_time,
        type="Warning" if include_optional_scalars else None,
        reason="Failed" if include_optional_scalars else None,
        action="Pulling" if include_optional_scalars else None,
        note=note,
        reporting_controller=("kubelet" if include_optional_scalars else None),
        series=(
            EventsV1EventSeries(
                count=series_count,
                last_observed_time=event_time,
            )
            if series_count is not None
            else None
        ),
        deprecated_count=deprecated_count,
        local_vars_configuration=configuration,
    )


def _reference(kind: str, name: str, uid: str) -> V1ObjectReference:
    return V1ObjectReference(
        api_version="apps/v1" if kind != "Pod" else "v1",
        kind=kind,
        namespace=TARGET.namespace,
        name=name,
        uid=uid,
    )


class _AppsApi:
    def __init__(self, replica_sets: list[V1ReplicaSet]) -> None:
        self.replica_sets = replica_sets
        self.read_calls = 0
        self.list_calls = 0

    async def read_namespaced_deployment(self, **_: object) -> V1Deployment:
        self.read_calls += 1
        return _deployment()

    async def list_namespaced_replica_set(
        self,
        namespace: str,
        **_: object,
    ) -> V1ReplicaSetList:
        self.list_calls += 1
        return V1ReplicaSetList(
            metadata=V1ListMeta(),
            items=self.replica_sets,
        )


class _CoreApi:
    def __init__(self, pods: list[V1Pod]) -> None:
        self.pods = pods
        self.calls = 0

    async def list_namespaced_pod(
        self,
        namespace: str,
        **_: object,
    ) -> V1PodList:
        self.calls += 1
        return V1PodList(metadata=V1ListMeta(), items=self.pods)


class _EventsApi:
    def __init__(self, pages: dict[str | None, EventsV1EventList]) -> None:
        self.pages = pages
        self.calls: list[dict[str, object]] = []

    async def list_namespaced_event(
        self,
        namespace: str,
        **kwargs: object,
    ) -> EventsV1EventList:
        self.calls.append(kwargs)
        return self.pages[cast(str | None, kwargs.get("_continue"))]


def _adapter(
    apps_api: _AppsApi,
    core_api: _CoreApi,
    events_api: _EventsApi,
) -> KubernetesEvidenceAdapter:
    clients = cast(
        KubernetesClients,
        SimpleNamespace(
            apps_api=apps_api,
            core_api=core_api,
            discovery_api=object(),
            events_api=events_api,
            storage_api=object(),
            timeout_seconds=10.0,
            cluster_id=TARGET.cluster,
            diagnostic_namespace=TARGET.namespace,
        ),
    )
    return KubernetesEvidenceAdapter(clients, clock=lambda: OBSERVED_AT)


@pytest.mark.asyncio
async def test_read_events_rebuilds_associations_filters_and_sorts() -> None:
    owned_rs = _replica_set("rs-owned", "rs-uid", "deployment-uid")
    unrelated_rs = _replica_set("rs-other", "other-rs", "other-deployment")
    owned_pod = _pod("pod-owned", "pod-uid", "rs-uid")
    unrelated_pod = _pod("pod-other", "pod-other", "other-rs")
    later = _event(
        "z-event",
        "event-z",
        _reference("Pod", "pod-owned", "pod-uid"),
        datetime(2026, 8, 21, 10, 0, tzinfo=timezone(timedelta(hours=2))),
        note="token=event-secret",
        series_count=7,
        deprecated_count=5,
    )
    cast(Any, later).regarding.field_path = "spec.containers{app}"
    cast(Any, later).series.last_observed_time = OBSERVED_AT
    earlier = _event(
        "a-event",
        "event-a",
        _reference("Deployment", TARGET.name, "deployment-uid"),
        datetime(2026, 8, 21, 7, 0, tzinfo=UTC),
        deprecated_count=3,
    )
    unrelated = _event(
        "ignored",
        "event-other",
        _reference("Pod", "pod-other", "pod-other"),
        datetime(2026, 8, 21, 6, 0, tzinfo=UTC),
    )
    apps_api = _AppsApi([unrelated_rs, owned_rs])
    core_api = _CoreApi([unrelated_pod, owned_pod])
    events_api = _EventsApi(
        {
            None: EventsV1EventList(
                metadata=V1ListMeta(_continue="events-next"),
                items=[later, unrelated],
            ),
            "events-next": EventsV1EventList(
                metadata=V1ListMeta(),
                items=[earlier],
            ),
        }
    )

    observation = await _adapter(apps_api, core_api, events_api).read_events(TARGET)

    assert apps_api.read_calls == 1
    assert apps_api.list_calls == 1
    assert core_api.calls == 1
    assert events_api.calls == [
        {"limit": 100, "timeout_seconds": 10, "_request_timeout": 10.0},
        {
            "limit": 100,
            "timeout_seconds": 10,
            "_request_timeout": 10.0,
            "_continue": "events-next",
        },
    ]
    assert observation.payload.associated_replica_set_count == 1
    assert observation.payload.associated_pod_count == 1
    assert [event.name for event in observation.payload.events] == [
        "a-event",
        "z-event",
    ]
    assert observation.payload.events[0].series_count == 3
    assert observation.payload.events[1].series_count == 7
    assert observation.payload.events[1].event_time == "2026-08-21T08:00:00Z"
    assert observation.payload.events[1].last_observed_time == "2026-08-21T09:30:00Z"
    assert observation.payload.events[1].container == "app"
    assert observation.payload.events[1].note == "token=[REDACTED]"
    assert observation.redacted is True


@pytest.mark.asyncio
async def test_read_events_accepts_captured_nullable_list_item_fields() -> None:
    owned_rs = _replica_set(
        "rs-owned",
        "rs-uid",
        "deployment-uid",
        api_version=None,
        kind=None,
    )
    owned_pod = _pod(
        "pod-owned",
        "pod-uid",
        "rs-uid",
        api_version=None,
        kind=None,
    )
    event = _event(
        "pull-failed",
        "event-uid",
        _reference("Pod", "pod-owned", "pod-uid"),
        None,
        api_version=None,
        kind=None,
        deprecated_count=1,
    )
    events_api = _EventsApi(
        {None: EventsV1EventList(metadata=V1ListMeta(), items=[event])}
    )

    observation = await _adapter(
        _AppsApi([owned_rs]),
        _CoreApi([owned_pod]),
        events_api,
    ).read_events(TARGET)

    normalized = observation.payload.events[0]
    assert normalized.api_version == "events.k8s.io/v1"
    assert normalized.kind == "Event"
    assert normalized.event_time is None
    assert normalized.series_count == 1


@pytest.mark.asyncio
async def test_read_events_uses_one_when_series_and_deprecated_counts_are_absent() -> (
    None
):
    owned_rs = _replica_set("rs-owned", "rs-uid", "deployment-uid")
    owned_pod = _pod("pod-owned", "pod-uid", "rs-uid")
    event = _event(
        "minimal",
        "event-minimal",
        _reference("Pod", "pod-owned", "pod-uid"),
        datetime(2026, 8, 21, 7, 0, tzinfo=UTC),
        include_optional_scalars=False,
    )
    events_api = _EventsApi(
        {None: EventsV1EventList(metadata=V1ListMeta(), items=[event])}
    )

    observation = await _adapter(
        _AppsApi([owned_rs]),
        _CoreApi([owned_pod]),
        events_api,
    ).read_events(TARGET)
    normalized = observation.payload.events[0]

    assert normalized.series_count == 1
    assert normalized.type is None
    assert normalized.reason is None
    assert normalized.action is None
    assert normalized.note is None
    assert normalized.reporting_controller is None


@pytest.mark.asyncio
async def test_read_events_treats_an_empty_event_list_as_success() -> None:
    events_api = _EventsApi({None: EventsV1EventList(metadata=V1ListMeta(), items=[])})

    observation = await _adapter(
        _AppsApi([]),
        _CoreApi([]),
        events_api,
    ).read_events(TARGET)

    assert observation.payload.events == []
    assert observation.payload.associated_replica_set_count == 0
    assert observation.payload.associated_pod_count == 0
    assert observation.truncated is False
    assert observation.redacted is False


@pytest.mark.parametrize(
    ("field", "invalid_value"),
    [
        ("api_version", "apps/v1"),
        ("kind", "Secret"),
        ("namespace", "other-namespace"),
        ("name", "other-pod"),
    ],
)
@pytest.mark.asyncio
async def test_read_events_rejects_an_associated_uid_with_another_identity(
    field: str,
    invalid_value: str,
) -> None:
    owned_rs = _replica_set("rs-owned", "rs-uid", "deployment-uid")
    owned_pod = _pod("pod-owned", "pod-uid", "rs-uid")
    regarding = _reference("Pod", "pod-owned", "pod-uid")
    setattr(cast(Any, regarding), field, invalid_value)
    event = _event(
        "invalid-regarding",
        "event-invalid-regarding",
        regarding,
        datetime(2026, 8, 21, 7, 0, tzinfo=UTC),
    )
    events_api = _EventsApi(
        {None: EventsV1EventList(metadata=V1ListMeta(), items=[event])}
    )

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(
            _AppsApi([owned_rs]),
            _CoreApi([owned_pod]),
            events_api,
        ).read_events(TARGET)

    assert error.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
async def test_read_events_rejects_an_event_outside_the_requested_namespace() -> None:
    owned_rs = _replica_set("rs-owned", "rs-uid", "deployment-uid")
    owned_pod = _pod("pod-owned", "pod-uid", "rs-uid")
    event = _event(
        "wrong-namespace",
        "event-wrong-namespace",
        _reference("Pod", "pod-owned", "pod-uid"),
        datetime(2026, 8, 21, 7, 0, tzinfo=UTC),
    )
    metadata = cast(V1ObjectMeta, cast(Any, event).metadata)
    metadata.namespace = "other-namespace"
    events_api = _EventsApi(
        {None: EventsV1EventList(metadata=V1ListMeta(), items=[event])}
    )

    with pytest.raises(KubernetesBoundaryError) as error:
        await _adapter(
            _AppsApi([owned_rs]),
            _CoreApi([owned_pod]),
            events_api,
        ).read_events(TARGET)

    assert error.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID
