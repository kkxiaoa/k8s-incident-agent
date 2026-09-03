import asyncio
import base64
import json
import logging
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta, tzinfo
from pathlib import Path
from types import SimpleNamespace
from typing import Protocol, cast

import aiohttp
import certifi
import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    ApiClient,
    AppsV1Api,
    AuthorizationV1Api,
    Configuration,
    CoreV1Api,
    DiscoveryV1Api,
    EventsV1Api,
    EventsV1Event,
    EventsV1EventList,
    VersionApi,
)
from kubernetes.aio.client.exceptions import (  # pyright: ignore[reportMissingTypeStubs]
    ApiException,
)

import k8s_incident_agent.kubernetes.client as client_module
from k8s_incident_agent.kubernetes.client import (
    create_incluster_kubernetes_clients,
    create_kubernetes_clients,
    enforce_direct_kubernetes_transport,
)
from k8s_incident_agent.kubernetes.credentials import (
    DiagnosticCredential,
    load_diagnostic_credential,
)
from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    KubernetesErrorCode,
    map_kubernetes_exception,
)
from k8s_incident_agent.runtime.paths import RuntimePaths

NOW = datetime(2026, 8, 21, 8, 0, tzinfo=UTC)
CLUSTER_ID = "k8s-incident-agent"
DIAGNOSTIC_NAMESPACE = "k8s-incident-scenarios"
PROXY_ENVIRONMENT_VARIABLES = (
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
)


class _ConfigurationView(Protocol):
    proxy: object | None
    debug: bool
    client_side_validation: bool


class _CredentialConfigurationView(Protocol):
    async def get_api_key_with_prefix(
        self,
        identifier: str,
        alias: str | None = None,
    ) -> object: ...


class _RestClientView(Protocol):
    async def GET(
        self,
        url: str,
        *,
        _request_timeout: float,
    ) -> object: ...


class _ApiClientView(Protocol):
    configuration: object
    rest_client: _RestClientView

    def deserialize(self, response: object, response_type: str) -> object: ...


class _EventsListView(Protocol):
    items: object


class _EventView(Protocol):
    event_time: object


def _encode_segment(value: dict[str, object]) -> str:
    encoded = base64.urlsafe_b64encode(json.dumps(value).encode())
    return encoded.rstrip(b"=").decode()


def _credential(
    paths: RuntimePaths,
    *,
    ca_data: str | None = None,
) -> DiagnosticCredential:
    expires_at = NOW + timedelta(hours=1)
    token = (
        f"{_encode_segment({'alg': 'none'})}."
        f"{_encode_segment({'exp': int(expires_at.timestamp())})}.signature"
    )
    resolved_ca_data = (
        ca_data or base64.b64encode(Path(certifi.where()).read_bytes()).decode()
    )
    document = {
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": [
            {
                "name": "k8s-incident-agent",
                "cluster": {
                    "server": "https://127.0.0.1:6443",
                    "certificate-authority-data": resolved_ca_data,
                },
            }
        ],
        "contexts": [
            {
                "name": "kind-k8s-incident-agent",
                "context": {
                    "cluster": "k8s-incident-agent",
                    "namespace": "k8s-incident-scenarios",
                    "user": "diagnostic-agent",
                },
            }
        ],
        "users": [
            {
                "name": "diagnostic-agent",
                "user": {"token": token},
            }
        ],
        "current-context": "kind-k8s-incident-agent",
    }
    paths.diagnostic_kubeconfig.write_text(json.dumps(document), encoding="utf-8")
    paths.diagnostic_kubeconfig.chmod(0o600)
    return load_diagnostic_credential(paths, NOW)


def _transport_session(api_client: ApiClient) -> aiohttp.ClientSession:
    return api_client.rest_client.pool_manager


async def _create_kubeconfig_clients(
    credential: DiagnosticCredential,
) -> client_module.KubernetesClients:
    return await create_kubernetes_clients(
        credential,
        timeout_seconds=10,
        cluster_id=CLUSTER_ID,
        diagnostic_namespace=DIAGNOSTIC_NAMESPACE,
    )


