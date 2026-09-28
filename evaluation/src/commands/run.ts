import path from "node:path";

import { planCampaign, writeEvaluationArtifact, writeTrialPackage as writeTrialPackageRecord } from "../campaign/records.ts";
import {
  DATASET_SPLITS,
  EXECUTION_PROFILES,
  loadEvaluationDataset,
  loadEvaluationScenarioCatalog,
  requireEvaluationCatalog,
  type EvaluationCase,
  type EvaluationScenario,
  type ExecutionProfile,
} from "../contracts/dataset.ts";
import {
  CATALOG_ARTIFACT_SCHEMA_VERSION,
  type Campaign,
  type CatalogArtifact,
  type InfrastructureResult,
  type OnlineArtifact,
  type ScenarioResult,
} from "../contracts/records.ts";
import {
  adaptDeploymentExecutor,
  defaultDeploymentStatusCheck,
  defaultScenarioRunner,
  executeExternalCommand,
  loadReleaseManifest,
  type DeploymentStatusCheck,
  type Execute,
  type ScenarioRunner,
} from "../environment/commands.ts";
import type { FetchLike } from "../environment/http.ts";
import { operatorFetch } from "../environment/operator-session.ts";
import { openPortForwards, type Tunnels } from "../environment/tunnels.ts";
import { coverageReport, notRunScenarioResult } from "../lifecycle/coverage.ts";
import { runInfrastructureProbe, waitForHealthyMonitoring } from "../lifecycle/infrastructure-probe.ts";
import type { TrialPackageWriter } from "../lifecycle/review-package.ts";
import { runTrial, runtimeReaders } from "../lifecycle/trial.ts";
import { contractError, invalidArguments, safeFailure } from "../shared/errors.ts";
import { isNormalizedString, requireDate } from "../shared/guards.ts";
import type { Sleep } from "../shared/wait.ts";

const KIND_CONTEXT = "kind-k8s-incident-agent";
// Scenario runs target the manual-intake profiles; the online boundary targets the public one.
const PROFILES: ReadonlySet<string> = new Set([...EXECUTION_PROFILES, "k3s-public"]);

type EvaluationProfile = ExecutionProfile | "k3s-public";

export interface RunRequest {
  profile?: string;
  context?: string;
  releasePath?: string;
  datasetPath?: string;
  split?: string;
  scenarioIds?: readonly string[];
  retryOf?: string;
}

// Every external system the command touches can be replaced; the defaults are the real ones.
export interface SessionDependencies {
  repositoryRoot?: string;
  environment?: Record<string, string | undefined>;
  now?: () => Date;
  sleep?: Sleep;
  fetch?: FetchLike;
  execute?: Execute;
  verifyDeploymentStatus?: DeploymentStatusCheck;
  openTunnels?: (context: string, dependencies: { fetchImpl: FetchLike; sleep: Sleep }) => Promise<Tunnels>;
  writeArtifact?: (repositoryRoot: string, profile: string, artifact: CatalogArtifact | OnlineArtifact) => Promise<string>;
}

export interface RunDependencies extends SessionDependencies {
  scenarios?: EvaluationScenario[];
  runScenarioCommand?: ScenarioRunner;
  writeTrialPackage?: TrialPackageWriter;
  campaignSuffix?: () => string;
}

interface EvaluationSession {
  repositoryRoot: string;
  now: () => Date;
  sleep: Sleep;
  fetchImpl: FetchLike;
  execute: Execute;
  environment: Record<string, string | undefined>;
  deploymentStatus: DeploymentStatusCheck;
  openTunnels: NonNullable<SessionDependencies["openTunnels"]>;
  writeArtifact: NonNullable<SessionDependencies["writeArtifact"]>;
}

