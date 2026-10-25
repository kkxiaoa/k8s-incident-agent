import { describe, expect, it } from "vitest";

import {
  DIAGNOSIS_ID,
  INCIDENT_ID,
  REPAIR_PROPOSAL_DIGEST,
  REPAIR_PROPOSAL_ID,
  RUN_ID,
  makeIncidentDetail,
  makeIncidentWithoutRuns,
  makeWaitingApprovalIncidentDetail,
  makeRepairRunWaitingDetail,
  makeRecoveryDetail,
  makeRollbackRecoveryDetail,
} from "@/test/agent-runtime-fixtures";

import { parseRunEventHistoryResponse } from "./response-contracts";
import {
  createIncidentStreamState,
  isTerminalRunEvent,
  parseRunEvent,
  reduceIncidentStream,
  requiresIncidentDetailRefresh,
} from "./sse";

const OTHER_RUN_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_INCIDENT_ID = "66666666-6666-4666-8666-666666666666";

it.each([false, true])("replays closure and reopen without rewriting Run history, no Run=%s", (noRun) => {
  const detail = noRun ? makeIncidentWithoutRuns() : makeIncidentDetail();
  const common = { schemaVersion: 6, incidentId: INCIDENT_ID, runId: null, runKind: null, occurredAt: "2026-09-03T00:10:00Z" };
  const closed = { ...common, basis: "observed_stable", healthySince: "2026-09-03T00:05:00Z", lastHealthyAt: common.occurredAt, targetUid: "workload-uid", verificationRunId: null };
  const closeEvent = parseRunEvent("incident.closed", "10", JSON.stringify(closed), INCIDENT_ID)!;
  expect(requiresIncidentDetailRefresh(closeEvent, detail.selectedRun?.id ?? null)).toBe(true);
  expect(isTerminalRunEvent(closeEvent)).toBe(false);
  const state = reduceIncidentStream(createIncidentStreamState(detail), { type: "event", event: closeEvent });
  expect(state.detail.incident.lifecycleStatus).toBe("CLOSED");
  expect(state.detail.incident.status).toBe(detail.incident.status);
  expect(state.detail.selectedRun).toEqual(detail.selectedRun);
  expect(state.events).toEqual(detail.eventPage.items);
  expect(reduceIncidentStream(state, { type: "event", event: closeEvent })).toEqual(state);
  const behind = reduceIncidentStream(state, { type: "snapshot", afterEventId: "10", detail: { ...detail, eventCursor: "9" } });
  expect(behind.detail.incident.lifecycleStatus).toBe("CLOSED");
  expect(behind.detail.incident.updatedAt).toBe(common.occurredAt);
  expect(behind.detail.closure).toEqual({ basis: "observed_stable", closedAt: common.occurredAt });
  const reopened = { ...common, reason: "manual_rerun", previousClosedAt: common.occurredAt };
  const reopenEvent = parseRunEvent("incident.reopened", "11", JSON.stringify(reopened), INCIDENT_ID)!;
  const next = reduceIncidentStream(behind, { type: "event", event: reopenEvent });
  expect(next.detail.incident.lifecycleStatus).toBe("OPEN");
  expect(next.detail.closure).toEqual(behind.detail.closure);
  expect(next.detail.selectedRun).toEqual(detail.selectedRun);
  expect(next.detail.incident.status).toBe(detail.incident.status);
  for (const invalid of [{ runId: RUN_ID }, { runKind: "repair" }, { basis: "unknown" }, { verificationRunId: RUN_ID }, { basis: "recovery_verified" }]) {
    expect(() => parseRunEvent("incident.closed", "12", JSON.stringify({ ...closed, ...invalid }), INCIDENT_ID)).toThrow();
  }
  expect(() => parseRunEvent("incident.reopened", "12", JSON.stringify({ ...reopened, reason: "automatic" }), INCIDENT_ID)).toThrow();
});

