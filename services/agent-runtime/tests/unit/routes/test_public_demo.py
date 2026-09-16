import asyncio
from collections.abc import AsyncGenerator
from contextlib import AsyncExitStack
from datetime import timedelta
from pathlib import Path
from typing import cast
from uuid import UUID

import httpx
import pytest
from pydantic import ValidationError
from sqlalchemy import func, select, update
from starlette.types import Message, Scope
from tests.factories import normalized_trigger
from tests.unit.persistence.test_repair_persistence import BUDGET, MODEL
from tests.unit.repair.test_repair_preparation import KubernetesFixture
from tests.unit.routes.test_approvals import ORIGIN, ApprovalHarness, approval_harness
from tests.unit.routes.test_operator import credential as credential
from tests.unit.workflow.test_repair_preparation import dependencies

from k8s_incident_agent.auth.public_demo import PublicDemoLimitedError
from k8s_incident_agent.auth.sessions import SESSION_COOKIE, OperatorAuthenticationError
from k8s_incident_agent.config import Settings
from k8s_incident_agent.domain.models import RepairWorkflowRunSnapshot
from k8s_incident_agent.persistence.models import (
    ApprovalRow,
    ExecutionRow,
    IncidentRow,
    OperatorSessionRow,
    PublicDemoBudgetRow,
    RunEventRow,
    RunRow,
)
from k8s_incident_agent.workflow.graph import build_incident_graph


def visitor(harness: ApprovalHarness) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=harness.app, raise_app_exceptions=False),
        base_url=ORIGIN,
    )


def test_public_mode_requires_explicit_entire_instance_data_approval() -> None:
    assert Settings(_env_file=None).console_access_mode == "private"  # pyright: ignore[reportCallIssue]
    with pytest.raises(
        ValidationError, match="approval of retained and continuing data"
    ):
        Settings(console_access_mode="public_demo", _env_file=None)  # pyright: ignore[reportCallIssue]


@pytest.mark.parametrize("public_demo", [False, True])
@pytest.mark.parametrize(
    "identity", ["anonymous", "expired_operator", "old_guest_cookie"]
)
async def test_all_manual_mutations_require_operator_without_business_effects(
    tmp_path: Path, credential: tuple[str, str], public_demo: bool, identity: str
) -> None:
    async with (
        approval_harness(tmp_path, credential, public_demo=public_demo) as harness,
        visitor(harness) as client,
    ):
        request_headers = {"Origin": ORIGIN}
        if identity == "expired_operator":
            request_headers["Cookie"] = (
                f"{SESSION_COOKIE}={harness.client.cookies.get(SESSION_COOKIE)}"
            )
            harness.clock[0] += timedelta(hours=1)
        elif identity == "old_guest_cookie":
            request_headers["Cookie"] = "__Host-k8s-incident-guest=" + "g" * 43
        tables = (IncidentRow, RunRow, RunEventRow, ApprovalRow, ExecutionRow)
        async with harness.database.session_factory() as database:
            before = [
                await database.scalar(select(func.count()).select_from(table))
                for table in tables
            ]
        path = f"/api/v1/incidents/{harness.incident_id}"
        for endpoint, body in (
            ("/api/v1/incidents", {"scenarioId": "imagepullbackoff"}),
            (f"{path}/runs", {}),
            (f"{path}/runs", {"replacesRunId": str(harness.run_id)}),
            (f"{path}/repair-runs", {"sourceRunId": str(harness.run_id)}),
            (
                f"{path}/repair-runs",
                {
                    "sourceRunId": str(harness.run_id),
                    "replacesRunId": str(harness.run_id),
                },
            ),
            (
                f"{path}/repair-runs",
                {
                    "sourceRunId": str(harness.run_id),
                    "sourceExecutionId": str(harness.run_id),
                },
            ),
            (
                f"{path}/repair-runs",
                {
                    "sourceRunId": str(harness.run_id),
                    "replacesRunId": str(harness.run_id),
                    "selection": {
                        "revision": "1",
                        "replicaSetUid": str(harness.run_id),
                    },
                },
            ),
            (f"{path}/withdrawals", {"runId": str(harness.run_id)}),
            (harness.path, harness.body),
            (harness.path, {**harness.body, "decision": "reject"}),
            ("/api/v1/operator/session", {}),
            ("/api/v1/operator/logout", {}),
        ):
            response = await client.post(endpoint, json=body, headers=request_headers)
            assert response.status_code == 401, (endpoint, response.text)
            assert (
                response.json()["error"]["code"] == "operator_authentication_required"
            )
            assert "set-cookie" not in response.headers
        async with harness.database.session_factory() as database:
            after = [
                await database.scalar(select(func.count()).select_from(table))
                for table in tables
            ]
        assert after == before
        run = await harness.repository.get_workflow_run_snapshot(harness.run_id)
        assert run is not None and run.run_status.value == "WAITING_APPROVAL"


