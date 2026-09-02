import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIncident,
  createRun,
  fetchIncident,
  fetchIncidents,
  fetchMonitoringHealth,
  fetchMonitoringPanel,
  fetchMonitoringPanels,
  fetchRunEvents,
  fetchRuns,
  fetchScenarios,
  streamIncidentEvents,
} from "./server-client";

const INCIDENT_ID = "123e4567-e89b-12d3-a456-426614174000";
const RUN_ID = "223e4567-e89b-42d3-a456-426614174000";
const RUNTIME_URL = "http://127.0.0.1:8000/runtime";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function pendingUntilAbort(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

beforeEach(() => {
  vi.stubEnv("AGENT_RUNTIME_URL", RUNTIME_URL);
});

describe("fixed REST helpers", () => {
  it("preserves the base path and sends a no-store scenario GET", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const { response } = await fetchScenarios();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe(`${RUNTIME_URL}/api/v1/scenarios`);
    expect(init).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "error",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ items: [] });
  });

  it("forwards only the fixed incident-list query parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const query = new URLSearchParams([
      ["limit", "20"],
      ["cursor", "cursor-value"],
      ["target", "http://attacker.example"],
    ]);

    await fetchIncidents(query);

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.searchParams.toString()).toBe(
      "limit=20&cursor=cursor-value",
    );
  });

  it("maps monitoring health and catalog panels to fixed Runtime paths", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await fetchMonitoringHealth();
    await fetchMonitoringPanels(INCIDENT_ID);
    await fetchMonitoringPanel(
      INCIDENT_ID,
      "image-pull-affected-pods",
      new URLSearchParams([
        ["window", "1h"],
        ["query", "up"],
        ["endpoint", "http://attacker.example"],
      ]),
    );

    expect(
      (fetchMock.mock.calls[0] as [URL])[0].href,
    ).toBe(`${RUNTIME_URL}/api/v1/monitoring/health`);
    expect(
      (fetchMock.mock.calls[1] as [URL])[0].href,
    ).toBe(
      `${RUNTIME_URL}/api/v1/incidents/${INCIDENT_ID}/monitoring/panels`,
    );
    expect(
      (fetchMock.mock.calls[2] as [URL])[0].href,
    ).toBe(
      `${RUNTIME_URL}/api/v1/incidents/${INCIDENT_ID}/monitoring/panels/image-pull-affected-pods?window=1h`,
    );
    for (const call of fetchMock.mock.calls) {
      expect(new Headers((call as [URL, RequestInit])[1].headers)).toEqual(
        new Headers(),
      );
    }
  });

  it.each([
    ["invalid incident", "not-a-uuid", "image-pull-affected-pods", "15m"],
    ["invalid panel", INCIDENT_ID, "../../query", "15m"],
    ["missing window", INCIDENT_ID, "image-pull-affected-pods", null],
    ["unknown window", INCIDENT_ID, "image-pull-affected-pods", "24h"],
  ])(
    "rejects %s before a monitoring request",
    async (_case, incidentId, panelId, window) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const query = new URLSearchParams();
      if (window !== null) {
        query.set("window", window);
      }

      const { response } = await fetchMonitoringPanel(
        incidentId,
        panelId,
        query,
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "invalid_request",
          message: "Request is invalid.",
          retryable: false,
        },
      });
    },
  );

  it("rejects duplicate monitoring windows before a Runtime request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { response } = await fetchMonitoringPanel(
      INCIDENT_ID,
      "image-pull-affected-pods",
      new URLSearchParams([
        ["window", "15m"],
        ["window", "1h"],
      ]),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(422);
  });

  it("preserves the bounded monitoring-panel not-found contract", async () => {
    const envelope = {
      error: {
        code: "monitoring_panel_not_found",
        message: "Monitoring panel was not found.",
        retryable: false,
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(envelope, 404)));

    const { response } = await fetchMonitoringPanel(
      INCIDENT_ID,
      "image-pull-affected-pods",
      new URLSearchParams({ window: "15m" }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual(envelope);
  });

  it("sends the incident body unchanged with the fixed method and media type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 202));
    vi.stubGlobal("fetch", fetchMock);
    const body = '{"scenarioId":"image-pull"}';
    const request = new Request("http://console.test/api/runtime/incidents", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body,
    });

    const response = await createIncident(request);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe(`${RUNTIME_URL}/api/v1/incidents`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json",
    );
    await expect(new Response(init.body).text()).resolves.toBe(body);
    expect(response.status).toBe(202);
  });

  it("passes through a valid Runtime error status and envelope", async () => {
    const envelope = {
      error: {
        code: "incident_not_found",
        message: "Incident was not found.",
        retryable: false,
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(envelope, 404)));

    const { response } = await fetchIncident(INCIDENT_ID);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual(envelope);
  });

  it("maps run detail, history, events, and create to fixed owner-bound paths", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 200));
    vi.stubGlobal("fetch", fetchMock);

    await fetchIncident(INCIDENT_ID, RUN_ID);
    await fetchRuns(INCIDENT_ID, new URLSearchParams({ limit: "20" }));
    await fetchRunEvents(
      INCIDENT_ID,
      RUN_ID,
      new URLSearchParams({ cursor: "opaque" }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 202));
    await createRun(INCIDENT_ID);

    expect(
      fetchMock.mock.calls.map(([url]) => (url as URL).href),
    ).toEqual([
      `${RUNTIME_URL}/api/v1/incidents/${INCIDENT_ID}?runId=${RUN_ID}`,
      `${RUNTIME_URL}/api/v1/incidents/${INCIDENT_ID}/runs?limit=20`,
      `${RUNTIME_URL}/api/v1/incidents/${INCIDENT_ID}/runs/${RUN_ID}/events?cursor=opaque`,
      `${RUNTIME_URL}/api/v1/incidents/${INCIDENT_ID}/runs`,
    ]);
  });

  it("preserves the retryable active-run conflict contract", async () => {
    const envelope = {
      error: {
        code: "active_run_exists",
        message: "An active run already exists.",
        retryable: true,
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(envelope, 409)));

    const response = await createRun(INCIDENT_ID);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(envelope);
  });

  it.each([
    [
      "non-JSON success",
      new Response("secret", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ],
    ["non-JSON error", new Response("database secret", { status: 500 })],
    [
      "invalid error envelope",
      jsonResponse({ detail: "database secret" }, 500),
    ],
    [
      "error envelope with undeclared data",
      jsonResponse(
        {
          error: {
            code: "internal_error",
            message: "Internal server error.",
            retryable: false,
            upstreamDetail: "database secret",
          },
        },
        500,
      ),
    ],
    [
      "an unsafe Runtime error message",
      jsonResponse(
        {
          error: {
            code: "internal_error",
            message: "database secret",
            retryable: false,
          },
        },
        500,
      ),
    ],
    [
      "an undeclared Runtime error status",
      jsonResponse(
        {
          error: {
            code: "internal_error",
            message: "Internal server error.",
            retryable: false,
          },
        },
        418,
      ),
    ],
    [
      "an error that is not declared for the endpoint",
      jsonResponse(
        {
          error: {
            code: "scenario_not_found",
            message: "Scenario was not found.",
            retryable: false,
          },
        },
        404,
      ),
    ],
  ])("maps %s to a safe unavailable response", async (_case, upstream) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(upstream));

    const { response } = await fetchScenarios();
    const serialized = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(serialized)).toEqual({
      error: {
        code: "upstream_unavailable",
        message: "Agent Runtime is unavailable.",
        retryable: true,
      },
    });
    expect(serialized).not.toContain("secret");
  });

  it("maps connection errors without exposing the error or Runtime URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error(`connect failed: ${RUNTIME_URL}/secret`)),
    );

    const { response } = await fetchScenarios();
    const serialized = await response.text();

    expect(response.status).toBe(502);
    expect(serialized).not.toContain("connect failed");
    expect(serialized).not.toContain(RUNTIME_URL);
  });

  it("maps invalid server configuration without calling or exposing upstream", async () => {
    vi.stubEnv(
      "AGENT_RUNTIME_URL",
      "https://operator:secret@runtime.example.test/private",
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { response } = await fetchScenarios();
    const serialized = await response.text();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(502);
    expect(serialized).not.toContain("operator");
    expect(serialized).not.toContain("runtime.example.test");
  });

  it("canonicalizes a valid error instead of returning duplicate raw fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          '{"error":{"code":"internal_error","message":"database secret","message":"Internal server error.","retryable":false}}',
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    const { response } = await fetchScenarios();
    const serialized = await response.text();

    expect(response.status).toBe(500);
    expect(serialized).not.toContain("database secret");
    expect(JSON.parse(serialized)).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
        retryable: false,
      },
    });
  });

  it("aborts a REST request after 15 seconds", async () => {
    vi.useFakeTimers();
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: URL, init: RequestInit) => {
        upstreamSignal = init.signal ?? undefined;
        return pendingUntilAbort(upstreamSignal as AbortSignal);
      }),
    );

    const responsePromise = fetchScenarios();
    await vi.advanceTimersByTimeAsync(15_000);
    const { response } = await responsePromise;

    expect(upstreamSignal?.aborted).toBe(true);
    expect(response.status).toBe(502);
  });

  it("keeps the REST timeout active while reading the response body", async () => {
    vi.useFakeTimers();
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: URL, init: RequestInit) => {
        upstreamSignal = init.signal ?? undefined;
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                upstreamSignal?.addEventListener(
                  "abort",
                  () => controller.error(upstreamSignal?.reason),
                  { once: true },
                );
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      }),
    );

    const responsePromise = fetchScenarios();
    await vi.advanceTimersByTimeAsync(15_000);
    const { response } = await responsePromise;

    expect(upstreamSignal?.aborted).toBe(true);
    expect(response.status).toBe(502);
  });

  it("rejects a non-UUID incident ID before calling upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { response } = await fetchIncident("../secrets");

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
});

