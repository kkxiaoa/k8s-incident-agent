import "server-only";

import {
  parseIncidentDetailResponse,
  parseIncidentListResponse,
  parseScenarioListResponse,
  type IncidentDetailView,
  type IncidentListView,
  type ScenarioListView,
} from "./response-contracts";
import {
  fetchIncident,
  fetchIncidents,
  fetchScenarios,
} from "./server-client";

type IncidentPageData =
  | { state: "ready"; detail: IncidentDetailView }
  | { state: "missing" }
  | { state: "unavailable" };

export async function loadIncidentConsoleOverview(): Promise<{
  scenarios: ScenarioListView | null;
  incidents: IncidentListView | null;
}> {
  const [scenarioResult, incidentResult] = await Promise.all([
    fetchScenarios(),
    fetchIncidents(new URLSearchParams({ limit: "50" })),
  ]);

  return {
    scenarios: scenarioResult.response.ok
      ? parseScenarioListResponse(scenarioResult.value)
      : null,
    incidents: incidentResult.response.ok
      ? parseIncidentListResponse(incidentResult.value)
      : null,
  };
}

export async function loadIncidentPage(
  incidentId: string,
): Promise<IncidentPageData> {
  const result = await fetchIncident(incidentId);
  if (result.response.status === 404 || result.response.status === 422) {
    return { state: "missing" };
  }

  const detail = result.response.ok
    ? parseIncidentDetailResponse(result.value)
    : null;
  return detail === null
    ? { state: "unavailable" }
    : { state: "ready", detail };
}
