import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const INCIDENT_ID = "123e4567-e89b-12d3-a456-426614174000";

beforeEach(() => {
  vi.stubEnv("AGENT_RUNTIME_URL", "http://127.0.0.1:8000");
});

describe("GET /api/runtime/incidents/[incidentId]", () => {
  it("maps a valid UUID to one fixed Runtime path segment", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(new Request("http://console.test"), {
      params: Promise.resolve({ incidentId: INCIDENT_ID }),
    });

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.href).toBe(
      `http://127.0.0.1:8000/api/v1/incidents/${INCIDENT_ID}`,
    );
    expect(response.status).toBe(200);
  });

  it("returns a safe 422 before upstream for an invalid path segment", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(new Request("http://console.test"), {
      params: Promise.resolve({ incidentId: "../events" }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(422);
  });

  it("forwards the single selected runId and rejects duplicates", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    const runId = "223e4567-e89b-42d3-a456-426614174000";

    await GET(new Request(`http://console.test/detail?runId=${runId}`), {
      params: Promise.resolve({ incidentId: INCIDENT_ID }),
    });
    expect((fetchMock.mock.calls[0] as [URL])[0].searchParams.get("runId")).toBe(
      runId,
    );

    fetchMock.mockClear();
    const response = await GET(
      new Request(`http://console.test/detail?runId=${runId}&runId=${runId}`),
      { params: Promise.resolve({ incidentId: INCIDENT_ID }) },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(422);
  });
});
