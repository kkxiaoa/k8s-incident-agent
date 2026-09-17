import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { OPERATOR_COOKIE, OPERATOR_CSRF_HEADER } from "../../src/lib/agent-runtime/operator-contracts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { components } from "../../src/lib/agent-runtime/generated";
import { makeIncidentDetail, makeRecoveryDetail, makeWaitingApprovalIncidentDetail } from "../../src/test/agent-runtime-fixtures";

type ScenarioResponse = components["schemas"]["ScenarioResponse"];
type IncidentDetailResponse =
  components["schemas"]["IncidentDetailResponse"];
type IncidentListItem = components["schemas"]["IncidentListItem"];
type RunEventStreamItem =
  components["schemas"]["RunEventStreamItem"];

type OutcomeMode =
  | "diagnosed"
  | "failed"
  | "insufficient"
  | "running"
  | "waiting";
type RuntimeMode = OutcomeMode | "unavailable" | "diagnosis-unavailable";

interface FakeIncident {
  detail: IncidentDetailResponse;
  events: RunEventStreamItem[];
  finished: boolean;
  metricState: "ok" | "monitoring_unavailable";
  metricAnchor?: string;
  mode: OutcomeMode;
  history?: IncidentDetailResponse[];
}

const lifecycleStreams = new Map<string, Set<ServerResponse>>();
let nextRepair = 100;

function publishLifecycle(record: FakeIncident, event: RunEventStreamItem) {
  record.events.push(event);
  record.detail.eventCursor = event.id;
  record.detail.eventPage.items.unshift(event);
  for (const response of lifecycleStreams.get(record.detail.incident.id) ?? []) response.write(serializeEvent(event));
}

function lifecycleBase(detail: IncidentDetailResponse) {
  return { schemaVersion: 5 as const, runKind: "repair" as const, incidentId: detail.incident.id,
    runId: detail.selectedRun.id, occurredAt: new Date().toISOString() };
}

function selectedFakeDetail(record: FakeIncident, runId: string | null): IncidentDetailResponse | undefined {
  const selected = runId === null || runId === record.detail.selectedRun.id ? record.detail : record.history?.find((item) => item.selectedRun.id === runId);
  if (!selected) return undefined;
  const detail = structuredClone(selected);
  detail.incident = structuredClone(record.detail.incident);
  detail.eventCursor = record.detail.eventCursor;
  const otherActive = selected !== record.detail && ["QUEUED", "RUNNING", "WAITING_APPROVAL"].includes(record.detail.selectedRun.status);
  const busy = record.detail.actions.rerun === "execution_held" ? "execution_held" : otherActive ? "active_run" : null;
  if (busy) {
    detail.actions.rerun = busy;
    for (const key of ["prepare", "refresh", "edit", "rollback"] as const) if (detail.actions[key] === null) detail.actions[key] = busy;
  }
  if (detail.selectedRun.status === "WAITING_APPROVAL" && detail.selectedRun.waitingExpiresAt
    && Date.parse(detail.selectedRun.waitingExpiresAt) <= Date.now()) detail.actions.approve = detail.actions.reject = "proposal_expired";
  return detail;
}

