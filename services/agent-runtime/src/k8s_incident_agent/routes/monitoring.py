from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query

from k8s_incident_agent.api_contracts import error_responses
from k8s_incident_agent.application.monitoring import MonitoringApplicationService
from k8s_incident_agent.monitoring.contracts import (
    IncidentMetricPanel,
    IncidentMonitoringPanels,
    MetricWindow,
    MonitoringHealthSnapshot,
)
from k8s_incident_agent.routes import monitoring_service

router = APIRouter(prefix="/api/v1")

_MonitoringService = Annotated[
    MonitoringApplicationService,
    Depends(monitoring_service),
]
_PanelId = Annotated[
    str,
    Path(pattern=r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", max_length=128),
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


@router.get(
    "/incidents/{incident_id}/monitoring/panels",
    response_model=IncidentMonitoringPanels,
    responses=error_responses(404, 422, 500, 503),
)
async def list_incident_monitoring_panels(
    incident_id: UUID,
    service: _MonitoringService,
) -> IncidentMonitoringPanels:
    return await service.list_panels(incident_id)


@router.get(
    "/incidents/{incident_id}/monitoring/panels/{panel_id}",
    response_model=IncidentMetricPanel,
    responses=error_responses(404, 422, 500, 503),
)
async def get_incident_monitoring_panel(
    incident_id: UUID,
    panel_id: _PanelId,
    service: _MonitoringService,
    window: Annotated[MetricWindow, Query()] = MetricWindow.FIFTEEN_MINUTES,
) -> IncidentMetricPanel:
    return await service.get_panel(
        incident_id,
        panel_id=panel_id,
        window=window,
    )
