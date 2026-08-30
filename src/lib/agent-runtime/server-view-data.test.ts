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

beforeEach(() => {
  vi.stubEnv("AGENT_RUNTIME_URL", "http://127.0.0.1:8000");
});

describe("server view data", () => {
  it("rejects malformed items from successful list responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: URL) =>
        Promise.resolve(
          url.pathname.endsWith("/scenarios")
            ? jsonResponse({ schemaVersion: 1, items: [null] })
            : jsonResponse({
                schemaVersion: 1,
                items: [null],
                nextCursor: null,
              }),
        ),
      ),
    );

    const overview = await loadIncidentConsoleOverview();

    expect(overview).toEqual({ scenarios: null, incidents: null });
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
      vi.fn().mockResolvedValue(jsonResponse(makeIncidentDetail())),
    );

    const pageData = await loadIncidentPage(INCIDENT_ID);

    expect(pageData.state).toBe("ready");
    if (pageData.state === "ready") {
      expect(pageData.detail.run).toEqual({ status: "QUEUED", error: null });
      expect(pageData.detail.incident).not.toHaveProperty("updatedAt");
    }
  });
});
