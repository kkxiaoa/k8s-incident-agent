// Types for the scenario script's exports that the evaluation module consumes. The script stays
// JavaScript; the module's integration tests prove these declarations against its behaviour.
import type { ReleaseManifest } from "./release.mjs";

export type VerifierKind =
  | "image_pull_backoff"
  | "crash_loop_backoff"
  | "service_selector_mismatch"
  | "readiness_probe_failure"
  | "liveness_probe_failure"
  | "pvc_pending";

export interface ScenarioDefinitionTarget {
  cluster: string;
  namespace: string;
  api_version: string;
  kind: string;
  name: string;
}

export interface ScenarioPatchConstraints {
  action: "set_container_image";
  container_index: number;
  container_name: string;
  current_image: string;
  replacement_image: string;
}

export interface ScenarioDefinition {
  schema_version: number;
  scenario_id: string;
  scenario_version: number;
  monitoring_alert_id: string;
  display_name: string;
  description: string;
  trigger: { type: "manual"; summary: string };
  target: ScenarioDefinitionTarget;
  fixture_manifests: string[];
  expected_root_causes: string[];
  identity_evidence: string;
  required_evidence: string[];
  allowed_tools: string[];
  forbidden_tools: string[];
  deterministic_verifier: {
    kind: VerifierKind;
    timeout_seconds: number;
    poll_interval_seconds: number;
  };
  expected_patch_constraints?: ScenarioPatchConstraints;
}

export interface ScenarioCatalogEntry {
  definition: ScenarioDefinition;
  manifestPaths: string[];
}

export type ScenarioAction = "list" | "apply" | "verify" | "cleanup";

export interface ExternalCommandOptions {
  timeoutMilliseconds?: number;
  maxBufferBytes?: number;
}

export type ScenarioExecute = (
  command: string,
  args: readonly string[],
  options: ExternalCommandOptions,
) => Promise<string>;

export interface ScenarioCommandDependencies {
  repositoryRoot?: string;
  environment?: Record<string, string | undefined>;
  profile?: string;
  context?: string;
  release?: ReleaseManifest;
  releasePath?: string;
  execute?: ScenarioExecute;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class ScenarioCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function loadScenarioCatalog(
  repositoryRoot: string,
  environment?: Record<string, string | undefined>,
): ScenarioCatalogEntry[];

export function supportedScenarioVersion(scenarioId: string): number;

export function runScenarioCommand(
  action: ScenarioAction,
  scenarioId: string | undefined,
  dependencies?: ScenarioCommandDependencies,
): Promise<unknown>;

// Baseline evaluation projection and dataset loader, declared only for the differential tests
// that prove the module's re-implementation; both leave the script with the cutover.
export function loadEvaluationScenarioCatalog(
  repositoryRoot?: string,
  environment?: Record<string, string | undefined>,
): unknown[];

export function loadEvaluationDataset(
  repositoryRoot: string,
  scenarios: readonly unknown[],
  datasetPath?: string,
): unknown;
