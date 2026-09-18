import json
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

import pytest

from k8s_incident_agent.monitoring.catalog import (
    AlertCatalogEntry,
    MetricPanelContract,
    load_alert_catalog,
)
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT


def test_production_catalog_has_supported_alert_entries() -> None:
    catalog = load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog")

    assert catalog.version == "2026-09-17.2"
    assert [entry.alert_id for entry in catalog.entries] == [
        "K8sIncidentImagePullBackOff",
        "K8sIncidentCrashLoopBackOff",
        "K8sIncidentDeploymentReplicasUnavailable",
        "K8sIncidentServiceEndpointsUnavailable",
        "K8sIncidentReadinessProbeFailure",
        "K8sIncidentLivenessProbeRestart",
        "K8sIncidentContainerOOMKilled",
        "K8sIncidentContainerAbnormalExit",
        "K8sIncidentContainerMemoryNearLimit",
        "K8sIncidentContainerCPUThrottled",
        "K8sIncidentContainerProbeFailing",
        "K8sIncidentPodUnschedulable",
        "K8sIncidentPersistentVolumeClaimPending",
    ]
    assert catalog.entries[0].target.model_dump() == {
        "api_version": "apps/v1",
        "kind": "Deployment",
        "cluster_label": "cluster",
        "namespace_label": "namespace",
        "name_label": "deployment",
    }
    assert catalog.entries[0].rule.for_duration == "30s"
    assert all(
        not hasattr(entry, "allowed_tools") and not hasattr(entry, "required_evidence")
        for entry in catalog.entries
    )
    assert catalog.entries[0].repair_action == "set_container_image"
    assert all(entry.repair_action is None for entry in catalog.entries[1:])
    assert "kube_pod_container_status_waiting_reason" in (
        catalog.entries[0].rule.expression
    )
    assert catalog.panel_ids == (
        "image-pull-affected-pods",
        "image-pull-available-replicas",
        "crash-loop-restarts",
        "crash-loop-waiting-containers",
        "deployment-replica-deficit",
        "service-ready-endpoints",
        "readiness-probe-unready-containers",
        "liveness-probe-restarts",
        "oom-killed-containers",
        "abnormal-exit-containers",
        "memory-near-limit-containers",
        "cpu-throttled-containers",
        "probe-failing-containers",
        "unschedulable-pods",
        "pvc-pending-state",
        "pvc-pending-age-seconds",
        "container-cpu-cores",
        "container-memory-working-set-bytes",
        "container-cpu-throttled-ratio",
        "container-probe-failures",
        "container-last-terminated-reason",
        "pod-unschedulable",
    )
    assert catalog.entries[0].panels[0].model_dump() == {
        "panel_id": "image-pull-affected-pods",
        "title": "镜像拉取失败 Pod",
        "unit": "pods",
        "purpose": catalog.entries[0].panels[0].purpose,
        "producer": "kube-state-metrics",
        "series_binding": "target",
        "threshold": 1.0,
        "risk_direction": "higher_is_worse",
        "signal_role": "trigger",
        "threshold_duration": "30s",
        "recommended_window": "15m",
        "stale_after_seconds": 60,
        "query_template": catalog.entries[0].panels[0].query_template,
    }
    available_replicas = catalog.entries[0].panels[1]
    assert available_replicas.unit == "replicas"
    assert available_replicas.threshold is None
    assert available_replicas.risk_direction == "lower_is_worse"
    assert available_replicas.signal_role == "context"
    assert available_replicas.threshold_duration == "5m"
    assert available_replicas.query_template == (
        'max(kube_deployment_status_replicas_available{namespace="{{namespace}}",'
        'deployment="{{name}}"})'
    )
    crash_loop = catalog.entries[1]
    assert "kube_pod_container_status_restarts_total" in crash_loop.rule.expression
    assert crash_loop.rule.keep_firing_for == "2m"
    assert crash_loop.panels[0].unit == "restarts"
    for panel in [catalog.entries[0].panels[0], *crash_loop.panels]:
        assert " or (max(kube_replicaset_owner{" in panel.query_template
        assert panel.query_template.endswith("}) * 0)")
    availability = catalog.entries[2]
    assert availability.rule.for_duration == "5m"
    assert "kube_deployment_spec_replicas" in availability.rule.expression
    assert "kube_deployment_status_replicas_available" in (availability.rule.expression)
    deficit = availability.panels[0]
    assert deficit.panel_id == "deployment-replica-deficit"
    assert deficit.threshold == 1.0
    assert deficit.risk_direction == "higher_is_worse"
    assert deficit.threshold_duration == "5m"
    assert "clamp_min" in deficit.query_template
    service = catalog.entries[3]
    assert service.target.kind == "Service"
    assert service.target.name_label == "service"
    assert "kube_service_labels" in service.rule.expression
    assert "kube_endpointslice_endpoints" in service.rule.expression
    assert 'kube_endpointslice_endpoints{ready="true"} > 0' in (service.rule.expression)
    assert 'kube_endpointslice_endpoints{ready="true"} == 1' not in (
        service.rule.expression
    )
    ready_endpoints = service.panels[0]
    assert ready_endpoints.panel_id == "service-ready-endpoints"
    assert ready_endpoints.threshold == 1.0
    assert ready_endpoints.risk_direction == "lower_is_worse"
    assert (
        'kube_endpointslice_endpoints{namespace="{{namespace}}",ready="true"} > 0'
        in (ready_endpoints.query_template)
    )
    readiness = catalog.entries[4]
    assert readiness.rule.for_duration == "2m"
    assert "kube_pod_container_status_ready == bool 0" in (readiness.rule.expression)
    assert "kube_pod_container_status_running == 1" in readiness.rule.expression
    assert "label_k8s_incident_agent_io_readiness_container" in (
        readiness.rule.expression
    )
    assert 'label_k8s_incident_agent_io_readiness_slo="2m"' in (
        readiness.rule.expression
    )
    readiness_panel = readiness.panels[0]
    assert readiness_panel.panel_id == "readiness-probe-unready-containers"
    assert readiness_panel.unit == "containers"
    assert readiness_panel.threshold == 1.0
    assert readiness_panel.threshold_duration == "2m"
    assert 'label_k8s_incident_agent_io_readiness_slo="2m"' in (
        readiness_panel.query_template
    )
    liveness = catalog.entries[5]
    assert liveness.rule.for_duration == "30s"
    assert "increase(kube_pod_container_status_restarts_total[5m]) > 0" in (
        liveness.rule.expression
    )
    assert "label_k8s_incident_agent_io_liveness_container" in (
        liveness.rule.expression
    )
    liveness_panel = liveness.panels[0]
    assert liveness_panel.panel_id == "liveness-probe-restarts"
    assert liveness_panel.unit == "restarts"
    assert liveness_panel.threshold == 1.0
    assert liveness_panel.threshold_duration == "30s"
    pvc = catalog.find("K8sIncidentPersistentVolumeClaimPending")
    assert pvc is not None
    assert pvc.target.model_dump() == {
        "api_version": "v1",
        "kind": "PersistentVolumeClaim",
        "cluster_label": "cluster",
        "namespace_label": "namespace",
        "name_label": "persistentvolumeclaim",
    }
    assert pvc.rule.for_duration == "5m"
    assert "kube_persistentvolumeclaim_status_phase" in pvc.rule.expression
    assert "label_k8s_incident_agent_io_pending_policy" in pvc.rule.expression
    pending_state, pending_age = pvc.panels
    assert pending_state.panel_id == "pvc-pending-state"
    assert pending_state.unit == "claims"
    assert pending_state.threshold == 1.0
    assert pending_state.threshold_duration == "5m"
    assert pending_age.panel_id == "pvc-pending-age-seconds"
    assert pending_age.unit == "seconds"
    assert pending_age.threshold == 300.0
    assert "kube_persistentvolumeclaim_created" in pending_age.query_template
    assert "== bool 1" in pending_age.query_template
    assert "kube_persistentvolumeclaim_info" not in pending_state.query_template
    assert "kube_persistentvolumeclaim_info" not in pending_age.query_template


