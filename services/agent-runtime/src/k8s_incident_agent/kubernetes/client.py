import base64
import binascii
import logging
import math
import os
import tempfile
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, cast
from urllib.parse import urlsplit

import aiohttp
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    ApiClient,
    AppsV1Api,
    AuthorizationV1Api,
    Configuration,
    CoreV1Api,
    DiscoveryV1Api,
    EventsV1Api,
    StorageV1Api,
    VersionApi,
)
from kubernetes.aio.config import (  # pyright: ignore[reportMissingTypeStubs]
    incluster_config,
    load_kube_config_from_dict,  # pyright: ignore[reportUnknownVariableType]
)

from k8s_incident_agent.kubernetes.credentials import DiagnosticCredential
from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    KubernetesErrorCode,
    map_kubernetes_exception,
)
from k8s_incident_agent.runtime.paths import PRIVATE_FILE_MODE

_REST_LOGGER_NAME = "kubernetes.aio.client.rest"
_load_kube_config = cast(
    Callable[..., Awaitable[object]],
    load_kube_config_from_dict,
)
_load_incluster_config = cast(
    Callable[..., object],
    incluster_config.load_incluster_config,  # pyright: ignore[reportUnknownMemberType]
)


class _ConfigurationView(Protocol):
    host: str
    api_key: dict[str, str]
    proxy: object | None
    cert_file: object | None
    key_file: object | None
    ssl_ca_cert: object | None
    verify_ssl: bool
    debug: bool
    client_side_validation: bool
    refresh_api_key_hook: object | None


@dataclass(frozen=True, slots=True)
class KubernetesClients:
    api_client: ApiClient = field(repr=False)
    apps_api: AppsV1Api = field(repr=False)
    core_api: CoreV1Api = field(repr=False)
    discovery_api: DiscoveryV1Api = field(repr=False)
    events_api: EventsV1Api = field(repr=False)
    storage_api: StorageV1Api = field(repr=False)
    version_api: VersionApi = field(repr=False)
    authorization_api: AuthorizationV1Api = field(repr=False)
    timeout_seconds: float
    cluster_id: str
    diagnostic_namespace: str

    async def close(self) -> None:
        await self.api_client.close()


async def create_kubernetes_clients(
    credential: DiagnosticCredential,
    timeout_seconds: float,
    *,
    cluster_id: str,
    diagnostic_namespace: str,
) -> KubernetesClients:
    _require_positive_timeout(timeout_seconds)

    configuration = Configuration()
    try:
        kubeconfig = credential.copy_kubeconfig_for_client()
        ca_path = _materialize_ca_file(
            kubeconfig,
            credential.kubeconfig_path.parent,
        )
    except KubernetesBoundaryError:
        raise
    except Exception:
        raise KubernetesBoundaryError(
            KubernetesErrorCode.AUTHENTICATION_FAILED
        ) from None

    api_client: ApiClient | None = None
    try:
        try:
            await _load_kube_config(
                kubeconfig,
                context=credential.context_name,
                client_configuration=configuration,
            )
        except KubernetesBoundaryError:
            raise
        except Exception:
            raise KubernetesBoundaryError(
                KubernetesErrorCode.AUTHENTICATION_FAILED
            ) from None

        configuration_view = cast(_ConfigurationView, configuration)
        if (
            configuration_view.host != credential.server_url
            or configuration_view.proxy is not None
            or configuration_view.cert_file is not None
            or configuration_view.key_file is not None
            or configuration_view.ssl_ca_cert != ca_path
            or configuration_view.verify_ssl is not True
        ):
            raise KubernetesBoundaryError(KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID)

        api_client = _create_api_client(configuration_view)
    finally:
        try:
            _remove_ca_file(ca_path)
        except Exception:
            if api_client is not None:
                await _close_quietly(api_client)
            raise

    return await _create_scoped_clients(
        cast(ApiClient, api_client),
        timeout_seconds=timeout_seconds,
        cluster_id=cluster_id,
        diagnostic_namespace=diagnostic_namespace,
    )


async def create_incluster_kubernetes_clients(
    timeout_seconds: float,
    *,
    cluster_id: str,
    diagnostic_namespace: str,
) -> KubernetesClients:
    _require_positive_timeout(timeout_seconds)
    configuration = Configuration()
    try:
        _load_incluster_config(
            client_configuration=configuration,
            try_refresh_token=True,
        )
    except Exception:
        raise KubernetesBoundaryError(
            KubernetesErrorCode.AUTHENTICATION_FAILED
        ) from None

    configuration_view = cast(_ConfigurationView, configuration)
    _require_incluster_configuration(configuration_view)
    _protect_incluster_refresh_hook(configuration_view)
    api_client = _create_api_client(configuration_view)
    return await _create_scoped_clients(
        api_client,
        timeout_seconds=timeout_seconds,
        cluster_id=cluster_id,
        diagnostic_namespace=diagnostic_namespace,
    )


def _create_api_client(configuration: _ConfigurationView) -> ApiClient:
    configuration.debug = False
    # Kubernetes 1.36 can return converted events with eventTime=null, while
    # SDK 36.0.3 rejects that response before the adapter can normalize it.
    configuration.client_side_validation = False
    logging.getLogger(_REST_LOGGER_NAME).setLevel(logging.WARNING)
    try:
        return ApiClient(cast(Configuration, configuration))
    except Exception as error:
        raise map_kubernetes_exception(error) from None


