import json
import shutil
from pathlib import Path
from typing import cast

import pytest

from k8s_incident_agent.runtime.paths import REPOSITORY_ROOT
from k8s_incident_agent.scenarios.catalog import load_scenario_catalog


def _catalog(tmp_path: Path) -> Path:
    target = tmp_path / "catalog"
    shutil.copytree(REPOSITORY_ROOT / "scenarios", target)
    return target


def _definition_path(catalog: Path) -> Path:
    return catalog / "image-pull-backoff" / "scenario.json"


def _definition(catalog: Path) -> dict[str, object]:
    value = cast(
        object,
        json.loads(_definition_path(catalog).read_text(encoding="utf-8")),
    )
    assert isinstance(value, dict)
    untyped = cast(dict[object, object], value)
    assert all(isinstance(key, str) for key in untyped)
    return {cast(str, key): item for key, item in untyped.items()}


def _write_definition(catalog: Path, value: dict[str, object]) -> None:
    _definition_path(catalog).write_text(json.dumps(value), encoding="utf-8")


def test_loads_full_producer_contract_and_returns_only_public_projection(
    tmp_path: Path,
) -> None:
    scenarios = load_scenario_catalog(_catalog(tmp_path))

    assert [scenario.scenario_id for scenario in scenarios] == [
        "crash-loop-backoff",
        "image-pull-backoff",
    ]
    scenario = next(
        item for item in scenarios if item.scenario_id == "image-pull-backoff"
    )
    assert scenario.model_dump(mode="json") == {
        "scenario_id": "image-pull-backoff",
        "scenario_version": 1,
        "monitoring_alert_id": "K8sIncidentImagePullBackOff",
        "display_name": "Image pull failure",
        "description": "A Deployment cannot pull its configured image.",
        "trigger": {
            "type": "manual",
            "summary": "The target Deployment is unavailable.",
        },
        "target": {
            "cluster": "k8s-incident-agent",
            "namespace": "k8s-incident-scenarios",
            "api_version": "apps/v1",
            "kind": "Deployment",
            "name": "image-pull-backoff",
        },
        "allowed_tools": [
            "get_workload",
            "get_pods",
            "get_events",
            "query_prometheus",
        ],
        "required_evidence": ["workload", "pods", "events"],
    }
    assert "expected_root_causes" not in scenario.model_dump()
    assert "deterministic_verifier" not in scenario.model_dump()
    crash_loop = next(
        item for item in scenarios if item.scenario_id == "crash-loop-backoff"
    )
    assert crash_loop.monitoring_alert_id == "K8sIncidentCrashLoopBackOff"
    assert crash_loop.allowed_tools == (
        "get_workload",
        "get_pods",
        "get_events",
        "get_container_logs",
        "query_prometheus",
    )
    assert crash_loop.required_evidence[-1] == "container_logs"


@pytest.mark.parametrize(
    "mutation",
    [
        "extra",
        "whitespace",
        "coercion",
        "duplicate",
        "overlap",
        "target",
    ],
)
def test_rejects_documents_outside_the_node_producer_contract(
    tmp_path: Path,
    mutation: str,
) -> None:
    catalog = _catalog(tmp_path)
    value = _definition(catalog)
    if mutation == "extra":
        value["unexpected"] = True
    elif mutation == "whitespace":
        value["description"] = " unnormalized"
    elif mutation == "coercion":
        value["scenario_version"] = "1"
    elif mutation == "duplicate":
        value["allowed_tools"] = ["get_workload", "get_workload"]
    elif mutation == "overlap":
        value["forbidden_tools"] = ["get_workload", "execute_shell"]
    else:
        target = value["target"]
        assert isinstance(target, dict)
        cast(dict[object, object], target)["namespace"] = "default"
    _write_definition(catalog, value)

    with pytest.raises(RuntimeError, match="Scenario catalog"):
        load_scenario_catalog(catalog)


@pytest.mark.parametrize("mutation", ["missing", "symlink", "oversized"])
def test_rejects_invalid_manifest_references(
    tmp_path: Path,
    mutation: str,
) -> None:
    catalog = _catalog(tmp_path)
    manifest = catalog / "image-pull-backoff" / "manifests" / "deployment.yaml"
    if mutation == "missing":
        manifest.unlink()
    elif mutation == "symlink":
        content = manifest.read_bytes()
        replacement = tmp_path / "external.yaml"
        replacement.write_bytes(content)
        manifest.unlink()
        manifest.symlink_to(replacement)
    else:
        manifest.write_bytes(b"x" * (1024 * 1024 + 1))

    with pytest.raises(RuntimeError, match="Scenario catalog"):
        load_scenario_catalog(catalog)


def test_rejects_catalog_paths_that_traverse_a_symlink(tmp_path: Path) -> None:
    real_catalog = _catalog(tmp_path)
    linked_catalog = tmp_path / "linked-catalog"
    linked_catalog.symlink_to(real_catalog, target_is_directory=True)

    with pytest.raises(RuntimeError, match="Scenario catalog"):
        load_scenario_catalog(linked_catalog)