@pytest.mark.parametrize(
    "document",
    [
        '{"schemaVersion":11,"catalogVersion":"v1","contextPanels":[],"healthAlerts":[],"alerts":[]}',
        (
            '{"schemaVersion":11,"catalogVersion":"v1","contextPanels":[],"healthAlerts":[],"alerts":['
            '{"alertId":"A","displayName":"A","triggerSummary":"A",'
            '"rule":{"expression":"vector(1)","for":"1s"},'
            '"target":{"apiVersion":"v1","kind":"Pod",'
            '"clusterLabel":"same","namespaceLabel":"same",'
            '"nameLabel":"name"},"panels":[{"panelId":"panel-a",'
            '"title":"Panel A","unit":"pods","purpose":"P","producer":"kube-state-metrics","seriesBinding":"target","threshold":1.0,'
            '"riskDirection":"higher_is_worse","signalRole":"trigger",'
            '"thresholdDuration":"1s",'
            '"recommendedWindow":"15m","staleAfterSeconds":60,'
            '"queryTemplate":"metric{namespace="{{namespace}}",'
            'name="{{name}}"}"}]}]}'
        ),
        (
            '{"schemaVersion":11,"schemaVersion":11,"catalogVersion":"v1","contextPanels":[],"healthAlerts":[],'
            '"alerts":[{"alertId":"A","displayName":"A",'
            '"triggerSummary":"A","rule":{"expression":"vector(1)",'
            '"for":"1s"},"target":{"apiVersion":"v1",'
            '"kind":"Pod","clusterLabel":"cluster",'
            '"namespaceLabel":"namespace","nameLabel":"name"},'
            '"panels":[{"panelId":"panel-a","title":"Panel A",'
            '"unit":"pods","purpose":"P","producer":"kube-state-metrics","seriesBinding":"target","threshold":1.0,'
            '"riskDirection":"higher_is_worse","signalRole":"trigger",'
            '"thresholdDuration":"1s",'
            '"recommendedWindow":"15m",'
            '"staleAfterSeconds":60,"queryTemplate":'
            '"metric{namespace="{{namespace}}",name="{{name}}"}"}]}]}'
        ),
        (
            '{"schema_version":9,"catalogVersion":"v1","contextPanels":[],"healthAlerts":[],"alerts":['
            '{"alertId":"A","displayName":"A","triggerSummary":"A",'
            '"rule":{"expression":"vector(1)","for":"1s"},'
            '"target":{"apiVersion":"v1","kind":"Pod",'
            '"clusterLabel":"cluster","namespaceLabel":"namespace",'
            '"nameLabel":"name"},"panels":[{"panelId":"panel-a",'
            '"title":"Panel A","unit":"pods","purpose":"P","producer":"kube-state-metrics","seriesBinding":"target","threshold":1.0,'
            '"riskDirection":"higher_is_worse","signalRole":"trigger",'
            '"thresholdDuration":"1s",'
            '"recommendedWindow":"15m","staleAfterSeconds":60,'
            '"queryTemplate":"metric{namespace="{{namespace}}",'
            'name="{{name}}"}"}]}]}'
        ),
    ],
)
def test_catalog_rejects_empty_ambiguous_or_duplicate_key_contracts(
    tmp_path: Path,
    document: str,
) -> None:
    catalog_dir = tmp_path / "catalog"
    catalog_dir.mkdir()
    (catalog_dir / "catalog.json").write_text(document, encoding="utf-8")

    with pytest.raises(ValueError, match=r"catalog|Catalog"):
        load_alert_catalog(catalog_dir)