def _install_incluster_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Path:
    token_path = tmp_path / "token"
    ca_path = tmp_path / "ca.crt"
    token_path.write_text("token-one", encoding="utf-8")
    ca_path.write_bytes(Path(certifi.where()).read_bytes())
    monkeypatch.setattr(
        client_module.incluster_config,
        "SERVICE_TOKEN_FILENAME",
        str(token_path),
    )
    monkeypatch.setattr(
        client_module.incluster_config,
        "SERVICE_CERT_FILENAME",
        str(ca_path),
    )
    monkeypatch.setenv("KUBERNETES_SERVICE_HOST", "10.43.0.1")
    monkeypatch.setenv("KUBERNETES_SERVICE_PORT", "443")
    return token_path


@pytest.mark.asyncio
async def test_locked_upstream_client_defaults_to_environment_proxy_lookup() -> None:
    api_client = ApiClient(Configuration())
    try:
        assert _transport_session(api_client).trust_env is True
    finally:
        await api_client.close()


@pytest.mark.asyncio
async def test_factory_creates_scoped_direct_clients_without_mutating_proxy_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    credential = _credential(paths)
    expected_environment: dict[str, str] = {}
    for index, variable in enumerate(PROXY_ENVIRONMENT_VARIABLES):
        value = f"http://127.0.0.1:{65000 + index}"
        monkeypatch.setenv(variable, value)
        expected_environment[variable] = value
    rest_logger = logging.getLogger("kubernetes.aio.client.rest")
    previous_level = rest_logger.level
    rest_logger.setLevel(logging.DEBUG)

    try:
        clients = await _create_kubeconfig_clients(credential)
        try:
            api_client_view = cast(_ApiClientView, clients.api_client)
            configuration = cast(_ConfigurationView, api_client_view.configuration)
            assert _transport_session(clients.api_client).trust_env is False
            assert configuration.proxy is None
            assert configuration.debug is False
            assert configuration.client_side_validation is False
            assert rest_logger.level == logging.WARNING
            assert clients.timeout_seconds == 10
            assert clients.cluster_id == CLUSTER_ID
            assert clients.diagnostic_namespace == DIAGNOSTIC_NAMESPACE
            assert isinstance(clients.apps_api, AppsV1Api)
            assert isinstance(clients.core_api, CoreV1Api)
            assert isinstance(clients.discovery_api, DiscoveryV1Api)
            assert isinstance(clients.events_api, EventsV1Api)
            assert isinstance(clients.version_api, VersionApi)
            assert isinstance(clients.authorization_api, AuthorizationV1Api)
            assert list(paths.root.glob(".k8s-ca-*")) == []
            assert {
                variable: os.environ[variable]
                for variable in PROXY_ENVIRONMENT_VARIABLES
            } == expected_environment
        finally:
            await clients.close()
    finally:
        rest_logger.setLevel(previous_level)


def test_locked_incluster_loader_uses_standard_projected_service_account_paths() -> (
    None
):
    assert (
        client_module.incluster_config.SERVICE_TOKEN_FILENAME
        == "/var/run/secrets/kubernetes.io/serviceaccount/token"
    )
    assert (
        client_module.incluster_config.SERVICE_CERT_FILENAME
        == "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
    )


