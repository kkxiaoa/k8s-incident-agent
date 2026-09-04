from __future__ import annotations

from types import SimpleNamespace
from typing import cast

import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    V1ContainerState,
    V1ContainerStateWaiting,
    V1ContainerStatus,
    V1ListMeta,
    V1Pod,
    V1PodList,
    V1PodStatus,
    V1ReplicaSetList,
)
from tests.unit.kubernetes.test_adapter_pods import (
    OBSERVED_AT,
    TARGET,
    _AppsApi,  # pyright: ignore[reportPrivateUsage]
    _container_status,  # pyright: ignore[reportPrivateUsage]
    _pod,  # pyright: ignore[reportPrivateUsage]
    _replica_set,  # pyright: ignore[reportPrivateUsage]
)

from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.client import KubernetesClients
from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    KubernetesErrorCode,
)


class _LogContent:
    def __init__(self, body: bytes) -> None:
        self._body = body
        self.read_sizes: list[int] = []

    async def read(self, size: int) -> bytes:
        self.read_sizes.append(size)
        chunk = self._body[:size]
        self._body = self._body[size:]
        return chunk


class _LogResponse:
    def __init__(self, status: int, body: bytes = b"") -> None:
        self.status = status
        self.content = _LogContent(body)
        self.released = False

    def release(self) -> None:
        self.released = True


class _CoreApi:
    def __init__(
        self,
        pods: list[V1Pod],
        responses: dict[bool, _LogResponse] | None = None,
        *,
        rebound_pods: list[V1Pod] | None = None,
    ) -> None:
        self._pods = pods
        self._rebound_pods = rebound_pods or pods
        self._responses = responses or {}
        self.list_calls: list[dict[str, object]] = []
        self.log_calls: list[tuple[str, str, dict[str, object]]] = []

    async def list_namespaced_pod(
        self,
        namespace: str,
        **kwargs: object,
    ) -> V1PodList:
        del namespace
        self.list_calls.append(kwargs)
        pods = self._pods if len(self.list_calls) == 1 else self._rebound_pods
        return V1PodList(metadata=V1ListMeta(), items=pods)

    async def read_namespaced_pod_log(
        self,
        name: str,
        namespace: str,
        **kwargs: object,
    ) -> _LogResponse:
        self.log_calls.append((name, namespace, kwargs))
        return self._responses[cast(bool, kwargs["previous"])]


def _crash_loop_pod(*, uid: str = "pod-uid") -> V1Pod:
    return _pod(
        "crash-pod",
        uid,
        "rs-uid",
        container_statuses=[
            _container_status(
                "app",
                V1ContainerState(
                    waiting=V1ContainerStateWaiting(reason="CrashLoopBackOff")
                ),
            )
        ],
    )


def _adapter(
    core_api: _CoreApi,
) -> tuple[KubernetesEvidenceAdapter, _AppsApi]:
    apps_api = _AppsApi(
        {
            None: V1ReplicaSetList(
                metadata=V1ListMeta(),
                items=[_replica_set("rs-owned", "rs-uid", "deployment-uid")],
            )
        }
    )
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
    return KubernetesEvidenceAdapter(clients, clock=lambda: OBSERVED_AT), apps_api


@pytest.mark.asyncio
async def test_read_container_logs_uses_fixed_bounds_and_normalizes_snapshots() -> None:
    current = _LogResponse(
        200,
        b"2026-08-21T09:14:58Z startup token=container-secret\n",
    )
    previous = _LogResponse(
        200,
        b"2026-08-21T09:14:00+00:00 unknown command\n",
    )
    core_api = _CoreApi(
        [_crash_loop_pod()],
        {False: current, True: previous},
    )
    adapter, apps_api = _adapter(core_api)

    observation = await adapter.read_container_logs(TARGET)

    assert apps_api.read_calls == 2
    assert len(apps_api.list_calls) == 2
    assert len(core_api.list_calls) == 2
    assert core_api.log_calls == [
        (
            "crash-pod",
            TARGET.namespace,
            {
                "container": "app",
                "follow": False,
                "insecure_skip_tls_verify_backend": False,
                "limit_bytes": 4096,
                "previous": False,
                "since_seconds": 600,
                "tail_lines": 80,
                "timestamps": True,
                "_preload_content": False,
                "_request_timeout": 10.0,
            },
        ),
        (
            "crash-pod",
            TARGET.namespace,
            {
                "container": "app",
                "follow": False,
                "insecure_skip_tls_verify_backend": False,
                "limit_bytes": 4096,
                "previous": True,
                "since_seconds": 600,
                "tail_lines": 80,
                "timestamps": True,
                "_preload_content": False,
                "_request_timeout": 10.0,
            },
        ),
    ]
    assert [item.source for item in observation.payload.containers[0].snapshots] == [
        "current",
        "previous",
    ]
    assert observation.payload.containers[0].snapshots[0].lines[0].message == (
        "startup token=[REDACTED]"
    )
    assert observation.payload.containers[0].snapshots[1].lines[0].timestamp == (
        OBSERVED_AT.replace(minute=14, second=0)
    )
    assert observation.redacted is True
    assert observation.truncated is False
    assert current.released is True
    assert previous.released is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        (
            b"2026-08-21T09:14:56Z -----BEGIN PRIVATE KEY-----\n"
            b"2026-08-21T09:14:57Z private-material\n"
            b"2026-08-21T09:14:58Z -----END PRIVATE KEY-----\n"
        ),
        (
            b"2026-08-21T09:14:57Z -----BEGIN PRIVATE KEY-----\n"
            b"2026-08-21T09:14:58Z private-material\n"
        ),
    ],
)
async def test_read_container_logs_redacts_timestamped_multiline_pem(
    body: bytes,
) -> None:
    core_api = _CoreApi(
        [_crash_loop_pod()],
        {False: _LogResponse(200, body), True: _LogResponse(200)},
    )
    adapter, _ = _adapter(core_api)

    observation = await adapter.read_container_logs(TARGET)

    serialized = observation.model_dump_json()
    current = observation.payload.containers[0].snapshots[0]
    assert len(current.lines) == len(body.splitlines())
    assert current.lines[0].message == "[REDACTED]"
    assert observation.redacted is True
    assert "private-material" not in serialized


