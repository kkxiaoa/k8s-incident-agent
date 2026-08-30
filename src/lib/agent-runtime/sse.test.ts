import { describe, expect, it } from "vitest";

import {
  DIAGNOSIS_ID,
  INCIDENT_ID,
  RUN_ID,
  makeIncidentDetail,
} from "@/test/agent-runtime-fixtures";

import {
  createIncidentStreamState,
  parseRunEvent,
  reduceIncidentStream,
} from "./sse";

function incidentCreated(id: string) {
  return parseRunEvent(
    "incident.created",
    id,
    JSON.stringify({
      schemaVersion: 1,
      incidentId: INCIDENT_ID,
      runId: RUN_ID,
      scenarioId: "image-pull-backoff",
      incidentStatus: "RECEIVED",
      runStatus: "QUEUED",
      occurredAt: "2026-08-29T01:00:00Z",
    }),
  );
}

function runStarted(id: string) {
  return parseRunEvent(
    "run.started",
    id,
    JSON.stringify({
      schemaVersion: 1,
      incidentId: INCIDENT_ID,
      runId: RUN_ID,
      incidentStatus: "TRIAGING",
      runStatus: "RUNNING",
      occurredAt: "2026-08-29T01:00:01Z",
    }),
  );
}

function diagnosisCompleted(id: string) {
  return parseRunEvent(
    "diagnosis.completed",
    id,
    JSON.stringify({
      schemaVersion: 1,
      incidentId: INCIDENT_ID,
      runId: RUN_ID,
      diagnosisId: DIAGNOSIS_ID,
      incidentStatus: "DIAGNOSED",
      runStatus: "COMPLETED",
      outcome: "diagnosed",
      occurredAt: "2026-08-29T01:00:04Z",
    }),
  );
}

describe("parseRunEvent", () => {
  it("preserves a valid event id beyond Number.MAX_SAFE_INTEGER", () => {
    const event = parseRunEvent(
      "tool.started",
      "9007199254740993",
      JSON.stringify({
        schemaVersion: 1,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        toolCallId: "tool-call-1",
        toolName: "get_pod",
        occurredAt: "2026-08-29T01:00:02Z",
      }),
    );

    expect(event.id).toBe("9007199254740993");
    expect(event.event).toBe("tool.started");
  });

  it.each([
    ["unknown event", "tool.finished", "1", "{}"],
    ["non-canonical id", "run.started", "01", "{}"],
    ["out-of-range id", "run.started", "9223372036854775808", "{}"],
    ["invalid JSON", "run.started", "1", "{"],
    [
      "invalid event payload",
      "run.started",
      "1",
      JSON.stringify({
        schemaVersion: 1,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        incidentStatus: "RECEIVED",
        runStatus: "RUNNING",
        occurredAt: "2026-08-29T01:00:01Z",
      }),
    ],
  ])("rejects %s", (_label, eventName, id, data) => {
    expect(() => parseRunEvent(eventName, id, data)).toThrow(
      "Invalid incident event",
    );
  });
});

