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

import aiohttp
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    ApiClient,
    AppsV1Api,
    AuthorizationV1Api,
    Configuration,
    CoreV1Api,
    EventsV1Api,
    VersionApi,
)
from kubernetes.aio.config import (  # pyright: ignore[reportMissingTypeStubs]
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


class _ConfigurationView(Protocol):
    host: str
    proxy: object | None
    cert_file: object | None
    key_file: object | None
    ssl_ca_cert: object | None
    verify_ssl: bool
    debug: bool


@dataclass(frozen=True, slots=True)
class KubernetesClients:
    api_client: ApiClient = field(repr=False)
    apps_api: AppsV1Api = field(repr=False)
    core_api: CoreV1Api = field(repr=False)
    events_api: EventsV1Api = field(repr=False)
    version_api: VersionApi = field(repr=False)
    authorization_api: AuthorizationV1Api = field(repr=False)
    timeout_seconds: float
    context_name: str

    async def close(self) -> None:
        await self.api_client.close()


async def create_kubernetes_clients(
    credential: DiagnosticCredential,
    timeout_seconds: float,
) -> KubernetesClients:
    if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
        raise ValueError("Kubernetes timeout must be finite and positive")

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

        configuration_view.debug = False
        logging.getLogger(_REST_LOGGER_NAME).setLevel(logging.WARNING)
        try:
            api_client = ApiClient(configuration)
        except Exception as error:
            raise map_kubernetes_exception(error) from None
    finally:
        try:
            _remove_ca_file(ca_path)
        except Exception:
            if api_client is not None:
                await _close_quietly(api_client)
            raise

    api_client = cast(ApiClient, api_client)

    await enforce_direct_kubernetes_transport(api_client)
    try:
        return KubernetesClients(
            api_client=api_client,
            apps_api=AppsV1Api(api_client),
            core_api=CoreV1Api(api_client),
            events_api=EventsV1Api(api_client),
            version_api=VersionApi(api_client),
            authorization_api=AuthorizationV1Api(api_client),
            timeout_seconds=timeout_seconds,
            context_name=credential.context_name,
        )
    except Exception as error:
        await _close_quietly(api_client)
        raise map_kubernetes_exception(error) from None


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
