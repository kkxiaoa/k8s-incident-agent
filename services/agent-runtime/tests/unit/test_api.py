import asyncio
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import cast

import httpx
import pytest
from fastapi.responses import StreamingResponse
from tests.factories import monitoring_health_service_stub

from k8s_incident_agent import api
from k8s_incident_agent.api import RuntimeContainer
from k8s_incident_agent.application.events import IncidentEventService
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.config import ConfigurationInvalidError, Settings
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
                incidents=cast(IncidentApplicationService, _UnusedService()),
                events=cast(IncidentEventService, _UnusedService()),
                alerts=None,
                monitoring=monitoring_health_service_stub(),
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


def _route_table(app: api.FastAPI) -> set[tuple[str, str]]:
    routes: set[tuple[str, str]] = set()
    paths = cast(dict[str, dict[str, object]], app.openapi()["paths"])
    for path, operations in paths.items():
        routes.update((method.upper(), path) for method in operations)
    return routes


def test_manual_route_table_contains_read_and_create_endpoints() -> None:
    routes = _route_table(api.create_app())

    assert routes == {
        ("GET", "/healthz"),
        ("GET", "/api/v1/scenarios"),
        ("POST", "/api/v1/incidents"),
        ("GET", "/api/v1/incidents"),
        ("GET", "/api/v1/incidents/{incident_id}"),
        ("GET", "/api/v1/incidents/{incident_id}/events"),
        ("GET", "/api/v1/incidents/{incident_id}/runs"),
        ("POST", "/api/v1/incidents/{incident_id}/runs"),
        ("GET", "/api/v1/incidents/{incident_id}/runs/{run_id}/events"),
        ("GET", "/api/v1/monitoring/health"),
    }
    assert all(method not in {"PUT", "PATCH", "DELETE"} for method, _path in routes)


def test_online_route_table_omits_manual_entrypoints(tmp_path: Path) -> None:
    settings = _settings(tmp_path).model_copy(update={"incident_intake_mode": "online"})

    routes = _route_table(api.create_app(settings=settings))

    assert routes == {
        ("GET", "/healthz"),
        ("GET", "/api/v1/incidents"),
        ("GET", "/api/v1/incidents/{incident_id}"),
        ("GET", "/api/v1/incidents/{incident_id}/events"),
        ("GET", "/api/v1/incidents/{incident_id}/runs"),
        ("GET", "/api/v1/incidents/{incident_id}/runs/{run_id}/events"),
        ("GET", "/api/v1/monitoring/health"),
    }


def test_configured_alertmanager_route_is_internal_runtime_only(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path).model_copy(
        update={
            "incident_intake_mode": "online",
            "alertmanager_webhook_token_file": tmp_path / "mounted" / "credential",
        }
    )

    routes = _route_table(api.create_app(settings=settings))

    assert ("POST", "/api/v1/alerts/alertmanager") in routes
    assert ("POST", "/api/v1/incidents") not in routes
    assert ("POST", "/api/v1/incidents/{incident_id}/runs") not in routes
    assert ("GET", "/api/v1/scenarios") not in routes


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
        "app_target": "k8s_incident_agent.api:create_runtime_app",
        "factory": True,
        "host": "127.0.0.1",
        "workers": 1,
        "timeout_graceful_shutdown": 5,
    }


@pytest.mark.asyncio
async def test_uvicorn_timeout_cancels_active_sse_and_closes_lifespan() -> None:
    stream_entered = asyncio.Event()
    stream_cancelled = asyncio.Event()
    lifespan_closed = asyncio.Event()

    @asynccontextmanager
    async def lifespan(_app: object) -> AsyncGenerator[None]:
        try:
            yield
        finally:
            lifespan_closed.set()

    test_app = api.FastAPI(lifespan=lifespan)

    async def endless_stream() -> AsyncIterator[bytes]:
        stream_entered.set()
        try:
            yield b": ready\n\n"
            await asyncio.Future[None]()
        finally:
            stream_cancelled.set()

    async def events() -> StreamingResponse:
        return StreamingResponse(endless_stream(), media_type="text/event-stream")

    test_app.add_api_route("/events", events, methods=["GET"])
    server = api.uvicorn.Server(
        api.uvicorn.Config(
            test_app,
            host="127.0.0.1",
            port=0,
            log_level="critical",
            timeout_graceful_shutdown=1,
        )
    )
    server_task = asyncio.create_task(server.serve())
    try:
        async with asyncio.timeout(3):
            while not server.started:
                await asyncio.sleep(0.01)
        sockets = server.servers[0].sockets
        assert sockets
        port = cast(tuple[str, int], sockets[0].getsockname())[1]
        async with (
            httpx.AsyncClient(timeout=3) as client,
            client.stream("GET", f"http://127.0.0.1:{port}/events") as response,
        ):
            assert response.status_code == 200
            chunks = response.aiter_bytes()
            assert await anext(chunks) == b": ready\n\n"
            await asyncio.wait_for(stream_entered.wait(), 1)

            server.should_exit = True

            await asyncio.wait_for(server_task, 3)
            await asyncio.wait_for(stream_cancelled.wait(), 1)
    finally:
        server.should_exit = True
        if not server_task.done():
            await asyncio.wait_for(server_task, 3)

    assert lifespan_closed.is_set()


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
