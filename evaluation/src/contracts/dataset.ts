import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  loadScenarioCatalog,
  ScenarioCommandError,
  supportedScenarioVersion,
  type ScenarioCatalogEntry,
  type ScenarioDefinition,
  type VerifierKind,
} from "../../../scripts/scenario.mjs";
import {
  contractError,
  EvaluationError,
  producerError,
} from "../shared/errors.ts";
import {
  hasExactKeys,
  isNormalizedString,
  isPlainObject,
} from "../shared/guards.ts";

export const EXECUTION_PROFILES = ["kind-evaluation", "k3s-evaluation"] as const;
export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];

export const DATASET_SPLITS = ["development", "regression", "holdout"] as const;
export type DatasetSplit = (typeof DATASET_SPLITS)[number];

const DEFAULT_DATASET_PATH = "evaluation/datasets/regression-v1.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ALERT_WAIT_SECONDS = 1800;
// Scenarios whose supported version stayed at the default are dataset-era cases; the seven
// pre-dataset scenarios were all bumped past it and carry mechanism cues in their names.
const DEFAULT_SCENARIO_VERSION = 1;
const CASE_KEYS = [
  "scenario_id",
  "scenario_version",
  "split",
  "mechanism",
  "source_group",
  "expected_terminal",
  "profiles",
  "alert_wait_seconds",
] as const;
const REPAIR_CONSTRAINT_KEYS = [
  "action",
  "containerIndex",
  "containerName",
  "currentImage",
  "replacementImage",
] as const;

export interface ScenarioTarget {
  cluster: string;
  namespace: string;
  apiVersion: string;
  kind: string;
  name: string;
}

export interface ExpectedPatchConstraints {
  action: "set_container_image";
  containerIndex: number;
  containerName: string;
  currentImage: string;
  replacementImage: string;
}

export interface EvaluationScenario {
  scenarioId: string;
  scenarioVersion: number;
  alertId: string;
  target: ScenarioTarget;
  identityEvidence: string;
  requiredEvidence: string[];
  allowedTools: string[];
  forbiddenTools: string[];
  verifierKind: VerifierKind;
  healthyControlNames: string[];
  expectedPatchConstraints: ExpectedPatchConstraints | undefined;
}

export type ExpectedTerminal =
  | { outcome: "diagnosed" }
  | { outcome: "insufficient_evidence" }
  | { outcome: "failed"; errorCode: string };

export interface EvaluationCase extends EvaluationScenario {
  split: DatasetSplit;
  mechanism: string;
  sourceGroup: string;
  expectedTerminal: ExpectedTerminal;
  profiles: ExecutionProfile[];
  alertWaitMilliseconds: number;
  limitations: string[];
}

export interface EvaluationDataset {
  id: string;
  version: number;
  cases: EvaluationCase[];
}

export function loadEvaluationScenarioCatalog(
  repositoryRoot: string,
  environment: Record<string, string | undefined> = process.env,
): EvaluationScenario[] {
  let entries: ScenarioCatalogEntry[];
  try {
    entries = loadScenarioCatalog(repositoryRoot, environment);
  } catch (error) {
    if (error instanceof ScenarioCommandError) {
      throw producerError(error.code, error.message);
    }
    throw error;
  }
  return entries.map(({ definition }) => projectEvaluationScenario(definition));
}

// The private oracle (expected_root_causes) and the fixture manifests stay behind; only what
// the evaluator gates on is projected.
function projectEvaluationScenario(definition: ScenarioDefinition): EvaluationScenario {
  const constraints = definition.expected_patch_constraints;
  return {
    scenarioId: definition.scenario_id,
    scenarioVersion: definition.scenario_version,
    alertId: definition.monitoring_alert_id,
    target: {
      cluster: definition.target.cluster,
      namespace: definition.target.namespace,
      apiVersion: definition.target.api_version,
      kind: definition.target.kind,
      name: definition.target.name,
    },
    identityEvidence: definition.identity_evidence,
    requiredEvidence: [...definition.required_evidence],
    allowedTools: [...definition.allowed_tools],
    forbiddenTools: [...definition.forbidden_tools],
    verifierKind: definition.deterministic_verifier.kind,
    healthyControlNames: evaluationControlNames(definition),
    expectedPatchConstraints:
      constraints === undefined
        ? undefined
        : {
            action: constraints.action,
            containerIndex: constraints.container_index,
            containerName: constraints.container_name,
            currentImage: constraints.current_image,
            replacementImage: constraints.replacement_image,
          },
  };
}

