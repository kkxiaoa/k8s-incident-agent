from __future__ import annotations

import asyncio
import secrets
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Final, Protocol, cast
from urllib.parse import urlsplit

import httpx
from pydantic import ValidationError

from k8s_incident_agent.domain.models import JsonValue
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.repair.auth import (
    PATCH_VALIDATOR_PATH,
    PatchValidatorAuthenticationError,
    request_signature,
    verify_response_authentication,
)
from k8s_incident_agent.repair.contracts import (
    PatchValidationChange,
    PatchValidationErrorCode,
    PatchValidationRequest,
    PatchValidationResponse,
    PatchValidatorBoundaryError,
    RepairProposal,
)

PATCH_VALIDATOR_TIMESTAMP_HEADER: Final = "X-K8s-Incident-Timestamp"
PATCH_VALIDATOR_NONCE_HEADER: Final = "X-K8s-Incident-Nonce"
PATCH_VALIDATOR_SIGNATURE_HEADER: Final = "X-K8s-Incident-Signature"
PATCH_VALIDATOR_RESPONSE_SIGNATURE_HEADER: Final = "X-K8s-Incident-Response-Signature"
PATCH_VALIDATOR_BODY_LIMIT: Final = 16 * 1024


class _PatchValidatorResponseBudgetError(RuntimeError):
    pass


class PatchValidator(Protocol):
    async def validate(
        self,
        proposal: RepairProposal,
        *,
        deadline: datetime,
    ) -> PatchValidationResponse: ...


class PatchValidatorClient:
    def __init__(
        self,
        *,
        http: httpx.AsyncClient,
        base_url: str,
        key: bytes,
        timeout_seconds: float,
        now: Callable[[], datetime],
    ) -> None:
        parsed = urlsplit(base_url)
        if (
            parsed.scheme != "http"
            or parsed.hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or timeout_seconds <= 0
            or len(key) != 32
        ):
            raise ValueError("Patch Validator client configuration is invalid")
        self._http = http
        self._base_url = base_url.rstrip("/")
        self._key = key
        self._timeout_seconds = timeout_seconds
        self._now = now

    async def validate(
        self,
        proposal: RepairProposal,
        *,
        deadline: datetime,
    ) -> PatchValidationResponse:
        checked_at = self._now().astimezone(UTC)
        remaining = (deadline - checked_at).total_seconds()
        if remaining <= 0:
            return _local_failure(proposal, checked_at, "patch_validator_timeout", True)
        request = PatchValidationRequest(
            proposal_id=proposal.id,
            change=PatchValidationChange.from_proposal(proposal),
            proposal_digest=proposal.digest,
            deadline=deadline,
        )
        body = canonical_json(
            cast(dict[str, JsonValue], request.model_dump(mode="json"))
        ).encode()
        if len(body) > PATCH_VALIDATOR_BODY_LIMIT:
            return _local_failure(
                proposal,
                checked_at,
                "patch_validator_contract_invalid",
                False,
            )
        timestamp = str(int(checked_at.timestamp()))
        nonce = secrets.token_urlsafe(32)
        headers = {
            "content-type": "application/json",
            PATCH_VALIDATOR_TIMESTAMP_HEADER: timestamp,
            PATCH_VALIDATOR_NONCE_HEADER: nonce,
            PATCH_VALIDATOR_SIGNATURE_HEADER: request_signature(
                self._key,
                timestamp,
                nonce,
                body,
            ),
        }
        timeout_seconds = min(self._timeout_seconds, remaining)
        response: httpx.Response | None = None
        try:
            async with asyncio.timeout(timeout_seconds):
                outbound = self._http.build_request(
                    "POST",
                    f"{self._base_url}{PATCH_VALIDATOR_PATH}",
                    headers=headers,
                    content=body,
                )
                received_response = await self._http.send(outbound, stream=True)
                response = received_response
                response_body = bytearray()
                async for chunk in received_response.aiter_bytes():
                    response_body.extend(chunk)
                    if len(response_body) > PATCH_VALIDATOR_BODY_LIMIT:
                        raise _PatchValidatorResponseBudgetError
        except TimeoutError:
            return _local_failure(
                proposal,
                self._now().astimezone(UTC),
                "patch_validator_timeout",
                True,
            )
        except (httpx.HTTPError, OSError, _PatchValidatorResponseBudgetError):
            return _local_failure(
                proposal,
                self._now().astimezone(UTC),
                "patch_validator_upstream_failed",
                True,
            )
        except ValueError:
            return _local_failure(
                proposal,
                self._now().astimezone(UTC),
                "patch_validator_contract_invalid",
                False,
            )
        finally:
            if response is not None:
                await response.aclose()

        assert response is not None
        raw = bytes(response_body)
        try:
            signature = response.headers[PATCH_VALIDATOR_RESPONSE_SIGNATURE_HEADER]
            verify_response_authentication(
                key=self._key,
                status_code=response.status_code,
                nonce=nonce,
                signature=signature,
                body=raw,
            )
        except (KeyError, PatchValidatorAuthenticationError):
            return _local_failure(
                proposal,
                self._now().astimezone(UTC),
                "patch_validator_authentication_failed",
                False,
            )
        try:
            if response.headers.get("content-type", "").split(";", 1)[0] != (
                "application/json"
            ):
                raise ValueError
            if response.status_code != 200:
                try:
                    boundary_error = PatchValidatorBoundaryError.model_validate_json(
                        raw
                    )
                except ValidationError:
                    boundary_error = None
                if boundary_error is not None:
                    return _local_failure(
                        proposal,
                        self._now().astimezone(UTC),
                        boundary_error.error.code,
                        boundary_error.error.retryable,
                    )
            result = PatchValidationResponse.model_validate_json(raw)
            if (
                result.proposal_id != proposal.id
                or result.run_id != proposal.run_id
                or result.proposal_digest != proposal.digest
                or (result.outcome == "passed") is not (response.status_code == 200)
                or result.checked_at > deadline
            ):
                raise ValueError
            return result
        except (ValidationError, ValueError):
            return _local_failure(
                proposal,
                self._now().astimezone(UTC),
                "patch_validator_contract_invalid",
                False,
            )


def _local_failure(
    proposal: RepairProposal,
    checked_at: datetime,
    code: PatchValidationErrorCode,
    retryable: bool,
) -> PatchValidationResponse:
    return PatchValidationResponse.model_validate(
        {
            "proposal_id": proposal.id,
            "run_id": proposal.run_id,
            "proposal_digest": proposal.digest,
            "outcome": "failed",
            "checked_at": checked_at,
            "error": {"code": code, "retryable": retryable},
        }
    )
