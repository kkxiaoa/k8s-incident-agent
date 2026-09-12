from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header
from fastapi.responses import StreamingResponse

from k8s_incident_agent.api_contracts import RunEventStreamItem, error_responses
from k8s_incident_agent.application.events import IncidentEventService
from k8s_incident_agent.auth.http import operator_sessions, require_operator
from k8s_incident_agent.auth.sessions import OperatorSession, OperatorSessions
from k8s_incident_agent.routes import event_service

router = APIRouter(prefix="/api/v1")

_EventService = Annotated[
    IncidentEventService,
    Depends(event_service),
]


@router.get(
    "/incidents/{incident_id}/events",
    response_class=StreamingResponse,
    response_model=RunEventStreamItem,
    responses={
        200: {
            "content": {
                "text/event-stream": {
                    "schema": {
                        "$ref": "#/components/schemas/RunEventStreamItem",
                    }
                }
            }
        },
        **error_responses(400, 404, 422, 500, 503),
    },
)
async def get_incident_events(
    incident_id: UUID,
    service: _EventService,
    session: Annotated[OperatorSession, Depends(require_operator)],
    sessions: Annotated[OperatorSessions, Depends(operator_sessions)],
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
) -> StreamingResponse:
    stream = await service.open_stream(incident_id, last_event_id)
    return StreamingResponse(
        sessions.stream(session, stream),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
        },
    )
