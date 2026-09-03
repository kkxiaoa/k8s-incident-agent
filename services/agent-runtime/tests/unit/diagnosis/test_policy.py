import pytest

from k8s_incident_agent.diagnosis.policy import DiagnosticPolicyCatalog
from k8s_incident_agent.diagnosis.policy_contracts import (
    validate_diagnostic_policy_contract,
)
from k8s_incident_agent.domain.contracts import IncidentSource
from k8s_incident_agent.monitoring.catalog import load_alert_catalog
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT
from k8s_incident_agent.scenarios.catalog import load_scenario_catalog


def _policies() -> tuple[DiagnosticPolicyCatalog, str]:
    alerts = load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog")
    scenarios = load_scenario_catalog(REPOSITORY_ROOT / "scenarios")
    return DiagnosticPolicyCatalog(scenarios=scenarios, alerts=alerts), alerts.version


def test_resolves_exact_alert_and_scenario_diagnostic_policies() -> None:
    policies, revision = _policies()

    alert_policy = policies.resolve(
        IncidentSource(
            type="alertmanager",
            ref="K8sIncidentCrashLoopBackOff",
            revision=revision,
        )
    )
    scenario_policy = policies.resolve(
        IncidentSource(
            type="scenario",
            ref="crash-loop-backoff",
            revision="1",
        )
    )
    image_pull_policy = policies.resolve(
        IncidentSource(
            type="scenario",
            ref="image-pull-backoff",
            revision="1",
        )
    )

    assert alert_policy == scenario_policy
    assert alert_policy.tool_names == (
        "get_workload",
        "get_pods",
        "get_events",
        "get_container_logs",
        "query_prometheus",
    )
    assert alert_policy.required_evidence == frozenset(
        {"workload", "pods", "events", "container_logs"}
    )
    assert alert_policy.prometheus_panel_ids == (
        "crash-loop-restarts",
        "crash-loop-waiting-containers",
    )
    assert "get_container_logs" not in image_pull_policy.tool_names
    assert "container_logs" not in image_pull_policy.required_evidence


def test_resolves_generic_deployment_availability_policy_without_inventing_logs() -> (
    None
):
    policies, revision = _policies()

    policy = policies.resolve(
        IncidentSource(
            type="alertmanager",
            ref="K8sIncidentDeploymentReplicasUnavailable",
            revision=revision,
        )
    )

    assert policy.tool_names == (
        "get_workload",
        "get_pods",
        "get_events",
        "query_prometheus",
    )
    assert policy.required_evidence == frozenset({"workload", "pods", "events"})
    assert policy.prometheus_panel_ids == ("deployment-replica-deficit",)


def test_resolves_service_network_policy_without_deployment_tools() -> None:
    policies, revision = _policies()

    alert_policy = policies.resolve(
        IncidentSource(
            type="alertmanager",
            ref="K8sIncidentServiceEndpointsUnavailable",
            revision=revision,
        )
    )
    scenario_policy = policies.resolve(
        IncidentSource(
            type="scenario",
            ref="service-selector-mismatch",
            revision="1",
        )
    )

    assert alert_policy == scenario_policy
    assert alert_policy.tool_names == ("get_service_network", "query_prometheus")
    assert alert_policy.required_evidence == frozenset({"service_network"})
    assert alert_policy.prometheus_panel_ids == ("service-ready-endpoints",)


@pytest.mark.parametrize(
    "source",
    [
        IncidentSource(
            type="alertmanager",
            ref="K8sIncidentCrashLoopBackOff",
            revision="stale-catalog",
        ),
        IncidentSource(
            type="scenario",
            ref="crash-loop-backoff",
            revision="2",
        ),
        IncidentSource(
            type="scenario",
            ref="unknown-scenario",
            revision="1",
        ),
    ],
)
def test_rejects_sources_without_an_exact_policy(source: IncidentSource) -> None:
    policies, _ = _policies()

    with pytest.raises(ValueError, match="policy"):
        policies.resolve(source)


def test_rejects_scenario_policy_drift_from_its_alert() -> None:
    alerts = load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog")
    scenarios = load_scenario_catalog(REPOSITORY_ROOT / "scenarios")
    drifted = scenarios[0].model_copy(
        update={
            "allowed_tools": ("get_workload",),
            "required_evidence": ("workload",),
        }
    )

    with pytest.raises(ValueError, match="does not match"):
        DiagnosticPolicyCatalog(
            scenarios=(drifted, *scenarios[1:]),
            alerts=alerts,
        )


@pytest.mark.parametrize(
    ("tool_names", "required_evidence"),
    [
        (("unknown_tool",), ("workload",)),
        (("get_workload",), ("unknown_evidence",)),
        (("get_workload",), ("pods",)),
        (("get_workload", "get_workload"), ("workload",)),
    ],
)
def test_rejects_invalid_or_uncovered_policy_contracts(
    tool_names: tuple[str, ...],
    required_evidence: tuple[str, ...],
) -> None:
    with pytest.raises(ValueError, match="policy contract"):
        validate_diagnostic_policy_contract(tool_names, required_evidence)
