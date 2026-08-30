import {
  parseCreateIncidentResponse,
  parseIncidentDetailResponse,
  type CreateIncidentView,
  type IncidentDetailView,
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
): Promise<BrowserRuntimeResult<IncidentDetailView>> {
  let response: Response;
  try {
    response = await fetch(
      `/api/runtime/incidents/${encodeURIComponent(incidentId)}`,
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
