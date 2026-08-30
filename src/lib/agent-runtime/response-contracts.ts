import type { components } from "./generated";

type ApiDiagnosis = components["schemas"]["DiagnosisResponse"];
type ApiEvidence = components["schemas"]["EvidenceResponse"];
type ApiIncident = components["schemas"]["IncidentResponse"];
type ApiIncidentListItem = components["schemas"]["IncidentListItem"];
type ApiRootCause = components["schemas"]["RootCauseResponse"];
type ApiRunError = components["schemas"]["RunErrorResponse"];
type ApiScenario = components["schemas"]["ScenarioResponse"];
type ApiTarget = components["schemas"]["ScenarioTargetResponse"];

export type ScenarioView = Pick<
  ApiScenario,
  "scenarioId" | "displayName" | "description"
> & { target: TargetView };

export type IncidentListItemView = Pick<
  ApiIncidentListItem,
  "id" | "displayName" | "status" | "updatedAt"
> & { target: TargetView };

export interface ScenarioListView {
  items: ScenarioView[];
}

export interface CreateIncidentView {
  incidentId: string;
}

export interface IncidentListView {
  items: IncidentListItemView[];
  hasMore: boolean;
}

type TargetView = Pick<ApiTarget, "kind" | "namespace" | "name">;
type IncidentView = Pick<
  ApiIncident,
  | "id"
  | "scenarioId"
  | "scenarioVersion"
  | "displayName"
  | "triggerSummary"
  | "status"
  | "createdAt"
> & { target: TargetView };
export type RunErrorView = Pick<ApiRunError, "code" | "retryable">;
type RunView = {
  status: components["schemas"]["RunStatus"];
  error: RunErrorView | null;
};
export type EvidenceView = Pick<
  ApiEvidence,
  | "id"
  | "toolName"
  | "evidenceKind"
  | "observedAt"
  | "payload"
  | "redacted"
  | "targetRef"
  | "truncated"
>;
type RootCauseView = Pick<
  ApiRootCause,
  "code" | "statement" | "confidence" | "evidenceIds"
>;
export type DiagnosisView = Pick<
  ApiDiagnosis,
  "outcome" | "summary" | "missingInformation" | "redacted"
> & { rootCauses: RootCauseView[] };

