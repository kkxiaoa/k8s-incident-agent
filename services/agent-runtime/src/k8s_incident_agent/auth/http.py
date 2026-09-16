import asyncio
from collections.abc import AsyncIterator
from typing import Annotated, cast

from fastapi import Depends, Request
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyCookie
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from k8s_incident_agent.api_contracts import ErrorDetail, ErrorResponse
from k8s_incident_agent.application.incidents import RuntimeNotReadyError
from k8s_incident_agent.auth.public_demo import (
    PublicDemoAccess,
)
from k8s_incident_agent.auth.sessions import (
    CSRF_HEADER,
    SESSION_COOKIE,
    OperatorSession,
    OperatorSessions,
)

_cookie = APIKeyCookie(name=SESSION_COOKIE, auto_error=False)


def operator_sessions(request: Request) -> OperatorSessions:
    if request.app.state.ready is not True:
        raise RuntimeNotReadyError
    return cast(OperatorSessions, request.app.state.container.operator)


async def require_operator(
    request: Request,
    sessions: Annotated[OperatorSessions, Depends(operator_sessions)],
    _documented_cookie: Annotated[str | None, Depends(_cookie)],
) -> OperatorSession:
    session = await sessions.authenticate(request.headers.getlist("cookie"))
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        sessions.require_origin(request.headers.getlist("origin"))
        sessions.require_csrf(session, request.headers.getlist(CSRF_HEADER))
    return session


def console_access(request: Request) -> PublicDemoAccess:
    return operator_sessions(request).access


async def current_requester(
    request: Request, access: Annotated[PublicDemoAccess, Depends(console_access)]
) -> OperatorSession | None:
    return await access.resolve(request.headers.getlist("cookie"))


async def require_reader(
    requester: Annotated[OperatorSession | None, Depends(current_requester)],
    access: Annotated[PublicDemoAccess, Depends(console_access)],
) -> AsyncIterator[OperatorSession | None]:
    async with access.reading(requester):
        yield requester


async def require_stream_slot(
    requester: Annotated[OperatorSession | None, Depends(current_requester)],
    access: Annotated[PublicDemoAccess, Depends(console_access)],
) -> AsyncIterator[None]:
    async with access.stream_slot(requester):
        yield


class PublicApiNoStore:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/api/v1/"):
            await self.app(scope, receive, send)
            return

        async def send_no_store(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)["cache-control"] = "no-store"
            await send(message)

        await self.app(scope, receive, send_no_store)


class BusinessRequestBounds:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope["method"] != "POST"
            or not scope["path"].startswith("/api/v1/incidents")
        ):
            await self.app(scope, receive, send)
            return
        body = bytearray()
        try:
            async with asyncio.timeout(5):
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    chunk = message.get("body", b"")
                    if len(chunk) > 8192 - len(body):
                        raise ValueError
                    body.extend(chunk)
                    if not message.get("more_body", False):
                        break
        except (TimeoutError, ValueError):
            response = JSONResponse(
                status_code=422,
                content=ErrorResponse(
                    error=ErrorDetail(
                        code="invalid_request",
                        message="Request is invalid.",
                        retryable=False,
                    )
                ).model_dump(mode="json"),
            )
            await response(scope, receive, send)
            return
        delivered = False

        async def buffered_receive() -> Message:
            nonlocal delivered
            if delivered:
                return await receive()
            delivered = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, buffered_receive, send)
