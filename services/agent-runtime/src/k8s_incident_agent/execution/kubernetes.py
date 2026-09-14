from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Protocol, cast

import aiohttp
from kubernetes.aio.client import (  # pyright: ignore[reportMissingTypeStubs]
    ApiClient,
    AppsV1Api,
)

from k8s_incident_agent.execution.contracts import ExecutionReceipt, ExecutionResult
from k8s_incident_agent.kubernetes.client import (
    create_incluster_api_client,
    enforce_direct_kubernetes_transport,
)
from k8s_incident_agent.repair.contracts import RepairProposal

KUBERNETES_TIMEOUT_SECONDS: Final = 10
_RESPONSE_LIMIT: Final = 1024 * 1024


class _GeneratedAppsApi(Protocol):
    def read_namespaced_deployment(self, **kwargs: object) -> Awaitable[object]: ...
    def patch_namespaced_deployment(self, **kwargs: object) -> Awaitable[object]: ...


class _RestClient(Protocol):
    pool_manager: object


class _SingleAttemptPool:
    def __init__(self, session: aiohttp.ClientSession) -> None:
        if not hasattr(session, "_retry_connection"):
            raise ValueError("Locked Kubernetes transport is unavailable")
        # aiohttp 3.14.3 otherwise retries some broken persistent connections.
        session._retry_connection = False  # pyright: ignore[reportPrivateUsage]
        self._session = session

    async def request(self, **kwargs: Any) -> aiohttp.ClientResponse:
        kwargs["allow_redirects"] = False
        kwargs["timeout"] = aiohttp.ClientTimeout(
            total=KUBERNETES_TIMEOUT_SECONDS,
            ceil_threshold=float("inf"),
        )
        return await self._session.request(**kwargs)

    async def close(self) -> None:
        await self._session.close()


async def configure_executor_transport(api_client: ApiClient) -> None:
    await enforce_direct_kubernetes_transport(api_client)
    rest = cast(_RestClient, api_client.rest_client)
    session = rest.pool_manager
    if not isinstance(session, aiohttp.ClientSession):
        raise ValueError("Locked Kubernetes transport is unavailable")
    rest.pool_manager = _SingleAttemptPool(session)


async def create_executor_kubernetes() -> ExecutorKubernetes:
    api_client = create_incluster_api_client()
    try:
        await configure_executor_transport(api_client)
        return ExecutorKubernetes(AppsV1Api(api_client), api_client=api_client)
    except BaseException:
        await api_client.close()
        raise


@dataclass(frozen=True, slots=True)
class _Deployment:
    uid: str
    resource_version: str
    generation: int
    container_name: str
    image: str


class _RejectedResponse(RuntimeError):
    def __init__(self, status: int) -> None:
        self.status = status
        super().__init__("Kubernetes rejected the request")


class _TargetDrift(ValueError):
    pass


