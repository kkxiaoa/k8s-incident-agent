import asyncio
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast
from uuid import UUID

import httpx
import pytest
from alembic import command
from alembic.config import Config
from starlette.types import Message, Scope
from tests.factories import (
    diagnostic_model_stub,
    monitoring_health_service_stub,
    normalized_trigger,
)

from k8s_incident_agent import api
from k8s_incident_agent.api import RuntimeContainer
from k8s_incident_agent.application.events import (
    EventDependencies,
    IncidentEventService,
    InvalidLastEventIdError,
    RunEventNotifier,
)
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.config import Settings
from k8s_incident_agent.domain.models import (
    ModelSnapshot,
    RunBudget,
    RunStatus,
    TerminalRecord,
)
from k8s_incident_agent.persistence.database import (
    BusinessDatabase,
    create_business_database,
)
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT, RuntimePaths

SERVICE_ROOT = Path(__file__).resolve().parents[3]
INCIDENT_ID = UUID("00000000-0000-0000-0000-000000000001")
NOW = datetime(2026, 8, 26, 9, 0, tzinfo=UTC)
MODEL = ModelSnapshot(
    provider="deepseek",
    model_id="deepseek-v4-flash",
    thinking_mode=False,
    prompt_version="stage1-v1",
)
BUDGET = RunBudget(max_model_calls=8, max_tool_calls=6, timeout_seconds=180)


class _EventService:
    def __init__(self) -> None:
        self.arguments: tuple[UUID, str | None] | None = None

    async def open_stream(
        self,
        incident_id: UUID,
        last_event_id: str | None,
    ) -> AsyncIterator[bytes]:
        self.arguments = (incident_id, last_event_id)
        if last_event_id == "bad":
            raise InvalidLastEventIdError

        async def stream() -> AsyncIterator[bytes]:
            if last_event_id == "explode-after-start":
                raise RuntimeError("sensitive stream failure")
            yield b'id: 1\nevent: incident.created\ndata: {"schemaVersion":1}\n\n'

        return stream()


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        runtime_paths=RuntimePaths.prepare(tmp_path / "runtime"),
        scenario_catalog_dir=REPOSITORY_ROOT / "scenarios",
        _env_file=None,  # pyright: ignore[reportCallIssue]
    )


