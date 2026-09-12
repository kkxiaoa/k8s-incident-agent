import asyncio
import logging
import os
import secrets
import sqlite3
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, closing
from pathlib import Path
from typing import cast

import httpx
import pytest
from alembic import command
from alembic.config import Config
from argon2 import PasswordHasher
from argon2.profiles import RFC_9106_LOW_MEMORY
from pydantic import ValidationError
from sqlalchemy import Connection, Engine, event, select
from tests.factories import diagnostic_model_stub, monitoring_health_service_stub

from k8s_incident_agent.api import RuntimeContainer, create_app
from k8s_incident_agent.application.events import IncidentEventService
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.auth.sessions import (
    SESSION_COOKIE,
    OperatorAuthenticationError,
    OperatorSessions,
)
from k8s_incident_agent.auth.verifier import (
    OperatorCredentialUnavailableError,
    PasswordVerifier,
)
from k8s_incident_agent.config import Settings
from k8s_incident_agent.persistence.database import create_business_database
from k8s_incident_agent.persistence.models import OperatorSessionRow
from k8s_incident_agent.runtime.paths import RuntimePaths

ORIGIN = "https://console.example.test"


@pytest.fixture(scope="module")
def credential() -> tuple[str, str]:
    password = secrets.token_urlsafe(32)
    encoded = PasswordHasher.from_parameters(RFC_9106_LOW_MEMORY).hash(password)
    return password, encoded


@asynccontextmanager
async def boundary(
    tmp_path: Path, encoded: str
) -> AsyncGenerator[tuple[httpx.AsyncClient, OperatorSessions, list[float]]]:
    paths = RuntimePaths.prepare(tmp_path / "operator-test")
    config = Config(str(Path(__file__).resolve().parents[3] / "alembic.ini"))
    config.attributes["runtime_paths"] = paths
    command.upgrade(config, "head")
    database = await create_business_database(paths)
    clock = [1_800_000_000.0]
    sessions = OperatorSessions(
        sessions=database.session_factory,
        verifier=PasswordVerifier(encoded),
        origin=ORIGIN,
        now=lambda: clock[0],
    )
    await sessions.start()

    @asynccontextmanager
    async def context(_settings: Settings) -> AsyncGenerator[RuntimeContainer]:
        yield RuntimeContainer(
            incidents=cast(IncidentApplicationService, object()),
            events=cast(IncidentEventService, object()),
            alerts=None,
            monitoring=monitoring_health_service_stub(),
            diagnostic_model=diagnostic_model_stub(),
            operator=sessions,
        )

    settings = Settings(runtime_paths=paths, _env_file=None)  # pyright: ignore[reportCallIssue]
    app = create_app(settings=settings, runtime_context_factory=context)
    try:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                base_url=ORIGIN,
            ) as client,
        ):
            yield client, sessions, clock
        async with database.session_factory() as stored:
            rows = (await stored.scalars(select(OperatorSessionRow))).all()
            assert all(len(row.token_hash) == 64 for row in rows)
            assert all(row.operator_ref == "sandbox-operator" for row in rows)
    finally:
        await sessions.close()
        await database.dispose()


