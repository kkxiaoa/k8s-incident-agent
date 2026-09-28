import assert from "node:assert/strict";
import test from "node:test";

import { assessTerminal, observedRun } from "../../../src/lifecycle/gates/terminal.ts";
import { REPAIR_DIGEST } from "../../support/fake-runtime.ts";
import { caseFor, coded, trialFor } from "./support.ts";

const FAILED = { outcome: "failed", errorCode: "model_output_invalid" } as const;
const INSUFFICIENT = { outcome: "insufficient_evidence" } as const;

test("a diagnosed Run yields the collected kinds, the sorted codes and no repair for a diagnosis-only scenario", async () => {
  const { scenario, detail } = await trialFor("crash-loop-backoff");
  const summary = assessTerminal(scenario, detail);
  assert.deepEqual(summary, {
    evidenceKinds: [...scenario.requiredEvidence].sort(),
    uncitedExpectedEvidence: [],
    diagnosisCodes: ["observed_cause"],
    repair: undefined,
  });
  assert.deepEqual(observedRun(detail), { attempt: 1, status: "COMPLETED", errorCode: null, retryable: null, outcome: "diagnosed" });
});

test("the ImagePull scenario's diagnosis carries its evidence-bound repair check", async () => {
  const { scenario, detail } = await trialFor("image-pull-backoff");
  assert.deepEqual(assessTerminal(scenario, detail).repair, {
    action: "set_container_image",
    proposalDigest: REPAIR_DIGEST,
    validation: "passed",
    terminalStatus: "WAITING_APPROVAL",
  });
});

test("expected insufficient-evidence and typed-failure terminals pass and keep the Runtime's raw Run", async () => {
  const insufficient = await trialFor("crash-loop-backoff", { terminalByScenario: { "crash-loop-backoff": INSUFFICIENT } }, INSUFFICIENT);
  assert.deepEqual(assessTerminal(insufficient.scenario, insufficient.detail), {
    evidenceKinds: [...insufficient.scenario.requiredEvidence].sort(),
    uncitedExpectedEvidence: insufficient.scenario.requiredEvidence,
    diagnosisCodes: [],
    repair: undefined,
  });
  assert.deepEqual(observedRun(insufficient.detail), { attempt: 1, status: "COMPLETED", errorCode: null, retryable: null, outcome: "insufficient_evidence" });

  const failed = await trialFor("crash-loop-backoff", { terminalByScenario: { "crash-loop-backoff": { ...FAILED, retryable: false } } }, FAILED);
  assert.deepEqual(assessTerminal(failed.scenario, failed.detail).diagnosisCodes, []);
  assert.deepEqual(observedRun(failed.detail), { attempt: 1, status: "FAILED", errorCode: "model_output_invalid", retryable: false, outcome: null });
});

test("a terminal that differs from the case's expectation is named exactly", async () => {
  const mismatch = await trialFor(
    "crash-loop-backoff",
    { terminalByScenario: { "crash-loop-backoff": { outcome: "failed", errorCode: "tool_timeout", retryable: true, incidentStatus: "STALE_RESOURCE" } } },
    FAILED,
  );
  assert.throws(
    () => assessTerminal(mismatch.scenario, mismatch.detail),
    coded("terminal_outcome_mismatch", "The Run ended FAILED/tool_timeout while the case expects failed/model_output_invalid"),
  );
  const stopped = await trialFor("crash-loop-backoff", { terminalByScenario: { "crash-loop-backoff": INSUFFICIENT } });
  assert.throws(
    () => assessTerminal(stopped.scenario, stopped.detail),
    coded("terminal_outcome_mismatch", "The Run ended COMPLETED/insufficient_evidence while the case expects diagnosed"),
  );
  const weird = await trialFor("crash-loop-backoff", { terminalByScenario: { "crash-loop-backoff": { outcome: "failed", errorCode: "bad code!", retryable: true } } }, FAILED);
  assert.throws(() => assessTerminal(weird.scenario, weird.detail), coded("terminal_outcome_mismatch", "The Run ended FAILED/invalid while the case expects failed/model_output_invalid"));
});

