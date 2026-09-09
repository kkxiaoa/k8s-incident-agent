from __future__ import annotations

import math
import os
from collections.abc import AsyncIterator, Awaitable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, cast
from urllib.parse import urlsplit

from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    ApiClient,
    AppsV1Api,
    AuthorizationV1Api,
    Configuration,
    V1ResourceAttributes,
    V1SelfSubjectAccessReview,
    V1SelfSubjectAccessReviewSpec,
    V1SubjectAccessReviewStatus,
    VersionApi,
    VersionInfo,
)
from kubernetes.aio.client.exceptions import (  # pyright: ignore[reportMissingTypeStubs]
    ApiException,
)
from kubernetes.aio.client.rest import (  # pyright: ignore[reportMissingTypeStubs]
    RESTResponse,
)

from k8s_incident_agent.kubernetes.client import enforce_direct_kubernetes_transport
from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    KubernetesErrorCode,
    map_kubernetes_exception,
)

PATCH_VALIDATOR_TOKEN_FILE = Path(
    "/var/run/secrets/k8s-incident-agent/kubernetes/token"
)
PATCH_VALIDATOR_CA_FILE = Path("/var/run/secrets/k8s-incident-agent/kubernetes/ca.crt")
PATCH_VALIDATOR_NAMESPACE = "k8s-incident-agent"
_TOKEN_LIMIT = 16 * 1024
PATCH_VALIDATOR_KUBERNETES_RESPONSE_LIMIT = 1024 * 1024


class PatchValidatorKubernetesResponseError(RuntimeError):
    """The Kubernetes API returned an unusable bounded response."""


class _VersionApi(Protocol):
    def get_code(self, *, _request_timeout: float) -> Awaitable[object]: ...


class _AuthorizationApi(Protocol):
    def create_self_subject_access_review(
        self,
        *,
        body: object,
        _request_timeout: float,
    ) -> Awaitable[object]: ...


class _ConfigurationView(Protocol):
    host: str
    ssl_ca_cert: object | None
    verify_ssl: bool
    proxy: object | None
    cert_file: object | None
    key_file: object | None
    debug: bool
    client_side_validation: bool
    api_key: dict[str, str]
    api_key_prefix: dict[str, str]
    refresh_api_key_hook: object | None


class _VersionInfoView(Protocol):
    major: object
    minor: object


class _ReviewView(Protocol):
    status: object


class _StatusView(Protocol):
    allowed: object
    denied: object
    evaluation_error: object


class _GeneratedAppsApi(Protocol):
    def read_namespaced_deployment(self, **kwargs: object) -> Awaitable[object]: ...

    def patch_namespaced_deployment(self, **kwargs: object) -> Awaitable[object]: ...


class _ResponseContent(Protocol):
    def iter_chunked(self, size: int) -> AsyncIterator[bytes]: ...


class _RawResponse(Protocol):
    status: int
    reason: str | None
    headers: Mapping[str, str]
    content: _ResponseContent

    def release(self) -> None: ...

    def getheader(self, name: str, default: str | None = None) -> str | None: ...

    def getheaders(self) -> Mapping[str, str]: ...


class _Deserializer(Protocol):
    def deserialize(self, response: object, response_type: str) -> object: ...


class PatchValidatorAppsApi:
    """Narrow Apps API facade with a hard response-body budget."""

    def __init__(self, apps_api: object, api_client: object) -> None:
        self._apps_api = cast(_GeneratedAppsApi, apps_api)
        self._api_client = cast(_Deserializer, api_client)

    async def read_namespaced_deployment(
        self,
        *,
        name: str,
        namespace: str,
        _request_timeout: float,
    ) -> object:
        response = await self._apps_api.read_namespaced_deployment(
            name=name,
            namespace=namespace,
            _preload_content=False,
            _request_timeout=_request_timeout,
        )
        return await self._deserialize_deployment(response)

    async def patch_namespaced_deployment(
        self,
        *,
        name: str,
        namespace: str,
        body: object,
        dry_run: str,
        _content_type: str,
        _request_timeout: float,
    ) -> object:
        if dry_run != "All" or _content_type != "application/json-patch+json":
            raise ValueError("Patch Validator write request is invalid")
        response = await self._apps_api.patch_namespaced_deployment(
            name=name,
            namespace=namespace,
            body=body,
            dry_run="All",
            _content_type="application/json-patch+json",
            _preload_content=False,
            _request_timeout=_request_timeout,
        )
        return await self._deserialize_deployment(response)

    async def _deserialize_deployment(self, value: object) -> object:
        response = cast(_RawResponse, value)
        try:
            status = cast(object, response.status)
            if not isinstance(status, int):
                raise PatchValidatorKubernetesResponseError
            if not 200 <= status <= 299:
                raise ApiException(status=status)
            content_type = response.headers.get("Content-Type")
            if content_type is None:
                content_type = response.headers.get("content-type")
            if not isinstance(content_type, str) or not (
                content_type == "application/json"
                or content_type.startswith("application/json;")
            ):
                raise PatchValidatorKubernetesResponseError
            content_length = response.headers.get("Content-Length")
            if content_length is None:
                content_length = response.headers.get("content-length")
            if content_length is not None:
                try:
                    parsed_length = int(content_length)
                except ValueError:
                    raise PatchValidatorKubernetesResponseError from None
                if (
                    parsed_length < 0
                    or parsed_length > PATCH_VALIDATOR_KUBERNETES_RESPONSE_LIMIT
                ):
                    raise PatchValidatorKubernetesResponseError
            body = bytearray()
            async for chunk in response.content.iter_chunked(64 * 1024):
                body.extend(chunk)
                if len(body) > PATCH_VALIDATOR_KUBERNETES_RESPONSE_LIMIT:
                    raise PatchValidatorKubernetesResponseError
            if content_length is not None and len(body) != int(content_length):
                raise PatchValidatorKubernetesResponseError
            try:
                return self._api_client.deserialize(
                    RESTResponse(response, bytes(body)),
                    "V1Deployment",
                )
            except Exception:
                raise PatchValidatorKubernetesResponseError from None
        finally:
            response.release()