describe("reduceIncidentStream", () => {
  it("does not regress a running REST snapshot while replaying incident.created", () => {
    const detail = makeIncidentDetail();
    detail.incident.status = "TRIAGING";
    detail.run.status = "RUNNING";
    const initial = createIncidentStreamState(detail);

    const replayingCreated = reduceIncidentStream(initial, {
      type: "event",
      event: incidentCreated("1"),
    });

    expect(replayingCreated.events.map((event) => event.id)).toEqual(["1"]);
    expect(replayingCreated.detail.incident.status).toBe("TRIAGING");
    expect(replayingCreated.detail.run.status).toBe("RUNNING");
  });

  it("accepts gaps but ignores duplicate and out-of-order event ids", () => {
    const initial = createIncidentStreamState(makeIncidentDetail());
    const afterTen = reduceIncidentStream(initial, {
      type: "event",
      event: runStarted("10"),
    });
    const afterTwelve = reduceIncidentStream(afterTen, {
      type: "event",
      event: diagnosisCompleted("12"),
    });
    const afterDuplicate = reduceIncidentStream(afterTwelve, {
      type: "event",
      event: diagnosisCompleted("12"),
    });
    const afterEleven = reduceIncidentStream(afterDuplicate, {
      type: "event",
      event: runStarted("11"),
    });

    expect(afterEleven.events.map((event) => event.id)).toEqual(["10", "12"]);
    expect(afterEleven.lastEventId).toBe("12");
    expect(afterEleven.detail.incident.status).toBe("DIAGNOSED");
    expect(afterEleven.detail.run.status).toBe("COMPLETED");
    expect(afterEleven.terminalSeen).toBe(true);
    expect(afterEleven.connection).toBe("closed");

    const afterLaterNonterminal = reduceIncidentStream(afterEleven, {
      type: "event",
      event: runStarted("13"),
    });
    expect(afterLaterNonterminal).toBe(afterEleven);
  });

  it("does not let an older REST refresh regress the latest event state", () => {
    const initial = createIncidentStreamState(makeIncidentDetail());
    const afterStart = reduceIncidentStream(initial, {
      type: "event",
      event: runStarted("20"),
    });
    const afterTerminal = reduceIncidentStream(afterStart, {
      type: "event",
      event: diagnosisCompleted("21"),
    });

    const staleSnapshot = makeIncidentDetail();
    const afterStaleSnapshot = reduceIncidentStream(afterTerminal, {
      type: "snapshot",
      afterEventId: "20",
      detail: staleSnapshot,
    });

    expect(afterStaleSnapshot.detail.incident.status).toBe("DIAGNOSED");

    const currentSnapshot = makeIncidentDetail();
    currentSnapshot.incident.status = "DIAGNOSED";
    currentSnapshot.run.status = "COMPLETED";
    currentSnapshot.diagnosis = {
      id: DIAGNOSIS_ID,
      outcome: "diagnosed",
      summary: "The image reference does not exist.",
      rootCauses: [],
      missingInformation: [],
      redacted: false,
      createdAt: "2026-08-29T01:00:04Z",
    };

    const afterCurrentSnapshot = reduceIncidentStream(afterStaleSnapshot, {
      type: "snapshot",
      afterEventId: "21",
      detail: currentSnapshot,
    });

    expect(afterCurrentSnapshot.detail.diagnosis?.summary).toBe(
      "The image reference does not exist.",
    );
    expect(afterCurrentSnapshot.events).toHaveLength(2);
  });

  it("does not let an older REST refresh overwrite the latest refresh result", () => {
    const initial = createIncidentStreamState(makeIncidentDetail());
    const afterStart = reduceIncidentStream(initial, {
      type: "event",
      event: runStarted("20"),
    });
    const afterTerminal = reduceIncidentStream(afterStart, {
      type: "event",
      event: diagnosisCompleted("21"),
    });
    const afterCurrentFailure = reduceIncidentStream(afterTerminal, {
      type: "refresh_failed",
      afterEventId: "21",
      message: "无法刷新持久化详情；实时事件仍保留在时间线中。",
    });

    const afterStaleSuccess = reduceIncidentStream(afterCurrentFailure, {
      type: "snapshot",
      afterEventId: "20",
      detail: makeIncidentDetail(),
    });
    expect(afterStaleSuccess.refreshError).toBe(
      "无法刷新持久化详情；实时事件仍保留在时间线中。",
    );

    const terminalDetail = makeIncidentDetail();
    terminalDetail.incident.status = "DIAGNOSED";
    terminalDetail.run.status = "COMPLETED";
    const afterCurrentSuccess = reduceIncidentStream(afterStaleSuccess, {
      type: "snapshot",
      afterEventId: "21",
      detail: terminalDetail,
    });
    const afterStaleFailure = reduceIncidentStream(afterCurrentSuccess, {
      type: "refresh_failed",
      afterEventId: "20",
      message: "stale failure",
    });

    expect(afterStaleFailure.refreshError).toBeNull();
    expect(afterStaleFailure.detail.run.status).toBe("COMPLETED");
  });

  it("still starts replay for a terminal persisted snapshot", () => {
    const detail = makeIncidentDetail();
    detail.incident.status = "DIAGNOSED";
    detail.run.status = "COMPLETED";

    const state = createIncidentStreamState(detail);

    expect(state.connection).toBe("connecting");
    expect(state.terminalSeen).toBe(false);
    expect(state.lastEventId).toBeNull();

    const replayingEarlierEvent = reduceIncidentStream(state, {
      type: "event",
      event: runStarted("1"),
    });
    expect(replayingEarlierEvent.events).toHaveLength(1);
    expect(replayingEarlierEvent.detail.incident.status).toBe("DIAGNOSED");
    expect(replayingEarlierEvent.detail.run.status).toBe("COMPLETED");
  });
});
