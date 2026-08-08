from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import cast

import httpx
import pytest
from fastapi import FastAPI

from k8s_incident_agent import api
from k8s_incident_agent.config import ConfigurationInvalidError, Settings
from k8s_incident_agent.model.errors import ModelError, ModelErrorCode


def make_settings(
    monkeypatch: pytest.MonkeyPatch,
    *,
    api_key: str | None = "test-startup-key",
) -> Settings:
    if api_key is None:
        monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    else:
        monkeypatch.setenv("DEEPSEEK_API_KEY", api_key)
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://provider.example/api")
    return Settings(_env_file=None)  # pyright: ignore[reportCallIssue]


@asynccontextmanager
async def lifespan_client(app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
        ) as client:
            yield client


async def test_discovery_runs_in_lifespan_before_minimal_healthz_is_ready(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = make_settings(monkeypatch)
    discovery_calls = 0

    async def fake_discovery(received_settings: Settings) -> tuple[str, ...]:
        nonlocal discovery_calls
        discovery_calls += 1
        assert received_settings is settings
        return ("deepseek-v4-flash", "sensitive-unconfigured-model")

    app = api.create_app(settings=settings, discovery=fake_discovery)

    assert discovery_calls == 0
    assert cast(bool, app.state.ready) is False

    async with lifespan_client(app) as client:
        assert discovery_calls == 1
        assert cast(bool, app.state.ready) is True

        response = await client.get("/healthz")

        assert response.status_code == 200
        assert cast(object, response.json()) == {"status": "ok"}
        assert set(response.headers) >= {"content-length", "content-type"}
        assert "test-startup-key" not in response.text
        assert "sensitive-unconfigured-model" not in response.text

        for unavailable_path in ("/", "/docs", "/openapi.json", "/redoc"):
            unavailable_response = await client.get(unavailable_path)
            assert unavailable_response.status_code == 404

    assert cast(bool, app.state.ready) is False


async def test_missing_key_prevents_startup_without_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = make_settings(monkeypatch, api_key=None)

    async def fail_network(*_: object, **__: object) -> httpx.Response:
        raise AssertionError("missing-key startup must not access the network")

    monkeypatch.setattr(httpx.AsyncClient, "get", fail_network)
    app = api.create_app(settings=settings)

    with pytest.raises(ConfigurationInvalidError) as error:
        async with app.router.lifespan_context(app):
            pass

    assert error.value.code is ModelErrorCode.CONFIGURATION_INVALID
    assert cast(bool, app.state.ready) is False


@pytest.mark.parametrize(
    "error_code",
    [
        ModelErrorCode.AUTHENTICATION_FAILED,
        ModelErrorCode.MODEL_NOT_FOUND,
        ModelErrorCode.PROVIDER_UNAVAILABLE,
    ],
)
async def test_discovery_failure_prevents_ready_without_exposing_details(
    monkeypatch: pytest.MonkeyPatch,
    error_code: ModelErrorCode,
) -> None:
    settings = make_settings(monkeypatch)
    sensitive_detail = "sensitive upstream response body"

    async def fake_discovery(_: Settings) -> tuple[str, ...]:
        raise ModelError(error_code, sensitive_detail)

    app = api.create_app(settings=settings, discovery=fake_discovery)

    with pytest.raises(ModelError) as error:
        async with app.router.lifespan_context(app):
            pass

    assert error.value.code is error_code
    assert cast(bool, app.state.ready) is False
    assert not hasattr(app.state, "models")
    assert not hasattr(app.state, "error")


def test_runtime_entrypoint_uses_uvicorn_app_factory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_run(app_target: object, **options: object) -> None:
        captured["app_target"] = app_target
        captured.update(options)

    monkeypatch.setattr(api.uvicorn, "run", fake_run)

    api.main()

    assert captured == {
        "app_target": "k8s_incident_agent.api:create_app",
        "factory": True,
    }
