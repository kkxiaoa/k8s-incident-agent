from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Any, cast

import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    EventsV1Event,
    EventsV1EventList,
    EventsV1EventSeries,
    V1ContainerState,
    V1ContainerStateRunning,
    V1ContainerStateTerminated,
    V1ContainerStateWaiting,
    V1ContainerStatus,
    V1ListMeta,
    V1ObjectMeta,
    V1ObjectReference,
    V1Pod,
    V1PodList,
    V1PodStatus,
    V1Probe,
    V1ReplicaSetList,
    V1TCPSocketAction,
)
from tests.unit.kubernetes.test_adapter_events import (
    _EventsApi,  # pyright: ignore[reportPrivateUsage]
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


def _terminated_pod(*, uid: str = "pod-uid") -> V1Pod:
    # The kubelet serves a distinct previous generation only while the current
    # container has an id of its own; a container waiting to start has none.
    return _pod(
        "crash-pod",
        uid,
        "rs-uid",
        container_statuses=[
            _container_status(
                "app",
                V1ContainerState(
                    terminated=V1ContainerStateTerminated(
                        exit_code=1,
                        reason="Error",
                        started_at=OBSERVED_AT,
                        finished_at=OBSERVED_AT,
                    )
                ),
            )
        ],
    )


def _adapter(
    core_api: _CoreApi,
    events_api: _EventsApi | None = None,
    *,
    clock: Callable[[], datetime] = lambda: OBSERVED_AT,
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
            events_api=events_api or object(),
            storage_api=object(),
            timeout_seconds=10.0,
            cluster_id=TARGET.cluster,
            diagnostic_namespace=TARGET.namespace,
        ),
    )
    return KubernetesEvidenceAdapter(clients, clock=clock), apps_api


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
        [_terminated_pod()],
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
                "limit_bytes": 262144,
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
                "limit_bytes": 262144,
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
async def test_a_container_waiting_to_start_is_not_read_twice() -> None:
    # The kubelet resolves both reads to lastState.Terminated while a container
    # waits to start, so a previous read would repeat the current generation.
    current = _LogResponse(200, b"2026-08-21T09:14:58.000000001Z exit 1\n")
    previous = _LogResponse(200, b"2026-08-21T09:14:58.000000001Z exit 1\n")
    core_api = _CoreApi([_crash_loop_pod()], {False: current, True: previous})
    adapter, _ = _adapter(core_api)

    observation = await adapter.read_container_logs(TARGET)

    assert [call[2]["previous"] for call in core_api.log_calls] == [False]
    assert previous.released is False
    container = observation.payload.containers[0]
    assert container.selection_reason == "crash_loop"
    assert [(item.source, item.status) for item in container.snapshots] == [
        ("current", "available"),
        ("previous", "previous_unavailable"),
    ]
    assert [line.message for line in container.snapshots[0].lines] == ["exit 1"]
    assert container.snapshots[1].lines == []


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
        [_terminated_pod()],
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
        [_terminated_pod()],
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
            _LogResponse(200, b"x" * 262145),
            KubernetesErrorCode.RESULT_BUDGET_EXCEEDED,
        ),
        (
            _LogResponse(200, b"2026-08-21T09:14:58Z " + b"x" * 262123),
            KubernetesErrorCode.RESULT_BUDGET_EXCEEDED,
        ),
        (
            _LogResponse(200, b"2026-08-21T09:14:58Z line\n" * 81),
            KubernetesErrorCode.RESULT_BUDGET_EXCEEDED,
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


# The kubelet v1.36.1 log endpoint on the Kind baseline answered 200 with bodies
# of exactly these two shapes; the identifiers are replaced.
_KUBELET_CONTAINER_GONE = (
    b"unable to retrieve container logs for containerd://"
    b"0f6a3c1d9b7e4f52a8c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2"
)
_KUBELET_LOG_FILE_GONE = (
    b'failed to try resolving symlinks in path "/var/log/pods/'
    b'k8s-incident-scenarios_probe_5b1c/app/3.log": lstat /var/log/pods/'
    b"k8s-incident-scenarios_probe_5b1c/app/3.log: no such file or directory"
)


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [_KUBELET_CONTAINER_GONE, _KUBELET_LOG_FILE_GONE])
async def test_a_kubelet_failure_inside_the_previous_stream_is_unavailable(
    body: bytes,
) -> None:
    core_api = _CoreApi(
        [_crash_loop_pod()],
        {
            False: _LogResponse(200, b"2026-08-21T09:14:58.000000001Z boom\n"),
            True: _LogResponse(200, body),
        },
    )
    adapter, _ = _adapter(core_api)

    observation = await adapter.read_container_logs(TARGET)

    snapshots = observation.payload.containers[0].snapshots
    assert [(item.source, item.status, item.lines) for item in snapshots[1:]] == [
        ("previous", "previous_unavailable", []),
    ]
    assert snapshots[0].status == "available"
    assert observation.truncated is False


