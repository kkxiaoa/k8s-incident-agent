from typing import Annotated

from fastapi import APIRouter, Depends

from k8s_incident_agent.api_contracts import error_responses
from k8s_incident_agent.application.monitoring import MonitoringHealthService
from k8s_incident_agent.monitoring.contracts import MonitoringHealthSnapshot
from k8s_incident_agent.routes import monitoring_service

router = APIRouter(prefix="/api/v1")

_MonitoringService = Annotated[
    MonitoringHealthService,
    Depends(monitoring_service),
]


@router.get(
    "/monitoring/health",
    response_model=MonitoringHealthSnapshot,
    responses=error_responses(500, 503),
)
async def get_monitoring_health(
    service: _MonitoringService,
) -> MonitoringHealthSnapshot:
    return await service.get_health()
