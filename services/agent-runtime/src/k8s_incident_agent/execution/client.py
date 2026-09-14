from __future__ import annotations

import asyncio
import secrets
from collections.abc import Callable
from datetime import datetime

import httpx
from pydantic import ValidationError

from k8s_incident_agent.execution.auth import (
    BODY_LIMIT,
    CLAIM_CHANNEL,
    HTTP_TIMEOUT_SECONDS,
    NONCE_HEADER,
    REPORT_CHANNEL,
    RESPONSE_SIGNATURE_HEADER,
    SIGNATURE_HEADER,
    TIMESTAMP_HEADER,
)
from k8s_incident_agent.execution.contracts import (
    ExecutionAcknowledgement,
    ExecutionCommand,
    ExecutionReport,
)
from k8s_incident_agent.internal_auth import HmacChannel, InternalAuthenticationError

RUNTIME_BASE_URL = "http://agent-runtime.k8s-incident-agent.svc.cluster.local:8000"


class ExecutionExchangeError(RuntimeError):
    def __init__(self, *, retryable: bool) -> None:
        self.retryable = retryable
        super().__init__("Executor exchange failed")


class ExecutionClient:
    def __init__(
        self,
        *,
        http: httpx.AsyncClient,
        key: bytes,
        now: Callable[[], datetime],
    ) -> None:
        if len(key) != 32:
            raise ValueError("Executor key is invalid")
        self._http, self._key, self._now = http, key, now

    async def claim(self) -> ExecutionCommand | None:
        status, raw = await self._exchange(CLAIM_CHANNEL, b"{}")
        if status == 204 and raw == b"":
            return None
        try:
            if status != 200:
                raise ValueError
            return ExecutionCommand.model_validate_json(raw)
        except (ValueError, ValidationError):
            raise ExecutionExchangeError(retryable=False) from None

    async def report(self, report: ExecutionReport) -> None:
        status, raw = await self._exchange(
            REPORT_CHANNEL, report.model_dump_json().encode()
        )
        try:
            if status != 200:
                raise ValueError
            acknowledgement = ExecutionAcknowledgement.model_validate_json(raw)
            if acknowledgement.execution_id != report.execution_id:
                raise ValueError
        except (ValueError, ValidationError):
            raise ExecutionExchangeError(retryable=False) from None

    async def _exchange(self, channel: HmacChannel, body: bytes) -> tuple[int, bytes]:
        if len(body) > BODY_LIMIT:
            raise ExecutionExchangeError(retryable=False)
        timestamp = str(int(self._now().timestamp()))
        nonce = secrets.token_urlsafe(32)
        headers = {
            "content-type": "application/json",
            TIMESTAMP_HEADER: timestamp,
            NONCE_HEADER: nonce,
            SIGNATURE_HEADER: channel.request_signature(
                self._key, timestamp, nonce, body
            ),
        }
        try:
            async with asyncio.timeout(HTTP_TIMEOUT_SECONDS):
                async with self._http.stream(
                    "POST",
                    f"{RUNTIME_BASE_URL}{channel.path}",
                    headers=headers,
                    content=body,
                    follow_redirects=False,
                ) as response:
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(raw) + len(chunk) > BODY_LIMIT:
                            raise ExecutionExchangeError(retryable=False)
                        raw.extend(chunk)
                    signatures = response.headers.get_list(RESPONSE_SIGNATURE_HEADER)
                    if len(signatures) != 1:
                        raise InternalAuthenticationError
                    channel.verify_response(
                        key=self._key,
                        status_code=response.status_code,
                        nonce=nonce,
                        timestamp=timestamp,
                        signature=signatures[0],
                        body=bytes(raw),
                    )
                    if response.headers.get_list("content-type") != [
                        "application/json"
                    ]:
                        raise InternalAuthenticationError
                    if response.status_code not in (200, 204):
                        raise ExecutionExchangeError(
                            retryable=response.status_code == 503
                        )
                    return response.status_code, bytes(raw)
        except (httpx.HTTPError, OSError, TimeoutError):
            # A lost claim can have committed; the Runtime never requeues that item.
            raise ExecutionExchangeError(retryable=True) from None
        except InternalAuthenticationError:
            raise ExecutionExchangeError(retryable=False) from None