@pytest.mark.asyncio
async def test_a_kubelet_failure_inside_the_current_stream_is_retryable() -> None:
    core_api = _CoreApi(
        [_crash_loop_pod()],
        {False: _LogResponse(200, _KUBELET_CONTAINER_GONE), True: _LogResponse(400)},
    )
    adapter, _ = _adapter(core_api)

    with pytest.raises(KubernetesBoundaryError) as error:
        await adapter.read_container_logs(TARGET)

    assert error.value.code is KubernetesErrorCode.UPSTREAM_UNAVAILABLE
    assert error.value.retryable is True


@pytest.mark.asyncio
async def test_a_kubelet_failure_after_log_lines_keeps_them_and_hides_its_text() -> (
    None
):
    body = (
        b"2026-08-21T09:14:56.000000001Z\n" * 78
        + b"2026-08-21T09:14:57.000000001Z first\n"
        + b"2026-08-21T09:14:58.000000001Z second\n"
        + b'failed to read log file "/var/log/pods/ns_pod_uid/app/0.log": EOF'
    )
    core_api = _CoreApi(
        [_crash_loop_pod()],
        {False: _LogResponse(200, body), True: _LogResponse(400)},
    )
    adapter, _ = _adapter(core_api)

    observation = await adapter.read_container_logs(TARGET)

    current = observation.payload.containers[0].snapshots[0]
    assert [line.message for line in current.lines] == [""] * 78 + ["first", "second"]
    assert observation.truncated is True
    assert "/var/log/pods" not in observation.payload.model_dump_json()


@pytest.mark.asyncio
async def test_only_a_newline_ends_a_log_line() -> None:
    body = (
        "2026-08-21T09:14:57.000000001Z progress 10%\rprogress 20%\n"
        "2026-08-21T09:14:58.000000001Z left\u2028right\n"
        "2026-08-21T09:14:59.000000001Z next\x85line\n"
    ).encode()
    core_api = _CoreApi(
        [_crash_loop_pod()],
        {False: _LogResponse(200, body), True: _LogResponse(400)},
    )
    adapter, _ = _adapter(core_api)

    observation = await adapter.read_container_logs(TARGET)

    current = observation.payload.containers[0].snapshots[0]
    assert [line.message for line in current.lines] == [
        "progress 10%\rprogress 20%",
        "left\u2028right",
        "nextline",
    ]


@pytest.mark.asyncio
async def test_bytes_that_are_not_utf8_do_not_void_the_other_lines() -> None:
    body = (
        b"2026-08-21T09:14:57.000000001Z caf\xe9 closed\n"
        b"2026-08-21T09:14:58.000000001Z panic: nil map\n"
    )
    core_api = _CoreApi(
        [_crash_loop_pod()],
        {False: _LogResponse(200, body), True: _LogResponse(400)},
    )
    adapter, _ = _adapter(core_api)

    observation = await adapter.read_container_logs(TARGET)

    current = observation.payload.containers[0].snapshots[0]
    assert [line.message for line in current.lines] == [
        "caf\ufffd closed",
        "panic: nil map",
    ]