function defaultRepositoryRoot(): string {
  return path.resolve(import.meta.dirname, "../../..");
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function requireProfile(profile: unknown): EvaluationProfile {
  if (typeof profile !== "string" || !PROFILES.has(profile)) throw invalidArguments();
  return profile as EvaluationProfile;
}

export function resolveContext(profile: EvaluationProfile, context: unknown): string {
  if (profile === "kind-evaluation") {
    if (context !== undefined) throw invalidArguments();
    return KIND_CONTEXT;
  }
  if (!isNormalizedString(context) || context.startsWith("-")) throw invalidArguments();
  return context;
}

export function resolveSession(dependencies: SessionDependencies): EvaluationSession {
  return {
    repositoryRoot: path.resolve(dependencies.repositoryRoot ?? defaultRepositoryRoot()),
    now: dependencies.now ?? (() => new Date()),
    sleep: dependencies.sleep ?? defaultSleep,
    fetchImpl: dependencies.fetch ?? globalThis.fetch,
    execute: dependencies.execute ?? executeExternalCommand,
    environment: dependencies.environment ?? process.env,
    deploymentStatus: dependencies.verifyDeploymentStatus ?? defaultDeploymentStatusCheck,
    openTunnels: dependencies.openTunnels ?? openPortForwards,
    writeArtifact: dependencies.writeArtifact ?? writeEvaluationArtifact,
  };
}

// The live steps every command shares: the deployment must match the release before any
// forward is opened, and the forwards outlive nothing but the command itself.
export async function openGatedTunnels(
  profile: EvaluationProfile,
  context: string,
  release: CatalogArtifact["release"],
  session: EvaluationSession,
): Promise<Tunnels> {
  await session.deploymentStatus(profile, context, {
    repositoryRoot: session.repositoryRoot,
    release,
    execute: adaptDeploymentExecutor(session.execute),
  });
  return session.openTunnels(context, { fetchImpl: session.fetchImpl, sleep: session.sleep });
}

interface CatalogOptions {
  profile: ExecutionProfile;
  context: string;
  release: CatalogArtifact["release"];
  startedAt: string;
  completedAt: () => string;
  scenarios: EvaluationCase[];
  dataset: { id: string; version: number };
  campaign: Campaign;
  focused: boolean;
  selectedScenarioIds: string[];
  scenarioRunner: ScenarioRunner;
  repositoryRoot: string;
  execute: Execute;
  fetchImpl: FetchLike;
  sleep: Sleep;
  tunnels: Tunnels;
  now: () => Date;
  writeTrialPackage: TrialPackageWriter;
}

async function evaluateCatalog(options: CatalogOptions): Promise<CatalogArtifact> {
  const initialHealth = await waitForHealthyMonitoring(runtimeReaders(options.fetchImpl).runtime, options.sleep);
  const results: ScenarioResult[] = [];
  for (const scenario of options.scenarios) {
    results.push(
      options.selectedScenarioIds.includes(scenario.scenarioId)
        ? await runTrial(scenario, options)
        : notRunScenarioResult(scenario, scenario.profiles.includes(options.profile) ? "not_selected" : "profile_not_supported"),
    );
  }

  const passedScenarios = results.filter((result) => result.status === "pending_manual_review");
  let infrastructure: InfrastructureResult;
  if (options.focused) {
    infrastructure = { status: "not_run", reason: "focused_evaluation" };
  } else if (passedScenarios.length === 0) {
    infrastructure = { status: "not_run", reason: "no_scenario_passed" };
  } else {
    try {
      infrastructure = await runInfrastructureProbe(passedScenarios[passedScenarios.length - 1], options);
    } catch (error) {
      infrastructure = { status: "failed", failure: safeFailure(error) };
    }
  }

  const passed =
    passedScenarios.length === options.selectedScenarioIds.length &&
    (options.focused || infrastructure.status === "passed");
  return {
    schemaVersion: CATALOG_ARTIFACT_SCHEMA_VERSION,
    kind: "catalog-evaluation",
    profile: options.profile,
    release: options.release,
    startedAt: options.startedAt,
    completedAt: options.completedAt(),
    status: passed ? "pending_manual_review" : "failed",
    scope: options.focused ? "focused" : "full",
    selectedScenarioIds: options.selectedScenarioIds,
    dataset: { id: options.dataset.id, version: options.dataset.version },
    campaign: options.campaign,
    monitoring: { initialState: initialHealth.state, infrastructure },
    ...coverageReport(results),
  };
}

export async function runCatalogEvaluation(
  request: RunRequest,
  dependencies: RunDependencies = {},
): Promise<{ artifact: CatalogArtifact; artifactPath: string }> {
  const session = resolveSession(dependencies);
  const profile = requireProfile(request.profile);
  const context = resolveContext(profile, request.context);
  const catalog = dependencies.scenarios ?? loadEvaluationScenarioCatalog(session.repositoryRoot, session.environment);
  const scenarioRunner = dependencies.runScenarioCommand ?? defaultScenarioRunner;
  if (profile === "k3s-public") throw invalidArguments();
  if (request.split !== undefined && !(DATASET_SPLITS as readonly string[]).includes(request.split)) throw invalidArguments();
  if (request.split === "holdout") {
    throw contractError("evaluation_holdout_unavailable", "Holdout requires a private intake boundary");
  }
  requireEvaluationCatalog(catalog);
  const dataset = loadEvaluationDataset(session.repositoryRoot, catalog, request.datasetPath);
  const scenarios = dataset.cases;
  const eligible = scenarios.filter(
    (scenario) => scenario.profiles.includes(profile) && (request.split === undefined || scenario.split === request.split),
  );
  const scenarioIds = request.scenarioIds;
  if (
    scenarioIds !== undefined &&
    (!Array.isArray(scenarioIds) ||
      scenarioIds.length === 0 ||
      new Set(scenarioIds).size !== scenarioIds.length ||
      scenarioIds.some((id) => !eligible.some((scenario) => scenario.scenarioId === id)))
  ) {
    throw invalidArguments();
  }
  const selectedScenarioIds = scenarioIds === undefined ? eligible.map((scenario) => scenario.scenarioId) : [...scenarioIds];
  if (selectedScenarioIds.length === 0) throw invalidArguments();
  const focused = scenarioIds !== undefined || request.split !== undefined || selectedScenarioIds.length < scenarios.length;
  if (!isNormalizedString(request.releasePath)) throw invalidArguments();
  const release = await loadReleaseManifest(request.releasePath, session.repositoryRoot);
  const startedAt = requireDate(session.now()).toISOString();
  const campaign = await planCampaign(request, profile, dataset, startedAt, session.repositoryRoot, dependencies.campaignSuffix);
  const tunnels = await openGatedTunnels(profile, context, release, session);
  const completedAt = () => requireDate(session.now()).toISOString();
  let artifact: CatalogArtifact;
  try {
    try {
      const authenticatedFetch = await operatorFetch(session.fetchImpl, profile, session.environment);
      artifact = await evaluateCatalog({
        profile,
        context,
        release,
        startedAt,
        completedAt,
        scenarios,
        dataset,
        campaign,
        focused,
        selectedScenarioIds,
        scenarioRunner,
        repositoryRoot: session.repositoryRoot,
        execute: session.execute,
        fetchImpl: authenticatedFetch,
        sleep: session.sleep,
        tunnels,
        now: session.now,
        writeTrialPackage: dependencies.writeTrialPackage ?? writeTrialPackageRecord,
      });
    } catch (error) {
      artifact = {
        schemaVersion: CATALOG_ARTIFACT_SCHEMA_VERSION,
        kind: "catalog-evaluation",
        profile,
        release,
        startedAt,
        completedAt: completedAt(),
        status: "failed",
        scope: focused ? "focused" : "full",
        selectedScenarioIds,
        dataset: { id: dataset.id, version: dataset.version },
        campaign,
        ...coverageReport(scenarios.map((scenario) => notRunScenarioResult(scenario, "evaluation_aborted"))),
        failure: safeFailure(error),
      };
    }
  } finally {
    await tunnels.close();
  }
  const artifactPath = await session.writeArtifact(session.repositoryRoot, profile, artifact);
  return { artifact, artifactPath };
}
