import { authenticatedFetch } from "./operator-client";
import {
  parseCreateIncidentResponse,
  parseApprovalResponse,
  parseCreateRunResponse,
  parseIncidentDetailResponse,
  parseIncidentMetricPanelResponse,
  parseRunEventHistoryResponse,
  parseRunHistoryResponse,
  type CreateIncidentView,
  type CreateRunView,
  type RepairRunRequest,
  type ApprovalRequest,
  type EventPageView,
  type IncidentDetailView,
  type IncidentMetricPanelView,
  type MetricWindowView,
  type RunHistoryView,
} from "./response-contracts";

type BrowserRuntimeFailure =
  | "invalid_response"
  | "not_found"
  | "unavailable";

type BrowserRuntimeResult<T, Failure = BrowserRuntimeFailure> =
  | { ok: true; data: T }
  | { ok: false; failure: Failure };

type CreateFailure = BrowserRuntimeFailure | "diagnosis_unavailable";

async function jsonBody(response: Response): Promise<unknown | null> {
  if (
    response.headers.get("content-type")?.split(";", 1)[0].trim() !==
    "application/json"
  ) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
}

function failureForStatus(status: number): BrowserRuntimeFailure {
  return status === 404 ? "not_found" : "unavailable";
}

async function createFailure(response: Response): Promise<CreateFailure> {
  const body = await jsonBody(response);
  if (
    response.status === 503 && body !== null && typeof body === "object" &&
    "error" in body && body.error !== null && typeof body.error === "object" &&
    "code" in body.error && body.error.code === "diagnosis_unavailable" &&
    "retryable" in body.error && body.error.retryable === true
  ) {
    return "diagnosis_unavailable";
  }
  return failureForStatus(response.status);
}

export async function createIncidentFromBrowser(
  scenarioId: string,
): Promise<BrowserRuntimeResult<CreateIncidentView, CreateFailure>> {
  let response: Response;
  try {
    response = await authenticatedFetch("/api/runtime/incidents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId }),
      cache: "no-store",
    });
  } catch {
    return { ok: false, failure: "unavailable" };
  }

  if (!response.ok) {
    return { ok: false, failure: await createFailure(response) };
  }

  const body = await jsonBody(response);
  const data = parseCreateIncidentResponse(body);
  return data !== null
    ? { ok: true, data }
    : { ok: false, failure: "invalid_response" };
}

type RepairActionFailure = BrowserRuntimeFailure | "conflict" | "forbidden";

async function postRepairAction<T>(
  incidentId: string, endpoint: "repair-runs" | "approvals", request: RepairRunRequest | ApprovalRequest,
  parse: (body: unknown) => T | null,
): Promise<BrowserRuntimeResult<T, RepairActionFailure>> {
  try {
    const response = await authenticatedFetch(
      `/api/runtime/incidents/${encodeURIComponent(incidentId)}/${endpoint}`,
      { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(request) },
    );
    if (!response.ok) return { ok: false, failure: response.status === 409 ? "conflict" : response.status === 403 ? "forbidden" : failureForStatus(response.status) };
    const data = parse(await jsonBody(response));
    return data === null ? { ok: false, failure: "invalid_response" } : { ok: true, data };
  } catch {
    return { ok: false, failure: "unavailable" };
  }
}

export function prepareRepairFromBrowser(incidentId: string, request: RepairRunRequest) {
  return postRepairAction(incidentId, "repair-runs", request, parseCreateRunResponse);
}

export function decideRepairFromBrowser(incidentId: string, request: ApprovalRequest) {
  return postRepairAction(incidentId, "approvals", request, (body) => {
    const approval = parseApprovalResponse(body);
    return approval?.runId === request.runId && approval.proposalId === request.proposalId
      && approval.proposalDigest === request.proposalDigest && approval.decision === request.decision ? approval : null;
  });
}

