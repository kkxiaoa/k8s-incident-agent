import assert from "node:assert/strict";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { CampaignReport } from "../../src/contracts/records.ts";
import { buildCampaignReport } from "../../src/review/report.ts";
import { EvaluationError } from "../../src/shared/errors.ts";
import { CAMPAIGN, campaign, EVIDENCE, review, scenario, type LooseRecord } from "./layout.ts";

const GOLDEN = path.resolve(import.meta.dirname, "../fixtures/golden");

function golden(name: string): CampaignReport {
  return JSON.parse(readFileSync(path.join(GOLDEN, `${name}.json`), "utf8"));
}

test("an unreviewed Trial stays pending and a bound verdict settles it, exactly as recorded", async (t) => {
  const pending = await buildCampaignReport(campaign(t).file);
  assert.deepEqual(JSON.parse(JSON.stringify(pending)), golden("report-pending"));
  assert.equal(pending.status, "pending_manual_review");
  assert.deepEqual(pending.scenarios[0].review, { status: "pending_manual_review", reviewers: [] });
  assert.deepEqual(pending.review, { files: 0, unbound: 0, statuses: { pending_manual_review: 1 } });

  const reviewed = await buildCampaignReport(campaign(t, { reviews: [review(), review({ reviewer: "second", evidenceIds: EVIDENCE })] }).file);
  assert.deepEqual(JSON.parse(JSON.stringify(reviewed)), golden("report-reviewed"));
  assert.equal(reviewed.status, "reviewed");
  assert.equal(reviewed.scenarios[0].review.status, "pass");
  assert.deepEqual(reviewed.scenarios[0].reviewPackage, { truncated: false });
  assert.deepEqual(reviewed.mechanisms[0].review, { pass: 1 });
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
  ] as const) {
    const report = await buildCampaignReport(campaign(t, options).file);
    assert.equal(report.scenarios[0].review.status, "incomplete", JSON.stringify(options));
    assert.deepEqual((report.scenarios[0].review as { reasons: string[] }).reasons, reasons, JSON.stringify(options));
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
  assert.equal((report.scenarios[0].review as { reviewers: unknown[] }).reviewers.length, 1);
  assert.equal(report.scenarios[0].failure?.code, "terminal_outcome_mismatch");
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
    [(entry: LooseRecord) => { entry.verdict = "maybe"; }, "evaluation_review_invalid"],
    [(entry: LooseRecord) => { entry.note = "extra"; }, "evaluation_review_invalid"],
    [(entry: LooseRecord) => { entry.evidenceIds = ["not-a-uuid"]; }, "evaluation_review_invalid"],
    [(entry: LooseRecord) => { entry.schemaVersion = 2; }, "evaluation_review_invalid"],
    [(entry: LooseRecord) => { entry.reasons = Array.from({ length: 21 }, () => "r"); }, "evaluation_review_invalid"],
    [(entry: LooseRecord) => { entry.reviewedAt = "yesterday"; }, "evaluation_review_invalid"],
  ] as const) {
    const entry = review({ reasons: ["sensitive-canary"] });
    mutate(entry);
    await assert.rejects(buildCampaignReport(campaign(t, { reviews: [entry] }).file), (error: unknown) => {
      assert.ok(error instanceof EvaluationError);
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
  await assert.rejects(buildCampaignReport(file), (error: unknown) => error instanceof EvaluationError && error.code === "evaluation_review_invalid" && /Cannot read linked\.json/.test(error.message));
  rmSync(linked);

  const moved = path.join(root, "renamed.json");
  writeFileSync(moved, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), campaign: { id: CAMPAIGN, startedAt: "2026-09-05T00:00:00.000Z", retryOf: null } }));
  await assert.rejects(buildCampaignReport(moved), (error: unknown) => error instanceof EvaluationError && error.code === "evaluation_artifact_invalid");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), schemaVersion: 3 }));
  await assert.rejects(buildCampaignReport(file), (error: unknown) => error instanceof EvaluationError && error.code === "evaluation_artifact_invalid");
  await assert.rejects(buildCampaignReport(path.join(root, "20260905T000000Z-0000ffff.json")), (error: unknown) =>
    error instanceof EvaluationError && error.code === "evaluation_artifact_invalid" && error.message === "Cannot read 20260905T000000Z-0000ffff.json");
});
