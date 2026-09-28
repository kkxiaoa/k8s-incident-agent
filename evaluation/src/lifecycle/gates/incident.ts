import type { EvaluationScenario } from "../../contracts/dataset.ts";
import { isRunHistoryPage, type IncidentDetail } from "../../contracts/runtime-api.ts";
import { contractError } from "../../shared/errors.ts";
import { isPlainObject } from "../../shared/guards.ts";
import { sameTarget } from "./repair.ts";
import { TERMINAL_RUN_STATUSES } from "./terminal.ts";

export function matchesScenarioIncident(incident: unknown, scenario: EvaluationScenario): boolean {
  if (!isPlainObject(incident)) return false;
  const source = incident.source;
  return (
    sameTarget(incident.target, scenario.target) &&
    isPlainObject(source) &&
    source.type === "alertmanager" &&
    source.ref === scenario.alertId
  );
}

// One alert occurrence must create exactly one Incident for its target; none yet means keep waiting.
export function selectNewTargetIncident(candidates: readonly IncidentDetail[]): IncidentDetail | undefined {
  if (candidates.length > 1) {
    throw contractError("duplicate_target_incident", "One alert occurrence created multiple Incidents for the target");
  }
  return candidates[0];
}

export function isTerminalRun(detail: IncidentDetail): boolean {
  return TERMINAL_RUN_STATUSES.has(String(detail.selectedRun.status));
}

// The repeated Alertmanager delivery must not have created another Incident or Run.
export function requireSingleTargetRun(
  targetIncidents: readonly string[],
  incidentId: string,
  runs: unknown,
): void {
  const run: unknown = isRunHistoryPage(runs) ? runs.items[0] : undefined;
  const summary = isPlainObject(run) ? run : undefined;
  if (
    targetIncidents.length !== 1 ||
    targetIncidents[0] !== incidentId ||
    !isRunHistoryPage(runs) ||
    runs.items.length !== 1 ||
    summary?.attempt !== 1 ||
    summary?.kind !== "diagnosis" ||
    summary?.operation !== null
  ) {
    throw contractError(
      "alert_repeat_not_deduplicated",
      "Repeated Alertmanager delivery created another Incident or Run",
    );
  }
}

export function isResolvedIncident(detail: IncidentDetail): boolean {
  const page: unknown = detail.eventPage;
  const items: unknown = isPlainObject(page) ? page.items : undefined;
  const resolvedEvent = Array.isArray(items) && items.some((item) => isPlainObject(item) && item.event === "alert.resolved");
  return detail.alertSignal?.status === "RESOLVED" && resolvedEvent;
}

export function requireIncidentNotResolved(detail: IncidentDetail): void {
  if (detail.incident.status === "RESOLVED") {
    throw contractError("incident_resolution_invalid", "Alert resolution must not resolve the Incident");
  }
}
