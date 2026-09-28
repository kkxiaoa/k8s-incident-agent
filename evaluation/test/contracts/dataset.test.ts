import assert from "node:assert/strict";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  loadEvaluationDataset,
  loadEvaluationScenarioCatalog,
  requireEvaluationCatalog,
  type EvaluationScenario,
} from "../../src/contracts/dataset.ts";
import { EvaluationError } from "../../src/shared/errors.ts";
import { caseCatalog, datasetFile, REPOSITORY_ROOT, type MutableManifest } from "../support/fixtures.ts";

const catalog = loadEvaluationScenarioCatalog(REPOSITORY_ROOT);

function coded(code: string) {
  return (error: unknown) => error instanceof EvaluationError && error.code === code;
}

// Contract violations fold into one fixed message, so a rejected manifest never echoes its content.
function rejectsDataset(file: string): void {
  assert.throws(() => loadEvaluationDataset(REPOSITORY_ROOT, catalog, file), (error: unknown) => {
    assert.ok(error instanceof EvaluationError);
    assert.equal(error.code, "evaluation_dataset_invalid");
    assert.equal(error.message, "Evaluation dataset does not satisfy the versioned scenario contract");
    return true;
  });
}

function unchangedDataset(t: TestContext): string {
  return datasetFile(t, () => {});
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

test("every manifest rule rejects its own violation", async (t) => {
  const mutations: Array<[string, (manifest: MutableManifest) => void]> = [
    ["schema revision", (m) => { m.schema_version = 2; }],
    ["dataset version type", (m) => { m.dataset_version = "1"; }],
    ["dataset version below one", (m) => { m.dataset_version = 0; }],
    ["dataset id type", (m) => { m.dataset_id = null; }],
    ["unsafe dataset id", (m) => { m.dataset_id = "../private"; }],
    ["empty cases", (m) => { m.cases = []; }],
    ["extra manifest field", (m) => { (m as unknown as Record<string, unknown>).notes = "x"; }],
    ["extra case field", (m) => { m.cases[0].target = { namespace: "default" }; }],
    ["missing case field", (m) => { delete (m.cases[0] as Record<string, unknown>).mechanism; }],
    ["duplicate case", (m) => { m.cases.push(m.cases[0]); }],
    ["unknown scenario", (m) => { m.cases[0].scenario_id = "case-999"; }],
    ["unsafe scenario id", (m) => { m.cases[0].scenario_id = "Crash-Loop"; }],
    ["unsafe mechanism", (m) => { m.cases[0].mechanism = "Image-Pull"; }],
    ["unsafe source group", (m) => { m.cases[0].source_group = "../legacy"; }],
    ["scenario revision", (m) => { m.cases[0].scenario_version = 999; }],
    ["unknown split", (m) => { m.cases[0].split = "validation"; }],
    ["source group reused across splits", (m) => { m.cases[2].split = "development"; }],
    ["unknown outcome", (m) => { m.cases[0].expected_terminal.outcome = "passed"; }],
    ["failure without an error code", (m) => { m.cases[0].expected_terminal = { outcome: "failed" }; }],
    ["failure with an unsafe error code", (m) => { m.cases[0].expected_terminal = { outcome: "failed", error_code: "Model-Output" }; }],
    ["diagnosed with an error code", (m) => { m.cases[0].expected_terminal = { outcome: "diagnosed", error_code: "x" }; }],
    ["outcome with an extra field", (m) => { m.cases[0].expected_terminal.answer = "private"; }],
    ["outcome that is not an object", (m) => { (m.cases[0] as Record<string, unknown>).expected_terminal = "diagnosed"; }],
    ["profile outside the execution profiles", (m) => { m.cases[0].profiles = ["k3s-public"]; }],
    ["empty profiles", (m) => { m.cases[0].profiles = []; }],
    ["duplicate profiles", (m) => { m.cases[0].profiles = ["kind-evaluation", "kind-evaluation"]; }],
    ["alert wait above the bound", (m) => { m.cases[0].alert_wait_seconds = 1801; }],
    ["zero alert wait", (m) => { m.cases[0].alert_wait_seconds = 0; }],
    ["fractional alert wait", (m) => { m.cases[0].alert_wait_seconds = 1.5; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, (subtest) => rejectsDataset(datasetFile(subtest, mutate)));
  }
});

// Apart from the missing and malformed cases, each file holds the valid committed manifest, so only the rule under test can reject it.
test("the dataset file must be a bounded regular JSON file reached without symbolic links", async (t) => {
  await t.test("an explicit copy loads exactly like the default path", (subtest) => {
    assert.deepEqual(loadEvaluationDataset(REPOSITORY_ROOT, catalog, unchangedDataset(subtest)), loadEvaluationDataset(REPOSITORY_ROOT, catalog));
  });
  await t.test("symbolic link", (subtest) => {
    const file = unchangedDataset(subtest);
    const linked = path.join(path.dirname(file), "linked.json");
    symlinkSync(file, linked);
    rejectsDataset(linked);
  });
  await t.test("symbolic link as a directory component", (subtest) => {
    const file = unchangedDataset(subtest);
    const linkedDirectory = path.join(path.dirname(file), "..", `${path.basename(path.dirname(file))}-link`);
    symlinkSync(path.dirname(file), linkedDirectory);
    subtest.after(() => rmSync(linkedDirectory));
    rejectsDataset(path.join(linkedDirectory, path.basename(file)));
  });
  await t.test("oversized file", (subtest) => {
    const file = unchangedDataset(subtest);
    writeFileSync(file, `${readFileSync(file, "utf8")}${" ".repeat(1024 * 1024)}`);
    rejectsDataset(file);
  });
  await t.test("non-JSON extension", (subtest) => {
    const file = unchangedDataset(subtest);
    const renamed = path.join(path.dirname(file), "dataset.txt");
    writeFileSync(renamed, readFileSync(file, "utf8"));
    rejectsDataset(renamed);
  });
  await t.test("missing file", (subtest) => {
    rejectsDataset(path.join(path.dirname(unchangedDataset(subtest)), "absent.json"));
  });
  await t.test("malformed JSON", (subtest) => {
    const file = unchangedDataset(subtest);
    writeFileSync(file, "{not json");
    rejectsDataset(file);
  });
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
