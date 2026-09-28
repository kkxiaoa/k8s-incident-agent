import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

export const CAMPAIGN = "20260905T000000Z-0000aaaa";
export const RUN = "20000000-0000-4000-8000-000000000001";
export const EVIDENCE = ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000002"];

export type LooseRecord = Record<string, unknown>;

export function scenario(overrides: LooseRecord = {}): LooseRecord {
  return {
    scenarioId: "crash-loop-backoff", scenarioVersion: 3, split: "regression", mechanism: "invalid-startup-command",
    sourceGroup: "legacy-crash-loop", expectedTerminal: { outcome: "diagnosed" }, limitations: [], alertId: "K8sIncidentCrashLoopBackOff",
    status: "pending_manual_review", outcomeClass: "pending_manual_review", cleanup: "passed",
    reviewPackage: "trials/crash-loop-backoff.json",
    trial: { index: 1, startedAt: "2026-09-05T00:00:00.000Z", completedAt: "2026-09-05T00:00:00.000Z" },
    incidentId: "10000000-0000-4000-8000-000000000001", runId: RUN,
    checks: { run: { attempt: 1, status: "COMPLETED", errorCode: null, retryable: null, outcome: "diagnosed" } },
    ...overrides,
  };
}

export function review(overrides: LooseRecord = {}): LooseRecord {
  return {
    schemaVersion: 1, campaignId: CAMPAIGN, scenarioId: "crash-loop-backoff", trial: 1, runId: RUN, rulesVersion: "rubric-draft-1",
    reviewer: "maintainer", reviewedAt: "2026-09-06T10:00:00Z", verdict: "pass", reasons: ["Both causal claims cite the workload evidence."],
    evidenceIds: [EVIDENCE[0]],
    ...overrides,
  };
}

export interface CampaignLayoutOptions {
  id?: string;
  scenarios?: readonly LooseRecord[];
  reviews?: readonly LooseRecord[];
  packages?: boolean;
  oversizedPackage?: boolean;
  status?: string;
  retryOf?: string | null;
  directory?: string;
}

// Lays out one campaign the way the evaluator writes it: <dir>/<id>.json beside <dir>/<id>/{trials,reviews}.
export function campaign(t: TestContext, options: CampaignLayoutOptions = {}): { root: string; file: string } {
  const { id = CAMPAIGN, scenarios = [scenario()], reviews = [], packages = true, oversizedPackage = false, status = "pending_manual_review", retryOf = null, directory } = options;
  const root = directory ?? mkdtempSync(path.join(tmpdir(), "evaluation-report-"));
  if (directory === undefined) t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifact = {
    schemaVersion: 4, kind: "catalog-evaluation", profile: "kind-evaluation",
    release: { schemaVersion: 1, sourceRevision: "a".repeat(40), images: {} },
    startedAt: "2026-09-05T00:00:00.000Z", completedAt: "2026-09-05T00:00:00.000Z", status, scope: "focused",
    selectedScenarioIds: scenarios.filter((entry) => entry.status !== "not_run").map((entry) => entry.scenarioId),
    dataset: { id: "regression", version: 1 },
    campaign: { id, startedAt: "2026-09-05T00:00:00.000Z", retryOf },
    coverage: {
      plannedCases: scenarios.length, notRunCases: scenarios.filter((entry) => entry.status === "not_run").length,
      mechanisms: [...new Set(scenarios.map((entry) => entry.mechanism))].map((mechanism) => ({ mechanism, cases: 1, status: "pending_manual_review" })),
    },
    scenarios,
  };
  const file = path.join(root, `${id}.json`);
  writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
  mkdirSync(path.join(root, id, "trials"), { recursive: true });
  mkdirSync(path.join(root, id, "reviews"), { recursive: true });
  if (oversizedPackage) {
    for (const entry of scenarios.filter((entry) => entry.reviewPackage)) {
      writeFileSync(path.join(root, id, entry.reviewPackage as string), `{"padding":"${"x".repeat(4 * 1024 * 1024)}"}`);
    }
  } else if (packages) {
    for (const entry of scenarios.filter((entry) => entry.reviewPackage)) {
      writeFileSync(path.join(root, id, entry.reviewPackage as string), JSON.stringify({
        schemaVersion: 1, campaignId: id, scenarioId: entry.scenarioId, trial: 1, incidentId: entry.incidentId, runId: entry.runId,
        capturedAt: "2026-09-05T00:00:00.000Z", truncated: false, events: [],
        incident: { evidence: EVIDENCE.map((evidenceId) => ({ id: evidenceId, evidenceKind: "workload" })), diagnosis: { outcome: "diagnosed" } },
      }));
    }
  }
  reviews.forEach((entry, index) => {
    writeFileSync(path.join(root, id, "reviews", `${entry.scenarioId}-${index}.json`), JSON.stringify(entry));
  });
  return { root, file };
}
