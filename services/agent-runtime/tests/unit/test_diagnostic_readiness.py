import asyncio
from collections.abc import AsyncGenerator
from contextlib import aclosing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast
from uuid import UUID

import httpx
import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import func, select
from tests.factories import normalized_trigger
from tests.unit.application.test_alerts import alert_payload, watchdog_payload
from tests.unit.test_lifespan import install_runtime_fakes

from k8s_incident_agent import api
from k8s_incident_agent.config import Settings
from k8s_incident_agent.diagnosis.prompt import DIAGNOSTIC_PROMPT_VERSION
from k8s_incident_agent.domain.models import (
    DiagnosisWorkflowRunSnapshot,
    ModelSnapshot,
    RunBudget,
    TerminalRecord,
)
from k8s_incident_agent.kubernetes.credentials import DiagnosticCredential
from k8s_incident_agent.model import availability
from k8s_incident_agent.model.discovery import discover_models
from k8s_incident_agent.monitoring.auth import AlertmanagerWebhookAuthenticator
from k8s_incident_agent.persistence.database import (
    create_business_database,
    require_alembic_head,
)
from k8s_incident_agent.persistence.models import RunRow
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.runtime.lock import RuntimeLock
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT, RuntimePaths
from k8s_incident_agent.workflow.checkpoint import open_checkpoint_store