def test_catalog_accepts_a_static_lower_bound_threshold(tmp_path: Path) -> None:
    document = {
        "schemaVersion": 11,
        "catalogVersion": "v1",
        "contextPanels": [],
        "healthAlerts": [],
        "alerts": [
            {
                "alertId": "A",
                "displayName": "A",
                "triggerSummary": "A",
                "rule": {"expression": "vector(1)", "for": "1s"},
                "target": {
                    "apiVersion": "apps/v1",
                    "kind": "Deployment",
                    "clusterLabel": "cluster",
                    "namespaceLabel": "namespace",
                    "nameLabel": "name",
                },
                "panels": [
                    {
                        "panelId": "panel-a",
                        "title": "Panel A",
                        "unit": "replicas",
                        "purpose": "P",
                        "producer": "kube-state-metrics",
                        "seriesBinding": "target",
                        "threshold": 1.0,
                        "riskDirection": "lower_is_worse",
                        "signalRole": "trigger",
                        "thresholdDuration": "1s",
                        "recommendedWindow": "15m",
                        "staleAfterSeconds": 60,
                        "queryTemplate": (
                            'metric{namespace="{{namespace}}",name="{{name}}"}'
                        ),
                    }
                ],
            }
        ],
    }
    catalog_dir = tmp_path / "catalog"
    catalog_dir.mkdir()
    (catalog_dir / "catalog.json").write_text(json.dumps(document), encoding="utf-8")

    panel = load_alert_catalog(catalog_dir).entries[0].panels[0]

    assert panel.threshold == 1.0
    assert panel.risk_direction == "lower_is_worse"


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (("signalRole", "context"), "exactly one trigger panel"),
        (("thresholdDuration", "2s"), "duration must match"),
    ],
)
def test_alert_entry_rejects_an_ambiguous_trigger_panel(
    mutation: tuple[str, str],
    message: str,
) -> None:
    document = json.loads(
        (REPOSITORY_ROOT / "monitoring" / "catalog" / "catalog.json").read_text()
    )
    entry = document["alerts"][0]
    field, value = mutation
    entry["panels"][0][field] = value

    with pytest.raises(ValueError, match=message):
        AlertCatalogEntry.model_validate(entry)


