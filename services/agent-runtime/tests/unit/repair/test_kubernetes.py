from collections.abc import AsyncIterator
from typing import Protocol, cast

import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    ApiClient,
    AuthorizationV1Api,
    V1SelfSubjectAccessReview,
    V1SubjectAccessReviewStatus,
    VersionApi,
    VersionInfo,
)

from k8s_incident_agent.repair.kubernetes import (
    PATCH_VALIDATOR_KUBERNETES_RESPONSE_LIMIT,
    PatchValidatorAppsApi,
    PatchValidatorKubernetesClients,
    PatchValidatorKubernetesResponseError,
    verify_patch_validator_access,
)


class _Content:
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks

    async def iter_chunked(self, _size: int) -> AsyncIterator[bytes]:
        for chunk in self.chunks:
            yield chunk


class _Response:
    def __init__(
        self,
        body: bytes,
        *,
        status: int = 200,
        content_length: int | None = None,
    ) -> None:
        self.status = status
        self.reason = "test"
        self.headers = {
            "Content-Type": "application/json",
            "Content-Length": str(
                len(body) if content_length is None else content_length
            ),
        }
        self.content = _Content([body])
        self.released = False

    def release(self) -> None:
        self.released = True

    def getheader(self, name: str, default: str | None = None) -> str | None:
        return self.headers.get(name, default)

    def getheaders(self) -> dict[str, str]:
        return self.headers


class _GeneratedAppsApi:
    def __init__(self, response: _Response) -> None:
        self.response = response
        self.read_calls: list[dict[str, object]] = []
        self.patch_calls: list[dict[str, object]] = []

    async def read_namespaced_deployment(self, **kwargs: object) -> object:
        self.read_calls.append(kwargs)
        return self.response

    async def patch_namespaced_deployment(self, **kwargs: object) -> object:
        self.patch_calls.append(kwargs)
        return self.response


class _Deserializer:
    def __init__(self, result: object) -> None:
        self.result = result
        self.calls: list[tuple[object, str]] = []

    def deserialize(self, response: object, response_type: str) -> object:
        self.calls.append((response, response_type))
        return self.result


@pytest.mark.asyncio
async def test_apps_facade_bounds_and_deserializes_raw_kubernetes_response() -> None:
    response = _Response(b'{"kind":"Deployment"}')
    generated = _GeneratedAppsApi(response)
    expected = object()
    deserializer = _Deserializer(expected)
    facade = PatchValidatorAppsApi(generated, deserializer)

    result = await facade.read_namespaced_deployment(
        name="workload",
        namespace="k8s-incident-scenarios",
        _request_timeout=5,
    )

    assert result is expected
    assert generated.read_calls == [
        {
            "name": "workload",
            "namespace": "k8s-incident-scenarios",
            "_preload_content": False,
            "_request_timeout": 5,
        }
    ]
    assert deserializer.calls[0][1] == "V1Deployment"
    assert response.released is True


@pytest.mark.asyncio
async def test_apps_facade_rejects_oversized_response_before_deserialization() -> None:
    response = _Response(
        b"",
        content_length=PATCH_VALIDATOR_KUBERNETES_RESPONSE_LIMIT + 1,
    )
    generated = _GeneratedAppsApi(response)
    deserializer = _Deserializer(object())
    facade = PatchValidatorAppsApi(generated, deserializer)

    with pytest.raises(PatchValidatorKubernetesResponseError):
        await facade.read_namespaced_deployment(
            name="workload",
            namespace="k8s-incident-scenarios",
            _request_timeout=5,
        )

    assert deserializer.calls == []
    assert response.released is True


type AccessKey = tuple[
    str | None,
    str | None,
    str | None,
    str | None,
    str | None,
]


class _ReviewView(Protocol):
    spec: object


class _SpecView(Protocol):
    resource_attributes: object


class _AttributesView(Protocol):
    group: object
    resource: object
    subresource: object
    verb: object
    namespace: object


class _VersionApi:
    async def get_code(self, *, _request_timeout: float) -> object:
        assert _request_timeout == 5
        return VersionInfo(
            build_date="2026-09-01T00:00:00Z",
            compiler="gc",
            git_commit="test",
            git_tree_state="clean",
            git_version="v1.36.1",
            go_version="go1.25",
            major="1",
            minor="36",
            platform="linux/amd64",
        )


class _AuthorizationApi:
    def __init__(self) -> None:
        self.calls: list[AccessKey] = []

    async def create_self_subject_access_review(
        self,
        *,
        body: object,
        _request_timeout: float,
    ) -> object:
        assert _request_timeout == 5
        spec = cast(_SpecView, cast(_ReviewView, body).spec)
        attributes = cast(_AttributesView, spec.resource_attributes)
        key = (
            cast(str | None, attributes.group),
            cast(str | None, attributes.resource),
            cast(str | None, attributes.subresource),
            cast(str | None, attributes.verb),
            cast(str | None, attributes.namespace),
        )
        self.calls.append(key)
        expected_allowed = key in {
            ("apps", "deployments", None, "get", "k8s-incident-scenarios"),
            ("apps", "deployments", None, "patch", "k8s-incident-scenarios"),
            (
                "authorization.k8s.io",
                "selfsubjectaccessreviews",
                None,
                "create",
                None,
            ),
        }
        review = cast(_ReviewView, body)
        return V1SelfSubjectAccessReview(
            api_version="authorization.k8s.io/v1",
            kind="SelfSubjectAccessReview",
            spec=review.spec,
            status=V1SubjectAccessReviewStatus(allowed=expected_allowed),
        )


class _ApiClient:
    async def close(self) -> None:
        return None


@pytest.mark.asyncio
async def test_access_gate_accepts_absent_denied_for_expected_denials() -> None:
    authorization_api = _AuthorizationApi()
    clients = PatchValidatorKubernetesClients(
        api_client=cast(ApiClient, _ApiClient()),
        apps_api=cast(PatchValidatorAppsApi, object()),
        authorization_api=cast(AuthorizationV1Api, authorization_api),
        version_api=cast(VersionApi, _VersionApi()),
        timeout_seconds=5,
        cluster_id="k8s-incident-agent",
        namespace="k8s-incident-scenarios",
    )

    await verify_patch_validator_access(clients)

    assert len(authorization_api.calls) == 15
    assert (
        "apps",
        "deployments",
        "status",
        "patch",
        "k8s-incident-scenarios",
    ) in authorization_api.calls
    assert (
        "apps",
        "deployments",
        None,
        "get",
        "k8s-incident-agent",
    ) in authorization_api.calls
