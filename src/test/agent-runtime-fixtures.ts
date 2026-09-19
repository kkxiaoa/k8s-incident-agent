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
    recommendations: [
      {
        action: "对照 rollout 历史确认当前镜像是否为误发布",
        purpose: "在不改动集群的前提下判断是否应回到上一可用镜像",
        preconditions: "确认 rollout 历史中的上一版本镜像仍可拉取",
        risk: "若上一版本同样有问题，回退不能恢复",
        verification: "观察镜像拉取失败 Pod 数是否回到 0",
        evidenceIds: [EVIDENCE_ID],
      },
    ],
    redacted: false,
    createdAt: "2026-08-29T01:00:04Z",
  };
  detail.repair = makeRepairProposal();
  detail.actions = {
    ...detail.actions, prepare: null, edit: null, rerun: null,
    preparationSource: { sourceRunId: detail.selectedRun.id, sourceExecutionId: null },
    historyCandidates: [{ revision: "1", replicaSetUid: "previous-rs-uid", image: detail.repair.replacementImage }],
  };
  return detail;
}

export function makeIncidentDetail(): IncidentDetailResponse {
  return {
    schemaVersion: 5,
    actions: {
      withdraw: "not_applicable",
      prepare: "not_applicable", refresh: "not_applicable", edit: "not_applicable",
      approve: "not_applicable", reject: "not_applicable", rerun: "active_run", rollback: "not_applicable",
      preparationSource: null, historyCandidates: [],
    },
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
      initiatedByYou: false,
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
  detail.actions = {
    ...detail.actions, prepare: "not_applicable", refresh: null, approve: null, reject: null,
    preparationSource: { sourceRunId: detail.selectedRun.id, sourceExecutionId: null },
  };
  return detail;
}

export function makeRollbackRecoveryDetail(outcome: "observing" | "recovered" | "monitoring_unavailable"): IncidentDetailResponse {
  const detail = makeRecoveryDetail(outcome);
  detail.selectedRun.operation = "rollback";
  detail.selectedRun.sourceRunId = RUN_ID;
  detail.selectedRun.error = null;
  detail.selectedRun.selection = null;
  detail.selectedRun.status = outcome === "observing" ? "RUNNING" : "COMPLETED";
  detail.incident.status = outcome === "observing" ? "VERIFYING" : "ROLLED_BACK";
  detail.repair!.sourceExecutionId = "9c010d34-e10c-4c4a-a29e-83c555a832bd";
  const repair = detail.repair!;
  [repair.currentImage, repair.replacementImage] = [repair.replacementImage, repair.currentImage];
  repair.diff.before = repair.currentImage;
  repair.diff.after = repair.replacementImage;
  repair.patch[3].value = repair.currentImage;
  repair.patch[4].value = repair.replacementImage;
  detail.repair!.evidenceIds = [detail.repair!.evidenceIds[0]];
  detail.evidence = detail.evidence.filter((item) => detail.repair!.evidenceIds.includes(item.id));
  detail.actions.rollback = "not_applicable";
  detail.actions.historyCandidates = [];
  detail.actions.preparationSource = { sourceRunId: RUN_ID, sourceExecutionId: detail.repair!.sourceExecutionId };
  return detail;
}

export function makeRecoveryDetail(outcome: "observing" | "recovered" | "monitoring_unavailable"): IncidentDetailResponse {
  const detail = makeRepairRunWaitingDetail();
  const appliedAt = "2026-09-14T01:00:02Z";
  const completedAt = outcome === "observing" ? null : "2026-09-14T01:01:02Z";
  detail.approval = {
    id: REPAIR_PROPOSAL_ID, runId: detail.selectedRun.id, proposalId: REPAIR_PROPOSAL_ID,
    proposalDigest: REPAIR_PROPOSAL_DIGEST, validationDigest: `sha256:${"a".repeat(64)}`,
    decision: "approve", actor: "sandbox-operator", decidedAt: "2026-09-14T01:00:00Z", expiresAt: "2026-09-14T01:15:00Z",
    execution: { id: REPAIR_PROPOSAL_ID, status: "APPLIED", startBefore: "2026-09-14T01:00:30Z", claimedAt: "2026-09-14T01:00:01Z", reportedAt: appliedAt,
      result: { outcome: "APPLIED", receipt: { uid: detail.repair!.targetUid, resourceVersion: "patched-rv", generation: 4, beforeGeneration: 3 }, error: null }, lateResult: null },
  };
  detail.verification = { executionId: REPAIR_PROPOSAL_ID, startedAt: appliedAt, deadlineAt: "2026-09-14T01:10:02Z", completedAt, outcome,
    reason: outcome === "monitoring_unavailable" ? "monitoring_unavailable" : null,
    sampleCount: outcome === "observing" ? 1 : 13,
    lastObservedAt: completedAt ?? appliedAt, healthySince: outcome === "monitoring_unavailable" ? null : appliedAt };
  detail.selectedRun.status = outcome === "observing" ? "RUNNING" : outcome === "recovered" ? "COMPLETED" : "FAILED";
  detail.selectedRun.completedAt = completedAt;
  detail.selectedRun.error = outcome === "monitoring_unavailable" ? { code: "verification_monitoring_unavailable", retryable: false } : null;
  detail.incident.status = outcome === "observing" ? "VERIFYING" : outcome === "recovered" ? "RESOLVED" : "FAILED";
  detail.actions = {
    ...detail.actions, refresh: "not_applicable", edit: "not_applicable", approve: "not_applicable", reject: "not_applicable",
    rerun: outcome === "observing" ? "execution_held" : null,
    rollback: outcome === "observing" ? "not_applicable" : null,
  };
  return detail;
}