@pytest.mark.asyncio
async def test_incluster_factory_refreshes_replaced_projected_token(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token_path = _install_incluster_source(tmp_path, monkeypatch)
    time_offset_minutes = [0]
    system_datetime = datetime

    class _TestDateTime(datetime):
        @classmethod
        def now(cls, tz: tzinfo | None = None) -> datetime:
            return system_datetime.now(tz) + timedelta(minutes=time_offset_minutes[0])

    clients = await create_incluster_kubernetes_clients(
        timeout_seconds=10,
        cluster_id=CLUSTER_ID,
        diagnostic_namespace=DIAGNOSTIC_NAMESPACE,
    )
    try:
        configuration = cast(
            _CredentialConfigurationView,
            cast(_ApiClientView, clients.api_client).configuration,
        )
        assert await configuration.get_api_key_with_prefix("BearerToken") == (
            "bearer token-one"
        )

        token_path.write_text("token-two", encoding="utf-8")
        time_offset_minutes[0] = 2
        monkeypatch.setattr(
            client_module.incluster_config.datetime,
            "datetime",
            _TestDateTime,
        )

        assert await configuration.get_api_key_with_prefix("BearerToken") == (
            "bearer token-two"
        )
        assert _transport_session(clients.api_client).trust_env is False
        assert clients.cluster_id == CLUSTER_ID
        assert clients.diagnostic_namespace == DIAGNOSTIC_NAMESPACE

        token_path.unlink()
        time_offset_minutes[0] = 4
        with pytest.raises(KubernetesBoundaryError) as captured:
            await configuration.get_api_key_with_prefix("BearerToken")
        assert captured.value.code is KubernetesErrorCode.AUTHENTICATION_FAILED
    finally:
        await clients.close()


@pytest.mark.asyncio
async def test_incluster_factory_fails_closed_without_service_account_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("KUBERNETES_SERVICE_HOST", raising=False)
    monkeypatch.delenv("KUBERNETES_SERVICE_PORT", raising=False)

    with pytest.raises(KubernetesBoundaryError) as captured:
        await create_incluster_kubernetes_clients(
            timeout_seconds=10,
            cluster_id=CLUSTER_ID,
            diagnostic_namespace=DIAGNOSTIC_NAMESPACE,
        )

    assert captured.value.code is KubernetesErrorCode.AUTHENTICATION_FAILED


@pytest.mark.asyncio
async def test_factory_deserializes_captured_event_with_null_event_time(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    credential = _credential(paths)
    clients = await _create_kubeconfig_clients(credential)
    response = SimpleNamespace(
        data=json.dumps(
            {
                "apiVersion": "events.k8s.io/v1",
                "kind": "EventList",
                "metadata": {},
                "items": [
                    {
                        "metadata": {
                            "name": "image-pull-event",
                            "namespace": "k8s-incident-scenarios",
                            "resourceVersion": "42",
                            "uid": "event-uid",
                        },
                        "eventTime": None,
                        "deprecatedCount": 1,
                        "deprecatedFirstTimestamp": "2026-08-29T17:25:28Z",
                        "reason": "Failed",
                        "regarding": {
                            "apiVersion": "v1",
                            "kind": "Pod",
                            "name": "image-pull-pod",
                            "namespace": "k8s-incident-scenarios",
                            "uid": "pod-uid",
                        },
                        "reportingController": "kubelet",
                        "reportingInstance": "kind-control-plane",
                        "type": "Warning",
                    }
                ],
            }
        )
    )
    try:
        deserialized = cast(_ApiClientView, clients.api_client).deserialize(
            response,
            "EventsV1EventList",
        )
    finally:
        await clients.close()

    assert isinstance(deserialized, EventsV1EventList)
    items = cast(_EventsListView, deserialized).items
    assert isinstance(items, list)
    item_values = cast(list[object], items)
    assert len(item_values) == 1
    assert isinstance(item_values[0], EventsV1Event)
    assert cast(_EventView, item_values[0]).event_time is None


@pytest.mark.asyncio
async def test_factory_removes_owned_ca_file_when_client_construction_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    credential = _credential(paths)

    def fail_client_construction(_configuration: object) -> ApiClient:
        raise RuntimeError("constructor failed")

    monkeypatch.setattr(client_module, "ApiClient", fail_client_construction)

    with pytest.raises(KubernetesBoundaryError):
        await _create_kubeconfig_clients(credential)

    assert list(paths.root.glob(".k8s-ca-*")) == []


@pytest.mark.asyncio
async def test_factory_maps_malformed_ca_data_to_authentication_failure(
    tmp_path: Path,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    credential = _credential(paths, ca_data="not-valid-base64!")

    with pytest.raises(KubernetesBoundaryError) as captured:
        await _create_kubeconfig_clients(credential)

    assert captured.value.code is KubernetesErrorCode.AUTHENTICATION_FAILED
    assert list(paths.root.glob(".k8s-ca-*")) == []


@pytest.mark.asyncio
async def test_factory_removes_owned_ca_file_when_kubeconfig_load_is_cancelled(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    credential = _credential(paths)
    load_started = asyncio.Event()

    async def block_kubeconfig_load(*_args: object, **_kwargs: object) -> object:
        assert list(paths.root.glob(".k8s-ca-*")) != []
        load_started.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    monkeypatch.setattr(client_module, "_load_kube_config", block_kubeconfig_load)
    factory_task = asyncio.create_task(
        create_kubernetes_clients(
            credential,
            timeout_seconds=10,
            cluster_id=CLUSTER_ID,
            diagnostic_namespace=DIAGNOSTIC_NAMESPACE,
        )
    )
    await load_started.wait()
    factory_task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await factory_task

    assert list(paths.root.glob(".k8s-ca-*")) == []


@pytest.mark.asyncio
async def test_transport_compatibility_drift_closes_client_and_fails_closed() -> None:
    api_client = ApiClient(Configuration())
    session = _transport_session(api_client)
    delattr(session, "_trust_env")

    with pytest.raises(KubernetesBoundaryError) as captured:
        await enforce_direct_kubernetes_transport(api_client)

    assert captured.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID
    assert session.closed is True


@asynccontextmanager
async def _failing_http_server() -> AsyncGenerator[tuple[str, list[int]]]:
    request_count: list[int] = []

    async def handle_request(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        await reader.readuntil(b"\r\n\r\n")
        request_count.append(1)
        body = b"{}"
        writer.write(
            b"HTTP/1.1 503 Service Unavailable\r\n"
            b"Content-Type: application/json\r\n"
            b"Connection: close\r\n"
            + f"Content-Length: {len(body)}\r\n\r\n".encode()
            + body
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(handle_request, "127.0.0.1", 0)
    sockets = server.sockets
    assert sockets
    port = cast(tuple[str, int], sockets[0].getsockname())[1]
    try:
        async with server:
            yield f"http://127.0.0.1:{port}", request_count
    finally:
        server.close()
        await server.wait_closed()


@pytest.mark.asyncio
async def test_locked_async_transport_does_not_retry_a_5xx_response() -> None:
    async with _failing_http_server() as (server_url, request_count):
        api_client = ApiClient(Configuration(host=server_url))
        await enforce_direct_kubernetes_transport(api_client)
        try:
            with pytest.raises(ApiException):
                await cast(_ApiClientView, api_client).rest_client.GET(
                    f"{server_url}/version",
                    _request_timeout=1,
                )
        finally:
            await api_client.close()

    assert len(request_count) == 1


@pytest.mark.parametrize(
    ("upstream_error", "expected_code"),
    [
        (ApiException(status=401), KubernetesErrorCode.AUTHENTICATION_FAILED),
        (ApiException(status=403), KubernetesErrorCode.PERMISSION_DENIED),
        (ApiException(status=404), KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID),
        (TimeoutError(), KubernetesErrorCode.REQUEST_TIMEOUT),
        (aiohttp.ClientConnectionError(), KubernetesErrorCode.UPSTREAM_UNAVAILABLE),
        (ApiException(status=0), KubernetesErrorCode.UPSTREAM_UNAVAILABLE),
        (ApiException(status=429), KubernetesErrorCode.UPSTREAM_UNAVAILABLE),
        (ApiException(status=503), KubernetesErrorCode.UPSTREAM_UNAVAILABLE),
        (
            ValueError("malformed SDK field"),
            KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID,
        ),
    ],
)
def test_upstream_failures_map_to_stable_codes(
    upstream_error: Exception,
    expected_code: KubernetesErrorCode,
) -> None:
    mapped = map_kubernetes_exception(upstream_error)

    assert mapped.code is expected_code
    assert mapped.retryable is (
        expected_code
        in {
            KubernetesErrorCode.REQUEST_TIMEOUT,
            KubernetesErrorCode.UPSTREAM_UNAVAILABLE,
        }
    )


def test_upstream_error_text_headers_and_body_are_not_exposed() -> None:
    secret = "sensitive-upstream-material"
    upstream_error = ApiException(status=503, reason=secret)
    upstream_error.body = secret
    upstream_error.headers = {"Authorization": secret}

    mapped = map_kubernetes_exception(upstream_error)

    assert mapped.code is KubernetesErrorCode.UPSTREAM_UNAVAILABLE
    assert secret not in str(mapped)
    assert "Authorization" not in str(mapped)