@pytest.mark.asyncio
async def test_the_evidence_budget_keeps_the_newest_lines() -> None:
    body = (
        b"".join(
            b"2026-08-21T09:%02d:00.000000001Z %s\n" % (index, b"x" * 80)
            for index in range(59)
        )
        + b"2026-08-21T09:59:00.000000001Z panic: the reason"
    )
    core_api = _CoreApi(
        [_crash_loop_pod()],
        {False: _LogResponse(200, body), True: _LogResponse(400)},
    )
    adapter, _ = _adapter(core_api)

    observation = await adapter.read_container_logs(TARGET)

    lines = observation.payload.containers[0].snapshots[0].lines
    assert lines[-1].message == "panic: the reason"
    assert lines[-1].timestamp.minute == 59
    assert [line.timestamp.minute for line in lines] == list(range(60 - len(lines), 60))
    assert 1 < len(lines) < 60
    assert observation.truncated is True


@pytest.mark.asyncio
async def test_a_single_line_over_the_budget_is_clipped_not_refused() -> None:
    body = b"2026-08-21T09:14:58.000000001Z " + b"y" * 100_000 + b"\n"
    core_api = _CoreApi(
        [_crash_loop_pod()],
        {False: _LogResponse(200, body), True: _LogResponse(400)},
    )
    adapter, _ = _adapter(core_api)

    observation = await adapter.read_container_logs(TARGET)

    lines = observation.payload.containers[0].snapshots[0].lines
    assert [line.message for line in lines] == ["y" * 512]
    assert observation.truncated is True


@pytest.mark.asyncio
async def test_a_stream_cut_at_the_transport_limit_drops_its_broken_tail() -> None:
    whole = b"2026-08-21T09:14:58.000000001Z whole\n"
    body = whole + b"2026-08-21T09:14:59.000000001Z cut "
    body = body + b"z" * (262144 - len(body))
    core_api = _CoreApi(
        [_crash_loop_pod()],
        {False: _LogResponse(200, body), True: _LogResponse(400)},
    )
    adapter, _ = _adapter(core_api)

    observation = await adapter.read_container_logs(TARGET)

    lines = observation.payload.containers[0].snapshots[0].lines
    assert [line.message for line in lines] == ["whole"]
    assert observation.truncated is True


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


def _running_pod(*, probes: bool = False) -> V1Pod:
    container_status = _container_status(
        "app",
        V1ContainerState(
            running=V1ContainerStateRunning(
                started_at=OBSERVED_AT - timedelta(minutes=5)
            )
        ),
    )
    container_status.restart_count = 0
    container_status.container_id = "containerd://current"
    pod = _pod(
        "running-pod", "pod-uid", "rs-uid", container_statuses=[container_status]
    )
    if probes:
        spec: Any = cast(Any, pod).spec
        spec.containers[0].readiness_probe = V1Probe(
            tcp_socket=V1TCPSocketAction(port=8080)
        )
    return pod


