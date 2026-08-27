from collections.abc import AsyncGenerator, Callable
from contextlib import AbstractAsyncContextManager, AsyncExitStack, asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx
import uvicorn
from fastapi import FastAPI

from k8s_incident_agent.api_errors import install_exception_handlers
from k8s_incident_agent.application.events import (
    EventDependencies,
    IncidentEventService,
    RunEventNotifier,
)
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.config import Settings
from k8s_incident_agent.diagnosis.prompt import DIAGNOSTIC_PROMPT_VERSION
from k8s_incident_agent.domain.models import ModelSnapshot, RunBudget
from k8s_incident_agent.kubernetes.access import verify_stage_one_access
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.client import create_kubernetes_clients
from k8s_incident_agent.kubernetes.credentials import (
    load_diagnostic_credential,
    require_credential_ttl,
)
from k8s_incident_agent.model.discovery import discover_models
from k8s_incident_agent.model.factory import create_deepseek_model
from k8s_incident_agent.persistence.database import (
    create_business_database,
    require_alembic_head,
)
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.routes.events import router as events_router
from k8s_incident_agent.routes.incidents import router as incidents_router
from k8s_incident_agent.routes.scenarios import router as scenarios_router
from k8s_incident_agent.runtime.lock import RuntimeLock
from k8s_incident_agent.scenarios.catalog import load_scenario_catalog
from k8s_incident_agent.workflow.checkpoint import open_checkpoint_store
from k8s_incident_agent.workflow.supervisor import RunSupervisor


@dataclass(frozen=True, slots=True)
class RuntimeContainer:
    incidents: IncidentApplicationService
    events: IncidentEventService


type RuntimeContextFactory = Callable[
    [Settings],
    AbstractAsyncContextManager[RuntimeContainer],
]


def create_app(
    *,
    settings: Settings | None = None,
    runtime_context_factory: RuntimeContextFactory | None = None,
) -> FastAPI:
    context_factory = runtime_context_factory or build_runtime_container

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
        resolved_settings = settings or Settings()
        async with context_factory(resolved_settings) as container:
            app.state.container = container
            app.state.ready = True
            try:
                yield
            finally:
                app.state.ready = False
                del app.state.container

    app = FastAPI(
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.ready = False
    install_exception_handlers(app)

    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    app.add_api_route("/healthz", healthz, methods=["GET"])
    app.include_router(scenarios_router)
    app.include_router(incidents_router)
    app.include_router(events_router)
    return app


@asynccontextmanager
async def build_runtime_container(
    settings: Settings,
) -> AsyncGenerator[RuntimeContainer]:
    def now() -> datetime:
        return datetime.now(UTC)

    async with AsyncExitStack() as resources:
        runtime_lock = RuntimeLock(settings.runtime_paths.runtime_lock)
        runtime_lock.acquire()
        resources.callback(runtime_lock.release)

        settings.require_deepseek_api_key()
        await discover_models(settings)

        database = await create_business_database(settings.runtime_paths)
        resources.push_async_callback(database.dispose)
        await require_alembic_head(database)

        checkpointer = await resources.enter_async_context(
            open_checkpoint_store(settings.runtime_paths.checkpoint_database)
        )
        catalog = load_scenario_catalog(settings.scenario_catalog_dir)

        budget = RunBudget(
            max_model_calls=settings.agent_max_model_calls,
            max_tool_calls=settings.agent_max_tool_calls,
            timeout_seconds=settings.agent_timeout_seconds,
        )
        credential = load_diagnostic_credential(settings.runtime_paths, now())
        require_credential_ttl(
            credential,
            budget.timeout_seconds + 60,
            now(),
        )
        kubernetes_clients = await create_kubernetes_clients(
            credential,
            settings.kubernetes_timeout_seconds,
        )
        resources.push_async_callback(kubernetes_clients.close)
        for scenario in catalog:
            await verify_stage_one_access(kubernetes_clients, scenario.target)

        sync_http_client = httpx.Client()
        resources.callback(sync_http_client.close)
        async_http_client = httpx.AsyncClient()
        resources.push_async_callback(async_http_client.aclose)
        model = create_deepseek_model(
            settings,
            http_client=sync_http_client,
            http_async_client=async_http_client,
        )
        event_notifier = RunEventNotifier()
        repository = IncidentRepository(
            database.session_factory,
            on_event_committed=event_notifier.notify,
        )
        adapter = KubernetesEvidenceAdapter(kubernetes_clients)
        model_snapshot = ModelSnapshot(
            provider=settings.model_provider,
            model_id=settings.model_name,
            thinking_mode=settings.model_thinking,
            prompt_version=DIAGNOSTIC_PROMPT_VERSION,
        )
        supervisor = RunSupervisor(
            repository=repository,
            checkpointer=checkpointer,
            model=model,
            model_snapshot=model_snapshot,
            credential=credential,
            adapter=adapter,
            now=now,
        )
        resources.push_async_callback(supervisor.close)
        await supervisor.start()

        yield RuntimeContainer(
            incidents=IncidentApplicationService(
                catalog=catalog,
                repository=repository,
                supervisor=supervisor,
                credential=credential,
                model=model_snapshot,
                budget=budget,
                now=now,
            ),
            events=IncidentEventService(
                EventDependencies(
                    repository=repository,
                    notifier=event_notifier,
                )
            ),
        )


def main() -> None:
    uvicorn.run(
        "k8s_incident_agent.api:create_app",
        factory=True,
        host="127.0.0.1",
        workers=1,
        timeout_graceful_shutdown=5,
    )
