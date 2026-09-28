import type { ExpectedTerminal } from "../../contracts/dataset.ts";
import type { SseReplayCheck } from "../../contracts/records.ts";
import type { IncidentDetail, RunEvent } from "../../contracts/runtime-api.ts";
import { contractError, upstreamContractError } from "../../shared/errors.ts";
import { isPlainObject, isUuid } from "../../shared/guards.ts";
import { FAILED_INCIDENT_STATUSES } from "./terminal.ts";

// The persisted Run event that ends each expected terminal, with the states it must carry.
const TERMINAL_EVENTS: Readonly<Record<ExpectedTerminal["outcome"], string>> = Object.freeze({
  diagnosed: "diagnosis.completed",
  insufficient_evidence: "diagnosis.insufficient",
  failed: "run.failed",
});

const REPAIR_EVENT_NAMES = ["repair.patch_ready", "repair.dry_run_passed", "repair.waiting_approval"] as const;
const REPAIR_EVENT_STATUSES: ReadonlyArray<readonly [string, string]> = [
  ["PATCH_READY", "RUNNING"],
  ["DRY_RUN_PASSED", "RUNNING"],
  ["WAITING_APPROVAL", "COMPLETED"],
];

function payload(event: RunEvent | undefined): Record<string, unknown> | undefined {
  const data: unknown = event?.data;
  return isPlainObject(data) ? data : undefined;
}

export function requireReplayIdentity(cursor: unknown, runId: unknown): void {
  if (typeof cursor !== "string" || !/^[1-9][0-9]*$/.test(cursor)) throw upstreamContractError();
  if (!isUuid(runId)) throw upstreamContractError();
}

// Everything the replayed events must prove once the stream has been read: they reach the
// persisted cursor, span the Incident lifecycle and end in the terminal the case expects.
export function validateReplayEvents(
  events: readonly RunEvent[],
  cursor: string,
  repair: IncidentDetail["repair"],
  expectedTerminal: ExpectedTerminal,
): SseReplayCheck {
  if (events.length === 0 || events[events.length - 1].id !== cursor) {
    throw contractError("sse_replay_incomplete", "SSE replay did not reach the persisted event cursor");
  }
  const eventTypes = new Set<string>(events.map((item) => item.event));
  if (
    !eventTypes.has("incident.created") ||
    !eventTypes.has("run.started") ||
    !eventTypes.has(TERMINAL_EVENTS[expectedTerminal.outcome])
  ) {
    throw contractError("sse_replay_invalid", "SSE replay omitted a required Incident lifecycle event");
  }
  requireTerminalEventSequence(events, repair, expectedTerminal);
  return { events: events.length, eventTypes: [...eventTypes].sort(), finalCursorMatched: true };
}

function requireTerminalEventSequence(
  events: readonly RunEvent[],
  repair: IncidentDetail["repair"],
  expectedTerminal: ExpectedTerminal,
): void {
  const matchingRepairEvents = REPAIR_EVENT_NAMES.map((name) => events.filter((event) => event.event === name));
  const repairEvents = matchingRepairEvents.map(([event]) => event);
  const diagnosis = events.find((event) => event.event === TERMINAL_EVENTS[expectedTerminal.outcome]);
  const data = payload(diagnosis);
  if (expectedTerminal.outcome !== "diagnosed") {
    const persisted = expectedTerminal.outcome === "insufficient_evidence"
      ? data?.outcome === "insufficient_evidence" && data.incidentStatus === "INSUFFICIENT_EVIDENCE" && data.runStatus === "COMPLETED"
      : data?.errorCode === expectedTerminal.errorCode && data.runStatus === "FAILED" && FAILED_INCIDENT_STATUSES.has(String(data.incidentStatus));
    if (!persisted || repair !== null || repairEvents.some((event) => event !== undefined)) {
      throw contractError("sse_replay_invalid", "SSE replay did not persist the terminal Run event the case expects");
    }
    return;
  }
  if (repair === null) {
    if (
      repairEvents.some((event) => event !== undefined) ||
      data?.incidentStatus !== "DIAGNOSED" ||
      data?.runStatus !== "COMPLETED"
    ) {
      throw contractError("sse_replay_invalid", "SSE replay exposed repair events for a diagnosis-only Run");
    }
    return;
  }
  const proposal: unknown = repair;
  if (
    !isPlainObject(proposal) ||
    data?.incidentStatus !== "DIAGNOSED" ||
    data?.runStatus !== "RUNNING" ||
    matchingRepairEvents.some((matching) => matching.length !== 1) ||
    repairEvents.some((event) => event === undefined) ||
    repairEvents.some((event, index) => {
      const fields = payload(event);
      return (
        fields?.proposalId !== proposal.id ||
        fields?.proposalDigest !== proposal.digest ||
        fields?.incidentStatus !== REPAIR_EVENT_STATUSES[index][0] ||
        fields?.runStatus !== REPAIR_EVENT_STATUSES[index][1]
      );
    })
  ) {
    throw contractError("sse_replay_invalid", "SSE replay omitted or changed the repair lifecycle contract");
  }
  const positions = [events.indexOf(diagnosis as RunEvent), ...repairEvents.map((event) => events.indexOf(event as RunEvent))];
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
    throw contractError("sse_replay_invalid", "SSE replay changed the repair lifecycle order");
  }
}
