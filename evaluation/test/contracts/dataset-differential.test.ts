import assert from "node:assert/strict";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  loadEvaluationDataset as baselineLoadDataset,
  loadEvaluationScenarioCatalog as baselineLoadCatalog,
} from "../../../scripts/scenario.mjs";
import {
  loadEvaluationDataset,
  loadEvaluationScenarioCatalog,
  type EvaluationScenario,
} from "../../src/contracts/dataset.ts";
import { caseCatalog, datasetFile, REPOSITORY_ROOT, type MutableManifest } from "../support/fixtures.ts";

type Outcome = { value: unknown } | { code: string };

function outcome(operation: () => unknown): Outcome {
  try {
    return { value: JSON.parse(JSON.stringify(operation())) };
  } catch (error) {
    assert.ok(error instanceof Error && "code" in error, "both implementations raise coded errors");
    return { code: String((error as { code: unknown }).code) };
  }
}

// Both loaders see the same catalog projection, so the comparison isolates the dataset rules.
function compareDataset(
  t: TestContext,
  catalog: { baseline: unknown[]; module: EvaluationScenario[] },
  mutate: (manifest: MutableManifest) => void,
  arrange: (file: string) => string = (file) => file,
) {
  const file = arrange(datasetFile(t, mutate));
  const baseline = outcome(() => baselineLoadDataset(REPOSITORY_ROOT, catalog.baseline, file));
  const candidate = outcome(() => loadEvaluationDataset(REPOSITORY_ROOT, catalog.module, file));
  assert.deepEqual(candidate, baseline);
  return candidate;
}

const committed = {
  baseline: baselineLoadCatalog(REPOSITORY_ROOT),
  module: loadEvaluationScenarioCatalog(REPOSITORY_ROOT),
};

test("the evaluation projection of the committed catalog matches the scenario script", () => {
  assert.equal(committed.module.length, 7);
  assert.deepEqual(JSON.parse(JSON.stringify(committed.module)), JSON.parse(JSON.stringify(committed.baseline)));
});

test("a dataset-era case projects and loads identically, without legacy limitations", (t) => {
  const environment = { SCENARIO_CATALOG_DIR: caseCatalog(t) };
  const catalog = {
    baseline: baselineLoadCatalog(REPOSITORY_ROOT, environment),
    module: loadEvaluationScenarioCatalog(REPOSITORY_ROOT, environment),
  };
  assert.deepEqual(JSON.parse(JSON.stringify(catalog.module)), JSON.parse(JSON.stringify(catalog.baseline)));
  const loaded = compareDataset(t, catalog, (manifest) => {
    manifest.cases = [{ ...manifest.cases[0], scenario_id: "case-001", scenario_version: 1 }];
  });
  assert.ok("value" in loaded);
  const dataset = loaded.value as { cases: Array<{ limitations: string[] }> };
  assert.deepEqual(dataset.cases[0].limitations, []);
});

test("an invalid catalog directory is refused with the scenario script's own code", (t) => {
  const environment = { SCENARIO_CATALOG_DIR: path.join(caseCatalog(t), "missing") };
  const baseline = outcome(() => baselineLoadCatalog(REPOSITORY_ROOT, environment));
  const candidate = outcome(() => loadEvaluationScenarioCatalog(REPOSITORY_ROOT, environment));
  assert.deepEqual(candidate, baseline);
  assert.deepEqual(candidate, { code: "scenario_contract_invalid" });
});

test("the committed dataset loads identically from the default and an explicit path", (t) => {
  const byDefault = outcome(() => loadEvaluationDataset(REPOSITORY_ROOT, committed.module));
  assert.deepEqual(byDefault, outcome(() => baselineLoadDataset(REPOSITORY_ROOT, committed.baseline)));
  const explicit = compareDataset(t, committed, () => {});
  assert.deepEqual(explicit, byDefault);
  assert.ok("value" in explicit);
  const dataset = explicit.value as { cases: Array<{ limitations: string[] }> };
  assert.equal(dataset.cases.length, 7);
  assert.ok(dataset.cases.every((entry) => entry.limitations.includes("legacy_name_cues")));
});

