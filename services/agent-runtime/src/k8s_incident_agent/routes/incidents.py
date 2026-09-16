from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response, status

from k8s_incident_agent.api_contracts import (
    ApprovalRequest,
    ApprovalResponse,
    CreateIncidentRequest,
    CreateIncidentResponse,
    CreateRepairRunRequest,
    CreateRunRequest,
    CreateRunResponse,
    IncidentDetailResponse,
    IncidentListResponse,
    RunEventHistoryResponse,
    RunHistoryResponse,
    WithdrawRunRequest,
    error_responses,
)
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.auth.http import (
    require_operator,
    require_reader,
)
from k8s_incident_agent.auth.sessions import (
    OperatorSession,
)
from k8s_incident_agent.routes import incident_service

manual_router = APIRouter(prefix="/api/v1")
approval_router = APIRouter(prefix="/api/v1")
router = APIRouter(prefix="/api/v1")

_IncidentService = Annotated[
    IncidentApplicationService,
    Depends(incident_service),
]
_Operator = Annotated[OperatorSession, Depends(require_operator)]
_Reader = Annotated[OperatorSession | None, Depends(require_reader, scope="function")]


@approval_router.post(
    "/incidents/{incident_id}/approvals",
    response_model=ApprovalResponse,
    responses=error_responses(401, 403, 409, 422, 500, 503),
)
async def decide_approval(
    incident_id: UUID,
    request: ApprovalRequest,
    service: _IncidentService,
    operator: _Operator,
) -> ApprovalResponse:
    return await service.decide_approval(
        incident_id,
        request,
        operator_ref=operator.operator_ref,
        operator_token_hash=operator.token_hash,
    )


@manual_router.post(
    "/incidents",
    response_model=CreateIncidentResponse,
    status_code=status.HTTP_202_ACCEPTED,
    responses=error_responses(404, 422, 500, 503),
)
async def create_incident(
    request: CreateIncidentRequest,
    service: _IncidentService,
    operator: _Operator,
) -> CreateIncidentResponse:
    return await service.create_incident(
        request,
        operator_ref=operator.operator_ref,
        requester=operator,
    )


@router.post(
    "/incidents/{incident_id}/runs",
    response_model=CreateRunResponse,
    status_code=status.HTTP_202_ACCEPTED,
    responses=error_responses(404, 409, 422, 500, 503),
)
async def create_run(
    incident_id: UUID,
    service: _IncidentService,
    operator: _Operator,
    request: CreateRunRequest | None = None,
) -> CreateRunResponse:
    return await service.create_run(
        incident_id,
        replaces_run_id=request.replaces_run_id if request else None,
        operator_ref=operator.operator_ref,
        requester=operator,
    )


@router.post(
    "/incidents/{incident_id}/repair-runs",
    response_model=CreateRunResponse,
    status_code=status.HTTP_202_ACCEPTED,
    responses=error_responses(404, 409, 422, 500, 503),
)
async def create_repair_run(
    incident_id: UUID,
    request: CreateRepairRunRequest,
    service: _IncidentService,
    operator: _Operator,
) -> CreateRunResponse:
    return await service.create_repair_run(
        incident_id,
        request,
        operator_ref=operator.operator_ref,
        requester=operator,
    )


@router.post(
    "/incidents/{incident_id}/withdrawals",
    status_code=204,
    response_class=Response,
    responses=error_responses(401, 403, 409, 422, 429, 500, 503),
)
async def withdraw_run(
    incident_id: UUID,
    request: WithdrawRunRequest,
    service: _IncidentService,
    requester: _Operator,
) -> Response:
    await service.withdraw_run(incident_id, request.run_id, requester)
    return Response(status_code=204)


@router.get(
    "/incidents",
    dependencies=[Depends(require_reader, scope="function")],
    response_model=IncidentListResponse,
    responses=error_responses(400, 422, 500, 503),
)
async def list_incidents(
    service: _IncidentService,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    cursor: Annotated[str | None, Query()] = None,
) -> IncidentListResponse:
    return await service.list_incidents(limit=limit, cursor=cursor)


@router.get(
    "/incidents/{incident_id}",
    response_model=IncidentDetailResponse,
    responses=error_responses(404, 422, 500, 503),
)
async def get_incident(
    incident_id: UUID,
    service: _IncidentService,
    requester: _Reader,
    run_id: Annotated[UUID | None, Query(alias="runId")] = None,
) -> IncidentDetailResponse:
    return await service.get_incident(incident_id, run_id=run_id, requester=requester)


@router.get(
    "/incidents/{incident_id}/runs",
    response_model=RunHistoryResponse,
    responses=error_responses(400, 404, 422, 500, 503),
)
async def list_runs(
    incident_id: UUID,
    service: _IncidentService,
    requester: _Reader,
    mine: bool = False,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    cursor: Annotated[str | None, Query()] = None,
) -> RunHistoryResponse:
    return await service.list_runs(
        incident_id, limit=limit, cursor=cursor, requester=requester, mine=mine
    )


@router.get(
    "/incidents/{incident_id}/runs/{run_id}/events",
    dependencies=[Depends(require_reader, scope="function")],
    response_model=RunEventHistoryResponse,
    responses=error_responses(400, 404, 422, 500, 503),
)
async def list_run_events(
    incident_id: UUID,
    run_id: UUID,
    service: _IncidentService,
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
    cursor: Annotated[str | None, Query()] = None,
) -> RunEventHistoryResponse:
    return await service.list_run_events(
        incident_id,
        run_id,
        limit=limit,
        cursor=cursor,
    )
