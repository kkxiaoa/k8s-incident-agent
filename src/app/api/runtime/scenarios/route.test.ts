import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

beforeEach(() => {
  vi.stubEnv("AGENT_RUNTIME_URL", "http://127.0.0.1:8000");
});

describe("GET /api/runtime/scenarios", () => {
  it("maps to the fixed Runtime endpoint without forwarding browser metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ items: [], schemaVersion: 1 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe("http://127.0.0.1:8000/api/v1/scenarios");
    expect(new Headers(init.headers)).toEqual(new Headers());
    expect(response.status).toBe(200);
  });
});