def test_repair_action_requires_a_deployment_target() -> None:
    document = json.loads(
        (REPOSITORY_ROOT / "monitoring" / "catalog" / "catalog.json").read_text()
    )
    entry = document["alerts"][0]
    entry["target"]["apiVersion"] = "v1"
    entry["target"]["kind"] = "Service"

    with pytest.raises(ValueError, match="Deployment target"):
        AlertCatalogEntry.model_validate(entry)


def test_catalog_rejects_higher_risk_without_a_static_threshold() -> None:
    with pytest.raises(ValueError, match="Higher-is-worse"):
        MetricPanelContract.model_validate(
            {
                "panelId": "panel-a",
                "title": "Panel A",
                "unit": "pods",
                "purpose": "P",
                "producer": "kube-state-metrics",
                "seriesBinding": "target",
                "threshold": None,
                "riskDirection": "higher_is_worse",
                "signalRole": "trigger",
                "thresholdDuration": None,
                "recommendedWindow": "15m",
                "staleAfterSeconds": 60,
                "queryTemplate": ('metric{namespace="{{namespace}}",name="{{name}}"}'),
            }
        )


def test_catalog_rejects_mapping_label_outside_webhook_key_budget(
    tmp_path: Path,
) -> None:
    catalog_dir = tmp_path / "catalog"
    catalog_dir.mkdir()
    document = {
        "schemaVersion": 11,
        "catalogVersion": "v1",
        "contextPanels": [],
        "healthAlerts": [],
        "alerts": [
            {
                "alertId": "A",
                "displayName": "A",
                "triggerSummary": "A",
                "rule": {"expression": "vector(1)", "for": "1s"},
                "target": {
                    "apiVersion": "apps/v1",
                    "kind": "Deployment",
                    "clusterLabel": "x" * 129,
                    "namespaceLabel": "namespace",
                    "nameLabel": "name",
                },
                "panels": [
                    {
                        "panelId": "panel-a",
                        "title": "Panel A",
                        "unit": "pods",
                        "purpose": "P",
                        "producer": "kube-state-metrics",
                        "seriesBinding": "target",
                        "threshold": 1.0,
                        "riskDirection": "higher_is_worse",
                        "signalRole": "trigger",
                        "thresholdDuration": "1s",
                        "recommendedWindow": "15m",
                        "staleAfterSeconds": 60,
                        "queryTemplate": (
                            'metric{namespace="{{namespace}}",name="{{name}}"}'
                        ),
                    }
                ],
            }
        ],
    }
    (catalog_dir / "catalog.json").write_text(
        json.dumps(document),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="Alert catalog contract is invalid"):
        load_alert_catalog(catalog_dir)


