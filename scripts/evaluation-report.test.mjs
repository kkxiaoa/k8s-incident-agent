import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildCampaignReport } from "./evaluation-report.mjs";

const REPORT = path.join(path.dirname(fileURLToPath(import.meta.url)), "evaluation-report.mjs");
// Test-only capture of this implementation's reports as parity fixtures for the evaluation module.
const GOLDEN_DIRECTORY = process.env.EVALUATION_GOLDEN_DIR;
function recordGolden(name, value) {
  if (GOLDEN_DIRECTORY === undefined) return;
  writeFileSync(path.join(GOLDEN_DIRECTORY, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}
const CAMPAIGN = "20260905T000000Z-0000aaaa";
const RUN = "20000000-0000-4000-8000-000000000001";
const EVIDENCE = ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000002"];

function scenario(overrides = {}) {
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

function review(overrides = {}) {
  return {
    schemaVersion: 1, campaignId: CAMPAIGN, scenarioId: "crash-loop-backoff", trial: 1, runId: RUN, rulesVersion: "rubric-draft-1",
    reviewer: "maintainer", reviewedAt: "2026-09-06T10:00:00Z", verdict: "pass", reasons: ["Both causal claims cite the workload evidence."],
    evidenceIds: [EVIDENCE[0]],
    ...overrides,
  };
}

// Lays out one campaign the way the evaluator writes it: <dir>/<id>.json beside <dir>/<id>/{trials,reviews}.
function campaign(t, { id = CAMPAIGN, scenarios = [scenario()], reviews = [], packages = true, oversizedPackage = false, status = "pending_manual_review", retryOf = null, directory } = {}) {
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
      writeFileSync(path.join(root, id, entry.reviewPackage), `{"padding":"${"x".repeat(4 * 1024 * 1024)}"}`);
    }
  } else if (packages) {
    for (const entry of scenarios.filter((entry) => entry.reviewPackage)) {
      writeFileSync(path.join(root, id, entry.reviewPackage), JSON.stringify({
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

test("an unreviewed Trial stays pending and a bound verdict settles it", async (t) => {
  const pending = await buildCampaignReport(campaign(t).file);
  recordGolden("report-pending", pending);
  assert.equal(pending.status, "pending_manual_review");
  assert.deepEqual(pending.scenarios[0].review, { status: "pending_manual_review", reviewers: [] });
  assert.deepEqual(pending.review, { files: 0, unbound: 0, statuses: { pending_manual_review: 1 } });

  const reviewed = await buildCampaignReport(campaign(t, { reviews: [review(), review({ reviewer: "second", evidenceIds: EVIDENCE })] }).file);
  recordGolden("report-reviewed", reviewed);
  assert.equal(reviewed.status, "reviewed");
  assert.equal(reviewed.scenarios[0].review.status, "pass");
  assert.equal(reviewed.scenarios[0].review.rulesVersion, "rubric-draft-1");
  assert.deepEqual(reviewed.scenarios[0].review.reviewers.map((entry) => entry.reviewer), ["maintainer", "second"]);
  assert.deepEqual(reviewed.scenarios[0].reviewPackage, { truncated: false });
  assert.deepEqual(reviewed.mechanisms[0].review, { pass: 1 });
  assert.deepEqual(reviewed.outcomeClasses, { pending_manual_review: 1 });
  assert.deepEqual(reviewed.scenarios[0].run, { attempt: 1, status: "COMPLETED", errorCode: null, retryable: null, outcome: "diagnosed" });
});

test("reviewers who disagree leave the Trial unsettled rather than averaged", async (t) => {
  const report = await buildCampaignReport(campaign(t, { reviews: [review(), review({ reviewer: "second", verdict: "fail" })] }).file);
  assert.equal(report.scenarios[0].review.status, "disagreement");
  assert.equal(report.status, "pending_manual_review");
});

test("a verdict that is not bound to the exact Trial, Run, package and rules is incomplete", async (t) => {
  for (const [options, reasons] of [
    [{ reviews: [review({ runId: "20000000-0000-4000-8000-000000000009" })] }, ["trial_binding_mismatch"]],
    [{ reviews: [review({ trial: 2 })] }, ["trial_binding_mismatch"]],
    [{ reviews: [review({ campaignId: "20260901T000000Z-0123abcd" })] }, ["trial_binding_mismatch"]],
    [{ reviews: [review({ evidenceIds: ["30000000-0000-4000-8000-00000000ffff"] })] }, ["evidence_not_in_package"]],
    [{ reviews: [review()], packages: false }, ["review_package_missing"]],
    [{ reviews: [review()], oversizedPackage: true }, ["review_package_invalid"]],
    [{ reviews: [review(), review({ reviewer: "second", rulesVersion: "rubric-draft-2" })] }, ["rules_version_mismatch"]],
  ]) {
    const report = await buildCampaignReport(campaign(t, options).file);
    assert.equal(report.scenarios[0].review.status, "incomplete", JSON.stringify(options));
    assert.deepEqual(report.scenarios[0].review.reasons, reasons, JSON.stringify(options));
    assert.equal(report.status, "pending_manual_review");
  }
});

test("manual verdicts never apply to Trials whose automated gates failed or never ran", async (t) => {
  const failed = scenario({ status: "failed", outcomeClass: "outcome_mismatch", failure: { code: "terminal_outcome_mismatch", message: "m" } });
  const skipped = scenario({
    scenarioId: "image-pull-backoff", mechanism: "unpullable-image-reference", status: "not_run", outcomeClass: "not_run", trial: null,
    reviewPackage: null, checks: { run: undefined }, reason: "not_selected",
  });
  const { file } = campaign(t, { scenarios: [failed, skipped], reviews: [review(), review({ scenarioId: "other-case" })], status: "failed" });
  const report = await buildCampaignReport(file);
  assert.equal(report.status, "failed");
  assert.equal(report.scenarios[0].review.status, "not_applicable");
  assert.equal(report.scenarios[0].review.reviewers.length, 1);
  assert.equal(report.scenarios[0].failure.code, "terminal_outcome_mismatch");
  assert.deepEqual(report.scenarios[1].review, { status: "not_run" });
  assert.equal(report.scenarios[1].reviewPackage, "missing");
  assert.deepEqual(report.review, { files: 2, unbound: 1, statuses: { not_applicable: 1, not_run: 1 } });
});

test("a retry chain is followed through sibling records and a broken link is reported", async (t) => {
  const first = campaign(t, { id: "20260901T000000Z-0000aaaa" });
  campaign(t, { id: "20260902T000000Z-0000bbbb", retryOf: "20260901T000000Z-0000aaaa", directory: first.root });
  const third = campaign(t, { id: "20260903T000000Z-0000cccc", retryOf: "20260902T000000Z-0000bbbb", directory: first.root });
  assert.deepEqual((await buildCampaignReport(third.file)).chain, {
    campaigns: ["20260903T000000Z-0000cccc", "20260902T000000Z-0000bbbb", "20260901T000000Z-0000aaaa"], complete: true,
  });
  const orphan = campaign(t, { id: "20260904T000000Z-0000dddd", retryOf: "20260801T000000Z-0000ffff", directory: first.root });
  assert.deepEqual((await buildCampaignReport(orphan.file)).chain, { campaigns: ["20260904T000000Z-0000dddd"], complete: false });
  // A sibling whose own link is not a campaign identity ends the chain instead of steering the next read.
  const malformed = path.join(first.root, "20260905T000000Z-0000eeee.json");
  writeFileSync(malformed, JSON.stringify({ ...JSON.parse(readFileSync(first.file, "utf8")), campaign: { id: "20260905T000000Z-0000eeee", startedAt: "2026-09-05T00:00:00.000Z", retryOf: "../outside" } }));
  const follower = campaign(t, { id: "20260906T000000Z-0000ffff", retryOf: "20260905T000000Z-0000eeee", directory: first.root });
  assert.deepEqual((await buildCampaignReport(follower.file)).chain, { campaigns: ["20260906T000000Z-0000ffff", "20260905T000000Z-0000eeee"], complete: false });
});

test("malformed or misplaced records are refused by name without echoing their content", async (t) => {
  for (const [mutate, code] of [
    [(entry) => { entry.verdict = "maybe"; }, "evaluation_review_invalid"],
    [(entry) => { entry.note = "extra"; }, "evaluation_review_invalid"],
    [(entry) => { entry.evidenceIds = ["not-a-uuid"]; }, "evaluation_review_invalid"],
    [(entry) => { entry.schemaVersion = 2; }, "evaluation_review_invalid"],
  ]) {
    const entry = review({ reasons: ["sensitive-canary"] });
    mutate(entry);
    await assert.rejects(buildCampaignReport(campaign(t, { reviews: [entry] }).file), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message.includes("sensitive-canary"), false);
      assert.match(error.message, /crash-loop-backoff-0\.json/);
      return true;
    });
  }
  const { root, file } = campaign(t);
  const linked = path.join(root, CAMPAIGN, "reviews", "linked.json");
  writeFileSync(path.join(root, "outside.json"), JSON.stringify(review()));
  symlinkSync(path.join(root, "outside.json"), linked);
  await assert.rejects(buildCampaignReport(file), { code: "evaluation_review_invalid" });
  rmSync(linked);

  const moved = path.join(root, "renamed.json");
  writeFileSync(moved, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), campaign: { id: CAMPAIGN, startedAt: "2026-09-05T00:00:00.000Z", retryOf: null } }));
  await assert.rejects(buildCampaignReport(moved), { code: "evaluation_artifact_invalid" });
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), schemaVersion: 3 }));
  await assert.rejects(buildCampaignReport(file), { code: "evaluation_artifact_invalid" });
});

test("the command prints the report and fails closed on an unreadable record", async (t) => {
  const { file } = campaign(t, { reviews: [review()] });
  const ok = spawnSync(process.execPath, [REPORT, file], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).scenarios[0].review.status, "pass");
  const missing = spawnSync(process.execPath, [REPORT, path.join(path.dirname(file), "20260905T000000Z-0000ffff.json")], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^FAIL evaluation_artifact_invalid /);
  const usage = spawnSync(process.execPath, [REPORT], { encoding: "utf8" });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /^FAIL invalid_arguments /);
});
