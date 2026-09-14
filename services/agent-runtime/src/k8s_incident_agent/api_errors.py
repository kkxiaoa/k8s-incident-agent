from dataclasses import dataclass
from typing import cast

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.types import ExceptionHandler

from k8s_incident_agent.api_contracts import ErrorDetail, ErrorResponse
from k8s_incident_agent.application.events import InvalidLastEventIdError
from k8s_incident_agent.application.incidents import (
    ActiveRunConflictError,
    IncidentNotFoundError,
    InvalidCursorError,
    RunNotFoundError,
    RuntimeNotReadyError,
    ScenarioNotFoundError,
)
from k8s_incident_agent.application.monitoring import MonitoringPanelNotFoundError
from k8s_incident_agent.auth.sessions import (
    OperatorAuthenticationError,
    OperatorCsrfError,
    OperatorLoginLimitedError,
    OperatorOriginError,
)
from k8s_incident_agent.auth.verifier import OperatorCredentialUnavailableError
from k8s_incident_agent.model.availability import DiagnosisUnavailableError
from k8s_incident_agent.monitoring.errors import (
    AlertAuthenticationError,
    AlertPayloadInvalidError,
    AlertPayloadTooLargeError,
    AlertPayloadTruncatedError,
    AlertTargetInvalidError,
)
from k8s_incident_agent.persistence.repositories import (
    ApprovalConflictError,
    ExecutionDisabledError,
    RepairSourceInvalidError,
)


@dataclass(frozen=True, slots=True)
class _ErrorContract:
    status_code: int
    code: str
    message: str
    retryable: bool = False


_INVALID_REQUEST = _ErrorContract(422, "invalid_request", "Request is invalid.")
_SCENARIO_NOT_FOUND = _ErrorContract(
    404,
    "scenario_not_found",
    "Scenario was not found.",
)
_INCIDENT_NOT_FOUND = _ErrorContract(
    404,
    "incident_not_found",
    "Incident was not found.",
)
_MONITORING_PANEL_NOT_FOUND = _ErrorContract(
    404,
    "monitoring_panel_not_found",
    "Monitoring panel was not found.",
)
_RUN_NOT_FOUND = _ErrorContract(404, "run_not_found", "Run was not found.")
_ACTIVE_RUN_EXISTS = _ErrorContract(
    409,
    "active_run_exists",
    "An active run already exists.",
    True,
)
_INVALID_CURSOR = _ErrorContract(400, "invalid_cursor", "Cursor is invalid.")
_INVALID_LAST_EVENT_ID = _ErrorContract(
    400,
    "invalid_last_event_id",
    "Last-Event-ID is invalid.",
)
_RUNTIME_NOT_READY = _ErrorContract(
    503,
    "runtime_not_ready",
    "Runtime is not ready.",
    True,
)
_INTERNAL_ERROR = _ErrorContract(
    500,
    "internal_error",
    "Internal server error.",
)
_DIAGNOSIS_UNAVAILABLE = _ErrorContract(
    503,
    "diagnosis_unavailable",
    "Model diagnosis is unavailable.",
    True,
)
_ALERT_AUTHENTICATION_FAILED = _ErrorContract(
    401,
    "alert_authentication_failed",
    "Alertmanager authentication failed.",
)
_ALERT_PAYLOAD_TOO_LARGE = _ErrorContract(
    413,
    "alert_payload_too_large",
    "Alertmanager payload is too large.",
)
_ALERT_PAYLOAD_INVALID = _ErrorContract(
    422,
    "alert_payload_invalid",
    "Alertmanager payload is invalid.",
)
_ALERT_PAYLOAD_TRUNCATED = _ErrorContract(
    422,
    "alert_payload_truncated",
    "Alertmanager payload is truncated.",
)
_ALERT_TARGET_INVALID = _ErrorContract(
    422,
    "alert_target_invalid",
    "Alert target is invalid.",
)