it.each([
  ["alert.associated", { source: { type: "alertmanager", ref: "K8sIncidentCrashLoopBackOff", revision: "v1" }, fingerprint: "0123456789abcdef", startsAt: "2026-09-03T00:00:00.000000000Z", targetUid: "workload-uid" }],
  ["diagnosis.change_recorded", { change: { source: { type: "alertmanager", ref: "K8sIncidentCrashLoopBackOff", revision: "v1" }, fingerprint: "0123456789abcdef", startsAt: "2026-09-03T00:00:00.000000000Z", eventId: "10" } }],
  ["diagnosis.deferred", { deferral: { reason: "busy", reviewAfter: null } }],
])("refreshes %s without changing the selected historical Run or its progress", (name, fields) => {
  const detail = makeIncidentDetail();
  const payload = { schemaVersion: 6, incidentId: INCIDENT_ID, runId: null, runKind: null,
    occurredAt: "2026-09-03T00:10:00Z", ...fields };
  const event = parseRunEvent(name, "10", JSON.stringify(payload), INCIDENT_ID);
  expect(requiresIncidentDetailRefresh(event, detail.selectedRun.id)).toBe(true);
  const state = reduceIncidentStream(createIncidentStreamState(detail), { type: "event", event });
  expect(state.events).toEqual([]);
  expect(state.detail.selectedRun).toEqual(detail.selectedRun);
  expect(state.detail.incident.status).toEqual(detail.incident.status);
  expect(state.detailRefreshEventId).toBe("10");
  expect(() => parseRunEvent(name, "10", JSON.stringify({ ...payload, runId: RUN_ID }), INCIDENT_ID)).toThrow();
});

it("accepts a first Run queued after the Incident was saved without a Run", () => {
  const event = parseRunEvent("run.queued", "2", JSON.stringify({ schemaVersion: 6, incidentId: INCIDENT_ID,
    runId: RUN_ID, runKind: "diagnosis", occurredAt: "2026-09-03T00:00:00Z", attempt: 1, runStatus: "QUEUED" }), INCIDENT_ID);
  expect(requiresIncidentDetailRefresh(event, null)).toBe(true);
  expect(reduceIncidentStream(createIncidentStreamState(makeIncidentWithoutRuns()), { type: "event", event }).detail.selectedRun).toBeNull();
});

it.each([false, true])("replays Incident-owned notifications without changing Run state, no Run=%s", (noRun) => {
  const detail = noRun ? makeIncidentWithoutRuns() : makeIncidentDetail();
  const payload = { schemaVersion: 6, incidentId: INCIDENT_ID, runId: null, runKind: null,
    occurredAt: "2026-09-03T00:10:00Z", fingerprint: "0123456789abcdef", alertStatus: "FIRING",
    startsAt: "2026-09-03T00:00:00.000000001Z", endsAt: "2026-09-03T00:05:00.000000000Z" };
  const event = parseRunEvent("alert.notification", "10", JSON.stringify(payload), INCIDENT_ID)!;
  expect(requiresIncidentDetailRefresh(event, detail.selectedRun?.id ?? null)).toBe(true);
  expect(isTerminalRunEvent(event)).toBe(false);
  const state = reduceIncidentStream(createIncidentStreamState(detail), { type: "event", event });
  expect(state.detail.selectedRun).toEqual(detail.selectedRun);
  expect(state.detail.incident.status).toBe(detail.incident.status);
  expect(state.detail.eventPage.items).toEqual([]);
  expect(reduceIncidentStream(state, { type: "event", event })).toEqual(state);
  for (const invalid of [{ runId: RUN_ID }, { runKind: "diagnosis" }, { incidentId: OTHER_INCIDENT_ID }, { alertStatus: "RESOLVED", endsAt: null }]) {
    expect(() => parseRunEvent("alert.notification", "11", JSON.stringify({ ...payload, ...invalid }), INCIDENT_ID)).toThrow();
  }
});

it.each([
  ["apply", "observing"], ["apply", "recovered"], ["apply", "monitoring_unavailable"],
  ["rollback", "observing"], ["rollback", "recovered"], ["rollback", "monitoring_unavailable"],
] as const)("refreshes %s %s verification and deduplicates its replay", (operation, outcome) => {
  const detail = operation === "rollback" ? makeRollbackRecoveryDetail(outcome) : makeRecoveryDetail(outcome);
  const payload = { schemaVersion: 6, incidentId: detail.incident.id, runId: detail.selectedRun.id, runKind: "repair", occurredAt: "2026-09-14T01:01:02Z", executionId: detail.verification!.executionId,
    outcome, reason: detail.verification!.reason, sampleCount: detail.verification!.sampleCount, runStatus: detail.selectedRun.status, incidentStatus: detail.incident.status };
  const event = parseRunEvent("repair.verification_updated", "999", JSON.stringify(payload), detail.incident.id)!;
  expect(requiresIncidentDetailRefresh(event, detail.selectedRun.id)).toBe(true);
  expect(isTerminalRunEvent(event)).toBe(outcome !== "observing");
  const state = reduceIncidentStream(createIncidentStreamState(detail), { type: "event", event });
  expect(reduceIncidentStream(state, { type: "event", event })).toEqual(state);
  expect(() => parseRunEvent("repair.verification_updated", "999", JSON.stringify({ ...payload, runStatus: "QUEUED" }), detail.incident.id)).toThrow("Invalid incident event");
});

