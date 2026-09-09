import { describe, expect, it } from "vitest";

import {
  DIAGNOSIS_ID,
  INCIDENT_ID,
  REPAIR_PROPOSAL_DIGEST,
  REPAIR_PROPOSAL_ID,
  RUN_ID,
  makeIncidentDetail,
} from "@/test/agent-runtime-fixtures";

import { parseRunEventHistoryResponse } from "./response-contracts";
import {
  createIncidentStreamState,
  parseRunEvent,
  reduceIncidentStream,
} from "./sse";

const OTHER_RUN_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_INCIDENT_ID = "66666666-6666-4666-8666-666666666666";

function incidentCreated(id: string) {
  return parseRunEvent(
    "incident.created",
    id,
    JSON.stringify({
      schemaVersion: 4,
      incidentId: INCIDENT_ID,
      runId: RUN_ID,
      attempt: 1,
      incidentStatus: "RECEIVED",
      runStatus: "QUEUED",
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
      schemaVersion: 4,
      incidentId: INCIDENT_ID,
      runId,
      attempt: 2,
      runStatus: "QUEUED",
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
      schemaVersion: 4,
      incidentId: INCIDENT_ID,
      runId,
      attempt: runId === RUN_ID ? 1 : 2,
      incidentStatus: "TRIAGING",
      runStatus: "RUNNING",
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
      schemaVersion: 4,
      incidentId: INCIDENT_ID,
      runId,
      diagnosisId: DIAGNOSIS_ID,
      incidentStatus: "DIAGNOSED",
      runStatus: "COMPLETED",
      outcome: "diagnosed",
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
      schemaVersion: 4,
      incidentId: INCIDENT_ID,
      runId: RUN_ID,
      diagnosisId: DIAGNOSIS_ID,
      incidentStatus: "DIAGNOSED",
      runStatus: "RUNNING",
      outcome: "diagnosed",
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
      schemaVersion: 4,
      incidentId: INCIDENT_ID,
      runId: RUN_ID,
      proposalId: REPAIR_PROPOSAL_ID,
      proposalDigest: REPAIR_PROPOSAL_DIGEST,
      incidentStatus,
      runStatus,
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
      schemaVersion: 4,
      incidentId: INCIDENT_ID,
      runId,
      alertStatus: "RESOLVED",
      endsAt: "2026-08-29T01:05:00.000000001Z",
      occurredAt: "2026-08-29T01:05:01Z",
    }),
    INCIDENT_ID,
  );
}

describe("parseRunEvent", () => {
  it("accepts the v4 run.queued contract and preserves int64 ids", () => {
    const event = runQueued("9007199254740993");
    expect(event.id).toBe("9007199254740993");
    expect(event.event).toBe("run.queued");
  });

  it.each([
    ["v1 payload", { schemaVersion: 1 }],
    ["missing attempt", { schemaVersion: 4 }],
    ["zero attempt", { schemaVersion: 4, attempt: 0 }],
    ["first attempt", { schemaVersion: 4, attempt: 1 }],
    [
      "another Incident owner",
      { schemaVersion: 4, attempt: 2, incidentId: OTHER_INCIDENT_ID },
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
          occurredAt: "2026-08-29T01:00:01Z",
          ...override,
        }),
        INCIDENT_ID,
      ),
    ).toThrow("Invalid incident event");
  });

  it("binds REST event history to its Incident and Run owners", () => {
    const response = {
      schemaVersion: 4,
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
          schemaVersion: 4,
          incidentId: INCIDENT_ID,
          runId: RUN_ID,
          alertStatus: "RESOLVED",
          endsAt: "2026-08-29T01:05:00Z",
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
          schemaVersion: 4,
          incidentId: INCIDENT_ID,
          runId: RUN_ID,
          proposalId: REPAIR_PROPOSAL_ID,
          proposalDigest: "sha256:ABC",
          incidentStatus: "PATCH_READY",
          runStatus: "RUNNING",
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

    expect(connected.detail.selectedRun.status).toBe("COMPLETED");
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
    expect(state.detail.selectedRun.status).toBe("RUNNING");
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
    expect(state.detail.selectedRun.status).toBe("COMPLETED");
    expect(state.detailRefreshEventId).toBe("5");
  });

  it("isolates a selected historical Run while reflecting current Incident status", () => {
    const detail = makeIncidentDetail();
    detail.eventCursor = "1";
    const historical = createIncidentStreamState(detail, false);
    const afterCurrentStart = reduceIncidentStream(historical, {
      type: "event",
      event: runStarted("2", OTHER_RUN_ID),
    });

    expect(afterCurrentStart.detail.incident.status).toBe("TRIAGING");
    expect(afterCurrentStart.detail.selectedRun.id).toBe(RUN_ID);
    expect(afterCurrentStart.detail.selectedRun.status).toBe("QUEUED");
    expect(afterCurrentStart.events).toEqual([]);
    expect(afterCurrentStart.detailRefreshEventId).toBeNull();
  });

  it("marks a new queued Run for refresh only in latest mode", () => {
    const detail = makeIncidentDetail();
    detail.eventCursor = "1";
    const event = runQueued("2", OTHER_RUN_ID);

    const latest = reduceIncidentStream(createIncidentStreamState(detail), {
      type: "event",
      event,
    });
    const historical = reduceIncidentStream(
      createIncidentStreamState(detail, false),
      { type: "event", event },
    );

    expect(latest.detailRefreshEventId).toBe("2");
    expect(historical.detailRefreshEventId).toBeNull();
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
    expect(afterResolved.detail.selectedRun.status).toBe("COMPLETED");
  });
});