def _production_document() -> dict[str, Any]:
    return cast(
        dict[str, Any],
        json.loads(
            (REPOSITORY_ROOT / "monitoring" / "catalog" / "catalog.json").read_text()
        ),
    )


def _write_catalog(tmp_path: Path, document: dict[str, Any]) -> Path:
    catalog_dir = tmp_path / "catalog"
    catalog_dir.mkdir()
    (catalog_dir / "catalog.json").write_text(json.dumps(document), encoding="utf-8")
    return catalog_dir


def test_production_context_panels_are_bounded_deployment_context() -> None:
    catalog = load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog")

    [group] = catalog.context_groups
    assert (group.target.api_version, group.target.kind) == ("apps/v1", "Deployment")
    assert [panel.panel_id for panel in group.panels] == [
        "container-cpu-cores",
        "container-memory-working-set-bytes",
        "container-cpu-throttled-ratio",
        "container-probe-failures",
        "container-last-terminated-reason",
        "pod-unschedulable",
    ]
    assert {panel.producer for panel in group.panels} == {
        "kubelet-resource",
        "kubelet-cadvisor",
        "kubelet-probes",
        "kube-state-metrics",
    }
    assert all(panel.signal_role == "context" for panel in group.panels)
    assert [panel.series_binding for panel in group.panels] == [
        *(["pod_container"] * 5),
        "pod",
    ]
    assert all(
        'job="kubelet-' in panel.query_template
        for panel in group.panels
        if panel.producer.startswith("kubelet")
    )
    assert all(
        "group_left(uid, replicaset)" in panel.query_template for panel in group.panels
    )
    assert not catalog.context_panels("v1", "Service")
    assert len(catalog.default_panels(catalog.entries[3])) == 1
    assert catalog.find_panel("pod-unschedulable") is not None
    assert catalog.find_panel("missing-panel") is None


def _trigger_context(document: dict[str, Any]) -> None:
    document["contextPanels"][0]["panels"][0].update(
        {"signalRole": "trigger", "thresholdDuration": "30s"}
    )


def _unknown_kind(document: dict[str, Any]) -> None:
    document["contextPanels"][0]["target"].update({"kind": "StatefulSet"})


def _repeated_group(document: dict[str, Any]) -> None:
    document["contextPanels"].append(dict(document["contextPanels"][0]))


def _too_many_default_panels(document: dict[str, Any]) -> None:
    template = document["alerts"][0]["panels"][1]
    document["alerts"][0]["panels"].extend(
        [{**template, "panelId": f"extra-context-{index}"} for index in range(2)]
    )


def _neutral_with_threshold(document: dict[str, Any]) -> None:
    document["contextPanels"][0]["panels"][0].update({"threshold": 1.0})


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (_trigger_context, "contract is invalid"),
        (_unknown_kind, "need an alert for their kind"),
        (
            _repeated_group,
            "contract is invalid|repeats a context panel|duplicate panel",
        ),
        (_too_many_default_panels, "exceed the bounded set"),
        (_neutral_with_threshold, "contract is invalid"),
    ],
)
def test_catalog_rejects_unbounded_or_mislabelled_context_panels(
    tmp_path: Path,
    mutate: Callable[[dict[str, Any]], None],
    message: str,
) -> None:
    document = _production_document()
    mutate(document)

    with pytest.raises(ValueError, match=message):
        load_alert_catalog(_write_catalog(tmp_path, document))