@dataclass(frozen=True, slots=True)
class PatchValidatorKubernetesClients:
    api_client: ApiClient = field(repr=False)
    apps_api: PatchValidatorAppsApi = field(repr=False)
    authorization_api: AuthorizationV1Api = field(repr=False)
    version_api: VersionApi = field(repr=False)
    timeout_seconds: float
    cluster_id: str
    namespace: str

    async def close(self) -> None:
        await self.api_client.close()


async def create_patch_validator_kubernetes_clients(
    timeout_seconds: float,
    *,
    cluster_id: str,
    namespace: str,
    token_file: Path = PATCH_VALIDATOR_TOKEN_FILE,
    ca_file: Path = PATCH_VALIDATOR_CA_FILE,
) -> PatchValidatorKubernetesClients:
    if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
        raise ValueError("Kubernetes timeout must be finite and positive")
    host = _incluster_host()
    _require_ca_file(ca_file)
    configuration = Configuration()
    configuration_view = cast(_ConfigurationView, configuration)
    configuration_view.host = host
    configuration_view.ssl_ca_cert = str(ca_file)
    configuration_view.verify_ssl = True
    configuration_view.proxy = None
    configuration_view.cert_file = None
    configuration_view.key_file = None
    configuration_view.debug = False
    configuration_view.client_side_validation = True
    configuration_view.api_key_prefix["BearerToken"] = "Bearer"

    def refresh_token(client_configuration: object) -> None:
        try:
            configured = cast(_ConfigurationView, client_configuration)
            configured.api_key["BearerToken"] = _read_service_account_token(token_file)
        except KubernetesBoundaryError:
            raise
        except Exception:
            raise KubernetesBoundaryError(
                KubernetesErrorCode.AUTHENTICATION_FAILED
            ) from None

    refresh_token(configuration_view)
    configuration_view.refresh_api_key_hook = refresh_token
    api_client: ApiClient | None = None
    try:
        api_client = ApiClient(cast(Configuration, configuration_view))
        await enforce_direct_kubernetes_transport(api_client)
        generated_apps_api = AppsV1Api(api_client)
        return PatchValidatorKubernetesClients(
            api_client=api_client,
            apps_api=PatchValidatorAppsApi(generated_apps_api, api_client),
            authorization_api=AuthorizationV1Api(api_client),
            version_api=VersionApi(api_client),
            timeout_seconds=timeout_seconds,
            cluster_id=cluster_id,
            namespace=namespace,
        )
    except Exception as error:
        if api_client is not None:
            await api_client.close()
        if isinstance(error, KubernetesBoundaryError):
            raise
        raise map_kubernetes_exception(error) from None