@pytest.mark.parametrize("invalidated", ["expired", "revoked"])
async def test_session_rechecked_inside_every_manual_creation_transaction(
    tmp_path: Path, credential: tuple[str, str], invalidated: str
) -> None:
    async with approval_harness(tmp_path, credential, public_demo=True) as harness:
        principal = await harness.sessions.authenticate(
            [f"{SESSION_COOKIE}={harness.client.cookies.get(SESSION_COOKIE)}"]
        )
        if invalidated == "expired":
            harness.clock[0] += timedelta(hours=1)
        else:
            async with harness.database.session_factory.begin() as database:
                await database.execute(update(OperatorSessionRow).values(revoked=True))
        repo = harness.repository
        with pytest.raises(OperatorAuthenticationError):
            await repo.create_incident_and_run(
                normalized_trigger(), MODEL, BUDGET, requester=principal
            )
        with pytest.raises(OperatorAuthenticationError):
            await repo.create_run(
                harness.incident_id,
                MODEL,
                BUDGET,
                replaces_run_id=harness.run_id,
                requester=principal,
            )
        with pytest.raises(OperatorAuthenticationError):
            await repo.create_repair_run(
                harness.incident_id,
                harness.run_id,
                selection=None,
                replaces_run_id=harness.run_id,
                operator_ref=principal.operator_ref,
                now=harness.now(),
                requester=principal,
            )
        with pytest.raises(OperatorAuthenticationError):
            await repo.withdraw_run(harness.incident_id, harness.run_id, principal)
        saved = await repo.get_workflow_run_snapshot(harness.run_id)
        assert saved is not None and saved.run_status.value == "WAITING_APPROVAL"
        async with harness.database.session_factory() as database:
            assert (
                await database.scalar(select(func.count()).select_from(ExecutionRow))
                == 0
            )


@pytest.mark.parametrize("compete", [False, True])
async def test_operator_withdrawal_and_approval_cannot_both_commit(
    tmp_path: Path, credential: tuple[str, str], compete: bool
) -> None:
    async with approval_harness(tmp_path, credential, public_demo=True) as harness:
        path = f"/api/v1/incidents/{harness.incident_id}/withdrawals"
        approval = harness.client.post(
            harness.path, headers=harness.headers, json=harness.body
        )
        withdrawal = harness.client.post(
            path, headers=harness.headers, json={"runId": str(harness.run_id)}
        )
        if compete:
            approved, withdrawn = await asyncio.gather(approval, withdrawal)
            assert (approved.status_code, withdrawn.status_code) in {
                (200, 409),
                (409, 204),
            }
        else:
            approved = await approval
            assert approved.status_code == 200
            assert (await withdrawal).status_code == 409
        async with harness.database.session_factory() as database:
            assert await database.scalar(
                select(func.count()).select_from(ExecutionRow)
            ) == (1 if approved.status_code == 200 else 0)
            assert await database.scalar(
                select(func.count()).select_from(ApprovalRow)
            ) == (1 if approved.status_code == 200 else 0)


