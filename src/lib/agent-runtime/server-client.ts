import "server-only";

import type { components, paths } from "./generated";
import {
  OPERATOR_COOKIE,
  OPERATOR_CSRF_HEADER,
  parseOperatorSession,
  parseConsoleSession,
} from "./operator-contracts";
import { getAgentRuntimeBaseUrl } from "./server-config";

type ErrorResponse = components["schemas"]["ErrorResponse"];
type RuntimePath = keyof paths;

interface RuntimeJsonResult {
  response: Response;
  value: unknown | null;
}

const OPERATOR_PATH = "/api/v1/operator" as const;
const SCENARIOS_PATH = "/api/v1/scenarios" satisfies RuntimePath;
const INCIDENTS_PATH = "/api/v1/incidents" satisfies RuntimePath;
const INCIDENT_PATH = "/api/v1/incidents/{incident_id}" satisfies RuntimePath;
const INCIDENT_EVENTS_PATH =
  "/api/v1/incidents/{incident_id}/events" satisfies RuntimePath;
const INCIDENT_RUNS_PATH =
  "/api/v1/incidents/{incident_id}/runs" satisfies RuntimePath;
const REPAIR_RUNS_PATH =
  "/api/v1/incidents/{incident_id}/repair-runs" satisfies RuntimePath;
const APPROVALS_PATH =
  "/api/v1/incidents/{incident_id}/approvals" satisfies RuntimePath;
const WITHDRAWALS_PATH = "/api/v1/incidents/{incident_id}/withdrawals" satisfies RuntimePath;
const RUN_EVENTS_PATH =
  "/api/v1/incidents/{incident_id}/runs/{run_id}/events" satisfies RuntimePath;
const MONITORING_HEALTH_PATH =
  "/api/v1/monitoring/health" satisfies RuntimePath;
const MONITORING_OVERVIEW_PATH =
  "/api/v1/monitoring/overview" satisfies RuntimePath;
const MONITORING_PANELS_PATH =
  "/api/v1/incidents/{incident_id}/monitoring/panels" satisfies RuntimePath;
const MONITORING_PANEL_PATH =
  "/api/v1/incidents/{incident_id}/monitoring/panels/{panel_id}" satisfies RuntimePath;

const REST_TIMEOUT_MILLISECONDS = 15_000;
const SSE_CONNECT_TIMEOUT_MILLISECONDS = 10_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PANEL_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const RUNTIME_ERROR_CONTRACTS = {
  public_demo_limited: { status: 429, message: "Public demo capacity is exhausted.", retryable: false },
  run_ownership_required: { status: 403, message: "This run is not controlled by the current session.", retryable: false },
  operator_authentication_required: {
    status: 401,
    message: "Operator authentication is required.",
    retryable: false,
  },
  operator_origin_rejected: {
    status: 403,
    message: "Request origin is not permitted.",
    retryable: false,
  },
  operator_csrf_rejected: {
    status: 403,
    message: "Request verification failed.",
    retryable: false,
  },
  operator_login_limited: {
    status: 429,
    message: "Operator login is temporarily limited.",
    retryable: true,
  },
  operator_authentication_unavailable: {
    status: 503,
    message: "Operator authentication is unavailable.",
    retryable: true,
  },
  invalid_request: {
    status: 422,
    message: "Request is invalid.",
    retryable: false,
  },
  scenario_not_found: {
    status: 404,
    message: "Scenario was not found.",
    retryable: false,
  },
  incident_not_found: {
    status: 404,
    message: "Incident was not found.",
    retryable: false,
  },
  monitoring_panel_not_found: {
    status: 404,
    message: "Monitoring panel was not found.",
    retryable: false,
  },
  run_not_found: {
    status: 404,
    message: "Run was not found.",
    retryable: false,
  },
  active_run_exists: {
    status: 409,
    message: "An active run already exists.",
    retryable: true,
  },
  repair_source_invalid: {
    status: 409,
    message: "Repair source is not applicable.",
    retryable: false,
  },
  approval_conflict: {
    status: 409,
    message: "Exact approval is no longer available.",
    retryable: false,
  },
  execution_disabled: {
    status: 403,
    message: "Sandbox execution is disabled.",
    retryable: false,
  },
  invalid_cursor: {
    status: 400,
    message: "Cursor is invalid.",
    retryable: false,
  },
  invalid_last_event_id: {
    status: 400,
    message: "Last-Event-ID is invalid.",
    retryable: false,
  },
  runtime_not_ready: {
    status: 503,
    message: "Runtime is not ready.",
    retryable: true,
  },
  diagnosis_unavailable: {
    status: 503,
    message: "Model diagnosis is unavailable.",
    retryable: true,
  },
  internal_error: {
    status: 500,
    message: "Internal server error.",
    retryable: false,
  },
} as const;

