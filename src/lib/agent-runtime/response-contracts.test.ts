import { describe, expect, it } from "vitest";

import { makeIncidentDetail } from "@/test/agent-runtime-fixtures";

import {
  isMetricWindow,
  parseIncidentDetailResponse,
  parseIncidentMetricPanelResponse,
  parseMonitoringHealthResponse,
  parseMonitoringOverviewResponse,
  parseMonitoringPanelListResponse,
} from "./response-contracts";

it("accepts every bounded metric window", () => {
  expect(["15m", "1h", "6h", "7d", "15d"].every(isMetricWindow)).toBe(true);
  expect(isMetricWindow("24h")).toBe(false);
});

function metricPanel() {
  return {
    schemaVersion: 1,
    result: {
      panelId: "image-pull-affected-pods",
      title: "Affected pods",
      unit: "pods",
      threshold: 1,
      riskDirection: "higher_is_worse",
      window: "15m",
      state: "ok",
      queriedAt: "2026-09-03T02:15:00.000Z",
      latestSampleAt: "2026-09-03T02:15:00.000Z",
      currentValue: 0,
      samples: [
        { timestamp: "2026-09-03T02:14:45.000Z", value: 1 },
        { timestamp: "2026-09-03T02:15:00.000Z", value: 0 },
      ],
    },
    markers: [
      {
        kind: "alert_firing",
        occurredAt: "2026-09-03T02:05:00.000Z",
        runAttempt: null,
      },
      {
        kind: "run_started",
        occurredAt: "2026-09-03T02:06:00.000Z",
        runAttempt: 1,
      },
    ],
    markersTruncated: false,
  };
}

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

