import type { components } from "./generated";

export type VerificationView = Required<components["schemas"]["VerificationRecord"]>;

export function isVerificationOutcome(value: unknown): value is VerificationView["outcome"] {
  return value === "observing" || value === "recovered" || value === "workload_failed" ||
    value === "monitoring_unavailable" || value === "insufficient_evidence" || value === "target_drift" || value === "timeout";
}

export function isVerificationReason(value: unknown): value is VerificationView["reason"] {
  return value === null || value === "rollout_pending" || value === "workload_unhealthy" ||
    value === "sample_missing" || value === "sample_gap" || value === "monitoring_unavailable" ||
    value === "metrics_missing_or_stale" || value === "alerts_active" || value === "occurrence_not_resolved" ||
    value === "target_drift" || value === "deadline_exceeded";
}
