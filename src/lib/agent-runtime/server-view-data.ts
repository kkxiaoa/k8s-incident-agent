import "server-only";

import {
  parseIncidentDetailResponse,
  parseIncidentListResponse,
  parseRunHistoryResponse,
  parseScenarioListResponse,
  type IncidentDetailView,
  type IncidentListView,
  type RunHistoryView,
  type ScenarioListView,
} from "./response-contracts";
import {
  fetchIncident,
  fetchIncidents,
  fetchRuns,
  fetchScenarios,
} from "./server-client";
import type { IncidentIntakeMode } from "./server-config";

type IncidentPageData =
  | { state: "ready"; detail: IncidentDetailView; runs: RunHistoryView }
  | { state: "missing" }
  | { state: "unavailable" };

interface IncidentConsoleOverview {
  scenarios: ScenarioListView | null;
  incidents: IncidentListView | null;
}

export async function loadIncidentConsoleOverview(
  intakeMode: IncidentIntakeMode,
): Promise<IncidentConsoleOverview> {
  if (intakeMode === "online") {
    const incidentResult = await fetchIncidents(
      new URLSearchParams({ limit: "50" }),
    );
    return {
      scenarios: null,
      incidents: incidentResult.response.ok
        ? parseIncidentListResponse(incidentResult.value)
        : null,
    };
  }

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
  runId?: string,
): Promise<IncidentPageData> {
  const [detailResult, runsResult] = await Promise.all([
    fetchIncident(incidentId, runId),
    fetchRuns(incidentId, new URLSearchParams({ limit: "20" })),
  ]);
  if (
    detailResult.response.status === 404 ||
    detailResult.response.status === 422
  ) {
    return { state: "missing" };
  }

  const detail = detailResult.response.ok
    ? parseIncidentDetailResponse(detailResult.value)
    : null;
  const runs = runsResult.response.ok
    ? parseRunHistoryResponse(runsResult.value)
    : null;
  return detail === null || runs === null
    ? { state: "unavailable" }
    : { state: "ready", detail, runs };
}
