"""Bounded, domain-separated authentication for the two internal services."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from stat import S_ISREG

_NONCE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_TIMESTAMP = re.compile(r"^[0-9]{10}$")
_SIGNATURE = re.compile(r"^[a-f0-9]{64}$")


class InternalAuthenticationError(RuntimeError):
    def __init__(self, *, replay: bool = False) -> None:
        self.replay = replay
        super().__init__("Internal service authentication failed")


class NonceReplayCache:
    def __init__(self, *, freshness_seconds: int, max_entries: int = 4096) -> None:
        if freshness_seconds < 1 or max_entries < 1:
            raise ValueError("Freshness window must be positive")
        self.freshness_seconds = freshness_seconds
        self._max_entries = max_entries
        self._seen: dict[str, int] = {}
        self._lock = asyncio.Lock()

    async def remember(self, nonce: str, timestamp: int, now: int) -> None:
        async with self._lock:
            oldest = now - self.freshness_seconds
            self._seen = {
                value: observed
                for value, observed in self._seen.items()
                if observed >= oldest
            }
            if nonce in self._seen or len(self._seen) >= self._max_entries:
                raise InternalAuthenticationError(replay=True)
            self._seen[nonce] = timestamp


def load_hmac_key(path: Path) -> bytes:
    """Read an exact binary key, including bounded Kubernetes Secret projections."""
    try:
        resolved = path.resolve(strict=True)
        mount_root = path.parent.resolve(strict=True)
        if not resolved.is_relative_to(mount_root):
            raise ValueError
        descriptor = os.open(resolved, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            metadata = os.fstat(descriptor)
            if not S_ISREG(metadata.st_mode) or metadata.st_size != 32:
                raise ValueError
            key = os.read(descriptor, 33)
        finally:
            os.close(descriptor)
    except (OSError, RuntimeError, ValueError):
        raise ValueError("Internal service HMAC key is unavailable") from None
    if len(key) != 32:
        raise ValueError("Internal service HMAC key must contain exactly 32 bytes")
    return key


@dataclass(frozen=True, slots=True)
class HmacChannel:
    request_domain: str
    response_domain: str
    path: str

    def request_signature(
        self, key: bytes, timestamp: str, nonce: str, body: bytes
    ) -> str:
        return _sign(
            key, (self.request_domain, "POST", self.path, timestamp, nonce), body
        )

    def response_signature(
        self,
        key: bytes,
        status_code: int,
        nonce: str,
        body: bytes,
        *,
        timestamp: str | None = None,
    ) -> str:
        context = (self.response_domain, str(status_code), nonce)
        if timestamp is not None:
            context += (timestamp,)
        return _sign(key, context, body)

    async def verify_request(
        self,
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
            raise InternalAuthenticationError
        observed, current = int(timestamp), int(now.timestamp())
        if abs(current - observed) > replay_cache.freshness_seconds:
            raise InternalAuthenticationError
        expected = self.request_signature(key, timestamp, nonce, body)
        if not hmac.compare_digest(expected, signature):
            raise InternalAuthenticationError
        await replay_cache.remember(nonce, observed, current)

    def verify_response(
        self,
        *,
        key: bytes,
        status_code: int,
        nonce: str,
        signature: str,
        body: bytes,
        timestamp: str | None = None,
    ) -> None:
        if (
            not _NONCE.fullmatch(nonce)
            or not _SIGNATURE.fullmatch(signature)
            or (timestamp is not None and not _TIMESTAMP.fullmatch(timestamp))
        ):
            raise InternalAuthenticationError
        expected = self.response_signature(
            key, status_code, nonce, body, timestamp=timestamp
        )
        if not hmac.compare_digest(expected, signature):
            raise InternalAuthenticationError


def _sign(key: bytes, context: tuple[str, ...], body: bytes) -> str:
    document = "\n".join((*context, hashlib.sha256(body).hexdigest())).encode()
    return hmac.new(key, document, hashlib.sha256).hexdigest()
