import { loadEvaluationDataset, type EvaluationCase } from "../../src/contracts/dataset.ts";
import type { Campaign } from "../../src/contracts/records.ts";
import type { FetchLike } from "../../src/environment/http.ts";
import { operatorFetch } from "../../src/environment/operator-session.ts";
import type { TrialEnvironment } from "../../src/lifecycle/trial.ts";
import { REPOSITORY_ROOT } from "../support/fixtures.ts";
import { createHarness, type Harness, type HarnessOptions } from "../support/harness.ts";

export const CAMPAIGN: Campaign = { id: "20260905T000000Z-0000aaaa", startedAt: "2026-09-05T00:00:00.000Z", retryOf: null };

export interface TrialFixture {
  harness: Harness;
  cases: EvaluationCase[];
  environment: TrialEnvironment;
}

// The Trial's environment exactly as the campaign command will assemble it from a harness; a
// fetch wrapper is installed before the operator session is opened, as a test would do with the
// harness's own dependency.
export async function trialFixture(
  options: HarnessOptions = {},
  wrapFetch: (fetch: FetchLike, harness: Harness) => FetchLike = (fetch) => fetch,
): Promise<TrialFixture> {
  const harness = createHarness(options);
  harness.dependencies.fetch = wrapFetch(harness.dependencies.fetch, harness);
  const fetchImpl = await operatorFetch(harness.dependencies.fetch, "kind-evaluation", harness.dependencies.environment);
  const cases = loadEvaluationDataset(REPOSITORY_ROOT, harness.dependencies.scenarios).cases;
  const environment: TrialEnvironment = {
    profile: "kind-evaluation",
    context: "kind-k8s-incident-agent",
    release: harness.release.manifest,
    repositoryRoot: REPOSITORY_ROOT,
    campaign: CAMPAIGN,
    fetchImpl,
    execute: harness.dependencies.execute,
    scenarioRunner: harness.dependencies.runScenarioCommand,
    sleep: harness.dependencies.sleep,
    now: harness.dependencies.now,
    writeTrialPackage: harness.dependencies.writeTrialPackage!,
  };
  return { harness, cases, environment };
}

export function caseNamed(cases: readonly EvaluationCase[], scenarioId: string, overrides: Partial<EvaluationCase> = {}): EvaluationCase {
  const entry = cases.find((candidate) => candidate.scenarioId === scenarioId);
  if (entry === undefined) throw new Error(`unknown scenario ${scenarioId}`);
  return { ...entry, ...overrides };
}
