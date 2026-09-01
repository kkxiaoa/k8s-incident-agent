import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const INCIDENT_ID = "123e4567-e89b-12d3-a456-426614174000";
const RUN_ID = "223e4567-e89b-42d3-a456-426614174000";

beforeEach(() => {
  vi.stubEnv("AGENT_RUNTIME_URL", "http://127.0.0.1:8000");
});

describe("GET run event history", () => {
  it("binds both owner ids and forwards only pagination", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await GET(
      new Request("http://console.test/events?limit=100&cursor=older&url=secret"),
      { params: Promise.resolve({ incidentId: INCIDENT_ID, runId: RUN_ID }) },
    );

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.href).toBe(
      `http://127.0.0.1:8000/api/v1/incidents/${INCIDENT_ID}/runs/${RUN_ID}/events?limit=100&cursor=older`,
    );
  });

  it("rejects an invalid run id before upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(new Request("http://console.test/events"), {
      params: Promise.resolve({ incidentId: INCIDENT_ID, runId: "../secret" }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(422);
  });
});
