import json
from pathlib import Path

import pytest

from k8s_incident_agent.monitoring.catalog import load_alert_catalog
from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT


def test_production_catalog_has_one_stable_stage_two_entry() -> None:
    catalog = load_alert_catalog(REPOSITORY_ROOT / "monitoring" / "catalog")

    assert catalog.version == "2026-09-02.3"
    assert [entry.alert_id for entry in catalog.entries] == [
        "K8sIncidentImagePullBackOff"
    ]
    assert catalog.entries[0].target.model_dump() == {
        "api_version": "apps/v1",
        "kind": "Deployment",
        "cluster_label": "cluster",
        "namespace_label": "namespace",
        "name_label": "deployment",
    }
    assert catalog.entries[0].rule.for_duration == "30s"
    assert "kube_pod_container_status_waiting_reason" in (
        catalog.entries[0].rule.expression
    )
    assert catalog.panel_ids == (
        "image-pull-affected-pods",
        "image-pull-waiting-containers",
    )
    assert catalog.entries[0].panels[0].model_dump() == {
        "panel_id": "image-pull-affected-pods",
        "title": "Affected pods",
        "unit": "pods",
        "threshold": 1.0,
        "recommended_window": "15m",
        "stale_after_seconds": 60,
        "query_template": catalog.entries[0].panels[0].query_template,
    }
    for panel in catalog.entries[0].panels:
        assert " or (max(kube_replicaset_owner{" in panel.query_template
        assert panel.query_template.endswith("}) * 0)")


@pytest.mark.parametrize(
    "document",
    [
        '{"schemaVersion":3,"catalogVersion":"v1","alerts":[]}',
        (
            '{"schemaVersion":3,"catalogVersion":"v1","alerts":['
            '{"alertId":"A","displayName":"A","triggerSummary":"A",'
            '"rule":{"expression":"vector(1)","for":"1s"},'
            '"target":{"apiVersion":"v1","kind":"Pod",'
            '"clusterLabel":"same","namespaceLabel":"same",'
            '"nameLabel":"name"},"panels":[{"panelId":"panel-a",'
            '"title":"Panel A","unit":"pods","threshold":1.0,'
            '"recommendedWindow":"15m","staleAfterSeconds":60,'
            '"queryTemplate":"metric{namespace="{{namespace}}",'
            'name="{{name}}"}"}]}]}'
        ),
        (
            '{"schemaVersion":3,"schemaVersion":3,"catalogVersion":"v1",'
            '"alerts":[{"alertId":"A","displayName":"A",'
            '"triggerSummary":"A","rule":{"expression":"vector(1)",'
            '"for":"1s"},"target":{"apiVersion":"v1",'
            '"kind":"Pod","clusterLabel":"cluster",'
            '"namespaceLabel":"namespace","nameLabel":"name"},'
            '"panels":[{"panelId":"panel-a","title":"Panel A",'
            '"unit":"pods","threshold":1.0,"recommendedWindow":"15m",'
            '"staleAfterSeconds":60,"queryTemplate":'
            '"metric{namespace="{{namespace}}",name="{{name}}"}"}]}]}'
        ),
        (
            '{"schema_version":3,"catalogVersion":"v1","alerts":['
            '{"alertId":"A","displayName":"A","triggerSummary":"A",'
            '"rule":{"expression":"vector(1)","for":"1s"},'
            '"target":{"apiVersion":"v1","kind":"Pod",'
            '"clusterLabel":"cluster","namespaceLabel":"namespace",'
            '"nameLabel":"name"},"panels":[{"panelId":"panel-a",'
            '"title":"Panel A","unit":"pods","threshold":1.0,'
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


def test_catalog_rejects_mapping_label_outside_webhook_key_budget(
    tmp_path: Path,
) -> None:
    catalog_dir = tmp_path / "catalog"
    catalog_dir.mkdir()
    document = {
        "schemaVersion": 3,
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
                "panels": [
                    {
                        "panelId": "panel-a",
                        "title": "Panel A",
                        "unit": "pods",
                        "threshold": 1.0,
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