export async function fetchIncidentFromBrowser(
  incidentId: string,
  runId?: string,
): Promise<BrowserRuntimeResult<IncidentDetailView>> {
  const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
  let response: Response;
  try {
    response = await authenticatedFetch(
      `/api/runtime/incidents/${encodeURIComponent(incidentId)}${query}`,
      { method: "GET", cache: "no-store" },
    );
  } catch {
    return { ok: false, failure: "unavailable" };
  }

  if (!response.ok) {
    return { ok: false, failure: failureForStatus(response.status) };
  }

  const body = await jsonBody(response);
  const data = parseIncidentDetailResponse(body);
  return data !== null
    ? { ok: true, data }
    : { ok: false, failure: "invalid_response" };
}

export async function fetchMonitoringPanelFromBrowser(
  incidentId: string,
  panelId: string,
  window: MetricWindowView,
): Promise<BrowserRuntimeResult<IncidentMetricPanelView>> {
  const query = new URLSearchParams({ window });
  let response: Response;
  try {
    response = await authenticatedFetch(
      `/api/runtime/incidents/${encodeURIComponent(incidentId)}/monitoring/${encodeURIComponent(panelId)}?${query}`,
      { method: "GET", cache: "no-store" },
    );
  } catch {
    return { ok: false, failure: "unavailable" };
  }
  if (!response.ok) {
    return { ok: false, failure: failureForStatus(response.status) };
  }
  const data = parseIncidentMetricPanelResponse(
    await jsonBody(response),
    panelId,
    window,
  );
  return data !== null
    ? { ok: true, data }
    : { ok: false, failure: "invalid_response" };
}

export async function createRunFromBrowser(
  incidentId: string,
  replacesRunId?: string,
): Promise<BrowserRuntimeResult<CreateRunView, CreateFailure>> {
  let response: Response;
  try {
    response = await authenticatedFetch(
      `/api/runtime/incidents/${encodeURIComponent(incidentId)}/runs`,
      { method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
        body: JSON.stringify(replacesRunId ? { replacesRunId } : {}), },
    );
  } catch {
    return { ok: false, failure: "unavailable" };
  }

  if (!response.ok) {
    return { ok: false, failure: await createFailure(response) };
  }

  const data = parseCreateRunResponse(await jsonBody(response));
  return data !== null
    ? { ok: true, data }
    : { ok: false, failure: "invalid_response" };
}

export async function fetchRunHistoryFromBrowser(
  incidentId: string,
  cursor?: string,
): Promise<BrowserRuntimeResult<RunHistoryView>> {
  const query = new URLSearchParams({ limit: "20" });
  if (cursor !== undefined) {
    query.set("cursor", cursor);
  }

  let response: Response;
  try {
    response = await authenticatedFetch(
      `/api/runtime/incidents/${encodeURIComponent(incidentId)}/runs?${query}`,
      { method: "GET", cache: "no-store" },
    );
  } catch {
    return { ok: false, failure: "unavailable" };
  }

  if (!response.ok) {
    return { ok: false, failure: failureForStatus(response.status) };
  }

  const data = parseRunHistoryResponse(await jsonBody(response));
  return data !== null
    ? { ok: true, data }
    : { ok: false, failure: "invalid_response" };
}

export async function fetchRunEventsFromBrowser(
  incidentId: string,
  runId: string,
  cursor: string,
): Promise<BrowserRuntimeResult<EventPageView>> {
  const query = new URLSearchParams({ limit: "100", cursor });
  let response: Response;
  try {
    response = await authenticatedFetch(
      `/api/runtime/incidents/${encodeURIComponent(incidentId)}/runs/${encodeURIComponent(runId)}/events?${query}`,
      { method: "GET", cache: "no-store" },
    );
  } catch {
    return { ok: false, failure: "unavailable" };
  }

  if (!response.ok) {
    return { ok: false, failure: failureForStatus(response.status) };
  }

  const data = parseRunEventHistoryResponse(
    await jsonBody(response),
    incidentId,
    runId,
  );
  return data !== null
    ? { ok: true, data }
    : { ok: false, failure: "invalid_response" };
}
