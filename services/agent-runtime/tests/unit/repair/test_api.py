from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import cast
from uuid import uuid4

import httpx
import pytest

from k8s_incident_agent.config import PatchValidatorSettings
from k8s_incident_agent.domain.contracts import KubernetesTarget
from k8s_incident_agent.domain.models import JsonValue
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.repair.api import (
    PatchValidatorContainer,
    create_patch_validator_app,
)
from k8s_incident_agent.repair.auth import (
    NonceReplayCache,
    request_signature,
    verify_response_authentication,
)
from k8s_incident_agent.repair.client import (
    PATCH_VALIDATOR_BODY_LIMIT,
    PATCH_VALIDATOR_NONCE_HEADER,
    PATCH_VALIDATOR_PATH,
    PATCH_VALIDATOR_RESPONSE_SIGNATURE_HEADER,
    PATCH_VALIDATOR_SIGNATURE_HEADER,
    PATCH_VALIDATOR_TIMESTAMP_HEADER,
)
from k8s_incident_agent.repair.compiler import compile_repair_proposal
from k8s_incident_agent.repair.contracts import (
    EvidenceBoundImageChange,
    PatchValidationChange,
    PatchValidationRequest,
    PatchValidationResponse,
    PatchValidatorBoundaryError,
)
from k8s_incident_agent.repair.validator import PatchValidationService

NOW = datetime(2026, 9, 7, 12, 0, tzinfo=UTC)
KEY = b"0123456789abcdef0123456789abcdef"
NONCE = "n" * 43


class _Service:
    def __init__(self) -> None:
        self.requests: list[PatchValidationRequest] = []

    async def validate(
        self,
        request: PatchValidationRequest,
    ) -> PatchValidationResponse:
        self.requests.append(request)
        return PatchValidationResponse(
            proposal_id=request.proposal_id,
            run_id=request.change.run_id,
            proposal_digest=request.proposal_digest,
            outcome="passed",
            checked_at=NOW,
            error=None,
        )


def _request() -> PatchValidationRequest:
    proposal = compile_repair_proposal(
        EvidenceBoundImageChange(
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
            current_image="registry.invalid/workload:v2",
            replacement_image="registry.k8s.io/agnhost:2.53",
            evidence_ids=sorted([uuid4(), uuid4()], key=str),
        ),
        schema_checked_at=NOW,
        policy_checked_at=NOW,
        diff_checked_at=NOW,
    )
    return PatchValidationRequest(
        proposal_id=proposal.id,
        change=PatchValidationChange.from_proposal(proposal),
        proposal_digest=proposal.digest,
        deadline=NOW + timedelta(seconds=10),
    )


def _app(service: _Service):
    @asynccontextmanager
    async def context(
        _settings: PatchValidatorSettings,
    ) -> AsyncGenerator[PatchValidatorContainer]:
        yield PatchValidatorContainer(
            service=cast(PatchValidationService, service),
            key=KEY,
            replay_cache=NonceReplayCache(freshness_seconds=30),
            now=lambda: NOW,
        )

    return create_patch_validator_app(
        settings=PatchValidatorSettings(_env_file=None),  # pyright: ignore[reportCallIssue]
        context_factory=context,
    )


def _body(contract: PatchValidationRequest) -> bytes:
    return canonical_json(
        cast(dict[str, JsonValue], contract.model_dump(mode="json"))
    ).encode()


def _headers(body: bytes, *, signature: str | None = None) -> dict[str, str]:
    timestamp = str(int(NOW.timestamp()))
    return {
        "content-type": "application/json",
        PATCH_VALIDATOR_TIMESTAMP_HEADER: timestamp,
        PATCH_VALIDATOR_NONCE_HEADER: NONCE,
        PATCH_VALIDATOR_SIGNATURE_HEADER: signature
        or request_signature(KEY, timestamp, NONCE, body),
    }


@pytest.mark.asyncio
async def test_api_authenticates_before_parsing_and_signs_success() -> None:
    service = _Service()
    app = _app(service)
    body = _body(_request())
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://patch-validator.test",
        ) as client,
    ):
        response = await client.post(
            PATCH_VALIDATOR_PATH,
            content=body,
            headers=_headers(body),
        )

    assert response.status_code == 200
    assert len(service.requests) == 1
    verify_response_authentication(
        key=KEY,
        status_code=response.status_code,
        nonce=NONCE,
        signature=response.headers[PATCH_VALIDATOR_RESPONSE_SIGNATURE_HEADER],
        body=response.content,
    )


@pytest.mark.asyncio
async def test_api_rejects_bad_signature_before_parsing_invalid_json() -> None:
    service = _Service()
    app = _app(service)
    body = b"not-json"
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://patch-validator.test",
        ) as client,
    ):
        response = await client.post(
            PATCH_VALIDATOR_PATH,
            content=body,
            headers=_headers(body, signature="0" * 64),
        )

    assert response.status_code == 401
    assert service.requests == []
    verify_response_authentication(
        key=KEY,
        status_code=response.status_code,
        nonce=NONCE,
        signature=response.headers[PATCH_VALIDATOR_RESPONSE_SIGNATURE_HEADER],
        body=response.content,
    )
    error = PatchValidatorBoundaryError.model_validate_json(response.content)
    assert error.error.code == "patch_validator_authentication_failed"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "header_name",
    [
        PATCH_VALIDATOR_TIMESTAMP_HEADER,
        PATCH_VALIDATOR_NONCE_HEADER,
        PATCH_VALIDATOR_SIGNATURE_HEADER,
    ],
)
async def test_api_rejects_duplicate_authentication_headers(
    header_name: str,
) -> None:
    service = _Service()
    app = _app(service)
    body = _body(_request())
    headers = list(_headers(body).items())
    duplicate_value = next(value for name, value in headers if name == header_name)
    headers.append((header_name, duplicate_value))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://patch-validator.test",
        ) as client,
    ):
        response = await client.post(
            PATCH_VALIDATOR_PATH,
            content=body,
            headers=headers,
        )

    assert response.status_code == 401
    assert service.requests == []


@pytest.mark.asyncio
async def test_api_rejects_replay_and_oversized_body_without_service_call() -> None:
    service = _Service()
    app = _app(service)
    body = _body(_request())
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://patch-validator.test",
        ) as client,
    ):
        first = await client.post(
            PATCH_VALIDATOR_PATH,
            content=body,
            headers=_headers(body),
        )
        replay = await client.post(
            PATCH_VALIDATOR_PATH,
            content=body,
            headers=_headers(body),
        )
        oversized_body = b"x" * (PATCH_VALIDATOR_BODY_LIMIT + 1)
        oversized = await client.post(
            PATCH_VALIDATOR_PATH,
            content=oversized_body,
            headers=_headers(oversized_body),
        )

    assert first.status_code == 200
    assert replay.status_code == 409
    assert oversized.status_code == 413
    assert len(service.requests) == 1