test("every manifest rejection produces the same code as the scenario script", async (t) => {
  const mutations: Array<[string, (manifest: MutableManifest) => void]> = [
    ["schema revision", (m) => { m.schema_version = 2; }],
    ["dataset version", (m) => { m.dataset_version = "1"; }],
    ["dataset version below one", (m) => { m.dataset_version = 0; }],
    ["dataset id type", (m) => { m.dataset_id = null; }],
    ["unsafe dataset id", (m) => { m.dataset_id = "../private"; }],
    ["empty cases", (m) => { m.cases = []; }],
    ["extra manifest field", (m) => { (m as unknown as Record<string, unknown>).notes = "x"; }],
    ["extra field", (m) => { m.cases[0].target = { namespace: "default" }; }],
    ["missing field", (m) => { delete (m.cases[0] as Record<string, unknown>).mechanism; }],
    ["duplicate case", (m) => { m.cases.push(m.cases[0]); }],
    ["unknown scenario", (m) => { m.cases[0].scenario_id = "case-999"; }],
    ["unsafe scenario id", (m) => { m.cases[0].scenario_id = "Crash-Loop"; }],
    ["scenario revision", (m) => { m.cases[0].scenario_version = 999; }],
    ["split", (m) => { m.cases[0].split = "validation"; }],
    ["cross-split ancestry", (m) => { m.cases[2].split = "development"; }],
    ["outcome", (m) => { m.cases[0].expected_terminal.outcome = "passed"; }],
    ["failure without code", (m) => { m.cases[0].expected_terminal = { outcome: "failed" }; }],
    ["failure with unsafe code", (m) => { m.cases[0].expected_terminal = { outcome: "failed", error_code: "Model-Output" }; }],
    ["diagnosed with code", (m) => { m.cases[0].expected_terminal = { outcome: "diagnosed", error_code: "x" }; }],
    ["outcome extra field", (m) => { m.cases[0].expected_terminal.answer = "private"; }],
    ["outcome not an object", (m) => { (m.cases[0] as Record<string, unknown>).expected_terminal = "diagnosed"; }],
    ["profile", (m) => { m.cases[0].profiles = ["k3s-public"]; }],
    ["empty profiles", (m) => { m.cases[0].profiles = []; }],
    ["duplicate profiles", (m) => { m.cases[0].profiles = ["kind-evaluation", "kind-evaluation"]; }],
    ["unbounded wait", (m) => { m.cases[0].alert_wait_seconds = 1801; }],
    ["zero wait", (m) => { m.cases[0].alert_wait_seconds = 0; }],
    ["fractional wait", (m) => { m.cases[0].alert_wait_seconds = 1.5; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, (subtest) => {
      assert.deepEqual(compareDataset(subtest, committed, mutate), { code: "evaluation_dataset_invalid" });
    });
  }
  await t.test("holdout", (subtest) => {
    assert.deepEqual(
      compareDataset(subtest, committed, (m) => { m.cases[0].split = "holdout"; }),
      { code: "evaluation_holdout_unavailable" },
    );
  });
});

test("file-level rejections match the scenario script", async (t) => {
  await t.test("symbolic link", (subtest) => {
    assert.deepEqual(compareDataset(subtest, committed, () => {}, (file) => {
      const linked = path.join(path.dirname(file), "linked.json");
      symlinkSync(file, linked);
      return linked;
    }), { code: "evaluation_dataset_invalid" });
  });
  await t.test("symbolic link as a directory component", (subtest) => {
    assert.deepEqual(compareDataset(subtest, committed, () => {}, (file) => {
      const linkedDirectory = path.join(path.dirname(file), "..", `${path.basename(path.dirname(file))}-link`);
      symlinkSync(path.dirname(file), linkedDirectory);
      subtest.after(() => rmSync(linkedDirectory));
      return path.join(linkedDirectory, path.basename(file));
    }), { code: "evaluation_dataset_invalid" });
  });
  await t.test("oversized file", (subtest) => {
    assert.deepEqual(compareDataset(subtest, committed, () => {}, (file) => {
      writeFileSync(file, "sensitive-canary".repeat(80_000));
      return file;
    }), { code: "evaluation_dataset_invalid" });
  });
  await t.test("non-JSON extension", (subtest) => {
    assert.deepEqual(compareDataset(subtest, committed, () => {}, (file) => {
      const renamed = path.join(path.dirname(file), "dataset.txt");
      writeFileSync(renamed, "{}");
      return renamed;
    }), { code: "evaluation_dataset_invalid" });
  });
  await t.test("missing file", (subtest) => {
    assert.deepEqual(
      compareDataset(subtest, committed, () => {}, (file) => path.join(path.dirname(file), "absent.json")),
      { code: "evaluation_dataset_invalid" },
    );
  });
  await t.test("malformed JSON", (subtest) => {
    assert.deepEqual(compareDataset(subtest, committed, () => {}, (file) => {
      writeFileSync(file, "{not json");
      return file;
    }), { code: "evaluation_dataset_invalid" });
  });
});
