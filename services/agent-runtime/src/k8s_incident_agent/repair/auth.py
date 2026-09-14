from __future__ import annotations

from datetime import datetime
from typing import Final, Literal

from k8s_incident_agent.internal_auth import (
    HmacChannel,
    InternalAuthenticationError,
)
from k8s_incident_agent.internal_auth import (
    NonceReplayCache as NonceReplayCache,
)
from k8s_incident_agent.internal_auth import (
    load_hmac_key as load_hmac_key,
)

PATCH_VALIDATOR_PATH: Final = "/internal/v1/validate/set-container-image"
_CHANNEL = HmacChannel(
    "k8s-incident-agent.patch-validator.request.v1",
    "k8s-incident-agent.patch-validator.response.v1",
    PATCH_VALIDATOR_PATH,
)

type PatchValidatorAuthErrorCode = Literal[
    "patch_validator_authentication_failed", "patch_validator_replay_rejected"
]


class PatchValidatorAuthenticationError(RuntimeError):
    retryable = False

    def __init__(
        self,
        code: PatchValidatorAuthErrorCode = "patch_validator_authentication_failed",
    ) -> None:
        self.code: PatchValidatorAuthErrorCode = code
        super().__init__("Patch Validator authentication failed")


request_signature = _CHANNEL.request_signature
response_signature = _CHANNEL.response_signature


async def verify_request_authentication(
    *,
    key: bytes,
    timestamp: str,
    nonce: str,
    signature: str,
    body: bytes,
    now: datetime,
    replay_cache: NonceReplayCache,
) -> None:
    try:
        await _CHANNEL.verify_request(
            key=key,
            timestamp=timestamp,
            nonce=nonce,
            signature=signature,
            body=body,
            now=now,
            replay_cache=replay_cache,
        )
    except InternalAuthenticationError as error:
        raise PatchValidatorAuthenticationError(
            "patch_validator_replay_rejected"
            if error.replay
            else "patch_validator_authentication_failed"
        ) from None


def verify_response_authentication(
    *,
    key: bytes,
    status_code: int,
    nonce: str,
    signature: str,
    body: bytes,
) -> None:
    try:
        _CHANNEL.verify_response(
            key=key,
            status_code=status_code,
            nonce=nonce,
            signature=signature,
            body=body,
        )
    except InternalAuthenticationError:
        raise PatchValidatorAuthenticationError from None