it.each([
  ["CLAIMED", "RUNNING", "APPLYING"],
  ["APPLIED", "RUNNING", "VERIFYING"],
  ["UNKNOWN", "FAILED", "FAILED"],
] as const)("projects %s and refreshes the authoritative ledger", (executionStatus, runStatus, incidentStatus) => {
  const detail = makeRepairRunWaitingDetail();
  const payload = { schemaVersion: 6, incidentId: detail.incident.id, runId: detail.selectedRun.id, runKind: "repair", occurredAt: "2026-09-13T01:00:00Z", approvalId: OTHER_RUN_ID, executionId: OTHER_INCIDENT_ID, executionStatus, runStatus, incidentStatus, lateResult: false };
  const event = parseRunEvent("repair.execution_updated", "999", JSON.stringify(payload), detail.incident.id)!;
  expect(event).not.toBeNull();
  expect(requiresIncidentDetailRefresh(event, detail.selectedRun.id)).toBe(true);
  expect(isTerminalRunEvent(event)).toBe(runStatus === "FAILED");
  const state = reduceIncidentStream(createIncidentStreamState(detail), { type: "event", event });
  expect(state.detail.incident.status).toBe(incidentStatus);
  expect(state.detail.selectedRun?.status).toBe(runStatus);
  expect(() => parseRunEvent("repair.execution_updated", "999", JSON.stringify({ ...payload, incidentStatus: "RESOLVED" }), detail.incident.id)).toThrow("Invalid incident event");
});

function incidentCreated(id: string) {
  return parseRunEvent(
    "incident.created",
    id,
    JSON.stringify({
      schemaVersion: 6,
      incidentId: INCIDENT_ID,
      runId: RUN_ID,
      attempt: 1,
      incidentStatus: "RECEIVED",
      runStatus: "QUEUED",
      runKind: "diagnosis",
      occurredAt: "2026-08-29T01:00:00Z",
    }),
    INCIDENT_ID,
  );
}

function runQueued(id: string, runId = OTHER_RUN_ID) {
  return parseRunEvent(
    "run.queued",
    id,
    JSON.stringify({
      schemaVersion: 6,
      incidentId: INCIDENT_ID,
      runId,
      attempt: 2,
      runStatus: "QUEUED",
      runKind: "diagnosis",
      occurredAt: "2026-08-29T01:00:01Z",
    }),
    INCIDENT_ID,
  );
}

function runStarted(id: string, runId = RUN_ID) {
  return parseRunEvent(
    "run.started",
    id,
    JSON.stringify({
      schemaVersion: 6,
      incidentId: INCIDENT_ID,
      runId,
      attempt: runId === RUN_ID ? 1 : 2,
      incidentStatus: "TRIAGING",
      runStatus: "RUNNING",
      runKind: "diagnosis",
      occurredAt: "2026-08-29T01:00:02Z",
    }),
    INCIDENT_ID,
  );
}

function diagnosisCompleted(id: string, runId = RUN_ID) {
  return parseRunEvent(
    "diagnosis.completed",
    id,
    JSON.stringify({
      schemaVersion: 6,
      incidentId: INCIDENT_ID,
      runId,
      diagnosisId: DIAGNOSIS_ID,
      incidentStatus: "DIAGNOSED",
      runStatus: "COMPLETED",
      outcome: "diagnosed",
      runKind: "diagnosis",
      occurredAt: "2026-08-29T01:00:04Z",
    }),
    INCIDENT_ID,
  );
}