function evaluationControlNames(definition: ScenarioDefinition): string[] {
  const verifierKind = definition.deterministic_verifier.kind;
  if (verifierKind === "image_pull_backoff") return [];
  if (verifierKind === "readiness_probe_failure") {
    return [
      `${definition.target.name}-healthy-control`,
      `${definition.target.name}-slow-start-control`,
    ];
  }
  if (verifierKind === "pvc_pending") {
    return [`${definition.target.name}-wffc-control`];
  }
  return [`${definition.target.name}-healthy-control`];
}

export function loadEvaluationDataset(
  repositoryRoot: string,
  scenarios: readonly EvaluationScenario[],
  datasetPath?: string,
): EvaluationDataset {
  try {
    const filename = path.resolve(repositoryRoot, datasetPath ?? DEFAULT_DATASET_PATH);
    if (path.extname(filename) !== ".json") reject();
    requireRegularFileWithoutSymlinkComponents(path.parse(filename).root, filename);
    const manifest: unknown = JSON.parse(readBoundedFile(filename));
    if (
      !hasExactKeys(manifest, ["schema_version", "dataset_id", "dataset_version", "cases"]) ||
      manifest.schema_version !== 1 ||
      !isNormalizedString(manifest.dataset_id) ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(manifest.dataset_id) ||
      !Number.isSafeInteger(manifest.dataset_version) ||
      (manifest.dataset_version as number) < 1 ||
      !Array.isArray(manifest.cases) ||
      manifest.cases.length === 0
    ) {
      reject();
    }
    const catalog = new Map(scenarios.map((scenario) => [scenario.scenarioId, scenario]));
    const seen = new Set<string>();
    const sourceSplits = new Map<string, string>();
    const cases = manifest.cases.map((entry: unknown): EvaluationCase => {
      if (!hasExactKeys(entry, CASE_KEYS)) reject();
      for (const value of [entry.scenario_id, entry.mechanism, entry.source_group]) {
        if (!isNormalizedString(value) || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(value)) reject();
      }
      const scenarioId = entry.scenario_id as string;
      const sourceGroup = entry.source_group as string;
      const split = entry.split;
      if (
        seen.has(scenarioId) ||
        !isDatasetSplit(split) ||
        (sourceSplits.has(sourceGroup) && sourceSplits.get(sourceGroup) !== split)
      ) {
        reject();
      }
      seen.add(scenarioId);
      sourceSplits.set(sourceGroup, split);
      // This catalog is shipped to the Runtime and exposed by its Scenario API.
      // A different label cannot make those inputs a private holdout.
      if (split === "holdout") {
        throw contractError(
          "evaluation_holdout_unavailable",
          "Holdout requires a private intake boundary, not the public scenario catalog",
        );
      }
      const scenario = catalog.get(scenarioId);
      if (scenario === undefined || scenario.scenarioVersion !== entry.scenario_version) reject();
      const profiles = entry.profiles;
      if (
        !isNonEmptyUniqueStringArray(profiles) ||
        !profiles.every(isExecutionProfile) ||
        !Number.isSafeInteger(entry.alert_wait_seconds) ||
        (entry.alert_wait_seconds as number) < 1 ||
        (entry.alert_wait_seconds as number) > MAX_ALERT_WAIT_SECONDS
      ) {
        reject();
      }
      return {
        ...scenario,
        split,
        mechanism: entry.mechanism as string,
        sourceGroup,
        expectedTerminal: requireExpectedTerminal(entry.expected_terminal),
        profiles: [...profiles],
        alertWaitMilliseconds: (entry.alert_wait_seconds as number) * 1000,
        limitations:
          supportedScenarioVersion(scenario.scenarioId) !== DEFAULT_SCENARIO_VERSION
            ? ["legacy_name_cues"]
            : [],
      };
    });
    return { id: manifest.dataset_id, version: manifest.dataset_version as number, cases };
  } catch (error) {
    if (error instanceof EvaluationError) throw error;
    throw contractError(
      "evaluation_dataset_invalid",
      "Evaluation dataset does not satisfy the versioned scenario contract",
    );
  }
}

