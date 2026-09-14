from __future__ import annotations

import secrets
from datetime import timedelta
from pathlib import Path

import httpx
import pytest

from k8s_incident_agent.execution.auth import (
    BODY_LIMIT,
    CLAIM_CHANNEL,
    NONCE_HEADER,
    REPORT_CHANNEL,
    RESPONSE_SIGNATURE_HEADER,
    SIGNATURE_HEADER,
    TIMESTAMP_HEADER,
)
from k8s_incident_agent.execution.client import ExecutionClient, ExecutionExchangeError
from k8s_incident_agent.repair.auth import request_signature as validator_signature
from tests.unit.routes.test_approvals import approval_harness
from tests.unit.routes.test_operator import credential as credential


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fault",
    [
        "missing",
        "body",
        "old",
        "future",
        "key",
        "validator",
        "report",
        "duplicate",
        "query",
        "action",
        "budget",
    ],
)
async def test_internal_claim_rejects_unauthenticated_or_tampered_input(
    tmp_path: Path, credential: tuple[str, str], fault: str
) -> None:
    key = secrets.token_bytes(32)
    async with approval_harness(tmp_path, credential, executor_key=key) as harness:
        await harness.approve()
        timestamp = str(int(harness.now().timestamp()))
        if fault in ("old", "future"):
            timestamp = str(
                int(
                    (
                        harness.now() + timedelta(seconds=-31 if fault == "old" else 31)
                    ).timestamp()
                )
            )
        nonce = secrets.token_urlsafe(32)
        body = b'{"raw_patch":[]}' if fault == "action" else b"{}"
        if fault == "budget":
            body = b" " * (BODY_LIMIT + 1)
        sign = (
            validator_signature
            if fault == "validator"
            else (
                REPORT_CHANNEL.request_signature
                if fault == "report"
                else CLAIM_CHANNEL.request_signature
            )
        )
        headers = [
            ("content-type", "application/json"),
            (TIMESTAMP_HEADER, timestamp),
            (NONCE_HEADER, nonce),
            (
                SIGNATURE_HEADER,
                sign(
                    secrets.token_bytes(32) if fault == "key" else key,
                    timestamp,
                    nonce,
                    body,
                ),
            ),
        ]
        if fault == "missing":
            headers = [("content-type", "application/json")]
        if fault == "duplicate":
            headers.append((NONCE_HEADER, nonce))
        if fault == "body":
            body = b"{ }"
        response = await harness.client.post(
            CLAIM_CHANNEL.path + ("?task=other" if fault == "query" else ""),
            headers=headers,
            content=body,
        )
        assert response.status_code == (
            400 if fault in ("action", "budget", "query") else 401
        )
        # The logged-in operator cookie is present; it does not authorize an internal claim.
        command = await harness.repository.claim_execution(now=harness.now)
        assert command is not None
        assert CLAIM_CHANNEL.path not in harness.app.openapi()["paths"]
        assert REPORT_CHANNEL.path not in harness.app.openapi()["paths"]


@pytest.mark.asyncio
async def test_signed_claim_replay_is_rejected_even_after_no_work_response(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    key = secrets.token_bytes(32)
    async with approval_harness(tmp_path, credential, executor_key=key) as harness:
        timestamp, nonce = (
            str(int(harness.now().timestamp())),
            secrets.token_urlsafe(32),
        )
        headers = {
            "content-type": "application/json",
            TIMESTAMP_HEADER: timestamp,
            NONCE_HEADER: nonce,
            SIGNATURE_HEADER: CLAIM_CHANNEL.request_signature(
                key, timestamp, nonce, b"{}"
            ),
        }
        first = await harness.client.post(
            CLAIM_CHANNEL.path, headers=headers, content=b"{}"
        )
        assert first.status_code == 204
        await harness.approve()
        second = await harness.client.post(
            CLAIM_CHANNEL.path, headers=headers, content=b"{}"
        )
        assert second.status_code == 409
        assert await harness.repository.claim_execution(now=harness.now) is not None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fault",
    [
        "missing",
        "status",
        "body",
        "nonce",
        "timestamp",
        "domain",
        "duplicate",
        "redirect",
    ],
)
async def test_client_verifies_response_before_parsing_or_using_command(
    tmp_path: Path, credential: tuple[str, str], fault: str
) -> None:
    key = secrets.token_bytes(32)
    async with approval_harness(tmp_path, credential, executor_key=key) as harness:

        async def forged(request: httpx.Request) -> httpx.Response:
            timestamp, nonce = (
                request.headers[TIMESTAMP_HEADER],
                request.headers[NONCE_HEADER],
            )
            channel = REPORT_CHANNEL if fault == "domain" else CLAIM_CHANNEL
            signature = channel.response_signature(
                key,
                204,
                "x" * 43 if fault == "nonce" else nonce,
                b"",
                timestamp="1000000000" if fault == "timestamp" else timestamp,
            )
            headers = [("content-type", "application/json")]
            if fault != "missing":
                headers.append((RESPONSE_SIGNATURE_HEADER, signature))
            if fault == "duplicate":
                headers.append((RESPONSE_SIGNATURE_HEADER, signature))
            if fault == "redirect":
                headers.append(("Location", "https://outside.invalid/"))
            return httpx.Response(
                307 if fault == "redirect" else (200 if fault == "status" else 204),
                content=b"{}" if fault == "body" else b"",
                headers=headers,
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(forged)) as http:
            with pytest.raises(ExecutionExchangeError) as error:
                await ExecutionClient(http=http, key=key, now=harness.now).claim()
            assert error.value.retryable is False


@pytest.mark.asyncio
async def test_internal_routes_absent_without_executor_key(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential) as harness:
        for channel in (CLAIM_CHANNEL, REPORT_CHANNEL):
            response = await harness.client.post(channel.path, content=b"{}")
            assert response.status_code == 404