function repairDiagnosisCompleted(id: string) {
  return parseRunEvent(
    "diagnosis.completed",
    id,
    JSON.stringify({
      schemaVersion: 6,
      incidentId: INCIDENT_ID,
      runId: RUN_ID,
      diagnosisId: DIAGNOSIS_ID,
      incidentStatus: "DIAGNOSED",
      runStatus: "RUNNING",
      outcome: "diagnosed",
      runKind: "diagnosis",
      occurredAt: "2026-08-29T01:00:04Z",
    }),
    INCIDENT_ID,
  );
}

function repairEvent(
  name:
    | "repair.patch_ready"
    | "repair.dry_run_passed"
    | "repair.waiting_approval",
  id: string,
) {
  const statuses = {
    "repair.patch_ready": ["PATCH_READY", "RUNNING"],
    "repair.dry_run_passed": ["DRY_RUN_PASSED", "RUNNING"],
    "repair.waiting_approval": ["WAITING_APPROVAL", "COMPLETED"],
  } as const;
  const [incidentStatus, runStatus] = statuses[name];
  return parseRunEvent(
    name,
    id,
    JSON.stringify({
      schemaVersion: 6,
      incidentId: INCIDENT_ID,
      runId: RUN_ID,
      proposalId: REPAIR_PROPOSAL_ID,
      proposalDigest: REPAIR_PROPOSAL_DIGEST,
      incidentStatus,
      runStatus,
      runKind: "diagnosis",
      occurredAt: "2026-08-29T01:00:05Z",
    }),
    INCIDENT_ID,
  );
}

function alertResolved(id: string, runId = RUN_ID) {
  return parseRunEvent(
    "alert.resolved",
    id,
    JSON.stringify({
      schemaVersion: 6,
      incidentId: INCIDENT_ID,
      runId,
      alertStatus: "RESOLVED",
      endsAt: "2026-08-29T01:05:00.000000001Z",
      runKind: "diagnosis",
      occurredAt: "2026-08-29T01:05:01Z",
    }),
    INCIDENT_ID,
  );
}