function prepareFakeRepair(record: FakeIncident, request: components["schemas"]["CreateRepairRunRequest"]): boolean {
  const source = [record.detail, ...(record.history ?? [])].find((item) => item.selectedRun.id === request.sourceRunId);
  if (!source?.repair || record.detail.actions.rerun === "execution_held") return false;
  const old = record.detail;
  if (old.selectedRun.status === "WAITING_APPROVAL") {
    if (request.replacesRunId !== old.selectedRun.id) return false;
    old.selectedRun.status = "COMPLETED";
    old.selectedRun.endReason = "superseded";
    old.selectedRun.completedAt = new Date().toISOString();
    old.actions.approve = old.actions.reject = "not_applicable";
    publishLifecycle(record, { id: eventId(), event: "repair.wait_ended", data: {
      ...lifecycleBase(old), reason: "superseded", incidentStatus: "DIAGNOSED", runStatus: "COMPLETED",
    } });
  } else if (["QUEUED", "RUNNING"].includes(old.selectedRun.status)) return false;
  const chosen = request.selection ? source.actions.historyCandidates.find((item) => item.revision === request.selection!.revision && item.replicaSetUid === request.selection!.replicaSetUid) : null;
  if (request.selection && !chosen) return false;
  record.history = [structuredClone(old), ...(record.history ?? [])];
  const detail = structuredClone(source);
  const sequence = nextRepair++;
  const now = new Date().toISOString();
  detail.selectedRun = { ...detail.selectedRun, id: uuid("2", sequence), kind: "repair", operation: request.sourceExecutionId ? "rollback" : "apply",
    attempt: old.selectedRun.attempt + 1, status: "WAITING_APPROVAL", sourceRunId: request.sourceRunId,
    requestSource: "operator", selection: request.selection ?? null, createdAt: now, startedAt: now, completedAt: null,
    error: null, endReason: null, waitingExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
  detail.incident.status = "WAITING_APPROVAL";
  detail.diagnosis = detail.approval = detail.verification = null;
  const repair = detail.repair!;
  repair.id = uuid("8", sequence);
  repair.digest = `sha256:${sequence.toString(16).padStart(64, "0")}`;
  repair.targetResourceVersion = `fresh-${sequence}`;
  repair.patch[1].value = repair.targetResourceVersion;
  repair.sourceExecutionId = request.sourceExecutionId ?? null;
  if (request.sourceExecutionId) {
    [repair.currentImage, repair.replacementImage] = [repair.replacementImage, repair.currentImage];
    repair.evidenceIds = [repair.evidenceIds[0]];
    detail.evidence = detail.evidence.filter((item) => repair.evidenceIds.includes(item.id));
  } else if (chosen) repair.replacementImage = chosen.image;
  repair.patch[3].value = repair.diff.before = repair.currentImage;
  repair.patch[4].value = repair.diff.after = repair.replacementImage;
  repair.schemaCheckedAt = repair.policyCheckedAt = repair.diffCheckedAt = now;
  repair.validation = { outcome: "passed", checkedAt: now, error: null };
  detail.actions = { ...detail.actions, prepare: "not_applicable", refresh: null, edit: request.sourceExecutionId ? "not_applicable" : null,
    approve: null, reject: null, rerun: null, rollback: "not_applicable",
    preparationSource: { sourceRunId: request.sourceExecutionId ? request.sourceRunId : detail.selectedRun.id, sourceExecutionId: request.sourceExecutionId ?? null },
    historyCandidates: request.sourceExecutionId ? [] : detail.actions.historyCandidates };
  detail.eventPage = { items: [], nextCursor: null };
  record.detail = detail;
  record.finished = true;
  publishLifecycle(record, { id: eventId(), event: "run.queued", data: { ...lifecycleBase(detail), attempt: detail.selectedRun.attempt, runStatus: "QUEUED" } });
  publishLifecycle(record, { id: eventId(), event: "repair.waiting_approval", data: { ...lifecycleBase(detail), proposalId: repair.id, proposalDigest: repair.digest, incidentStatus: "WAITING_APPROVAL", runStatus: "WAITING_APPROVAL" } });
  return true;
}

function decideFakeRepair(record: FakeIncident, request: components["schemas"]["ApprovalRequest"]): boolean {
  const detail = record.detail;
  const repair = detail.repair;
  if (!repair || request.runId !== detail.selectedRun.id || request.proposalId !== repair.id || request.proposalDigest !== repair.digest) return false;
  if (detail.approval) return detail.approval.decision === request.decision;
  if (selectedFakeDetail(record, null)!.actions[request.decision] !== null) return false;
  const now = new Date().toISOString();
  detail.approval = { id: uuid("7", nextRepair++), runId: request.runId, proposalId: request.proposalId,
    proposalDigest: request.proposalDigest, validationDigest: repair.digest, decision: request.decision, actor: "sandbox-operator",
    decidedAt: now, expiresAt: detail.selectedRun.waitingExpiresAt!, execution: request.decision === "approve" ? {
      id: uuid("6", nextRepair++), status: "PENDING", startBefore: new Date(Date.now() + 30_000).toISOString(),
      claimedAt: null, reportedAt: null, result: null, lateResult: null,
    } : null };
  detail.selectedRun.status = request.decision === "approve" ? "RUNNING" : "COMPLETED";
  detail.selectedRun.completedAt = request.decision === "approve" ? null : now;
  detail.selectedRun.endReason = request.decision === "reject" ? "rejected" : null;
  detail.incident.status = request.decision === "approve" ? "APPLYING" : "REJECTED";
  detail.actions = { ...detail.actions, approve: "not_applicable", reject: "not_applicable", edit: "not_applicable",
    refresh: request.decision === "approve" ? "not_applicable" : null, rerun: request.decision === "approve" ? "execution_held" : null };
  publishLifecycle(record, { id: eventId(), event: "repair.approval_decided", data: {
    ...lifecycleBase(detail), approvalId: detail.approval.id, proposalId: repair.id, proposalDigest: repair.digest,
    decision: request.decision, incidentStatus: detail.incident.status, runStatus: detail.selectedRun.status,
  } });
  return true;
}

const SCENARIO: ScenarioResponse = {
  scenarioId: "image-pull-backoff",
  scenarioVersion: 2,
  displayName: "镜像拉取失败",
  description: "调查 Pod 的 ImagePullBackOff，并保留 Kubernetes Evidence 引用。",
  target: {
    apiVersion: "apps/v1",
    kind: "Deployment",
    namespace: "k8s-incident-scenarios",
    name: "image-pull-backoff",
    cluster: "kind-k8s-incident-agent",
  },
  trigger: {
    type: "manual",
    summary: "Pod 无法拉取不存在的容器镜像。",
  },
};

const CREATED_AT = "2026-08-29T02:00:00Z";
const STARTED_AT = "2026-08-29T02:00:01Z";
const TOOL_AT = "2026-08-29T02:00:02Z";
const EVIDENCE_AT = "2026-08-29T02:00:03Z";
const TERMINAL_AT = "2026-08-29T02:00:04Z";
const ALERT_PENDING_AT = "2026-08-29T01:59:30Z";
const ALERT_STARTS_AT = "2026-08-29T02:00:00.000000000Z";
const ALERT_ENDS_AT = "2026-08-29T02:00:15.000000000Z";
const RESOLVED_QUERY_AT = "2026-08-29T02:00:16Z";

let checkOperatorPassword: ((password: string) => Promise<boolean>) | undefined;
let operatorOrigin = "";
const operatorSessions = new Map<string, components["schemas"]["OperatorSessionResponse"]>();
let accessMode: "private" | "public_demo" = "private";

type FakeRequester = { role: "operator"; key: string } | null;

function ownsFakeRun(run: IncidentDetailResponse["selectedRun"], requester: FakeRequester): boolean {
  return requester?.role === "operator" && run.requestSource === "operator";
}

function projectFakeRequester(detail: IncidentDetailResponse, requester: FakeRequester): IncidentDetailResponse {
  detail.selectedRun.initiatedByYou = ownsFakeRun(detail.selectedRun, requester);
  detail.actions.withdraw = detail.selectedRun.kind === "repair" && detail.selectedRun.status === "WAITING_APPROVAL"
    ? detail.selectedRun.initiatedByYou ? null : "not_owner" : "not_applicable";
  if (requester === null) {
    for (const action of ["prepare", "refresh", "edit", "approve", "reject", "rerun", "rollback", "withdraw"] as const)
      if (detail.actions[action] !== "not_applicable") detail.actions[action] = "authentication_required";
  }
  return detail;
}

function bindFakeRequester(record: FakeIncident, requester: FakeRequester) {
  record.detail.selectedRun.requestSource = requester?.role ?? "system";
}

let mode: RuntimeMode = "diagnosed";
let nextIncident = 1;
let nextEventId = 1;
let showcaseEnabled = false;
const incidents = new Map<string, FakeIncident>();
const eventConnections = new Map<string, Array<string | null>>();

const SHOWCASE_INCIDENTS: Array<{
  alertStatus: "FIRING" | "RESOLVED";
  displayName: string;
  outcome: OutcomeMode;
  sourceRef: string;
  targetName: string;
  metricState?: "ok" | "monitoring_unavailable";
}> = [
  {
    alertStatus: "FIRING",
    displayName: "容器反复重启",
    outcome: "running",
    sourceRef: "K8sIncidentCrashLoopBackOff",
    targetName: "checkout-api",
  },
  {
    alertStatus: "FIRING",
    displayName: "容器反复重启",
    outcome: "diagnosed",
    sourceRef: "K8sIncidentCrashLoopBackOff",
    targetName: "payment-worker",
  },
  {
    alertStatus: "FIRING",
    displayName: "容器反复重启",
    outcome: "diagnosed",
    sourceRef: "K8sIncidentCrashLoopBackOff",
    targetName: "notification-api",
  },
  {
    alertStatus: "FIRING",
    displayName: "镜像拉取失败",
    outcome: "running",
    sourceRef: "K8sIncidentImagePullBackOff",
    targetName: "catalog-api",
  },
  {
    alertStatus: "FIRING",
    displayName: "镜像拉取失败",
    outcome: "diagnosed",
    sourceRef: "K8sIncidentImagePullBackOff",
    targetName: "search-indexer",
  },
  {
    alertStatus: "FIRING",
    displayName: "Service 路由异常",
    outcome: "running",
    sourceRef: "K8sIncidentServiceEndpointsUnavailable",
    targetName: "orders-api",
  },
  {
    alertStatus: "FIRING",
    displayName: "Service 路由异常",
    outcome: "insufficient",
    sourceRef: "K8sIncidentServiceEndpointsUnavailable",
    targetName: "inventory-api",
  },
  {
    alertStatus: "FIRING",
    displayName: "健康检查失败",
    outcome: "running",
    sourceRef: "K8sIncidentProbeFailure",
    targetName: "session-api",
  },
  {
    alertStatus: "FIRING",
    displayName: "存储卷待绑定",
    outcome: "failed",
    sourceRef: "K8sIncidentPVCPending",
    targetName: "reporting-worker",
  },
  {
    alertStatus: "RESOLVED",
    displayName: "容器反复重启",
    outcome: "diagnosed",
    sourceRef: "K8sIncidentCrashLoopBackOff",
    targetName: "profile-api",
  },
  {
    alertStatus: "RESOLVED",
    displayName: "Service 路由异常",
    outcome: "diagnosed",
    sourceRef: "K8sIncidentServiceEndpointsUnavailable",
    targetName: "pricing-api",
  },
  {
    alertStatus: "RESOLVED",
    displayName: "镜像拉取失败",
    metricState: "monitoring_unavailable",
    outcome: "diagnosed",
    sourceRef: "K8sIncidentImagePullBackOff",
    targetName: "image-resizer",
  },
];

function uuid(prefix: string, sequence: number): string {
  return `${prefix}0000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function eventId(): string {
  const id = String(nextEventId);
  nextEventId += 1;
  return id;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

function runtimeError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  retryable: boolean,
): void {
  json(response, status, { error: { code, message, retryable } });
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function buildEvents(
  incidentId: string,
  runId: string,
  workloadEvidenceId: string,
  podsEvidenceId: string,
  diagnosisId: string,
  outcome: OutcomeMode,
): RunEventStreamItem[] {
  const events: RunEventStreamItem[] = [
    {
      id: eventId(),
      event: "incident.created",
      data: {
        schemaVersion: 5,
        incidentId,
        runId,
        attempt: 1,
        incidentStatus: "RECEIVED",
        runStatus: "QUEUED",
        runKind: "diagnosis",
        occurredAt: CREATED_AT,
      },
    },
    {
      id: eventId(),
      event: "run.started",
      data: {
        schemaVersion: 5,
        incidentId,
        runId,
        attempt: 1,
        incidentStatus: "TRIAGING",
        runStatus: "RUNNING",
        runKind: "diagnosis",
        occurredAt: STARTED_AT,
      },
    },
    {
      id: eventId(),
      event: "tool.started",
      data: {
        schemaVersion: 5,
        incidentId,
        runId,
        toolCallId: "tool-call-1",
        toolName: "get_workload",
        runKind: "diagnosis",
        occurredAt: TOOL_AT,
      },
    },
  ];

  if (outcome === "waiting") {
    return events.slice(0, 1);
  }

  if (outcome === "running") {
    return events;
  }

  if (outcome === "failed") {
    events.push(
      {
        id: eventId(),
        event: "tool.failed",
        data: {
          schemaVersion: 5,
          incidentId,
          runId,
          toolCallId: "tool-call-1",
          toolName: "get_workload",
          errorCode: "kubernetes_forbidden",
          retryable: false,
          runKind: "diagnosis",
          occurredAt: EVIDENCE_AT,
        },
      },
      {
        id: eventId(),
        event: "run.failed",
        data: {
          schemaVersion: 5,
          incidentId,
          runId,
          errorCode: "workflow_failed",
          incidentStatus: "FAILED",
          retryable: false,
          runStatus: "FAILED",
          runKind: "diagnosis",
          occurredAt: TERMINAL_AT,
        },
      },
    );
    return events;
  }

  events.push(
    {
      id: eventId(),
      event: "evidence.recorded",
      data: {
        schemaVersion: 5,
        incidentId,
        runId,
        evidenceId: workloadEvidenceId,
        evidenceKind: "workload",
        observedAt: EVIDENCE_AT,
        redacted: false,
        toolCallId: "tool-call-1",
        toolName: "get_workload",
        truncated: false,
        runKind: "diagnosis",
        occurredAt: EVIDENCE_AT,
      },
    },
    {
      id: eventId(),
      event: "tool.started",
      data: {
        schemaVersion: 5,
        incidentId,
        runId,
        toolCallId: "tool-call-2",
        toolName: "get_pods",
        runKind: "diagnosis",
        occurredAt: EVIDENCE_AT,
      },
    },
    {
      id: eventId(),
      event: "evidence.recorded",
      data: {
        schemaVersion: 5,
        incidentId,
        runId,
        evidenceId: podsEvidenceId,
        evidenceKind: "pods",
        observedAt: EVIDENCE_AT,
        redacted: false,
        toolCallId: "tool-call-2",
        toolName: "get_pods",
        truncated: false,
        runKind: "diagnosis",
        occurredAt: EVIDENCE_AT,
      },
    },
  );

  if (outcome === "diagnosed") {
    events.push({
      id: eventId(),
      event: "diagnosis.completed",
      data: {
        schemaVersion: 5,
        incidentId,
        runId,
        diagnosisId,
        incidentStatus: "DIAGNOSED",
        outcome: "diagnosed",
        runStatus: "COMPLETED",
        runKind: "diagnosis",
        occurredAt: TERMINAL_AT,
      },
    });
  } else {
    events.push({
      id: eventId(),
      event: "diagnosis.insufficient",
      data: {
        schemaVersion: 5,
        incidentId,
        runId,
        diagnosisId,
        incidentStatus: "INSUFFICIENT_EVIDENCE",
        outcome: "insufficient_evidence",
        runStatus: "COMPLETED",
        runKind: "diagnosis",
        occurredAt: TERMINAL_AT,
      },
    });
  }

  return events;
}

function createIncident(outcome: OutcomeMode): FakeIncident {
  const sequence = nextIncident;
  nextIncident += 1;
  const incidentId = uuid("1", sequence);
  const runId = uuid("2", sequence);
  const workloadEvidenceId = uuid("3", sequence);
  const podsEvidenceId = uuid("5", sequence);
  const diagnosisId = uuid("4", sequence);
  const events = buildEvents(
    incidentId,
    runId,
    workloadEvidenceId,
    podsEvidenceId,
    diagnosisId,
    outcome,
  );
  const initialEvent = events[0];

  return {
    mode: outcome,
    metricState: "ok",
    finished: false,
    events,
    detail: {
      schemaVersion: 5,
      actions: makeIncidentDetail().actions,
      incident: {
        id: incidentId,
        source: {
          type: "scenario",
          ref: SCENARIO.scenarioId,
          revision: String(SCENARIO.scenarioVersion),
        },
        displayName: SCENARIO.displayName,
        triggerSummary: SCENARIO.trigger.summary,
        status: "RECEIVED",
        target: SCENARIO.target,
        createdAt: CREATED_AT,
      },
      selectedRun: {
        initiatedByYou: false,
        kind: "diagnosis",
        operation: null,
        id: runId,
        attempt: 1,
        status: "QUEUED",
        error: null,
        createdAt: CREATED_AT,
        startedAt: null,
        completedAt: null,
      },
      eventPage: {
        items: outcome === "waiting" ? [] : [initialEvent],
        nextCursor: null,
      },
      eventCursor: initialEvent.id,
      evidence: [],
      diagnosis: null,
      repair: null,
      verification: null,
      alertSignal: null,
    },
  };
}

function applyEvent(record: FakeIncident, event: RunEventStreamItem): void {
  record.detail.eventCursor = event.id;
  if (!record.detail.eventPage.items.some((item) => item.id === event.id)) {
    record.detail.eventPage.items.unshift(event);
  }

  switch (event.event) {
    case "incident.created":
    case "run.queued":
      break;
    case "run.started":
      record.detail.incident.status = "TRIAGING";
      record.detail.selectedRun.status = "RUNNING";
      record.detail.selectedRun.startedAt = event.data.occurredAt;
      break;
    case "tool.started":
    case "tool.failed":
    case "alert.resolved":
      break;
    case "evidence.recorded":
      if (!record.detail.evidence.some((item) => item.id === event.data.evidenceId)) {
        const target = record.detail.incident.target;
        const workloadPayload = {
          workload: {
            resourceVersion: "101",
            generation: 1,
            observedGeneration: 1,
            replicas: { desired: 3, updated: 3, ready: 0, available: 0 },
            selector: { matchLabels: { app: target.name } },
            containers: [
              {
                name: "app",
                image: "example.invalid/missing:v1",
                imagePullPolicy: "IfNotPresent",
                command: [],
                args: [],
              },
            ],
            conditions: [],
          },
        };
        const podsPayload = {
          sourceWorkload: {
            resourceVersion: "101",
            selector: { matchLabels: { app: target.name } },
          },
          pods: Array.from({ length: 3 }, (_, index) => ({
            apiVersion: "v1",
            kind: "Pod",
            namespace: target.namespace,
            name: `${target.name}-${index + 1}`,
            uid: `showcase-pod-${index + 1}`,
            resourceVersion: String(201 + index),
            owner: {
              apiVersion: "apps/v1",
              kind: "ReplicaSet",
              name: `${target.name}-rs`,
              uid: "showcase-replicaset",
              controller: true,
            },
            phase: "Pending",
            conditions: [],
            containers: [
              {
                name: "app",
                image: "example.invalid/missing:v1",
                imageId: null,
                restartCount: 0,
                state: {
                  status: "waiting",
                  reason: index === 0 ? "ErrImagePull" : "ImagePullBackOff",
                  message: "manifest unknown",
                },
              },
            ],
          })),
        };
        record.detail.evidence.push({
          id: event.data.evidenceId,
          toolCallId: event.data.toolCallId,
          toolName: event.data.toolName,
          evidenceKind: event.data.evidenceKind,
          targetRef: record.detail.incident.target,
          observedAt: event.data.observedAt,
          payload:
            event.data.evidenceKind === "workload"
              ? workloadPayload
              : podsPayload,
          truncated: event.data.truncated,
          redacted: event.data.redacted,
        });
      }
      break;
    case "diagnosis.completed":
      record.detail.incident.status = "DIAGNOSED";
      record.detail.selectedRun.status = event.data.runStatus;
      record.detail.selectedRun.completedAt =
        event.data.runStatus === "COMPLETED" ? event.data.occurredAt : null;
      record.detail.diagnosis = {
        id: event.data.diagnosisId,
        outcome: "diagnosed",
        summary: "Pod 引用的镜像 manifest 不存在，导致 ImagePullBackOff。",
        rootCauses: [
          {
            code: "image_manifest_not_found",
            statement: "工作负载引用了仓库中不存在的镜像 manifest。",
            confidence: "high",
            evidenceIds: record.detail.evidence.map((item) => item.id),
          },
        ],
        missingInformation: [],
        redacted: false,
        createdAt: event.data.occurredAt,
      };
      record.finished = event.data.runStatus === "COMPLETED";
      break;
    case "repair.patch_ready":
      record.detail.incident.status = "PATCH_READY";
      record.detail.selectedRun.status = "RUNNING";
      break;
    case "repair.dry_run_passed":
      record.detail.incident.status = "DRY_RUN_PASSED";
      record.detail.selectedRun.status = "RUNNING";
      break;
    case "repair.waiting_approval":
      record.detail.incident.status = "WAITING_APPROVAL";
      record.detail.selectedRun.status = event.data.runStatus;
      record.detail.selectedRun.completedAt = event.data.runStatus === "COMPLETED" ? event.data.occurredAt : null;
      record.finished = event.data.runStatus === "COMPLETED";
      break;
    case "repair.wait_ended":
      record.detail.incident.status = "DIAGNOSED";
      record.detail.selectedRun.status = "COMPLETED";
      record.detail.selectedRun.completedAt = event.data.occurredAt;
      record.detail.selectedRun.endReason = event.data.reason;
      record.finished = true;
      break;
    case "diagnosis.insufficient":
      record.detail.incident.status = "INSUFFICIENT_EVIDENCE";
      record.detail.selectedRun.status = "COMPLETED";
      record.detail.selectedRun.completedAt = event.data.occurredAt;
      record.detail.diagnosis = {
        id: event.data.diagnosisId,
        outcome: "insufficient_evidence",
        summary: "现有 Kubernetes 证据不足以确认镜像仓库端失败原因。",
        rootCauses: [],
        missingInformation: ["镜像仓库端的拉取审计记录"],
        redacted: true,
        createdAt: event.data.occurredAt,
      };
      record.finished = true;
      break;
    case "run.failed":
      record.detail.incident.status = event.data.incidentStatus;
      record.detail.selectedRun.status = "FAILED";
      record.detail.selectedRun.completedAt = event.data.occurredAt;
      record.detail.selectedRun.error = {
        code: event.data.errorCode,
        retryable: event.data.retryable,
      };
      record.finished = true;
      break;
  }
}

function seedShowcase(): void {
  mode = "diagnosed";
  nextIncident = 1;
  nextEventId = 1;
  showcaseEnabled = true;
  incidents.clear();
  eventConnections.clear();

  for (const definition of SHOWCASE_INCIDENTS) {
    const record = createIncident(definition.outcome);
    record.metricState = definition.metricState ?? "ok";
    record.detail.incident.source = {
      type: "alertmanager",
      ref: definition.sourceRef,
      revision: "showcase-v1",
    };
    record.detail.incident.displayName = definition.displayName;
    record.detail.incident.triggerSummary = `${definition.displayName}测试告警。`;
    record.detail.incident.target =
      definition.sourceRef === "K8sIncidentServiceEndpointsUnavailable"
        ? {
            ...record.detail.incident.target,
            apiVersion: "v1",
            kind: "Service",
            name: definition.targetName,
          }
        : {
            ...record.detail.incident.target,
            name: definition.targetName,
          };
    record.detail.alertSignal = {
      status: definition.alertStatus,
      startsAt: ALERT_STARTS_AT,
      endsAt: definition.alertStatus === "RESOLVED" ? ALERT_ENDS_AT : null,
    };

    for (const event of record.events) {
      applyEvent(record, event);
    }
    incidents.set(record.detail.incident.id, record);
  }
}

function serializeEvent(event: RunEventStreamItem): string {
  return `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  incidentId: string,
  record: FakeIncident,
): void {
  const rawLastEventId = request.headers["last-event-id"];
  const lastEventId = typeof rawLastEventId === "string" ? rawLastEventId : null;
  const connections = eventConnections.get(incidentId) ?? [];
  connections.push(lastEventId);
  eventConnections.set(incidentId, connections);

  const lastId = lastEventId === null ? BigInt(0) : BigInt(lastEventId);
  const pending = record.events.filter((event) => BigInt(event.id) > lastId);
  const disconnectForReconnect =
    record.mode === "diagnosed" && connections.length === 1 && !record.finished;
  const batch = disconnectForReconnect ? pending.slice(0, 3) : pending;
  const replay = record.finished;

  response.writeHead(200, {
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  response.flushHeaders();
  response.write(": heartbeat\n\n");
  const streams = lifecycleStreams.get(incidentId) ?? new Set<ServerResponse>();
  streams.add(response);
  lifecycleStreams.set(incidentId, streams);
  response.once("close", () => streams.delete(response));

  for (const event of batch) {
    if (!replay) {
      applyEvent(record, event);
    }
    response.write(serializeEvent(event));
  }
  if (record.mode === "running" || record.mode === "waiting") {
    return;
  }
  if (disconnectForReconnect) {
    response.end();
  }
}

function listItem(record: FakeIncident): IncidentListItem {
  const { incident } = record.detail;
  return {
    id: incident.id,
    displayName: incident.displayName,
    target: incident.target,
    status: incident.status,
    updatedAt:
      record.detail.selectedRun.completedAt ??
      record.detail.selectedRun.startedAt ??
      incident.createdAt,
  };
}

function monitoringOverview() {
  const generatedAt = new Date(Math.max(Date.parse(TERMINAL_AT), ...[...incidents.values()].map((record) => Date.parse(record.metricAnchor ?? TERMINAL_AT))));
  const currentHour = new Date(generatedAt);
  currentHour.setUTCMinutes(0, 0, 0);
  const showcaseCreated = new Map([
    [1, 1],
    [4, 2],
    [6, 1],
    [9, 1],
    [11, 2],
    [14, 1],
    [17, 1],
    [19, 1],
    [21, 1],
    [23, 1],
  ]);
  const showcaseResolved = new Set([8, 16, 22]);
  const samples = Array.from({ length: 24 }, (_, index) => {
    const timestamp = new Date(
      currentHour.valueOf() - (23 - index) * 3_600_000,
    );
    return {
      timestamp: timestamp.toISOString(),
      incidentsCreated: showcaseEnabled
        ? (showcaseCreated.get(index) ?? 0)
        : index === 23
          ? incidents.size
          : 0,
      alertConditionsResolved:
        showcaseEnabled && showcaseResolved.has(index) ? 1 : 0,
    };
  });
  const records = [...incidents.values()];
  const firingRecords = records.filter(
    (record) => record.detail.alertSignal?.status === "FIRING",
  );
  const families = new Map<string, { displayName: string; count: number }>();
  for (const record of firingRecords) {
    const sourceRef = record.detail.incident.source.ref;
    const current = families.get(sourceRef);
    families.set(sourceRef, {
      displayName: record.detail.incident.displayName,
      count: (current?.count ?? 0) + 1,
    });
  }
  return {
    schemaVersion: 2,
    window: "24h",
    generatedAt: generatedAt.toISOString(),
    counts: {
      totalIncidents: records.length,
      firingAlerts: firingRecords.length,
      triagingIncidents: records.filter(
        (record) => record.detail.incident.status === "TRIAGING",
      ).length,
      waitingApprovalIncidents: records.filter(
        (record) => record.detail.incident.status === "WAITING_APPROVAL",
      ).length,
    },
    families: [...families].map(([sourceRef, family]) => ({
      sourceRef,
      ...family,
    })),
    samples,
  };
}

function metricMarkers(record: FakeIncident) {
  const markers: Array<{
    kind:
      | "alert_firing"
      | "alert_resolved"
      | "run_started"
      | "run_completed";
    occurredAt: string;
    runAttempt: number | null;
  }> = [];
  const alertSignal = record.detail.alertSignal;
  if (alertSignal !== null) {
    markers.push({
      kind: "alert_firing",
      occurredAt: alertSignal.startsAt,
      runAttempt: null,
    });
  }
  if (record.detail.selectedRun.startedAt !== null) {
    markers.push({
      kind: "run_started",
      occurredAt: record.detail.selectedRun.startedAt,
      runAttempt: record.detail.selectedRun.attempt,
    });
  }
  if (record.detail.selectedRun.completedAt !== null) {
    markers.push({
      kind: "run_completed",
      occurredAt: record.detail.selectedRun.completedAt,
      runAttempt: record.detail.selectedRun.attempt,
    });
  }
  if (alertSignal?.endsAt !== null && alertSignal?.endsAt !== undefined) {
    markers.push({
      kind: "alert_resolved",
      occurredAt: alertSignal.endsAt,
      runAttempt: null,
    });
  }
  return markers;
}

const CONTEXT_PANELS = [
  { panelId: "container-cpu-cores", title: "容器 CPU 用量与限额", unit: "cores", seriesBinding: "pod_container", riskDirection: "neutral",
    purpose: "每个容器每个采样区间（至少 2 分钟）的平均 CPU 核数（usage）与 limit；无 limit 序列即未配置。每个容器 2 条序列，最多展示 4 个容器，超出为部分数据。" },
  { panelId: "container-memory-working-set-bytes", title: "容器内存工作集与限额", unit: "bytes", seriesBinding: "pod_container", riskDirection: "neutral",
    purpose: "每个容器的内存工作集（usage）与 limit；接近 limit 是压力而非已 OOM，无 limit 序列即未配置。每个容器 2 条序列，最多展示 4 个容器，超出为部分数据。" },
  { panelId: "container-cpu-throttled-ratio", title: "容器 CPU 限流周期比例", unit: "ratio", seriesBinding: "pod_container", riskDirection: "neutral",
    purpose: "每个容器每个采样区间（至少 2 分钟）被 CFS 限流的调度周期占比，不是耗时比例；无序列表示未配置 CPU limit，不能当作 0。" },
  { panelId: "container-probe-failures", title: "容器探针失败次数", unit: "probes", seriesBinding: "pod_container", riskDirection: "neutral",
    purpose: "每个容器每个采样区间（至少 5 分钟）非成功的探针次数，按探针类型拆分；启动期失败可能正常。" },
  { panelId: "container-last-terminated-reason", title: "容器最近一次终止原因", unit: "containers", seriesBinding: "pod_container", riskDirection: "neutral",
    purpose: "每个容器最近一次终止原因的快照（1 = 当时的最近原因），不是终止事件记录。" },
  { panelId: "pod-unschedulable", title: "未调度 Pod", unit: "pods", seriesBinding: "pod", riskDirection: "higher_is_worse",
    purpose: "每个 Pod 是否被调度器判为无法调度（1 = 是），不是节点容量审计。" },
] as const;

const CONTEXT_POINTS = 60;
const POD_A = { pod: "checkout-7c9d8f6b5-x2k4p", uid: "0f6c1e52-8a41-4a0e-9d3b-5b1f7a2c9e10" };
const POD_B = { pod: "checkout-7c9d8f6b5-m8q7z", uid: "9b2d4f80-3c17-4e6a-b5a2-1d8e6f4c7a21" };

function contextSeries(panelId: string, start: number, end: number) {
  const at = (index: number) => start + ((end - start) * index) / CONTEXT_POINTS;
  const line = (labels: Record<string, string>, value: (progress: number) => number, from = 0) => ({
    labels,
    samples: Array.from({ length: CONTEXT_POINTS + 1 - from }, (_, offset) => {
      const index = from + offset;
      return { timestamp: new Date(at(index)).toISOString(), value: Number(value(index / CONTEXT_POINTS).toFixed(4)) };
    }),
  });
  const app = { ...POD_A, container: "app" };
  const appB = { ...POD_B, container: "app" };
  const sidecar = { ...POD_A, container: "sidecar" };
  const wave = (progress: number) => Math.sin(progress * Math.PI * 6) * 0.04;
  if (panelId === "container-cpu-cores") {
    return [
      line({ ...app, series: "usage" }, (t) => Math.min(0.5, 0.12 + t * 0.45 + wave(t))),
      line({ ...app, series: "limit" }, () => 0.5),
      line({ ...appB, series: "usage" }, (t) => 0.1 + t * 0.12 + wave(t)),
      line({ ...appB, series: "limit" }, () => 0.5),
      line({ ...sidecar, series: "usage" }, (t) => 0.02 + Math.abs(wave(t)) / 2),
    ];
  }
  if (panelId === "container-memory-working-set-bytes") {
    const MiB = 1024 * 1024;
    return [
      line({ ...app, series: "usage" }, (t) => Math.round((96 + t * 150) * MiB)),
      line({ ...app, series: "limit" }, () => 256 * MiB),
      line({ ...appB, series: "usage" }, (t) => Math.round((90 + t * 20 + wave(t) * 100) * MiB)),
      line({ ...appB, series: "limit" }, () => 256 * MiB),
      line({ ...sidecar, series: "usage" }, () => 24 * MiB),
    ];
  }
  if (panelId === "container-cpu-throttled-ratio") {
    return [
      line({ ...app, series: "throttled_ratio" }, (t) => Math.max(0, Math.min(0.85, (t - 0.35) * 1.4))),
      line({ ...appB, series: "throttled_ratio" }, (t) => Math.max(0, wave(t))),
    ];
  }
  if (panelId === "container-probe-failures") {
    return [
      line({ ...app, series: "Readiness" }, (t) => (t > 0.5 ? Math.round((t - 0.5) * 24) : 0)),
      line({ ...app, series: "Liveness" }, (t) => (t > 0.75 ? Math.round((t - 0.75) * 12) : 0)),
      line({ ...appB, series: "Readiness" }, () => 0),
    ];
  }
  if (panelId === "container-last-terminated-reason") {
    return [
      line({ ...app, series: "Error" }, (t) => (t < 0.7 ? 1 : 0), 10),
      line({ ...app, series: "OOMKilled" }, () => 1, Math.round(CONTEXT_POINTS * 0.7)),
      line({ ...appB, series: "Completed" }, () => 1, 25),
    ];
  }
  return [
    line({ ...POD_A }, () => 0),
    line({ ...POD_B }, (t) => (t > 0.6 ? 1 : 0)),
  ];
}

function metricPanelReferences(record: FakeIncident) {
  return record.detail.incident.source.ref ===
    "K8sIncidentServiceEndpointsUnavailable"
    ? [
        {
          panelId: "service-ready-endpoints",
          title: "Service 就绪 Endpoint",
          unit: "endpoints",
          purpose: "就绪 Endpoint 数；0 表示没有后端可接流量，不证明网络连通性。",
          seriesBinding: "target",
          recommendedWindow: "15m",
          riskDirection: "lower_is_worse",
          signalRole: "trigger",
          thresholdDuration: "30s",
        },
      ]
    : [
        {
          panelId: "image-pull-affected-pods",
          title: "镜像拉取失败 Pod",
          unit: "pods",
          purpose: "因镜像拉取失败而等待的 Pod 数，衡量影响范围，不说明失败原因。",
          seriesBinding: "target",
          recommendedWindow: "15m",
          riskDirection: "higher_is_worse",
          signalRole: "trigger",
          thresholdDuration: "30s",
        },
        {
          panelId: "image-pull-available-replicas",
          title: "Deployment 可用副本",
          unit: "replicas",
          purpose: "当前可用副本数，与期望副本对照看容量缺口。",
          seriesBinding: "target",
          recommendedWindow: "15m",
          riskDirection: "lower_is_worse",
          signalRole: "context",
          thresholdDuration: "5m",
        },
        ...CONTEXT_PANELS.map((panel) => ({
          ...panel,
          recommendedWindow: "15m",
          signalRole: "context",
          thresholdDuration: null,
        })),
      ];
}

function metricWindowMilliseconds(window: string): number {
  if (window === "15m") {
    return 15 * 60_000;
  }
  if (window === "1h") {
    return 60 * 60_000;
  }
  if (window === "6h") {
    return 6 * 60 * 60_000;
  }
  if (window === "7d") {
    return 7 * 24 * 60 * 60_000;
  }
  return 15 * 24 * 60 * 60_000;
}

function metricPanel(
  record: FakeIncident,
  panelId: string,
  window: string,
  anchor: string,
) {
  const serviceEndpoints = panelId === "service-ready-endpoints";
  const affectedPods = panelId === "image-pull-affected-pods";
  const alertResolved = record.detail.alertSignal?.status === "RESOLVED";
  const recovered = alertResolved || record.detail.verification?.outcome === "recovered";
  const observing = record.detail.verification?.outcome === "observing";
  const affectedPodCount = recovered ? 0 : observing ? 1 : 3;
  const availableReplicas = recovered ? 3 : observing ? 2 : 0;
  const readyEndpoints = alertResolved ? 2 : 0;
  const windowDuration = metricWindowMilliseconds(window);
  const markers = metricMarkers(record);
  const queriedAt = Math.max(Date.parse(record.metricAnchor ?? (alertResolved ? RESOLVED_QUERY_AT : TERMINAL_AT)),
    ...markers.map((marker) => Date.parse(marker.occurredAt)));
  const queriedAtTimestamp = new Date(queriedAt).toISOString();
  const windowStartsAt = queriedAt - windowDuration;
  const healthyValue = affectedPods ? 0 : serviceEndpoints ? 2 : 3;
  const failingValue = affectedPods
    ? affectedPodCount
    : serviceEndpoints
      ? readyEndpoints
      : availableReplicas;
  const alertSignal = record.detail.alertSignal;
  const samplesByTimestamp = new Map<number, number>();
  const addSample = (timestamp: number, value: number) => {
    if (timestamp >= windowStartsAt && timestamp <= queriedAt) {
      samplesByTimestamp.set(timestamp, value);
    }
  };

  addSample(windowStartsAt, healthyValue);
  if (alertSignal === null) {
    const incidentCreatedAt = Date.parse(record.detail.incident.createdAt);
    addSample(incidentCreatedAt - 15_000, healthyValue);
    addSample(incidentCreatedAt, affectedPods ? 3 : 0);
    const verification = record.detail.verification;
    if (verification) {
      addSample(Date.parse(verification.startedAt), affectedPods ? 3 : 0);
      addSample(Date.parse(verification.healthySince ?? verification.lastObservedAt ?? verification.startedAt), failingValue);
    }
  } else {
    const pendingAt = Date.parse(ALERT_PENDING_AT);
    const firingAt = Date.parse(alertSignal.startsAt);
    addSample(pendingAt - 5 * 60_000, healthyValue);
    addSample(pendingAt - 15_000, healthyValue);
    addSample(
      pendingAt,
      affectedPods ? 1 : 2,
    );
    addSample(
      pendingAt + 15_000,
      affectedPods ? 2 : 1,
    );
    addSample(firingAt, affectedPods ? 3 : 0);
    addSample(Date.parse(TERMINAL_AT), affectedPods ? 3 : 0);
    if (alertResolved) {
      addSample(Date.parse(ALERT_ENDS_AT), healthyValue);
    }
  }
  addSample(queriedAt, failingValue);
  const samples = [...samplesByTimestamp]
    .sort(([left], [right]) => left - right)
    .map(([timestamp, value]) => ({
      timestamp: new Date(timestamp).toISOString(),
      value,
    }));

  const unavailable = record.metricState === "monitoring_unavailable";
  const contextPanel = CONTEXT_PANELS.find((panel) => panel.panelId === panelId);
  if (contextPanel !== undefined) {
    return {
      schemaVersion: 2,
      result: {
        panelId,
        title: contextPanel.title,
        unit: contextPanel.unit,
        purpose: contextPanel.purpose,
        threshold: contextPanel.riskDirection === "higher_is_worse" ? 1 : null,
        riskDirection: contextPanel.riskDirection,
        seriesBinding: contextPanel.seriesBinding,
        window,
        anchor,
        state: record.metricState,
        queriedAt: queriedAtTimestamp,
        rangeStart: new Date(windowStartsAt).toISOString(),
        rangeEnd: queriedAtTimestamp,
        latestSampleAt: unavailable ? null : queriedAtTimestamp,
        currentValue: null,
        series: unavailable ? [] : contextSeries(panelId, windowStartsAt, queriedAt),
      },
      markers: markers.filter((marker) => Date.parse(marker.occurredAt) >= windowStartsAt && Date.parse(marker.occurredAt) <= queriedAt)
        .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt)),
      markersTruncated: false,
    };
  }
  return {
    schemaVersion: 2,
    result: {
      panelId,
      title:
        affectedPods
          ? "镜像拉取失败 Pod"
          : serviceEndpoints
            ? "Service 就绪 Endpoint"
            : "Deployment 可用副本",
      unit: affectedPods ? "pods" : serviceEndpoints ? "endpoints" : "replicas",
      purpose: affectedPods
        ? "因镜像拉取失败而等待的 Pod 数，衡量影响范围，不说明失败原因。"
        : serviceEndpoints
          ? "就绪 Endpoint 数；0 表示没有后端可接流量，不证明网络连通性。"
          : "当前可用副本数，与期望副本对照看容量缺口。",
      threshold: affectedPods || serviceEndpoints ? 1 : null,
      riskDirection: affectedPods ? "higher_is_worse" : "lower_is_worse",
      seriesBinding: "target",
      window,
      anchor,
      state: record.metricState,
      queriedAt: queriedAtTimestamp,
      rangeStart: new Date(windowStartsAt).toISOString(),
      rangeEnd: queriedAtTimestamp,
      latestSampleAt: unavailable ? null : queriedAtTimestamp,
      currentValue: unavailable ? null : failingValue,
      series: unavailable ? [] : [{ labels: {}, samples }],
    },
    markers: markers.filter((marker) => Date.parse(marker.occurredAt) >= windowStartsAt && Date.parse(marker.occurredAt) <= queriedAt)
      .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt)),
    markersTruncated: false,
  };
}

