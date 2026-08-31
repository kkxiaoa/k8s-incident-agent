from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Protocol, cast

import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    ApiClient,
    AppsV1Api,
    AuthorizationV1Api,
    Configuration,
    CoreV1Api,
    EventsV1Api,
    V1SelfSubjectAccessReview,
    V1SubjectAccessReviewStatus,
    VersionApi,
    VersionInfo,
)
from kubernetes.aio.client.exceptions import (  # pyright: ignore[reportMissingTypeStubs]
    ApiException,
)

from k8s_incident_agent.kubernetes.access import (
    require_stage_one_target_scope,
    verify_stage_one_access,
)
from k8s_incident_agent.kubernetes.client import KubernetesClients
from k8s_incident_agent.kubernetes.errors import (
    KubernetesBoundaryError,
    KubernetesErrorCode,
)
from k8s_incident_agent.scenarios.contracts import ScenarioTarget

type AccessKey = tuple[
    str | None,
    str | None,
    str | None,
    str | None,
    str | None,
    str | None,
    str | None,
]

TARGET = ScenarioTarget(
    cluster="k8s-incident-agent",
    namespace="k8s-incident-scenarios",
    api_version="apps/v1",
    kind="Deployment",
    name="image-pull-backoff",
)

REQUIRED_DEPLOYMENT_GET: AccessKey = (
    "apps",
    "v1",
    "deployments",
    None,
    "get",
    TARGET.namespace,
    None,
)
FORBIDDEN_SECRET_GET: AccessKey = (
    "",
    "v1",
    "secrets",
    None,
    "get",
    TARGET.namespace,
    None,
)

EXPECTED_ALLOWED: frozenset[AccessKey] = frozenset(
    {
        REQUIRED_DEPLOYMENT_GET,
        ("apps", "v1", "replicasets", None, "list", TARGET.namespace, None),
        ("", "v1", "pods", None, "list", TARGET.namespace, None),
        (
            "events.k8s.io",
            "v1",
            "events",
            None,
            "list",
            TARGET.namespace,
            None,
        ),
        (
            "authorization.k8s.io",
            "v1",
            "selfsubjectaccessreviews",
            None,
            "create",
            None,
            None,
        ),
    }
)

EXPECTED_DENIED: frozenset[AccessKey] = frozenset(
    {
        FORBIDDEN_SECRET_GET,
        ("", "v1", "pods", "exec", "create", TARGET.namespace, None),
        *{
            (
                "apps",
                "v1",
                "deployments",
                None,
                verb,
                TARGET.namespace,
                None,
            )
            for verb in ("create", "update", "patch", "delete")
        },
    }
)


class _ReviewView(Protocol):
    spec: object


class _ReviewSpecView(Protocol):
    resource_attributes: object


class _ResourceAttributesView(Protocol):
    group: object
    version: object
    resource: object
    subresource: object
    verb: object
    namespace: object
    name: object


def _optional_string(value: object) -> str | None:
    assert value is None or isinstance(value, str)
    return value


def _access_key(review: object) -> AccessKey:
    spec = cast(_ReviewSpecView, cast(_ReviewView, review).spec)
    attributes = cast(_ResourceAttributesView, spec.resource_attributes)
    return (
        _optional_string(attributes.group),
        _optional_string(attributes.version),
        _optional_string(attributes.resource),
        _optional_string(attributes.subresource),
        _optional_string(attributes.verb),
        _optional_string(attributes.namespace),
        _optional_string(attributes.name),
    )


def _version(*, major: str = "1", minor: str = "36") -> VersionInfo:
    return VersionInfo(
        build_date="2026-08-01T00:00:00Z",
        compiler="gc",
        git_commit="test-commit",
        git_tree_state="clean",
        git_version=f"v{major}.{minor}.1",
        go_version="go1.25",
        major=major,
        minor=minor,
        platform="darwin/arm64",
    )


class _ScriptedVersionApi:
    def __init__(self, result: object) -> None:
        self.result = result
        self.timeouts: list[float] = []

    async def get_code(self, *, _request_timeout: float) -> object:
        self.timeouts.append(_request_timeout)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


_DEFAULT_STATUS = object()


class _ScriptedAuthorizationApi:
    def __init__(
        self,
        *,
        decisions: dict[AccessKey, bool] | None = None,
        response_status: object = _DEFAULT_STATUS,
        error: Exception | None = None,
    ) -> None:
        self.decisions = decisions or {}
        self.response_status = response_status
        self.error = error
        self.calls: list[tuple[AccessKey, float]] = []

    async def create_self_subject_access_review(
        self,
        body: object,
        *,
        _request_timeout: float,
    ) -> V1SelfSubjectAccessReview:
        key = _access_key(body)
        self.calls.append((key, _request_timeout))
        if self.error is not None:
            raise self.error
        allowed = self.decisions.get(key, key in EXPECTED_ALLOWED)
        status = self.response_status
        if status is _DEFAULT_STATUS:
            status = V1SubjectAccessReviewStatus(
                allowed=allowed,
                denied=not allowed,
            )
        review = cast(_ReviewView, body)
        return V1SelfSubjectAccessReview(
            api_version="authorization.k8s.io/v1",
            kind="SelfSubjectAccessReview",
            spec=review.spec,
            status=status,
        )