describe("parseRunEvent", () => {
  it.each(["expired", "superseded", "withdrawn"])("ends a %s repair wait and refreshes the authoritative detail", (reason) => {
    const detail = makeRepairRunWaitingDetail();
    const payload = {
      schemaVersion: 6, incidentId: INCIDENT_ID, runId: detail.selectedRun.id,
      runKind: "repair", runStatus: "COMPLETED", incidentStatus: "DIAGNOSED",
      occurredAt: "2026-08-29T01:16:00Z", reason,
    };
    const event = parseRunEvent("repair.wait_ended", "2", JSON.stringify(payload), INCIDENT_ID);
    expect(isTerminalRunEvent(event)).toBe(true);
    const state = reduceIncidentStream(createIncidentStreamState(detail), { type: "event", event });
    expect(state.detail.selectedRun?.status).toBe("COMPLETED");
    expect(state.detail.incident.status).toBe("DIAGNOSED");
    expect(state.detailRefreshEventId).toBe("2");
    for (const change of [{ reason: "approved" }, { runKind: "diagnosis" }, { runStatus: "WAITING_APPROVAL" }]) {
      expect(() => parseRunEvent("repair.wait_ended", "2", JSON.stringify({ ...payload, ...change }), INCIDENT_ID)).toThrow();
    }
  });

  it("accepts repair start in PATCH_READY, never diagnosis TRIAGING", () => {
    const payload = { ...runStarted("2").data, runKind: "repair", incidentStatus: "PATCH_READY" };
    expect(parseRunEvent("run.started", "2", JSON.stringify(payload), INCIDENT_ID).data.runKind).toBe("repair");
    expect(() => parseRunEvent("run.started", "2", JSON.stringify({ ...payload, incidentStatus: "TRIAGING" }), INCIDENT_ID)).toThrow();
  });
  it("refreshes a new repair waiting proposal without turning it into a terminal Run", () => {
    const detail = makeRepairRunWaitingDetail();
    detail.selectedRun.status = "RUNNING";
    const payload = {
      ...repairEvent("repair.waiting_approval", "2").data,
      runId: detail.selectedRun.id,
      runKind: "repair",
      runStatus: "WAITING_APPROVAL",
    };
    const waiting = parseRunEvent("repair.waiting_approval", "2", JSON.stringify(payload), INCIDENT_ID);
    expect(isTerminalRunEvent(waiting)).toBe(false);
    expect(isTerminalRunEvent(repairEvent("repair.waiting_approval", "2"))).toBe(true);
    const state = reduceIncidentStream(
      reduceIncidentStream(createIncidentStreamState(detail), { type: "connected" }),
      { type: "event", event: waiting },
    );
    expect(state.connection).toBe("live");
    expect(state.detail.selectedRun?.status).toBe("WAITING_APPROVAL");
    expect(state.detail.selectedRun?.completedAt).toBeNull();
    expect(state.detailRefreshEventId).toBe("2");
    for (const fields of [
      { runKind: "repair", runStatus: "COMPLETED" },
      { runKind: "diagnosis", runStatus: "WAITING_APPROVAL" },
      { runKind: undefined },
    ]) {
      expect(() => parseRunEvent("repair.waiting_approval", "2", JSON.stringify({ ...payload, ...fields }), INCIDENT_ID)).toThrow();
    }
  });
  it("accepts the v5 run.queued contract and preserves int64 ids", () => {
    const event = runQueued("9007199254740993");
    expect(event.id).toBe("9007199254740993");
    expect(event.event).toBe("run.queued");
  });

  it.each([
    ["v1 payload", { schemaVersion: 1 }],
    ["missing attempt", { schemaVersion: 6 }],
    ["zero attempt", { schemaVersion: 6, attempt: 0 }],
    [
      "another Incident owner",
      { schemaVersion: 6, attempt: 2, incidentId: OTHER_INCIDENT_ID },
    ],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      parseRunEvent(
        "run.queued",
        "2",
        JSON.stringify({
          incidentId: INCIDENT_ID,
          runId: RUN_ID,
          runStatus: "QUEUED",
          runKind: "diagnosis",
          occurredAt: "2026-08-29T01:00:01Z",
          ...override,
        }),
        INCIDENT_ID,
      ),
    ).toThrow("Invalid incident event");
  });

  it("binds REST event history to its Incident and Run owners", () => {
    const response = {
      schemaVersion: 6,
      items: [runStarted("2")],
      nextCursor: null,
    };

    expect(
      parseRunEventHistoryResponse(response, INCIDENT_ID, RUN_ID),
    ).not.toBeNull();
    expect(
      parseRunEventHistoryResponse(response, INCIDENT_ID, OTHER_RUN_ID),
    ).toBeNull();
    expect(
      parseRunEventHistoryResponse(response, OTHER_INCIDENT_ID, RUN_ID),
    ).toBeNull();
  });

  it("accepts resolved only as an alert signal event", () => {
    const event = alertResolved("3");

    expect(event.event).toBe("alert.resolved");
    expect(event.data).not.toHaveProperty("incidentStatus");
    expect(event.data).not.toHaveProperty("runStatus");
  });

  it("rejects alert.resolved without the canonical nanosecond form", () => {
    expect(() =>
      parseRunEvent(
        "alert.resolved",
        "3",
        JSON.stringify({
          schemaVersion: 6,
          incidentId: INCIDENT_ID,
          runId: RUN_ID,
          alertStatus: "RESOLVED",
          endsAt: "2026-08-29T01:05:00Z",
          runKind: "diagnosis",
          occurredAt: "2026-08-29T01:05:01Z",
        }),
        INCIDENT_ID,
      ),
    ).toThrow("Invalid incident event");
  });

  it("accepts the fixed repair event family and rejects an invalid digest", () => {
    expect(repairEvent("repair.patch_ready", "4").event).toBe(
      "repair.patch_ready",
    );
    expect(repairEvent("repair.dry_run_passed", "5").event).toBe(
      "repair.dry_run_passed",
    );
    expect(repairEvent("repair.waiting_approval", "6").event).toBe(
      "repair.waiting_approval",
    );

    expect(() =>
      parseRunEvent(
        "repair.patch_ready",
        "4",
        JSON.stringify({
          schemaVersion: 6,
          incidentId: INCIDENT_ID,
          runId: RUN_ID,
          proposalId: REPAIR_PROPOSAL_ID,
          proposalDigest: "sha256:ABC",
          incidentStatus: "PATCH_READY",
          runStatus: "RUNNING",
          runKind: "diagnosis",
          occurredAt: "2026-08-29T01:00:05Z",
        }),
        INCIDENT_ID,
      ),
    ).toThrow("Invalid incident event");
  });
});

