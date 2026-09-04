import json
from pathlib import Path

import pytest

from k8s_incident_agent.monitoring.catalog import (
    AlertCatalogEntry,
    MetricPanelContract,
    load_alert_catalog,
)
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT


def test_production_catalog_has_supported_alert_entries() -> None:
    catalog = load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog")

    assert catalog.version == "2026-09-05.3"
    assert [entry.alert_id for entry in catalog.entries] == [
        "K8sIncidentImagePullBackOff",
        "K8sIncidentCrashLoopBackOff",
        "K8sIncidentDeploymentReplicasUnavailable",
        "K8sIncidentServiceEndpointsUnavailable",
        "K8sIncidentReadinessProbeFailure",
        "K8sIncidentLivenessProbeRestart",
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
    assert catalog.entries[0].allowed_tools == [
        "get_workload",
        "get_pods",
        "get_events",
        "query_prometheus",
    ]
    assert catalog.entries[0].required_evidence == ["workload", "pods", "events"]
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
        "pvc-pending-state",
        "pvc-pending-age-seconds",
    )
    assert catalog.entries[0].panels[0].model_dump() == {
        "panel_id": "image-pull-affected-pods",
        "title": "镜像拉取失败 Pod",
        "unit": "pods",
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
    assert crash_loop.required_evidence == [
        "workload",
        "pods",
        "events",
        "container_logs",
    ]
    assert crash_loop.panels[0].unit == "restarts"
    for panel in [catalog.entries[0].panels[0], *crash_loop.panels]:
        assert " or (max(kube_replicaset_owner{" in panel.query_template
        assert panel.query_template.endswith("}) * 0)")
    availability = catalog.entries[2]
    assert availability.rule.for_duration == "5m"
    assert "kube_deployment_spec_replicas" in availability.rule.expression
    assert "kube_deployment_status_replicas_available" in (availability.rule.expression)
    assert availability.allowed_tools == [
        "get_workload",
        "get_pods",
        "get_events",
        "query_prometheus",
    ]
    assert availability.required_evidence == ["workload", "pods", "events"]
    deficit = availability.panels[0]
    assert deficit.panel_id == "deployment-replica-deficit"
    assert deficit.threshold == 1.0
    assert deficit.risk_direction == "higher_is_worse"
    assert deficit.threshold_duration == "5m"
    assert "clamp_min" in deficit.query_template
    service = catalog.entries[3]
    assert service.target.kind == "Service"
    assert service.target.name_label == "service"
    assert service.allowed_tools == ["get_service_network", "query_prometheus"]
    assert service.required_evidence == ["service_network"]
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
    assert readiness.required_evidence == ["workload", "pods", "events"]
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
    assert liveness.required_evidence == ["workload", "pods", "events"]
    liveness_panel = liveness.panels[0]
    assert liveness_panel.panel_id == "liveness-probe-restarts"
    assert liveness_panel.unit == "restarts"
    assert liveness_panel.threshold == 1.0
    assert liveness_panel.threshold_duration == "30s"
    pvc = catalog.entries[6]
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
    assert pvc.allowed_tools == ["get_pvc_storage", "query_prometheus"]
    assert pvc.required_evidence == ["pvc_storage"]
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
        '{"schemaVersion":6,"catalogVersion":"v1","alerts":[]}',
        (
            '{"schemaVersion":6,"catalogVersion":"v1","alerts":['
            '{"alertId":"A","displayName":"A","triggerSummary":"A",'
            '"rule":{"expression":"vector(1)","for":"1s"},'
            '"target":{"apiVersion":"v1","kind":"Pod",'
            '"clusterLabel":"same","namespaceLabel":"same",'
            '"nameLabel":"name"},"allowedTools":["get_workload"],'
            '"requiredEvidence":["workload"],"panels":[{"panelId":"panel-a",'
            '"title":"Panel A","unit":"pods","threshold":1.0,'
            '"riskDirection":"higher_is_worse","signalRole":"trigger",'
            '"thresholdDuration":"1s",'
            '"recommendedWindow":"15m","staleAfterSeconds":60,'
            '"queryTemplate":"metric{namespace="{{namespace}}",'
            'name="{{name}}"}"}]}]}'
        ),
        (
            '{"schemaVersion":6,"schemaVersion":6,"catalogVersion":"v1",'
            '"alerts":[{"alertId":"A","displayName":"A",'
            '"triggerSummary":"A","rule":{"expression":"vector(1)",'
            '"for":"1s"},"target":{"apiVersion":"v1",'
            '"kind":"Pod","clusterLabel":"cluster",'
            '"namespaceLabel":"namespace","nameLabel":"name"},'
            '"panels":[{"panelId":"panel-a","title":"Panel A",'
            '"unit":"pods","threshold":1.0,'
            '"riskDirection":"higher_is_worse","signalRole":"trigger",'
            '"thresholdDuration":"1s",'
            '"recommendedWindow":"15m",'
            '"staleAfterSeconds":60,"queryTemplate":'
            '"metric{namespace="{{namespace}}",name="{{name}}"}"}]}]}'
        ),
        (
            '{"schema_version":6,"catalogVersion":"v1","alerts":['
            '{"alertId":"A","displayName":"A","triggerSummary":"A",'
            '"rule":{"expression":"vector(1)","for":"1s"},'
            '"target":{"apiVersion":"v1","kind":"Pod",'
            '"clusterLabel":"cluster","namespaceLabel":"namespace",'
            '"nameLabel":"name"},"panels":[{"panelId":"panel-a",'
            '"title":"Panel A","unit":"pods","threshold":1.0,'
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
        "schemaVersion": 6,
        "catalogVersion": "v1",
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
                "allowedTools": ["get_workload"],
                "requiredEvidence": ["workload"],
                "panels": [
                    {
                        "panelId": "panel-a",
                        "title": "Panel A",
                        "unit": "replicas",
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


def test_catalog_rejects_higher_risk_without_a_static_threshold() -> None:
    with pytest.raises(ValueError, match="Higher-is-worse"):
        MetricPanelContract.model_validate(
            {
                "panelId": "panel-a",
                "title": "Panel A",
                "unit": "pods",
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
        "schemaVersion": 6,
        "catalogVersion": "v1",
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
                "allowedTools": ["get_workload"],
                "requiredEvidence": ["workload"],
                "panels": [
                    {
                        "panelId": "panel-a",
                        "title": "Panel A",
                        "unit": "pods",
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
