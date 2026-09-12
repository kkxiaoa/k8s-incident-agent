import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError

from k8s_incident_agent.api_contracts import error_responses
from k8s_incident_agent.auth.http import operator_sessions, require_operator
from k8s_incident_agent.auth.sessions import (
    SESSION_COOKIE,
    SESSION_SECONDS,
    OperatorSession,
    OperatorSessions,
)

router = APIRouter(prefix="/api/v1/operator")
_Sessions = Annotated[OperatorSessions, Depends(operator_sessions)]
_Session = Annotated[OperatorSession, Depends(require_operator)]


class OperatorLoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    password: SecretStr = Field(min_length=1, max_length=1024, repr=False)


class OperatorSessionResponse(BaseModel):
    operatorRef: str
    expiresAt: int
    csrfToken: str = Field(repr=False)


def _projection(session: OperatorSession) -> OperatorSessionResponse:
    return OperatorSessionResponse(
        operatorRef=session.operator_ref,
        expiresAt=session.expires_at,
        csrfToken=session.csrf_token,
    )


@router.post(
    "/login",
    response_model=OperatorSessionResponse,
    responses=error_responses(401, 403, 422, 429, 500, 503),
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {"schema": OperatorLoginRequest.model_json_schema()}
            },
        }
    },
)
async def login(
    request: Request, response: Response, sessions: _Sessions
) -> OperatorSessionResponse:
    sessions.require_origin(request.headers.getlist("origin"))
    content_types = request.headers.getlist("content-type")
    if (
        len(content_types) != 1
        or content_types[0].partition(";")[0].strip().lower() != "application/json"
    ):
        raise RequestValidationError([])
    body = bytearray()
    try:
        async with asyncio.timeout(5):
            async for chunk in request.stream():
                if len(chunk) > 8192 - len(body):
                    raise RequestValidationError([])
                body.extend(chunk)
        payload = OperatorLoginRequest.model_validate_json(body)
        password = payload.password.get_secret_value().encode("utf-8")
        if len(password) > 1024:
            raise ValueError
    except (TimeoutError, ValidationError, UnicodeError, ValueError):
        raise RequestValidationError([]) from None
    session = await sessions.login(password)
    _set_session_cookie(response, session)
    return _projection(session)


def _set_session_cookie(response: Response, session: OperatorSession) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        session.token,
        max_age=SESSION_SECONDS,
        path="/",
        secure=True,
        httponly=True,
        samesite="strict",
    )


@router.get(
    "/session",
    response_model=OperatorSessionResponse,
    responses=error_responses(401, 500, 503),
)
async def get_session(session: _Session) -> OperatorSessionResponse:
    return _projection(session)


@router.post(
    "/session",
    response_model=OperatorSessionResponse,
    responses=error_responses(401, 403, 500, 503),
)
async def renew_session(
    response: Response, session: _Session, sessions: _Sessions
) -> OperatorSessionResponse:
    renewed = await sessions.renew(session)
    _set_session_cookie(response, renewed)
    return _projection(renewed)


@router.post(
    "/logout",
    status_code=204,
    response_class=Response,
    responses=error_responses(401, 403, 500, 503),
)
async def logout(session: _Session, sessions: _Sessions) -> Response:
    await sessions.logout(session)
    response = Response(status_code=204)
    response.delete_cookie(
        SESSION_COOKIE, path="/", secure=True, httponly=True, samesite="strict"
    )
    return response
