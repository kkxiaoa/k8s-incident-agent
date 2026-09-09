import { beforeEach, describe, expect, it, vi } from "vitest";

import { INCIDENT_ID, makeIncidentDetail } from "@/test/agent-runtime-fixtures";

import {
  loadIncidentConsoleOverview,
  loadIncidentPage,
} from "./server-view-data";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function monitoringHealth() {
  return {
    state: "healthy",
    checkedAt: "2026-09-03T02:15:00.000Z",
    prometheus: "healthy",
    kubeStateMetrics: "healthy",
    ruleEvaluation: "healthy",
    alertmanager: "healthy",
    notification: "healthy",
    watchdogLastReceivedAt: "2026-09-03T02:14:00.000Z",
  };
}

function monitoringOverview() {
  const start = Date.parse("2026-09-02T03:00:00.000Z");
  return {
    schemaVersion: 1,
    window: "24h",
    generatedAt: "2026-09-03T02:15:00.000Z",
    counts: {
      totalIncidents: 0,
      firingAlerts: 0,
      triagingIncidents: 0,
      diagnosedIncidents: 0,
    },
    families: [],
    samples: Array.from({ length: 24 }, (_, index) => ({
      timestamp: new Date(start + index * 3_600_000).toISOString(),
      incidentsCreated: 0,
      alertConditionsResolved: 0,
    })),
  };
}

function monitoringOverviewView() {
  const overview = monitoringOverview();
  return {
    window: overview.window,
    generatedAt: overview.generatedAt,
    counts: overview.counts,
    families: overview.families,
    samples: overview.samples,
  };
}

beforeEach(() => {
  vi.stubEnv("AGENT_RUNTIME_URL", "http://127.0.0.1:8000");
});

describe("server view data", () => {
  it("rejects malformed items from successful list responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: URL) =>
        Promise.resolve(
          url.pathname.endsWith("/monitoring/health")
            ? jsonResponse(monitoringHealth())
            : url.pathname.endsWith("/monitoring/overview")
            ? jsonResponse(monitoringOverview())
            : url.pathname.endsWith("/scenarios")
            ? jsonResponse({ schemaVersion: 1, items: [null] })
            : jsonResponse({
                schemaVersion: 4,
                items: [null],
                nextCursor: null,
              }),
        ),
      ),
    );

    const overview = await loadIncidentConsoleOverview("manual");

    expect(overview).toEqual({
      scenarios: null,
      incidents: null,
      monitoringHealth: monitoringHealth(),
      monitoringOverview: monitoringOverviewView(),
    });
  });

  it("loads only persisted incidents for the online profile", async () => {
    const fetchMock = vi.fn((url: URL) =>
      Promise.resolve(
        url.pathname.endsWith("/monitoring/health")
          ? jsonResponse(monitoringHealth())
          : url.pathname.endsWith("/monitoring/overview")
          ? jsonResponse(monitoringOverview())
          : jsonResponse({ schemaVersion: 4, items: [], nextCursor: null }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const overview = await loadIncidentConsoleOverview("online");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.map((call) => (call[0] as URL).pathname).sort(),
    ).toEqual([
      "/api/v1/incidents",
      "/api/v1/monitoring/health",
      "/api/v1/monitoring/overview",
    ]);
    expect(overview).toEqual({
      scenarios: null,
      incidents: { items: [], nextCursor: null },
      monitoringHealth: monitoringHealth(),
      monitoringOverview: monitoringOverviewView(),
    });
  });

  it("maps a successful detail without diagnosis to unavailable", async () => {
    const malformed: Record<string, unknown> = { ...makeIncidentDetail() };
    Reflect.deleteProperty(malformed, "diagnosis");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(malformed)));

    await expect(loadIncidentPage(INCIDENT_ID)).resolves.toEqual({
      state: "unavailable",
    });
  });

  it("projects a valid detail to the fields consumed by the console", async () => {
    const fetchMock = vi.fn((url: URL) =>
      Promise.resolve(
        url.pathname.endsWith("/monitoring/panels")
          ? jsonResponse({
              schemaVersion: 3,
              panels: [
                {
                  panelId: "image-pull-affected-pods",
                  recommendedWindow: "15m",
                  riskDirection: "higher_is_worse",
                  signalRole: "trigger",
                  thresholdDuration: "30s",
                },
              ],
            })
          : url.pathname.endsWith("/runs")
            ? jsonResponse({
                schemaVersion: 4,
                items: [
                  {
                    id: makeIncidentDetail().selectedRun.id,
                    attempt: 1,
                    status: "QUEUED",
                    createdAt: "2026-08-29T01:00:00Z",
                    startedAt: null,
                    completedAt: null,
                  },
                ],
                nextCursor: null,
              })
            : jsonResponse(makeIncidentDetail()),
      ),
    );
    vi.stubGlobal(
      "fetch",
      fetchMock,
    );

    const pageData = await loadIncidentPage(INCIDENT_ID);

    expect(pageData.state).toBe("ready");
    if (pageData.state === "ready") {
      expect(pageData.detail.selectedRun).toMatchObject({
        attempt: 1,
        status: "QUEUED",
        error: null,
      });
      expect(pageData.runs.items).toHaveLength(1);
      expect(pageData.monitoringPanels?.panels).toEqual([
        {
          panelId: "image-pull-affected-pods",
          recommendedWindow: "15m",
          riskDirection: "higher_is_worse",
          signalRole: "trigger",
          thresholdDuration: "30s",
        },
      ]);
      expect(pageData.detail.incident).not.toHaveProperty("updatedAt");
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.map((call) => (call[0] as URL).pathname),
    ).not.toContain("/api/v1/monitoring/health");
  });
});