export interface IncidentDetailView {
  incident: IncidentView;
  run: RunView;
  evidence: EvidenceView[];
  diagnosis: DiagnosisView | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isIncidentStatus(
  value: unknown,
): value is components["schemas"]["IncidentStatus"] {
  return (
    value === "RECEIVED" ||
    value === "TRIAGING" ||
    value === "DIAGNOSED" ||
    value === "INSUFFICIENT_EVIDENCE" ||
    value === "FAILED"
  );
}

function isRunStatus(
  value: unknown,
): value is components["schemas"]["RunStatus"] {
  return (
    value === "QUEUED" ||
    value === "RUNNING" ||
    value === "COMPLETED" ||
    value === "FAILED"
  );
}

function parseTarget(value: unknown): TargetView | null {
  if (
    !isObject(value) ||
    typeof value.kind !== "string" ||
    typeof value.namespace !== "string" ||
    typeof value.name !== "string"
  ) {
    return null;
  }

  return {
    kind: value.kind,
    namespace: value.namespace,
    name: value.name,
  };
}

function parseStringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function parseScenario(value: unknown): ScenarioView | null {
  if (
    !isObject(value) ||
    typeof value.scenarioId !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.description !== "string"
  ) {
    return null;
  }

  const target = parseTarget(value.target);
  return target === null
    ? null
    : {
        scenarioId: value.scenarioId,
        displayName: value.displayName,
        description: value.description,
        target,
      };
}

function parseIncidentListItem(value: unknown): IncidentListItemView | null {
  if (
    !isObject(value) ||
    !isUuid(value.id) ||
    typeof value.displayName !== "string" ||
    !isIncidentStatus(value.status) ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  const target = parseTarget(value.target);
  return target === null
    ? null
    : {
        id: value.id,
        displayName: value.displayName,
        status: value.status,
        target,
        updatedAt: value.updatedAt,
      };
}

function parseIncident(value: unknown): IncidentView | null {
  if (
    !isObject(value) ||
    !isUuid(value.id) ||
    typeof value.scenarioId !== "string" ||
    !isInteger(value.scenarioVersion) ||
    typeof value.displayName !== "string" ||
    typeof value.triggerSummary !== "string" ||
    !isIncidentStatus(value.status) ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }

  const target = parseTarget(value.target);
  return target === null
    ? null
    : {
        id: value.id,
        scenarioId: value.scenarioId,
        scenarioVersion: value.scenarioVersion,
        displayName: value.displayName,
        triggerSummary: value.triggerSummary,
        status: value.status,
        target,
        createdAt: value.createdAt,
      };
}

function parseRunError(value: unknown): RunErrorView | null {
  return isObject(value) &&
    typeof value.code === "string" &&
    typeof value.retryable === "boolean"
    ? { code: value.code, retryable: value.retryable }
    : null;
}

function parseRun(value: unknown): RunView | null {
  if (!isObject(value) || !isRunStatus(value.status)) {
    return null;
  }

  const error = value.error === null ? null : parseRunError(value.error);
  return value.error !== null && error === null
    ? null
    : { status: value.status, error };
}

function parseEvidence(value: unknown): EvidenceView | null {
  if (
    !isObject(value) ||
    !isUuid(value.id) ||
    typeof value.toolName !== "string" ||
    typeof value.evidenceKind !== "string" ||
    typeof value.observedAt !== "string" ||
    !isObject(value.targetRef) ||
    !isObject(value.payload) ||
    typeof value.truncated !== "boolean" ||
    typeof value.redacted !== "boolean"
  ) {
    return null;
  }

  return {
    id: value.id,
    toolName: value.toolName,
    evidenceKind: value.evidenceKind,
    observedAt: value.observedAt,
    targetRef: value.targetRef,
    payload: value.payload,
    truncated: value.truncated,
    redacted: value.redacted,
  };
}

function parseRootCause(value: unknown): RootCauseView | null {
  if (
    !isObject(value) ||
    typeof value.code !== "string" ||
    typeof value.statement !== "string" ||
    (value.confidence !== "low" &&
      value.confidence !== "medium" &&
      value.confidence !== "high")
  ) {
    return null;
  }

  const evidenceIds = parseStringList(value.evidenceIds);
  return evidenceIds === null
    ? null
    : {
        code: value.code,
        statement: value.statement,
        confidence: value.confidence,
        evidenceIds,
      };
}

function parseDiagnosis(value: unknown): DiagnosisView | null {
  if (
    !isObject(value) ||
    (value.outcome !== "diagnosed" &&
      value.outcome !== "insufficient_evidence") ||
    typeof value.summary !== "string" ||
    typeof value.redacted !== "boolean" ||
    !Array.isArray(value.rootCauses)
  ) {
    return null;
  }

  const missingInformation = parseStringList(value.missingInformation);
  const rootCauses = value.rootCauses.map(parseRootCause);
  if (
    missingInformation === null ||
    rootCauses.some((rootCause) => rootCause === null)
  ) {
    return null;
  }

  return {
    outcome: value.outcome,
    summary: value.summary,
    rootCauses: rootCauses as RootCauseView[],
    missingInformation,
    redacted: value.redacted,
  };
}

export function parseCreateIncidentResponse(
  value: unknown,
): CreateIncidentView | null {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    !isUuid(value.incidentId)
  ) {
    return null;
  }

  return { incidentId: value.incidentId };
}

export function parseScenarioListResponse(
  value: unknown,
): ScenarioListView | null {
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.items)) {
    return null;
  }

  const items = value.items.map(parseScenario);
  return items.some((item) => item === null)
    ? null
    : { items: items as ScenarioView[] };
}

export function parseIncidentListResponse(
  value: unknown,
): IncidentListView | null {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.items) ||
    (value.nextCursor !== null && typeof value.nextCursor !== "string")
  ) {
    return null;
  }

  const items = value.items.map(parseIncidentListItem);
  return items.some((item) => item === null)
    ? null
    : {
        items: items as IncidentListItemView[],
        hasMore: value.nextCursor !== null,
      };
}

export function parseIncidentDetailResponse(
  value: unknown,
): IncidentDetailView | null {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.evidence)
  ) {
    return null;
  }

  const incident = parseIncident(value.incident);
  const run = parseRun(value.run);
  const evidence = value.evidence.map(parseEvidence);
  const diagnosis =
    value.diagnosis === null ? null : parseDiagnosis(value.diagnosis);
  if (
    incident === null ||
    run === null ||
    evidence.some((item) => item === null) ||
    (value.diagnosis !== null && diagnosis === null)
  ) {
    return null;
  }

  return {
    incident,
    run,
    evidence: evidence as EvidenceView[],
    diagnosis,
  };
}
