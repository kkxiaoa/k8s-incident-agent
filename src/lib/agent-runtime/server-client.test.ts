import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

import {
  createIncident,
  createRun,
  createRepairRun,
  withdrawRun,
  fetchIncident,
  fetchIncidents,
  fetchMonitoringHealth,
  fetchMonitoringOverview,
  fetchMonitoringPanel,
  fetchMonitoringPanels,
  fetchRunEvents,
  fetchRuns,
  fetchScenarios,
  fetchRuntimeHealth,
  fetchOperatorSession,
  loginOperator,
  logoutOperator,
  renewOperatorSession,
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
  it("rejects business cookies and transports operator ownership filtering and withdrawal", async () => {
    const token = randomBytes(32).toString("base64url");
    const cookie = `__Host-k8s-incident-session=${token}`;
    const setCookie = `${cookie}; HttpOnly; Secure; SameSite=strict; Path=/; Max-Age=3600`;
    const csrf = randomBytes(32).toString("hex");
    const request = new Request("https://console.example.test/api/runtime/incidents/x/repair-runs", {
      method: "POST", headers: { "content-type": "application/json", Origin: "https://console.example.test" },
      body: JSON.stringify({ sourceRunId: RUN_ID }),
    });
    const creation = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 5, runId: RUN_ID }), { status: 202, headers: { "content-type": "application/json", "set-cookie": setCookie } }));
    vi.stubGlobal("fetch", creation);
    const rejected = await createRepairRun(INCIDENT_ID, request);
    expect(rejected.status).toBe(502);
    expect(rejected.headers.has("set-cookie")).toBe(false);
    expect(new Headers((creation.mock.calls[0] as unknown as [URL, RequestInit])[1].headers).has("cookie")).toBe(false);
    const incoming = new Headers({ cookie: `sibling=discard; ${cookie}`, Origin: "https://console.example.test", "X-CSRF-Token": csrf });
    const read = vi.fn(async () => jsonResponse({ schemaVersion: 5, items: [], nextCursor: null }));
    vi.stubGlobal("fetch", read);
    await fetchRuns(INCIDENT_ID, new URLSearchParams("mine=true&limit=1&guestRef=forged"), incoming);
    const [url, init] = read.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.search).toBe("?mine=true&limit=1");
    expect(new Headers(init.headers).get("cookie") === cookie).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const withdrawn = await withdrawRun(INCIDENT_ID, new Request("https://console.example.test/api/runtime/incidents/x/withdrawals", {
      method: "POST", headers: new Headers([...incoming, ["content-type", "application/json"]]), body: JSON.stringify({ runId: RUN_ID }),
    }));
    expect(withdrawn.status).toBe(204);
    expect(withdrawn.headers.get("cache-control")).toBe("no-store");
    expect(await withdrawn.text()).toBe("");
  });

  it("clears an expired operator on public session reads without issuing or accepting a forged actor", async () => {
    const cleared = '__Host-k8s-incident-session=""; HttpOnly; Secure; SameSite=strict; Path=/; Max-Age=0';
    const view = { accessMode: "public_demo", role: "anonymous", csrfToken: null, expiresAt: null };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(view), { headers: { "content-type": "application/json", "set-cookie": cleared } })));
    const result = await fetchOperatorSession(new Headers());
    expect(result.response.status).toBe(200);
    expect(result.value).toEqual(view);
    expect(result.response.headers.get("set-cookie")).toBe(cleared);
    for (const invalid of [{ ...view, guestRef: "forged" }, { ...view, role: "operator" }, { ...view, accessMode: "private" }]) {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(invalid)));
      expect((await fetchOperatorSession(new Headers())).response.status).toBe(502);
    }
  });

  it("rejects oversized business bodies before Runtime dispatch and keeps read-capacity failures bounded", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { code: "public_demo_limited", message: "Public demo capacity is exhausted.", retryable: false } }, 429));
    vi.stubGlobal("fetch", fetchMock);
    const request = (length: number) => new Request("https://console.example.test/api/runtime/incidents", {
      method: "POST", headers: { "content-type": "application/json", "content-length": "1" }, body: "x".repeat(length),
    });
    expect((await createIncident(request(8193))).status).toBe(422);
    expect((await createRepairRun(INCIDENT_ID, request(8193))).status).toBe(422);
    expect((await createRun(INCIDENT_ID, request(8193))).status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await createIncident(request(2))).status).toBe(429);
  });

  it("projects each request's operator credential without forwarding sibling or identity headers", async () => {
    const cookies = Array.from({ length: 2 }, () => `__Host-k8s-incident-session=${randomBytes(32).toString("base64url")}`);
    const received: string[] = [];
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      const headers = new Headers(init.headers);
      received.push(headers.get("cookie") ?? "");
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("x-operator-ref")).toBe(false);
      expect(init.cache).toBe("no-store");
      expect(init.redirect).toBe("error");
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all(cookies.map(async cookie => {
      const incoming = new Headers({ cookie: `sibling=discard; ${cookie}`, authorization: "discard", "x-operator-ref": "forged" });
      await Promise.all([
        fetchScenarios(incoming), fetchIncidents(new URLSearchParams(), incoming),
        fetchMonitoringHealth(incoming), fetchMonitoringOverview(incoming),
        fetchMonitoringPanels(INCIDENT_ID, incoming), fetchIncident(INCIDENT_ID, undefined, incoming),
        fetchRuns(INCIDENT_ID, new URLSearchParams(), incoming), fetchRunEvents(INCIDENT_ID, RUN_ID, new URLSearchParams(), incoming),
      ]);
    }));
    for (const cookie of cookies) expect(received.filter(value => value === cookie).length).toBe(8);
    const duplicate = new Headers({ cookie: `${cookies[0]}; ${cookies[0]}` });
    expect((await fetchOperatorSession(duplicate)).response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(16);
  });

  it("forwards only validated Runtime login/logout cookies and bounds auth responses", async () => {
    const token = randomBytes(32).toString("base64url");
    const cookie = `__Host-k8s-incident-session=${token}; HttpOnly; Secure; SameSite=strict; Path=/; Max-Age=3600`;
    const session = { operatorRef: "sandbox-operator", expiresAt: 1800000000, csrfToken: randomBytes(32).toString("hex") };
    const request = () => new Request("https://console.example.test/api/runtime/operator/login", { method: "POST", headers: { "content-type": "application/json", Origin: "https://console.example.test" }, body: JSON.stringify({ password: randomBytes(32).toString("hex") }) });
    const upstream = (setCookie = cookie) => new Response(JSON.stringify(session), { headers: { "content-type": "application/json", "set-cookie": setCookie } });
    vi.stubGlobal("fetch", vi.fn(async () => upstream()));
    const response = await loginOperator(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie") === cookie).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
    for (const invalid of [cookie + "; Domain=example.test", cookie.replace("Secure; ", ""), cookie + ", sibling=secret"]) {
      vi.stubGlobal("fetch", vi.fn(async () => upstream(invalid)));
      const denied = await loginOperator(request());
      expect(denied.status).toBe(502);
      expect(denied.headers.has("set-cookie")).toBe(false);
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(8193), { headers: { "content-type": "application/json" } })));
    expect((await loginOperator(request())).status).toBe(502);
    const cleared = '__Host-k8s-incident-session=""; HttpOnly; Secure; SameSite=strict; Path=/; Max-Age=0';
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204, headers: [["set-cookie", cleared]] })));
    expect((await logoutOperator(new Request("https://console.example.test/api/runtime/operator/logout", { method: "POST" }))).status).toBe(204);
  });

  it("forwards authenticated renewal with original Origin/CSRF and a validated cookie only", async () => {
    const token = randomBytes(32).toString("base64url");
    const cookie = `__Host-k8s-incident-session=${token}`;
    const setCookie = `${cookie}; HttpOnly; Secure; SameSite=strict; Path=/; Max-Age=3600`;
    const session = { accessMode: "private", role: "operator", expiresAt: 1800000000, csrfToken: randomBytes(32).toString("hex") };
    const origin = "https://console.example.test";
    const request = () => new Request(`${origin}/api/runtime/operator/session`, { method: "POST", headers: { cookie, Origin: origin, "X-CSRF-Token": session.csrfToken } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(session), { headers: { "content-type": "application/json", "set-cookie": setCookie } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await renewOperatorSession(request());
    expect(result.status).toBe(200);
    expect(result.headers.get("set-cookie") === setCookie).toBe(true);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/runtime/api/v1/operator/session");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("origin")).toBe(origin);
    expect(new Headers(init.headers).get("x-csrf-token") === session.csrfToken).toBe(true);
    expect(new Headers(init.headers).get("cookie") === cookie).toBe(true);
    for (const invalid of [setCookie.replace("Secure; ", ""), `${setCookie}; Domain=example.test`]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(session), { headers: { "content-type": "application/json", "set-cookie": invalid } })));
      const rejected = await renewOperatorSession(request());
      expect(rejected.status).toBe(502);
      expect(rejected.headers.has("set-cookie")).toBe(false);
    }
  });

  it("reads core and diagnostic health from the fixed no-store Runtime endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      status: "ok", diagnosis: { status: "unavailable", reason: "authentication_failed" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchRuntimeHealth();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe(`${RUNTIME_URL}/healthz`);
    expect(init).toMatchObject({ method: "GET", cache: "no-store", redirect: "error" });
    expect(result.response.status).toBe(200);
  });

  it("preserves retryable diagnosis failures on both creation routes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => jsonResponse({ error: {
      code: "diagnosis_unavailable", message: "Model diagnosis is unavailable.", retryable: true,
    } }, 503)));
    for (const response of [await createIncident(new Request("http://console.test/api/runtime/incidents", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId: "image-pull-backoff" }),
    })), await createRun(INCIDENT_ID, new Request("https://console.example.test/api/runtime/incidents/runs", { method: "POST" }))]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "diagnosis_unavailable", retryable: true } });
    }
  });
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

  it("maps monitoring endpoints and catalog panels to fixed Runtime paths", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await fetchMonitoringHealth();
    await fetchMonitoringOverview();
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
    ).toBe(`${RUNTIME_URL}/api/v1/monitoring/overview`);
    expect(
      (fetchMock.mock.calls[2] as [URL])[0].href,
    ).toBe(
      `${RUNTIME_URL}/api/v1/incidents/${INCIDENT_ID}/monitoring/panels`,
    );
    expect(
      (fetchMock.mock.calls[3] as [URL])[0].href,
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
    await createRun(INCIDENT_ID, new Request("https://console.example.test/api/runtime/incidents/runs", { method: "POST" }));

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

    const response = await createRun(INCIDENT_ID, new Request("https://console.example.test/api/runtime/incidents/runs", { method: "POST" }));

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
            "cache-control": "no-store",
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
    expect(response.headers.get("cache-control")).toBe("no-store");
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
              "cache-control": "no-store",
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
