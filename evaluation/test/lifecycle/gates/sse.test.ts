import assert from "node:assert/strict";
import test from "node:test";

import type { RunEvent } from "../../../src/contracts/runtime-api.ts";
import { requireReplayIdentity, validateReplayEvents } from "../../../src/lifecycle/gates/sse.ts";
import { coded, trialFor } from "./support.ts";

const FAILED = { outcome: "failed", errorCode: "model_output_invalid" } as const;
const INSUFFICIENT = { outcome: "insufficient_evidence" } as const;

function withPayload(event: RunEvent, fields: Record<string, unknown>): RunEvent {
  return { ...event, data: { ...(event.data as unknown as Record<string, unknown>), ...fields } } as unknown as RunEvent;
}

test("the replay must reach the persisted cursor and contain the Incident lifecycle events", async () => {
  const { scenario, detail, events } = await trialFor("crash-loop-backoff");
  requireReplayIdentity(detail.eventCursor, detail.selectedRun.id);
  assert.deepEqual(validateReplayEvents(events, detail.eventCursor, detail.repair, scenario.expectedTerminal), {
    events: 3,
    eventTypes: ["diagnosis.completed", "incident.created", "run.started"],
    finalCursorMatched: true,
  });

  assert.throws(() => requireReplayIdentity("0", detail.selectedRun.id), coded("upstream_contract_invalid"));
  assert.throws(() => requireReplayIdentity(undefined, detail.selectedRun.id), coded("upstream_contract_invalid"));
  assert.throws(() => requireReplayIdentity(3, detail.selectedRun.id), coded("upstream_contract_invalid"));
  assert.throws(() => requireReplayIdentity("3", "run"), coded("upstream_contract_invalid"));
  assert.throws(() => validateReplayEvents(events.slice(0, 2), detail.eventCursor, detail.repair, scenario.expectedTerminal), coded("sse_replay_incomplete"));
  assert.throws(() => validateReplayEvents([], detail.eventCursor, detail.repair, scenario.expectedTerminal), coded("sse_replay_incomplete"));
  for (const name of ["incident.created", "run.started"]) {
    const missing = events.filter((event) => event.event !== name);
    assert.throws(
      () => validateReplayEvents(missing, detail.eventCursor, detail.repair, scenario.expectedTerminal),
      coded("sse_replay_invalid", "SSE replay omitted a required Incident lifecycle event"),
      name,
    );
  }
  assert.throws(() => validateReplayEvents(events, detail.eventCursor, detail.repair, INSUFFICIENT), coded("sse_replay_invalid", "SSE replay omitted a required Incident lifecycle event"));
});

test("a diagnosis-only Run must end DIAGNOSED / COMPLETED without repair events", async () => {
  const { scenario, detail, events } = await trialFor("crash-loop-backoff");
  const running = events.map((event) => (event.event === "diagnosis.completed" ? withPayload(event, { runStatus: "RUNNING" }) : event));
  assert.throws(() => validateReplayEvents(running, detail.eventCursor, null, scenario.expectedTerminal), coded("sse_replay_invalid", "SSE replay exposed repair events for a diagnosis-only Run"));
  const withRepairEvent = [...events, withPayload({ ...events[2], id: "4", event: "repair.patch_ready" } as RunEvent, {})];
  assert.throws(() => validateReplayEvents(withRepairEvent, "4", null, scenario.expectedTerminal), coded("sse_replay_invalid", "SSE replay exposed repair events for a diagnosis-only Run"));
});

