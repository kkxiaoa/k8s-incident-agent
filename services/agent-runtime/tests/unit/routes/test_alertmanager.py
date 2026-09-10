from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import cast

import httpx
import pytest
from tests.factories import diagnostic_model_stub, monitoring_health_service_stub

from k8s_incident_agent import api
from k8s_incident_agent.api import RuntimeContainer
from k8s_incident_agent.application.alerts import AlertmanagerApplicationService
from k8s_incident_agent.application.events import IncidentEventService
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.config import Settings
from k8s_incident_agent.monitoring.alertmanager import MAX_WEBHOOK_BODY_BYTES
from k8s_incident_agent.monitoring.errors import (
    AlertAuthenticationError,
    AlertPayloadInvalidError,
    AlertPayloadTooLargeError,
    AlertPayloadTruncatedError,
    AlertTargetInvalidError,
)
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT, RuntimePaths


class _AlertService:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.authenticated: list[str | None] = []
        self.payloads: list[bytes] = []

    def require_authentication(self, credential: str | None) -> None:
        self.authenticated.append(credential)
        if credential != "a" * 32:
            raise AlertAuthenticationError

    async def ingest(self, payload: bytes) -> None:
        self.payloads.append(payload)
        if self.error is not None:
            raise self.error


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        runtime_paths=RuntimePaths.prepare(tmp_path / "runtime"),
        scenario_catalog_dir=REPOSITORY_ROOT / "scenarios",
        alert_catalog_dir=REPOSITORY_ROOT / "monitoring" / "catalog",
        alertmanager_webhook_token_file=tmp_path / "mounted" / "credential",
        _env_file=None,  # pyright: ignore[reportCallIssue]
    )


@asynccontextmanager
async def _client(
    tmp_path: Path,
    service: _AlertService,
) -> AsyncGenerator[httpx.AsyncClient]:
    @asynccontextmanager
    async def runtime_context(
        _settings: Settings,
    ) -> AsyncGenerator[RuntimeContainer]:
        yield RuntimeContainer(
            diagnostic_model=diagnostic_model_stub(),
            incidents=cast(IncidentApplicationService, object()),
            events=cast(IncidentEventService, object()),
            alerts=cast(AlertmanagerApplicationService, service),
            monitoring=monitoring_health_service_stub(),
        )

    app = api.create_app(
        settings=_settings(tmp_path),
        runtime_context_factory=runtime_context,
    )
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
        ) as client:
            yield client


def _headers() -> dict[str, str]:
    return {
        "authorization": f"Bearer {'a' * 32}",
        "content-type": "application/json",
    }


def _error(code: str, message: str) -> dict[str, object]:
    return {
        "error": {
            "code": code,
            "message": message,
            "retryable": False,
        }
    }


@pytest.mark.asyncio
async def test_authenticated_json_is_streamed_to_the_application_service(
    tmp_path: Path,
) -> None:
    service = _AlertService()
    async with _client(tmp_path, service) as client:
        response = await client.post(
            "/api/v1/alerts/alertmanager",
            headers=_headers(),
            content=b'{"version":"4"}',
        )

    assert response.status_code == 204
    assert response.content == b""
    assert service.authenticated == ["a" * 32]
    assert service.payloads == [b'{"version":"4"}']


@pytest.mark.asyncio
async def test_authentication_failure_does_not_consume_the_request_body(
    tmp_path: Path,
) -> None:
    service = _AlertService()
    consumed = False

    async def body() -> AsyncIterator[bytes]:
        nonlocal consumed
        consumed = True
        yield b'{"version":"4"}'

    async with _client(tmp_path, service) as client:
        response = await client.post(
            "/api/v1/alerts/alertmanager",
            headers={"content-type": "application/json"},
            content=body(),
        )

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.json() == _error(
        "alert_authentication_failed",
        "Alertmanager authentication failed.",
    )
    assert consumed is False
    assert service.payloads == []


@pytest.mark.asyncio
async def test_declared_oversize_is_rejected_before_streaming(tmp_path: Path) -> None:
    service = _AlertService()
    consumed = False

    async def body() -> AsyncIterator[bytes]:
        nonlocal consumed
        consumed = True
        yield b"{}"

    headers = _headers()
    headers["content-length"] = str(MAX_WEBHOOK_BODY_BYTES + 1)
    async with _client(tmp_path, service) as client:
        response = await client.post(
            "/api/v1/alerts/alertmanager",
            headers=headers,
            content=body(),
        )

    assert response.status_code == 413
    assert response.json() == _error(
        "alert_payload_too_large",
        "Alertmanager payload is too large.",
    )
    assert consumed is False
    assert service.payloads == []


@pytest.mark.asyncio
async def test_streamed_body_budget_is_enforced(tmp_path: Path) -> None:
    service = _AlertService()

    async def body() -> AsyncIterator[bytes]:
        yield b"a" * MAX_WEBHOOK_BODY_BYTES
        yield b"b"

    async with _client(tmp_path, service) as client:
        response = await client.post(
            "/api/v1/alerts/alertmanager",
            headers=_headers(),
            content=body(),
        )

    assert response.status_code == 413
    assert service.payloads == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "status_code", "code", "message"),
    [
        (
            AlertPayloadTooLargeError(),
            413,
            "alert_payload_too_large",
            "Alertmanager payload is too large.",
        ),
        (
            AlertPayloadInvalidError(),
            422,
            "alert_payload_invalid",
            "Alertmanager payload is invalid.",
        ),
        (
            AlertPayloadTruncatedError(),
            422,
            "alert_payload_truncated",
            "Alertmanager payload is truncated.",
        ),
        (
            AlertTargetInvalidError(),
            422,
            "alert_target_invalid",
            "Alert target is invalid.",
        ),
    ],
)
async def test_intake_failures_use_distinct_safe_envelopes(
    tmp_path: Path,
    error: Exception,
    status_code: int,
    code: str,
    message: str,
) -> None:
    service = _AlertService(error)
    async with _client(tmp_path, service) as client:
        response = await client.post(
            "/api/v1/alerts/alertmanager",
            headers=_headers(),
            content=b"{}",
        )

    assert response.status_code == status_code
    assert response.json() == _error(code, message)


@pytest.mark.asyncio
async def test_content_type_is_checked_only_after_authentication(
    tmp_path: Path,
) -> None:
    service = _AlertService()
    async with _client(tmp_path, service) as client:
        unauthenticated = await client.post(
            "/api/v1/alerts/alertmanager",
            headers={"content-type": "text/plain"},
            content=b"{}",
        )
        wrong_content_type = await client.post(
            "/api/v1/alerts/alertmanager",
            headers={
                "authorization": f"Bearer {'a' * 32}",
                "content-type": "text/plain",
            },
            content=b"{}",
        )

    assert unauthenticated.status_code == 401
    assert wrong_content_type.status_code == 422
    assert service.payloads == []
