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
  mode: OutcomeMode;
}

const SCENARIO: ScenarioResponse = {
  scenarioId: "image-pull-backoff",
  scenarioVersion: 1,
  displayName: "镜像拉取失败",
  description: "调查 Pod 的 ImagePullBackOff，并保留 Kubernetes Evidence 引用。",
  target: {
    apiVersion: "v1",
    kind: "Pod",
    namespace: "incident-demo",
    name: "broken-image",
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

let mode: RuntimeMode = "diagnosed";
let nextIncident = 1;
let nextEventId = 1;
const incidents = new Map<string, FakeIncident>();
const eventConnections = new Map<string, Array<string | null>>();

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
  evidenceId: string,
  diagnosisId: string,
  outcome: OutcomeMode,
): RunEventStreamItem[] {
  const events: RunEventStreamItem[] = [
    {
      id: eventId(),
      event: "incident.created",
      data: {
        schemaVersion: 2,
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
        schemaVersion: 2,
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
        schemaVersion: 2,
        incidentId,
        runId,
        toolCallId: "tool-call-1",
        toolName: "get_pod",
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
          schemaVersion: 2,
          incidentId,
          runId,
          toolCallId: "tool-call-1",
          toolName: "get_pod",
          errorCode: "kubernetes_forbidden",
          retryable: false,
          occurredAt: EVIDENCE_AT,
        },
      },
      {
        id: eventId(),
        event: "run.failed",
        data: {
          schemaVersion: 2,
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

  events.push({
    id: eventId(),
    event: "evidence.recorded",
    data: {
      schemaVersion: 2,
      incidentId,
      runId,
      evidenceId,
      evidenceKind: "kubernetes.pod",
      observedAt: EVIDENCE_AT,
      redacted: false,
      toolCallId: "tool-call-1",
      toolName: "get_pod",
      truncated: false,
      occurredAt: EVIDENCE_AT,
    },
  });

  if (outcome === "diagnosed") {
    events.push({
      id: eventId(),
      event: "diagnosis.completed",
      data: {
        schemaVersion: 2,
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
        schemaVersion: 2,
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
  const evidenceId = uuid("3", sequence);
  const diagnosisId = uuid("4", sequence);
  const events = buildEvents(incidentId, runId, evidenceId, diagnosisId, outcome);
  const initialEvent = events[0];

  return {
    mode: outcome,
    finished: false,
    events,
    detail: {
      schemaVersion: 2,
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
      break;
    case "evidence.recorded":
      if (!record.detail.evidence.some((item) => item.id === event.data.evidenceId)) {
        record.detail.evidence.push({
          id: event.data.evidenceId,
          toolCallId: event.data.toolCallId,
          toolName: event.data.toolName,
          evidenceKind: event.data.evidenceKind,
          targetRef: SCENARIO.target,
          observedAt: event.data.observedAt,
          payload: {
            metadata: {
              namespace: SCENARIO.target.namespace,
              name: SCENARIO.target.name,
            },
            spec: {
              containers: [{ name: "app", image: "example.invalid/missing:v1" }],
            },
            status: {
              waiting: {
                reason: "ImagePullBackOff",
                message: "manifest unknown",
              },
            },
          },
          truncated: event.data.truncated,
          redacted: event.data.redacted,
        });
      }
      break;
    case "diagnosis.completed":
      record.detail.incident.status = "DIAGNOSED";
      record.detail.selectedRun.status = "COMPLETED";
      record.detail.selectedRun.completedAt = event.data.occurredAt;
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
      record.detail.incident.status = "FAILED";
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

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "POST" && url.pathname === "/__test__/reset") {
    mode = "diagnosed";
    nextIncident = 1;
    nextEventId = 1;
    incidents.clear();
    eventConnections.clear();
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

  if (request.method === "GET" && url.pathname === "/api/v1/incidents") {
    json(response, 200, {
      schemaVersion: 2,
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
      schemaVersion: 2,
      incidentId: record.detail.incident.id,
    });
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
      schemaVersion: 2,
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
      schemaVersion: 2,
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
