import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { ScenarioCommandError } from "../../../scripts/scenario.mjs";
import type { CatalogArtifact, ScenarioResult } from "../../src/contracts/records.ts";
import { runTrial } from "../../src/lifecycle/trial.ts";
import { jsonResponse } from "../support/responses.ts";
import { AUTH_PASSWORD } from "../support/harness.ts";
import { caseNamed, trialFixture } from "./support.ts";

const GOLDEN = path.resolve(import.meta.dirname, "../fixtures/golden");

function golden(name: string): CatalogArtifact {
  return JSON.parse(readFileSync(path.join(GOLDEN, `${name}.json`), "utf8"));
}

function recorded(result: ScenarioResult): ScenarioResult {
  return JSON.parse(JSON.stringify(result));
}

test("every committed case reproduces its recorded Trial result through the fake environment", async () => {
  const { harness, cases, environment } = await trialFixture();
  const expected = golden("catalog-full").scenarios;
  for (const [index, scenario] of cases.entries()) {
    const result = await runTrial(scenario, environment);
    assert.deepEqual(recorded(result), expected[index], scenario.scenarioId);
  }
  assert.equal(harness.calls.scenarioApply, 7);
  assert.equal(harness.calls.scenarioVerify, 7);
  assert.equal(harness.calls.packages.length, 7);
  assert.equal(harness.calls.sleepDurations.includes(330_000), false);
  assert.equal(harness.state.logins, 1);
});

test("the three expected terminals and a mismatch reproduce their recorded results", async () => {
  const insufficient = await trialFixture({ terminalByScenario: { "crash-loop-backoff": { outcome: "insufficient_evidence" } } });
  const insufficientCase = caseNamed(insufficient.cases, "crash-loop-backoff", { expectedTerminal: { outcome: "insufficient_evidence" } });
  assert.deepEqual(recorded(await runTrial(insufficientCase, insufficient.environment)), golden("catalog-terminal-insufficient_evidence").scenarios[0]);

  const failed = await trialFixture({ terminalByScenario: { "crash-loop-backoff": { outcome: "failed", errorCode: "model_output_invalid", retryable: false } } });
  const failedCase = caseNamed(failed.cases, "crash-loop-backoff", { expectedTerminal: { outcome: "failed", errorCode: "model_output_invalid" } });
  assert.deepEqual(recorded(await runTrial(failedCase, failed.environment)), golden("catalog-terminal-failed").scenarios[0]);

  const mismatch = await trialFixture({
    terminalByScenario: { "crash-loop-backoff": { outcome: "failed", errorCode: "tool_timeout", retryable: true, incidentStatus: "STALE_RESOURCE" } },
  });
  const mismatchCase = caseNamed(mismatch.cases, "crash-loop-backoff", { expectedTerminal: { outcome: "failed", errorCode: "model_output_invalid" } });
  const result = await runTrial(mismatchCase, mismatch.environment);
  assert.deepEqual(recorded(result), golden("catalog-terminal-mismatch").scenarios[0]);
  assert.equal(mismatch.harness.calls.packages.length, 1);
});

test("a fixture that breaks before an Incident exists is an infrastructure failure that is still cleaned up", async () => {
  const { harness, cases, environment } = await trialFixture();
  const original = harness.dependencies.runScenarioCommand;
  const actions: string[] = [];
  environment.scenarioRunner = async (action, scenarioId, dependencies) => {
    actions.push(action);
    if (action === "verify") throw new Error("fixture did not converge");
    return original(action, scenarioId, dependencies);
  };
  const result = await runTrial(caseNamed(cases, "crash-loop-backoff"), environment);
  assert.equal(result.status, "failed");
  assert.equal(result.outcomeClass, "infrastructure_invalid");
  assert.equal(result.reviewPackage, null);
  assert.equal(result.checks.alertmanagerFiring, false);
  assert.equal(result.checks.uniqueIncident, false);
  assert.deepEqual(result.failure, { code: "evaluation_failed", message: "Scenario evaluation failed without exposing upstream content" });
  assert.deepEqual(actions, ["cleanup", "apply", "verify", "cleanup"]);
  assert.equal(result.cleanup, "passed");
  assert.deepEqual(result.trial, { index: 1, startedAt: "2026-09-05T00:00:00.000Z", completedAt: "2026-09-05T00:00:00.000Z" });
});

