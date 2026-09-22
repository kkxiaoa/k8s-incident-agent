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
        "liveness-probe-misconfigured",
        "pvc-binding-pending",
        "pvc-storage-class-missing",
        "readiness-probe-misconfigured",
        "service-selector-mismatch",
    ]
    scenario = next(
        item for item in scenarios if item.scenario_id == "image-pull-backoff"
    )
    assert scenario.model_dump(mode="json") == {
        "scenario_id": "image-pull-backoff",
        "scenario_version": 5,
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
    }
    assert "allowed_tools" not in scenario.model_dump()
    assert "required_evidence" not in scenario.model_dump()
    assert "forbidden_tools" not in scenario.model_dump()
    assert "expected_root_causes" not in scenario.model_dump()
    assert "deterministic_verifier" not in scenario.model_dump()
    assert "expected_patch_constraints" not in scenario.model_dump()
    assert "identity_evidence" not in scenario.model_dump()
    crash_loop = next(
        item for item in scenarios if item.scenario_id == "crash-loop-backoff"
    )
    assert crash_loop.monitoring_alert_id == "K8sIncidentCrashLoopBackOff"
    assert crash_loop.scenario_version == 3
    for scenario_id, alert_id in (
        ("readiness-probe-misconfigured", "K8sIncidentReadinessProbeFailure"),
        ("liveness-probe-misconfigured", "K8sIncidentLivenessProbeRestart"),
    ):
        probe = next(item for item in scenarios if item.scenario_id == scenario_id)
        assert probe.monitoring_alert_id == alert_id
        assert probe.scenario_version == 3

    for scenario_id in ("pvc-binding-pending", "pvc-storage-class-missing"):
        pvc = next(item for item in scenarios if item.scenario_id == scenario_id)
        assert pvc.monitoring_alert_id == ("K8sIncidentPersistentVolumeClaimPending")
        assert pvc.target.api_version == "v1"
        assert pvc.target.kind == "PersistentVolumeClaim"
        assert pvc.scenario_version == 2


@pytest.mark.parametrize(
    "mutation",
    [
        "extra",
        "dataset_metadata",
        "schema_version",
        "whitespace",
        "coercion",
        "duplicate",
        "overlap",
        "target",
        "verifier_timeout",
        "missing_patch_constraints",
        "invalid_patch_constraints",
        "capability_drift",
        "identity_drift",
        "identity_unrequired",
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
    elif mutation == "dataset_metadata":
        value["split"] = "holdout"
    elif mutation == "schema_version":
        value["schema_version"] = 4
    elif mutation == "whitespace":
        value["description"] = " unnormalized"
    elif mutation == "coercion":
        value["scenario_version"] = "1"
    elif mutation == "duplicate":
        value["allowed_tools"] = ["get_workload", "get_workload"]
    elif mutation == "overlap":
        value["forbidden_tools"] = ["get_workload", "execute_shell"]
    elif mutation == "target":
        target = value["target"]
        assert isinstance(target, dict)
        cast(dict[object, object], target)["namespace"] = "default"
    elif mutation == "verifier_timeout":
        verifier = value["deterministic_verifier"]
        assert isinstance(verifier, dict)
        cast(dict[object, object], verifier)["timeout_seconds"] = 300
    elif mutation == "missing_patch_constraints":
        del value["expected_patch_constraints"]
    elif mutation == "capability_drift":
        value["allowed_tools"] = ["get_workload", "query_prometheus"]
    elif mutation == "identity_drift":
        # Expected by the scenario, but not the identity Evidence of a Deployment.
        value["identity_evidence"] = "events"
    elif mutation == "identity_unrequired":
        # Correct for the target kind, yet absent from what the scenario expects.
        value["required_evidence"] = ["rollout_history", "pods", "events"]
    else:
        constraints = value["expected_patch_constraints"]
        assert isinstance(constraints, dict)
        cast(dict[object, object], constraints)["action"] = "arbitrary_patch"
    _write_definition(catalog, value)

    with pytest.raises(RuntimeError, match="Scenario catalog"):
        load_scenario_catalog(catalog)


@pytest.mark.parametrize(
    ("scenario_id", "scenario_version"),
    [("image-pull-backoff", 3), ("crash-loop-backoff", 2), ("pvc-binding-pending", 3)],
)
def test_rejects_versions_not_owned_by_the_exact_scenario(
    tmp_path: Path,
    scenario_id: str,
    scenario_version: int,
) -> None:
    catalog = _catalog(tmp_path)
    definition_path = catalog / scenario_id / "scenario.json"
    value = cast(dict[str, object], json.loads(definition_path.read_text()))
    value["scenario_version"] = scenario_version
    definition_path.write_text(json.dumps(value), encoding="utf-8")

    with pytest.raises(RuntimeError, match="Scenario catalog"):
        load_scenario_catalog(catalog)


@pytest.mark.parametrize(
    ("scenario_id", "version", "accepted"),
    [("case-001", 1, True), ("case-001", 2, False), ("new-root-cause", 1, False)],
)
def test_neutral_new_scenarios_keep_oracles_out_of_the_runtime_projection(
    tmp_path: Path, scenario_id: str, version: int, accepted: bool
) -> None:
    catalog = tmp_path / "catalog"
    directory = catalog / scenario_id
    shutil.copytree(REPOSITORY_ROOT / "scenarios" / "crash-loop-backoff", directory)
    definition_path = directory / "scenario.json"
    value = cast(dict[str, object], json.loads(definition_path.read_text()))
    value["scenario_id"] = scenario_id
    value["scenario_version"] = version
    value["display_name"] = "Scenario 001"
    value["description"] = "A Deployment is unavailable."
    value["expected_root_causes"] = ["private-oracle-canary"]
    cast(dict[str, object], value["target"])["name"] = scenario_id
    definition_path.write_text(json.dumps(value), encoding="utf-8")
    for filename in (directory / "manifests").iterdir():
        filename.write_text(
            filename.read_text().replace("crash-loop-backoff", scenario_id),
            encoding="utf-8",
        )
    if not accepted:
        with pytest.raises(RuntimeError, match="Scenario catalog"):
            load_scenario_catalog(catalog)
        return
    (scenario,) = load_scenario_catalog(catalog)
    assert scenario.scenario_id == "case-001"
    assert scenario.scenario_version == 1
    assert "private-oracle-canary" not in scenario.model_dump_json()
    assert "split" not in scenario.model_dump()


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