@pytest.mark.asyncio
async def test_login_cookie_csrf_logout_and_private_boundary(
    tmp_path: Path, credential: tuple[str, str], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    password, encoded = credential
    async with boundary(tmp_path, encoded) as (client, _sessions, _clock):
        for path in (
            "/api/v1/incidents",
            "/api/v1/scenarios",
            "/api/v1/monitoring/health",
        ):
            assert (await client.get(path)).status_code == 401
        response = await client.post(
            "/api/v1/operator/login",
            json={"password": password},
            headers={"Origin": ORIGIN},
        )
        assert response.status_code == 200
        cookie = response.headers["set-cookie"]
        for attribute in (
            "HttpOnly",
            "Secure",
            "SameSite=strict",
            "Path=/",
            "Max-Age=1800",
        ):
            assert attribute in cookie
        assert "Domain=" not in cookie
        assert response.headers["cache-control"] == "no-store"
        assert password not in response.text and encoded not in response.text
        session = response.json()
        assert (await client.get("/api/v1/operator/session")).json() == session
        assert (
            await client.post("/api/v1/operator/logout", headers={"Origin": ORIGIN})
        ).status_code == 403
        assert (
            await client.post(
                "/api/v1/operator/logout",
                headers={
                    "Origin": "https://other.example",
                    "X-CSRF-Token": session["csrfToken"],
                },
            )
        ).status_code == 403
        token = client.cookies.get(SESSION_COOKIE)
        assert token is not None
        # Check persisted SQLite bytes, not a test-only repository projection.
        stored_files = list((tmp_path / "operator-test").glob("incidents.sqlite3*"))
        assert stored_files
        for stored_file in stored_files:
            stored = stored_file.read_bytes()
            assert token.encode() not in stored
            assert password.encode() not in stored
            assert encoded.encode() not in stored
            assert session["csrfToken"].encode() not in stored
        assert (
            await client.get(
                "/api/v1/operator/session",
                headers={
                    "Cookie": f"{SESSION_COOKIE}={token}; {SESSION_COOKIE}={token}"
                },
            )
        ).status_code == 401
        assert (
            await client.post(
                "/api/v1/operator/logout",
                headers={"Origin": ORIGIN, "X-CSRF-Token": session["csrfToken"]},
            )
        ).status_code == 204
        assert (
            await client.get(
                "/api/v1/operator/session",
                headers={"Cookie": f"{SESSION_COOKIE}={token}"},
            )
        ).status_code == 401
        for sensitive in (password, encoded, token, session["csrfToken"]):
            assert sensitive not in caplog.text


@pytest.mark.asyncio
async def test_sliding_session_requires_csrf_and_cannot_resurrect(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    password, encoded = credential
    async with boundary(tmp_path, encoded) as (client, sessions, clock):
        response = await client.post(
            "/api/v1/operator/login",
            json={"password": password},
            headers={"Origin": ORIGIN},
        )
        initial = response.json()
        token = client.cookies.get(SESSION_COOKIE)
        assert token is not None
        principal = await sessions.authenticate([f"{SESSION_COOKIE}={token}"])

        async def source() -> AsyncGenerator[bytes]:
            while True:
                yield b": keepalive\n\n"

        stream = sessions.stream(principal, source())
        headers = {"Origin": ORIGIN, "X-CSRF-Token": initial["csrfToken"]}
        for _ in range(20):
            clock[0] += 1700
            read = await client.get("/api/v1/operator/session")
            assert read.json()["expiresAt"] < int(clock[0]) + 1800
            assert "set-cookie" not in read.headers
            for rejected in (
                {},
                {"Origin": ORIGIN},
                {**headers, "Origin": "https://other.test"},
            ):
                assert (
                    await client.post("/api/v1/operator/session", headers=rejected)
                ).status_code == 403
            renewed = await client.post("/api/v1/operator/session", headers=headers)
            assert renewed.status_code == 200
            assert renewed.json() == {**initial, "expiresAt": int(clock[0]) + 1800}
            assert "Max-Age=1800" in renewed.headers["set-cookie"]
            assert client.cookies.get(SESSION_COOKIE) == token
            assert token not in renewed.text
            assert await anext(stream) == b": keepalive\n\n"
        # A principal authenticated before a competing logout cannot revive it.
        await sessions.logout(principal)
        with pytest.raises(StopAsyncIteration):
            await anext(stream)
        with pytest.raises(OperatorAuthenticationError):
            await sessions.renew(principal)
        assert (
            await client.post("/api/v1/operator/session", headers=headers)
        ).status_code == 401
        await client.post(
            "/api/v1/operator/login",
            json={"password": password},
            headers={"Origin": ORIGIN},
        )
        token = client.cookies.get(SESSION_COOKIE)
        principal = await sessions.authenticate([f"{SESSION_COOKIE}={token}"])
        clock[0] += 1800
        with pytest.raises(OperatorAuthenticationError):
            await sessions.renew(principal)
        assert (await client.get("/api/v1/operator/session")).status_code == 401


@pytest.mark.asyncio
async def test_renewal_waiting_for_a_write_lock_cannot_cross_expiry(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    password, encoded = credential
    async with boundary(tmp_path, encoded) as (client, _sessions, clock):
        logged_in = await client.post(
            "/api/v1/operator/login",
            json={"password": password},
            headers={"Origin": ORIGIN},
        )
        expires = logged_in.json()["expiresAt"]
        database_path = tmp_path / "operator-test" / "incidents.sqlite3"
        write_attempted = asyncio.Event()

        def observe_write(
            connection: Connection,
            _cursor: object,
            statement: str,
            _parameters: object,
            _context: object,
            _executemany: bool,
        ) -> None:
            if connection.engine.url.database == str(
                database_path
            ) and statement.upper().startswith(("UPDATE", "BEGIN IMMEDIATE")):
                write_attempted.set()

        event.listen(Engine, "before_cursor_execute", observe_write)
        try:
            with closing(sqlite3.connect(database_path)) as blocker:
                blocker.execute("BEGIN IMMEDIATE")
                clock[0] = expires - 1
                pending = asyncio.create_task(
                    client.post(
                        "/api/v1/operator/session",
                        headers={
                            "Origin": ORIGIN,
                            "X-CSRF-Token": logged_in.json()["csrfToken"],
                        },
                    )
                )
                try:
                    await asyncio.wait_for(write_attempted.wait(), 2)
                    assert not pending.done()
                    clock[0] = expires + 1
                finally:
                    blocker.rollback()
                    result = await asyncio.wait_for(pending, 2)
                assert result.status_code == 401
                assert "set-cookie" not in result.headers
                assert (
                    blocker.execute(
                        "SELECT expires_at FROM operator_sessions"
                    ).fetchone()[0]
                    == expires
                )
            assert (await client.get("/api/v1/operator/session")).status_code == 401
        finally:
            event.remove(Engine, "before_cursor_execute", observe_write)


@pytest.mark.asyncio
async def test_login_rejects_untrusted_inputs_and_has_bounded_attempts(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    password, encoded = credential
    async with boundary(tmp_path, encoded) as (client, _sessions, _clock):
        assert (
            await client.post("/api/v1/operator/login", json={"password": password})
        ).status_code == 403
        assert (
            await client.post(
                "/api/v1/operator/login",
                json={"password": password},
                headers=[("Origin", ORIGIN), ("Origin", ORIGIN)],
            )
        ).status_code == 403
        for payload in (
            {"password": "x" * 9000},
            {"password": "密" * 500},
            {"password": password, "actor": "admin"},
        ):
            response = await client.post(
                "/api/v1/operator/login", json=payload, headers={"Origin": ORIGIN}
            )
            assert response.status_code == 422
            assert password not in response.text
        for _ in range(5):
            response = await client.post(
                "/api/v1/operator/login",
                json={"password": "incorrect"},
                headers={"Origin": ORIGIN},
            )
            assert response.status_code == 401
        assert (
            await client.post(
                "/api/v1/operator/login",
                json={"password": password},
                headers={"Origin": ORIGIN},
            )
        ).status_code == 429


@pytest.mark.asyncio
async def test_expiry_restart_and_stream_revocation(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    password, encoded = credential
    async with boundary(tmp_path, encoded) as (client, sessions, clock):
        response = await client.post(
            "/api/v1/operator/login",
            json={"password": password},
            headers={"Origin": ORIGIN},
        )
        assert response.status_code == 200
        token = client.cookies.get(SESSION_COOKIE)
        principal = await sessions.authenticate([f"{SESSION_COOKIE}={token}"])
        closed = asyncio.Event()

        async def source() -> AsyncGenerator[bytes]:
            try:
                yield b": first\n\n"
                await asyncio.Event().wait()
            finally:
                closed.set()

        stream = sessions.stream(principal, source())
        assert await anext(stream) == b": first\n\n"
        pending = asyncio.ensure_future(anext(stream))
        await asyncio.sleep(0)
        await sessions.logout(principal)
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(pending, 2)
        assert closed.is_set()
        assert (await client.get("/api/v1/operator/session")).status_code == 401
        await client.post(
            "/api/v1/operator/login",
            json={"password": password},
            headers={"Origin": ORIGIN},
        )
        clock[0] += 1800
        assert (await client.get("/api/v1/operator/session")).status_code == 401
        await client.post(
            "/api/v1/operator/login",
            json={"password": password},
            headers={"Origin": ORIGIN},
        )
        await sessions.close()
        await sessions.start()
        assert (await client.get("/api/v1/operator/session")).status_code == 401


def test_verifier_rejects_cost_escalation_before_native_verification(
    credential: tuple[str, str],
) -> None:
    _, encoded = credential
    with pytest.raises(OperatorCredentialUnavailableError):
        PasswordVerifier(encoded.replace("m=65536", "m=2147483647"))
    with pytest.raises(OperatorCredentialUnavailableError):
        PasswordVerifier(encoded.replace("argon2id", "argon2i"))


@pytest.mark.parametrize(
    "origin",
    [
        "http://remote.test",
        "https://console.example.test/path",
        "https://console.example.test/",
        "https://user:pass@console.example.test",
        "null",
        "https://console.example.test?x=1",
    ],
)
def test_origin_rejects_ambiguous_or_unencrypted_remote_sources(origin: str) -> None:
    with pytest.raises(ValidationError):
        Settings(operator_origin=origin, _env_file=None)  # pyright: ignore[reportCallIssue]


def test_verifier_accepts_projected_mount_but_rejects_escape_and_nonregular_files(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    password, encoded = credential
    mount = tmp_path / "mount"
    projection = mount / "..projection"
    projection.mkdir(parents=True)
    (projection / "verifier").write_text(encoded)
    target = mount / "verifier"
    target.symlink_to(projection / "verifier")
    assert PasswordVerifier.from_file(target).matches(password.encode())
    outside = tmp_path / "outside"
    outside.write_text(encoded)
    escape = mount / "escape"
    escape.symlink_to(outside)
    fifo = mount / "fifo"
    os.mkfifo(fifo)
    for invalid in [escape, fifo, mount, mount / "missing"]:
        with pytest.raises(OperatorCredentialUnavailableError) as failure:
            PasswordVerifier.from_file(invalid)
        assert str(failure.value) == "Operator credential is unavailable"


async def test_cancelled_login_keeps_hash_slot_until_native_work_finishes(
    tmp_path: Path, credential: tuple[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    password, encoded = credential
    entered, release, completed = asyncio.Event(), asyncio.Event(), asyncio.Event()
    original = PasswordVerifier.check

    async def paused(self: PasswordVerifier, candidate: bytes) -> bool:
        entered.set()
        await release.wait()
        try:
            return await original(self, candidate)
        finally:
            completed.set()

    monkeypatch.setattr(PasswordVerifier, "check", paused)
    async with boundary(tmp_path, encoded) as (client, _sessions, _clock):

        async def login() -> httpx.Response:
            return await client.post(
                "/api/v1/operator/login",
                json={"password": password},
                headers={"Origin": ORIGIN},
            )

        pending = asyncio.create_task(login())
        await asyncio.wait_for(entered.wait(), 2)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        assert (await login()).status_code == 429
        release.set()
        await asyncio.wait_for(completed.wait(), 2)
        assert (await login()).status_code == 200