function repairFixture(outcome = "passed"): FakeIncident {
  const detail = makeWaitingApprovalIncidentDetail();
  const repair = detail.repair!;
  detail.incident.target = SCENARIO.target;
  repair.target = SCENARIO.target;
  detail.incident.source = { type: "scenario", ref: SCENARIO.scenarioId, revision: "3" };
  detail.incident.displayName = SCENARIO.displayName;
  detail.evidence[0].targetRef = { api_version: "apps/v1", kind: "Deployment", namespace: SCENARIO.target.namespace, name: SCENARIO.target.name, uid: repair.targetUid };
  detail.evidence[1].targetRef = detail.evidence[0].targetRef;
  detail.evidence[0].payload = { workload: { resource_version: repair.targetResourceVersion, replicas: { desired: 3, available: 0, ready: 0 }, containers: [{ name: repair.containerName, image: repair.currentImage, source_index: repair.containerIndex }] } };
  detail.evidence[1].payload = { source_workload: { resource_version: repair.targetResourceVersion }, revisions: [
    { revision: 2, containers: [{ name: repair.containerName, image: repair.currentImage }] },
    { revision: 1, containers: [{ name: repair.containerName, image: repair.replacementImage }] },
  ] };
  const base = { schemaVersion: 5 as const, runKind: "diagnosis" as const, incidentId: detail.incident.id, runId: detail.selectedRun.id };
  const events: RunEventStreamItem[] = [{
    id: eventId(), event: "diagnosis.completed", data: { ...base, diagnosisId: detail.diagnosis!.id, outcome: "diagnosed", incidentStatus: "DIAGNOSED", runStatus: "RUNNING", occurredAt: repair.schemaCheckedAt },
  }, {
    id: eventId(), event: "repair.patch_ready", data: { ...base, proposalId: repair.id, proposalDigest: repair.digest, incidentStatus: "PATCH_READY", runStatus: "RUNNING", occurredAt: repair.diffCheckedAt },
  }];
  if (["repair_schema_invalid", "repair_policy_denied", "repair_diff_invalid"].includes(outcome ?? "")) {
    const code = outcome!;
    detail.repair = null;
    detail.incident.status = "FAILED";
    detail.selectedRun.status = "FAILED";
    detail.selectedRun.error = { code, retryable: false };
    if (code === "repair_schema_invalid") {
      detail.diagnosis = null;
      events.length = 0;
    } else {
      events.splice(1);
    }
    events.push({ id: eventId(), event: "run.failed", data: { ...base, errorCode: code, retryable: false, incidentStatus: "FAILED", runStatus: "FAILED", occurredAt: detail.selectedRun.completedAt! } });
  } else if (outcome === "stale") {
    detail.incident.status = "STALE_RESOURCE";
    detail.selectedRun.status = "FAILED";
    detail.selectedRun.error = { code: "stale_resource", retryable: false };
    repair.validation = { ...repair.validation, outcome: "failed", error: { code: "stale_resource", retryable: false } };
    events.push({ id: eventId(), event: "run.failed", data: { ...base, errorCode: "stale_resource", retryable: false, incidentStatus: "STALE_RESOURCE", runStatus: "FAILED", occurredAt: detail.selectedRun.completedAt! } });
  } else {
    events.push({ id: eventId(), event: "repair.dry_run_passed", data: { ...base, proposalId: repair.id, proposalDigest: repair.digest, incidentStatus: "DRY_RUN_PASSED", runStatus: "RUNNING", occurredAt: repair.validation.checkedAt } },
      { id: eventId(), event: "repair.waiting_approval", data: { ...base, proposalId: repair.id, proposalDigest: repair.digest, incidentStatus: "WAITING_APPROVAL", runStatus: "COMPLETED", occurredAt: detail.selectedRun.completedAt! } });
  }
  if (outcome === "invalid") repair.patch[4].path = "/spec/replicas";
  detail.eventCursor = events.at(-1)!.id;
  detail.eventPage = { items: [...events].reverse(), nextCursor: null };
  if (detail.repair === null) {
    detail.actions.prepare = detail.actions.edit = "not_applicable";
    detail.actions.preparationSource = null;
    detail.actions.historyCandidates = [];
  }
  return { detail, events, finished: true, metricState: "ok", mode: "diagnosed" };
}

