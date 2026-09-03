from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Protocol, cast

from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    V1ResourceAttributes,
    V1SelfSubjectAccessReview,
    V1SelfSubjectAccessReviewSpec,
    V1SubjectAccessReviewStatus,
    VersionInfo,
)

from k8s_incident_agent.domain.contracts import KubernetesTarget
from k8s_incident_agent.kubernetes.client import KubernetesClients
from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    KubernetesErrorCode,
    map_kubernetes_exception,
)
from k8s_incident_agent.scenarios.contracts import (
    validate_stage_one_target,
)


class _VersionApiView(Protocol):
    def get_code(self, *, _request_timeout: float) -> Awaitable[object]: ...


class _AuthorizationApiView(Protocol):
    def create_self_subject_access_review(
        self,
        body: object,
        *,
        _request_timeout: float,
    ) -> Awaitable[object]: ...


class _VersionInfoView(Protocol):
    major: object
    minor: object


class _ReviewView(Protocol):
    status: object


class _StatusView(Protocol):
    allowed: object
    denied: object
    evaluation_error: object


@dataclass(frozen=True, slots=True)
class _AccessCheck:
    group: str
    version: str
    resource: str
    verb: str
    expected_allowed: bool
    namespace: str | None = None
    name: str | None = None
    subresource: str | None = None


async def verify_stage_one_access(
    clients: KubernetesClients,
) -> None:
    try:
        version = await cast(_VersionApiView, clients.version_api).get_code(
            _request_timeout=clients.timeout_seconds
        )
    except Exception as error:
        raise map_kubernetes_exception(error) from None
    if not isinstance(version, VersionInfo):
        raise _contract_invalid()
    version_view = cast(_VersionInfoView, version)
    if version_view.major != "1" or version_view.minor != "36":
        raise _contract_invalid()

    for check in _stage_one_checks(clients.diagnostic_namespace):
        await _verify_access_check(clients, check)


def require_stage_one_target_scope(
    target: KubernetesTarget,
    *,
    cluster_id: str,
    diagnostic_namespace: str,
) -> str:
    try:
        validate_stage_one_target(target)
    except ValueError:
        raise _contract_invalid() from None
    if target.cluster != cluster_id or target.namespace != diagnostic_namespace:
        raise _contract_invalid()
    if target.namespace is None:
        raise _contract_invalid()
    return target.namespace


def _stage_one_checks(namespace: str) -> tuple[_AccessCheck, ...]:
    return (
        _AccessCheck(
            group="apps",
            version="v1",
            resource="deployments",
            verb="get",
            namespace=namespace,
            expected_allowed=True,
        ),
        _AccessCheck(
            group="apps",
            version="v1",
            resource="replicasets",
            verb="list",
            namespace=namespace,
            expected_allowed=True,
        ),
        _AccessCheck(
            group="",
            version="v1",
            resource="pods",
            verb="list",
            namespace=namespace,
            expected_allowed=True,
        ),
        _AccessCheck(
            group="",
            version="v1",
            resource="pods",
            subresource="log",
            verb="get",
            namespace=namespace,
            expected_allowed=True,
        ),
        _AccessCheck(
            group="events.k8s.io",
            version="v1",
            resource="events",
            verb="list",
            namespace=namespace,
            expected_allowed=True,
        ),
        _AccessCheck(
            group="authorization.k8s.io",
            version="v1",
            resource="selfsubjectaccessreviews",
            verb="create",
            expected_allowed=True,
        ),
        _AccessCheck(
            group="",
            version="v1",
            resource="secrets",
            verb="get",
            namespace=namespace,
            expected_allowed=False,
        ),
        _AccessCheck(
            group="",
            version="v1",
            resource="pods",
            subresource="exec",
            verb="create",
            namespace=namespace,
            expected_allowed=False,
        ),
        _AccessCheck(
            group="",
            version="v1",
            resource="pods",
            subresource="attach",
            verb="create",
            namespace=namespace,
            expected_allowed=False,
        ),
        *(
            _AccessCheck(
                group="apps",
                version="v1",
                resource="deployments",
                verb=verb,
                namespace=namespace,
                expected_allowed=False,
            )
            for verb in ("create", "update", "patch", "delete")
        ),
    )


async def _verify_access_check(
    clients: KubernetesClients,
    check: _AccessCheck,
) -> None:
    review = V1SelfSubjectAccessReview(
        api_version="authorization.k8s.io/v1",
        kind="SelfSubjectAccessReview",
        spec=V1SelfSubjectAccessReviewSpec(
            resource_attributes=V1ResourceAttributes(
                group=check.group,
                version=check.version,
                resource=check.resource,
                subresource=check.subresource,
                verb=check.verb,
                namespace=check.namespace,
                name=check.name,
            )
        ),
    )
    try:
        response = await cast(
            _AuthorizationApiView,
            clients.authorization_api,
        ).create_self_subject_access_review(
            review,
            _request_timeout=clients.timeout_seconds,
        )
    except Exception as error:
        raise map_kubernetes_exception(error) from None
    if not isinstance(response, V1SelfSubjectAccessReview):
        raise _contract_invalid()
    status = cast(_ReviewView, response).status
    if not isinstance(status, V1SubjectAccessReviewStatus):
        raise _contract_invalid()
    status_view = cast(_StatusView, status)
    if (
        type(status_view.allowed) is not bool
        or (status_view.denied is not None and type(status_view.denied) is not bool)
        or (
            status_view.evaluation_error is not None
            and (
                not isinstance(status_view.evaluation_error, str)
                or bool(status_view.evaluation_error)
            )
        )
        or (status_view.allowed is True and status_view.denied is True)
    ):
        raise _contract_invalid()
    if status_view.allowed is not check.expected_allowed:
        raise KubernetesBoundaryError(KubernetesErrorCode.PERMISSION_DENIED)


def _contract_invalid() -> KubernetesBoundaryError:
    return KubernetesBoundaryError(KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID)