@pytest.mark.asyncio
async def test_read_container_logs_projects_known_unavailable_snapshots() -> None:
    current = _LogResponse(400)
    previous = _LogResponse(400)
    core_api = _CoreApi(
        [_crash_loop_pod()],
        {False: current, True: previous},
    )
    adapter, _ = _adapter(core_api)

    observation = await adapter.read_container_logs(TARGET)

    snapshots = observation.payload.containers[0].snapshots
    assert [(item.source, item.status, item.lines) for item in snapshots] == [
        ("current", "container_not_started", []),
        ("previous", "previous_unavailable", []),
    ]
    assert current.released is True
    assert previous.released is True


@pytest.mark.asyncio
async def test_read_container_logs_distinguishes_an_empty_snapshot_window() -> None:
    current = _LogResponse(200)
    previous = _LogResponse(
        200,
        b"2026-08-21T09:14:00Z previous failure\n",
    )
    core_api = _CoreApi(
        [_crash_loop_pod()],
        {False: current, True: previous},
    )
    adapter, _ = _adapter(core_api)

    observation = await adapter.read_container_logs(TARGET)

    snapshots = observation.payload.containers[0].snapshots
    assert snapshots[0].status == "no_logs_in_window"
    assert snapshots[0].lines == []
    assert snapshots[1].status == "available"


@pytest.mark.asyncio
async def test_read_container_logs_skips_non_crashloop_pods_without_rebinding() -> None:
    pod = _crash_loop_pod()
    status = cast(V1PodStatus, getattr(pod, "status"))  # noqa: B009
    container_statuses = cast(
        list[V1ContainerStatus],
        getattr(status, "container_statuses"),  # noqa: B009
    )
    state = cast(
        V1ContainerState,
        getattr(container_statuses[0], "state"),  # noqa: B009
    )
    waiting = cast(
        V1ContainerStateWaiting,
        getattr(state, "waiting"),  # noqa: B009
    )
    waiting.reason = "ImagePullBackOff"
    core_api = _CoreApi([pod])
    adapter, apps_api = _adapter(core_api)

    observation = await adapter.read_container_logs(TARGET)

    assert observation.payload.containers == []
    assert apps_api.read_calls == 1
    assert len(apps_api.list_calls) == 1
    assert len(core_api.list_calls) == 1
    assert core_api.log_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response", "expected_code"),
    [
        (_LogResponse(404), KubernetesErrorCode.RESOURCE_NOT_FOUND),
        (
            _LogResponse(200, b"x" * 4097),
            KubernetesErrorCode.RESULT_BUDGET_EXCEEDED,
        ),
        (
            _LogResponse(200, b"missing-timestamp\n"),
            KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID,
        ),
    ],
)
async def test_read_container_logs_fails_closed_on_bad_responses(
    response: _LogResponse,
    expected_code: KubernetesErrorCode,
) -> None:
    core_api = _CoreApi(
        [_crash_loop_pod()],
        {False: response, True: _LogResponse(200)},
    )
    adapter, _ = _adapter(core_api)

    with pytest.raises(KubernetesBoundaryError) as error:
        await adapter.read_container_logs(TARGET)

    assert error.value.code is expected_code
    assert response.released is True


@pytest.mark.asyncio
async def test_read_container_logs_rejects_pod_identity_drift() -> None:
    core_api = _CoreApi(
        [_crash_loop_pod()],
        {
            False: _LogResponse(200, b"2026-08-21T09:14:58Z current\n"),
            True: _LogResponse(200, b"2026-08-21T09:14:00Z previous\n"),
        },
        rebound_pods=[_crash_loop_pod(uid="replacement-pod-uid")],
    )
    adapter, _ = _adapter(core_api)

    with pytest.raises(KubernetesBoundaryError) as error:
        await adapter.read_container_logs(TARGET)

    assert error.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID
