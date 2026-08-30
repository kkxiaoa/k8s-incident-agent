import type { components } from "@/lib/agent-runtime/generated";
import type { IncidentDetailView } from "@/lib/agent-runtime/response-contracts";

export type IncidentDetailResponse = IncidentDetailView;
export type RunEventStreamItem =
  components["schemas"]["RunEventStreamItem"];

export const RUN_EVENT_NAMES = [
  "incident.created",
  "run.started",
  "tool.started",
  "evidence.recorded",
  "tool.failed",
  "diagnosis.completed",
  "diagnosis.insufficient",
  "run.failed",
] as const satisfies readonly RunEventStreamItem["event"][];

export type IncidentStreamConnection =
  | "connecting"
  | "live"
  | "reconnecting"
  | "closed"
  | "invalid";

interface IncidentStreamState {
  connection: IncidentStreamConnection;
  detail: IncidentDetailResponse;
  detailRefreshEventId: string | null;
  events: RunEventStreamItem[];
  lastEventId: string | null;
  refreshError: string | null;
  streamError: string | null;
  terminalSeen: boolean;
}

type IncidentStreamAction =
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "event"; event: RunEventStreamItem }
  | {
      type: "snapshot";
      afterEventId: string;
      detail: IncidentDetailResponse;
    }
  | { type: "refresh_failed"; afterEventId: string; message: string }
  | { type: "invalid"; message: string };

type JsonObject = Record<string, unknown>;

const MAX_EVENT_ID = BigInt("9223372036854775807");
const EVENT_ID_PATTERN = /^[1-9][0-9]*$/;
const TERMINAL_EVENTS = new Set<RunEventStreamItem["event"]>([
  "diagnosis.completed",
  "diagnosis.insufficient",
  "run.failed",
]);

export function isTerminalRunEvent(event: RunEventStreamItem): boolean {
  return TERMINAL_EVENTS.has(event.event);
}

export function requiresIncidentDetailRefresh(
  event: RunEventStreamItem,
): boolean {
  return event.event === "evidence.recorded" || isTerminalRunEvent(event);
}

function invalidEvent(): never {
  throw new Error("Invalid incident event");
}

function eventId(value: string): string {
  if (!EVENT_ID_PATTERN.test(value)) {
    return invalidEvent();
  }

  try {
    if (BigInt(value) > MAX_EVENT_ID) {
      return invalidEvent();
    }
  } catch {
    return invalidEvent();
  }

  return value;
}

function jsonObject(data: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return invalidEvent();
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidEvent();
  }

  return value as JsonObject;
}

function textField(value: JsonObject, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    return invalidEvent();
  }
  return field;
}

function booleanField(value: JsonObject, key: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    return invalidEvent();
  }
  return field;
}

function literalField<const T extends string>(
  value: JsonObject,
  key: string,
  expected: T,
): T {
  if (value[key] !== expected) {
    return invalidEvent();
  }
  return expected;
}

function commonFields(value: JsonObject) {
  if (value.schemaVersion !== 1) {
    return invalidEvent();
  }

  return {
    schemaVersion: 1 as const,
    incidentId: textField(value, "incidentId"),
    runId: textField(value, "runId"),
    occurredAt: textField(value, "occurredAt"),
  };
}

function parseEventData(
  name: RunEventStreamItem["event"],
  value: JsonObject,
): RunEventStreamItem["data"] {
  const common = commonFields(value);

  switch (name) {
    case "incident.created":
      return {
        ...common,
        scenarioId: textField(value, "scenarioId"),
        incidentStatus: literalField(
          value,
          "incidentStatus",
          "RECEIVED",
        ),
        runStatus: literalField(value, "runStatus", "QUEUED"),
      };
    case "run.started":
      return {
        ...common,
        incidentStatus: literalField(
          value,
          "incidentStatus",
          "TRIAGING",
        ),
        runStatus: literalField(value, "runStatus", "RUNNING"),
      };
    case "tool.started":
      return {
        ...common,
        toolCallId: textField(value, "toolCallId"),
        toolName: textField(value, "toolName"),
      };
    case "evidence.recorded":
      return {
        ...common,
        evidenceId: textField(value, "evidenceId"),
        evidenceKind: textField(value, "evidenceKind"),
        observedAt: textField(value, "observedAt"),
        redacted: booleanField(value, "redacted"),
        toolCallId: textField(value, "toolCallId"),
        toolName: textField(value, "toolName"),
        truncated: booleanField(value, "truncated"),
      };
    case "tool.failed":
      return {
        ...common,
        errorCode: textField(value, "errorCode"),
        retryable: booleanField(value, "retryable"),
        toolCallId: textField(value, "toolCallId"),
        toolName: textField(value, "toolName"),
      };
    case "diagnosis.completed":
      return {
        ...common,
        diagnosisId: textField(value, "diagnosisId"),
        incidentStatus: literalField(
          value,
          "incidentStatus",
          "DIAGNOSED",
        ),
        outcome: literalField(value, "outcome", "diagnosed"),
        runStatus: literalField(value, "runStatus", "COMPLETED"),
      };
    case "diagnosis.insufficient":
      return {
        ...common,
        diagnosisId: textField(value, "diagnosisId"),
        incidentStatus: literalField(
          value,
          "incidentStatus",
          "INSUFFICIENT_EVIDENCE",
        ),
        outcome: literalField(value, "outcome", "insufficient_evidence"),
        runStatus: literalField(value, "runStatus", "COMPLETED"),
      };
    case "run.failed":
      return {
        ...common,
        errorCode: textField(value, "errorCode"),
        incidentStatus: literalField(value, "incidentStatus", "FAILED"),
        retryable: booleanField(value, "retryable"),
        runStatus: literalField(value, "runStatus", "FAILED"),
      };
  }
}

function isEventName(value: string): value is RunEventStreamItem["event"] {
  return (RUN_EVENT_NAMES as readonly string[]).includes(value);
}

export function parseRunEvent(
  name: string,
  id: string,
  data: string,
): RunEventStreamItem {
  if (!isEventName(name)) {
    return invalidEvent();
  }

  const parsedId = eventId(id);
  const parsedData = parseEventData(name, jsonObject(data));

  return { id: parsedId, event: name, data: parsedData } as RunEventStreamItem;
}

export function createIncidentStreamState(
  detail: IncidentDetailResponse,
): IncidentStreamState {
  return {
    connection: "connecting",
    detail,
    detailRefreshEventId: null,
    events: [],
    lastEventId: null,
    refreshError: null,
    streamError: null,
    terminalSeen: false,
  };
}

function applyEventStatus(
  detail: IncidentDetailResponse,
  event: RunEventStreamItem,
): IncidentDetailResponse {
  if (detail.run.status === "COMPLETED" || detail.run.status === "FAILED") {
    return detail;
  }

  // The REST snapshot can already be ahead of history replayed from event zero.
  if (detail.run.status === "RUNNING" && event.event === "incident.created") {
    return detail;
  }

  switch (event.event) {
    case "incident.created":
    case "run.started":
    case "diagnosis.completed":
    case "diagnosis.insufficient":
    case "run.failed":
      return {
        ...detail,
        incident: {
          ...detail.incident,
          status: event.data.incidentStatus,
        },
        run: { ...detail.run, status: event.data.runStatus },
      };
    case "tool.started":
    case "evidence.recorded":
    case "tool.failed":
      return detail;
  }
}

export function reduceIncidentStream(
  state: IncidentStreamState,
  action: IncidentStreamAction,
): IncidentStreamState {
  switch (action.type) {
    case "connected":
      return state.terminalSeen
        ? state
        : { ...state, connection: "live", streamError: null };
    case "disconnected":
      return state.terminalSeen
        ? { ...state, connection: "closed" }
        : { ...state, connection: "reconnecting" };
    case "invalid":
      return {
        ...state,
        connection: "invalid",
        streamError: action.message,
      };
    case "snapshot":
      return action.afterEventId === state.detailRefreshEventId
        ? { ...state, detail: action.detail, refreshError: null }
        : state;
    case "refresh_failed":
      return action.afterEventId === state.detailRefreshEventId
        ? { ...state, refreshError: action.message }
        : state;
    case "event": {
      if (state.terminalSeen) {
        return state;
      }

      if (
        state.lastEventId !== null &&
        BigInt(action.event.id) <= BigInt(state.lastEventId)
      ) {
        return state;
      }

      const terminalSeen = isTerminalRunEvent(action.event);
      return {
        ...state,
        connection: terminalSeen ? "closed" : state.connection,
        detail: applyEventStatus(state.detail, action.event),
        detailRefreshEventId: requiresIncidentDetailRefresh(action.event)
          ? action.event.id
          : state.detailRefreshEventId,
        events: [...state.events, action.event],
        lastEventId: action.event.id,
        terminalSeen,
      };
    }
  }
}
