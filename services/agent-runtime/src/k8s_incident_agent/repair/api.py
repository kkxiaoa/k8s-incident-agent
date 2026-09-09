from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final, cast

import uvicorn
from fastapi import FastAPI, Request, Response
from pydantic import ValidationError

from k8s_incident_agent.api_contracts import HealthResponse
from k8s_incident_agent.config import PatchValidatorSettings
from k8s_incident_agent.domain.models import JsonValue
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.repair.auth import (
    NonceReplayCache,
    PatchValidatorAuthenticationError,
    load_hmac_key,
    response_signature,
    verify_request_authentication,
)
from k8s_incident_agent.repair.client import (
    PATCH_VALIDATOR_BODY_LIMIT,
    PATCH_VALIDATOR_NONCE_HEADER,
    PATCH_VALIDATOR_PATH,
    PATCH_VALIDATOR_RESPONSE_SIGNATURE_HEADER,
    PATCH_VALIDATOR_SIGNATURE_HEADER,
    PATCH_VALIDATOR_TIMESTAMP_HEADER,
)
from k8s_incident_agent.repair.contracts import (
    PatchValidationErrorCode,
    PatchValidationRequest,
    PatchValidationResponse,
    PatchValidatorBoundaryError,
)
from k8s_incident_agent.repair.kubernetes import (
    create_patch_validator_kubernetes_clients,
    verify_patch_validator_access,
)
from k8s_incident_agent.repair.validator import PatchValidationService

_JSON_CONTENT_TYPE: Final = "application/json"


@dataclass(frozen=True, slots=True)
class PatchValidatorContainer:
    service: PatchValidationService
    key: bytes
    replay_cache: NonceReplayCache
    now: Callable[[], datetime]


type PatchValidatorContextFactory = Callable[
    [PatchValidatorSettings],
    AbstractAsyncContextManager[PatchValidatorContainer],
]