@pytest.mark.parametrize(
    ("template", "valid"),
    [
        ('rate(m{namespace="{{namespace}}",n="{{name}}"}[{{range:2m}}])', True),
        ('rate(m{namespace="{{namespace}}",n="{{name}}"}[{{range:30s}}])', True),
        ('rate(m{namespace="{{namespace}}",n="{{name}}"}[{{range:2h}}])', False),
        ('rate(m{namespace="{{namespace}}",n="{{name}}"}[{{range:0m}}])', False),
        ('rate(m{namespace="{{namespace}}",n="{{name}}"}[{{step}}])', False),
    ],
)
def test_query_templates_admit_only_the_bounded_rolling_range_placeholder(
    template: str,
    valid: bool,
) -> None:
    document = _production_document()
    panel = {**document["contextPanels"][0]["panels"][0], "queryTemplate": template}
    if valid:
        MetricPanelContract.model_validate(panel)
    else:
        with pytest.raises(ValueError, match="unknown placeholder"):
            MetricPanelContract.model_validate(panel)


def test_discovery_alerts_are_bounded_deployment_rules_outside_the_recovery_gate() -> (
    None
):
    catalog = load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog")
    discovery = [
        catalog.find(alert_id)
        for alert_id in (
            "K8sIncidentContainerOOMKilled",
            "K8sIncidentContainerAbnormalExit",
            "K8sIncidentContainerMemoryNearLimit",
            "K8sIncidentContainerCPUThrottled",
            "K8sIncidentContainerProbeFailing",
            "K8sIncidentPodUnschedulable",
        )
    ]

    assert all(entry is not None for entry in discovery)
    for entry in discovery:
        assert entry is not None
        assert entry.target.kind == "Deployment"
        assert entry.repair_action is None and entry.recovery_alerts is None
        [panel] = entry.panels
        assert panel.signal_role == "trigger"
        assert panel.series_binding == "target"
        assert panel.threshold_duration == entry.rule.for_duration
        assert len(catalog.default_panels(entry)) == 7
    assert catalog.recovery_alerts("set_container_image") == (
        "K8sIncidentImagePullBackOff",
        "K8sIncidentCrashLoopBackOff",
        "K8sIncidentDeploymentReplicasUnavailable",
        "K8sIncidentReadinessProbeFailure",
        "K8sIncidentLivenessProbeRestart",
    )
    abnormal = catalog.find("K8sIncidentContainerAbnormalExit")
    assert abnormal is not None
    assert (
        "unless on (namespace, deployment) max_over_time(ALERTS{"
        in abnormal.rule.expression
    )
    assert [entry.alert_id for entry in catalog.health_entries] == [
        "K8sIncidentMonitoringTargetDown",
        "K8sIncidentKubeStateMetricsListFailing",
        "K8sIncidentKubeletTargetsMissing",
        "K8sIncidentRuleEvaluationFailing",
    ]
    assert catalog.find("K8sIncidentMonitoringTargetDown") is None
    assert all(catalog.find_health(entry.alert_id) is None for entry in catalog.entries)


def _drop_recovery_alerts(document: dict[str, Any]) -> None:
    document["alerts"][0].pop("recoveryAlerts")


def _unknown_recovery_alert(document: dict[str, Any]) -> None:
    document["alerts"][0]["recoveryAlerts"].append(
        "K8sIncidentServiceEndpointsUnavailable"
    )


def _health_reuses_business_id(document: dict[str, Any]) -> None:
    document["healthAlerts"][0]["alertId"] = "K8sIncidentPodUnschedulable"


def _health_named_watchdog(document: dict[str, Any]) -> None:
    document["healthAlerts"][0]["alertId"] = "Watchdog"


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (_drop_recovery_alerts, "contract is invalid"),
        (_unknown_recovery_alert, "registered Deployment rules"),
        (_health_reuses_business_id, "must be distinct"),
        (_health_named_watchdog, "must be distinct"),
    ],
)
def test_catalog_rejects_ambiguous_recovery_or_health_classification(
    tmp_path: Path,
    mutate: Callable[[dict[str, Any]], None],
    message: str,
) -> None:
    document = _production_document()
    mutate(document)

    with pytest.raises(ValueError, match=message):
        load_alert_catalog(_write_catalog(tmp_path, document))
