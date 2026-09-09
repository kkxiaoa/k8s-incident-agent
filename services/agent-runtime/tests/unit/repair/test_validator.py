from datetime import UTC, datetime, timedelta
from typing import Protocol, cast
from uuid import uuid4

import pytest
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    V1Container,
    V1Deployment,
    V1DeploymentSpec,
    V1ObjectMeta,
    V1PodSpec,
    V1PodTemplateSpec,
    V1SelfSubjectAccessReview,
    V1SubjectAccessReviewStatus,
)
from kubernetes.aio.client.exceptions import (  # pyright: ignore[reportMissingTypeStubs]
    ApiException,
)

from k8s_incident_agent.domain.contracts import KubernetesTarget
from k8s_incident_agent.repair.compiler import compile_repair_proposal
from k8s_incident_agent.repair.contracts import (
    EvidenceBoundImageChange,
    PatchValidationChange,
    PatchValidationRequest,
)
from k8s_incident_agent.repair.validator import PatchValidationService

NOW = datetime(2026, 9, 6, 12, 0, tzinfo=UTC)
CURRENT = "registry.invalid/workload:v2"
PREVIOUS = "registry.k8s.io/e2e-test-images/agnhost:2.53"


def _deployment(*, uid: str = "deployment-uid", rv: str = "42", image: str = CURRENT):
    return V1Deployment(
        api_version="apps/v1",
        kind="Deployment",
        metadata=V1ObjectMeta(
            namespace="k8s-incident-scenarios",
            name="image-pull-backoff",
            uid=uid,
            resource_version=rv,
        ),
        spec=V1DeploymentSpec(
            selector={"matchLabels": {"app": "image-pull"}},
            template=V1PodTemplateSpec(
                spec=V1PodSpec(containers=[V1Container(name="workload", image=image)])
            ),
        ),
    )


class _AppsApi:
    def __init__(self, current: object | list[object], patched: object) -> None:
        if isinstance(current, list):
            self.current: list[object] = current
        else:
            self.current = [current]
        self.patched = patched
        self.read_calls: list[dict[str, object]] = []
        self.patch_calls: list[dict[str, object]] = []

    async def read_namespaced_deployment(self, **kwargs: object) -> object:
        self.read_calls.append(kwargs)
        value = self.current.pop(0) if len(self.current) > 1 else self.current[0]
        if isinstance(value, Exception):
            raise value
        return value

    async def patch_namespaced_deployment(self, **kwargs: object) -> object:
        self.patch_calls.append(kwargs)
        if isinstance(self.patched, Exception):
            raise self.patched
        return self.patched


class _AuthorizationApi:
    def __init__(self, *, allowed: bool = True) -> None:
        self.allowed = allowed
        self.calls: list[dict[str, object]] = []

    async def create_self_subject_access_review(
        self,
        **kwargs: object,
    ) -> object:
        self.calls.append(kwargs)
        body = kwargs["body"]
        assert isinstance(body, V1SelfSubjectAccessReview)
        spec = cast(_ReviewView, body).spec
        return V1SelfSubjectAccessReview(
            api_version="authorization.k8s.io/v1",
            kind="SelfSubjectAccessReview",
            spec=spec,
            status=V1SubjectAccessReviewStatus(
                allowed=self.allowed,
                denied=not self.allowed,
            ),
        )


class _ReviewView(Protocol):
    spec: object


def _request():
    change = EvidenceBoundImageChange(
        run_id=uuid4(),
        action="set_container_image",
        target=KubernetesTarget(
            cluster="k8s-incident-agent",
            namespace="k8s-incident-scenarios",
            api_version="apps/v1",
            kind="Deployment",
            name="image-pull-backoff",
        ),
        target_uid="deployment-uid",
        target_resource_version="42",
        container_index=0,
        container_name="workload",
        current_image=CURRENT,
        replacement_image=PREVIOUS,
        evidence_ids=sorted([uuid4(), uuid4()], key=str),
    )
    proposal = compile_repair_proposal(
        change,
        schema_checked_at=NOW,
        policy_checked_at=NOW,
        diff_checked_at=NOW,
    )
    return PatchValidationRequest(
        proposal_id=proposal.id,
        change=PatchValidationChange.from_proposal(proposal),
        proposal_digest=proposal.digest,
        deadline=NOW + timedelta(seconds=10),
    ), proposal