describe("monitoring response contracts", () => {
  it("accepts the bounded health projection", () => {
    const health = {
      state: "degraded",
      checkedAt: "2026-09-03T02:15:00.000Z",
      prometheus: "healthy",
      kubeStateMetrics: "healthy",
      ruleEvaluation: "degraded",
      alertmanager: "healthy",
      notification: "stale",
      watchdogLastReceivedAt: "2026-09-03T02:08:00.000Z",
    };

    expect(parseMonitoringHealthResponse(health)).toEqual(health);
    expect(
      parseMonitoringHealthResponse({ ...health, notification: "normal" }),
    ).toBeNull();
  });

  it("accepts a complete 24-hour overview and rejects inconsistent totals", () => {
    const start = Date.parse("2026-09-02T03:00:00.000Z");
    const overview = {
      schemaVersion: 1,
      window: "24h",
      generatedAt: "2026-09-03T02:15:00.000Z",
      counts: {
        totalIncidents: 8,
        firingAlerts: 2,
        triagingIncidents: 1,
        diagnosedIncidents: 5,
      },
      families: [
        {
          sourceRef: "K8sIncidentImagePullBackOff",
          displayName: "Image pull failure",
          count: 2,
        },
      ],
      samples: Array.from({ length: 24 }, (_, index) => ({
        timestamp: new Date(start + index * 3_600_000).toISOString(),
        incidentsCreated: index === 23 ? 1 : 0,
        alertConditionsResolved: index === 22 ? 1 : 0,
      })),
    };

    expect(parseMonitoringOverviewResponse(overview)).toEqual({
      window: "24h",
      generatedAt: overview.generatedAt,
      counts: overview.counts,
      families: overview.families,
      samples: overview.samples,
    });
    expect(
      parseMonitoringOverviewResponse({
        ...overview,
        counts: { ...overview.counts, firingAlerts: 3 },
      }),
    ).toBeNull();
    expect(
      parseMonitoringOverviewResponse({
        ...overview,
        samples: overview.samples.slice(1),
      }),
    ).toBeNull();
    expect(
      parseMonitoringOverviewResponse({
        ...overview,
        counts: { ...overview.counts, firingAlerts: 4 },
        families: [overview.families[0], overview.families[0]],
      }),
    ).toBeNull();
    expect(
      parseMonitoringOverviewResponse({
        ...overview,
        samples: overview.samples.map((sample) => ({
          ...sample,
          timestamp: new Date(
            Date.parse(sample.timestamp) - 3_600_000,
          ).toISOString(),
        })),
      }),
    ).toBeNull();
  });

  it("accepts unique catalog panel references and rejects duplicates", () => {
    const panels = {
      schemaVersion: 3,
      panels: [
        {
          panelId: "image-pull-affected-pods",
          recommendedWindow: "15m",
          riskDirection: "higher_is_worse",
          signalRole: "trigger",
          thresholdDuration: "30s",
        },
        {
          panelId: "image-pull-available-replicas",
          recommendedWindow: "1h",
          riskDirection: "lower_is_worse",
          signalRole: "context",
          thresholdDuration: "5m",
        },
      ],
    };

    expect(parseMonitoringPanelListResponse(panels)?.panels).toHaveLength(2);
    expect(
      parseMonitoringPanelListResponse({
        ...panels,
        panels: [panels.panels[0], panels.panels[0]],
      }),
    ).toBeNull();
  });

  it("preserves a valid zero and keeps markers separate from samples", () => {
    const panel = metricPanel();

    const parsed = parseIncidentMetricPanelResponse(
      panel,
      "image-pull-affected-pods",
      "15m",
    );

    expect(parsed?.result.currentValue).toBe(0);
    expect(parsed?.result.samples).toHaveLength(2);
    expect(parsed?.markers).toEqual(panel.markers);
  });

  it("accepts an explicit no-data state without treating it as zero", () => {
    const panel = metricPanel();
    panel.result.state = "no_data";
    panel.result.latestSampleAt = null as unknown as string;
    panel.result.currentValue = null as unknown as number;
    panel.result.samples = [];

    const parsed = parseIncidentMetricPanelResponse(
      panel,
      "image-pull-affected-pods",
      "15m",
    );

    expect(parsed?.result.currentValue).toBeNull();
    expect(parsed?.result.samples).toEqual([]);
  });

  it("accepts a static lower bound for a lower-is-worse metric", () => {
    const panel = metricPanel();
    panel.result.panelId = "service-ready-endpoints";
    panel.result.title = "Service 就绪 Endpoint";
    panel.result.unit = "endpoints";
    panel.result.riskDirection = "lower_is_worse";

    const parsed = parseIncidentMetricPanelResponse(
      panel,
      "service-ready-endpoints",
      "15m",
    );

    expect(parsed?.result.threshold).toBe(1);
    expect(parsed?.result.riskDirection).toBe("lower_is_worse");
  });

  it.each([
    "panel",
    "window",
    "state-shape",
    "sample-order",
    "sample-window",
    "current",
    "risk-threshold",
    "marker-shape",
    "marker-window",
  ])("rejects invalid %s responses", (mutation) => {
    const panel = metricPanel();
    if (mutation === "panel") {
      panel.result.panelId = "image-pull-available-replicas";
    } else if (mutation === "window") {
      panel.result.window = "1h";
    } else if (mutation === "state-shape") {
      panel.result.state = "no_data";
    } else if (mutation === "sample-order") {
      panel.result.samples.reverse();
    } else if (mutation === "sample-window") {
      panel.result.samples[0].timestamp = "2026-09-03T01:59:59.999Z";
    } else if (mutation === "current") {
      panel.result.currentValue = 2;
    } else if (mutation === "risk-threshold") {
      panel.result.threshold = null as unknown as number;
    } else if (mutation === "marker-shape") {
      panel.markers[0].runAttempt = 1;
    } else {
      panel.markers[0].occurredAt = "2026-09-03T01:00:00.000Z";
    }

    expect(
      parseIncidentMetricPanelResponse(
        panel,
        "image-pull-affected-pods",
        "15m",
      ),
    ).toBeNull();
  });
});