export function requireEvaluationCatalog(scenarios: readonly EvaluationScenario[]): void {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw contractError(
      "evaluation_catalog_invalid",
      "Evaluation catalog must contain versioned scenarios",
    );
  }
  const scenarioIds = new Set<string>();
  for (const scenario of scenarios) {
    const expectedRepair: unknown = scenario?.expectedPatchConstraints;
    if (
      !isNormalizedString(scenario?.scenarioId) ||
      scenario.scenarioVersion !== supportedScenarioVersion(scenario.scenarioId) ||
      !isNormalizedString(scenario.alertId) ||
      !isPlainObject(scenario.target) ||
      !Array.isArray(scenario.requiredEvidence) ||
      scenario.requiredEvidence.length === 0 ||
      !Array.isArray(scenario.allowedTools) ||
      !Array.isArray(scenario.forbiddenTools) ||
      !Array.isArray(scenario.healthyControlNames) ||
      !(
        expectedRepair === undefined ||
        (hasExactKeys(expectedRepair, REPAIR_CONSTRAINT_KEYS) &&
          expectedRepair.action === "set_container_image" &&
          Number.isInteger(expectedRepair.containerIndex) &&
          (expectedRepair.containerIndex as number) >= 0 &&
          (expectedRepair.containerIndex as number) <= 255 &&
          isNormalizedString(expectedRepair.containerName) &&
          isNormalizedString(expectedRepair.currentImage) &&
          isNormalizedString(expectedRepair.replacementImage) &&
          expectedRepair.currentImage !== expectedRepair.replacementImage &&
          scenario.target.apiVersion === "apps/v1" &&
          scenario.target.kind === "Deployment" &&
          scenario.requiredEvidence.includes("workload") &&
          scenario.requiredEvidence.includes("rollout_history"))
      ) ||
      scenarioIds.has(scenario.scenarioId)
    ) {
      throw contractError(
        "evaluation_catalog_invalid",
        "Evaluation catalog does not satisfy the approved contract",
      );
    }
    scenarioIds.add(scenario.scenarioId);
  }
}

function reject(): never {
  throw new Error("dataset manifest rejected");
}

function isDatasetSplit(value: unknown): value is DatasetSplit {
  return typeof value === "string" && (DATASET_SPLITS as readonly string[]).includes(value);
}

function isExecutionProfile(value: string): value is ExecutionProfile {
  return (EXECUTION_PROFILES as readonly string[]).includes(value);
}

function isNonEmptyUniqueStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isNormalizedString) &&
    new Set(value).size === value.length
  );
}

function requireExpectedTerminal(value: unknown): ExpectedTerminal {
  if (!isPlainObject(value)) reject();
  if (value.outcome === "failed") {
    const code = value.error_code;
    if (
      !hasExactKeys(value, ["outcome", "error_code"]) ||
      typeof code !== "string" ||
      !/^[a-z][a-z0-9_]{0,127}$/.test(code)
    ) {
      reject();
    }
    return { outcome: "failed", errorCode: code };
  }
  if (!hasExactKeys(value, ["outcome"])) reject();
  if (value.outcome === "diagnosed" || value.outcome === "insufficient_evidence") {
    return { outcome: value.outcome };
  }
  return reject();
}

function requireRegularFileWithoutSymlinkComponents(root: string, filePath: string): void {
  const relative = path.relative(root, filePath);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    // lstat never reports a symbolic link as a file or a directory, so links are rejected here.
    const entry = lstatSync(current);
    if (current === filePath ? !entry.isFile() : !entry.isDirectory()) reject();
  }
}

function readBoundedFile(filePath: string): string {
  const entry = lstatSync(filePath);
  if (!entry.isFile() || entry.size > MAX_MANIFEST_BYTES) reject();
  return readFileSync(filePath, "utf8");
}