@pytest.mark.asyncio
async def test_validator_recompiles_and_sends_only_fixed_server_side_dry_run() -> None:
    request, proposal = _request()
    apps = _AppsApi(_deployment(), _deployment(image=PREVIOUS))
    service = PatchValidationService(
        apps_api=cast(object, apps),
        authorization_api=cast(object, _AuthorizationApi()),
        cluster_id="k8s-incident-agent",
        namespace="k8s-incident-scenarios",
        timeout_seconds=5,
        now=lambda: NOW,
    )

    result = await service.validate(request)

    assert result.outcome == "passed"
    assert result.proposal_digest == proposal.digest
    assert apps.read_calls == [
        {
            "name": "image-pull-backoff",
            "namespace": "k8s-incident-scenarios",
            "_request_timeout": 5,
        }
    ]
    assert apps.patch_calls == [
        {
            "name": "image-pull-backoff",
            "namespace": "k8s-incident-scenarios",
            "body": [operation.model_dump(mode="json") for operation in proposal.patch],
            "dry_run": "All",
            "_content_type": "application/json-patch+json",
            "_request_timeout": 5,
        }
    ]
    assert "field_manager" not in apps.patch_calls[0]
    assert "force" not in apps.patch_calls[0]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "current",
    [
        _deployment(uid="recreated-uid"),
        _deployment(rv="43"),
        _deployment(image="registry.example/changed:v3"),
    ],
)
async def test_validator_rejects_stale_target_without_patch(current: object) -> None:
    request, _ = _request()
    apps = _AppsApi(current, _deployment(image=PREVIOUS))
    service = PatchValidationService(
        apps_api=cast(object, apps),
        authorization_api=cast(object, _AuthorizationApi()),
        cluster_id="k8s-incident-agent",
        namespace="k8s-incident-scenarios",
        timeout_seconds=5,
        now=lambda: NOW,
    )

    result = await service.validate(request)

    assert result.outcome == "failed"
    assert result.error is not None
    assert result.error.code == "stale_resource"
    assert apps.patch_calls == []


@pytest.mark.asyncio
async def test_validator_rejects_digest_substitution_before_kubernetes() -> None:
    request, _ = _request()
    request = request.model_copy(update={"proposal_digest": f"sha256:{'0' * 64}"})
    apps = _AppsApi(_deployment(), _deployment(image=PREVIOUS))
    service = PatchValidationService(
        apps_api=cast(object, apps),
        authorization_api=cast(object, _AuthorizationApi()),
        cluster_id="k8s-incident-agent",
        namespace="k8s-incident-scenarios",
        timeout_seconds=5,
        now=lambda: NOW,
    )

    result = await service.validate(request)

    assert result.error is not None
    assert result.error.code == "patch_validator_contract_invalid"
    assert apps.read_calls == [
        {
            "name": "image-pull-backoff",
            "namespace": "k8s-incident-scenarios",
            "_request_timeout": 5,
        }
    ]
    assert apps.patch_calls == []


@pytest.mark.asyncio
async def test_validator_classifies_malformed_kubernetes_response_as_upstream() -> None:
    request, _ = _request()
    apps = _AppsApi(object(), _deployment(image=PREVIOUS))
    service = PatchValidationService(
        apps_api=cast(object, apps),
        authorization_api=cast(object, _AuthorizationApi()),
        cluster_id="k8s-incident-agent",
        namespace="k8s-incident-scenarios",
        timeout_seconds=5,
        now=lambda: NOW,
    )

    result = await service.validate(request)

    assert result.error is not None
    assert result.error.code == "patch_validator_upstream_failed"
    assert result.error.retryable is True
    assert apps.patch_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("allowed", "expected_code"),
    [
        (True, "patch_validator_admission_denied"),
        (False, "patch_validator_permission_denied"),
    ],
)
async def test_validator_distinguishes_admission_from_permission_denial(
    allowed: bool,
    expected_code: str,
) -> None:
    request, _ = _request()
    apps = _AppsApi(_deployment(), ApiException(status=403))
    authorization = _AuthorizationApi(allowed=allowed)
    service = PatchValidationService(
        apps_api=cast(object, apps),
        authorization_api=cast(object, authorization),
        cluster_id="k8s-incident-agent",
        namespace="k8s-incident-scenarios",
        timeout_seconds=5,
        now=lambda: NOW,
    )

    result = await service.validate(request)

    assert result.error is not None
    assert result.error.code == expected_code
    assert len(authorization.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("reloaded", "expected_code"),
    [
        (_deployment(), "patch_validator_admission_denied"),
        (_deployment(rv="43"), "stale_resource"),
    ],
)
async def test_validator_rechecks_target_after_unprocessable_patch(
    reloaded: object,
    expected_code: str,
) -> None:
    request, _ = _request()
    apps = _AppsApi(
        [_deployment(), reloaded],
        ApiException(status=422),
    )
    service = PatchValidationService(
        apps_api=cast(object, apps),
        authorization_api=cast(object, _AuthorizationApi()),
        cluster_id="k8s-incident-agent",
        namespace="k8s-incident-scenarios",
        timeout_seconds=5,
        now=lambda: NOW,
    )

    result = await service.validate(request)

    assert result.error is not None
    assert result.error.code == expected_code
    assert len(apps.read_calls) == 2