test("non-diagnosed terminals are gated on the Runtime's own persisted shape", async () => {
  const drifted = await trialFor("crash-loop-backoff", { terminalByScenario: { "crash-loop-backoff": FAILED }, retryableDrift: true }, FAILED);
  assert.throws(() => assessTerminal(drifted.scenario, drifted.detail), coded("run_failure_invalid"));
  const statusDrift = await trialFor("crash-loop-backoff", { terminalByScenario: { "crash-loop-backoff": FAILED }, incidentStatusDrift: true }, FAILED);
  assert.throws(() => assessTerminal(statusDrift.scenario, statusDrift.detail), coded("run_failure_invalid"));
  const repairDrift = await trialFor("crash-loop-backoff", { terminalByScenario: { "crash-loop-backoff": FAILED }, repairDrift: true }, FAILED);
  assert.throws(() => assessTerminal(repairDrift.scenario, repairDrift.detail), coded("run_failure_invalid"));

  const rootCauses = await trialFor("crash-loop-backoff", { terminalByScenario: { "crash-loop-backoff": INSUFFICIENT }, insufficientWithRootCauses: true }, INSUFFICIENT);
  assert.throws(() => assessTerminal(rootCauses.scenario, rootCauses.detail), coded("diagnosis_invalid"));
  const missing = await trialFor("crash-loop-backoff", { terminalByScenario: { "crash-loop-backoff": INSUFFICIENT }, emptyMissingInformation: true }, INSUFFICIENT);
  assert.throws(() => assessTerminal(missing.scenario, missing.detail), coded("diagnosis_invalid"));
  const insufficientStatus = await trialFor("crash-loop-backoff", { terminalByScenario: { "crash-loop-backoff": INSUFFICIENT }, incidentStatusDrift: true }, INSUFFICIENT);
  assert.throws(() => assessTerminal(insufficientStatus.scenario, insufficientStatus.detail), coded("diagnosis_invalid"));
});

test("diagnosis root causes must cite persisted Evidence including the target's identity kind", async () => {
  const unlinked = await trialFor("crash-loop-backoff", { omitDiagnosisEvidenceLinks: true });
  assert.throws(() => assessTerminal(unlinked.scenario, unlinked.detail), coded("diagnosis_evidence_links_invalid"));
  const nonIdentity = await trialFor("crash-loop-backoff", { citeOnlyNonIdentityEvidence: true });
  assert.throws(() => assessTerminal(nonIdentity.scenario, nonIdentity.detail), coded("diagnosis_evidence_links_invalid", "Diagnosis does not reference workload"));
  const identityOnly = await trialFor("crash-loop-backoff", { citeOnlyIdentityEvidence: true });
  assert.deepEqual(assessTerminal(identityOnly.scenario, identityOnly.detail).uncitedExpectedEvidence, ["pods", "events", "container_logs"]);
  for (const code of ["unknown", "Not a code", "a".repeat(65)]) {
    const malformed = await trialFor("pvc-binding-pending", { diagnosisCodeByScenario: { "pvc-binding-pending": code } });
    assert.throws(() => assessTerminal(malformed.scenario, malformed.detail), coded("diagnosis_evidence_links_invalid"), code);
  }
  const renamed = await trialFor("pvc-binding-pending", {
    diagnosisCodeByScenario: { "pvc-binding-pending": "persistent_volume_claim_unbound" },
    diagnosisStatement: "The claim was continuously Pending throughout a full hour despite only five minutes of samples.",
  });
  assert.deepEqual(assessTerminal(renamed.scenario, renamed.detail).diagnosisCodes, ["persistent_volume_claim_unbound"]);
});

test("Evidence must come from permitted tools and cover every expected kind", async () => {
  const forbidden = await trialFor("crash-loop-backoff", { forbiddenToolUsed: true });
  assert.throws(() => assessTerminal(forbidden.scenario, forbidden.detail), coded("diagnosis_tools_invalid"));
  const uncollected = await trialFor("crash-loop-backoff", { uncollectedEvidenceKind: "container_logs" });
  assert.throws(() => assessTerminal(uncollected.scenario, uncollected.detail), coded("diagnosis_evidence_missing", "Diagnosis did not collect container_logs"));

  const { scenario, detail } = await trialFor("crash-loop-backoff");
  const duplicated = { ...detail, evidence: [detail.evidence[0], detail.evidence[0]] };
  assert.throws(() => assessTerminal(scenario, duplicated), coded("upstream_contract_invalid"));
  const unnamed = { ...detail, evidence: [{ ...detail.evidence[0], toolName: "" }] };
  assert.throws(() => assessTerminal(scenario, unnamed), coded("upstream_contract_invalid"));
});

test("a diagnosed terminal must still satisfy the completed-Run shape", async () => {
  const { scenario, detail } = await trialFor("crash-loop-backoff");
  const attemptTwo = { ...detail, selectedRun: { ...detail.selectedRun, attempt: 2 } };
  assert.throws(() => assessTerminal(scenario, attemptTwo), coded("diagnosis_invalid"));
  const tooMany = { ...detail, diagnosis: { ...detail.diagnosis!, rootCauses: Array.from({ length: 6 }, () => detail.diagnosis!.rootCauses[0]) } };
  assert.throws(() => assessTerminal(scenario, tooMany), coded("diagnosis_invalid"));
  const lowConfidence = { ...detail, diagnosis: { ...detail.diagnosis!, rootCauses: [{ ...detail.diagnosis!.rootCauses[0], confidence: "certain" }] } };
  assert.throws(() => assessTerminal(scenario, lowConfidence as typeof detail), coded("diagnosis_invalid", "Diagnosis statement or confidence is invalid"));
  assert.equal(caseFor("crash-loop-backoff").expectedTerminal.outcome, "diagnosed");
});
