import os
from collections.abc import AsyncGenerator, Callable
from contextlib import AbstractAsyncContextManager, AsyncExitStack, asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
import uvicorn
from fastapi import FastAPI

from k8s_incident_agent.api_contracts import HealthResponse, error_responses
from k8s_incident_agent.api_errors import install_exception_handlers
from k8s_incident_agent.application.alerts import AlertmanagerApplicationService
from k8s_incident_agent.application.events import (
    EventDependencies,
    IncidentEventService,
    RunEventNotifier,
)
from k8s_incident_agent.application.incidents import IncidentApplicationService
from k8s_incident_agent.application.monitoring import MonitoringHealthService
from k8s_incident_agent.config import ConfigurationInvalidError, Settings
from k8s_incident_agent.diagnosis.prompt import DIAGNOSTIC_PROMPT_VERSION
from k8s_incident_agent.domain.models import ModelSnapshot, RunBudget
from k8s_incident_agent.kubernetes.access import (
    require_stage_one_target_scope,
    verify_stage_one_access,
)
from k8s_incident_agent.kubernetes.adapter import KubernetesEvidenceAdapter
from k8s_incident_agent.kubernetes.client import (
    create_incluster_kubernetes_clients,
    create_kubernetes_clients,
)
from k8s_incident_agent.kubernetes.credentials import (
    DiagnosticCredentialLease,
    InClusterCredentialLease,
    load_diagnostic_credential,
    require_credential_window,
)
from k8s_incident_agent.model.discovery import discover_models
from k8s_incident_agent.model.factory import create_deepseek_model
from k8s_incident_agent.monitoring.alertmanager import AlertmanagerWebhook
from k8s_incident_agent.monitoring.auth import AlertmanagerWebhookAuthenticator
from k8s_incident_agent.monitoring.catalog import load_alert_catalog
from k8s_incident_agent.monitoring.prometheus import PrometheusHttpClient
from k8s_incident_agent.monitoring.service import PrometheusQueryService
from k8s_incident_agent.persistence.database import (
    create_business_database,
    require_alembic_head,
)
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.routes.alertmanager import router as alertmanager_router
from k8s_incident_agent.routes.events import router as events_router
from k8s_incident_agent.routes.incidents import (
    manual_router as manual_incidents_router,
)
from k8s_incident_agent.routes.incidents import router as incidents_router
from k8s_incident_agent.routes.monitoring import router as monitoring_router
from k8s_incident_agent.routes.scenarios import router as scenarios_router
from k8s_incident_agent.runtime.artifacts import open_private_directory
from k8s_incident_agent.runtime.cutover import require_runtime_cutover_complete
from k8s_incident_agent.runtime.lock import RuntimeLock
from k8s_incident_agent.scenarios.catalog import load_scenario_catalog
from k8s_incident_agent.workflow.checkpoint import open_checkpoint_store
from k8s_incident_agent.workflow.supervisor import RunSupervisor


@dataclass(frozen=True, slots=True)
class RuntimeContainer:
    incidents: IncidentApplicationService
    events: IncidentEventService
    alerts: AlertmanagerApplicationService | None
    monitoring: MonitoringHealthService


type RuntimeContextFactory = Callable[
    [Settings],
    AbstractAsyncContextManager[RuntimeContainer],
]