async def test_public_reads_are_anonymous_and_actions_require_login(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with (
        approval_harness(tmp_path, credential, public_demo=True) as harness,
        visitor(harness) as client,
    ):
        path = f"/api/v1/incidents/{harness.incident_id}"
        for endpoint in (
            "/api/v1/incidents",
            path,
            f"{path}/runs",
            f"{path}/runs/{harness.run_id}/events",
            "/api/v1/operator/session",
        ):
            response = await client.get(endpoint)
            assert response.status_code == 200, (endpoint, response.text)
            assert "set-cookie" not in response.headers
            assert response.headers["cache-control"] == "no-store"
        assert response.json() == {
            "accessMode": "public_demo",
            "role": "anonymous",
            "expiresAt": None,
            "csrfToken": None,
        }
        detail = (await client.get(path)).json()
        assert detail["selectedRun"]["initiatedByYou"] is False
        assert detail["repair"] is not None
        for name in (
            "prepare",
            "refresh",
            "edit",
            "approve",
            "reject",
            "rerun",
            "rollback",
            "withdraw",
        ):
            assert detail["actions"][name] in (
                "authentication_required",
                "not_applicable",
            )
        assert (await client.get(f"{path}/runs?mine=true")).json()["items"] == []
        assert (
            await client.post(
                path + "/repair-runs",
                content=b"x" * 8193,
                headers={"Content-Type": "application/json", "Origin": ORIGIN},
            )
        ).status_code == 422


async def test_operator_owns_preparation_and_can_withdraw_in_public_mode(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential, public_demo=True) as harness:
        response = await harness.client.post(
            harness.path,
            json={**harness.body, "decision": "reject"},
            headers=harness.headers,
        )
        assert response.status_code == 200
        path = f"/api/v1/incidents/{harness.incident_id}"
        response = await harness.client.post(
            path + "/repair-runs",
            json={"sourceRunId": str(harness.run_id)},
            headers=harness.headers,
        )
        assert response.status_code == 202, response.text
        run_id = response.json()["runId"]
        run = await harness.repository.get_workflow_run_snapshot(UUID(run_id))
        assert isinstance(run, RepairWorkflowRunSnapshot)
        graph = build_incident_graph(
            dependencies(
                harness.repository, harness.saver, KubernetesFixture(), harness.now
            ),
            run,
        )
        await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            {"run_id": run_id},
            {"configurable": {"thread_id": run_id}},
            durability="sync",
        )
        detail = (await harness.client.get(path)).json()
        assert detail["selectedRun"]["requestSource"] == "operator"
        assert detail["selectedRun"]["initiatedByYou"] is True
        assert detail["actions"]["withdraw"] is None
        mine = (await harness.client.get(path + "/runs?mine=true")).json()["items"]
        assert [item["id"] for item in mine] == [run_id, str(harness.run_id)]
        response = await harness.client.post(
            path + "/withdrawals", json={"runId": run_id}, headers=harness.headers
        )
        assert response.status_code == 204
        final = (await harness.client.get(path)).json()
        assert final["selectedRun"]["status"] == "COMPLETED"
    assert final["selectedRun"]["endReason"] == "withdrawn"


@pytest.mark.parametrize("capacity", ["rate", "concurrent_reads"])
async def test_anonymous_mutations_require_login_even_when_public_reads_are_full(
    tmp_path: Path, credential: tuple[str, str], capacity: str
) -> None:
    async with (
        approval_harness(tmp_path, credential, public_demo=True) as harness,
        visitor(harness) as client,
        AsyncExitStack() as stack,
    ):
        if capacity == "rate":
            async with harness.database.session_factory.begin() as database:
                database.add(
                    PublicDemoBudgetRow(
                        category="reads",
                        used=600,
                        window_started_at=int(harness.now().timestamp()),
                    )
                )
            expected_reads = 600
        else:
            for _ in range(8):
                await stack.enter_async_context(harness.sessions.access.reading(None))
            expected_reads = 8
        path = f"/api/v1/incidents/{harness.incident_id}"
        assert (await client.get(path)).status_code == 429
        tables = (IncidentRow, RunRow, RunEventRow, ApprovalRow, ExecutionRow)
        async with harness.database.session_factory() as database:
            before = [
                await database.scalar(select(func.count()).select_from(table))
                for table in tables
            ]
        for endpoint, body in (
            ("/api/v1/incidents", {"scenarioId": "imagepullbackoff"}),
            (path + "/runs", {"replacesRunId": str(harness.run_id)}),
            (path + "/repair-runs", {"sourceRunId": str(harness.run_id)}),
            (path + "/withdrawals", {"runId": str(harness.run_id)}),
            (harness.path, harness.body),
        ):
            denied = await client.post(endpoint, json=body, headers={"Origin": ORIGIN})
            assert denied.status_code == 401
            assert denied.json()["error"]["code"] == "operator_authentication_required"
        async with harness.database.session_factory() as database:
            after = [
                await database.scalar(select(func.count()).select_from(table))
                for table in tables
            ]
            counter = await database.get(PublicDemoBudgetRow, "reads")
            assert counter is not None and counter.used == expected_reads
        assert after == before


