from dataclasses import replace

import pytest

from k8s_incident_agent.diagnosis.policy import (
    DiagnosticPolicy,
    DiagnosticPolicyCatalog,
)
from k8s_incident_agent.diagnosis.policy_contracts import investigation_capability
from k8s_incident_agent.domain.contracts import IncidentSource, KubernetesTarget
from k8s_incident_agent.monitoring.catalog import load_alert_catalog
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT
from k8s_incident_agent.scenarios.catalog import load_scenario_catalog

DEPLOYMENT_TOOLS = (
    "get_workload",
    "get_rollout_history",
    "get_pods",
    "get_events",
    "get_container_logs",
    "query_prometheus",
)
DEPLOYMENT_PANELS = (
    "image-pull-affected-pods",
    "image-pull-available-replicas",
    "crash-loop-restarts",
    "crash-loop-waiting-containers",
    "deployment-replica-deficit",
    "readiness-probe-unready-containers",
    "liveness-probe-restarts",
    "oom-killed-containers",
    "abnormal-exit-containers",
    "memory-near-limit-containers",
    "cpu-throttled-containers",
    "probe-failing-containers",
    "unschedulable-pods",
    "container-cpu-cores",
    "container-memory-working-set-bytes",
    "container-cpu-throttled-ratio",
    "container-probe-failures",
    "container-last-terminated-reason",
    "pod-unschedulable",
)

NEW_TRIGGER_PANELS = (
    "oom-killed-containers",
    "abnormal-exit-containers",
    "memory-near-limit-containers",
    "cpu-throttled-containers",
    "probe-failing-containers",
    "unschedulable-pods",
)


def _panel_ids(policy: DiagnosticPolicy) -> frozenset[str]:
    # Admitted panels are the alert's own panels plus the ones listed by name.
    return frozenset(
        panel.panel_id for panel in (*policy.prometheus_panels, *policy.other_panels)
    )


def _policies() -> tuple[DiagnosticPolicyCatalog, str]:
    alerts = load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog")
    scenarios = load_scenario_catalog(REPOSITORY_ROOT / "scenarios")
    return DiagnosticPolicyCatalog(scenarios=scenarios, alerts=alerts), alerts.version


def _target(api_version: str, kind: str, name: str) -> KubernetesTarget:
    return KubernetesTarget(
        cluster="k8s-incident-agent",
        namespace="k8s-incident-scenarios",
        api_version=api_version,
        kind=kind,
        name=name,
    )


def _deployment(name: str) -> KubernetesTarget:
    return _target("apps/v1", "Deployment", name)


@pytest.mark.parametrize(
    ("alert_id", "scenario", "trigger_panel_id", "repair_action"),
    [
        (
            "K8sIncidentImagePullBackOff",
            ("image-pull-backoff", "4"),
            "image-pull-affected-pods",
            "set_container_image",
        ),
        (
            "K8sIncidentCrashLoopBackOff",
            ("crash-loop-backoff", "2"),
            "crash-loop-waiting-containers",
            None,
        ),
        (
            "K8sIncidentReadinessProbeFailure",
            ("readiness-probe-misconfigured", "2"),
            "readiness-probe-unready-containers",
            None,
        ),
        (
            "K8sIncidentLivenessProbeRestart",
            ("liveness-probe-misconfigured", "2"),
            "liveness-probe-restarts",
            None,
        ),
    ],
)
def test_every_deployment_entry_grants_the_same_target_capability(
    alert_id: str,
    scenario: tuple[str, str],
    trigger_panel_id: str,
    repair_action: str | None,
) -> None:
    policies, revision = _policies()
    scenario_id, scenario_version = scenario

    alert_policy = policies.resolve(
        IncidentSource(type="alertmanager", ref=alert_id, revision=revision),
        _deployment(scenario_id),
    )
    scenario_policy = policies.resolve(
        IncidentSource(type="scenario", ref=scenario_id, revision=scenario_version),
        _deployment(scenario_id),
    )

    # Both routes admit the same capability; only the alert route can say when
    # the rule started firing, so only it carries the rule duration.
    assert scenario_policy.trigger_duration is None
    assert alert_policy.trigger_duration is not None
    assert replace(alert_policy, trigger_duration=None) == scenario_policy
    assert alert_policy.tool_names == DEPLOYMENT_TOOLS
    assert alert_policy.required_evidence == frozenset({"workload"})
    assert _panel_ids(alert_policy) == frozenset(DEPLOYMENT_PANELS)
    assert all(
        panel.title and panel.unit and panel.purpose
        for panel in alert_policy.prometheus_panels
    )
    detailed = {panel.panel_id for panel in alert_policy.prometheus_panels}
    assert trigger_panel_id in detailed
    assert set(NEW_TRIGGER_PANELS).isdisjoint(detailed)
    assert {"container-cpu-cores", "pod-unschedulable"} <= detailed
    assert detailed.isdisjoint(panel.panel_id for panel in alert_policy.other_panels)
    assert all(panel.title for panel in alert_policy.other_panels)
    assert alert_policy.trigger_panel_id == trigger_panel_id
    assert alert_policy.repair_action == repair_action