def _probe_event(
    *,
    field_path: str | None = "spec.containers{app}",
    age: int = 30,
    uid: str = "pod-uid",
) -> EventsV1Event:
    return EventsV1Event(
        metadata=V1ObjectMeta(
            namespace=TARGET.namespace,
            name="probe-failure",
            uid="event-uid",
            resource_version="3",
        ),
        regarding=V1ObjectReference(
            api_version="v1",
            kind="Pod",
            namespace=TARGET.namespace,
            name="running-pod",
            uid=uid,
            field_path=field_path,
        ),
        event_time=OBSERVED_AT - timedelta(seconds=age),
        reason="Unhealthy",
        type="Warning",
        reporting_controller="kubelet",
        note="Readiness probe failed: token=event-secret",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("previous", "reason", "exit_code", "age", "selected"),
    [
        (False, "OOMKilled", 137, 30, True),
        (False, None, 137, 30, True),
        (False, "Completed", 0, 30, False),
        (True, "Error", 1, 30, True),
        (True, "OOMKilled", 137, 601, False),
        (True, "Error", 1, -1, False),
    ],
)
async def test_logs_require_current_or_recent_abnormal_termination(
    previous: bool,
    reason: str | None,
    exit_code: int,
    age: int,
    selected: bool,
) -> None:
    pod = _running_pod()
    status: Any = cast(Any, pod).status.container_statuses[0]
    terminated = V1ContainerState(
        terminated=V1ContainerStateTerminated(
            reason=reason,
            exit_code=exit_code,
            finished_at=OBSERVED_AT - timedelta(seconds=age),
        )
    )
    if previous:
        status.last_state = terminated
        status.restart_count = 1
    else:
        status.state = terminated
    core = _CoreApi(
        [pod],
        {
            False: _LogResponse(200, b"2026-08-21T09:14:50Z token=private\n"),
            True: _LogResponse(400),
        },
    )
    adapter, _ = _adapter(core)
    observation = await adapter.read_container_logs(TARGET)
    assert bool(observation.payload.containers) is selected
    assert bool(core.log_calls) is selected
    if selected:
        container = observation.payload.containers[0]
        assert container.selection_reason == (
            "recent_termination" if previous else "current_termination"
        )
        assert container.snapshots[1].status == "previous_unavailable"
        assert "private" not in observation.model_dump_json()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field_path", "age", "uid", "selected"),
    [
        ("spec.containers{app}", 30, "pod-uid", True),
        ("spec.containers{app}", 601, "pod-uid", False),
        ("spec.containers{app}", -1, "pod-uid", False),
        ("spec.containers{app}", 30, "other-pod", False),
        ("spec.containers{other}", 30, "pod-uid", False),
        ("spec.initContainers{app}", 30, "pod-uid", False),
        ("spec.ephemeralContainers{app}", 30, "pod-uid", False),
        (None, 30, "pod-uid", False),
    ],
)
async def test_probe_logs_require_fresh_exact_regular_container_event(
    field_path: str | None,
    age: int,
    uid: str,
    selected: bool,
) -> None:
    core = _CoreApi(
        [_running_pod(probes=True)],
        {
            False: _LogResponse(200, b"2026-08-21T09:14:50Z password=log-secret\n"),
            True: _LogResponse(400),
        },
    )
    event = _probe_event(field_path=field_path, age=age, uid=uid)
    events_api = _EventsApi(
        {None: EventsV1EventList(metadata=V1ListMeta(), items=[event])}
    )
    adapter, _ = _adapter(core, events_api)
    observation = await adapter.read_container_logs(TARGET)
    assert bool(observation.payload.containers) is selected
    assert bool(core.log_calls) is selected
    if selected:
        assert observation.payload.containers[0].selection_reason == "probe_failure"
        assert observation.payload.containers[0].restart_count == 0
        assert "log-secret" not in observation.model_dump_json()
    assert "event-secret" not in observation.model_dump_json()


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy", [False, True])
async def test_probe_event_uses_latest_series_or_legacy_observation(
    legacy: bool,
) -> None:
    event = _probe_event(age=3600)
    if legacy:
        event.deprecated_last_timestamp = OBSERVED_AT
    else:
        event.series = EventsV1EventSeries(count=8, last_observed_time=OBSERVED_AT)
    core = _CoreApi(
        [_running_pod(probes=True)],
        {
            False: _LogResponse(200),
            True: _LogResponse(400),
        },
    )
    adapter, _ = _adapter(
        core,
        _EventsApi({None: EventsV1EventList(metadata=V1ListMeta(), items=[event])}),
    )
    observation = await adapter.read_container_logs(TARGET)
    assert observation.payload.containers[0].selection_reason == "probe_failure"


