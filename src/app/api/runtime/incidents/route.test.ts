import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";

beforeEach(() => {
  vi.stubEnv("AGENT_RUNTIME_URL", "http://127.0.0.1:8000");
  vi.stubEnv("INCIDENT_INTAKE_MODE", "manual");
});

describe("/api/runtime/incidents", () => {
  it("maps GET and forwards only the Runtime list query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request(
      "http://console.test/api/runtime/incidents?limit=10&cursor=next&url=http://attacker.test",
      { headers: { authorization: "Bearer secret", cookie: "session=secret" } },
    );

    await GET(request);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe(
      "http://127.0.0.1:8000/api/v1/incidents?limit=10&cursor=next",
    );
    expect(new Headers(init.headers)).toEqual(new Headers());
  });

  it("maps POST and forwards only the JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("http://console.test/api/runtime/incidents", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: '{"scenarioId":"image-pull-backoff"}',
    });

    await POST(request);

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.method).toBe("POST");
    expect([...new Headers(init.headers).entries()]).toEqual([
      ["content-type", "application/json"],
    ]);
    await expect(new Response(init.body).text()).resolves.toBe(
      '{"scenarioId":"image-pull-backoff"}',
    );
  });

  it("rejects a non-JSON browser request before reading or forwarding it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("http://console.test/api/runtime/incidents", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"scenarioId":"image-pull-backoff"}',
    });

    const response = await POST(request);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "Request is invalid.",
        retryable: false,
      },
    });
  });

  it("keeps incident reads available in online mode", async () => {
    vi.stubEnv("INCIDENT_INTAKE_MODE", "online");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new Request("http://console.test/api/runtime/incidents?limit=10"),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
  });

  it("returns no create capability without contacting Runtime in online mode", async () => {
    vi.stubEnv("INCIDENT_INTAKE_MODE", "online");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("http://console.test/api/runtime/incidents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"scenarioId":"image-pull-backoff"}',
    });

    const response = await POST(request);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("");
  });
});