def test_generic_deployment_alert_shares_the_deployment_capability() -> None:
    policies, revision = _policies()

    policy = policies.resolve(
        IncidentSource(
            type="alertmanager",
            ref="K8sIncidentDeploymentReplicasUnavailable",
            revision=revision,
        ),
        _deployment("any-deployment"),
    )

    assert policy.tool_names == DEPLOYMENT_TOOLS
    assert policy.trigger_panel_id == "deployment-replica-deficit"
    assert policy.repair_action is None


def test_service_and_pvc_targets_keep_their_own_bounded_capabilities() -> None:
    policies, revision = _policies()

    service_policy = policies.resolve(
        IncidentSource(
            type="alertmanager",
            ref="K8sIncidentServiceEndpointsUnavailable",
            revision=revision,
        ),
        _target("v1", "Service", "service-selector-mismatch"),
    )
    pvc_policy = policies.resolve(
        IncidentSource(type="scenario", ref="pvc-binding-pending", revision="1"),
        _target("v1", "PersistentVolumeClaim", "pvc-binding-pending"),
    )

    assert service_policy.tool_names == ("get_service_network", "query_prometheus")
    assert service_policy.required_evidence == frozenset({"service_network"})
    assert _panel_ids(service_policy) == frozenset({"service-ready-endpoints"})
    assert service_policy.trigger_panel_id == "service-ready-endpoints"
    assert pvc_policy.tool_names == ("get_pvc_storage", "query_prometheus")
    assert pvc_policy.required_evidence == frozenset({"pvc_storage"})
    assert _panel_ids(pvc_policy) == frozenset(
        {"pvc-pending-state", "pvc-pending-age-seconds"}
    )
    for policy in (service_policy, pvc_policy):
        assert not set(policy.tool_names).intersection(
            {"get_workload", "get_rollout_history", "get_container_logs"}
        )
        assert policy.repair_action is None


def test_policy_panels_match_the_server_side_admission_set() -> None:
    alerts = load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog")
    policies, revision = _policies()

    policy = policies.resolve(
        IncidentSource(
            type="alertmanager",
            ref="K8sIncidentCrashLoopBackOff",
            revision=revision,
        ),
        _deployment("crash-loop-backoff"),
    )

    assert _panel_ids(policy) == frozenset(
        panel.panel_id for panel in alerts.panels_for_target("apps/v1", "Deployment")
    )
    assert not alerts.panels_for_target("v1", "Node")


@pytest.mark.parametrize(
    ("source", "target"),
    [
        (
            IncidentSource(
                type="alertmanager",
                ref="K8sIncidentCrashLoopBackOff",
                revision="stale-catalog",
            ),
            _deployment("crash-loop-backoff"),
        ),
        (
            IncidentSource(type="scenario", ref="crash-loop-backoff", revision="1"),
            _deployment("crash-loop-backoff"),
        ),
        (
            IncidentSource(type="scenario", ref="unknown-scenario", revision="1"),
            _deployment("unknown-scenario"),
        ),
        (
            IncidentSource(
                type="alertmanager",
                ref="K8sIncidentServiceEndpointsUnavailable",
                revision="2026-09-17.2",
            ),
            _deployment("service-selector-mismatch"),
        ),
    ],
)
def test_rejects_sources_without_an_exact_policy_or_mismatched_target(
    source: IncidentSource,
    target: KubernetesTarget,
) -> None:
    policies, _ = _policies()

    with pytest.raises(ValueError, match="policy"):
        policies.resolve(source, target)


def test_rejects_scenarios_whose_target_kind_drifts_from_their_alert() -> None:
    alerts = load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog")
    scenarios = load_scenario_catalog(REPOSITORY_ROOT / "scenarios")
    drifted = scenarios[0].model_copy(
        update={"monitoring_alert_id": "K8sIncidentPersistentVolumeClaimPending"}
    )

    with pytest.raises(ValueError, match="does not match"):
        DiagnosticPolicyCatalog(scenarios=(drifted, *scenarios[1:]), alerts=alerts)


def test_unsupported_target_kinds_have_no_capability() -> None:
    with pytest.raises(ValueError, match="capability"):
        investigation_capability("v1", "Node")
