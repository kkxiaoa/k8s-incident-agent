import type { IncidentStatus, RunStatus } from "@/lib/agent-runtime/view-models";
import { ShimmerText } from "@/components/ui/shimmer-text";
import {
  incidentStatusLabel,
  runStatusLabel,
} from "@/lib/agent-runtime/view-models";

function tone(status: IncidentStatus | RunStatus): string {
  if (status === "FAILED" || status === "STALE_RESOURCE") {
    return "status-badge status-badge--danger";
  }
  if (
    status === "DIAGNOSED" ||
    status === "DRY_RUN_PASSED" ||
    status === "COMPLETED"
  ) {
    return "status-badge status-badge--success";
  }
  if (status === "INSUFFICIENT_EVIDENCE" || status === "WAITING_APPROVAL") {
    return "status-badge status-badge--warning";
  }
  if (
    status === "TRIAGING" ||
    status === "QUEUED" ||
    status === "APPLYING" ||
    status === "VERIFYING" ||
    status === "PATCH_READY" ||
    status === "RUNNING"
  ) {
    return "status-badge status-badge--active";
  }
  return "status-badge status-badge--neutral";
}

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  const className = tone(status);
  return <span className={className}><ShimmerText active={className === "status-badge status-badge--active"}>{incidentStatusLabel(status)}</ShimmerText></span>;
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const className = tone(status);
  return <span className={className}><ShimmerText active={className === "status-badge status-badge--active"}>{runStatusLabel(status)}</ShimmerText></span>;
}
