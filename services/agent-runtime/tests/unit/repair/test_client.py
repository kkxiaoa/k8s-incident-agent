from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest

from k8s_incident_agent.domain.contracts import KubernetesTarget
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.repair.auth import response_signature
from k8s_incident_agent.repair.client import (
    PATCH_VALIDATOR_BODY_LIMIT,
    PatchValidatorClient,
)
from k8s_incident_agent.repair.compiler import compile_repair_proposal
from k8s_incident_agent.repair.contracts import (
    EvidenceBoundImageChange,
    PatchValidationResponse,
)

NOW = datetime(2026, 9, 6, 12, 0, tzinfo=UTC)
KEY = b"0123456789abcdef0123456789abcdef"


def _proposal():
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
        current_image="registry.invalid/workload:v2",
        replacement_image="registry.k8s.io/e2e-test-images/agnhost:2.53",
        evidence_ids=sorted([uuid4(), uuid4()], key=str),
    )
    return compile_repair_proposal(
        change,
        schema_checked_at=NOW,
        policy_checked_at=NOW,
        diff_checked_at=NOW,
    )


@pytest.mark.asyncio
async def test_client_verifies_signed_response_before_returning_result() -> None:
    proposal = _proposal()

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/internal/v1/validate/set-container-image"
        request_document = request.content.decode()
        assert '"patch"' not in request_document
        assert '"dryRun"' not in request_document
        assert '"container_index"' not in request_document
        nonce = request.headers["X-K8s-Incident-Nonce"]
        response = PatchValidationResponse(
            proposal_id=proposal.id,
            run_id=proposal.run_id,
            proposal_digest=proposal.digest,
            outcome="passed",
            checked_at=NOW,
            error=None,
        )
        body = canonical_json(response.model_dump(mode="json")).encode()
        return httpx.Response(
            200,
            content=body,
            headers={
                "content-type": "application/json",
                "X-K8s-Incident-Response-Signature": response_signature(
                    KEY,
                    200,
                    nonce,
                    body,
                ),
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = PatchValidatorClient(
            http=http,
            base_url="http://patch-validator.test",
            key=KEY,
            timeout_seconds=5,
            now=lambda: NOW,
        )

        result = await client.validate(
            proposal,
            deadline=NOW + timedelta(seconds=10),
        )

    assert result.outcome == "passed"
    assert result.error is None


@pytest.mark.asyncio
async def test_client_fails_closed_on_unsigned_or_substituted_response() -> None:
    proposal = _proposal()

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"{}")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = PatchValidatorClient(
            http=http,
            base_url="http://patch-validator.test",
            key=KEY,
            timeout_seconds=5,
            now=lambda: NOW,
        )
        result = await client.validate(
            proposal,
            deadline=NOW + timedelta(seconds=10),
        )

    assert result.outcome == "failed"
    assert result.error is not None
    assert result.error.code == "patch_validator_authentication_failed"
    assert result.error.retryable is False


@pytest.mark.asyncio
async def test_client_classifies_oversized_validator_response_as_upstream() -> None:
    proposal = _proposal()

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * (PATCH_VALIDATOR_BODY_LIMIT + 1))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = PatchValidatorClient(
            http=http,
            base_url="http://patch-validator.test",
            key=KEY,
            timeout_seconds=5,
            now=lambda: NOW,
        )
        result = await client.validate(
            proposal,
            deadline=NOW + timedelta(seconds=10),
        )

    assert result.error is not None
    assert result.error.code == "patch_validator_upstream_failed"
    assert result.error.retryable is True


@pytest.mark.asyncio
async def test_client_does_not_call_validator_after_run_deadline() -> None:
    proposal = _proposal()
    called = False

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(500)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = PatchValidatorClient(
            http=http,
            base_url="http://patch-validator.test",
            key=KEY,
            timeout_seconds=5,
            now=lambda: NOW,
        )
        result = await client.validate(proposal, deadline=NOW)

    assert called is False
    assert result.error is not None
    assert result.error.code == "patch_validator_timeout"