type RuntimeErrorCode = keyof typeof RUNTIME_ERROR_CONTRACTS;

const SCENARIO_ERROR_CODES = [
  "runtime_not_ready",
  "internal_error",
] as const satisfies readonly RuntimeErrorCode[];
const INCIDENT_LIST_ERROR_CODES = [
  "invalid_cursor",
  "invalid_request",
  "runtime_not_ready",
  "internal_error",
] as const satisfies readonly RuntimeErrorCode[];
const INCIDENT_CREATE_ERROR_CODES = [
  "diagnosis_unavailable",
  "scenario_not_found",
  "invalid_request",
  "runtime_not_ready",
  "internal_error",
] as const satisfies readonly RuntimeErrorCode[];
const INCIDENT_DETAIL_ERROR_CODES = [
  "incident_not_found",
  "run_not_found",
  "invalid_request",
  "runtime_not_ready",
  "internal_error",
] as const satisfies readonly RuntimeErrorCode[];
const RUN_HISTORY_ERROR_CODES = [
  "invalid_cursor",
  "incident_not_found",
  "invalid_request",
  "runtime_not_ready",
  "internal_error",
] as const satisfies readonly RuntimeErrorCode[];
const RUN_CREATE_ERROR_CODES = [
  "diagnosis_unavailable",
  "incident_not_found",
  "active_run_exists",
  "invalid_request",
  "runtime_not_ready",
  "internal_error",
] as const satisfies readonly RuntimeErrorCode[];
const RUN_EVENT_HISTORY_ERROR_CODES = [
  "invalid_cursor",
  "incident_not_found",
  "run_not_found",
  "invalid_request",
  "runtime_not_ready",
  "internal_error",
] as const satisfies readonly RuntimeErrorCode[];
const INCIDENT_EVENT_ERROR_CODES = [
  "invalid_last_event_id",
  "incident_not_found",
  "invalid_request",
  "runtime_not_ready",
  "internal_error",
] as const satisfies readonly RuntimeErrorCode[];
const MONITORING_HEALTH_ERROR_CODES = [
  "runtime_not_ready",
  "internal_error",
] as const satisfies readonly RuntimeErrorCode[];
const MONITORING_PANELS_ERROR_CODES = [
  "incident_not_found",
  "invalid_request",
  "runtime_not_ready",
  "internal_error",
] as const satisfies readonly RuntimeErrorCode[];
const MONITORING_PANEL_ERROR_CODES = [
  "incident_not_found",
  "monitoring_panel_not_found",
  "invalid_request",
  "runtime_not_ready",
  "internal_error",
] as const satisfies readonly RuntimeErrorCode[];

function runtimeErrorBody(code: RuntimeErrorCode): ErrorResponse {
  const contract = RUNTIME_ERROR_CONTRACTS[code];
  return {
    error: {
      code,
      message: contract.message,
      retryable: contract.retryable,
    },
  };
}

const INVALID_REQUEST = runtimeErrorBody("invalid_request");

const UPSTREAM_UNAVAILABLE: ErrorResponse = {
  error: {
    code: "upstream_unavailable",
    message: "Agent Runtime is unavailable.",
    retryable: true,
  },
};

function errorResponse(
  status: number,
  body: ErrorResponse,
  contentType = "application/json",
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": contentType,
    },
  });
}

function unavailableResponse(): Response {
  return errorResponse(502, UPSTREAM_UNAVAILABLE);
}

function unavailableResult(): RuntimeJsonResult {
  return { response: unavailableResponse(), value: null };
}