async def verify_patch_validator_access(
    clients: PatchValidatorKubernetesClients,
) -> None:
    try:
        version = await cast(_VersionApi, clients.version_api).get_code(
            _request_timeout=clients.timeout_seconds
        )
        if (
            not isinstance(version, VersionInfo)
            or cast(_VersionInfoView, version).major != "1"
            or cast(_VersionInfoView, version).minor != "36"
        ):
            raise ValueError
        for group, resource, subresource, verb, namespace, allowed in (
            ("apps", "deployments", None, "get", clients.namespace, True),
            ("apps", "deployments", None, "patch", clients.namespace, True),
            ("apps", "deployments", None, "create", clients.namespace, False),
            ("apps", "deployments", None, "update", clients.namespace, False),
            ("apps", "deployments", None, "delete", clients.namespace, False),
            (
                "apps",
                "deployments",
                "status",
                "patch",
                clients.namespace,
                False,
            ),
            (
                "apps",
                "deployments",
                "scale",
                "patch",
                clients.namespace,
                False,
            ),
            ("", "pods", None, "get", clients.namespace, False),
            ("apps", "replicasets", None, "get", clients.namespace, False),
            ("", "pods", None, "patch", clients.namespace, False),
            ("", "secrets", None, "get", clients.namespace, False),
            (
                "authorization.k8s.io",
                "selfsubjectaccessreviews",
                None,
                "create",
                None,
                True,
            ),
            (
                "apps",
                "deployments",
                None,
                "get",
                PATCH_VALIDATOR_NAMESPACE,
                False,
            ),
            (
                "apps",
                "deployments",
                None,
                "patch",
                PATCH_VALIDATOR_NAMESPACE,
                False,
            ),
            (
                "",
                "secrets",
                None,
                "get",
                PATCH_VALIDATOR_NAMESPACE,
                False,
            ),
        ):
            await _verify_access(
                clients,
                group=group,
                resource=resource,
                subresource=subresource,
                verb=verb,
                namespace=namespace,
                expected_allowed=allowed,
            )
    except KubernetesBoundaryError:
        raise
    except Exception as error:
        raise map_kubernetes_exception(error) from None


async def _verify_access(
    clients: PatchValidatorKubernetesClients,
    *,
    group: str,
    resource: str,
    subresource: str | None,
    verb: str,
    namespace: str | None,
    expected_allowed: bool,
) -> None:
    review = await cast(
        _AuthorizationApi,
        clients.authorization_api,
    ).create_self_subject_access_review(
        body=V1SelfSubjectAccessReview(
            api_version="authorization.k8s.io/v1",
            kind="SelfSubjectAccessReview",
            spec=V1SelfSubjectAccessReviewSpec(
                resource_attributes=V1ResourceAttributes(
                    group=group,
                    version="v1",
                    resource=resource,
                    subresource=subresource,
                    verb=verb,
                    namespace=namespace,
                )
            ),
        ),
        _request_timeout=clients.timeout_seconds,
    )
    if not isinstance(review, V1SelfSubjectAccessReview):
        raise ValueError
    status_value = cast(_ReviewView, review).status
    if not isinstance(status_value, V1SubjectAccessReviewStatus):
        raise ValueError
    status = cast(_StatusView, status_value)
    if (
        type(status.allowed) is not bool
        or (status.denied is not None and type(status.denied) is not bool)
        or (
            status.evaluation_error is not None
            and (
                not isinstance(status.evaluation_error, str)
                or bool(status.evaluation_error)
            )
        )
        or (status.allowed is True and status.denied is True)
    ):
        raise ValueError
    if status.allowed is not expected_allowed:
        raise KubernetesBoundaryError(KubernetesErrorCode.PERMISSION_DENIED)


def _incluster_host() -> str:
    host = os.environ.get("KUBERNETES_SERVICE_HOST")
    port_value = os.environ.get("KUBERNETES_SERVICE_PORT")
    try:
        if host is None or port_value is None:
            raise ValueError
        if host != host.strip() or port_value != port_value.strip():
            raise ValueError
        port = int(port_value)
        authority = f"[{host}]" if ":" in host else host
        value = f"https://{authority}:{port}"
        parsed = urlsplit(value)
        if (
            not 1 <= port <= 65535
            or parsed.scheme != "https"
            or parsed.hostname is None
            or parsed.hostname.casefold() != host.casefold()
            or parsed.port != port
            or parsed.path
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError
        return value
    except ValueError:
        raise KubernetesBoundaryError(
            KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID
        ) from None


def _require_ca_file(path: Path) -> None:
    try:
        if not path.is_absolute() or not path.is_file():
            raise ValueError
    except (OSError, ValueError):
        raise KubernetesBoundaryError(
            KubernetesErrorCode.AUTHENTICATION_FAILED
        ) from None


def _read_service_account_token(path: Path) -> str:
    try:
        with path.open("rb") as token_file:
            payload = token_file.read(_TOKEN_LIMIT + 1)
        token = payload.decode("utf-8")
    except (OSError, UnicodeDecodeError):
        raise KubernetesBoundaryError(
            KubernetesErrorCode.AUTHENTICATION_FAILED
        ) from None
    if (
        not token
        or len(payload) > _TOKEN_LIMIT
        or token != token.strip()
        or any(ord(character) < 0x21 or ord(character) == 0x7F for character in token)
    ):
        raise KubernetesBoundaryError(KubernetesErrorCode.AUTHENTICATION_FAILED)
    return token