describe("reduceIncidentStream", () => {
  it("starts from the bounded detail events and same-snapshot cursor", () => {
    const detail = makeIncidentDetail();
    detail.eventCursor = "12";
    detail.eventPage.items = [runStarted("10"), incidentCreated("9")];
    detail.eventPage.nextCursor = "9";

    const state = createIncidentStreamState(detail);

    expect(state.events.map((event) => event.id)).toEqual(["9", "10"]);
    expect(state.lastEventId).toBe("12");
    expect(state.eventPageCursor).toBe("9");
  });

  it("keeps the Incident stream live after a terminal event", () => {
    const detail = makeIncidentDetail();
    detail.eventCursor = "1";
    const initial = createIncidentStreamState(detail);
    const terminal = reduceIncidentStream(initial, {
      type: "event",
      event: diagnosisCompleted("2"),
    });
    const connected = reduceIncidentStream(terminal, { type: "connected" });

    expect(connected.detail.selectedRun?.status).toBe("COMPLETED");
    expect(connected.connection).toBe("live");
  });

  it("keeps repair diagnosis non-terminal until waiting approval", () => {
    const detail = makeIncidentDetail();
    detail.eventCursor = "1";
    let state = createIncidentStreamState(detail);

    state = reduceIncidentStream(state, {
      type: "event",
      event: repairDiagnosisCompleted("2"),
    });
    expect(state.detail.incident.status).toBe("DIAGNOSED");
    expect(state.detail.selectedRun?.status).toBe("RUNNING");
    expect(state.detailRefreshEventId).toBeNull();

    state = reduceIncidentStream(state, {
      type: "event",
      event: repairEvent("repair.patch_ready", "3"),
    });
    expect(state.detail.incident.status).toBe("PATCH_READY");
    expect(state.detailRefreshEventId).toBeNull();

    state = reduceIncidentStream(state, {
      type: "event",
      event: repairEvent("repair.dry_run_passed", "4"),
    });
    expect(state.detail.incident.status).toBe("DRY_RUN_PASSED");
    expect(state.detailRefreshEventId).toBeNull();

    state = reduceIncidentStream(state, {
      type: "event",
      event: repairEvent("repair.waiting_approval", "5"),
    });
    expect(state.detail.incident.status).toBe("WAITING_APPROVAL");
    expect(state.detail.selectedRun?.status).toBe("COMPLETED");
    expect(state.detailRefreshEventId).toBe("5");
  });

  it("isolates a selected historical Run while reflecting current Incident status", () => {
    const detail = makeIncidentDetail();
    detail.eventCursor = "1";
    const historical = createIncidentStreamState(detail);
    const afterCurrentStart = reduceIncidentStream(historical, {
      type: "event",
      event: runStarted("2", OTHER_RUN_ID),
    });

    expect(afterCurrentStart.detail.incident.status).toBe("TRIAGING");
    expect(afterCurrentStart.detail.selectedRun?.id).toBe(RUN_ID);
    expect(afterCurrentStart.detail.selectedRun?.status).toBe("QUEUED");
    expect(afterCurrentStart.events).toEqual([]);
    expect(afterCurrentStart.detailRefreshEventId).toBeNull();
  });

  it("refreshes action availability for a new Run even when viewing history", () => {
    const detail = makeIncidentDetail();
    detail.eventCursor = "1";
    const event = runQueued("2", OTHER_RUN_ID);

    const historical = reduceIncidentStream(
      createIncidentStreamState(detail),
      { type: "event", event },
    );

    expect(historical.detailRefreshEventId).toBe("2");
    const completed = parseRunEvent("run.failed", "3", JSON.stringify({
      schemaVersion: 6, incidentId: INCIDENT_ID, runId: OTHER_RUN_ID, runKind: "diagnosis",
      occurredAt: "2026-08-29T01:00:03Z", incidentStatus: "FAILED", runStatus: "FAILED",
      errorCode: "diagnosis_failed", retryable: false,
    }), INCIDENT_ID);
    expect(reduceIncidentStream(historical, { type: "event", event: completed }).detailRefreshEventId).toBe("3");
  });

  it("ignores duplicate and out-of-order global event ids", () => {
    const detail = makeIncidentDetail();
    detail.eventCursor = "8";
    const initial = createIncidentStreamState(detail);
    const afterTen = reduceIncidentStream(initial, {
      type: "event",
      event: runStarted("10"),
    });
    const afterNine = reduceIncidentStream(afterTen, {
      type: "event",
      event: runQueued("9"),
    });

    expect(afterNine).toBe(afterTen);
    expect(afterNine.lastEventId).toBe("10");
  });

  it("does not allow a stale detail refresh to replace a newer request", () => {
    const detail = makeIncidentDetail();
    detail.eventCursor = "1";
    const afterFirst = reduceIncidentStream(createIncidentStreamState(detail), {
      type: "event",
      event: diagnosisCompleted("2"),
    });
    const afterSecond = reduceIncidentStream(afterFirst, {
      type: "event",
      event: runQueued("3", OTHER_RUN_ID),
    });

    const stale = reduceIncidentStream(afterSecond, {
      type: "snapshot",
      afterEventId: "2",
      detail: makeIncidentDetail(),
    });
    expect(stale).toBe(afterSecond);
  });

  it("does not replay intermediate repair states over a newer persisted snapshot", () => {
    const initial = makeIncidentDetail();
    initial.eventCursor = "1";
    initial.eventPage = { items: [incidentCreated("1")], nextCursor: null };
    const waiting = reduceIncidentStream(createIncidentStreamState(initial), {
      type: "event", event: alertResolved("2"),
    });
    const persisted = makeWaitingApprovalIncidentDetail();
    persisted.eventCursor = "5";
    persisted.eventPage = {
      items: [repairEvent("repair.waiting_approval", "5"), repairEvent("repair.dry_run_passed", "4"), repairEvent("repair.patch_ready", "3")],
      nextCursor: "3",
    };
    const snapshot = reduceIncidentStream(waiting, {
      type: "snapshot", afterEventId: "2", detail: persisted,
    });
    const replay = reduceIncidentStream(snapshot, {
      type: "event", event: repairEvent("repair.patch_ready", "3"),
    });
    expect(replay.detail.incident.status).toBe("WAITING_APPROVAL");
    expect(replay.detail.selectedRun?.status).toBe("COMPLETED");
    expect(replay.lastEventId).toBe("5");
    expect(replay.eventPageCursor).toBe("3");
    expect(replay.events.map((event) => event.id)).toEqual(["1", "2", "3", "4", "5"]);
    const newer = reduceIncidentStream(replay, {
      type: "event", event: runStarted("6", OTHER_RUN_ID),
    });
    expect(newer.detail.incident.status).toBe("TRIAGING");
    expect(newer.detail.selectedRun?.status).toBe("COMPLETED");
  });

  it("keeps newer streamed statuses when a slow snapshot arrives", () => {
    const initial = makeIncidentDetail();
    initial.eventCursor = "1";
    const waiting = reduceIncidentStream(createIncidentStreamState(initial), {
      type: "event", event: alertResolved("2"),
    });
    const newer = reduceIncidentStream(waiting, {
      type: "event", event: repairEvent("repair.patch_ready", "3"),
    });
    const persisted = makeIncidentDetail();
    persisted.eventCursor = "2";
    const snapshot = reduceIncidentStream(newer, {
      type: "snapshot", afterEventId: "2", detail: persisted,
    });
    expect(snapshot.detail.incident.status).toBe("PATCH_READY");
    expect(snapshot.detail.selectedRun?.status).toBe("RUNNING");
    expect(snapshot.detail.evidence).toEqual(persisted.evidence);
    expect(snapshot.detail.eventCursor).toBe("2");
    expect(snapshot.lastEventId).toBe("3");
    expect(snapshot.events.map((event) => event.id)).toContain("3");
  });

  it("refreshes an Incident-level resolved signal without changing statuses", () => {
    const detail = makeIncidentDetail();
    detail.eventCursor = "1";
    detail.incident.status = "DIAGNOSED";
    detail.selectedRun.status = "COMPLETED";
    const afterResolved = reduceIncidentStream(
      createIncidentStreamState(detail),
      { type: "event", event: alertResolved("2") },
    );

    expect(afterResolved.detailRefreshEventId).toBe("2");
    expect(afterResolved.detail.incident.status).toBe("DIAGNOSED");
    expect(afterResolved.detail.selectedRun?.status).toBe("COMPLETED");
  });
});
