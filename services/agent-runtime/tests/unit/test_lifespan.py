from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast
from uuid import UUID

import pytest
from langchain_core.language_models import BaseChatModel

from k8s_incident_agent import api
from k8s_incident_agent.config import ConfigurationInvalidError, Settings
from k8s_incident_agent.kubernetes.credentials import (
    DiagnosticCredential,
    DiagnosticCredentialLease,
)
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT, RuntimePaths
from k8s_incident_agent.scenarios.contracts import (
    PublicScenario,
    ScenarioTarget,
    ScenarioTrigger,
)

NOW = datetime(2026, 8, 26, 9, 0, tzinfo=UTC)


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        deepseek_api_key="test-key",
        runtime_paths=RuntimePaths.prepare(tmp_path / "runtime"),
        scenario_catalog_dir=REPOSITORY_ROOT / "scenarios",
        _env_file=None,  # pyright: ignore[reportCallIssue]
    )


def _scenario() -> PublicScenario:
    return PublicScenario(
        scenario_id="image-pull-backoff",
        scenario_version=1,
        display_name="Image pull failure",
        description="A Deployment cannot pull its configured image.",
        trigger=ScenarioTrigger(
            type="manual",
            summary="The target Deployment is unavailable.",
        ),
        target=ScenarioTarget(
            cluster="k8s-incident-agent",
            namespace="k8s-incident-scenarios",
            api_version="apps/v1",
            kind="Deployment",
            name="image-pull-backoff",
        ),
    )


