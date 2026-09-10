import "server-only";

import {
  parseIncidentDetailResponse,
  parseIncidentListResponse,
  parseMonitoringHealthResponse,
  parseMonitoringOverviewResponse,
  parseMonitoringPanelListResponse,
  parseRunHistoryResponse,
  parseScenarioListResponse,
  parseRuntimeHealthResponse,
  type IncidentDetailView,
  type IncidentListView,
  type MonitoringHealthView,
  type MonitoringOverviewView,
  type MonitoringPanelListView,
  type RunHistoryView,
  type ScenarioListView,
  type RuntimeHealthView,
} from "./response-contracts";
import {
  fetchIncident,
  fetchIncidents,
  fetchMonitoringHealth,
  fetchMonitoringOverview,
  fetchMonitoringPanels,
  fetchRuns,
  fetchScenarios,
  fetchRuntimeHealth,
} from "./server-client";
import type { IncidentIntakeMode } from "./server-config";

type IncidentPageData =
  | {
      state: "ready";
      detail: IncidentDetailView;
      runs: RunHistoryView;
      monitoringPanels: MonitoringPanelListView | null;
    }
  | { state: "missing" }
  | { state: "invalid" }
  | { state: "unavailable" };

interface IncidentConsoleOverview {
  runtimeHealth: RuntimeHealthView | null;
  scenarios: ScenarioListView | null;
  incidents: IncidentListView | null;
  monitoringHealth: MonitoringHealthView | null;
  monitoringOverview: MonitoringOverviewView | null;
}

export async function loadIncidentConsoleOverview(
  intakeMode: IncidentIntakeMode,
): Promise<IncidentConsoleOverview> {
  if (intakeMode === "online") {
    const [incidentResult, healthResult, overviewResult, runtimeResult] = await Promise.all([
      fetchIncidents(new URLSearchParams({ limit: "50" })),
      fetchMonitoringHealth(),
      fetchMonitoringOverview(),
      fetchRuntimeHealth(),
    ]);
    return {
      runtimeHealth: runtimeResult.response.ok
        ? parseRuntimeHealthResponse(runtimeResult.value)
        : null,
      scenarios: null,
      incidents: incidentResult.response.ok
        ? parseIncidentListResponse(incidentResult.value)
        : null,
      monitoringHealth: healthResult.response.ok
        ? parseMonitoringHealthResponse(healthResult.value)
        : null,
      monitoringOverview: overviewResult.response.ok
        ? parseMonitoringOverviewResponse(overviewResult.value)
        : null,
    };
  }

  const [scenarioResult, incidentResult, healthResult, overviewResult, runtimeResult] =
    await Promise.all([
      fetchScenarios(),
      fetchIncidents(new URLSearchParams({ limit: "50" })),
      fetchMonitoringHealth(),
      fetchMonitoringOverview(),
      fetchRuntimeHealth(),
    ]);

  return {
    runtimeHealth: runtimeResult.response.ok
      ? parseRuntimeHealthResponse(runtimeResult.value)
      : null,
    scenarios: scenarioResult.response.ok
      ? parseScenarioListResponse(scenarioResult.value)
      : null,
    incidents: incidentResult.response.ok
      ? parseIncidentListResponse(incidentResult.value)
      : null,
    monitoringHealth: healthResult.response.ok
      ? parseMonitoringHealthResponse(healthResult.value)
      : null,
    monitoringOverview: overviewResult.response.ok
      ? parseMonitoringOverviewResponse(overviewResult.value)
      : null,
  };
}

export async function loadIncidentPage(
  incidentId: string,
  runId?: string,
): Promise<IncidentPageData> {
  const [detailResult, runsResult, monitoringPanelsResult] =
    await Promise.all([
      fetchIncident(incidentId, runId),
      fetchRuns(incidentId, new URLSearchParams({ limit: "20" })),
      fetchMonitoringPanels(incidentId),
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
  return !detailResult.response.ok || !runsResult.response.ok
    ? { state: "unavailable" }
    : detail === null || runs === null
    ? { state: "invalid" }
    : {
        state: "ready",
        detail,
        runs,
        monitoringPanels: monitoringPanelsResult.response.ok
          ? parseMonitoringPanelListResponse(monitoringPanelsResult.value)
          : null,
      };
}
