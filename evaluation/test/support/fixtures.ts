import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

export const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
export const DATASET_PATH = path.join(REPOSITORY_ROOT, "evaluation/datasets/regression-v1.json");

export interface MutableCase {
  scenario_id: string;
  scenario_version: number;
  split: string;
  mechanism: string;
  source_group: string;
  expected_terminal: { outcome?: unknown; error_code?: unknown; [extra: string]: unknown };
  profiles: string[];
  alert_wait_seconds: number;
  [extra: string]: unknown;
}

export interface MutableManifest {
  schema_version: unknown;
  dataset_id: unknown;
  dataset_version: unknown;
  cases: MutableCase[];
}

export function temporaryDirectory(t: TestContext, prefix: string): string {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// A copy of the committed dataset with one mutation applied, in its own directory.
export function datasetFile(t: TestContext, mutate: (manifest: MutableManifest) => void): string {
  const manifest = JSON.parse(readFileSync(DATASET_PATH, "utf8")) as MutableManifest;
  mutate(manifest);
  const filename = path.join(temporaryDirectory(t, "evaluation-dataset-"), "dataset.json");
  writeFileSync(filename, JSON.stringify(manifest));
  return filename;
}

// A catalog directory holding one dataset-era case cloned from the crash-loop scenario.
export function caseCatalog(t: TestContext, caseId = "case-001"): string {
  const catalog = temporaryDirectory(t, "evaluation-catalog-");
  const directory = path.join(catalog, caseId);
  cpSync(path.join(REPOSITORY_ROOT, "scenarios/crash-loop-backoff"), directory, { recursive: true });
  const definitionPath = path.join(directory, "scenario.json");
  const definition = JSON.parse(readFileSync(definitionPath, "utf8")) as Record<string, unknown> & {
    target: Record<string, unknown>;
  };
  definition.scenario_id = caseId;
  definition.scenario_version = 1;
  definition.target.name = caseId;
  definition.display_name = "Scenario 001";
  definition.description = "A Deployment is unavailable.";
  definition.expected_root_causes = ["private-oracle-canary"];
  writeFileSync(definitionPath, JSON.stringify(definition));
  const manifests = path.join(directory, "manifests");
  for (const name of readdirSync(manifests)) {
    const filename = path.join(manifests, name);
    writeFileSync(filename, readFileSync(filename, "utf8").replaceAll("crash-loop-backoff", caseId));
  }
  return catalog;
}