test("the ImagePull repair lifecycle must be complete, unique, ordered and bound to the proposal", async () => {
  const { scenario, detail, events } = await trialFor("image-pull-backoff");
  assert.equal(events.length, 6);
  assert.equal(validateReplayEvents(events, detail.eventCursor, detail.repair, scenario.expectedTerminal).events, 6);

  // The stream is read only up to the persisted cursor, so the duplicate pushes the last repair event out.
  const duplicated = await trialFor("image-pull-backoff", { duplicateRepairEvent: true });
  const upToCursor = duplicated.events.filter((event) => BigInt(event.id) <= BigInt(duplicated.detail.eventCursor));
  assert.throws(
    () => validateReplayEvents(upToCursor, duplicated.detail.eventCursor, duplicated.detail.repair, scenario.expectedTerminal),
    coded("sse_replay_invalid", "SSE replay omitted or changed the repair lifecycle contract"),
  );
  const repeated = [...events.slice(0, 4), events[3], ...events.slice(4)];
  assert.throws(
    () => validateReplayEvents(repeated, detail.eventCursor, detail.repair, scenario.expectedTerminal),
    coded("sse_replay_invalid", "SSE replay omitted or changed the repair lifecycle contract"),
  );
  const missing = events.filter((event) => event.event !== "repair.dry_run_passed");
  assert.throws(() => validateReplayEvents(missing, detail.eventCursor, detail.repair, scenario.expectedTerminal), coded("sse_replay_invalid"));
  const otherProposal = events.map((event) => (event.event === "repair.waiting_approval" ? withPayload(event, { proposalDigest: "sha256:" + "0".repeat(64) }) : event));
  assert.throws(() => validateReplayEvents(otherProposal, detail.eventCursor, detail.repair, scenario.expectedTerminal), coded("sse_replay_invalid"));
  const reordered = [events[0], events[1], events[3], events[2], events[4], events[5]];
  assert.throws(() => validateReplayEvents(reordered, detail.eventCursor, detail.repair, scenario.expectedTerminal), coded("sse_replay_invalid", "SSE replay changed the repair lifecycle order"));
  const completedEarly = events.map((event) => (event.event === "diagnosis.completed" ? withPayload(event, { runStatus: "COMPLETED" }) : event));
  assert.throws(() => validateReplayEvents(completedEarly, detail.eventCursor, detail.repair, scenario.expectedTerminal), coded("sse_replay_invalid"));
  assert.throws(() => validateReplayEvents(events, detail.eventCursor, null, scenario.expectedTerminal), coded("sse_replay_invalid"));
});

test("insufficient-evidence and failed terminals must persist their own states and no repair", async () => {
  const insufficient = await trialFor("crash-loop-backoff", { terminalByScenario: { "crash-loop-backoff": INSUFFICIENT } }, INSUFFICIENT);
  assert.equal(validateReplayEvents(insufficient.events, insufficient.detail.eventCursor, insufficient.detail.repair, INSUFFICIENT).eventTypes.includes("diagnosis.insufficient"), true);
  const drifted = await trialFor("crash-loop-backoff", { terminalByScenario: { "crash-loop-backoff": INSUFFICIENT }, sseTerminalStateDrift: true }, INSUFFICIENT);
  assert.throws(
    () => validateReplayEvents(drifted.events, drifted.detail.eventCursor, drifted.detail.repair, INSUFFICIENT),
    coded("sse_replay_invalid", "SSE replay did not persist the terminal Run event the case expects"),
  );
  const stale = await trialFor("crash-loop-backoff", { terminalByScenario: { "crash-loop-backoff": INSUFFICIENT }, staleSseTerminal: true }, INSUFFICIENT);
  assert.throws(() => validateReplayEvents(stale.events, stale.detail.eventCursor, stale.detail.repair, INSUFFICIENT), coded("sse_replay_invalid", "SSE replay omitted a required Incident lifecycle event"));

  const failed = await trialFor("crash-loop-backoff", { terminalByScenario: { "crash-loop-backoff": { ...FAILED, retryable: false } } }, FAILED);
  assert.equal(validateReplayEvents(failed.events, failed.detail.eventCursor, failed.detail.repair, FAILED).eventTypes.includes("run.failed"), true);
  assert.throws(() => validateReplayEvents(failed.events, failed.detail.eventCursor, failed.detail.repair, { outcome: "failed", errorCode: "another_error" }), coded("sse_replay_invalid"));
  const failedDrift = await trialFor("crash-loop-backoff", { terminalByScenario: { "crash-loop-backoff": FAILED }, sseTerminalStateDrift: true }, FAILED);
  assert.throws(() => validateReplayEvents(failedDrift.events, failedDrift.detail.eventCursor, failedDrift.detail.repair, FAILED), coded("sse_replay_invalid"));
  const staleFailure = failed.events.map((event) => (event.event === "run.failed" ? withPayload(event, { incidentStatus: "DIAGNOSED" }) : event));
  assert.throws(() => validateReplayEvents(staleFailure, failed.detail.eventCursor, null, FAILED), coded("sse_replay_invalid"));
  assert.throws(() => validateReplayEvents(failed.events, failed.detail.eventCursor, { drift: true } as unknown as typeof failed.detail.repair, FAILED), coded("sse_replay_invalid"));
});