describe("fixed SSE helper", () => {
  it("forwards only Last-Event-ID and passes through the established stream", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>();
    let upstreamSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: URL, init: RequestInit) => {
      upstreamSignal = init.signal ?? undefined;
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await streamIncidentEvents(
      INCIDENT_ID,
      "42",
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(30_000);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(url.href).toBe(
      `${RUNTIME_URL}/api/v1/incidents/${INCIDENT_ID}/events`,
    );
    expect([...headers.entries()]).toEqual([
      ["accept", "text/event-stream"],
      ["last-event-id", "42"],
    ]);
    expect(upstreamSignal?.aborted).toBe(false);
    expect(response.status).toBe(200);
    expect(response.body).toBe(body);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  it("aborts when response headers are not available after 10 seconds", async () => {
    vi.useFakeTimers();
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: URL, init: RequestInit) => {
        upstreamSignal = init.signal ?? undefined;
        return pendingUntilAbort(upstreamSignal as AbortSignal);
      }),
    );

    const responsePromise = streamIncidentEvents(
      INCIDENT_ID,
      null,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await responsePromise;

    expect(upstreamSignal?.aborted).toBe(true);
    expect(response.status).toBe(502);
  });

  it("aborts the established upstream stream when the browser disconnects", async () => {
    const browser = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: URL, init: RequestInit) => {
        upstreamSignal = init.signal ?? undefined;
        return Promise.resolve(
          new Response(new ReadableStream(), {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
            },
          }),
        );
      }),
    );

    const response = await streamIncidentEvents(
      INCIDENT_ID,
      null,
      browser.signal,
    );
    browser.abort();

    expect(response.status).toBe(200);
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("rejects an event stream without the Runtime cache policy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new ReadableStream(), {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );

    const response = await streamIncidentEvents(
      INCIDENT_ID,
      null,
      new AbortController().signal,
    );

    expect(response.status).toBe(502);
  });

  it("rejects an event stream with a cacheable Runtime policy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new ReadableStream(), {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "public, max-age=60",
          },
        }),
      ),
    );

    const response = await streamIncidentEvents(
      INCIDENT_ID,
      null,
      new AbortController().signal,
    );

    expect(response.status).toBe(502);
  });

  it("keeps browser abort wired while reading an SSE error response", async () => {
    const browser = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let markBodyRead: (() => void) | undefined;
    const bodyRead = new Promise<void>((resolve) => {
      markBodyRead = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: URL, init: RequestInit) => {
        upstreamSignal = init.signal ?? undefined;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                bodyController = controller;
              },
              pull() {
                markBodyRead?.();
              },
            }),
            {
              status: 503,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      }),
    );

    const responsePromise = streamIncidentEvents(
      INCIDENT_ID,
      null,
      browser.signal,
    );
    await bodyRead;
    browser.abort();
    const wasAborted = upstreamSignal?.aborted;
    bodyController?.enqueue(
      new TextEncoder().encode(
        '{"error":{"code":"runtime_not_ready","message":"Runtime is not ready.","retryable":true}}',
      ),
    );
    bodyController?.close();
    const response = await responsePromise;

    expect(wasAborted).toBe(true);
    expect(response.status).toBe(503);
  });
});
