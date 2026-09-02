import type { components } from "@/lib/agent-runtime/generated";

type IncidentDetailResponse =
  components["schemas"]["IncidentDetailResponse"];

export const INCIDENT_ID = "11111111-1111-4111-8111-111111111111";
export const RUN_ID = "22222222-2222-4222-8222-222222222222";
export const EVIDENCE_ID = "33333333-3333-4333-8333-333333333333";
export const DIAGNOSIS_ID = "44444444-4444-4444-8444-444444444444";

export function makeIncidentDetail(): IncidentDetailResponse {
  return {
    schemaVersion: 3,
    incident: {
      id: INCIDENT_ID,
      source: {
        type: "scenario",
        ref: "image-pull-backoff",
        revision: "1",
      },
      displayName: "Image pull failure",
      triggerSummary: "Pod cannot pull its container image.",
      status: "RECEIVED",
      target: {
        apiVersion: "v1",
        kind: "Pod",
        namespace: "incident-demo",
        name: "broken-image",
        cluster: "kind-k8s-incident-agent",
      },
      createdAt: "2026-08-29T01:00:00Z",
    },
    selectedRun: {
      id: RUN_ID,
      attempt: 1,
      status: "QUEUED",
      createdAt: "2026-08-29T01:00:00Z",
      startedAt: null,
      completedAt: null,
      error: null,
    },
    eventPage: { items: [], nextCursor: null },
    eventCursor: "1",
    evidence: [],
    diagnosis: null,
    alertSignal: null,
  };
}
