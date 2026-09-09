from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import re
from datetime import datetime
from pathlib import Path
from stat import S_ISREG
from typing import Final, Literal

_NONCE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_TIMESTAMP = re.compile(r"^[0-9]{10}$")
_SIGNATURE = re.compile(r"^[a-f0-9]{64}$")
_REQUEST_DOMAIN: Final = "k8s-incident-agent.patch-validator.request.v1"
_RESPONSE_DOMAIN: Final = "k8s-incident-agent.patch-validator.response.v1"
PATCH_VALIDATOR_PATH: Final = "/internal/v1/validate/set-container-image"


type PatchValidatorAuthErrorCode = Literal[
    "patch_validator_authentication_failed",
    "patch_validator_replay_rejected",
]


class PatchValidatorAuthenticationError(RuntimeError):
    retryable = False

    def __init__(
        self,
        code: PatchValidatorAuthErrorCode = "patch_validator_authentication_failed",
    ) -> None:
        self.code: PatchValidatorAuthErrorCode = code
        super().__init__("Patch Validator authentication failed")


class NonceReplayCache:
    def __init__(self, *, freshness_seconds: int, max_entries: int = 4096) -> None:
        if freshness_seconds < 1 or max_entries < 1:
            raise ValueError("Freshness window must be positive")
        self._freshness_seconds = freshness_seconds
        self._max_entries = max_entries
        self._seen: dict[str, int] = {}
        self._lock = asyncio.Lock()

    @property
    def freshness_seconds(self) -> int:
        return self._freshness_seconds

    async def remember(self, nonce: str, timestamp: int, now: int) -> None:
        async with self._lock:
            oldest = now - self._freshness_seconds
            self._seen = {
                value: observed
                for value, observed in self._seen.items()
                if observed >= oldest
            }
            if nonce in self._seen:
                raise PatchValidatorAuthenticationError(
                    "patch_validator_replay_rejected"
                )
            if len(self._seen) >= self._max_entries:
                raise PatchValidatorAuthenticationError(
                    "patch_validator_replay_rejected"
                )
            self._seen[nonce] = timestamp


def load_hmac_key(path: Path) -> bytes:
    """Read one exact binary key without ever rendering it as text."""

    try:
        resolved = path.resolve(strict=True)
        mount_root = path.parent.resolve(strict=True)
        if not resolved.is_relative_to(mount_root):
            raise ValueError
        descriptor = os.open(
            resolved,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
        )
        try:
            metadata = os.fstat(descriptor)
            if not S_ISREG(metadata.st_mode) or metadata.st_size != 32:
                raise ValueError
            key = os.read(descriptor, 33)
        finally:
            os.close(descriptor)
    except (OSError, RuntimeError, ValueError):
        raise ValueError("Patch Validator HMAC key is unavailable") from None
    if len(key) != 32:
        raise ValueError("Patch Validator HMAC key must contain exactly 32 bytes")
    return key


def _body_digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def request_signature(key: bytes, timestamp: str, nonce: str, body: bytes) -> str:
    document = "\n".join(
        (
            _REQUEST_DOMAIN,
            "POST",
            PATCH_VALIDATOR_PATH,
            timestamp,
            nonce,
            _body_digest(body),
        )
    ).encode()
    return hmac.new(key, document, hashlib.sha256).hexdigest()


def response_signature(key: bytes, status_code: int, nonce: str, body: bytes) -> str:
    document = "\n".join(
        (_RESPONSE_DOMAIN, str(status_code), nonce, _body_digest(body))
    ).encode()
    return hmac.new(key, document, hashlib.sha256).hexdigest()


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
    if (
        not _TIMESTAMP.fullmatch(timestamp)
        or not _NONCE.fullmatch(nonce)
        or not _SIGNATURE.fullmatch(signature)
    ):
        raise PatchValidatorAuthenticationError
    observed = int(timestamp)
    current = int(now.timestamp())
    if abs(current - observed) > replay_cache.freshness_seconds:
        raise PatchValidatorAuthenticationError
    expected = request_signature(key, timestamp, nonce, body)
    if not hmac.compare_digest(expected, signature):
        raise PatchValidatorAuthenticationError
    await replay_cache.remember(nonce, observed, current)


def verify_response_authentication(
    *,
    key: bytes,
    status_code: int,
    nonce: str,
    signature: str,
    body: bytes,
) -> None:
    if not _NONCE.fullmatch(nonce) or not _SIGNATURE.fullmatch(signature):
        raise PatchValidatorAuthenticationError
    expected = response_signature(key, status_code, nonce, body)
    if not hmac.compare_digest(expected, signature):
        raise PatchValidatorAuthenticationError
