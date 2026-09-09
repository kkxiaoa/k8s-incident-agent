import type { components } from "./generated";

export type RunEventStreamItem =
  components["schemas"]["RunEventStreamItem"];

export const RUN_EVENT_NAMES = [
  "incident.created",
  "run.queued",
  "run.started",
  "tool.started",
  "evidence.recorded",
  "tool.failed",
  "diagnosis.completed",
  "repair.patch_ready",
  "repair.dry_run_passed",
  "repair.waiting_approval",
  "diagnosis.insufficient",
  "run.failed",
  "alert.resolved",
] as const satisfies readonly RunEventStreamItem["event"][];

type JsonObject = Record<string, unknown>;

const MAX_EVENT_ID = BigInt("9223372036854775807");
const EVENT_ID_PATTERN = /^[1-9][0-9]*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const CANONICAL_ALERT_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/;

function invalidEvent(): never {
  throw new Error("Invalid incident event");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidEventId(value: unknown): value is string {
  if (typeof value !== "string" || !EVENT_ID_PATTERN.test(value)) {
    return false;
  }
  try {
    if (BigInt(value) > MAX_EVENT_ID) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function eventId(value: unknown): string {
  return isValidEventId(value) ? value : invalidEvent();
}

function textField(value: JsonObject, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    return invalidEvent();
  }
  return field;
}

function uuidField(value: JsonObject, key: string): string {
  const field = textField(value, key);
  return UUID_PATTERN.test(field) ? field : invalidEvent();
}

function timestampField(value: JsonObject, key: string): string {
  const field = textField(value, key);
  return UTC_TIMESTAMP_PATTERN.test(field) && Number.isFinite(Date.parse(field))
    ? field
    : invalidEvent();
}

export function isCanonicalAlertTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CANONICAL_ALERT_TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function canonicalAlertTimestampField(value: JsonObject, key: string): string {
  const field = textField(value, key);
  return isCanonicalAlertTimestamp(field) ? field : invalidEvent();
}

function booleanField(value: JsonObject, key: string): boolean {
  const field = value[key];
  return typeof field === "boolean" ? field : invalidEvent();
}

function positiveIntegerField(
  value: JsonObject,
  key: string,
  minimum = 1,
): number {
  const field = value[key];
  return typeof field === "number" &&
    Number.isInteger(field) &&
    field >= minimum
    ? field
    : invalidEvent();
}

function literalField<const T extends string>(
  value: JsonObject,
  key: string,
  expected: T,
): T {
  return value[key] === expected ? expected : invalidEvent();
}

function commonFields(value: JsonObject) {
  if (value.schemaVersion !== 4) {
    return invalidEvent();
  }

  return {
    schemaVersion: 4 as const,
    incidentId: uuidField(value, "incidentId"),
    runId: uuidField(value, "runId"),
    occurredAt: timestampField(value, "occurredAt"),
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
        attempt: positiveIntegerField(value, "attempt"),
        incidentStatus: literalField(value, "incidentStatus", "RECEIVED"),
        runStatus: literalField(value, "runStatus", "QUEUED"),
      };
    case "run.queued":
      return {
        ...common,
        attempt: positiveIntegerField(value, "attempt", 2),
        runStatus: literalField(value, "runStatus", "QUEUED"),
      };
    case "run.started":
      return {
        ...common,
        attempt: positiveIntegerField(value, "attempt"),
        incidentStatus: literalField(value, "incidentStatus", "TRIAGING"),
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
        evidenceId: uuidField(value, "evidenceId"),
        evidenceKind: textField(value, "evidenceKind"),
        observedAt: timestampField(value, "observedAt"),
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
        diagnosisId: uuidField(value, "diagnosisId"),
        incidentStatus: literalField(value, "incidentStatus", "DIAGNOSED"),
        outcome: literalField(value, "outcome", "diagnosed"),
        runStatus:
          value.runStatus === "RUNNING" || value.runStatus === "COMPLETED"
            ? value.runStatus
            : invalidEvent(),
      };
    case "repair.patch_ready":
      return {
        ...common,
        proposalId: uuidField(value, "proposalId"),
        proposalDigest: digestField(value, "proposalDigest"),
        incidentStatus: literalField(value, "incidentStatus", "PATCH_READY"),
        runStatus: literalField(value, "runStatus", "RUNNING"),
      };
    case "repair.dry_run_passed":
      return {
        ...common,
        proposalId: uuidField(value, "proposalId"),
        proposalDigest: digestField(value, "proposalDigest"),
        incidentStatus: literalField(
          value,
          "incidentStatus",
          "DRY_RUN_PASSED",
        ),
        runStatus: literalField(value, "runStatus", "RUNNING"),
      };
    case "repair.waiting_approval":
      return {
        ...common,
        proposalId: uuidField(value, "proposalId"),
        proposalDigest: digestField(value, "proposalDigest"),
        incidentStatus: literalField(
          value,
          "incidentStatus",
          "WAITING_APPROVAL",
        ),
        runStatus: literalField(value, "runStatus", "COMPLETED"),
      };
    case "diagnosis.insufficient":
      return {
        ...common,
        diagnosisId: uuidField(value, "diagnosisId"),
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
        incidentStatus:
          value.incidentStatus === "FAILED" ||
          value.incidentStatus === "STALE_RESOURCE"
            ? value.incidentStatus
            : invalidEvent(),
        retryable: booleanField(value, "retryable"),
        runStatus: literalField(value, "runStatus", "FAILED"),
      };
    case "alert.resolved":
      return {
        ...common,
        alertStatus: literalField(value, "alertStatus", "RESOLVED"),
        endsAt: canonicalAlertTimestampField(value, "endsAt"),
      };
  }
}

function digestField(value: JsonObject, key: string): string {
  const field = textField(value, key);
  return /^sha256:[a-f0-9]{64}$/.test(field) ? field : invalidEvent();
}

function isEventName(value: unknown): value is RunEventStreamItem["event"] {
  return (
    typeof value === "string" &&
    (RUN_EVENT_NAMES as readonly string[]).includes(value)
  );
}

export function parseRunEventItem(value: unknown): RunEventStreamItem {
  if (
    !isObject(value) ||
    !isEventName(value.event) ||
    !isObject(value.data)
  ) {
    return invalidEvent();
  }

  const id = eventId(value.id);
  const data = parseEventData(value.event, value.data);
  return { id, event: value.event, data } as RunEventStreamItem;
}

export function parseRunEvent(
  name: string,
  id: string,
  data: string,
  expectedIncidentId: string,
): RunEventStreamItem {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return invalidEvent();
  }

  const event = parseRunEventItem({ id, event: name, data: parsed });
  return event.data.incidentId === expectedIncidentId ? event : invalidEvent();
}
