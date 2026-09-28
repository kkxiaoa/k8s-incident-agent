import assert from "node:assert/strict";
import test from "node:test";

import {
  isResolvedIncident,
  isTerminalRun,
  matchesScenarioIncident,
  requireIncidentNotResolved,
  requireSingleTargetRun,
  selectNewTargetIncident,
} from "../../../src/lifecycle/gates/incident.ts";
import { coded, trialFor } from "./support.ts";

const RUN_PAGE = {
  schemaVersion: 5,
  items: [{ id: "20000000-0000-4000-8000-000000000001", kind: "diagnosis", operation: null, attempt: 1, status: "COMPLETED" }],
  nextCursor: null,
};

test("an Incident belongs to a scenario when its target and Alertmanager source match", async () => {
  const { scenario, detail } = await trialFor("crash-loop-backoff");
  assert.equal(matchesScenarioIncident(detail.incident, scenario), true);
  assert.equal(matchesScenarioIncident({ ...detail.incident, source: { ...detail.incident.source, ref: "K8sIncidentDeploymentReplicasUnavailable" } }, scenario), false);
  assert.equal(matchesScenarioIncident({ ...detail.incident, source: { ...detail.incident.source, type: "scenario" } }, scenario), false);
  assert.equal(matchesScenarioIncident({ ...detail.incident, target: { ...detail.incident.target, name: "other" } }, scenario), false);
  assert.equal(matchesScenarioIncident(null, scenario), false);
});

test("exactly one new target Incident may exist; none means keep waiting", async () => {
  const { detail } = await trialFor("crash-loop-backoff");
  assert.equal(selectNewTargetIncident([]), undefined);
  assert.equal(selectNewTargetIncident([detail]), detail);
  assert.throws(() => selectNewTargetIncident([detail, detail]), coded("duplicate_target_incident"));
});

test("terminal and resolved Incidents are recognised from the Runtime's own fields", async () => {
  const { detail } = await trialFor("crash-loop-backoff");
  assert.equal(isTerminalRun(detail), true);
  assert.equal(isTerminalRun({ ...detail, selectedRun: { ...detail.selectedRun, status: "RUNNING" } }), false);
  assert.equal(isResolvedIncident(detail), false);
  const resolved = { ...detail, alertSignal: { startsAt: "2026-09-05T00:00:00Z", endsAt: null, status: "RESOLVED" as const }, eventPage: { items: [{ event: "alert.resolved" }], nextCursor: null } } as unknown as typeof detail;
  assert.equal(isResolvedIncident(resolved), true);
  assert.equal(isResolvedIncident({ ...resolved, eventPage: { items: [], nextCursor: null } }), false);
  assert.equal(isResolvedIncident({ ...resolved, alertSignal: { ...resolved.alertSignal!, status: "FIRING" } }), false);
  assert.doesNotThrow(() => requireIncidentNotResolved(detail));
  assert.throws(() => requireIncidentNotResolved({ ...detail, incident: { ...detail.incident, status: "RESOLVED" } }), coded("incident_resolution_invalid"));
});

test("the repeated delivery gate accepts one target Incident with exactly one first diagnosis Run", () => {
  const incidentId = "10000000-0000-4000-8000-000000000001";
  assert.doesNotThrow(() => requireSingleTargetRun([incidentId], incidentId, RUN_PAGE));
  const rejects = (targets: string[], runs: unknown, label: string) =>
    assert.throws(() => requireSingleTargetRun(targets, incidentId, runs), coded("alert_repeat_not_deduplicated"), label);
  rejects([], RUN_PAGE, "no target incident");
  rejects([incidentId, "10000000-0000-4000-8000-000000000002"], RUN_PAGE, "two target incidents");
  rejects(["10000000-0000-4000-8000-000000000002"], RUN_PAGE, "other incident");
  rejects([incidentId], { ...RUN_PAGE, items: [...RUN_PAGE.items, RUN_PAGE.items[0]] }, "two runs");
  rejects([incidentId], { ...RUN_PAGE, items: [{ ...RUN_PAGE.items[0], attempt: 2 }] }, "second attempt");
  rejects([incidentId], { ...RUN_PAGE, items: [{ ...RUN_PAGE.items[0], kind: "repair" }] }, "repair run");
  rejects([incidentId], { ...RUN_PAGE, items: [{ ...RUN_PAGE.items[0], operation: "apply" }] }, "operation");
  rejects([incidentId], { ...RUN_PAGE, schemaVersion: 4 }, "schema");
  rejects([incidentId], { ...RUN_PAGE, items: [null] }, "null run");
  rejects([incidentId], undefined, "no page");
});
