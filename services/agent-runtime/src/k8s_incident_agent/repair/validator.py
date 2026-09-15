from __future__ import annotations

import asyncio
import copy
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol, cast

import aiohttp
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    V1Container,
    V1Deployment,
    V1DeploymentSpec,
    V1ObjectMeta,
    V1PodSpec,
    V1PodTemplateSpec,
    V1ResourceAttributes,
    V1SelfSubjectAccessReview,
    V1SelfSubjectAccessReviewSpec,
    V1SubjectAccessReviewStatus,
)
from kubernetes.aio.client.exceptions import (  # pyright: ignore[reportMissingTypeStubs]
    ApiException,
)

from k8s_incident_agent.repair.compiler import compile_repair_proposal
from k8s_incident_agent.repair.contracts import (
    EvidenceBoundImageChange,
    PatchValidationErrorCode,
    PatchValidationRequest,
    PatchValidationResponse,
)
from k8s_incident_agent.repair.kubernetes import (
    PatchValidatorKubernetesResponseError,
)


class _AppsApi(Protocol):
    def read_namespaced_deployment(self, **kwargs: object) -> Awaitable[object]: ...

    def patch_namespaced_deployment(self, **kwargs: object) -> Awaitable[object]: ...


class _AuthorizationApi(Protocol):
    def create_self_subject_access_review(
        self,
        *,
        body: object,
        _request_timeout: float,
    ) -> Awaitable[object]: ...


class _ApiExceptionView(Protocol):
    status: object


class _DeploymentView(Protocol):
    api_version: object
    kind: object
    metadata: object
    spec: object


class _MetadataView(Protocol):
    namespace: object
    name: object
    uid: object
    resource_version: object


class _DeploymentSpecView(Protocol):
    template: object

    def to_dict(self) -> object: ...


class _TemplateView(Protocol):
    spec: object


class _PodSpecView(Protocol):
    containers: object


class _ContainerView(Protocol):
    name: object
    image: object


class _ReviewView(Protocol):
    status: object


class _StatusView(Protocol):
    allowed: object
    denied: object
    evaluation_error: object


@dataclass(frozen=True, slots=True)
class _ContainerState:
    name: str
    image: str


@dataclass(frozen=True, slots=True)
class _DeploymentState:
    api_version: str
    kind: str
    namespace: str
    name: str
    uid: str
    resource_version: str
    spec: dict[str, object]
    containers: list[_ContainerState]


