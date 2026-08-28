import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const INCIDENT_ID = "123e4567-e89b-12d3-a456-426614174000";

beforeEach(() => {
  vi.stubEnv("AGENT_RUNTIME_URL", "http://127.0.0.1:8000");
});

describe("GET /api/runtime/incidents/[incidentId]/events", () => {
  it("forwards Last-Event-ID without forwarding other browser headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new ReadableStream(), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("http://console.test/events", {
      headers: {
        authorization: "Bearer secret",
        cookie: "session=secret",
        "last-event-id": "9",
      },
    });

    const response = await GET(request, {
      params: Promise.resolve({ incidentId: INCIDENT_ID }),
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe(
      `http://127.0.0.1:8000/api/v1/incidents/${INCIDENT_ID}/events`,
    );
    expect([...new Headers(init.headers).entries()]).toEqual([
      ["accept", "text/event-stream"],
      ["last-event-id", "9"],
    ]);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });
});
