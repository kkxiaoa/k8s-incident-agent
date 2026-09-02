import "server-only";

import type { components, paths } from "./generated";
import { getAgentRuntimeBaseUrl } from "./server-config";

type ErrorResponse = components["schemas"]["ErrorResponse"];
type RuntimePath = keyof paths;

interface RuntimeJsonResult {
  response: Response;
  value: unknown | null;
}

const SCENARIOS_PATH = "/api/v1/scenarios" satisfies RuntimePath;
const INCIDENTS_PATH = "/api/v1/incidents" satisfies RuntimePath;
const INCIDENT_PATH = "/api/v1/incidents/{incident_id}" satisfies RuntimePath;
const INCIDENT_EVENTS_PATH =
  "/api/v1/incidents/{incident_id}/events" satisfies RuntimePath;
const INCIDENT_RUNS_PATH =
  "/api/v1/incidents/{incident_id}/runs" satisfies RuntimePath;
const RUN_EVENTS_PATH =
  "/api/v1/incidents/{incident_id}/runs/{run_id}/events" satisfies RuntimePath;
const MONITORING_HEALTH_PATH =
  "/api/v1/monitoring/health" satisfies RuntimePath;
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
  return cacheControl?.trim().toLowerCase() === "no-cache";
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
    !allowedCodes.includes(code) ||
    status !== contract.status ||
    detail.message !== contract.message ||
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
): Promise<RuntimeJsonResult> {
  const contentType = upstream.headers.get("content-type");
  if (!isJsonContentType(contentType)) {
    await discardBody(upstream);
    return unavailableResult();
  }

  let bytes: ArrayBuffer;
  let parsed: unknown;
  try {
    bytes = await upstream.arrayBuffer();
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

async function requestRest(
  path: string,
  expectedSuccessStatus: number,
  allowedErrorCodes: readonly RuntimeErrorCode[],
  init: RequestInit,
  searchParams?: URLSearchParams,
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
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    return await normalizeJsonResponse(
      upstream,
      expectedSuccessStatus,
      allowedErrorCodes,
    );
  } catch {
    return unavailableResult();
  } finally {
    clearTimeout(timeout);
  }
}

export function fetchScenarios(): Promise<RuntimeJsonResult> {
  return requestRest(SCENARIOS_PATH, 200, SCENARIO_ERROR_CODES, {
    method: "GET",
  });
}

export function fetchIncidents(
  searchParams: URLSearchParams,
): Promise<RuntimeJsonResult> {
  return requestRest(
    INCIDENTS_PATH,
    200,
    INCIDENT_LIST_ERROR_CODES,
    { method: "GET" },
    forwardQuery(searchParams, ["limit", "cursor"]),
  );
}

export function fetchMonitoringHealth(): Promise<RuntimeJsonResult> {
  return requestRest(
    MONITORING_HEALTH_PATH,
    200,
    MONITORING_HEALTH_ERROR_CODES,
    { method: "GET" },
  );
}

export function fetchMonitoringPanels(
  incidentId: string,
): Promise<RuntimeJsonResult> {
  const path = incidentPath(MONITORING_PANELS_PATH, incidentId);
  if (path === null) {
    return Promise.resolve({
      response: errorResponse(422, INVALID_REQUEST),
      value: null,
    });
  }
  return requestRest(path, 200, MONITORING_PANELS_ERROR_CODES, {
    method: "GET",
  });
}

export function fetchMonitoringPanel(
  incidentId: string,
  panelId: string,
  searchParams: URLSearchParams,
): Promise<RuntimeJsonResult> {
  const path = monitoringPanelPath(incidentId, panelId);
  const windows = searchParams.getAll("window");
  if (
    path === null ||
    windows.length !== 1 ||
    (windows[0] !== "15m" && windows[0] !== "1h" && windows[0] !== "6h")
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
    new URLSearchParams({ window: windows[0] }),
  );
}

export async function createIncident(request: Request): Promise<Response> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return errorResponse(422, INVALID_REQUEST);
  }

  let body: ArrayBuffer;
  try {
    body = await request.arrayBuffer();
  } catch {
    return errorResponse(422, INVALID_REQUEST);
  }

  const result = await requestRest(INCIDENTS_PATH, 202, INCIDENT_CREATE_ERROR_CODES, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return result.response;
}

export function fetchIncident(
  incidentId: string,
  runId?: string,
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
  );
}

export function fetchRuns(
  incidentId: string,
  searchParams: URLSearchParams,
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
    forwardQuery(searchParams, ["limit", "cursor"]),
  );
}

export async function createRun(incidentId: string): Promise<Response> {
  const path = incidentPath(INCIDENT_RUNS_PATH, incidentId);
  if (path === null) {
    return errorResponse(422, INVALID_REQUEST);
  }

  return (
    await requestRest(path, 202, RUN_CREATE_ERROR_CODES, { method: "POST" })
  ).response;
}

export function fetchRunEvents(
  incidentId: string,
  runId: string,
  searchParams: URLSearchParams,
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
  );
}

export async function streamIncidentEvents(
  incidentId: string,
  lastEventId: string | null,
  browserSignal: AbortSignal,
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
    const headers = new Headers({ accept: "text/event-stream" });
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
  } catch {
    browserSignal.removeEventListener("abort", abortUpstream);
    return unavailableResponse();
  } finally {
    clearTimeout(timeout);
  }
}
