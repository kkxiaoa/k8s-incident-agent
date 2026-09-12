from typing import Annotated, cast

from fastapi import Depends, Request
from fastapi.security import APIKeyCookie
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from k8s_incident_agent.application.incidents import RuntimeNotReadyError
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