def create_app(
    *,
    settings: Settings | None = None,
    runtime_context_factory: RuntimeContextFactory | None = None,
    include_alertmanager_route: bool | None = None,
) -> FastAPI:
    route_intake_mode = (
        settings.incident_intake_mode if settings is not None else "manual"
    )
    context_factory = runtime_context_factory or build_runtime_container
    route_alertmanager_enabled = (
        include_alertmanager_route
        if include_alertmanager_route is not None
        else settings is not None
        and settings.alertmanager_webhook_token_file is not None
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
        resolved_settings = settings or Settings()
        if resolved_settings.incident_intake_mode != route_intake_mode:
            raise ConfigurationInvalidError(
                "INCIDENT_INTAKE_MODE changed after route assembly"
            )
        if (
            resolved_settings.alertmanager_webhook_token_file is not None
        ) != route_alertmanager_enabled:
            raise ConfigurationInvalidError(
                "ALERTMANAGER_WEBHOOK_TOKEN_FILE changed after route assembly"
            )
        async with context_factory(resolved_settings) as container:
            app.state.container = container
            app.state.ready = True
            try:
                yield
            finally:
                app.state.ready = False
                del app.state.container

    app = FastAPI(
        title="K8s Incident Agent Runtime",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.ready = False
    install_exception_handlers(app)

    async def healthz() -> HealthResponse:
        return HealthResponse()

    app.add_api_route(
        "/healthz",
        healthz,
        methods=["GET"],
        response_model=HealthResponse,
        responses=error_responses(500),
    )
    if route_intake_mode == "manual":
        app.include_router(scenarios_router)
        app.include_router(manual_incidents_router)
    if route_alertmanager_enabled:
        app.include_router(alertmanager_router)
    app.include_router(incidents_router)
    app.include_router(events_router)
    app.include_router(monitoring_router)
    if route_alertmanager_enabled:
        _install_alertmanager_openapi_contract(app)
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

        runtime_root_fd = open_private_directory(settings.runtime_paths.root)
        try:
            require_runtime_cutover_complete(runtime_root_fd)
        finally:
            os.close(runtime_root_fd)

        settings.require_deepseek_api_key()
        await discover_models(settings)

        database = await create_business_database(settings.runtime_paths)
        resources.push_async_callback(database.dispose)
        await require_alembic_head(database)

        checkpointer = await resources.enter_async_context(
            open_checkpoint_store(settings.runtime_paths.checkpoint_database)
        )
        catalog = (
            load_scenario_catalog(settings.scenario_catalog_dir)
            if settings.incident_intake_mode == "manual"
            else ()
        )
        alert_catalog = load_alert_catalog(settings.alert_catalog_dir)
        alert_authenticator = (
            AlertmanagerWebhookAuthenticator.from_file(
                settings.alertmanager_webhook_token_file
            )
            if settings.alertmanager_webhook_token_file is not None
            else None
        )

        budget = RunBudget(
            max_model_calls=settings.agent_max_model_calls,
            max_tool_calls=settings.agent_max_tool_calls,
            timeout_seconds=settings.agent_timeout_seconds,
        )
        credential: DiagnosticCredentialLease
        if settings.kubernetes_credential_mode == "kind_kubeconfig":
            credential = load_diagnostic_credential(settings.runtime_paths, now())
            require_credential_window(
                credential,
                budget.timeout_seconds + 60,
                now(),
            )
            kubernetes_clients = await create_kubernetes_clients(
                credential,
                settings.kubernetes_timeout_seconds,
                cluster_id=settings.kubernetes_cluster_id,
                diagnostic_namespace=settings.kubernetes_diagnostic_namespace,
            )
        else:
            credential = InClusterCredentialLease()
            kubernetes_clients = await create_incluster_kubernetes_clients(
                settings.kubernetes_timeout_seconds,
                cluster_id=settings.kubernetes_cluster_id,
                diagnostic_namespace=settings.kubernetes_diagnostic_namespace,
            )
        resources.push_async_callback(kubernetes_clients.close)
        for scenario in catalog:
            require_stage_one_target_scope(
                scenario.target,
                cluster_id=kubernetes_clients.cluster_id,
                diagnostic_namespace=kubernetes_clients.diagnostic_namespace,
            )
        await verify_stage_one_access(kubernetes_clients)

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
        prometheus = PrometheusQueryService(
            catalog=alert_catalog,
            client=PrometheusHttpClient.create(settings.prometheus_base_url),
            cluster_id=kubernetes_clients.cluster_id,
            now=now,
        )
        resources.push_async_callback(prometheus.close)
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
            prometheus=prometheus,
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
            alerts=(
                AlertmanagerApplicationService(
                    catalog=alert_catalog,
                    authenticator=alert_authenticator,
                    repository=repository,
                    supervisor=supervisor,
                    model=model_snapshot,
                    budget=budget,
                    cluster_id=kubernetes_clients.cluster_id,
                    diagnostic_namespace=kubernetes_clients.diagnostic_namespace,
                    now=now,
                )
                if alert_authenticator is not None
                else None
            ),
            monitoring=MonitoringHealthService(
                prometheus=prometheus,
                repository=repository,
                now=now,
            ),
        )


def _install_alertmanager_openapi_contract(app: FastAPI) -> None:
    default_openapi = app.openapi

    def openapi() -> dict[str, Any]:
        schema = default_openapi()
        components = schema.setdefault("components", {})
        schemas = components.setdefault("schemas", {})
        webhook_schema = AlertmanagerWebhook.model_json_schema(
            by_alias=True,
            ref_template="#/components/schemas/{model}",
        )
        definitions = webhook_schema.pop("$defs", {})
        schemas.update(definitions)
        schemas["AlertmanagerWebhook"] = webhook_schema
        return schema

    app.openapi = openapi


def create_runtime_app() -> FastAPI:
    return create_app(settings=Settings())


def main() -> None:
    uvicorn.run(
        "k8s_incident_agent.api:create_runtime_app",
        factory=True,
        host="127.0.0.1",
        workers=1,
        timeout_graceful_shutdown=5,
    )
