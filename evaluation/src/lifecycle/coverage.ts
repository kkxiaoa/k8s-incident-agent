import type { EvaluationCase } from "../contracts/dataset.ts";
import type {
  CoverageReport,
  NotRunReason,
  ScenarioResult,
  ScenarioStatus,
} from "../contracts/records.ts";

// The five families the first evaluations reported on; each keeps its denominator even when a
// dataset selects only some of its scenarios.
const HISTORICAL_FAMILIES: ReadonlyMap<string, readonly string[]> = new Map([
  ["image-pull-backoff", ["image-pull-backoff"]],
  ["crash-loop-backoff", ["crash-loop-backoff"]],
  ["service-selector-mismatch", ["service-selector-mismatch"]],
  ["probe-misconfiguration", ["readiness-probe-misconfigured", "liveness-probe-misconfigured"]],
  ["pvc-pending", ["pvc-binding-pending", "pvc-storage-class-missing"]],
]);

// The orchestration decides the Trial and its outcome class; nothing here stands in for them.
export type PendingScenarioResult = Omit<ScenarioResult, "outcomeClass" | "trial">;

export function emptyScenarioResult(scenario: EvaluationCase): PendingScenarioResult {
  return {
    scenarioId: scenario.scenarioId,
    scenarioVersion: scenario.scenarioVersion,
    split: scenario.split,
    mechanism: scenario.mechanism,
    sourceGroup: scenario.sourceGroup,
    expectedTerminal: scenario.expectedTerminal,
    limitations: scenario.limitations,
    alertId: scenario.alertId,
    status: "failed",
    cleanup: "passed",
    reviewPackage: null,
    checks: {
      healthyBaseline: false,
      fixtureVerified: false,
      prometheusFiring: false,
      alertmanagerFiring: false,
      healthyControls: false,
      uniqueIncident: false,
      run: undefined,
      evidenceKinds: [],
      uncitedExpectedEvidence: [],
      diagnosisCodes: [],
      panels: [],
      sseReplay: undefined,
      consoleDetail: false,
      repair: undefined,
      repeatDeliveryDeduplicated: false,
      alertResolved: false,
      postResolutionPanelStates: [],
    },
  };
}

export function notRunScenarioResult(scenario: EvaluationCase, reason: NotRunReason): ScenarioResult {
  return { ...emptyScenarioResult(scenario), status: "not_run", outcomeClass: "not_run", trial: null, cleanup: "not_run", reason };
}

function coverageStatus(statuses: readonly ScenarioStatus[]): ScenarioStatus {
  return statuses.includes("failed") ? "failed" : statuses.includes("not_run") ? "not_run" : "pending_manual_review";
}

export function coverageReport(results: readonly ScenarioResult[]): CoverageReport {
  const grouped = new Map<string, ScenarioStatus[]>();
  for (const result of results) {
    const statuses = grouped.get(result.mechanism) ?? [];
    statuses.push(result.status);
    grouped.set(result.mechanism, statuses);
  }
  return {
    families: [...HISTORICAL_FAMILIES]
      .map(([familyId, ids]) => ({
        familyId,
        scenarios: ids.length,
        status: coverageStatus(ids.map((id) => results.find((result) => result.scenarioId === id)?.status ?? "not_run")),
      }))
      .sort((left, right) => left.familyId.localeCompare(right.familyId)),
    coverage: {
      plannedCases: results.length,
      notRunCases: results.filter((result) => result.status === "not_run").length,
      mechanisms: [...grouped]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([mechanism, statuses]) => ({ mechanism, cases: statuses.length, status: coverageStatus(statuses) })),
    },
    scenarios: [...results],
  };
}
