import type { components } from "@/lib/agent-runtime/generated";
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

export function CurrentAlertBadge({ state }: { state: components["schemas"]["CurrentAlertState"] }) {
  const tone = state === "CLEAR" ? "success" : state === "FIRING" ? "danger" : "warning";
  return <span className={`status-badge status-badge--${tone}`}>{state === "UNKNOWN" ? "UNKNOWN · 未确认" : state}</span>;
}

export function lifecycleLabel(status: components["schemas"]["IncidentLifecycleStatus"] | null) {
  return status === null ? "历史未判定" : status === "OPEN" ? "未关闭" : "已关闭";
}
