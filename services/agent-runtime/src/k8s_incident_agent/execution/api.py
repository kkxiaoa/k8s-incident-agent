from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import cast

from fastapi import APIRouter, Request, Response
from pydantic import ValidationError

from k8s_incident_agent.domain.models import JsonValue
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
    ExecutionClaim,
    ExecutionReport,
)
from k8s_incident_agent.internal_auth import (
    HmacChannel,
    InternalAuthenticationError,
    NonceReplayCache,
)
from k8s_incident_agent.persistence.canonical import canonical_json
from k8s_incident_agent.persistence.repositories import (
    ExecutionReportConflictError,
    IncidentRepository,
)


@dataclass(frozen=True, slots=True)
class ExecutionEndpoint:
    repository: IncidentRepository
    key: bytes = field(repr=False)
    replay_cache: NonceReplayCache
    now: Callable[[], datetime]


router = APIRouter(include_in_schema=False)


@router.post(CLAIM_CHANNEL.path)
async def claim(request: Request) -> Response:
    return await _handle(request, CLAIM_CHANNEL)


@router.post(REPORT_CHANNEL.path)
async def report(request: Request) -> Response:
    return await _handle(request, REPORT_CHANNEL)


async def _handle(request: Request, channel: HmacChannel) -> Response:
    endpoint = cast(ExecutionEndpoint | None, request.app.state.container.execution)
    if endpoint is None:
        return Response(status_code=404, headers={"cache-control": "no-store"})
    nonce = _header(request, NONCE_HEADER)
    timestamp = _header(request, TIMESTAMP_HEADER)
    status, body = 200, b""
    try:
        if request.url.query:
            raise ValueError
        async with asyncio.timeout(HTTP_TIMEOUT_SECONDS):
            raw = bytearray()
            async for chunk in request.stream():
                if len(raw) + len(chunk) > BODY_LIMIT:
                    raise ValueError
                raw.extend(chunk)
        await channel.verify_request(
            key=endpoint.key,
            timestamp=timestamp,
            nonce=nonce,
            signature=_header(request, SIGNATURE_HEADER),
            body=bytes(raw),
            now=endpoint.now(),
            replay_cache=endpoint.replay_cache,
        )
        if _header(request, "content-type") != "application/json":
            raise ValueError
        if channel == CLAIM_CHANNEL:
            ExecutionClaim.model_validate_json(raw)
            command = await endpoint.repository.claim_execution(now=endpoint.now)
            if command is None:
                status = 204
            else:
                body = canonical_json(
                    cast(dict[str, JsonValue], command.model_dump(mode="json"))
                ).encode()
        else:
            contract = ExecutionReport.model_validate_json(raw)
            await endpoint.repository.report_execution(
                contract.execution_id,
                contract.result,
                now=endpoint.now,
            )
            acknowledgement = ExecutionAcknowledgement(
                execution_id=contract.execution_id
            )
            body = acknowledgement.model_dump_json().encode()
    except InternalAuthenticationError as error:
        status = 409 if error.replay else 401
    except ExecutionReportConflictError:
        logging.getLogger(__name__).warning("executor_report_conflict")
        status = 409
    except (ValueError, ValidationError, TimeoutError):
        status = 400
    except asyncio.CancelledError:
        raise
    except Exception:
        # The transaction may have committed. The worker must not infer non-consumption.
        status = 503
    if len(body) > BODY_LIMIT:
        status, body = 503, b""
    return Response(
        content=body,
        status_code=status,
        media_type="application/json",
        headers={
            "cache-control": "no-store",
            RESPONSE_SIGNATURE_HEADER: channel.response_signature(
                endpoint.key,
                status,
                nonce,
                body,
                timestamp=timestamp,
            ),
        },
    )


def _header(request: Request, name: str) -> str:
    values = request.headers.getlist(name)
    return values[0] if len(values) == 1 else ""
