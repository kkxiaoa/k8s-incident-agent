import assert from "node:assert/strict";
import test from "node:test";

import type { IncidentDetail } from "../../../src/contracts/runtime-api.ts";
import { sameTarget } from "../../../src/lifecycle/gates/repair.ts";
import { assessTerminal } from "../../../src/lifecycle/gates/terminal.ts";
import { REPAIR_DIGEST } from "../../support/fake-runtime.ts";
import { coded, trialFor } from "./support.ts";

test("a repair slice needs a proposal that is bound to the cited Evidence, not merely a diagnosis", async () => {
  const omitted = await trialFor("image-pull-backoff", { omitRepair: true, diagnosisCodeByScenario: { "image-pull-backoff": "image_pull_forbidden_invalid_registry" } });
  assert.throws(() => assessTerminal(omitted.scenario, omitted.detail), coded("repair_validation_invalid", "The ImagePull repair did not satisfy the evidence-bound contract"));
  const rollback = await trialFor("image-pull-backoff", { sourceExecutionId: "70000000-0000-4000-8000-0000000000ff" });
  assert.throws(() => assessTerminal(rollback.scenario, rollback.detail), coded("repair_validation_invalid", "The ImagePull repair did not satisfy the evidence-bound contract"));
  const digest = await trialFor("image-pull-backoff", { invalidRepairDigest: true });
  assert.throws(() => assessTerminal(digest.scenario, digest.detail), coded("repair_validation_invalid", "The ImagePull repair identity is not bound to its exact Run Evidence"));
  const renamed = await trialFor("image-pull-backoff", { diagnosisCodeByScenario: { "image-pull-backoff": "registry_host_unresolvable" } });
  assert.equal(assessTerminal(renamed.scenario, renamed.detail).repair?.proposalDigest, REPAIR_DIGEST);
});

test("the proposal's shape, target, gate order, Evidence kinds and Run binding are all enforced", async () => {
  const { scenario, detail } = await trialFor("image-pull-backoff");
  const repair = detail.repair!;
  const rejects = (mutate: (candidate: Record<string, unknown>, mutated: Record<string, unknown>) => void, label: string, message?: string) => {
    const candidate = structuredClone(repair) as unknown as Record<string, unknown>;
    const mutated = { ...structuredClone(detail), repair: candidate } as unknown as Record<string, unknown>;
    mutate(candidate, mutated);
    assert.throws(() => assessTerminal(scenario, mutated as unknown as IncidentDetail), coded("repair_validation_invalid", message), label);
  };
  const contract = "The ImagePull repair did not satisfy the evidence-bound contract";
  rejects((_, mutated) => { (mutated.incident as Record<string, unknown>).status = "DIAGNOSED"; }, "incident status", contract);
  rejects((candidate) => { candidate.extra = true; }, "extra key", contract);
  rejects((candidate) => { delete candidate.diff; }, "missing key", contract);
  rejects((candidate) => { (candidate.target as Record<string, unknown>).name = "other"; }, "target", contract);
  rejects((candidate) => { candidate.containerName = "sidecar"; }, "container name", contract);
  rejects((candidate) => { candidate.evidenceIds = [...(candidate.evidenceIds as string[])].reverse(); }, "unsorted evidence", contract);
  rejects((candidate) => { candidate.evidenceIds = [(candidate.evidenceIds as string[])[0]]; }, "single evidence", contract);
  rejects((candidate) => { (candidate.patch as unknown[]).pop(); }, "patch length", contract);
  rejects((candidate) => { (candidate.diff as Record<string, unknown>).after = "other"; }, "diff", contract);
  rejects((candidate) => { candidate.policyCheckedAt = "2026-09-04T00:00:00.000Z"; }, "gate order", contract);
  rejects((candidate) => { (candidate.validation as Record<string, unknown>).outcome = "failed"; }, "validation outcome", contract);
  rejects((candidate) => { candidate.digest = "sha256:" + "0".repeat(64); }, "digest", "The ImagePull repair identity is not bound to its exact Run Evidence");
  rejects((candidate) => { candidate.evidenceIds = ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000003"]; }, "evidence kinds", "The ImagePull repair identity is not bound to its exact Run Evidence");
  rejects((_, mutated) => { (mutated.selectedRun as Record<string, unknown>).id = "20000000-0000-4000-8000-000000000099"; }, "run identity", "The ImagePull repair identity is not bound to its exact Run Evidence");

  const diagnosisOnly = await trialFor("crash-loop-backoff");
  const carried = { ...diagnosisOnly.detail, repair, incident: { ...diagnosisOnly.detail.incident, status: "WAITING_APPROVAL" as const } };
  assert.throws(() => assessTerminal(diagnosisOnly.scenario, carried), coded("repair_validation_invalid", "A diagnosis without an approved repair slice exposed repair state"));
  assert.equal(sameTarget(repair.target, scenario.target), true);
  assert.equal(sameTarget({ ...repair.target, name: "other" }, scenario.target), false);
});
