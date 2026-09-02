import { describe, expect, it } from "vitest";

import { makeIncidentDetail } from "@/test/agent-runtime-fixtures";

import { parseIncidentDetailResponse } from "./response-contracts";

describe("parseIncidentDetailResponse", () => {
  it("accepts a Scenario detail without an alert signal", () => {
    expect(parseIncidentDetailResponse(makeIncidentDetail())).not.toBeNull();
  });

  it("accepts a distinct Alertmanager signal projection", () => {
    const detail = makeIncidentDetail();
    detail.incident.source = {
      type: "alertmanager",
      ref: "K8sIncidentImagePullBackOff",
      revision: "2026-09-02.1",
    };
    detail.alertSignal = {
      status: "RESOLVED",
      startsAt: "2026-09-02T08:00:00.000000001Z",
      endsAt: "2026-09-02T08:05:00.000000001Z",
    };

    expect(parseIncidentDetailResponse(detail)?.alertSignal).toEqual(
      detail.alertSignal,
    );
  });

  it("rejects missing, contradictory, or regressive signal projections", () => {
    const missing = makeIncidentDetail();
    missing.incident.source.type = "alertmanager";

    const scenarioWithSignal = makeIncidentDetail();
    scenarioWithSignal.alertSignal = {
      status: "FIRING",
      startsAt: "2026-09-02T08:00:00.000000000Z",
      endsAt: null,
    };

    const regressive = makeIncidentDetail();
    regressive.incident.source.type = "alertmanager";
    regressive.alertSignal = {
      status: "RESOLVED",
      startsAt: "2026-09-02T08:00:00.000000002Z",
      endsAt: "2026-09-02T08:00:00.000000001Z",
    };

    expect(parseIncidentDetailResponse(missing)).toBeNull();
    expect(parseIncidentDetailResponse(scenarioWithSignal)).toBeNull();
    expect(parseIncidentDetailResponse(regressive)).toBeNull();
  });

  it("rejects an Alertmanager signal without the canonical nanosecond form", () => {
    const detail = makeIncidentDetail();
    detail.incident.source.type = "alertmanager";
    detail.alertSignal = {
      status: "FIRING",
      startsAt: "2026-09-02T08:00:00Z",
      endsAt: null,
    };

    expect(parseIncidentDetailResponse(detail)).toBeNull();
  });

  it("rejects the superseded v2 envelope", () => {
    const detail = { ...makeIncidentDetail(), schemaVersion: 2 };

    expect(parseIncidentDetailResponse(detail)).toBeNull();
  });
});
