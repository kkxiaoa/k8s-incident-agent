import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const INCIDENT_ID = "123e4567-e89b-12d3-a456-426614174000";

beforeEach(() => {
  vi.stubEnv("AGENT_RUNTIME_URL", "http://127.0.0.1:8000/runtime");
});

describe("GET /api/runtime/incidents/:incidentId/monitoring/:panelId", () => {
  it("forwards only one allowlisted window to the fixed owner-bound path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new Request(
        `http://console.test/api/runtime/incidents/${INCIDENT_ID}/monitoring/image-pull-affected-pods?window=1h&query=up`,
        { headers: { authorization: "Bearer browser-secret" } },
      ),
      {
        params: Promise.resolve({
          incidentId: INCIDENT_ID,
          panelId: "image-pull-affected-pods",
        }),
      },
    );

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe(
      `http://127.0.0.1:8000/runtime/api/v1/incidents/${INCIDENT_ID}/monitoring/panels/image-pull-affected-pods?window=1h`,
    );
    expect(new Headers(init.headers)).toEqual(new Headers());
    expect(response.status).toBe(200);
  });

  it("rejects duplicate windows without contacting Runtime", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new Request(
        `http://console.test/api/runtime/incidents/${INCIDENT_ID}/monitoring/image-pull-affected-pods?window=15m&window=1h`,
      ),
      {
        params: Promise.resolve({
          incidentId: INCIDENT_ID,
          panelId: "image-pull-affected-pods",
        }),
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(422);
  });
});
