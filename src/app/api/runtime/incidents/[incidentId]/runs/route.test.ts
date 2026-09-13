import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";

const INCIDENT_ID = "123e4567-e89b-12d3-a456-426614174000";

beforeEach(() => {
  vi.stubEnv("AGENT_RUNTIME_URL", "http://127.0.0.1:8000");
  vi.stubEnv("INCIDENT_INTAKE_MODE", "manual");
});

describe("/api/runtime/incidents/[incidentId]/runs", () => {
  it("forwards only bounded history query parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await GET(
      new Request("http://console.test/runs?limit=20&cursor=next&url=secret"),
      { params: Promise.resolve({ incidentId: INCIDENT_ID }) },
    );

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.href).toBe(
      `http://127.0.0.1:8000/api/v1/incidents/${INCIDENT_ID}/runs?limit=20&cursor=next`,
    );
  });

  it("creates a run with a fixed empty POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(new Request("http://console.test/runs"), {
      params: Promise.resolve({ incidentId: INCIDENT_ID }),
    });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(response.status).toBe(202);
  });

  it("forwards authenticated rerun and its exact waiting replacement in online mode", async () => {
    vi.stubEnv("INCIDENT_INTAKE_MODE", "online");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const body = JSON.stringify({ replacesRunId: INCIDENT_ID });
    const response = await POST(new Request("http://console.test/runs", {
      method: "POST", body, headers: { "content-type": "application/json" },
    }), {
      params: Promise.resolve({ incidentId: INCIDENT_ID }),
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe(`/api/v1/incidents/${INCIDENT_ID}/runs`);
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(body);
    expect(response.status).toBe(202);
  });
});