class ExecutorKubernetes:
    def __init__(
        self, apps_api: object, *, api_client: ApiClient | None = None
    ) -> None:
        self._apps = cast(_GeneratedAppsApi, apps_api)
        self._api_client = api_client

    async def close(self) -> None:
        if self._api_client is not None:
            await self._api_client.close()

    async def apply(
        self,
        proposal: RepairProposal,
        *,
        start_before: datetime,
        now: Callable[[], datetime],
    ) -> ExecutionResult:
        change = proposal.change
        try:
            async with asyncio.timeout(KUBERNETES_TIMEOUT_SECONDS):
                before = await self._read_deployment(proposal)
            if (
                before.uid != change.target_uid
                or before.resource_version != change.target_resource_version
                or before.container_name != change.container_name
                or before.image != change.current_image
            ):
                return _stale()
        except _RejectedResponse as error:
            return _stale() if error.status == 404 else _rejected(error.status)
        except _TargetDrift:
            return _stale()
        except asyncio.CancelledError:
            raise
        except Exception:
            return _rejected(None)
        if now() >= start_before:
            return ExecutionResult(outcome="REJECTED", error="precondition_failed")
        try:
            async with asyncio.timeout(KUBERNETES_TIMEOUT_SECONDS):
                response = await self._apps.patch_namespaced_deployment(
                    name=change.target.name,
                    namespace=change.target.namespace,
                    body=[operation.model_dump() for operation in proposal.patch],
                    _content_type="application/json-patch+json",
                    _request_timeout=KUBERNETES_TIMEOUT_SECONDS,
                    _preload_content=False,
                )
                after = await _project_response(response, proposal)
                if (
                    after.uid != before.uid
                    or after.resource_version == before.resource_version
                    or after.generation != before.generation + 1
                    or after.container_name != change.container_name
                    or after.image != change.replacement_image
                ):
                    raise ValueError
                return ExecutionResult(
                    outcome="APPLIED",
                    receipt=ExecutionReceipt(
                        uid=after.uid,
                        resource_version=after.resource_version,
                        generation=after.generation,
                        before_generation=before.generation,
                    ),
                )
        except _RejectedResponse as error:
            return _rejected(error.status)
        except asyncio.CancelledError:
            # Process shutdown cannot prove the API server stopped the write.
            raise
        except Exception:
            return ExecutionResult(outcome="UNKNOWN", error="outcome_unknown")

    async def _read_deployment(self, proposal: RepairProposal) -> _Deployment:
        response = await self._apps.read_namespaced_deployment(
            name=proposal.target.name,
            namespace=proposal.target.namespace,
            _request_timeout=KUBERNETES_TIMEOUT_SECONDS,
            _preload_content=False,
        )
        return await _project_response(response, proposal)


async def _project_response(value: object, proposal: RepairProposal) -> _Deployment:
    response = cast(aiohttp.ClientResponse, value)
    try:
        if (
            response.headers.get("Content-Type", "").split(";", 1)[0]
            != "application/json"
        ):
            raise ValueError
        # aiohttp verifies wire framing; the budget below counts decoded bytes.
        raw = bytearray()
        async for chunk in response.content.iter_chunked(64 * 1024):
            if len(raw) + len(chunk) > _RESPONSE_LIMIT:
                raise ValueError
            raw.extend(chunk)
        document = cast(object, json.loads(raw))
        obj = _object(document)
        if response.status != 200:
            if (
                response.status in (400, 401, 403, 404, 405, 409, 415, 422, 429)
                and obj.get("apiVersion") == "v1"
                and obj.get("kind") == "Status"
                and obj.get("status") == "Failure"
                and type(obj.get("code")) is int
                and obj["code"] == response.status
            ):
                raise _RejectedResponse(response.status)
            raise ValueError
        if obj.get("apiVersion") != "apps/v1" or obj.get("kind") != "Deployment":
            raise ValueError
        metadata = _object(obj.get("metadata"))
        if (
            metadata.get("name") != proposal.target.name
            or metadata.get("namespace") != proposal.target.namespace
        ):
            raise _TargetDrift
        uid = _text(metadata.get("uid"), 253)
        rv = _text(metadata.get("resourceVersion"), 253)
        generation = metadata.get("generation")
        if type(generation) is not int or not 1 <= generation <= 2**63 - 1:
            raise ValueError
        template = _object(_object(obj.get("spec")).get("template"))
        containers = _object(template.get("spec")).get("containers")
        if not isinstance(containers, list):
            raise ValueError
        items = cast(list[object], containers)
        if not proposal.container_index < len(items):
            raise _TargetDrift
        container = _object(items[proposal.container_index])
        return _Deployment(
            uid,
            rv,
            generation,
            _text(container.get("name"), 253),
            _text(container.get("image"), 2048),
        )
    finally:
        response.release()


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError
    return cast(dict[str, object], value)


def _text(value: object, limit: int) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= limit
        or value.strip() != value
    ):
        raise ValueError
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        raise ValueError
    return value


def _stale() -> ExecutionResult:
    return ExecutionResult(outcome="STALE_RESOURCE", error="precondition_failed")


def _rejected(status: int | None) -> ExecutionResult:
    # 403/422 do not distinguish RBAC, admission, and schema/test rejection.
    error = (
        "permission_denied"
        if status == 401
        else ("precondition_failed" if status in (404, 409) else "upstream_failed")
    )
    return ExecutionResult(outcome="REJECTED", error=error)