def create_patch_validator_app(
    *,
    settings: PatchValidatorSettings | None = None,
    context_factory: PatchValidatorContextFactory | None = None,
) -> FastAPI:
    factory = context_factory or build_patch_validator_container

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
        resolved_settings = settings or PatchValidatorSettings()
        async with factory(resolved_settings) as container:
            app.state.container = container
            app.state.ready = True
            try:
                yield
            finally:
                app.state.ready = False
                del app.state.container

    app = FastAPI(
        title="K8s Incident Agent Patch Validator",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.ready = False

    async def healthz() -> HealthResponse:
        return HealthResponse()

    async def validate(request: Request) -> Response:
        container = cast(PatchValidatorContainer, request.app.state.container)
        nonce = _single_header(request, PATCH_VALIDATOR_NONCE_HEADER) or ""
        try:
            body = await _read_bounded_body(request)
            timestamp = _required_single_header(
                request,
                PATCH_VALIDATOR_TIMESTAMP_HEADER,
            )
            nonce = _required_single_header(request, PATCH_VALIDATOR_NONCE_HEADER)
            signature = _required_single_header(
                request,
                PATCH_VALIDATOR_SIGNATURE_HEADER,
            )
            await verify_request_authentication(
                key=container.key,
                timestamp=timestamp,
                nonce=nonce,
                signature=signature,
                body=body,
                now=container.now().astimezone(UTC),
                replay_cache=container.replay_cache,
            )
        except PatchValidatorAuthenticationError as error:
            return _signed_boundary_error(
                container.key,
                nonce,
                error.code,
                error.retryable,
                status_code=(
                    409 if error.code == "patch_validator_replay_rejected" else 401
                ),
            )
        except ValueError:
            return _signed_boundary_error(
                container.key,
                nonce,
                "patch_validator_contract_invalid",
                False,
                status_code=413,
            )

        if _single_header(request, "content-type") != _JSON_CONTENT_TYPE:
            return _signed_boundary_error(
                container.key,
                nonce,
                "patch_validator_contract_invalid",
                False,
                status_code=415,
            )
        try:
            contract = PatchValidationRequest.model_validate_json(body)
        except ValidationError:
            return _signed_boundary_error(
                container.key,
                nonce,
                "patch_validator_contract_invalid",
                False,
                status_code=422,
            )
        try:
            result = await container.service.validate(contract)
        except asyncio.CancelledError:
            raise
        except Exception:
            return _signed_boundary_error(
                container.key,
                nonce,
                "patch_validator_upstream_failed",
                True,
                status_code=502,
            )
        return _signed_validation_response(container.key, nonce, result)

    app.add_api_route(
        "/healthz", healthz, methods=["GET"], response_model=HealthResponse
    )
    app.add_api_route(PATCH_VALIDATOR_PATH, validate, methods=["POST"])
    return app


@asynccontextmanager
async def build_patch_validator_container(
    settings: PatchValidatorSettings,
) -> AsyncGenerator[PatchValidatorContainer]:
    def now() -> datetime:
        return datetime.now(UTC)

    key = load_hmac_key(settings.patch_validator_hmac_key_file)
    clients = await create_patch_validator_kubernetes_clients(
        settings.kubernetes_timeout_seconds,
        cluster_id=settings.kubernetes_cluster_id,
        namespace=settings.kubernetes_diagnostic_namespace,
    )
    try:
        await verify_patch_validator_access(clients)
        yield PatchValidatorContainer(
            service=PatchValidationService(
                apps_api=clients.apps_api,
                authorization_api=clients.authorization_api,
                cluster_id=clients.cluster_id,
                namespace=clients.namespace,
                timeout_seconds=clients.timeout_seconds,
                now=now,
            ),
            key=key,
            replay_cache=NonceReplayCache(
                freshness_seconds=settings.patch_validator_auth_freshness_seconds,
                max_entries=settings.patch_validator_replay_capacity,
            ),
            now=now,
        )
    finally:
        await clients.close()


async def _read_bounded_body(request: Request) -> bytes:
    content_length = _single_header(request, "content-length")
    if content_length is not None:
        try:
            parsed_length = int(content_length)
        except ValueError:
            raise ValueError("Request body length is invalid") from None
        if parsed_length < 0 or parsed_length > PATCH_VALIDATOR_BODY_LIMIT:
            raise ValueError("Request body length is invalid")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > PATCH_VALIDATOR_BODY_LIMIT:
            raise ValueError("Request body is too large")
    if content_length is not None and len(body) != int(content_length):
        raise ValueError("Request body length is inconsistent")
    return bytes(body)


def _single_header(request: Request, name: str) -> str | None:
    values = request.headers.getlist(name)
    return values[0] if len(values) == 1 else None


def _required_single_header(request: Request, name: str) -> str:
    value = _single_header(request, name)
    if value is None:
        raise PatchValidatorAuthenticationError
    return value


def _signed_validation_response(
    key: bytes,
    nonce: str,
    result: PatchValidationResponse,
) -> Response:
    status_code = _validation_status(result)
    body = canonical_json(
        cast(dict[str, JsonValue], result.model_dump(mode="json"))
    ).encode()
    return _signed_response(key, nonce, status_code, body)


def _signed_boundary_error(
    key: bytes,
    nonce: str,
    code: PatchValidationErrorCode,
    retryable: bool,
    *,
    status_code: int,
) -> Response:
    contract = PatchValidatorBoundaryError.model_validate(
        {
            "error": {"code": code, "retryable": retryable},
        }
    )
    body = canonical_json(
        cast(dict[str, JsonValue], contract.model_dump(mode="json"))
    ).encode()
    return _signed_response(key, nonce, status_code, body)


def _signed_response(
    key: bytes,
    nonce: str,
    status_code: int,
    body: bytes,
) -> Response:
    return Response(
        content=body,
        status_code=status_code,
        media_type=_JSON_CONTENT_TYPE,
        headers={
            PATCH_VALIDATOR_RESPONSE_SIGNATURE_HEADER: response_signature(
                key,
                status_code,
                nonce,
                body,
            )
        },
    )


def _validation_status(result: PatchValidationResponse) -> int:
    if result.outcome == "passed":
        return 200
    if result.error is None:
        return 500
    return {
        "stale_resource": 409,
        "patch_validator_authentication_failed": 502,
        "patch_validator_replay_rejected": 502,
        "patch_validator_permission_denied": 403,
        "patch_validator_admission_denied": 422,
        "patch_validator_timeout": 504,
        "patch_validator_upstream_failed": 502,
        "patch_validator_contract_invalid": 502,
    }[result.error.code]


def create_app() -> FastAPI:
    return create_patch_validator_app(settings=PatchValidatorSettings())


def main() -> None:
    uvicorn.run(
        "k8s_incident_agent.repair.api:create_app",
        factory=True,
        host="0.0.0.0",
        port=8081,
        workers=1,
        timeout_graceful_shutdown=5,
    )
