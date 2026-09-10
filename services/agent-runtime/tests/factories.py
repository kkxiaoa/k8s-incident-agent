from typing import cast
from uuid import UUID

from k8s_incident_agent.application.monitoring import MonitoringApplicationService
from k8s_incident_agent.domain.contracts import (
    IncidentSource,
    KubernetesTarget,
    NormalizedIncidentTrigger,
)
from k8s_incident_agent.domain.models import AgentRunSnapshot
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
