import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { CatalogArtifact, ScenarioResult } from "../../../src/contracts/records.ts";
import { classifyFailure } from "../../../src/lifecycle/classification.ts";
import type { EvaluationErrorCode } from "../../../src/shared/errors.ts";
import { coverageReport, emptyScenarioResult, notRunScenarioResult } from "../../../src/lifecycle/coverage.ts";
import { caseFor } from "./support.ts";

const GOLDEN = path.resolve(import.meta.dirname, "../../fixtures/golden");

function golden(name: string): CatalogArtifact {
  return JSON.parse(readFileSync(path.join(GOLDEN, `${name}.json`), "utf8"));
}

test("coverage and family reports are recomputed exactly from the recorded results", () => {
  for (const name of ["catalog-full", "catalog-focused", "catalog-terminal-mismatch", "catalog-aborted"]) {
    const artifact = golden(name);
    const report = coverageReport(artifact.scenarios);
    assert.deepEqual(report.families, artifact.families, name);
    assert.deepEqual(report.coverage, artifact.coverage, name);
    assert.deepEqual(report.scenarios, artifact.scenarios, name);
  }
  // One failed scenario marks its family and mechanism failed even when the rest never ran.
  const focused = golden("catalog-focused");
  const mixed = focused.scenarios.map((result) =>
    result.scenarioId === "pvc-binding-pending" ? { ...result, status: "failed" as const, outcomeClass: "contract_failed" as const } : result,
  );
  const report = coverageReport(mixed);
  assert.equal(mixed.find((result) => result.scenarioId === "pvc-storage-class-missing")?.status, "not_run");
  assert.equal(report.families.find((family) => family.familyId === "pvc-pending")?.status, "failed");
  assert.equal(report.families.find((family) => family.familyId === "probe-misconfiguration")?.status, "not_run");
  const mechanism = mixed.find((result) => result.scenarioId === "pvc-binding-pending")!.mechanism;
  assert.equal(report.coverage.mechanisms.find((entry) => entry.mechanism === mechanism)?.status, "failed");
  assert.equal(report.coverage.notRunCases, focused.coverage.notRunCases);
});

test("not-run results carry the complete planned denominator with the case's expectation", () => {
  const focused = golden("catalog-focused");
  for (const recorded of focused.scenarios.filter((result) => result.status === "not_run")) {
    const rebuilt = notRunScenarioResult(caseFor(recorded.scenarioId), "not_selected");
    assert.deepEqual(JSON.parse(JSON.stringify(rebuilt)), recorded, recorded.scenarioId);
  }
  const aborted = golden("catalog-aborted");
  assert.deepEqual(
    JSON.parse(JSON.stringify(notRunScenarioResult(caseFor("crash-loop-backoff"), "evaluation_aborted"))),
    aborted.scenarios.find((result) => result.scenarioId === "crash-loop-backoff"),
  );
  const empty = emptyScenarioResult(caseFor("crash-loop-backoff"));
  assert.deepEqual({ status: empty.status, cleanup: empty.cleanup, reviewPackage: empty.reviewPackage }, { status: "failed", cleanup: "passed", reviewPackage: null });
  assert.equal("outcomeClass" in empty || "trial" in empty, false);
  // The recorded checks omit the undefined-valued keys; the constructor declares them all.
  assert.deepEqual(Object.keys(empty.checks).sort(), [...new Set([...Object.keys(focused.scenarios[0].checks), "repair", "run", "sseReplay"])].sort());
});

test("failures are classified by how far the input travelled before the gate that stopped it", () => {
  const base = emptyScenarioResult(caseFor("crash-loop-backoff"));
  const classify = (checks: Partial<ScenarioResult["checks"]>, code?: EvaluationErrorCode) =>
    classifyFailure({ checks: { ...base.checks, ...checks }, failure: code === undefined ? undefined : { code, message: "" } });
  assert.equal(classify({}, "alert_firing_timeout"), "infrastructure_invalid");
  assert.equal(classify({ prometheusFiring: true }, "healthy_control_alerted"), "infrastructure_invalid");
  assert.equal(classify({ alertmanagerFiring: true }, "healthy_control_alerted"), "intake_failed");
  assert.equal(classify({ alertmanagerFiring: true }, "incident_not_created"), "intake_failed");
  assert.equal(classify({ alertmanagerFiring: true, uniqueIncident: true }, "diagnosis_not_terminal"), "run_not_terminal");
  assert.equal(classify({ alertmanagerFiring: true, uniqueIncident: true }, "terminal_outcome_mismatch"), "outcome_mismatch");
  assert.equal(classify({ alertmanagerFiring: true, uniqueIncident: true }, "diagnosis_invalid"), "contract_failed");
  assert.equal(classify({ alertmanagerFiring: true, uniqueIncident: true }), "contract_failed");
  const mismatch = golden("catalog-terminal-mismatch").scenarios[0];
  assert.equal(classifyFailure(mismatch), mismatch.outcomeClass);
  const aborted = golden("catalog-aborted");
  assert.equal(aborted.scenarios.every((result) => result.outcomeClass === "not_run"), true);
});
