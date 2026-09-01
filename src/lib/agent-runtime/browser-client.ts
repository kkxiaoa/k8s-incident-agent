import {
  parseCreateIncidentResponse,
  parseCreateRunResponse,
  parseIncidentDetailResponse,
  parseRunEventHistoryResponse,
  parseRunHistoryResponse,
  type CreateIncidentView,
  type CreateRunView,
  type EventPageView,
  type IncidentDetailView,
  type RunHistoryView,
} from "./response-contracts";

type BrowserRuntimeFailure =
  | "invalid_response"
  | "not_found"
  | "unavailable";

type BrowserRuntimeResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: BrowserRuntimeFailure };

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

export async function createIncidentFromBrowser(
  scenarioId: string,
): Promise<BrowserRuntimeResult<CreateIncidentView>> {
  let response: Response;
  try {
    response = await fetch("/api/runtime/incidents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId }),
      cache: "no-store",
    });
  } catch {
    return { ok: false, failure: "unavailable" };
  }

  if (!response.ok) {
    return { ok: false, failure: failureForStatus(response.status) };
  }

  const body = await jsonBody(response);
  const data = parseCreateIncidentResponse(body);
  return data !== null
    ? { ok: true, data }
    : { ok: false, failure: "invalid_response" };
}

export async function fetchIncidentFromBrowser(
  incidentId: string,
  runId?: string,
): Promise<BrowserRuntimeResult<IncidentDetailView>> {
  const query = runId === undefined ? "" : `?runId=${encodeURIComponent(runId)}`;
  let response: Response;
  try {
    response = await fetch(
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

export async function createRunFromBrowser(
  incidentId: string,
): Promise<BrowserRuntimeResult<CreateRunView>> {
  let response: Response;
  try {
    response = await fetch(
      `/api/runtime/incidents/${encodeURIComponent(incidentId)}/runs`,
      { method: "POST", cache: "no-store" },
    );
  } catch {
    return { ok: false, failure: "unavailable" };
  }

  if (!response.ok) {
    return { ok: false, failure: failureForStatus(response.status) };
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
    response = await fetch(
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
    response = await fetch(
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