@pytest.mark.asyncio
async def test_probe_event_occurring_during_the_request_is_not_future() -> None:
    now = OBSERVED_AT

    class AdvancingEventsApi(_EventsApi):
        async def list_namespaced_event(
            self,
            namespace: str,
            **kwargs: object,
        ) -> EventsV1EventList:
            nonlocal now
            result = await super().list_namespaced_event(namespace, **kwargs)
            now += timedelta(seconds=2)
            return result

    events_api = AdvancingEventsApi(
        {None: EventsV1EventList(metadata=V1ListMeta(), items=[_probe_event(age=-1)])}
    )
    core = _CoreApi(
        [_running_pod(probes=True)],
        {
            False: _LogResponse(200, b"2026-08-21T09:15:01Z probe failed\n"),
            True: _LogResponse(400),
        },
    )
    adapter, _ = _adapter(core, events_api, clock=lambda: now)
    observation = await adapter.read_container_logs(TARGET)
    container = observation.payload.containers[0]
    assert container.selection_reason == "probe_failure"
    assert container.snapshots[0].lines[0].message == "probe failed"
    assert observation.observed_at == OBSERVED_AT + timedelta(seconds=2)


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["renamed", "owner"])
async def test_logs_discard_snapshots_after_rename_or_owner_drift(
    change: str,
) -> None:
    pod = _crash_loop_pod()
    rebound = _crash_loop_pod()
    rebound_view: Any = rebound
    if change == "renamed":
        # Rename spec and status together: a pod whose two halves disagree is
        # rejected while they are paired, before any identity is compared.
        rebound_view.spec.containers[0].name = "other"
        rebound_view.status.container_statuses[0].name = "other"
    else:
        rebound_view.metadata.owner_references[0].uid = "other-rs"
    core = _CoreApi(
        [pod],
        {False: _LogResponse(200), True: _LogResponse(200)},
        rebound_pods=[rebound],
    )
    adapter, _ = _adapter(core)
    with pytest.raises(KubernetesBoundaryError) as failure:
        await adapter.read_container_logs(TARGET)
    assert failure.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["restart", "container"])
async def test_logs_survive_a_restart_between_the_read_and_the_rebind(
    change: str,
) -> None:
    # A container that restarts while its own logs are being read is the normal
    # state of the workloads this tool exists for, not a workload swapped out
    # underneath the read. Failing it closed cost the whole diagnosis.
    pod = _terminated_pod()
    rebound = _terminated_pod()
    rebound_view: Any = rebound
    if change == "restart":
        rebound_view.status.container_statuses[0].restart_count += 1
    else:
        rebound_view.status.container_statuses[
            0
        ].container_id = "containerd://replacement"
    core = _CoreApi(
        [pod],
        {False: _LogResponse(200), True: _LogResponse(200)},
        rebound_pods=[rebound],
    )
    adapter, _ = _adapter(core)

    observation = await adapter.read_container_logs(TARGET)

    assert observation.evidence_kind == "container_logs"
    container = observation.payload.containers[0]
    current, previous = container.snapshots
    assert current.source == "current"
    # `previous` is resolved when the request is served, so after a restart it
    # would repeat the generation `current` already carried.
    assert previous.source == "previous"
    if change == "restart":
        assert previous.status == "previous_unavailable"
        assert previous.lines == []
    else:
        assert previous.status in {"available", "no_logs_in_window"}


@pytest.mark.asyncio
async def test_abnormal_log_container_budget_is_not_silently_truncated() -> None:
    pods = [_crash_loop_pod(uid=f"uid-{index}") for index in range(5)]
    for index, pod in enumerate(pods):
        cast(Any, pod).metadata.name = f"pod-{index}"
    core = _CoreApi(pods)
    adapter, _ = _adapter(core)
    with pytest.raises(KubernetesBoundaryError) as failure:
        await adapter.read_container_logs(TARGET)
    assert failure.value.code is KubernetesErrorCode.RESULT_BUDGET_EXCEEDED
    assert core.log_calls == []