async def test_public_read_window_survives_restart(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential, public_demo=True) as harness:
        async with harness.database.session_factory.begin() as database:
            database.add(
                PublicDemoBudgetRow(
                    category="reads",
                    used=600,
                    window_started_at=int(harness.now().timestamp()),
                )
            )
        await harness.sessions.close()
        await harness.sessions.start()
        async with visitor(harness) as client:
            assert (await client.get("/api/v1/incidents")).status_code == 429
            harness.clock[0] += timedelta(seconds=60)
            assert (await client.get("/api/v1/incidents")).status_code == 200


async def test_public_read_stream_slots_leave_operator_capacity(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential, public_demo=True) as harness:
        access = harness.sessions.access
        operator = await harness.sessions.authenticate(
            [f"{SESSION_COOKIE}={harness.client.cookies.get(SESSION_COOKIE)}"]
        )
        async with AsyncExitStack() as stack:
            for _ in range(8):
                await stack.enter_async_context(access.reading(None))
            with pytest.raises(PublicDemoLimitedError):
                async with access.reading(None):
                    pytest.fail("anonymous read admitted beyond capacity")
            async with access.reading(operator):
                pass
            async with visitor(harness) as client:
                for path in ("/api/v1/operator/session", "/api/v1/incidents"):
                    response = await client.get(path)
                    assert response.status_code == 429
                    assert response.json()["error"]["code"] == "public_demo_limited"
                assert (
                    await harness.client.get("/api/v1/operator/session")
                ).status_code == 200
        async with access.reading(None):
            pass
        async with visitor(harness) as client:
            assert (await client.get("/api/v1/operator/session")).status_code == 200
        async with AsyncExitStack() as stack:
            for _ in range(16):
                await stack.enter_async_context(access.stream_slot(None))
            with pytest.raises(PublicDemoLimitedError):
                async with access.stream_slot(None):
                    pytest.fail("anonymous stream admitted beyond capacity")
            async with access.stream_slot(operator):
                pass
        async with access.stream_slot(None):
            pass


@pytest.mark.parametrize("end", ["deadline", "private"])
async def test_anonymous_stream_closes_at_deadline_or_private_mode(
    tmp_path: Path, credential: tuple[str, str], end: str
) -> None:
    async with approval_harness(tmp_path, credential, public_demo=True) as harness:
        access = harness.sessions.access
        closed = asyncio.Event()

        async def source() -> AsyncGenerator[bytes]:
            try:
                yield b": first\n\n"
                await asyncio.Event().wait()
            finally:
                closed.set()

        async with access.stream_slot(None):
            stream = access.open_stream(None, source())
            assert await anext(stream) == b": first\n\n"
            if end == "deadline":
                harness.clock[0] += timedelta(seconds=300)
            else:
                access.mode = "private"
            with pytest.raises(StopAsyncIteration):
                await anext(stream)
            assert closed.is_set()


async def test_real_public_sse_disconnect_releases_admission_before_the_next_request(
    tmp_path: Path, credential: tuple[str, str]
) -> None:
    async with approval_harness(tmp_path, credential, public_demo=True) as harness:
        access = harness.sessions.access
        path = f"/api/v1/incidents/{harness.incident_id}/events"
        scope = cast(
            Scope,
            {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.3"},
                "http_version": "1.1",
                "method": "GET",
                "scheme": "https",
                "path": path,
                "raw_path": path.encode(),
                "query_string": b"",
                "root_path": "",
                "headers": [
                    (b"host", b"console.example.test"),
                    (b"last-event-id", b"0"),
                ],
                "client": ("127.0.0.1", 12345),
                "server": ("console.example.test", 443),
            },
        )
        received: asyncio.Queue[Message] = asyncio.Queue()
        await received.put({"type": "http.request", "body": b"", "more_body": False})
        chunks: list[bytes] = []

        async def send(message: Message) -> None:
            if message["type"] == "http.response.start":
                assert message["status"] == 200
            elif message["type"] == "http.response.body" and message.get("body"):
                chunks.append(message["body"])
                await received.put({"type": "http.disconnect"})

        await asyncio.wait_for(harness.app(scope, received.get, send), 2)
        assert chunks and b"incident.created" in chunks[0]
        async with AsyncExitStack() as stack:
            for _ in range(16):
                await stack.enter_async_context(access.stream_slot(None))
            async with visitor(harness) as client:
                assert (await client.get(path)).status_code == 429
                assert (await client.get("/api/v1/incidents")).status_code == 200
