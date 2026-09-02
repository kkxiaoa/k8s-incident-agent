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
            : url.pathname.endsWith("/scenarios")
            ? jsonResponse({ schemaVersion: 1, items: [null] })
            : jsonResponse({
                schemaVersion: 3,
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
    });
  });

  it("loads only persisted incidents for the online profile", async () => {
    const fetchMock = vi.fn((url: URL) =>
      Promise.resolve(
        url.pathname.endsWith("/monitoring/health")
          ? jsonResponse(monitoringHealth())
          : jsonResponse({ schemaVersion: 3, items: [], nextCursor: null }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const overview = await loadIncidentConsoleOverview("online");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map((call) => (call[0] as URL).pathname).sort(),
    ).toEqual(["/api/v1/incidents", "/api/v1/monitoring/health"]);
    expect(overview).toEqual({
      scenarios: null,
      incidents: { items: [], nextCursor: null },
      monitoringHealth: monitoringHealth(),
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
    vi.stubGlobal(
      "fetch",
      vi.fn((url: URL) =>
        Promise.resolve(
          url.pathname.endsWith("/monitoring/panels")
            ? jsonResponse({
                schemaVersion: 1,
                panels: [
                  {
                    panelId: "image-pull-affected-pods",
                    recommendedWindow: "15m",
                  },
                ],
              })
            : url.pathname.endsWith("/runs")
            ? jsonResponse({
                schemaVersion: 3,
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
      ),
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
        },
      ]);
      expect(pageData.detail.incident).not.toHaveProperty("updatedAt");
    }
  });
});