export function seedManualRepairShowcase(): number {
  if (incidents.size !== 0) throw new Error("Manual showcase requires an empty fake Runtime");
  const cases = [
    ["T10 · 诊断建议 → 准备修复", "diagnosis"],
    ["T10 · 待审批 / 历史镜像 / 刷新", "waiting"],
    ["T10 · 已拒绝，可重新准备", "rejected"],
    ["T10 · 提案过期，可重新准备", "expired"],
    ["T7 · 已批准，等待领取", "pending"],
    ["T7 · 已领取，等待写入结果", "claimed"],
    ["T7 · UNKNOWN，禁止重试", "unknown"],
    ["T8 · 写入已确认，恢复观察中", "observing"],
    ["T8 · 工作负载与告警恢复成功", "recovered"],
    ["T8 · 监控不可用，不能证明恢复", "monitoring_unavailable"],
    ["T9 · 回滚提案，必须另行批准", "rollback-waiting"],
    ["T9 · 已回滚，恢复已验证", "rollback-recovered"],
    ["T9 · 已回滚，但恢复无法证明", "rollback-monitoring_unavailable"],
    ["T9 · 回滚结果 UNKNOWN，保持占用", "rollback-unknown"],
  ] as const;
  const now = new Date().toISOString();
  const approve = (record: FakeIncident, decision: "approve" | "reject" = "approve") => {
    const detail = record.detail;
    if (!decideFakeRepair(record, { runId: detail.selectedRun.id, proposalId: detail.repair!.id,
      proposalDigest: detail.repair!.digest, decision })) throw new Error("Invalid manual approval fixture");
  };
  const recover = (record: FakeIncident, outcome: "observing" | "recovered" | "monitoring_unavailable") => {
    const detail = record.detail;
    const observed = makeRecoveryDetail(outcome);
    const execution = detail.approval!.execution!;
    const startedAt = new Date(Date.parse(now) - (outcome === "observing" ? 0 : 60_000)).toISOString();
    detail.approval!.decidedAt = new Date(Date.parse(startedAt) - 2000).toISOString();
    detail.repair!.validation.checkedAt = new Date(Date.parse(startedAt) - 3000).toISOString();
    detail.repair!.schemaCheckedAt = detail.repair!.policyCheckedAt = detail.repair!.diffCheckedAt = detail.repair!.validation.checkedAt;
    detail.selectedRun.createdAt = detail.selectedRun.startedAt = new Date(Date.parse(startedAt) - 4000).toISOString();
    Object.assign(execution, observed.approval!.execution, { id: execution.id,
      claimedAt: new Date(Date.parse(startedAt) - 1000).toISOString(), reportedAt: startedAt,
      startBefore: new Date(Date.parse(startedAt) + 28_000).toISOString() });
    execution.result!.receipt!.uid = detail.repair!.targetUid;
    detail.verification = { ...observed.verification!, executionId: execution.id, startedAt,
      deadlineAt: new Date(Date.parse(startedAt) + 600_000).toISOString(), lastObservedAt: now,
      healthySince: outcome === "recovered" ? startedAt : null, completedAt: outcome === "observing" ? null : now };
    detail.selectedRun.status = outcome === "observing" ? "RUNNING"
      : detail.selectedRun.operation === "rollback" ? "COMPLETED" : observed.selectedRun.status;
    detail.selectedRun.completedAt = outcome === "observing" ? null : now;
    detail.selectedRun.error = detail.selectedRun.operation === "rollback" ? null : observed.selectedRun.error;
    detail.incident.status = outcome === "observing" ? "VERIFYING"
      : detail.selectedRun.operation === "rollback" ? "ROLLED_BACK" : outcome === "recovered" ? "RESOLVED" : "FAILED";
    detail.actions.rerun = outcome === "observing" ? "execution_held" : null;
    detail.actions.rollback = outcome !== "observing" && detail.selectedRun.operation === "apply" ? null : "not_applicable";
    publishLifecycle(record, { id: eventId(), event: "repair.verification_updated", data: {
      ...lifecycleBase(detail), executionId: execution.id, outcome, reason: detail.verification.reason,
      sampleCount: detail.verification.sampleCount, runStatus: detail.selectedRun.status as "RUNNING" | "COMPLETED" | "FAILED", incidentStatus: detail.incident.status,
    } });
  };
  for (const [label, state] of cases) {
    const record = repairFixture();
    const detail = record.detail;
    const originalStart = Date.parse(detail.incident.createdAt);
    const shift = (timestamp: string) => new Date(Date.parse(now) - 5 * 60_000 + Date.parse(timestamp) - originalStart).toISOString();
    detail.incident.createdAt = shift(detail.incident.createdAt);
    detail.selectedRun.createdAt = shift(detail.selectedRun.createdAt);
    if (detail.selectedRun.startedAt) detail.selectedRun.startedAt = shift(detail.selectedRun.startedAt);
    if (detail.selectedRun.completedAt) detail.selectedRun.completedAt = shift(detail.selectedRun.completedAt);
    if (detail.diagnosis) detail.diagnosis.createdAt = shift(detail.diagnosis.createdAt);
    for (const evidence of detail.evidence) evidence.observedAt = shift(evidence.observedAt);
    const proposal = detail.repair!;
    proposal.schemaCheckedAt = shift(proposal.schemaCheckedAt);
    proposal.policyCheckedAt = shift(proposal.policyCheckedAt);
    proposal.diffCheckedAt = shift(proposal.diffCheckedAt);
    proposal.validation.checkedAt = shift(proposal.validation.checkedAt);
    for (const event of record.events) event.data.occurredAt = shift(event.data.occurredAt);
    record.metricAnchor = now;
    detail.incident.id = uuid("1", nextIncident++);
    detail.incident.displayName = label;
    detail.incident.triggerSummary = "手工 UI 走查测试数据；不连接 Kubernetes，不证明真实执行或恢复。";
    detail.incident.status = "DIAGNOSED";
    for (const event of record.events) event.data.incidentId = detail.incident.id;
    if (state !== "diagnosis") {
      if (!prepareFakeRepair(record, { sourceRunId: detail.selectedRun.id })) throw new Error("Invalid manual preparation fixture");
      if (state === "expired") {
        record.detail.selectedRun.waitingExpiresAt = new Date(Date.now() - 1000).toISOString();
        record.detail.actions.approve = record.detail.actions.reject = "proposal_expired";
      } else if (state === "rejected") approve(record, "reject");
      else if (state !== "waiting") {
        approve(record);
        if (state.startsWith("rollback-")) {
          recover(record, "monitoring_unavailable");
          const source = record.detail;
          if (!prepareFakeRepair(record, { sourceRunId: source.selectedRun.id, sourceExecutionId: source.approval!.execution!.id })) throw new Error("Invalid manual rollback fixture");
          if (state !== "rollback-waiting") approve(record);
        }
        if (state === "claimed" || state.endsWith("unknown")) {
          const current = record.detail;
          const execution = current.approval!.execution!;
          execution.claimedAt = now;
          execution.status = state === "claimed" ? "CLAIMED" : "UNKNOWN";
          if (execution.status === "UNKNOWN") {
            execution.reportedAt = now;
            execution.result = { outcome: "UNKNOWN", error: "outcome_unknown", receipt: null };
            current.selectedRun.status = "FAILED";
            current.selectedRun.completedAt = now;
            current.selectedRun.error = { code: "execution_outcome_unknown", retryable: false };
            current.incident.status = "FAILED";
          }
          publishLifecycle(record, { id: eventId(), event: "repair.execution_updated", data: {
            ...lifecycleBase(current), approvalId: current.approval!.id, executionId: execution.id,
            executionStatus: execution.status, lateResult: false, runStatus: state === "claimed" ? "RUNNING" : "FAILED", incidentStatus: state === "claimed" ? "APPLYING" : "FAILED",
          } });
        } else if (state === "observing") recover(record, "observing");
        else if (state.endsWith("monitoring_unavailable")) recover(record, "monitoring_unavailable");
        else if (state.endsWith("recovered")) recover(record, "recovered");
      }
    }
    record.metricState = state.endsWith("monitoring_unavailable") ? "monitoring_unavailable" : "ok";
    incidents.set(record.detail.incident.id, record);
  }
  return cases.length;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "POST" && url.pathname === "/__test__/reset") {
    mode = "diagnosed";
    nextIncident = 1;
    nextEventId = 1;
    showcaseEnabled = false;
    operatorSessions.clear();
    accessMode = "private";
    incidents.clear();
    eventConnections.clear();
    nextRepair = 100;
    for (const streams of lifecycleStreams.values()) for (const stream of streams) stream.end();
    lifecycleStreams.clear();
    json(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__test__/access") {
    const body = await requestBody(request) as { mode?: string; expireOperator?: boolean };
    if (body.mode === "private" || body.mode === "public_demo") accessMode = body.mode;
    if (body.expireOperator) for (const session of operatorSessions.values()) session.expiresAt = 0;
    json(response, 200, { ok: true }); return;
  }

  if (request.method === "POST" && url.pathname === "/__test__/showcase") {
    seedShowcase();
    json(response, 200, { incidents: incidents.size, ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__test__/repair") {
    const body = await requestBody(request) as { outcome?: string };
    const record = repairFixture(body.outcome);
    incidents.set(record.detail.incident.id, record);
    json(response, 200, { incidentId: record.detail.incident.id });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__test__/repair-state") {
    const body = await requestBody(request) as { incidentId: string; state: string };
    const record = incidents.get(body.incidentId);
    if (!record?.detail.repair) { json(response, 404, { ok: false }); return; }
    const detail = record.detail;
    if (body.state === "expired") {
      detail.selectedRun.waitingExpiresAt = new Date(Date.now() - 1000).toISOString();
      detail.actions.approve = detail.actions.reject = "proposal_expired";
    } else if (body.state === "preparation-failed") {
      detail.repair = null;
      detail.selectedRun.status = "FAILED";
      detail.selectedRun.error = { code: "stale_resource", retryable: false };
      detail.selectedRun.completedAt = new Date().toISOString();
      detail.incident.status = "STALE_RESOURCE";
      detail.actions.approve = detail.actions.reject = detail.actions.edit = "not_applicable";
      detail.actions.preparationSource!.sourceRunId = detail.selectedRun.sourceRunId!;
    } else if (body.state === "UNKNOWN" || body.state === "STALE_RESOURCE") {
      const execution = detail.approval!.execution!;
      execution.status = body.state;
      execution.claimedAt = execution.reportedAt = new Date().toISOString();
      execution.result = body.state === "UNKNOWN" ? { outcome: "UNKNOWN", receipt: null, error: "outcome_unknown" }
        : { outcome: "STALE_RESOURCE", receipt: null, error: "precondition_failed" };
      detail.selectedRun.status = "FAILED";
      detail.selectedRun.completedAt = execution.reportedAt;
      detail.incident.status = body.state === "UNKNOWN" ? "FAILED" : "STALE_RESOURCE";
      detail.actions.rerun = body.state === "UNKNOWN" ? "execution_held" : null;
      publishLifecycle(record, { id: eventId(), event: "repair.execution_updated", data: { ...lifecycleBase(detail),
        approvalId: detail.approval!.id, executionId: execution.id, executionStatus: execution.status,
        runStatus: "FAILED", incidentStatus: detail.incident.status, lateResult: false } });
    } else if (body.state === "observing" || body.state === "recovered" || body.state === "monitoring_unavailable") {
      const observed = makeRecoveryDetail(body.state);
      const execution = detail.approval!.execution!;
      Object.assign(execution, observed.approval!.execution, { id: execution.id });
      detail.verification = { ...observed.verification!, executionId: execution.id };
      detail.selectedRun.status = body.state === "observing" ? "RUNNING" : detail.selectedRun.operation === "rollback" ? "COMPLETED" : observed.selectedRun.status;
      detail.selectedRun.completedAt = observed.selectedRun.completedAt;
      detail.incident.status = body.state === "observing" ? "VERIFYING" : detail.selectedRun.operation === "rollback" ? "ROLLED_BACK" : body.state === "recovered" ? "RESOLVED" : "FAILED";
      detail.actions.rerun = body.state === "observing" ? "execution_held" : null;
      detail.actions.rollback = body.state !== "observing" && detail.selectedRun.operation === "apply" ? null : "not_applicable";
      publishLifecycle(record, { id: eventId(), event: "repair.verification_updated", data: { ...lifecycleBase(detail),
        executionId: execution.id, outcome: body.state, reason: detail.verification.reason,
        sampleCount: detail.verification.sampleCount,
        runStatus: detail.selectedRun.status as "RUNNING" | "COMPLETED" | "FAILED", incidentStatus: detail.incident.status,
      } });
    } else if (body.state !== "reconnect") { json(response, 422, { ok: false }); return; }
    for (const stream of lifecycleStreams.get(body.incidentId) ?? []) stream.end();
    json(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__test__/mode") {
    const body = await requestBody(request);
    if (
      typeof body !== "object" ||
      body === null ||
      !("mode" in body) ||
      ![
        "diagnosed",
        "failed",
        "insufficient",
        "running",
        "waiting",
        "unavailable",
        "diagnosis-unavailable",
      ].includes(
        String(body.mode),
      )
    ) {
      json(response, 400, { ok: false });
      return;
    }
    mode = body.mode as RuntimeMode;
    json(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/__test__/observations") {
    json(response, 200, {
      eventConnections: Object.fromEntries(eventConnections),
    });
    return;
  }

  if (url.pathname === "/api/v1/operator/login" && request.method === "POST") {
    if (request.headers.origin !== operatorOrigin) {
      runtimeError(response, 403, "operator_origin_rejected", "Request origin is not permitted.", false); return;
    }
    const payload = await requestBody(request) as { password?: unknown };
    if (typeof payload.password !== "string" || Buffer.byteLength(payload.password, "utf8") > 1024 || !checkOperatorPassword || !await checkOperatorPassword(payload.password)) {
      runtimeError(response, 401, "operator_authentication_required", "Operator authentication is required.", false); return;
    }
    const token = randomBytes(32).toString("base64url");
    const session = { operatorRef: "sandbox-operator", csrfToken: randomBytes(32).toString("hex"), expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    operatorSessions.set(token, session);
    response.setHeader("set-cookie", `${OPERATOR_COOKIE}=${token}; HttpOnly; Secure; SameSite=strict; Path=/; Max-Age=3600`);
    json(response, 200, session); return;
  }

  let requester: FakeRequester = null;
  if (url.pathname.startsWith("/api/v1/")) {
    const cookies = new Map((request.headers.cookie ?? "").split(";").map(part => {
      const [name, value] = part.trim().split("="); return [name, value];
    }));
    const operatorToken = cookies.get(OPERATOR_COOKIE);
    const token = operatorToken ?? "";
    let session = operatorSessions.get(token);
    if (session && session.expiresAt > Date.now() / 1000) requester = { role: "operator", key: token };
    else session = undefined;
    const mutation = !["GET", "HEAD"].includes(request.method ?? "");
    if (!requester && (accessMode === "private" || mutation)) {
      runtimeError(response, 401, "operator_authentication_required", "Operator authentication is required.", false); return;
    }
    if (mutation) {
      if (request.headers.origin !== operatorOrigin) {
        runtimeError(response, 403, "operator_origin_rejected", "Request origin is not permitted.", false); return;
      }
      if (session && request.headers[OPERATOR_CSRF_HEADER.toLowerCase()] !== session.csrfToken) {
        runtimeError(response, 403, "operator_csrf_rejected", "Request verification failed.", false); return;
      }
    }
    const view = () => ({ accessMode, role: requester?.role ?? "anonymous", expiresAt: session?.expiresAt ?? null, csrfToken: session?.csrfToken ?? null });
    if (url.pathname === "/api/v1/operator/session" && request.method === "GET") {
      if (!session && operatorToken) response.setHeader("set-cookie", `${OPERATOR_COOKIE}=""; HttpOnly; Secure; SameSite=strict; Path=/; Max-Age=0`);
      json(response, 200, view()); return;
    }
    if (url.pathname === "/api/v1/operator/session" && request.method === "POST" && session) {
      session.expiresAt = Math.max(session.expiresAt, Math.floor(Date.now() / 1000) + 3600);
      response.setHeader("set-cookie", `${OPERATOR_COOKIE}=${token}; HttpOnly; Secure; SameSite=strict; Path=/; Max-Age=3600`);
      json(response, 200, view()); return;
    }
    if (url.pathname === "/api/v1/operator/logout" && request.method === "POST") {
      if (operatorToken) operatorSessions.delete(operatorToken);
      response.setHeader("set-cookie", `${OPERATOR_COOKIE}=""; HttpOnly; Secure; SameSite=strict; Path=/; Max-Age=0`);
      response.writeHead(204, { "cache-control": "no-store" }); response.end(); return;
    }
    if (request.headers.accept === "text/event-stream") {
      const deadline = Date.now() + 300_000;
      const streamRequester = requester;
      const expiry = setInterval(() => {
        if (session && (!operatorSessions.has(token) || session.expiresAt <= Date.now() / 1000)) response.end();
        if (streamRequester?.role !== "operator" && (accessMode !== "public_demo" || Date.now() >= deadline)) response.end();
      }, 100);
      response.once("close", () => clearInterval(expiry));
    }
  }

  if (mode === "unavailable") {
    runtimeError(
      response,
      503,
      "runtime_not_ready",
      "Runtime is not ready.",
      true,
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/scenarios") {
    json(response, 200, { schemaVersion: 1, items: [SCENARIO] });
    return;
  }

  if (request.method === "GET" && url.pathname === "/healthz") {
    json(response, 200, {
      status: "ok",
      diagnosis: mode === "diagnosis-unavailable"
        ? { status: "unavailable", reason: "provider_unavailable" }
        : { status: "ready", reason: null },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/monitoring/health") {
    json(response, 200, {
      state: "healthy",
      checkedAt: TERMINAL_AT,
      prometheus: "healthy",
      kubeStateMetrics: "healthy",
      ruleEvaluation: "healthy",
      alertmanager: "healthy",
      notification: "healthy",
      watchdogLastReceivedAt: TOOL_AT,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/monitoring/overview") {
    json(response, 200, monitoringOverview());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/incidents") {
    json(response, 200, {
      schemaVersion: 5,
      items: [...incidents.values()].reverse().map(listItem),
      nextCursor: null,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/incidents") {
    if (mode === "diagnosis-unavailable") {
      runtimeError(response, 503, "diagnosis_unavailable", "Model diagnosis is unavailable.", true);
      return;
    }
    const body = await requestBody(request);
    if (
      typeof body !== "object" ||
      body === null ||
      !("scenarioId" in body) ||
      body.scenarioId !== SCENARIO.scenarioId
    ) {
      runtimeError(
        response,
        404,
        "scenario_not_found",
        "Scenario was not found.",
        false,
      );
      return;
    }

    const record = createIncident(mode);
    bindFakeRequester(record, requester);
    incidents.set(record.detail.incident.id, record);
    json(response, 202, {
      schemaVersion: 5,
      incidentId: record.detail.incident.id,
    });
    return;
  }

  const panelListMatch = url.pathname.match(
    /^\/api\/v1\/incidents\/([0-9a-f-]+)\/monitoring\/panels$/i,
  );
  if (request.method === "GET" && panelListMatch !== null) {
    const record = incidents.get(panelListMatch[1]);
    if (record === undefined) {
      runtimeError(response, 404, "incident_not_found", "Incident was not found.", false);
      return;
    }
    json(response, 200, {
      schemaVersion: 4,
      panels: metricPanelReferences(record),
    });
    return;
  }

  const panelMatch = url.pathname.match(
    /^\/api\/v1\/incidents\/([0-9a-f-]+)\/monitoring\/panels\/([a-z0-9-]+)$/i,
  );
  if (request.method === "GET" && panelMatch !== null) {
    const record = incidents.get(panelMatch[1]);
    const window = url.searchParams.get("window");
    if (record === undefined) {
      runtimeError(response, 404, "incident_not_found", "Incident was not found.", false);
      return;
    }
    if (
      !metricPanelReferences(record).some(
        (panel) => panel.panelId === panelMatch[2],
      )
    ) {
      runtimeError(
        response,
        404,
        "monitoring_panel_not_found",
        "Monitoring panel was not found.",
        false,
      );
      return;
    }
    if (
      window !== "15m" &&
      window !== "1h" &&
      window !== "6h" &&
      window !== "7d" &&
      window !== "15d"
    ) {
      runtimeError(response, 422, "invalid_request", "Request is invalid.", false);
      return;
    }
    const anchor = url.searchParams.get("anchor") ?? "current";
    if (anchor !== "current" && anchor !== "run" && anchor !== "occurrence") {
      runtimeError(response, 422, "invalid_request", "Request is invalid.", false);
      return;
    }
    json(response, 200, metricPanel(record, panelMatch[2], window, anchor));
    return;
  }

  const runsMatch = url.pathname.match(
    /^\/api\/v1\/incidents\/([0-9a-f-]+)\/runs$/i,
  );
  if (request.method === "GET" && runsMatch !== null) {
    const record = incidents.get(runsMatch[1]);
    if (record === undefined) {
      runtimeError(response, 404, "incident_not_found", "Incident was not found.", false);
      return;
    }
    json(response, 200, {
      schemaVersion: 5,
      items: [record.detail, ...(record.history ?? [])].filter(({ selectedRun: run }) => url.searchParams.get("mine") !== "true" || ownsFakeRun(run, requester)).map(({ selectedRun: run }) => ({
        initiatedByYou: ownsFakeRun(run, requester),
        id: run.id,
        kind: run.kind,
        operation: run.operation,
        attempt: run.attempt,
        status: run.status,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        requestSource: run.requestSource ?? null,
        sourceRunId: run.sourceRunId ?? null,
      })),
      nextCursor: null,
    });
    return;
  }

  const repairMutationMatch = url.pathname.match(/^\/api\/v1\/incidents\/([0-9a-f-]+)\/(repair-runs|approvals|withdrawals)$/i);
  if (request.method === "POST" && repairMutationMatch !== null) {
    const record = incidents.get(repairMutationMatch[1]);
    if (!record) { runtimeError(response, 404, "incident_not_found", "Incident was not found.", false); return; }
    const body = await requestBody(request);
    if (record.detail.selectedRun.status === "WAITING_APPROVAL" && requester?.role !== "operator" && !ownsFakeRun(record.detail.selectedRun, requester)) {
      runtimeError(response, 403, "run_ownership_required", "This run is not controlled by the current session.", false); return;
    }
    if (repairMutationMatch[2] === "withdrawals") {
      const run = record.detail.selectedRun;
      if (!ownsFakeRun(run, requester) || run.status !== "WAITING_APPROVAL" || (body as { runId?: string }).runId !== run.id) {
        runtimeError(response, 409, "active_run_exists", "An active run already exists.", true); return;
      }
      run.status = "COMPLETED";
      run.completedAt = new Date().toISOString();
      run.endReason = "withdrawn";
      record.detail.incident.status = "DIAGNOSED";
      record.detail.actions.approve = record.detail.actions.reject = record.detail.actions.withdraw = "not_applicable";
      publishLifecycle(record, { id: eventId(), event: "repair.wait_ended", data: { ...lifecycleBase(record.detail), reason: "withdrawn", incidentStatus: "DIAGNOSED", runStatus: "COMPLETED" } });
      response.writeHead(204, { "cache-control": "no-store" }); response.end(); return;
    }
    const preparing = repairMutationMatch[2] === "repair-runs";
    const succeeded = preparing ? prepareFakeRepair(record, body as components["schemas"]["CreateRepairRunRequest"])
      : decideFakeRepair(record, body as components["schemas"]["ApprovalRequest"]);
    if (!succeeded) { runtimeError(response, 409, "approval_conflict", "The saved state changed.", false); return; }
    if (preparing) bindFakeRequester(record, requester);
    json(response, preparing ? 202 : 200, preparing ? { schemaVersion: 5, runId: record.detail.selectedRun.id } : record.detail.approval);
    return;
  }

  const runEventsMatch = url.pathname.match(
    /^\/api\/v1\/incidents\/([0-9a-f-]+)\/runs\/([0-9a-f-]+)\/events$/i,
  );
  if (request.method === "GET" && runEventsMatch !== null) {
    const record = incidents.get(runEventsMatch[1]);
    const detail = record && selectedFakeDetail(record, runEventsMatch[2]);
    if (!detail) {
      runtimeError(response, 404, "run_not_found", "Run was not found.", false);
      return;
    }
    json(response, 200, {
      schemaVersion: 5,
      items: [...detail.eventPage.items],
      nextCursor: null,
    });
    return;
  }

  const eventMatch = url.pathname.match(
    /^\/api\/v1\/incidents\/([0-9a-f-]+)\/events$/i,
  );
  if (request.method === "GET" && eventMatch !== null) {
    const incidentId = eventMatch[1];
    const record = incidents.get(incidentId);
    if (record === undefined) {
      runtimeError(
        response,
        404,
        "incident_not_found",
        "Incident was not found.",
        false,
      );
      return;
    }
    streamEvents(request, response, incidentId, record);
    return;
  }

  const detailMatch = url.pathname.match(/^\/api\/v1\/incidents\/([0-9a-f-]+)$/i);
  if (request.method === "GET" && detailMatch !== null) {
    const record = incidents.get(detailMatch[1]);
    if (record === undefined) {
      runtimeError(
        response,
        404,
        "incident_not_found",
        "Incident was not found.",
        false,
      );
      return;
    }
    const runId = url.searchParams.get("runId");
    const detail = selectedFakeDetail(record, runId);
    if (!detail) {
      runtimeError(response, 404, "run_not_found", "Run was not found.", false);
      return;
    }
    json(response, 200, projectFakeRequester(detail, requester));
    return;
  }

  runtimeError(
    response,
    404,
    "incident_not_found",
    "Incident was not found.",
    false,
  );
}

export async function startFakeRuntime(port: number, auth: { origin: string } & ({ password: string } | { verifierFile: string; pythonExecutable: string })) {
  if ("password" in auth) {
    checkOperatorPassword = async password => auth.password.length > 0 && password === auth.password;
  } else {
    const verifierFile = auth.verifierFile;
    checkOperatorPassword = password => new Promise<boolean>((resolve, reject) => {
      const child = execFile(auth.pythonExecutable, ["-c", `
import sys
from pathlib import Path
from k8s_incident_agent.auth.verifier import PasswordVerifier
try:
    verifier = PasswordVerifier.from_file(Path(sys.argv[1]))
    password = sys.stdin.buffer.read(1025)
    print("1" if len(password) <= 1024 and verifier.matches(password) else "0")
except Exception:
    raise SystemExit(2) from None
`, verifierFile], { timeout: 5000, maxBuffer: 1024 }, (error, stdout) => {
        if (error || !["0", "1"].includes(stdout.trim())) reject(new Error("Fake Runtime password verification unavailable"));
        else resolve(stdout.trim() === "1");
      });
      // Passwords travel only through stdin, never argv, environment or logs.
      child.stdin?.on("error", () => {});
      child.stdin?.end(password);
    });
    await checkOperatorPassword("");
  }
  operatorOrigin = auth.origin;
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        runtimeError(
          response,
          500,
          "internal_error",
          "Internal server error.",
          false,
        );
      } else {
        response.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
}
