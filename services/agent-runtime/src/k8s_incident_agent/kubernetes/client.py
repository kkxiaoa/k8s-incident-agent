import logging
import math
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, field
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
        await _load_kube_config(
            credential.copy_kubeconfig_for_client(),
            context=credential.context_name,
            client_configuration=configuration,
            temp_file_path=str(credential.kubeconfig_path.parent),
        )
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
        or configuration_view.verify_ssl is not True
    ):
        raise KubernetesBoundaryError(KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID)

    configuration_view.debug = False
    logging.getLogger(_REST_LOGGER_NAME).setLevel(logging.WARNING)
    try:
        api_client = ApiClient(configuration)
    except Exception as error:
        raise map_kubernetes_exception(error) from None

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
