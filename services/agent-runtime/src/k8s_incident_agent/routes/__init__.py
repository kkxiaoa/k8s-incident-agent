from typing import cast

from fastapi import Request

from k8s_incident_agent.application.alerts import AlertmanagerApplicationService
from k8s_incident_agent.application.events import IncidentEventService
from k8s_incident_agent.application.incidents import (
    IncidentApplicationService,
    RuntimeNotReadyError,
)


def incident_service(request: Request) -> IncidentApplicationService:
    if request.app.state.ready is not True:
        raise RuntimeNotReadyError
    try:
        service = request.app.state.container.incidents
    except AttributeError:
        raise RuntimeNotReadyError from None
    return cast(IncidentApplicationService, service)


def event_service(request: Request) -> IncidentEventService:
    if request.app.state.ready is not True:
        raise RuntimeNotReadyError
    try:
        service = request.app.state.container.events
    except AttributeError:
        raise RuntimeNotReadyError from None
    return cast(IncidentEventService, service)


def alertmanager_service(request: Request) -> AlertmanagerApplicationService:
    if request.app.state.ready is not True:
        raise RuntimeNotReadyError
    try:
        service = request.app.state.container.alerts
    except AttributeError:
        raise RuntimeNotReadyError from None
    if service is None:
        raise RuntimeNotReadyError
    return cast(AlertmanagerApplicationService, service)