class PatchValidationService:
    def __init__(
        self,
        *,
        apps_api: object,
        authorization_api: object,
        cluster_id: str,
        namespace: str,
        timeout_seconds: float,
        now: Callable[[], datetime],
    ) -> None:
        if not cluster_id or not namespace or timeout_seconds <= 0:
            raise ValueError("Patch Validator Kubernetes scope is invalid")
        self._apps_api = cast(_AppsApi, apps_api)
        self._authorization_api = cast(_AuthorizationApi, authorization_api)
        self._cluster_id = cluster_id
        self._namespace = namespace
        self._timeout_seconds = timeout_seconds
        self._now = now

    async def validate(
        self,
        request: PatchValidationRequest,
    ) -> PatchValidationResponse:
        now = self._now().astimezone(UTC)
        change = request.change
        if (
            change.target.cluster != self._cluster_id
            or change.target.namespace != self._namespace
            or change.target.api_version != "apps/v1"
            or change.target.kind != "Deployment"
            or request.deadline <= now
        ):
            code = (
                "patch_validator_timeout"
                if request.deadline <= now
                else "patch_validator_contract_invalid"
            )
            return _failure(request, now, code, code == "patch_validator_timeout")
        remaining = (request.deadline - now).total_seconds()
        timeout = min(self._timeout_seconds, remaining)
        operation = "read"
        try:
            current_value = await self._apps_api.read_namespaced_deployment(
                name=change.target.name,
                namespace=self._namespace,
                _request_timeout=timeout,
            )
            current = _normalize_deployment(current_value)
            containers = current.containers
            matching_indexes = [
                index
                for index, container in enumerate(containers)
                if container.name == change.container_name
            ]
            if (
                not _matches_identity(current, request)
                or current.resource_version != change.target_resource_version
                or len(matching_indexes) != 1
                or containers[matching_indexes[0]].image != change.current_image
            ):
                return _failure(request, self._now(), "stale_resource", False)
            container_index = matching_indexes[0]
            bound_change = EvidenceBoundImageChange(
                run_id=change.run_id,
                action=change.action,
                target=change.target,
                target_uid=change.target_uid,
                target_resource_version=change.target_resource_version,
                container_index=container_index,
                container_name=change.container_name,
                current_image=change.current_image,
                replacement_image=change.replacement_image,
                evidence_ids=change.evidence_ids,
                source_execution_id=change.source_execution_id,
            )
            expected = compile_repair_proposal(
                bound_change,
                schema_checked_at=now,
                policy_checked_at=now,
                diff_checked_at=now,
            )
            if (
                expected.id != request.proposal_id
                or expected.digest != request.proposal_digest
            ):
                return _failure(
                    request,
                    self._now(),
                    "patch_validator_contract_invalid",
                    False,
                )
            try:
                expected_spec = copy.deepcopy(current.spec)
                template = cast(dict[str, object], expected_spec["template"])
                pod_spec = cast(dict[str, object], template["spec"])
                expected_containers = cast(
                    list[dict[str, object]],
                    pod_spec["containers"],
                )
                expected_containers[container_index]["image"] = change.replacement_image
            except (IndexError, KeyError, TypeError):
                raise PatchValidatorKubernetesResponseError from None
            remaining = (request.deadline - self._now().astimezone(UTC)).total_seconds()
            if remaining <= 0:
                return _failure(
                    request,
                    self._now(),
                    "patch_validator_timeout",
                    True,
                )
            timeout = min(self._timeout_seconds, remaining)
            operation = "patch"
            patched_value = await self._apps_api.patch_namespaced_deployment(
                name=change.target.name,
                namespace=self._namespace,
                body=[
                    operation.model_dump(mode="json") for operation in expected.patch
                ],
                dry_run="All",
                _content_type="application/json-patch+json",
                _request_timeout=timeout,
            )
            patched = _normalize_deployment(patched_value)
            patched_containers = patched.containers
            if (
                not _matches_identity(patched, request)
                or patched.spec != expected_spec
                or container_index >= len(patched_containers)
                or patched_containers[container_index].image != change.replacement_image
            ):
                return _failure(
                    request,
                    self._now(),
                    "patch_validator_contract_invalid",
                    False,
                )
            return PatchValidationResponse(
                proposal_id=request.proposal_id,
                run_id=change.run_id,
                proposal_digest=request.proposal_digest,
                outcome="passed",
                checked_at=self._now().astimezone(UTC),
                error=None,
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if operation == "patch" and isinstance(error, ApiException):
                code, retryable = await self._classify_patch_error(error, request)
            else:
                code, retryable = _classify_error(error)
            return _failure(request, self._now(), code, retryable)

    async def _classify_patch_error(
        self,
        error: ApiException,
        request: PatchValidationRequest,
    ) -> tuple[PatchValidationErrorCode, bool]:
        status = cast(_ApiExceptionView, error).status
        if status == 403:
            try:
                allowed = await self._patch_access_allowed(request)
            except asyncio.CancelledError:
                raise
            except Exception as secondary_error:
                return _classify_error(secondary_error)
            return (
                ("patch_validator_admission_denied", False)
                if allowed
                else ("patch_validator_permission_denied", False)
            )
        if status == 422:
            try:
                current_value = await self._apps_api.read_namespaced_deployment(
                    name=request.change.target.name,
                    namespace=self._namespace,
                    _request_timeout=self._remaining_timeout(request),
                )
                current = _normalize_deployment(current_value)
            except asyncio.CancelledError:
                raise
            except Exception as secondary_error:
                return _classify_error(secondary_error)
            return (
                ("patch_validator_admission_denied", False)
                if _request_matches_deployment(current, request)
                else ("stale_resource", False)
            )
        return _classify_error(error, patch_operation=True)

    async def _patch_access_allowed(
        self,
        request: PatchValidationRequest,
    ) -> bool:
        response = await self._authorization_api.create_self_subject_access_review(
            body=V1SelfSubjectAccessReview(
                api_version="authorization.k8s.io/v1",
                kind="SelfSubjectAccessReview",
                spec=V1SelfSubjectAccessReviewSpec(
                    resource_attributes=V1ResourceAttributes(
                        group="apps",
                        version="v1",
                        resource="deployments",
                        verb="patch",
                        namespace=self._namespace,
                        name=request.change.target.name,
                    )
                ),
            ),
            _request_timeout=self._remaining_timeout(request),
        )
        if not isinstance(response, V1SelfSubjectAccessReview):
            raise PatchValidatorKubernetesResponseError
        status_value = cast(_ReviewView, response).status
        if not isinstance(status_value, V1SubjectAccessReviewStatus):
            raise PatchValidatorKubernetesResponseError
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
            raise PatchValidatorKubernetesResponseError
        return status.allowed

    def _remaining_timeout(self, request: PatchValidationRequest) -> float:
        remaining = (request.deadline - self._now().astimezone(UTC)).total_seconds()
        if remaining <= 0:
            raise TimeoutError
        return min(self._timeout_seconds, remaining)


def _normalize_deployment(value: object) -> _DeploymentState:
    if not isinstance(value, V1Deployment):
        raise PatchValidatorKubernetesResponseError
    deployment = cast(_DeploymentView, value)
    metadata_value = deployment.metadata
    spec_value = deployment.spec
    if not isinstance(metadata_value, V1ObjectMeta) or not isinstance(
        spec_value,
        V1DeploymentSpec,
    ):
        raise PatchValidatorKubernetesResponseError
    metadata = cast(_MetadataView, metadata_value)
    spec = cast(_DeploymentSpecView, spec_value)
    template_value = spec.template
    if not isinstance(template_value, V1PodTemplateSpec):
        raise PatchValidatorKubernetesResponseError
    pod_spec_value = cast(_TemplateView, template_value).spec
    if not isinstance(pod_spec_value, V1PodSpec):
        raise PatchValidatorKubernetesResponseError
    containers_value = cast(_PodSpecView, pod_spec_value).containers
    serialized_spec = spec.to_dict()
    identity_values = (
        deployment.api_version,
        deployment.kind,
        metadata.namespace,
        metadata.name,
        metadata.uid,
        metadata.resource_version,
    )
    if (
        not isinstance(containers_value, list)
        or not isinstance(serialized_spec, dict)
        or not all(isinstance(item, str) and item for item in identity_values)
    ):
        raise PatchValidatorKubernetesResponseError
    containers: list[_ContainerState] = []
    for container_value in cast(list[object], containers_value):
        if not isinstance(container_value, V1Container):
            raise PatchValidatorKubernetesResponseError
        container = cast(_ContainerView, container_value)
        if not isinstance(container.name, str) or not isinstance(container.image, str):
            raise PatchValidatorKubernetesResponseError
        containers.append(_ContainerState(name=container.name, image=container.image))
    api_version, kind, namespace, name, uid, resource_version = cast(
        tuple[str, str, str, str, str, str],
        identity_values,
    )
    return _DeploymentState(
        api_version=api_version,
        kind=kind,
        namespace=namespace,
        name=name,
        uid=uid,
        resource_version=resource_version,
        spec=cast(dict[str, object], serialized_spec),
        containers=containers,
    )


def _matches_identity(
    deployment: _DeploymentState,
    request: PatchValidationRequest,
) -> bool:
    change = request.change
    return (
        deployment.api_version == "apps/v1"
        and deployment.kind == "Deployment"
        and deployment.namespace == change.target.namespace
        and deployment.name == change.target.name
        and deployment.uid == change.target_uid
    )


def _request_matches_deployment(
    deployment: _DeploymentState,
    request: PatchValidationRequest,
) -> bool:
    matching = [
        container
        for container in deployment.containers
        if container.name == request.change.container_name
    ]
    return (
        _matches_identity(deployment, request)
        and deployment.resource_version == request.change.target_resource_version
        and len(matching) == 1
        and matching[0].image == request.change.current_image
    )


def _classify_error(
    error: Exception,
    *,
    patch_operation: bool = False,
) -> tuple[PatchValidationErrorCode, bool]:
    if isinstance(error, TimeoutError):
        return "patch_validator_timeout", True
    if isinstance(error, PatchValidatorKubernetesResponseError):
        return "patch_validator_upstream_failed", True
    if isinstance(error, ApiException):
        status = cast(_ApiExceptionView, error).status
        if status == 401:
            return "patch_validator_authentication_failed", False
        if status == 403:
            return "patch_validator_permission_denied", False
        if status in {404, 409}:
            return "stale_resource", False
        if status in {400, 422}:
            return (
                "patch_validator_admission_denied"
                if patch_operation
                else "patch_validator_contract_invalid",
                False,
            )
        if (
            status == 0
            or status == 429
            or (isinstance(status, int) and 500 <= status <= 599)
        ):
            return "patch_validator_upstream_failed", True
    if isinstance(error, (aiohttp.ClientError, OSError)):
        return "patch_validator_upstream_failed", True
    return "patch_validator_contract_invalid", False


def _failure(
    request: PatchValidationRequest,
    checked_at: datetime,
    code: PatchValidationErrorCode,
    retryable: bool,
) -> PatchValidationResponse:
    return PatchValidationResponse.model_validate(
        {
            "proposal_id": request.proposal_id,
            "run_id": request.change.run_id,
            "proposal_digest": request.proposal_digest,
            "outcome": "failed",
            "checked_at": checked_at.astimezone(UTC),
            "error": {"code": code, "retryable": retryable},
        }
    )
