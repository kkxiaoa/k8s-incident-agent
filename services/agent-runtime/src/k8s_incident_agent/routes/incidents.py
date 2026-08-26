from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, status

from k8s_incident_agent.api_contracts import (
    CreateIncidentRequest,
    CreateIncidentResponse,
    IncidentDetailResponse,
    IncidentListResponse,
)
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.routes import incident_service

router = APIRouter(prefix="/api/v1")

_IncidentService = Annotated[
    IncidentApplicationService,
    Depends(incident_service),
]


@router.post(
    "/incidents",
    response_model=CreateIncidentResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_incident(
    request: CreateIncidentRequest,
    service: _IncidentService,
) -> CreateIncidentResponse:
    return await service.create_incident(request)


@router.get("/incidents", response_model=IncidentListResponse)
async def list_incidents(
    service: _IncidentService,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    cursor: Annotated[str | None, Query()] = None,
) -> IncidentListResponse:
    return await service.list_incidents(limit=limit, cursor=cursor)


@router.get("/incidents/{incident_id}", response_model=IncidentDetailResponse)
async def get_incident(
    incident_id: UUID,
    service: _IncidentService,
) -> IncidentDetailResponse:
    return await service.get_incident(incident_id)
