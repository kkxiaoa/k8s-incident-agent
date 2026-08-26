from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import cast

import httpx
import pytest
from fastapi.routing import APIRoute

from k8s_incident_agent import api
from k8s_incident_agent.api import RuntimeContainer
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.config import ConfigurationInvalidError, Settings
from k8s_incident_agent.routes.incidents import router as incidents_router
from k8s_incident_agent.routes.scenarios import router as scenarios_router
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT, RuntimePaths


class _UnusedService:
    pass


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        runtime_paths=RuntimePaths.prepare(tmp_path / "runtime"),
        scenario_catalog_dir=REPOSITORY_ROOT / "scenarios",
        _env_file=None,  # pyright: ignore[reportCallIssue]
    )


@pytest.mark.asyncio
async def test_settings_and_runtime_context_are_entered_only_during_lifespan(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    events: list[str] = []

    def settings_factory() -> Settings:
        events.append("settings")
        return settings

    @asynccontextmanager
    async def runtime_context(received: Settings) -> AsyncGenerator[RuntimeContainer]:
        assert received is settings
        events.append("runtime.open")
        try:
            yield RuntimeContainer(
                incidents=cast(IncidentApplicationService, _UnusedService())
            )
        finally:
            assert cast(bool, app.state.ready) is False
            events.append("runtime.close")

    monkeypatch.setattr(api, "Settings", settings_factory)
    app = api.create_app(runtime_context_factory=runtime_context)

    assert events == []
    assert cast(bool, app.state.ready) is False
    assert not hasattr(app.state, "container")

    async with app.router.lifespan_context(app):
        assert events == ["settings", "runtime.open"]
        assert cast(bool, app.state.ready) is True
        assert hasattr(app.state, "container")
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
        ) as client:
            response = await client.get("/healthz")
            assert response.status_code == 200
            assert response.json() == {"status": "ok"}
            for unavailable_path in ("/", "/docs", "/openapi.json", "/redoc"):
                unavailable = await client.get(unavailable_path)
                assert unavailable.status_code == 404

    assert events == ["settings", "runtime.open", "runtime.close"]
    assert cast(bool, app.state.ready) is False
    assert not hasattr(app.state, "container")


@pytest.mark.asyncio
async def test_runtime_context_failure_never_publishes_ready_container(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)

    @asynccontextmanager
    async def failing_context(
        _settings: Settings,
    ) -> AsyncGenerator[RuntimeContainer]:
        raise RuntimeError("startup failed")
        yield  # pragma: no cover

    app = api.create_app(
        settings=settings,
        runtime_context_factory=failing_context,
    )

    with pytest.raises(RuntimeError, match="startup failed"):
        async with app.router.lifespan_context(app):
            pass

    assert cast(bool, app.state.ready) is False
    assert not hasattr(app.state, "container")


def test_route_table_contains_only_task_11_endpoints() -> None:
    app = api.create_app()
    routes: set[tuple[str, str]] = set()
    for route in (*app.routes, *scenarios_router.routes, *incidents_router.routes):
        if isinstance(route, APIRoute):
            assert route.methods is not None
            routes.update((method, route.path) for method in route.methods)

    assert routes == {
        ("GET", "/healthz"),
        ("GET", "/api/v1/scenarios"),
        ("POST", "/api/v1/incidents"),
        ("GET", "/api/v1/incidents"),
        ("GET", "/api/v1/incidents/{incident_id}"),
    }
    assert all(method not in {"PUT", "PATCH", "DELETE"} for method, _path in routes)


def test_runtime_entrypoint_freezes_loopback_single_worker(
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
        "host": "127.0.0.1",
        "workers": 1,
    }


@pytest.mark.asyncio
async def test_settings_failure_prevents_runtime_context_entry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered = False

    def settings_factory() -> Settings:
        raise ConfigurationInvalidError("invalid runtime configuration")

    @asynccontextmanager
    async def runtime_context(_settings: Settings) -> AsyncGenerator[RuntimeContainer]:
        nonlocal entered
        entered = True
        yield cast(RuntimeContainer, object())

    monkeypatch.setattr(api, "Settings", settings_factory)
    app = api.create_app(runtime_context_factory=runtime_context)

    with pytest.raises(ConfigurationInvalidError):
        async with app.router.lifespan_context(app):
            pass

    assert entered is False
    assert cast(bool, app.state.ready) is False
