import type { components } from "@/lib/agent-runtime/generated";

type IncidentDetailResponse =
  components["schemas"]["IncidentDetailResponse"];

export const INCIDENT_ID = "11111111-1111-4111-8111-111111111111";
export const RUN_ID = "22222222-2222-4222-8222-222222222222";
export const EVIDENCE_ID = "33333333-3333-4333-8333-333333333333";
export const ROLLOUT_EVIDENCE_ID = "77777777-7777-4777-8777-777777777777";
export const DIAGNOSIS_ID = "44444444-4444-4444-8444-444444444444";
export const REPAIR_PROPOSAL_ID = "88888888-8888-4888-8888-888888888888";
export const REPAIR_PROPOSAL_DIGEST = `sha256:${"a".repeat(64)}`;

export function makeRepairProposal(): NonNullable<
  IncidentDetailResponse["repair"]
> {
  const imagePath = "/spec/template/spec/containers/0/image";
  const currentImage = "registry.invalid/k8s-incident-agent/missing:v1";
  const replacementImage =
    "registry.k8s.io/e2e-test-images/agnhost:2.53@sha256:99c6b4bb4a1e1df3f0b3752168c89358794d02258ebebc26bf21c29399011a85";
  return {
    schemaVersion: 1,
    id: REPAIR_PROPOSAL_ID,
    action: "set_container_image",
    target: {
      apiVersion: "apps/v1",
      kind: "Deployment",
      namespace: "incident-demo",
      name: "broken-image",
      cluster: "kind-k8s-incident-agent",
    },
    targetUid: "deployment-uid",
    targetResourceVersion: "42",
    containerIndex: 0,
    containerName: "workload",
    currentImage,
    replacementImage,
    evidenceIds: [EVIDENCE_ID, ROLLOUT_EVIDENCE_ID],
    patch: [
      { op: "test", path: "/metadata/uid", value: "deployment-uid" },
      { op: "test", path: "/metadata/resourceVersion", value: "42" },
      {
        op: "test",
        path: "/spec/template/spec/containers/0/name",
        value: "workload",
      },
      { op: "test", path: imagePath, value: currentImage },
      { op: "replace", path: imagePath, value: replacementImage },
    ],
    digest: REPAIR_PROPOSAL_DIGEST,
    diff: { path: imagePath, before: currentImage, after: replacementImage },
    schemaCheckedAt: "2026-08-29T01:00:04Z",
    policyCheckedAt: "2026-08-29T01:00:05Z",
    diffCheckedAt: "2026-08-29T01:00:06Z",
    validation: {
      outcome: "passed",
      checkedAt: "2026-08-29T01:00:07Z",
      error: null,
    },
  };
}

export function makeWaitingApprovalIncidentDetail(): IncidentDetailResponse {
  const detail = makeIncidentDetail();
  detail.incident.status = "WAITING_APPROVAL";
  detail.incident.target = makeRepairProposal().target;
  detail.selectedRun.status = "COMPLETED";
  detail.selectedRun.startedAt = "2026-08-29T01:00:01Z";
  detail.selectedRun.completedAt = "2026-08-29T01:00:08Z";
  detail.evidence = [
    {
      id: EVIDENCE_ID,
      toolCallId: "call-workload",
      toolName: "get_workload",
      evidenceKind: "workload",
      targetRef: {},
      observedAt: "2026-08-29T01:00:02Z",
      payload: {},
      truncated: false,
      redacted: false,
    },
    {
      id: ROLLOUT_EVIDENCE_ID,
      toolCallId: "call-rollout-history",
      toolName: "get_rollout_history",
      evidenceKind: "rollout_history",
      targetRef: {},
      observedAt: "2026-08-29T01:00:03Z",
      payload: {},
      truncated: false,
      redacted: false,
    },
  ];
  detail.diagnosis = {
    id: DIAGNOSIS_ID,
    outcome: "diagnosed",
    summary: "The configured image registry is invalid.",
    rootCauses: [
      {
        code: "image_invalid_registry",
        statement: "The current image references an invalid registry.",
        confidence: "high",
        evidenceIds: [EVIDENCE_ID, ROLLOUT_EVIDENCE_ID],
      },
    ],
    missingInformation: [],
    redacted: false,
    createdAt: "2026-08-29T01:00:04Z",
  };
  detail.repair = makeRepairProposal();
  return detail;
}

export function makeIncidentDetail(): IncidentDetailResponse {
  return {
    schemaVersion: 5,
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
      kind: "diagnosis",
      operation: null,
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
    repair: null,
    alertSignal: null,
  };
}

export function makeRepairRunWaitingDetail(): IncidentDetailResponse {
  const detail = makeWaitingApprovalIncidentDetail();
  detail.selectedRun = {
    ...detail.selectedRun,
    id: "99999999-9999-4999-8999-999999999999",
    attempt: 2,
    kind: "repair",
    operation: "apply",
    status: "WAITING_APPROVAL",
    completedAt: null,
  };
  detail.diagnosis = null;
  return detail;
}