test("scenario command failures keep their own code and a partial apply is cleaned before moving on", async () => {
  const { harness, cases, environment } = await trialFixture();
  const original = harness.dependencies.runScenarioCommand;
  const actions: string[] = [];
  environment.scenarioRunner = async (action, scenarioId, dependencies) => {
    actions.push(action);
    if (action === "apply") throw new ScenarioCommandError("upstream_unavailable", "The healthy rollout did not complete");
    return original(action, scenarioId, dependencies);
  };
  const result = await runTrial(caseNamed(cases, "image-pull-backoff"), environment);
  assert.deepEqual(result.failure, { code: "upstream_unavailable", message: "The healthy rollout did not complete" });
  assert.deepEqual(actions, ["cleanup", "apply", "cleanup"]);
  assert.equal(result.outcomeClass, "infrastructure_invalid");

  const verifyFails = await trialFixture();
  const verifyOriginal = verifyFails.harness.dependencies.runScenarioCommand;
  verifyFails.environment.scenarioRunner = async (action, scenarioId, dependencies) => {
    if (action === "verify") throw new ScenarioCommandError("verification_failed", "Scenario did not reach its deterministic evidence condition");
    if (action === "cleanup" && scenarioId === "crash-loop-backoff" && verifyFails.harness.calls.scenarioApply > 0) throw new Error("cleanup broke");
    return verifyOriginal(action, scenarioId, dependencies);
  };
  const broken = await runTrial(caseNamed(verifyFails.cases, "crash-loop-backoff"), verifyFails.environment);
  assert.deepEqual(broken.failure, { code: "verification_failed", message: "Scenario did not reach its deterministic evidence condition" });
  assert.equal(broken.cleanup, "failed");
});

test("a fired alert that fails before a unique Incident exists is an intake failure of the product", async () => {
  const control = await trialFixture({ controlAlertScenarioId: "crash-loop-backoff" });
  const alerted = await runTrial(caseNamed(control.cases, "crash-loop-backoff"), control.environment);
  assert.equal(alerted.failure?.code, "healthy_control_alerted");
  assert.equal(alerted.outcomeClass, "intake_failed");
  assert.equal(alerted.checks.alertmanagerFiring, true);
  assert.equal(alerted.checks.uniqueIncident, false);

  const incident = await trialFixture({ controlIncidentScenarioId: "readiness-probe-misconfigured" });
  const owned = await runTrial(caseNamed(incident.cases, "readiness-probe-misconfigured"), incident.environment);
  assert.equal(owned.failure?.code, "healthy_control_incident_created");
  assert.equal(owned.outcomeClass, "contract_failed");
  assert.equal(owned.checks.repeatDeliveryDeduplicated, true);
  assert.equal(owned.checks.healthyControls, false);
});

test("later gates fail with their own codes after the review package was captured", async () => {
  for (const [options, scenarioId, code] of [
    [{ consoleEchoOnly: true }, "crash-loop-backoff", "console_incident_incomplete"],
    [{ invalidSseContract: true }, "crash-loop-backoff", "sse_replay_invalid"],
    [{ duplicateRepairEvent: true }, "image-pull-backoff", "sse_replay_invalid"],
    [{ contextPanelState: "query_error" }, "crash-loop-backoff", "firing_panel_invalid"],
    [{ omitDiagnosisEvidenceLinks: true }, "crash-loop-backoff", "diagnosis_evidence_links_invalid"],
  ] as const) {
    const { harness, cases, environment } = await trialFixture(options);
    const result = await runTrial(caseNamed(cases, scenarioId), environment);
    assert.equal(result.status, "failed", JSON.stringify(options));
    assert.equal(result.failure?.code, code, JSON.stringify(options));
    assert.equal(result.outcomeClass, "contract_failed", JSON.stringify(options));
    assert.equal(result.reviewPackage, `trials/${scenarioId}.json`, JSON.stringify(options));
    assert.equal(harness.calls.packages.length, 1, JSON.stringify(options));
    assert.ok(result.checks.run, JSON.stringify(options));
    assert.equal(harness.calls.scenarioApply, 1);
  }
});