def _install_runtime_fakes(
    monkeypatch: pytest.MonkeyPatch,
    events: list[str],
    *,
    fail_at: str | None = None,
) -> None:
    def fail(stage: str) -> None:
        if fail_at == stage:
            raise RuntimeError(f"{stage} failed")

    class FakeLock:
        def __init__(self, _path: Path) -> None:
            pass

        def acquire(self) -> None:
            events.append("lock.acquire")
            fail("lock")

        def release(self) -> None:
            events.append("lock.release")

    class FakeDatabase:
        session_factory = object()

        async def dispose(self) -> None:
            events.append("database.close")

    class FakeKubernetesClients:
        cluster_id = "k8s-incident-agent"
        diagnostic_namespace = "k8s-incident-scenarios"

        async def close(self) -> None:
            events.append("kubernetes.close")

    class FakeSyncClient:
        def __init__(self) -> None:
            events.append("model.sync.open")

        def close(self) -> None:
            events.append("model.sync.close")

    class FakeAsyncClient:
        def __init__(self) -> None:
            events.append("model.async.open")

        async def aclose(self) -> None:
            events.append("model.async.close")

    class FakeSupervisor:
        def __init__(self, **_kwargs: object) -> None:
            events.append("supervisor.init")

        async def start(self) -> None:
            events.append("supervisor.start")
            fail("supervisor")

        async def close(self) -> None:
            events.append("supervisor.close")

        async def schedule(self, _run_id: UUID) -> None:
            pass

    async def discover(_settings: Settings) -> tuple[str, ...]:
        events.append("discovery")
        fail("discovery")
        return ("deepseek-v4-flash",)

    async def create_database(_paths: RuntimePaths) -> FakeDatabase:
        events.append("database.open")
        fail("database")
        return FakeDatabase()

    async def require_head(_database: object) -> None:
        events.append("database.head")
        fail("head")

    @asynccontextmanager
    async def checkpoint(_path: Path) -> AsyncGenerator[object]:
        events.append("checkpoint.open")
        fail("checkpoint")
        try:
            yield object()
        finally:
            events.append("checkpoint.close")

    def catalog(_path: Path) -> tuple[PublicScenario, ...]:
        events.append("catalog")
        fail("catalog")
        return (_scenario(),)

    def credential(_paths: RuntimePaths, _now: datetime) -> DiagnosticCredential:
        events.append("credential")
        fail("credential")
        return DiagnosticCredential(
            kubeconfig_path=Path("/unused/diagnostic.kubeconfig"),
            context_name="kind-k8s-incident-agent",
            server_url="https://127.0.0.1:6443",
            expires_at=NOW + timedelta(hours=1),
            _kubeconfig={},
        )

    def require_window(
        _credential: DiagnosticCredentialLease,
        required_seconds: float,
        _now: datetime,
    ) -> None:
        events.append(f"credential.window:{required_seconds:g}")
        fail("ttl")

    async def create_kubernetes(
        _credential: DiagnosticCredential,
        _timeout: float,
        *,
        cluster_id: str,
        diagnostic_namespace: str,
    ) -> FakeKubernetesClients:
        assert cluster_id == "k8s-incident-agent"
        assert diagnostic_namespace == "k8s-incident-scenarios"
        events.append("kubernetes.open")
        fail("kubernetes")
        return FakeKubernetesClients()

    async def create_incluster_kubernetes(
        _timeout: float,
        *,
        cluster_id: str,
        diagnostic_namespace: str,
    ) -> FakeKubernetesClients:
        assert cluster_id == "k8s-incident-agent"
        assert diagnostic_namespace == "k8s-incident-scenarios"
        events.append("kubernetes.incluster.open")
        fail("kubernetes")
        return FakeKubernetesClients()

    def target_scope(
        _target: ScenarioTarget,
        *,
        cluster_id: str,
        diagnostic_namespace: str,
    ) -> None:
        assert cluster_id == "k8s-incident-agent"
        assert diagnostic_namespace == "k8s-incident-scenarios"
        events.append("kubernetes.target-scope")
        fail("target-scope")

    async def access(_clients: object) -> None:
        events.append("kubernetes.access")
        fail("access")

    def create_model(*_args: object, **_kwargs: object) -> BaseChatModel:
        events.append("model.create")
        fail("model")
        return cast(BaseChatModel, object())

    def create_adapter(_clients: object) -> object:
        return object()

    monkeypatch.setattr(api, "RuntimeLock", FakeLock)
    monkeypatch.setattr(api, "discover_models", discover)
    monkeypatch.setattr(api, "create_business_database", create_database)
    monkeypatch.setattr(api, "require_alembic_head", require_head)
    monkeypatch.setattr(api, "open_checkpoint_store", checkpoint)
    monkeypatch.setattr(api, "load_scenario_catalog", catalog)
    monkeypatch.setattr(api, "load_diagnostic_credential", credential)
    monkeypatch.setattr(api, "require_credential_window", require_window)
    monkeypatch.setattr(api, "create_kubernetes_clients", create_kubernetes)
    monkeypatch.setattr(
        api,
        "create_incluster_kubernetes_clients",
        create_incluster_kubernetes,
    )
    monkeypatch.setattr(api, "require_stage_one_target_scope", target_scope)
    monkeypatch.setattr(api, "verify_stage_one_access", access)
    monkeypatch.setattr(api, "KubernetesEvidenceAdapter", create_adapter)
    monkeypatch.setattr(api.httpx, "Client", FakeSyncClient)
    monkeypatch.setattr(api.httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(api, "create_deepseek_model", create_model)
    monkeypatch.setattr(api, "RunSupervisor", FakeSupervisor)


@pytest.mark.asyncio
async def test_runtime_builds_in_order_and_closes_every_owned_resource_in_reverse(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    _install_runtime_fakes(monkeypatch, events)

    async with api.build_runtime_container(_settings(tmp_path)) as container:
        assert container.incidents is not None
        assert container.events is not None
        assert events == [
            "lock.acquire",
            "discovery",
            "database.open",
            "database.head",
            "checkpoint.open",
            "catalog",
            "credential",
            "credential.window:240",
            "kubernetes.open",
            "kubernetes.target-scope",
            "kubernetes.access",
            "model.sync.open",
            "model.async.open",
            "model.create",
            "supervisor.init",
            "supervisor.start",
        ]

    assert events[-7:-1] == [
        "supervisor.close",
        "model.async.close",
        "model.sync.close",
        "kubernetes.close",
        "checkpoint.close",
        "database.close",
    ]
    assert events[-1] == "lock.release"


@pytest.mark.asyncio
async def test_online_runtime_uses_incluster_source_without_loading_manual_catalog(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    _install_runtime_fakes(monkeypatch, events)
    settings = _settings(tmp_path).model_copy(
        update={
            "incident_intake_mode": "online",
            "kubernetes_credential_mode": "in_cluster",
        }
    )

    async with api.build_runtime_container(settings):
        assert events == [
            "lock.acquire",
            "discovery",
            "database.open",
            "database.head",
            "checkpoint.open",
            "kubernetes.incluster.open",
            "kubernetes.access",
            "model.sync.open",
            "model.async.open",
            "model.create",
            "supervisor.init",
            "supervisor.start",
        ]

    assert "catalog" not in events
    assert "credential" not in events
    assert not any(event.startswith("credential.window:") for event in events)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("fail_at", "cleanup"),
    [
        ("discovery", ["lock.release"]),
        ("database", ["lock.release"]),
        ("head", ["database.close", "lock.release"]),
        ("checkpoint", ["database.close", "lock.release"]),
        ("catalog", ["checkpoint.close", "database.close", "lock.release"]),
        (
            "credential",
            ["checkpoint.close", "database.close", "lock.release"],
        ),
        ("ttl", ["checkpoint.close", "database.close", "lock.release"]),
        (
            "kubernetes",
            ["checkpoint.close", "database.close", "lock.release"],
        ),
        (
            "access",
            [
                "kubernetes.close",
                "checkpoint.close",
                "database.close",
                "lock.release",
            ],
        ),
        (
            "target-scope",
            [
                "kubernetes.close",
                "checkpoint.close",
                "database.close",
                "lock.release",
            ],
        ),
        (
            "model",
            [
                "model.async.close",
                "model.sync.close",
                "kubernetes.close",
                "checkpoint.close",
                "database.close",
                "lock.release",
            ],
        ),
        (
            "supervisor",
            [
                "supervisor.close",
                "model.async.close",
                "model.sync.close",
                "kubernetes.close",
                "checkpoint.close",
                "database.close",
                "lock.release",
            ],
        ),
    ],
)
async def test_startup_failure_closes_only_initialized_resources_in_reverse(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fail_at: str,
    cleanup: list[str],
) -> None:
    events: list[str] = []
    _install_runtime_fakes(monkeypatch, events, fail_at=fail_at)

    with pytest.raises(RuntimeError, match=f"{fail_at} failed"):
        async with api.build_runtime_container(_settings(tmp_path)):
            pass

    assert events[-len(cleanup) :] == cleanup


@pytest.mark.asyncio
async def test_missing_model_key_releases_lock_before_any_outbound_step(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    _install_runtime_fakes(monkeypatch, events)
    settings = _settings(tmp_path).model_copy(update={"deepseek_api_key": None})

    with pytest.raises(ConfigurationInvalidError):
        async with api.build_runtime_container(settings):
            pass

    assert events == ["lock.acquire", "lock.release"]
