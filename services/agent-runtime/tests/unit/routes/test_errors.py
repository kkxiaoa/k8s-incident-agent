from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import cast
from uuid import UUID

import httpx
import pytest
from fastapi import FastAPI
from tests.factories import monitoring_health_service_stub

from k8s_incident_agent import api
from k8s_incident_agent.api import RuntimeContainer
from k8s_incident_agent.api_contracts import CreateIncidentRequest
from k8s_incident_agent.application.events import IncidentEventService
from k8s_incident_agent.application.incidents import (
    IncidentApplicationService,
    IncidentNotFoundError,
    InvalidCursorError,
    ScenarioNotFoundError,
)
from k8s_incident_agent.config import Settings
from k8s_incident_agent.persistence.repositories import PersistenceOperationError
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT, RuntimePaths


class _FailingService:
    async def list_scenarios(self) -> object:
        raise RuntimeError("unused")

    async def create_incident(self, request: CreateIncidentRequest) -> object:
        if request.scenario_id == "database":
            raise PersistenceOperationError
        if request.scenario_id == "unexpected":
            raise RuntimeError("sensitive internal detail")
        raise ScenarioNotFoundError

    async def list_incidents(self, *, limit: int, cursor: str | None) -> object:
        del limit, cursor
        raise InvalidCursorError

    async def get_incident(
        self,
        incident_id: UUID,
        *,
        run_id: UUID | None,
    ) -> object:
        del incident_id, run_id
        raise IncidentNotFoundError


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        runtime_paths=RuntimePaths.prepare(tmp_path / "runtime"),
        scenario_catalog_dir=REPOSITORY_ROOT / "scenarios",
        _env_file=None,  # pyright: ignore[reportCallIssue]
    )


def _app(tmp_path: Path) -> FastAPI:
    @asynccontextmanager
    async def runtime_context(_settings: Settings) -> AsyncGenerator[RuntimeContainer]:
        yield RuntimeContainer(
            incidents=cast(IncidentApplicationService, _FailingService()),
            events=cast(IncidentEventService, object()),
            alerts=None,
            monitoring=monitoring_health_service_stub(),
        )

    return api.create_app(
        settings=_settings(tmp_path),
        runtime_context_factory=runtime_context,
    )


@asynccontextmanager
async def _client(
    app: FastAPI,
    *,
    lifespan: bool = True,
) -> AsyncGenerator[httpx.AsyncClient]:
    if lifespan:
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://testserver",
            ) as client:
                yield client
        return
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        yield client


def _error(code: str, message: str, *, retryable: bool = False) -> dict[str, object]:
    return {
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
        }
    }


@pytest.mark.asyncio
async def test_request_validation_is_static_and_does_not_echo_body(
    tmp_path: Path,
) -> None:
    app = _app(tmp_path)
    secret = "must-not-appear-in-validation-response"
    async with _client(app) as client:
        response = await client.post(
            "/api/v1/incidents",
            json={"scenarioId": "known", "unexpected": secret},
        )

    assert response.status_code == 422
    assert response.json() == _error("invalid_request", "Request is invalid.")
    assert secret not in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path", "body", "status", "code", "message"),
    [
        (
            "POST",
            "/api/v1/incidents",
            {"scenarioId": "missing"},
            404,
            "scenario_not_found",
            "Scenario was not found.",
        ),
        (
            "GET",
            "/api/v1/incidents?cursor=bad",
            None,
            400,
            "invalid_cursor",
            "Cursor is invalid.",
        ),
        (
            "GET",
            "/api/v1/incidents/00000000-0000-0000-0000-000000000001",
            None,
            404,
            "incident_not_found",
            "Incident was not found.",
        ),
        (
            "POST",
            "/api/v1/incidents",
            {"scenarioId": "database"},
            500,
            "internal_error",
            "Internal server error.",
        ),
        (
            "POST",
            "/api/v1/incidents",
            {"scenarioId": "unexpected"},
            500,
            "internal_error",
            "Internal server error.",
        ),
    ],
)
async def test_business_and_internal_errors_use_safe_stable_envelopes(
    tmp_path: Path,
    method: str,
    path: str,
    body: dict[str, object] | None,
    status: int,
    code: str,
    message: str,
) -> None:
    app = _app(tmp_path)
    async with _client(app) as client:
        response = await client.request(method, path, json=body)

    assert response.status_code == status
    assert response.json() == _error(code, message)
    assert "sensitive internal detail" not in response.text


@pytest.mark.asyncio
async def test_application_routes_fail_closed_before_runtime_is_ready(
    tmp_path: Path,
) -> None:
    app = _app(tmp_path)

    async with _client(app, lifespan=False) as client:
        response = await client.get("/api/v1/scenarios")

    assert response.status_code == 503
    assert response.json() == _error(
        "runtime_not_ready",
        "Runtime is not ready.",
        retryable=True,
    )
