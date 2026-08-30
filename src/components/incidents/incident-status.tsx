import type { IncidentStatus, RunStatus } from "@/lib/agent-runtime/view-models";
import {
  incidentStatusLabel,
  runStatusLabel,
} from "@/lib/agent-runtime/view-models";

function tone(status: IncidentStatus | RunStatus): string {
  if (status === "FAILED") {
    return "status-badge status-badge--danger";
  }
  if (status === "DIAGNOSED" || status === "COMPLETED") {
    return "status-badge status-badge--success";
  }
  if (status === "INSUFFICIENT_EVIDENCE") {
    return "status-badge status-badge--warning";
  }
  if (status === "TRIAGING" || status === "RUNNING") {
    return "status-badge status-badge--active";
  }
  return "status-badge status-badge--neutral";
}

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  return <span className={tone(status)}>{incidentStatusLabel(status)}</span>;
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <span className={tone(status)}>{runStatusLabel(status)}</span>;
}