@asynccontextmanager
async def _client(
    tmp_path: Path,
    service: IncidentEventService | _EventService,
) -> AsyncGenerator[httpx.AsyncClient]:
    @asynccontextmanager
    async def runtime_context(_settings: Settings) -> AsyncGenerator[RuntimeContainer]:
        yield RuntimeContainer(
            diagnostic_model=diagnostic_model_stub(),
            incidents=cast(IncidentApplicationService, object()),
            events=cast(IncidentEventService, service),
            alerts=None,
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


@pytest.mark.asyncio
async def test_route_sets_sse_content_type_cache_header_and_forwards_cursor(
    tmp_path: Path,
) -> None:
    service = _EventService()
    async with _client(tmp_path, service) as client:
        response = await client.get(
            f"/api/v1/incidents/{INCIDENT_ID}/events",
            headers={"Last-Event-ID": "0"},
        )

    assert response.status_code == 200
    assert response.headers["content-type"] == "text/event-stream; charset=utf-8"
    assert response.headers["cache-control"] == "no-cache"
    assert service.arguments == (INCIDENT_ID, "0")
    assert response.content.startswith(b"id: 1\nevent: incident.created\n")


@pytest.mark.asyncio
async def test_invalid_last_event_id_is_json_error_before_stream_starts(
    tmp_path: Path,
) -> None:
    service = _EventService()
    async with _client(tmp_path, service) as client:
        response = await client.get(
            f"/api/v1/incidents/{INCIDENT_ID}/events",
            headers={"Last-Event-ID": "bad"},
        )

    assert response.status_code == 400
    assert response.headers["content-type"] == "application/json"
    assert response.json() == {
        "error": {
            "code": "invalid_last_event_id",
            "message": "Last-Event-ID is invalid.",
            "retryable": False,
        }
    }


@pytest.mark.asyncio
async def test_failure_after_stream_start_does_not_become_sse_data(
    tmp_path: Path,
) -> None:
    service = _EventService()
    async with _client(tmp_path, service) as client:
        response = await client.get(
            f"/api/v1/incidents/{INCIDENT_ID}/events",
            headers={"Last-Event-ID": "explode-after-start"},
        )

    assert response.status_code == 200
    assert b"sensitive stream failure" not in response.content
    assert b"data:" not in response.content


def _alembic_config(paths: RuntimePaths) -> Config:
    config = Config(str(SERVICE_ROOT / "alembic.ini"))
    config.attributes["runtime_paths"] = paths
    return config


@asynccontextmanager
async def _database(tmp_path: Path) -> AsyncGenerator[BusinessDatabase]:
    paths = RuntimePaths.prepare(tmp_path / "database-runtime")
    command.upgrade(_alembic_config(paths), "head")
    database = await create_business_database(paths)
    try:
        yield database
    finally:
        await database.dispose()


def _scenario():
    return normalized_trigger()


@pytest.mark.asyncio
async def test_new_asgi_client_replays_from_real_sqlite_without_duplicates(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:
        notifier = RunEventNotifier()
        repository = IncidentRepository(
            database.session_factory,
            on_event_committed=notifier.notify,
        )
        created = await repository.create_incident_and_run(_scenario(), MODEL, BUDGET)
        started = await repository.start_run(created.run_id, NOW)
        terminal = await repository.persist_terminal(
            TerminalRecord(
                run_id=created.run_id,
                completed_at=NOW + timedelta(seconds=1),
                outcome=None,
                summary=None,
                root_causes=(),
                missing_information=(),
                redacted=False,
                error_code="agent_timeout",
                error_retryable=True,
                model_calls=1,
                tool_calls=0,
                input_tokens=10,
                output_tokens=5,
            )
        )

        def finite_service(event_count: int) -> IncidentEventService:
            class _FiniteReplayService(IncidentEventService):
                async def open_stream(
                    self,
                    incident_id: UUID,
                    last_event_id_header: str | None,
                ) -> AsyncIterator[bytes]:
                    stream = await super().open_stream(
                        incident_id,
                        last_event_id_header,
                    )

                    async def finite() -> AsyncIterator[bytes]:
                        try:
                            for _ in range(event_count):
                                yield await anext(stream)
                        finally:
                            await cast(AsyncGenerator[bytes], stream).aclose()

                    return finite()

            return _FiniteReplayService(
                EventDependencies(repository=repository, notifier=notifier)
            )

        async with _client(tmp_path, finite_service(3)) as first_client:
            first_response = await first_client.get(
                f"/api/v1/incidents/{created.incident_id}/events",
                headers={"Last-Event-ID": "0"},
            )
        async with _client(tmp_path, finite_service(1)) as reconnected_client:
            replay = await reconnected_client.get(
                f"/api/v1/incidents/{created.incident_id}/events",
                headers={"Last-Event-ID": str(started.event.id)},
            )
        async with _client(tmp_path, finite_service(0)) as terminal_reconnect_client:
            after_terminal = await terminal_reconnect_client.get(
                f"/api/v1/incidents/{created.incident_id}/events",
                headers={"Last-Event-ID": str(terminal.event.id)},
            )

        assert first_response.status_code == 200
        assert first_response.text.count("\nevent: ") == 3
        assert replay.status_code == 200
        assert replay.text.startswith(f"id: {terminal.event.id}\n")
        assert replay.text.count("\nevent: ") == 1
        assert "event: run.failed" in replay.text
        assert f"id: {started.event.id}\n" not in replay.text
        assert after_terminal.status_code == 200
        assert after_terminal.content == b""


@pytest.mark.asyncio
async def test_http_disconnect_cancels_stream_without_changing_run_state(
    tmp_path: Path,
) -> None:
    async with _database(tmp_path) as database:

        class TrackingNotifier(RunEventNotifier):
            def __init__(self) -> None:
                super().__init__()
                self.waiting = asyncio.Event()
                self.cancelled = asyncio.Event()

            async def wait(
                self,
                incident_id: UUID,
                timeout_seconds: float,
            ) -> bool:
                self.waiting.set()
                try:
                    return await super().wait(incident_id, timeout_seconds)
                except asyncio.CancelledError:
                    self.cancelled.set()
                    raise

        notifier = TrackingNotifier()
        repository = IncidentRepository(database.session_factory)
        created = await repository.create_incident_and_run(_scenario(), MODEL, BUDGET)
        service = IncidentEventService(
            EventDependencies(
                repository=repository,
                notifier=notifier,
            )
        )

        @asynccontextmanager
        async def runtime_context(
            _settings: Settings,
        ) -> AsyncGenerator[RuntimeContainer]:
            yield RuntimeContainer(
                diagnostic_model=diagnostic_model_stub(),
                incidents=cast(IncidentApplicationService, object()),
                events=service,
                alerts=None,
                monitoring=monitoring_health_service_stub(),
            )

        app = api.create_app(
            settings=_settings(tmp_path),
            runtime_context_factory=runtime_context,
        )
        path = f"/api/v1/incidents/{created.incident_id}/events"
        scope = cast(
            Scope,
            {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.3"},
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": path,
                "raw_path": path.encode(),
                "query_string": b"",
                "root_path": "",
                "headers": [
                    (b"host", b"testserver"),
                    (b"last-event-id", str(created.event.id).encode()),
                ],
                "client": ("127.0.0.1", 12345),
                "server": ("testserver", 80),
            },
        )
        receive_messages: asyncio.Queue[Message] = asyncio.Queue()
        response_started = asyncio.Event()

        async def receive() -> Message:
            return await receive_messages.get()

        async def send(message: Message) -> None:
            if message["type"] == "http.response.start":
                response_started.set()

        await receive_messages.put(
            {"type": "http.request", "body": b"", "more_body": False}
        )
        async with app.router.lifespan_context(app):
            request = asyncio.create_task(app(scope, receive, send))
            await asyncio.wait_for(response_started.wait(), 1)
            await asyncio.wait_for(notifier.waiting.wait(), 1)

            await receive_messages.put({"type": "http.disconnect"})

            await asyncio.wait_for(request, 1)
            assert notifier.cancelled.is_set()

        detail = await repository.get_incident_detail(
            created.incident_id,
            run_id=None,
            event_limit=100,
        )
        assert detail is not None
        assert detail.run.status is RunStatus.QUEUED
