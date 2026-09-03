import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

beforeEach(() => {
  vi.stubEnv("AGENT_RUNTIME_URL", "http://127.0.0.1:8000/runtime");
});

describe("GET /api/runtime/monitoring/overview", () => {
  it("uses the fixed Runtime path without forwarding browser input", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ schemaVersion: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe(
      "http://127.0.0.1:8000/runtime/api/v1/monitoring/overview",
    );
    expect(new Headers(init.headers)).toEqual(new Headers());
    expect(init).toMatchObject({ method: "GET", cache: "no-store" });
  });
});
