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


def install_exception_handlers(app: FastAPI) -> None:
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
    app.add_exception_handler(Exception, cast(ExceptionHandler, internal_handler))


def _response(contract: _ErrorContract) -> JSONResponse:
    content = ErrorResponse(
        error=ErrorDetail(
            code=contract.code,
            message=contract.message,
            retryable=contract.retryable,
        )
    ).model_dump(mode="json")
    return JSONResponse(status_code=contract.status_code, content=content)
