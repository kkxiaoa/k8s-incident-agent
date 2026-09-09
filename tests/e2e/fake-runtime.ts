import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { components } from "../../src/lib/agent-runtime/generated";

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
type RuntimeMode = OutcomeMode | "unavailable";

interface FakeIncident {
  detail: IncidentDetailResponse;
  events: RunEventStreamItem[];
  finished: boolean;
  metricState: "ok" | "monitoring_unavailable";
  mode: OutcomeMode;
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
        schemaVersion: 4,
        incidentId,
        runId,
        attempt: 1,
        incidentStatus: "RECEIVED",
        runStatus: "QUEUED",
        occurredAt: CREATED_AT,
      },
    },
    {
      id: eventId(),
      event: "run.started",
      data: {
        schemaVersion: 4,
        incidentId,
        runId,
        attempt: 1,
        incidentStatus: "TRIAGING",
        runStatus: "RUNNING",
        occurredAt: STARTED_AT,
      },
    },
    {
      id: eventId(),
      event: "tool.started",
      data: {
        schemaVersion: 4,
        incidentId,
        runId,
        toolCallId: "tool-call-1",
        toolName: "get_workload",
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
          schemaVersion: 4,
          incidentId,
          runId,
          toolCallId: "tool-call-1",
          toolName: "get_workload",
          errorCode: "kubernetes_forbidden",
          retryable: false,
          occurredAt: EVIDENCE_AT,
        },
      },
      {
        id: eventId(),
        event: "run.failed",
        data: {
          schemaVersion: 4,
          incidentId,
          runId,
          errorCode: "workflow_failed",
          incidentStatus: "FAILED",
          retryable: false,
          runStatus: "FAILED",
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
        schemaVersion: 4,
        incidentId,
        runId,
        evidenceId: workloadEvidenceId,
        evidenceKind: "workload",
        observedAt: EVIDENCE_AT,
        redacted: false,
        toolCallId: "tool-call-1",
        toolName: "get_workload",
        truncated: false,
        occurredAt: EVIDENCE_AT,
      },
    },
    {
      id: eventId(),
      event: "tool.started",
      data: {
        schemaVersion: 4,
        incidentId,
        runId,
        toolCallId: "tool-call-2",
        toolName: "get_pods",
        occurredAt: EVIDENCE_AT,
      },
    },
    {
      id: eventId(),
      event: "evidence.recorded",
      data: {
        schemaVersion: 4,
        incidentId,
        runId,
        evidenceId: podsEvidenceId,
        evidenceKind: "pods",
        observedAt: EVIDENCE_AT,
        redacted: false,
        toolCallId: "tool-call-2",
        toolName: "get_pods",
        truncated: false,
        occurredAt: EVIDENCE_AT,
      },
    },
  );

  if (outcome === "diagnosed") {
    events.push({
      id: eventId(),
      event: "diagnosis.completed",
      data: {
        schemaVersion: 4,
        incidentId,
        runId,
        diagnosisId,
        incidentStatus: "DIAGNOSED",
        outcome: "diagnosed",
        runStatus: "COMPLETED",
        occurredAt: TERMINAL_AT,
      },
    });
  } else {
    events.push({
      id: eventId(),
      event: "diagnosis.insufficient",
      data: {
        schemaVersion: 4,
        incidentId,
        runId,
        diagnosisId,
        incidentStatus: "INSUFFICIENT_EVIDENCE",
        outcome: "insufficient_evidence",
        runStatus: "COMPLETED",
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
      schemaVersion: 4,
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
      record.detail.selectedRun.status = "COMPLETED";
      record.detail.selectedRun.completedAt = event.data.occurredAt;
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
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  response.flushHeaders();

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
  const generatedAt = new Date(TERMINAL_AT);
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
    schemaVersion: 1,
    window: "24h",
    generatedAt: generatedAt.toISOString(),
    counts: {
      totalIncidents: records.length,
      firingAlerts: firingRecords.length,
      triagingIncidents: records.filter(
        (record) => record.detail.incident.status === "TRIAGING",
      ).length,
      diagnosedIncidents: records.filter(
        (record) => record.detail.incident.status === "DIAGNOSED",
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

function metricPanelReferences(record: FakeIncident) {
  return record.detail.incident.source.ref ===
    "K8sIncidentServiceEndpointsUnavailable"
    ? [
        {
          panelId: "service-ready-endpoints",
          recommendedWindow: "15m",
          riskDirection: "lower_is_worse",
          signalRole: "trigger",
          thresholdDuration: "30s",
        },
      ]
    : [
        {
          panelId: "image-pull-affected-pods",
          recommendedWindow: "15m",
          riskDirection: "higher_is_worse",
          signalRole: "trigger",
          thresholdDuration: "30s",
        },
        {
          panelId: "image-pull-available-replicas",
          recommendedWindow: "15m",
          riskDirection: "lower_is_worse",
          signalRole: "context",
          thresholdDuration: "5m",
        },
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
) {
  const serviceEndpoints = panelId === "service-ready-endpoints";
  const affectedPods = panelId === "image-pull-affected-pods";
  const alertResolved = record.detail.alertSignal?.status === "RESOLVED";
  const affectedPodCount = alertResolved ? 0 : 3;
  const availableReplicas = alertResolved ? 3 : 0;
  const readyEndpoints = alertResolved ? 2 : 0;
  const windowDuration = metricWindowMilliseconds(window);
  const queriedAt = Date.parse(alertResolved ? RESOLVED_QUERY_AT : TERMINAL_AT);
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
    addSample(incidentCreatedAt, failingValue);
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

  return {
    schemaVersion: 1,
    result: {
      panelId,
      title:
        affectedPods
          ? "镜像拉取失败 Pod"
          : serviceEndpoints
            ? "Service 就绪 Endpoint"
            : "Deployment 可用副本",
      unit: affectedPods ? "pods" : serviceEndpoints ? "endpoints" : "replicas",
      threshold: affectedPods || serviceEndpoints ? 1 : null,
      riskDirection: affectedPods ? "higher_is_worse" : "lower_is_worse",
      window,
      state: record.metricState,
      queriedAt: queriedAtTimestamp,
      latestSampleAt:
        record.metricState === "monitoring_unavailable"
          ? null
          : queriedAtTimestamp,
      currentValue:
        record.metricState === "monitoring_unavailable" ? null : failingValue,
      samples: record.metricState === "monitoring_unavailable" ? [] : samples,
    },
    markers: metricMarkers(record),
    markersTruncated: false,
  };
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
    incidents.clear();
    eventConnections.clear();
    json(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__test__/showcase") {
    seedShowcase();
    json(response, 200, { incidents: incidents.size, ok: true });
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
      schemaVersion: 4,
      items: [...incidents.values()].reverse().map(listItem),
      nextCursor: null,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/incidents") {
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
    incidents.set(record.detail.incident.id, record);
    json(response, 202, {
      schemaVersion: 4,
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
      schemaVersion: 3,
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
    json(response, 200, metricPanel(record, panelMatch[2], window));
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
    const run = record.detail.selectedRun;
    json(response, 200, {
      schemaVersion: 4,
      items: [{
        id: run.id,
        attempt: run.attempt,
        status: run.status,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      }],
      nextCursor: null,
    });
    return;
  }

  const runEventsMatch = url.pathname.match(
    /^\/api\/v1\/incidents\/([0-9a-f-]+)\/runs\/([0-9a-f-]+)\/events$/i,
  );
  if (request.method === "GET" && runEventsMatch !== null) {
    const record = incidents.get(runEventsMatch[1]);
    if (record === undefined || record.detail.selectedRun.id !== runEventsMatch[2]) {
      runtimeError(response, 404, "run_not_found", "Run was not found.", false);
      return;
    }
    json(response, 200, {
      schemaVersion: 4,
      items: [...record.detail.eventPage.items],
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
    if (runId !== null && runId !== record.detail.selectedRun.id) {
      runtimeError(response, 404, "run_not_found", "Run was not found.", false);
      return;
    }
    json(response, 200, record.detail);
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

export async function startFakeRuntime(port: number) {
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