test("alert maturity waits for the case's own budget", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-05T00:00:00Z") });
  let readyAt = 0;
  const { harness, cases, environment } = await trialFixture({}, (fetch) => async (input, init) => {
    const url = new URL(String(input));
    if (Date.now() < readyAt && url.port === "19090" && url.searchParams.get("query")?.startsWith("ALERTS{")) {
      return jsonResponse({ status: "success", data: { resultType: "vector", result: [] } });
    }
    return fetch(input, init);
  });
  const runner = harness.dependencies.runScenarioCommand;
  const sleep = harness.dependencies.sleep;
  environment.scenarioRunner = async (action, scenarioId, dependencies) => {
    readyAt = action === "apply" ? Date.now() + 480_000 : action === "cleanup" ? 0 : readyAt;
    return runner(action, scenarioId, dependencies);
  };
  environment.sleep = async (milliseconds) => {
    t.mock.timers.tick(milliseconds);
    // The repeat notification belongs after the initial firing/diagnosis, not
    // to the synthetic time spent waiting for the first alert to mature.
    if (Date.now() > readyAt) await sleep(milliseconds);
  };
  const budgeted = caseNamed(cases, "crash-loop-backoff", { alertWaitMilliseconds: 540_000 });
  const result = await runTrial(budgeted, environment);
  assert.equal(result.status, "pending_manual_review", JSON.stringify(result.failure));
  assert.ok(Date.now() - Date.parse("2026-09-05T00:00:00Z") >= 480_000);
});

test("the review package holds the projected Incident and its Run events without credentials and within its bound", async () => {
  const { harness, cases, environment } = await trialFixture();
  const result = await runTrial(caseNamed(cases, "image-pull-backoff"), environment);
  assert.equal(result.reviewPackage, "trials/image-pull-backoff.json");
  const [record] = harness.calls.packages as Array<Record<string, unknown>>;
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.campaignId, "20260905T000000Z-0000aaaa");
  assert.equal(record.trial, 1);
  assert.equal(record.runId, result.runId);
  assert.equal((record.incident as { diagnosis: { outcome: string } }).diagnosis.outcome, "diagnosed");
  assert.deepEqual((record.events as Array<{ event: string }>).map((event) => event.event).slice(0, 3), ["incident.created", "run.started", "diagnosis.completed"]);
  assert.equal(record.truncated, false);
  const serialized = JSON.stringify(record);
  for (const secret of [harness.state.cookie, harness.state.csrf, AUTH_PASSWORD]) assert.equal(serialized.includes(String(secret)), false);

  const bulky = await trialFixture({ bulkyRunEvents: true });
  const truncated = await runTrial(caseNamed(bulky.cases, "crash-loop-backoff"), bulky.environment);
  assert.equal(truncated.status, "pending_manual_review");
  const [dropped] = bulky.harness.calls.packages as Array<Record<string, unknown>>;
  assert.equal(dropped.truncated, true);
  assert.deepEqual(dropped.events, []);
  assert.ok(bulky.harness.calls.packageBytes[0] <= 4 * 1024 * 1024);

  const many = await trialFixture({ manyRunEvents: { pages: 10, perPage: 100, fields: 200 } });
  const near = await runTrial(caseNamed(many.cases, "crash-loop-backoff"), many.environment);
  assert.equal(near.status, "pending_manual_review", JSON.stringify(near.failure));
  const [bytes] = many.harness.calls.packageBytes;
  assert.ok(bytes > 3.5 * 1024 * 1024 && bytes <= 4 * 1024 * 1024, `package is ${bytes} bytes`);
  const [kept] = many.harness.calls.packages as Array<Record<string, unknown>>;
  assert.equal(kept.truncated, false);
  assert.equal((kept.events as unknown[]).length, 1000);

  const paginated = await trialFixture({ paginatedIncidents: true });
  const retained = await runTrial(caseNamed(paginated.cases, "crash-loop-backoff"), paginated.environment);
  assert.equal(retained.status, "pending_manual_review", JSON.stringify(retained.failure));
});
