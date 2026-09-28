import { contractError, upstreamContractError } from "../shared/errors.ts";
import { isNormalizedString, isPlainObject, isUuid } from "../shared/guards.ts";

export interface ConsoleIncidentIdentity {
  incidentId: string;
  displayName: string;
  targetName: string;
}

// What the Console must render for an Incident, taken from the Runtime's own detail document.
export function requireConsoleIncidentIdentity(detail: unknown): ConsoleIncidentIdentity {
  const incident = isPlainObject(detail) ? detail.incident : undefined;
  if (!isPlainObject(incident)) throw upstreamContractError();
  const incidentId = incident.id;
  const displayName = incident.displayName;
  const target = incident.target;
  const targetName = isPlainObject(target) ? target.name : undefined;
  if (!isUuid(incidentId) || !isNormalizedString(displayName) || !isNormalizedString(targetName)) {
    throw upstreamContractError();
  }
  return { incidentId, displayName, targetName };
}

export function requireConsoleIncidentPage(document: string, identity: ConsoleIncidentIdentity): void {
  if (
    !document.includes(identity.incidentId) ||
    !document.includes(identity.displayName) ||
    !document.includes(identity.targetName)
  ) {
    throw contractError(
      "console_incident_incomplete",
      "Console did not render stable details for the evaluated Incident",
    );
  }
}

export function requireOnlineHomePage(document: string): void {
  if (document.includes("离线评估入口") || document.includes("创建 Incident")) {
    throw contractError("online_console_invalid", "Online Console exposes a manual intake control");
  }
}
