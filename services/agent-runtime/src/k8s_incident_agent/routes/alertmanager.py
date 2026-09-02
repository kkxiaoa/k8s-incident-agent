from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from k8s_incident_agent.api_contracts import error_responses
from k8s_incident_agent.application.alerts import AlertmanagerApplicationService
from k8s_incident_agent.monitoring.alertmanager import MAX_WEBHOOK_BODY_BYTES
from k8s_incident_agent.monitoring.errors import (
    AlertAuthenticationError,
    AlertPayloadInvalidError,
    AlertPayloadTooLargeError,
)
from k8s_incident_agent.routes import alertmanager_service

router = APIRouter(prefix="/api/v1")

_bearer = HTTPBearer(
    auto_error=False,
    scheme_name="AlertmanagerBearer",
    description="Shared bearer credential mounted in Alertmanager and Runtime.",
)
_AlertmanagerService = Annotated[
    AlertmanagerApplicationService,
    Depends(alertmanager_service),
]
_BearerCredentials = Annotated[
    HTTPAuthorizationCredentials | None,
    Depends(_bearer),
]


@router.post(
    "/alerts/alertmanager",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    responses=error_responses(401, 413, 422, 500, 503),
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": {"$ref": "#/components/schemas/AlertmanagerWebhook"}
                }
            },
        }
    },
)
async def receive_alertmanager_webhook(
    request: Request,
    service: _AlertmanagerService,
    credentials: _BearerCredentials,
) -> Response:
    if len(request.headers.getlist("authorization")) != 1:
        raise AlertAuthenticationError
    token = credentials.credentials if credentials is not None else None
    service.require_authentication(token)
    content_types = request.headers.getlist("content-type")
    if (
        len(content_types) != 1
        or content_types[0].partition(";")[0].strip().lower() != "application/json"
    ):
        raise AlertPayloadInvalidError
    content_lengths = request.headers.getlist("content-length")
    if len(content_lengths) > 1:
        raise AlertPayloadInvalidError
    if content_lengths:
        try:
            content_length = int(content_lengths[0])
            if content_length < 0:
                raise ValueError
            if content_length > MAX_WEBHOOK_BODY_BYTES:
                raise AlertPayloadTooLargeError
        except ValueError:
            raise AlertPayloadInvalidError from None

    body = bytearray()
    async for chunk in request.stream():
        if len(chunk) > MAX_WEBHOOK_BODY_BYTES - len(body):
            raise AlertPayloadTooLargeError
        body.extend(chunk)
    await service.ingest(bytes(body))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