async def _create_scoped_clients(
    api_client: ApiClient,
    *,
    timeout_seconds: float,
    cluster_id: str,
    diagnostic_namespace: str,
) -> KubernetesClients:

    await enforce_direct_kubernetes_transport(api_client)
    try:
        return KubernetesClients(
            api_client=api_client,
            apps_api=AppsV1Api(api_client),
            core_api=CoreV1Api(api_client),
            discovery_api=DiscoveryV1Api(api_client),
            events_api=EventsV1Api(api_client),
            storage_api=StorageV1Api(api_client),
            version_api=VersionApi(api_client),
            authorization_api=AuthorizationV1Api(api_client),
            timeout_seconds=timeout_seconds,
            cluster_id=cluster_id,
            diagnostic_namespace=diagnostic_namespace,
        )
    except Exception as error:
        await _close_quietly(api_client)
        raise map_kubernetes_exception(error) from None


def _require_positive_timeout(timeout_seconds: float) -> None:
    if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
        raise ValueError("Kubernetes timeout must be finite and positive")


def _require_incluster_configuration(configuration: _ConfigurationView) -> None:
    service_host = os.environ.get(incluster_config.SERVICE_HOST_ENV_NAME)
    service_port = os.environ.get(incluster_config.SERVICE_PORT_ENV_NAME)
    try:
        if service_host is None or service_port is None:
            raise ValueError
        if (
            service_host != service_host.strip()
            or service_port != service_port.strip()
            or any(
                ord(character) < 0x20 or ord(character) == 0x7F
                for character in f"{service_host}{service_port}"
            )
        ):
            raise ValueError
        port = int(service_port)
        parsed = urlsplit(configuration.host)
        if (
            not 1 <= port <= 65535
            or parsed.scheme != "https"
            or parsed.hostname is None
            or parsed.hostname.casefold() != service_host.casefold()
            or parsed.port != port
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError
    except ValueError:
        raise KubernetesBoundaryError(
            KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID
        ) from None

    bearer_token = configuration.api_key.get("BearerToken")
    if (
        configuration.proxy is not None
        or configuration.cert_file is not None
        or configuration.key_file is not None
        or configuration.ssl_ca_cert != incluster_config.SERVICE_CERT_FILENAME
        or configuration.verify_ssl is not True
        or not isinstance(bearer_token, str)
        or not bearer_token
        or not callable(configuration.refresh_api_key_hook)
    ):
        raise KubernetesBoundaryError(KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID)


def _protect_incluster_refresh_hook(configuration: _ConfigurationView) -> None:
    upstream_hook = configuration.refresh_api_key_hook
    if not callable(upstream_hook):
        raise KubernetesBoundaryError(KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID)
    typed_hook = cast(Callable[[object], object], upstream_hook)

    def refresh(client_configuration: object) -> object:
        try:
            return typed_hook(client_configuration)
        except Exception:
            raise KubernetesBoundaryError(
                KubernetesErrorCode.AUTHENTICATION_FAILED
            ) from None
        finally:
            configuration.refresh_api_key_hook = refresh

    configuration.refresh_api_key_hook = refresh


async def enforce_direct_kubernetes_transport(api_client: ApiClient) -> None:
    try:
        session = cast(object, api_client.rest_client.pool_manager)
        if not isinstance(session, aiohttp.ClientSession) or not hasattr(
            session, "_trust_env"
        ):
            raise AttributeError
        # kubernetes 36.0.3 hardcodes trust_env=True; aiohttp 3.14.3 reads this
        # field at request time and exposes the resulting state via trust_env.
        session._trust_env = False  # pyright: ignore[reportPrivateUsage]
        if session.trust_env is not False:
            raise AttributeError
    except Exception:
        await _close_quietly(api_client)
        raise KubernetesBoundaryError(
            KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID
        ) from None


async def _close_quietly(api_client: ApiClient) -> None:
    with suppress(Exception):
        await api_client.close()


def _materialize_ca_file(kubeconfig: dict[str, object], directory: Path) -> str:
    clusters = kubeconfig.get("clusters")
    if not isinstance(clusters, list):
        raise ValueError
    untyped_clusters = cast(list[object], clusters)
    if len(untyped_clusters) != 1:
        raise ValueError
    entry = untyped_clusters[0]
    if not isinstance(entry, dict):
        raise ValueError
    untyped_entry = cast(dict[object, object], entry)
    cluster = untyped_entry.get("cluster")
    if not isinstance(cluster, dict):
        raise ValueError
    untyped_cluster = cast(dict[object, object], cluster)
    encoded = untyped_cluster.pop("certificate-authority-data", None)
    if not isinstance(encoded, str):
        raise ValueError
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError from None
    if not content:
        raise ValueError

    file_descriptor, path = tempfile.mkstemp(
        prefix=".k8s-ca-",
        dir=os.fspath(directory),
    )
    try:
        os.fchmod(file_descriptor, PRIVATE_FILE_MODE)
        with os.fdopen(file_descriptor, "wb") as ca_file:
            file_descriptor = -1
            ca_file.write(content)
        untyped_cluster["certificate-authority"] = path
        return path
    except BaseException:
        if file_descriptor >= 0:
            os.close(file_descriptor)
        _remove_ca_file(path)
        raise


def _remove_ca_file(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        raise KubernetesBoundaryError(
            KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID
        ) from None