@pytest.mark.parametrize(
    ("provider_status", "malformed_encoding", "expected_reason"),
    [
        (None, False, "configuration_invalid"),
        (401, False, "authentication_failed"),
        (503, False, "provider_unavailable"),
        (200, False, "model_not_found"),
        (200, True, "provider_contract_invalid"),
    ],
)
async def test_degraded_startup_keeps_persisted_history_sse_and_watchdog_available(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    provider_status: int | None,
    malformed_encoding: bool,
    expected_reason: str,
) -> None:
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    config = Config(str(REPOSITORY_ROOT / "services/agent-runtime/alembic.ini"))
    config.attributes["runtime_paths"] = paths
    command.upgrade(config, "head")
    snapshot = ModelSnapshot(
        provider="deepseek",
        model_id="deepseek-flash",
        thinking_mode=False,
        prompt_version=DIAGNOSTIC_PROMPT_VERSION,
    )
    budget = RunBudget(max_model_calls=8, max_tool_calls=6, timeout_seconds=180)
    database = await create_business_database(paths)
    repository = IncidentRepository(database.session_factory)
    created = await repository.create_incident_and_run(
        normalized_trigger(), snapshot, budget
    )
    await repository.persist_terminal(
        TerminalRecord(
            run_id=created.run_id,
            completed_at=datetime.now(UTC),
            outcome=None,
            summary=None,
            root_causes=(),
            missing_information=(),
            redacted=False,
            error_code="agent_timeout",
            error_retryable=True,
            model_calls=None,
            tool_calls=None,
            input_tokens=None,
            output_tokens=None,
        )
    )
    await database.dispose()

    client_class = httpx.AsyncClient
    events: list[str] = []
    install_runtime_fakes(monkeypatch, events)
    monkeypatch.setattr(api, "RuntimeLock", RuntimeLock)
    monkeypatch.setattr(api, "create_business_database", create_business_database)
    monkeypatch.setattr(api, "require_alembic_head", require_alembic_head)
    monkeypatch.setattr(api, "open_checkpoint_store", open_checkpoint_store)
    monkeypatch.setattr(
        api, "AlertmanagerWebhookAuthenticator", AlertmanagerWebhookAuthenticator
    )

    def credential(_paths: RuntimePaths, now: datetime) -> DiagnosticCredential:
        return DiagnosticCredential(
            kubeconfig_path=tmp_path / "unused",
            context_name="kind-k8s-incident-agent",
            server_url="https://127.0.0.1:6443",
            expires_at=now + timedelta(hours=1),
            _kubeconfig={},
        )

    monkeypatch.setattr(api, "load_diagnostic_credential", credential)
    monkeypatch.setattr(availability, "_RECHECK_INTERVAL_SECONDS", 0.01)
    recovered = False

    def provider(_request: httpx.Request) -> httpx.Response:
        if malformed_encoding and not recovered:
            return httpx.Response(
                200,
                headers={"Content-Encoding": "gzip"},
                stream=httpx.ByteStream(b"malformed upstream gzip"),
            )
        return httpx.Response(
            200 if recovered else provider_status or 500,
            json={"data": [{"id": "deepseek-flash" if recovered else "not-selected"}]},
        )

    async with client_class(transport=httpx.MockTransport(provider)) as model_http:

        async def discovery(settings: Settings, **_kwargs: object) -> tuple[str, ...]:
            return await discover_models(settings, client=model_http)

        monkeypatch.setattr(api, "discover_models", discovery)
        credential_file = tmp_path / "test-webhook-token"
        credential_file.write_bytes(b"a" * 32)
        settings = Settings(
            _env_file=None,  # pyright: ignore[reportCallIssue]
            RUNTIME_DATA_DIR=paths,  # pyright: ignore[reportCallIssue]
            deepseek_api_key="test-key" if provider_status is not None else None,
            alertmanager_webhook_token_file=credential_file,
            scenario_catalog_dir=REPOSITORY_ROOT / "scenarios",
        )
        assert settings.runtime_paths == paths
        app = api.create_app(settings=settings)
        async with (
            app.router.lifespan_context(app),
            client_class(
                transport=httpx.ASGITransport(app=app), base_url="http://runtime.test"
            ) as client,
        ):
            assert app.state.ready is True
            health = await client.get("/healthz")
            assert health.status_code == 200
            assert health.json() == {
                "status": "ok",
                "diagnosis": {
                    "status": "unavailable",
                    "reason": expected_reason,
                },
            }
            detail_url = f"/api/v1/incidents/{created.incident_id}"
            old_detail = await client.get(detail_url)
            assert old_detail.status_code == 200
            assert old_detail.json()["selectedRun"]["id"] == str(created.run_id)
            container = cast(api.RuntimeContainer, app.state.container)
            stream = cast(
                AsyncGenerator[bytes],
                await container.events.open_stream(created.incident_id, "0"),
            )
            async with aclosing(stream), asyncio.timeout(1):
                async for frame in stream:
                    if b"event: run.failed" in frame:
                        break
                else:
                    pytest.fail(
                        "Persisted failure must remain available for SSE replay"
                    )

            for url, body in [
                ("/api/v1/incidents", {"scenarioId": "image-pull-backoff"}),
                (f"{detail_url}/runs", None),
            ]:
                response = (
                    await client.post(url, json=body)
                    if body
                    else await client.post(url)
                )
                assert response.status_code == 503
                assert response.json()["error"] == {
                    "code": "diagnosis_unavailable",
                    "message": "Model diagnosis is unavailable.",
                    "retryable": True,
                }
            webhook_url = "/api/v1/alerts/alertmanager"
            headers = {
                "Authorization": f"Bearer {'a' * 32}",
                "Content-Type": "application/json",
            }
            firing = await client.post(
                webhook_url, headers=headers, content=alert_payload()
            )
            assert firing.status_code == 503
            assert firing.json()["error"]["code"] == "diagnosis_unavailable"
            watchdog = await client.post(
                webhook_url, headers=headers, content=watchdog_payload()
            )
            assert watchdog.status_code == 204
            assert (await client.get(detail_url)).json() == old_detail.json()
            database = await create_business_database(paths)
            try:
                repository = IncidentRepository(database.session_factory)
                assert await repository.get_watchdog_last_received_at() is not None
                async with database.session_factory() as session:
                    assert (
                        await session.scalar(select(func.count()).select_from(RunRow))
                        == 1
                    )
                if provider_status is not None:
                    recovered = True
                    async with asyncio.timeout(1):
                        while (await client.get("/healthz")).json()["diagnosis"][
                            "status"
                        ] != "ready":
                            await asyncio.sleep(0.001)
                    for _ in range(2):
                        assert (
                            await client.post(
                                webhook_url, headers=headers, content=alert_payload()
                            )
                        ).status_code == 204
                    async with database.session_factory() as session:
                        assert (
                            await session.scalar(
                                select(func.count()).select_from(RunRow)
                            )
                            == 2
                        )
                        new_run = await session.scalar(
                            select(RunRow).where(RunRow.id != str(created.run_id))
                        )
                        assert new_run is not None
                        persisted = await repository.get_workflow_run_snapshot(
                            UUID(new_run.id)
                        )
                        assert isinstance(persisted, DiagnosisWorkflowRunSnapshot)
                        assert persisted.model == snapshot
            finally:
                await database.dispose()
        assert app.state.ready is False


async def test_health_never_reports_ready_outside_core_lifespan(tmp_path: Path) -> None:
    app = api.create_app(
        settings=Settings(
            _env_file=None,  # pyright: ignore[reportCallIssue]
            RUNTIME_DATA_DIR=RuntimePaths.prepare(tmp_path / "runtime"),  # pyright: ignore[reportCallIssue]
        )
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://runtime.test"
    ) as client:
        response = await client.get("/healthz")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "runtime_not_ready"