def install_exception_handlers(app: FastAPI) -> None:
    async def approval_conflict_handler(
        _request: Request, _error: ApprovalConflictError
    ) -> JSONResponse:
        return _response(
            _ErrorContract(
                409, "approval_conflict", "Exact approval is no longer available."
            )
        )

    async def execution_disabled_handler(
        _request: Request, _error: ExecutionDisabledError
    ) -> JSONResponse:
        return _response(
            _ErrorContract(403, "execution_disabled", "Sandbox execution is disabled.")
        )

    app.add_exception_handler(
        ApprovalConflictError, cast(ExceptionHandler, approval_conflict_handler)
    )
    app.add_exception_handler(
        ExecutionDisabledError, cast(ExceptionHandler, execution_disabled_handler)
    )

    async def repair_source_handler(
        _request: Request, _error: RepairSourceInvalidError
    ) -> JSONResponse:
        return _response(
            _ErrorContract(
                409, "repair_source_invalid", "Repair source is not applicable."
            )
        )

    app.add_exception_handler(
        RepairSourceInvalidError, cast(ExceptionHandler, repair_source_handler)
    )
    operator_errors: dict[type[Exception], _ErrorContract] = {
        OperatorAuthenticationError: _ErrorContract(
            401,
            "operator_authentication_required",
            "Operator authentication is required.",
        ),
        OperatorOriginError: _ErrorContract(
            403, "operator_origin_rejected", "Request origin is not permitted."
        ),
        OperatorCsrfError: _ErrorContract(
            403, "operator_csrf_rejected", "Request verification failed."
        ),
        OperatorLoginLimitedError: _ErrorContract(
            429,
            "operator_login_limited",
            "Operator login is temporarily limited.",
            True,
        ),
        OperatorCredentialUnavailableError: _ErrorContract(
            503,
            "operator_authentication_unavailable",
            "Operator authentication is unavailable.",
            True,
        ),
    }

    async def operator_handler(_request: Request, error: Exception) -> JSONResponse:
        contract = operator_errors[type(error)]
        return _response(
            contract,
            headers={"Retry-After": "60"} if contract.status_code == 429 else None,
        )

    for exception_type in operator_errors:
        app.add_exception_handler(
            exception_type, cast(ExceptionHandler, operator_handler)
        )

    async def diagnosis_unavailable_handler(
        _request: Request,
        _error: DiagnosisUnavailableError,
    ) -> JSONResponse:
        return _response(_DIAGNOSIS_UNAVAILABLE)

    app.add_exception_handler(
        DiagnosisUnavailableError,
        cast(ExceptionHandler, diagnosis_unavailable_handler),
    )

    async def validation_handler(
        _request: Request,
        _error: RequestValidationError,
    ) -> JSONResponse:
        return _response(_INVALID_REQUEST)

    async def scenario_not_found_handler(
        _request: Request,
        _error: ScenarioNotFoundError,
    ) -> JSONResponse:
        return _response(_SCENARIO_NOT_FOUND)

    async def incident_not_found_handler(
        _request: Request,
        _error: IncidentNotFoundError,
    ) -> JSONResponse:
        return _response(_INCIDENT_NOT_FOUND)

    async def monitoring_panel_not_found_handler(
        _request: Request,
        _error: MonitoringPanelNotFoundError,
    ) -> JSONResponse:
        return _response(_MONITORING_PANEL_NOT_FOUND)

    async def run_not_found_handler(
        _request: Request,
        _error: RunNotFoundError,
    ) -> JSONResponse:
        return _response(_RUN_NOT_FOUND)

    async def active_run_handler(
        _request: Request,
        _error: ActiveRunConflictError,
    ) -> JSONResponse:
        return _response(_ACTIVE_RUN_EXISTS)

    async def invalid_cursor_handler(
        _request: Request,
        _error: InvalidCursorError,
    ) -> JSONResponse:
        return _response(_INVALID_CURSOR)

    async def invalid_last_event_id_handler(
        _request: Request,
        _error: InvalidLastEventIdError,
    ) -> JSONResponse:
        return _response(_INVALID_LAST_EVENT_ID)

    async def runtime_not_ready_handler(
        _request: Request,
        _error: RuntimeNotReadyError,
    ) -> JSONResponse:
        return _response(_RUNTIME_NOT_READY)

    async def internal_handler(
        _request: Request,
        _error: Exception,
    ) -> JSONResponse:
        return _response(_INTERNAL_ERROR)

    async def alert_authentication_handler(
        _request: Request,
        _error: AlertAuthenticationError,
    ) -> JSONResponse:
        return _response(
            _ALERT_AUTHENTICATION_FAILED,
            headers={"WWW-Authenticate": "Bearer"},
        )

    async def alert_payload_too_large_handler(
        _request: Request,
        _error: AlertPayloadTooLargeError,
    ) -> JSONResponse:
        return _response(_ALERT_PAYLOAD_TOO_LARGE)

    async def alert_payload_invalid_handler(
        _request: Request,
        _error: AlertPayloadInvalidError,
    ) -> JSONResponse:
        return _response(_ALERT_PAYLOAD_INVALID)

    async def alert_payload_truncated_handler(
        _request: Request,
        _error: AlertPayloadTruncatedError,
    ) -> JSONResponse:
        return _response(_ALERT_PAYLOAD_TRUNCATED)

    async def alert_target_invalid_handler(
        _request: Request,
        _error: AlertTargetInvalidError,
    ) -> JSONResponse:
        return _response(_ALERT_TARGET_INVALID)

    app.add_exception_handler(
        RequestValidationError,
        cast(ExceptionHandler, validation_handler),
    )
    app.add_exception_handler(
        ScenarioNotFoundError,
        cast(ExceptionHandler, scenario_not_found_handler),
    )
    app.add_exception_handler(
        IncidentNotFoundError,
        cast(ExceptionHandler, incident_not_found_handler),
    )
    app.add_exception_handler(
        MonitoringPanelNotFoundError,
        cast(ExceptionHandler, monitoring_panel_not_found_handler),
    )
    app.add_exception_handler(
        RunNotFoundError,
        cast(ExceptionHandler, run_not_found_handler),
    )
    app.add_exception_handler(
        ActiveRunConflictError,
        cast(ExceptionHandler, active_run_handler),
    )
    app.add_exception_handler(
        InvalidCursorError,
        cast(ExceptionHandler, invalid_cursor_handler),
    )
    app.add_exception_handler(
        InvalidLastEventIdError,
        cast(ExceptionHandler, invalid_last_event_id_handler),
    )
    app.add_exception_handler(
        RuntimeNotReadyError,
        cast(ExceptionHandler, runtime_not_ready_handler),
    )
    app.add_exception_handler(
        AlertAuthenticationError,
        cast(ExceptionHandler, alert_authentication_handler),
    )
    app.add_exception_handler(
        AlertPayloadTooLargeError,
        cast(ExceptionHandler, alert_payload_too_large_handler),
    )
    app.add_exception_handler(
        AlertPayloadInvalidError,
        cast(ExceptionHandler, alert_payload_invalid_handler),
    )
    app.add_exception_handler(
        AlertPayloadTruncatedError,
        cast(ExceptionHandler, alert_payload_truncated_handler),
    )
    app.add_exception_handler(
        AlertTargetInvalidError,
        cast(ExceptionHandler, alert_target_invalid_handler),
    )
    app.add_exception_handler(Exception, cast(ExceptionHandler, internal_handler))


def _response(
    contract: _ErrorContract,
    *,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    content = ErrorResponse(
        error=ErrorDetail(
            code=contract.code,
            message=contract.message,
            retryable=contract.retryable,
        )
    ).model_dump(mode="json")
    return JSONResponse(
        status_code=contract.status_code,
        content=content,
        headers={"Cache-Control": "no-store", **(headers or {})},
    )
