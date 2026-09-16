from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import cast
from uuid import UUID

from k8s_incident_agent.application.monitoring import MonitoringApplicationService
from k8s_incident_agent.auth.sessions import OperatorSession, OperatorSessions
from k8s_incident_agent.domain.contracts import (
    IncidentSource,
    KubernetesTarget,
    NormalizedIncidentTrigger,
)
from k8s_incident_agent.domain.models import (
    AgentRunSnapshot,
    DiagnosisWorkflowRunSnapshot,
)
from k8s_incident_agent.model.availability import DiagnosticModelAvailability
from k8s_incident_agent.monitoring.service import PrometheusQueryService
from k8s_incident_agent.persistence.repositories import IncidentRepository
from k8s_incident_agent.scenarios.contracts import (
    PublicScenario,
    ScenarioTarget,
    ScenarioTrigger,
)


def normalized_trigger(
    name: str = "image-pull-backoff",
) -> NormalizedIncidentTrigger:
    revision = "2" if name == "image-pull-backoff" else "1"
    return NormalizedIncidentTrigger(
        source=IncidentSource(type="scenario", ref=name, revision=revision),
        display_name="Image pull failure",
        trigger_summary="The target Deployment is unavailable.",
        target=KubernetesTarget(
            cluster="k8s-incident-agent",
            namespace="k8s-incident-scenarios",
            api_version="apps/v1",
            kind="Deployment",
            name=name,
        ),
    )


def public_scenario(name: str = "image-pull-backoff") -> PublicScenario:
    return PublicScenario(
        scenario_id=name,
        scenario_version=2,
        monitoring_alert_id="K8sIncidentImagePullBackOff",
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
            name=name,
        ),
        allowed_tools=(
            "get_workload",
            "get_rollout_history",
            "get_pods",
            "get_events",
            "query_prometheus",
        ),
        required_evidence=("workload", "rollout_history", "pods", "events"),
    )


async def agent_run_snapshot(
    repository: IncidentRepository,
    run_id: UUID,
) -> AgentRunSnapshot:
    workflow = await repository.get_workflow_run_snapshot(run_id)
    assert isinstance(workflow, DiagnosisWorkflowRunSnapshot)
    if workflow.started_at is None:
        raise AssertionError("Test Run must be started")
    return AgentRunSnapshot(
        id=run_id,
        started_at=workflow.started_at,
        timeout_seconds=workflow.budget.timeout_seconds,
    )


class _PrometheusQueryServiceStub:
    panel_ids = ("image-pull-affected-pods", "image-pull-available-replicas")


def prometheus_query_service_stub() -> PrometheusQueryService:
    return cast(PrometheusQueryService, _PrometheusQueryServiceStub())


def monitoring_health_service_stub() -> MonitoringApplicationService:
    return cast(MonitoringApplicationService, object())


class _DiagnosticModelStub:
    error = None


def diagnostic_model_stub() -> DiagnosticModelAvailability:
    return cast(DiagnosticModelAvailability, _DiagnosticModelStub())


class _OperatorSessionsStub:
    @property
    def access(self) -> "_OperatorSessionsStub":
        return self

    @property
    def operator(self) -> "_OperatorSessionsStub":
        return self

    async def resolve(
        self, cookies: list[str], *, mutation: bool = False
    ) -> OperatorSession:
        return await self.authenticate(cookies)

    @asynccontextmanager
    async def reading(self, _requester: object) -> AsyncGenerator[None]:
        yield

    @asynccontextmanager
    async def stream_slot(self, _requester: object) -> AsyncGenerator[None]:
        yield

    def open_stream(
        self, _requester: object, source: AsyncGenerator[bytes]
    ) -> AsyncGenerator[bytes]:
        return source

    async def authenticate(self, _cookies: list[str]) -> OperatorSession:
        return OperatorSession("sandbox-operator", 2**31, "", "", "")

    def require_origin(self, _origins: list[str]) -> None:
        pass

    def require_csrf(self, _session: OperatorSession, _candidates: list[str]) -> None:
        pass

    def stream(
        self, _session: OperatorSession, source: AsyncGenerator[bytes]
    ) -> AsyncGenerator[bytes]:
        return source


def operator_sessions_stub() -> OperatorSessions:
    """Isolate business-route tests; test_operator exercises real session gates."""
    return cast(OperatorSessions, _OperatorSessionsStub())