function runtimeUrl(path: string): URL {
  const url = getAgentRuntimeBaseUrl();
  const prefix = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}${path}`;
  return url;
}

function incidentPath(template: string, incidentId: string): string | null {
  if (!UUID_PATTERN.test(incidentId)) {
    return null;
  }

  return template.replace("{incident_id}", encodeURIComponent(incidentId));
}

function runPath(
  template: string,
  incidentId: string,
  runId: string,
): string | null {
  const path = incidentPath(template, incidentId);
  return path !== null && UUID_PATTERN.test(runId)
    ? path.replace("{run_id}", encodeURIComponent(runId))
    : null;
}

function monitoringPanelPath(
  incidentId: string,
  panelId: string,
): string | null {
  const path = incidentPath(MONITORING_PANEL_PATH, incidentId);
  return path !== null &&
    panelId.length <= 128 &&
    PANEL_ID_PATTERN.test(panelId)
    ? path.replace("{panel_id}", encodeURIComponent(panelId))
    : null;
}

function forwardQuery(
  searchParams: URLSearchParams,
  allowedNames: readonly string[],
): URLSearchParams {
  const forwarded = new URLSearchParams();
  for (const [name, value] of searchParams) {
    if (allowedNames.includes(name)) {
      forwarded.append(name, value);
    }
  }
  return forwarded;
}

function isJsonContentType(contentType: string | null): contentType is string {
  return (
    contentType?.split(";", 1)[0].trim().toLowerCase() === "application/json"
  );
}

function isEventStreamContentType(
  contentType: string | null,
): contentType is string {
  return (
    contentType?.split(";", 1)[0].trim().toLowerCase() === "text/event-stream"
  );
}

function isNoCachePolicy(cacheControl: string | null): cacheControl is string {
  return cacheControl?.trim().toLowerCase() === "no-store";
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function runtimeErrorResponse(
  value: unknown,
  status: number,
  allowedCodes: readonly RuntimeErrorCode[],
): ErrorResponse | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !hasExactKeys(value, ["error"])
  ) {
    return null;
  }

  const error = (value as { error: unknown }).error;
  if (
    typeof error !== "object" ||
    error === null ||
    !hasExactKeys(error, ["code", "message", "retryable"])
  ) {
    return null;
  }

  const detail = error as {
    code: unknown;
    message: unknown;
    retryable: unknown;
  };
  if (
    typeof detail.code !== "string" ||
    !Object.hasOwn(RUNTIME_ERROR_CONTRACTS, detail.code)
  ) {
    return null;
  }

  const code = detail.code as RuntimeErrorCode;
  const contract = RUNTIME_ERROR_CONTRACTS[code];
  if (
    (!allowedCodes.includes(code) && !code.startsWith("operator_") && code !== "public_demo_limited" && code !== "run_ownership_required") ||
    status !== contract.status ||
    (!code.startsWith("operator_") && detail.message !== contract.message) ||
    detail.retryable !== contract.retryable
  ) {
    return null;
  }

  return runtimeErrorBody(code);
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; cleanup failure must not replace the safe BFF error.
  }
}

async function normalizeJsonResponse(
  upstream: Response,
  expectedSuccessStatus: number,
  allowedErrorCodes: readonly RuntimeErrorCode[],
  maxBytes?: number,
): Promise<RuntimeJsonResult> {
  const contentType = upstream.headers.get("content-type");
  if (!isJsonContentType(contentType)) {
    await discardBody(upstream);
    return unavailableResult();
  }

  let bytes: ArrayBuffer;
  let parsed: unknown;
  try {
    if (maxBytes !== undefined && upstream.body !== null) {
      const reader = upstream.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error("Response exceeds limit");
          chunks.push(value);
        }
        const buffer = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          buffer.set(chunk, offset);
          offset += chunk.byteLength;
        }
        bytes = buffer.buffer;
      } finally {
        await reader.cancel();
      }
    } else bytes = await upstream.arrayBuffer();
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return unavailableResult();
  }

  if (upstream.status === expectedSuccessStatus) {
    return {
      response: new Response(bytes, {
        status: upstream.status,
        headers: {
          "cache-control": "no-store",
          "content-type": contentType,
        },
      }),
      value: parsed,
    };
  }

  const runtimeError = runtimeErrorResponse(
    parsed,
    upstream.status,
    allowedErrorCodes,
  );
  if (runtimeError !== null) {
    return {
      response: errorResponse(upstream.status, runtimeError, contentType),
      value: null,
    };
  }

  return unavailableResult();
}

export async function fetchRuntimeHealth(): Promise<RuntimeJsonResult> {
  return requestRest(
    "/healthz" satisfies RuntimePath,
    200,
    SCENARIO_ERROR_CODES,
    {
      method: "GET",
    },
  );
}

async function requestRest(
  path: string,
  expectedSuccessStatus: number,
  allowedErrorCodes: readonly RuntimeErrorCode[],
  init: RequestInit,
  searchParams?: URLSearchParams,
  incoming?: Headers,
): Promise<RuntimeJsonResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REST_TIMEOUT_MILLISECONDS,
  );
  AbortSignal.timeout(REST_TIMEOUT_MILLISECONDS);

  try {
    const url = runtimeUrl(path);
    if (searchParams !== undefined) {
      url.search = searchParams.toString();
    }
    const upstream = await fetch(url, {
      ...init,
      headers: operatorHeaders(incoming, init.headers),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if ((path === `${OPERATOR_PATH}/logout` || path.endsWith("/withdrawals")) && upstream.status === 204) {
      return {
        response: withSessionCookies(upstream, new Response(null, { status: 204, headers: { "cache-control": "no-store" } }), path, init.method),
        value: null,
      };
    }
    const result = await normalizeJsonResponse(
      upstream,
      expectedSuccessStatus,
      allowedErrorCodes,
      path.startsWith(`${OPERATOR_PATH}/`) ? 8192 : undefined,
    );
    if (path.startsWith(`${OPERATOR_PATH}/`) && result.response.ok) {
      const session = path === `${OPERATOR_PATH}/login` ? parseOperatorSession(result.value) : parseConsoleSession(result.value);
      if (session === null) return unavailableResult();
      return {
        response: withSessionCookies(upstream, Response.json(session, { headers: { "cache-control": "no-store" } }), path, init.method),
        value: session,
      };
    }
    return { ...result, response: withSessionCookies(upstream, result.response, path, init.method) };
  } catch (error) {
    if (error instanceof InvalidOperatorCookie)
      return {
        response: errorResponse(
          401,
          runtimeErrorBody("operator_authentication_required"),
        ),
        value: null,
      };
    return unavailableResult();
  } finally {
    clearTimeout(timeout);
  }
}

export function fetchScenarios(incoming?: Headers): Promise<RuntimeJsonResult> {
  return requestRest(
    SCENARIOS_PATH,
    200,
    SCENARIO_ERROR_CODES,
    {
      method: "GET",
    },
    undefined,
    incoming,
  );
}

export function fetchIncidents(
  searchParams: URLSearchParams,
  incoming?: Headers,
): Promise<RuntimeJsonResult> {
  return requestRest(
    INCIDENTS_PATH,
    200,
    INCIDENT_LIST_ERROR_CODES,
    { method: "GET" },
    forwardQuery(searchParams, ["limit", "cursor"]),
    incoming,
  );
}

export function fetchMonitoringHealth(
  incoming?: Headers,
): Promise<RuntimeJsonResult> {
  return requestRest(
    MONITORING_HEALTH_PATH,
    200,
    MONITORING_HEALTH_ERROR_CODES,
    { method: "GET" },
    undefined,
    incoming,
  );
}

export function fetchMonitoringOverview(
  incoming?: Headers,
): Promise<RuntimeJsonResult> {
  return requestRest(
    MONITORING_OVERVIEW_PATH,
    200,
    MONITORING_HEALTH_ERROR_CODES,
    { method: "GET" },
    undefined,
    incoming,
  );
}

export function fetchMonitoringPanels(
  incidentId: string,
  incoming?: Headers,
): Promise<RuntimeJsonResult> {
  const path = incidentPath(MONITORING_PANELS_PATH, incidentId);
  if (path === null) {
    return Promise.resolve({
      response: errorResponse(422, INVALID_REQUEST),
      value: null,
    });
  }
  return requestRest(
    path,
    200,
    MONITORING_PANELS_ERROR_CODES,
    {
      method: "GET",
    },
    undefined,
    incoming,
  );
}

export function fetchMonitoringPanel(
  incidentId: string,
  panelId: string,
  searchParams: URLSearchParams,
  incoming?: Headers,
): Promise<RuntimeJsonResult> {
  const path = monitoringPanelPath(incidentId, panelId);
  const windows = searchParams.getAll("window");
  const anchors = searchParams.getAll("anchor");
  const runIds = searchParams.getAll("runId");
  const anchor = anchors[0] ?? "current";
  if (
    path === null ||
    windows.length !== 1 ||
    (windows[0] !== "15m" &&
      windows[0] !== "1h" &&
      windows[0] !== "6h" &&
      windows[0] !== "7d" &&
      windows[0] !== "15d") ||
    anchors.length > 1 ||
    (anchor !== "current" && anchor !== "run") ||
    runIds.length !== (anchor === "run" ? 1 : 0) ||
    (anchor === "run" && !UUID_PATTERN.test(runIds[0] ?? ""))
  ) {
    return Promise.resolve({
      response: errorResponse(422, INVALID_REQUEST),
      value: null,
    });
  }
  return requestRest(
    path,
    200,
    MONITORING_PANEL_ERROR_CODES,
    { method: "GET" },
    new URLSearchParams({
      window: windows[0],
      anchor,
      ...(anchor === "run" ? { runId: runIds[0] } : {}),
    }),
    incoming,
  );
}

export async function createIncident(request: Request): Promise<Response> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return errorResponse(422, INVALID_REQUEST);
  }

  let body: ArrayBuffer;
  try {
    body = await boundedRequestBody(request);
  } catch {
    return errorResponse(422, INVALID_REQUEST);
  }

  const result = await requestRest(
    INCIDENTS_PATH,
    202,
    INCIDENT_CREATE_ERROR_CODES,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    },
    undefined,
    request.headers,
  );
  return result.response;
}

export function fetchIncident(
  incidentId: string,
  runId?: string,
  incoming?: Headers,
): Promise<RuntimeJsonResult> {
  const path = incidentPath(INCIDENT_PATH, incidentId);
  if (path === null || (runId !== undefined && !UUID_PATTERN.test(runId))) {
    return Promise.resolve({
      response: errorResponse(422, INVALID_REQUEST),
      value: null,
    });
  }

  const searchParams = new URLSearchParams();
  if (runId !== undefined) {
    searchParams.set("runId", runId);
  }
  return requestRest(
    path,
    200,
    INCIDENT_DETAIL_ERROR_CODES,
    { method: "GET" },
    searchParams,
    incoming,
  );
}

export function fetchRuns(
  incidentId: string,
  searchParams: URLSearchParams,
  incoming?: Headers,
): Promise<RuntimeJsonResult> {
  const path = incidentPath(INCIDENT_RUNS_PATH, incidentId);
  if (path === null) {
    return Promise.resolve({
      response: errorResponse(422, INVALID_REQUEST),
      value: null,
    });
  }

  return requestRest(
    path,
    200,
    RUN_HISTORY_ERROR_CODES,
    { method: "GET" },
    forwardQuery(searchParams, ["limit", "cursor", "mine"]),
    incoming,
  );
}

export async function createRun(
  incidentId: string,
  request: Request,
): Promise<Response> {
  const path = incidentPath(INCIDENT_RUNS_PATH, incidentId);
  if (path === null) {
    return errorResponse(422, INVALID_REQUEST);
  }
  const incoming = request.headers;
  let body: ArrayBuffer;
  try { body = await boundedRequestBody(request); } catch { return errorResponse(422, INVALID_REQUEST); }
  if (body.byteLength > 0 && !isJsonContentType(incoming.get("content-type"))) {
    return errorResponse(422, INVALID_REQUEST);
  }

  return (
    await requestRest(
      path,
      202,
      RUN_CREATE_ERROR_CODES,
      { method: "POST", ...(body?.byteLength ? { headers: { "content-type": "application/json" }, body } : {}) },
      undefined,
      incoming,
    )
  ).response;
}

export async function createRepairRun(incidentId: string, request: Request): Promise<Response> {
  const path = incidentPath(REPAIR_RUNS_PATH, incidentId);
  if (path === null || !isJsonContentType(request.headers.get("content-type"))) {
    return errorResponse(422, INVALID_REQUEST);
  }
  let body: ArrayBuffer;
  try {
    body = await boundedRequestBody(request);
  } catch {
    return errorResponse(422, INVALID_REQUEST);
  }
  return (await requestRest(path, 202, [...RUN_CREATE_ERROR_CODES, "repair_source_invalid"], {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }, undefined, request.headers)).response;
}

export async function decideApproval(incidentId: string, request: Request): Promise<Response> {
  const path = incidentPath(APPROVALS_PATH, incidentId);
  if (path === null || !isJsonContentType(request.headers.get("content-type"))) {
    return errorResponse(422, INVALID_REQUEST);
  }
  let body: ArrayBuffer;
  try {
    body = await boundedRequestBody(request);
  } catch {
    return errorResponse(422, INVALID_REQUEST);
  }
  return (await requestRest(path, 200, ["approval_conflict", "execution_disabled", "invalid_request", "runtime_not_ready", "internal_error"], {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }, undefined, request.headers)).response;
}

export async function withdrawRun(incidentId: string, request: Request): Promise<Response> {
  const path = incidentPath(WITHDRAWALS_PATH, incidentId);
  if (path === null || !isJsonContentType(request.headers.get("content-type"))) return errorResponse(422, INVALID_REQUEST);
  let body: ArrayBuffer;
  try { body = await boundedRequestBody(request); } catch { return errorResponse(422, INVALID_REQUEST); }
  return (await requestRest(path, 204, RUN_CREATE_ERROR_CODES, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }, undefined, request.headers)).response;
}

export function fetchRunEvents(
  incidentId: string,
  runId: string,
  searchParams: URLSearchParams,
  incoming?: Headers,
): Promise<RuntimeJsonResult> {
  const path = runPath(RUN_EVENTS_PATH, incidentId, runId);
  if (path === null) {
    return Promise.resolve({
      response: errorResponse(422, INVALID_REQUEST),
      value: null,
    });
  }

  return requestRest(
    path,
    200,
    RUN_EVENT_HISTORY_ERROR_CODES,
    { method: "GET" },
    forwardQuery(searchParams, ["limit", "cursor"]),
    incoming,
  );
}

export async function streamIncidentEvents(
  incidentId: string,
  lastEventId: string | null,
  browserSignal: AbortSignal,
  incoming?: Headers,
): Promise<Response> {
  const path = incidentPath(INCIDENT_EVENTS_PATH, incidentId);
  if (path === null) {
    return errorResponse(422, INVALID_REQUEST);
  }

  const controller = new AbortController();
  const abortUpstream = () => controller.abort();
  if (browserSignal.aborted) {
    abortUpstream();
  } else {
    browserSignal.addEventListener("abort", abortUpstream, { once: true });
  }

  const timeout = setTimeout(abortUpstream, SSE_CONNECT_TIMEOUT_MILLISECONDS);

  try {
    const headers = operatorHeaders(incoming, { accept: "text/event-stream" });
    if (lastEventId !== null) {
      headers.set("last-event-id", lastEventId);
    }

    const upstream = await fetch(runtimeUrl(path), {
      method: "GET",
      headers,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const contentType = upstream.headers.get("content-type");
    const cacheControl = upstream.headers.get("cache-control");
    if (
      upstream.status === 200 &&
      upstream.body !== null &&
      isEventStreamContentType(contentType) &&
      isNoCachePolicy(cacheControl)
    ) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "cache-control": cacheControl,
          "content-type": contentType,
        },
      });
    }

    try {
      if (upstream.status >= 400) {
        const result = await normalizeJsonResponse(
          upstream,
          Number.NaN,
          INCIDENT_EVENT_ERROR_CODES,
        );
        return result.response;
      }
      await discardBody(upstream);
      return unavailableResponse();
    } finally {
      browserSignal.removeEventListener("abort", abortUpstream);
    }
  } catch (error) {
    browserSignal.removeEventListener("abort", abortUpstream);
    if (error instanceof InvalidOperatorCookie)
      return errorResponse(
        401,
        runtimeErrorBody("operator_authentication_required"),
      );
    return unavailableResponse();
  } finally {
    clearTimeout(timeout);
  }
}

class InvalidOperatorCookie extends Error {}

function operatorHeaders(incoming?: Headers, initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  const cookie = incoming?.get("cookie");
  if (cookie !== undefined && cookie !== null) {
    if (cookie.length > 8192) throw new InvalidOperatorCookie();
    const selected: string[] = [];
    for (const name of [OPERATOR_COOKIE]) {
      const candidates = cookie.split(";").map(part => part.trim()).filter(part => part.split("=", 1)[0] === name);
      if (candidates.length > 1 || (candidates.length === 1 && !new RegExp("^" + name + "=[A-Za-z0-9_-]{43}$").test(candidates[0]))) throw new InvalidOperatorCookie();
      selected.push(...candidates);
    }
    if (selected.length) headers.set("cookie", selected.join("; "));
  }
  for (const name of ["origin", OPERATOR_CSRF_HEADER]) {
    const value = incoming?.get(name);
    if (value !== undefined && value !== null) headers.set(name, value);
  }
  return headers;
}

function withSessionCookies(upstream: Response, response: Response, path: string, method?: string): Response {
  const cookies = upstream.headers.getSetCookie();
  const login = path === `${OPERATOR_PATH}/login`;
  const logout = path === `${OPERATOR_PATH}/logout`;
  const session = path === `${OPERATOR_PATH}/session`;
  if (cookies.length > 1 || (!response.ok && cookies.length > 0) || (cookies.length && !login && !logout && !session) ||
      (response.ok && login && cookies.length !== 1) || (response.ok && logout && cookies.length !== 1) ||
      (response.ok && session && method === "POST" && cookies.length !== 1)) throw new Error("Invalid session response");
  const names = new Set<string>();
  for (const cookie of cookies) {
    if (cookie.length > 512) throw new Error("Invalid session response");
    const [pair, ...attributes] = cookie.split(";").map(part => part.trim());
    const name = pair.split("=", 1)[0];
    if (name !== OPERATOR_COOKIE || names.has(name)) throw new Error("Invalid session response");
    names.add(name);
    const values = new Map(attributes.map(part => {
      const index = part.indexOf("=");
      return index < 0 ? [part.toLowerCase(), ""] : [part.slice(0, index).toLowerCase(), part.slice(index + 1)];
    }));
    const clearing = values.get("max-age") === "0";
    const expected = clearing ? new RegExp("^" + name + '=(?:"")?$') : new RegExp("^" + name + "=[A-Za-z0-9_-]{43}$");
    if (!expected.test(pair) || values.size !== attributes.length ||
      [...values.keys()].some(key => !["path", "httponly", "secure", "samesite", "max-age", "expires"].includes(key)) ||
      values.get("path") !== "/" || values.get("httponly") !== "" || values.get("secure") !== "" ||
      values.get("samesite")?.toLowerCase() !== "strict" || values.get("max-age") !== (clearing ? "0" : "3600") ||
      (logout && !clearing) || ((login || (session && method === "POST")) && clearing) || (session && method === "GET" && !clearing)) throw new Error("Invalid session response");
    response.headers.append("set-cookie", cookie);
  }
  return response;
}

export function fetchOperatorSession(
  incoming: Headers,
): Promise<RuntimeJsonResult> {
  return requestRest(
    `${OPERATOR_PATH}/session` satisfies RuntimePath,
    200,
    SCENARIO_ERROR_CODES,
    { method: "GET" },
    undefined,
    incoming,
  );
}

export async function logoutOperator(request: Request): Promise<Response> {
  return (
    await requestRest(
      `${OPERATOR_PATH}/logout` satisfies RuntimePath,
      204,
      SCENARIO_ERROR_CODES,
      { method: "POST" },
      undefined,
      request.headers,
    )
  ).response;
}

export async function renewOperatorSession(
  request: Request,
): Promise<Response> {
  return (
    await requestRest(
      `${OPERATOR_PATH}/session` satisfies RuntimePath,
      200,
      SCENARIO_ERROR_CODES,
      { method: "POST" },
      undefined,
      request.headers,
    )
  ).response;
}

export async function loginOperator(request: Request): Promise<Response> {
  if (
    !isJsonContentType(request.headers.get("content-type")) ||
    request.body === null
  )
    return errorResponse(422, INVALID_REQUEST);
  let body: ArrayBuffer;
  try { body = await boundedRequestBody(request); } catch { return errorResponse(422, INVALID_REQUEST); }
  return (await requestRest(
    `${OPERATOR_PATH}/login` satisfies RuntimePath, 200,
    ["invalid_request", "internal_error", "runtime_not_ready"],
    { method: "POST", headers: { "content-type": "application/json" }, body },
    undefined, request.headers,
  )).response;
}

async function boundedRequestBody(request: Request): Promise<ArrayBuffer> {
  if (request.body === null) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Request deadline")), 5000);
  });
  try {
    while (true) {
      const item = await Promise.race([reader.read(), deadline]);
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 8192) throw new Error("Request too large");
      chunks.push(item.value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body.buffer;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}
