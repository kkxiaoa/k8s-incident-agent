import assert from "node:assert/strict";
import test from "node:test";

import {
  loadEvaluationDataset,
  loadEvaluationScenarioCatalog,
  requireEvaluationCatalog,
  type EvaluationScenario,
} from "../../src/contracts/dataset.ts";
import { EvaluationError } from "../../src/shared/errors.ts";
import { caseCatalog, datasetFile, REPOSITORY_ROOT } from "../support/fixtures.ts";

const catalog = loadEvaluationScenarioCatalog(REPOSITORY_ROOT);

function coded(code: string) {
  return (error: unknown) => error instanceof EvaluationError && error.code === code;
}

test("the projection keeps the evaluation fields and leaves the private oracle behind", () => {
  const imagePull = catalog.find((scenario) => scenario.scenarioId === "image-pull-backoff");
  assert.ok(imagePull);
  assert.equal(imagePull.scenarioVersion, 5);
  assert.equal(imagePull.identityEvidence, "workload");
  assert.deepEqual(imagePull.expectedPatchConstraints, {
    action: "set_container_image",
    containerIndex: 0,
    containerName: "workload",
    currentImage: "registry.invalid/k8s-incident-agent/missing:v1",
    replacementImage:
      "registry.k8s.io/e2e-test-images/agnhost:2.53@sha256:99c6b4bb4a1e1df3f0b3752168c89358794d02258ebebc26bf21c29399011a85",
  });
  assert.equal(JSON.stringify(catalog).includes("expected_root_causes"), false);
  for (const scenario of catalog) {
    assert.ok(scenario.requiredEvidence.includes(scenario.identityEvidence));
    if (scenario.scenarioId !== "image-pull-backoff") assert.equal(scenario.expectedPatchConstraints, undefined);
  }
});

test("healthy control names follow the verifier kind of each committed scenario", () => {
  const byKind = (kind: EvaluationScenario["verifierKind"]) => catalog.filter((scenario) => scenario.verifierKind === kind);
  assert.equal(new Set(catalog.map((scenario) => scenario.verifierKind)).size, 6);
  assert.deepEqual(byKind("image_pull_backoff").map((scenario) => scenario.healthyControlNames), [[]]);
  assert.deepEqual(byKind("readiness_probe_failure").map((scenario) => scenario.healthyControlNames), [[
    "readiness-probe-misconfigured-healthy-control",
    "readiness-probe-misconfigured-slow-start-control",
  ]]);
  const pvc = byKind("pvc_pending");
  assert.equal(pvc.length, 2);
  for (const scenario of pvc) assert.deepEqual(scenario.healthyControlNames, [`${scenario.target.name}-wffc-control`]);
  for (const kind of ["crash_loop_backoff", "liveness_probe_failure", "service_selector_mismatch"] as const) {
    const [scenario, ...rest] = byKind(kind);
    assert.equal(rest.length, 0);
    assert.deepEqual(scenario.healthyControlNames, [`${scenario.target.name}-healthy-control`]);
  }
});

test("catalog failures surface as evaluation errors carrying the scenario script's code", (t) => {
  assert.throws(
    () => loadEvaluationScenarioCatalog(REPOSITORY_ROOT, { SCENARIO_CATALOG_DIR: `${caseCatalog(t)}/absent` }),
    coded("scenario_contract_invalid"),
  );
});

test("dataset rejections are typed evaluation errors without manifest content", (t) => {
  const file = datasetFile(t, (manifest) => { manifest.dataset_id = "sensitive-canary-id"; manifest.schema_version = 2; });
  assert.throws(() => loadEvaluationDataset(REPOSITORY_ROOT, catalog, file), (error: unknown) => {
    assert.ok(error instanceof EvaluationError);
    assert.equal(error.code, "evaluation_dataset_invalid");
    assert.doesNotMatch(error.message, /sensitive-canary/);
    return true;
  });
  const holdout = datasetFile(t, (manifest) => { manifest.cases[0].split = "holdout"; });
  assert.throws(() => loadEvaluationDataset(REPOSITORY_ROOT, catalog, holdout), coded("evaluation_holdout_unavailable"));
});

test("the committed dataset yields typed cases with millisecond budgets", () => {
  const dataset = loadEvaluationDataset(REPOSITORY_ROOT, catalog);
  assert.deepEqual({ id: dataset.id, version: dataset.version }, { id: "regression", version: 1 });
  for (const entry of dataset.cases) {
    assert.equal(entry.split, "regression");
    assert.ok(entry.alertWaitMilliseconds >= 1000 && entry.alertWaitMilliseconds % 1000 === 0);
    assert.ok(entry.profiles.every((profile) => ["kind-evaluation", "k3s-evaluation"].includes(profile)));
    assert.equal(entry.expectedTerminal.outcome, "diagnosed");
  }
});

test("the catalog gate accepts the committed catalog and rejects broken repair slices", () => {
  assert.doesNotThrow(() => requireEvaluationCatalog(catalog));
  const rejects = (mutate: (scenarios: EvaluationScenario[]) => void) => {
    const scenarios = structuredClone(catalog);
    mutate(scenarios);
    assert.throws(() => requireEvaluationCatalog(scenarios), coded("evaluation_catalog_invalid"));
  };
  assert.throws(() => requireEvaluationCatalog([]), coded("evaluation_catalog_invalid"));
  rejects((scenarios) => { scenarios.push(structuredClone(scenarios[0])); });
  rejects((scenarios) => { scenarios[0].scenarioVersion += 1; });
  rejects((scenarios) => { scenarios[0].requiredEvidence = []; });
  const imagePull = (scenarios: EvaluationScenario[]) => {
    const scenario = scenarios.find((entry) => entry.scenarioId === "image-pull-backoff");
    assert.ok(scenario?.expectedPatchConstraints);
    return scenario as EvaluationScenario & { expectedPatchConstraints: NonNullable<EvaluationScenario["expectedPatchConstraints"]> };
  };
  rejects((scenarios) => { imagePull(scenarios).expectedPatchConstraints.replacementImage = imagePull(scenarios).expectedPatchConstraints.currentImage; });
  rejects((scenarios) => { imagePull(scenarios).expectedPatchConstraints.containerIndex = 256; });
  rejects((scenarios) => { imagePull(scenarios).requiredEvidence = imagePull(scenarios).requiredEvidence.filter((kind) => kind !== "rollout_history"); });
  rejects((scenarios) => { imagePull(scenarios).target.kind = "StatefulSet"; });
  rejects((scenarios) => {
    (imagePull(scenarios).expectedPatchConstraints as unknown as Record<string, unknown>).extra = true;
  });
});
