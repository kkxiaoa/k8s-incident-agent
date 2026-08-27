from typing import Annotated

from fastapi import APIRouter, Depends

from k8s_incident_agent.api_contracts import ScenarioListResponse, error_responses
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.routes import incident_service

router = APIRouter(prefix="/api/v1")

_IncidentService = Annotated[
    IncidentApplicationService,
    Depends(incident_service),
]


@router.get(
    "/scenarios",
    response_model=ScenarioListResponse,
    responses=error_responses(500, 503),
)
async def list_scenarios(
    service: _IncidentService,
) -> ScenarioListResponse:
    return await service.list_scenarios()
