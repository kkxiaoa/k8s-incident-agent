import { describe, expect, it } from "vitest";

import {
  DIAGNOSIS_ID,
  INCIDENT_ID,
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
      schemaVersion: 2,
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
      schemaVersion: 2,
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
      schemaVersion: 2,
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
      schemaVersion: 2,
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

describe("parseRunEvent", () => {
  it("accepts the v2 run.queued contract and preserves int64 ids", () => {
    const event = runQueued("9007199254740993");
    expect(event.id).toBe("9007199254740993");
    expect(event.event).toBe("run.queued");
  });

  it.each([
    ["v1 payload", { schemaVersion: 1 }],
    ["missing attempt", { schemaVersion: 2 }],
    ["zero attempt", { schemaVersion: 2, attempt: 0 }],
    ["first attempt", { schemaVersion: 2, attempt: 1 }],
    [
      "another Incident owner",
      { schemaVersion: 2, attempt: 2, incidentId: OTHER_INCIDENT_ID },
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
      schemaVersion: 2,
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
});
