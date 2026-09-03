import json
from pathlib import Path

import pytest

from k8s_incident_agent.monitoring.catalog import load_alert_catalog
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT


def test_production_catalog_has_specific_and_shared_deployment_entries() -> None:
    catalog = load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog")

    assert catalog.version == "2026-09-04.1"
    assert [entry.alert_id for entry in catalog.entries] == [
        "K8sIncidentImagePullBackOff",
        "K8sIncidentCrashLoopBackOff",
        "K8sIncidentDeploymentReplicasUnavailable",
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
    )
    assert catalog.entries[0].panels[0].model_dump() == {
        "panel_id": "image-pull-affected-pods",
        "title": "镜像拉取失败 Pod",
        "unit": "pods",
        "threshold": 1.0,
        "risk_direction": "higher_is_worse",
        "threshold_duration": "30s",
        "recommended_window": "15m",
        "stale_after_seconds": 60,
        "query_template": catalog.entries[0].panels[0].query_template,
    }
    available_replicas = catalog.entries[0].panels[1]
    assert available_replicas.unit == "replicas"
    assert available_replicas.threshold is None
    assert available_replicas.risk_direction == "lower_is_worse"
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


@pytest.mark.parametrize(
    "document",
    [
        '{"schemaVersion":5,"catalogVersion":"v1","alerts":[]}',
        (
            '{"schemaVersion":5,"catalogVersion":"v1","alerts":['
            '{"alertId":"A","displayName":"A","triggerSummary":"A",'
            '"rule":{"expression":"vector(1)","for":"1s"},'
            '"target":{"apiVersion":"v1","kind":"Pod",'
            '"clusterLabel":"same","namespaceLabel":"same",'
            '"nameLabel":"name"},"allowedTools":["get_workload"],'
            '"requiredEvidence":["workload"],"panels":[{"panelId":"panel-a",'
            '"title":"Panel A","unit":"pods","threshold":1.0,'
            '"riskDirection":"higher_is_worse","thresholdDuration":null,'
            '"recommendedWindow":"15m","staleAfterSeconds":60,'
            '"queryTemplate":"metric{namespace="{{namespace}}",'
            'name="{{name}}"}"}]}]}'
        ),
        (
            '{"schemaVersion":5,"schemaVersion":5,"catalogVersion":"v1",'
            '"alerts":[{"alertId":"A","displayName":"A",'
            '"triggerSummary":"A","rule":{"expression":"vector(1)",'
            '"for":"1s"},"target":{"apiVersion":"v1",'
            '"kind":"Pod","clusterLabel":"cluster",'
            '"namespaceLabel":"namespace","nameLabel":"name"},'
            '"panels":[{"panelId":"panel-a","title":"Panel A",'
            '"unit":"pods","threshold":1.0,'
            '"riskDirection":"higher_is_worse","thresholdDuration":null,'
            '"recommendedWindow":"15m",'
            '"staleAfterSeconds":60,"queryTemplate":'
            '"metric{namespace="{{namespace}}",name="{{name}}"}"}]}]}'
        ),
        (
            '{"schema_version":5,"catalogVersion":"v1","alerts":['
            '{"alertId":"A","displayName":"A","triggerSummary":"A",'
            '"rule":{"expression":"vector(1)","for":"1s"},'
            '"target":{"apiVersion":"v1","kind":"Pod",'
            '"clusterLabel":"cluster","namespaceLabel":"namespace",'
            '"nameLabel":"name"},"panels":[{"panelId":"panel-a",'
            '"title":"Panel A","unit":"pods","threshold":1.0,'
            '"riskDirection":"higher_is_worse","thresholdDuration":null,'
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


@pytest.mark.parametrize(
    ("risk_direction", "threshold"),
    [("higher_is_worse", None), ("lower_is_worse", 1.0)],
)
def test_catalog_rejects_thresholds_that_contradict_risk_direction(
    tmp_path: Path,
    risk_direction: str,
    threshold: float | None,
) -> None:
    document = {
        "schemaVersion": 5,
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
                        "threshold": threshold,
                        "riskDirection": risk_direction,
                        "thresholdDuration": None,
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

    with pytest.raises(ValueError, match="Alert catalog contract is invalid"):
        load_alert_catalog(catalog_dir)


def test_catalog_rejects_mapping_label_outside_webhook_key_budget(
    tmp_path: Path,
) -> None:
    catalog_dir = tmp_path / "catalog"
    catalog_dir.mkdir()
    document = {
        "schemaVersion": 5,
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
                        "thresholdDuration": None,
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