@asynccontextmanager
async def _clients(
    version_api: _ScriptedVersionApi,
    authorization_api: _ScriptedAuthorizationApi,
    *,
    cluster_id: str = TARGET.cluster,
    diagnostic_namespace: str = TARGET.namespace,
) -> AsyncGenerator[KubernetesClients]:
    api_client = ApiClient(Configuration())
    clients = KubernetesClients(
        api_client=api_client,
        apps_api=AppsV1Api(api_client),
        core_api=CoreV1Api(api_client),
        events_api=EventsV1Api(api_client),
        version_api=cast(VersionApi, version_api),
        authorization_api=cast(AuthorizationV1Api, authorization_api),
        timeout_seconds=10,
        cluster_id=cluster_id,
        diagnostic_namespace=diagnostic_namespace,
    )
    try:
        yield clients
    finally:
        await clients.close()


@pytest.mark.asyncio
async def test_gate_checks_exact_version_and_fixed_allow_deny_matrix() -> None:
    version_api = _ScriptedVersionApi(_version())
    authorization_api = _ScriptedAuthorizationApi()

    async with _clients(version_api, authorization_api) as clients:
        await verify_stage_one_access(clients)

    assert version_api.timeouts == [10]
    assert {key for key, _ in authorization_api.calls} == (
        EXPECTED_ALLOWED | EXPECTED_DENIED
    )
    assert len(authorization_api.calls) == len(EXPECTED_ALLOWED | EXPECTED_DENIED)
    assert {timeout for _, timeout in authorization_api.calls} == {10}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "version_result",
    [_version(major="2"), _version(minor="35"), object()],
    ids=["wrong-major", "wrong-minor", "wrong-model"],
)
async def test_gate_rejects_unsupported_version_contract(
    version_result: object,
) -> None:
    authorization_api = _ScriptedAuthorizationApi()

    async with _clients(
        _ScriptedVersionApi(version_result), authorization_api
    ) as clients:
        with pytest.raises(KubernetesBoundaryError) as captured:
            await verify_stage_one_access(clients)

    assert captured.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID
    assert authorization_api.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("key", "unexpected_decision"),
    [
        (REQUIRED_DEPLOYMENT_GET, False),
        (FORBIDDEN_SECRET_GET, True),
    ],
    ids=["required-read-denied", "forbidden-operation-allowed"],
)
async def test_gate_fails_when_fixed_permission_expectation_is_not_met(
    key: AccessKey,
    unexpected_decision: bool,
) -> None:
    authorization_api = _ScriptedAuthorizationApi(decisions={key: unexpected_decision})

    async with _clients(_ScriptedVersionApi(_version()), authorization_api) as clients:
        with pytest.raises(KubernetesBoundaryError) as captured:
            await verify_stage_one_access(clients)

    assert captured.value.code is KubernetesErrorCode.PERMISSION_DENIED


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status",
    [
        None,
        object(),
        V1SubjectAccessReviewStatus(allowed=True, denied=True),
        V1SubjectAccessReviewStatus(
            allowed=True,
            denied=False,
            evaluation_error="sensitive authorizer detail",
        ),
    ],
    ids=["missing", "wrong-model", "inconsistent", "evaluation-error"],
)
async def test_gate_rejects_malformed_authorization_status(status: object) -> None:
    authorization_api = _ScriptedAuthorizationApi(response_status=status)

    async with _clients(_ScriptedVersionApi(_version()), authorization_api) as clients:
        with pytest.raises(KubernetesBoundaryError) as captured:
            await verify_stage_one_access(clients)

    assert captured.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID
    assert "sensitive authorizer detail" not in str(captured.value)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("upstream_error", "expected_code"),
    [
        (ApiException(status=403), KubernetesErrorCode.PERMISSION_DENIED),
        (TimeoutError(), KubernetesErrorCode.REQUEST_TIMEOUT),
    ],
)
async def test_gate_preserves_typed_upstream_failure_categories(
    upstream_error: Exception,
    expected_code: KubernetesErrorCode,
) -> None:
    authorization_api = _ScriptedAuthorizationApi(error=upstream_error)

    async with _clients(_ScriptedVersionApi(_version()), authorization_api) as clients:
        with pytest.raises(KubernetesBoundaryError) as captured:
            await verify_stage_one_access(clients)

    assert captured.value.code is expected_code


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("cluster", "another-cluster"),
        ("namespace", "default"),
        ("api_version", "apps/v2"),
        ("kind", "StatefulSet"),
    ],
)
def test_target_scope_rejects_catalog_target_outside_configured_scope(
    field: str,
    value: str,
) -> None:
    target = TARGET.model_copy(update={field: value})

    with pytest.raises(KubernetesBoundaryError) as captured:
        require_stage_one_target_scope(
            target,
            cluster_id=TARGET.cluster,
            diagnostic_namespace=TARGET.namespace,
        )

    assert captured.value.code is KubernetesErrorCode.UPSTREAM_CONTRACT_INVALID
