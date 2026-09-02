import type { components } from "./generated";
import {
  isCanonicalAlertTimestamp,
  isValidEventId,
  parseRunEventItem,
  type RunEventStreamItem,
} from "./event-contracts";

type ApiDiagnosis = components["schemas"]["DiagnosisResponse"];
type ApiEvidence = components["schemas"]["EvidenceResponse"];
type ApiAlertSignal = components["schemas"]["AlertSignalResponse"];
type ApiRootCause = components["schemas"]["RootCauseResponse"];
type ApiRunError = components["schemas"]["RunErrorResponse"];
type ApiScenario = components["schemas"]["ScenarioResponse"];

export interface TargetView {
  kind: string;
  namespace: string | null;
  name: string;
}

export type ScenarioView = Pick<
  ApiScenario,
  "scenarioId" | "displayName" | "description"
> & { target: TargetView };

export interface ScenarioListView {
  items: ScenarioView[];
}

export interface CreateIncidentView {
  incidentId: string;
}

export interface CreateRunView {
  runId: string;
}

export interface IncidentListItemView {
  id: string;
  displayName: string;
  status: components["schemas"]["IncidentStatus"];
  target: TargetView;
  updatedAt: string;
}

export interface IncidentListView {
  items: IncidentListItemView[];
  nextCursor: string | null;
}

export interface IncidentSourceView {
  type: "scenario" | "alertmanager";
  ref: string;
  revision: string;
}

export interface IncidentView {
  id: string;
  displayName: string;
  triggerSummary: string;
  status: components["schemas"]["IncidentStatus"];
  source: IncidentSourceView;
  target: TargetView;
  createdAt: string;
}

export type RunErrorView = Pick<ApiRunError, "code" | "retryable">;

export interface SelectedRunView {
  id: string;
  attempt: number;
  status: components["schemas"]["RunStatus"];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: RunErrorView | null;
}

export type RunSummaryView = Omit<SelectedRunView, "error">;

export interface RunHistoryView {
  items: RunSummaryView[];
  nextCursor: string | null;
}

export interface EventPageView {
  items: RunEventStreamItem[];
  nextCursor: string | null;
}

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

export type AlertSignalView = Pick<
  ApiAlertSignal,
  "status" | "startsAt" | "endsAt"
>;

export interface IncidentDetailView {
  incident: IncidentView;
  selectedRun: SelectedRunView;
  eventPage: EventPageView;
  eventCursor: string;
  evidence: EvidenceView[];
  diagnosis: DiagnosisView | null;
  alertSignal: AlertSignalView | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
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

function parseTarget(value: unknown, namespaceRequired = false): TargetView | null {
  if (
    !isObject(value) ||
    typeof value.kind !== "string" ||
    typeof value.name !== "string" ||
    (value.namespace !== null && typeof value.namespace !== "string") ||
    (namespaceRequired && typeof value.namespace !== "string")
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

  const target = parseTarget(value.target, true);
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
    !isTimestamp(value.updatedAt)
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

function parseIncidentSource(value: unknown): IncidentSourceView | null {
  if (
    !isObject(value) ||
    (value.type !== "scenario" && value.type !== "alertmanager") ||
    typeof value.ref !== "string" ||
    value.ref.length === 0 ||
    typeof value.revision !== "string" ||
    value.revision.length === 0
  ) {
    return null;
  }

  return { type: value.type, ref: value.ref, revision: value.revision };
}

function parseAlertSignal(value: unknown): AlertSignalView | null {
  if (
    !isObject(value) ||
    (value.status !== "FIRING" && value.status !== "RESOLVED") ||
    !isCanonicalAlertTimestamp(value.startsAt) ||
    (value.endsAt !== null && !isCanonicalAlertTimestamp(value.endsAt)) ||
    (value.status === "FIRING" && value.endsAt !== null) ||
    (value.status === "RESOLVED" && value.endsAt === null) ||
    (typeof value.endsAt === "string" &&
      value.endsAt < value.startsAt)
  ) {
    return null;
  }
  return {
    status: value.status,
    startsAt: value.startsAt,
    endsAt: value.endsAt,
  };
}

function parseIncident(value: unknown): IncidentView | null {
  if (
    !isObject(value) ||
    !isUuid(value.id) ||
    typeof value.displayName !== "string" ||
    typeof value.triggerSummary !== "string" ||
    !isIncidentStatus(value.status) ||
    !isTimestamp(value.createdAt)
  ) {
    return null;
  }

  const source = parseIncidentSource(value.source);
  const target = parseTarget(value.target);
  return source === null || target === null
    ? null
    : {
        id: value.id,
        displayName: value.displayName,
        triggerSummary: value.triggerSummary,
        status: value.status,
        source,
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

function parseRunBase(value: unknown): RunSummaryView | null {
  if (
    !isObject(value) ||
    !isUuid(value.id) ||
    !isPositiveInteger(value.attempt) ||
    !isRunStatus(value.status) ||
    !isTimestamp(value.createdAt) ||
    (value.startedAt !== null && !isTimestamp(value.startedAt)) ||
    (value.completedAt !== null && !isTimestamp(value.completedAt))
  ) {
    return null;
  }

  return {
    id: value.id,
    attempt: value.attempt,
    status: value.status,
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
  };
}

function parseSelectedRun(value: unknown): SelectedRunView | null {
  const run = parseRunBase(value);
  if (run === null || !isObject(value)) {
    return null;
  }

  const error = value.error === null ? null : parseRunError(value.error);
  return value.error !== null && error === null ? null : { ...run, error };
}

function parseEventPage(value: unknown): EventPageView | null {
  if (
    !isObject(value) ||
    !Array.isArray(value.items) ||
    (value.nextCursor !== null &&
      (typeof value.nextCursor !== "string" || value.nextCursor.length === 0))
  ) {
    return null;
  }

  try {
    return {
      items: value.items.map(parseRunEventItem),
      nextCursor: value.nextCursor,
    };
  } catch {
    return null;
  }
}

function parseEvidence(value: unknown): EvidenceView | null {
  if (
    !isObject(value) ||
    !isUuid(value.id) ||
    typeof value.toolName !== "string" ||
    typeof value.evidenceKind !== "string" ||
    !isTimestamp(value.observedAt) ||
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
  return isObject(value) && value.schemaVersion === 3 && isUuid(value.incidentId)
    ? { incidentId: value.incidentId }
    : null;
}

export function parseCreateRunResponse(value: unknown): CreateRunView | null {
  return isObject(value) && value.schemaVersion === 3 && isUuid(value.runId)
    ? { runId: value.runId }
    : null;
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
    value.schemaVersion !== 3 ||
    !Array.isArray(value.items) ||
    (value.nextCursor !== null && typeof value.nextCursor !== "string")
  ) {
    return null;
  }

  const items = value.items.map(parseIncidentListItem);
  return items.some((item) => item === null)
    ? null
    : { items: items as IncidentListItemView[], nextCursor: value.nextCursor };
}

export function parseRunHistoryResponse(value: unknown): RunHistoryView | null {
  if (
    !isObject(value) ||
    value.schemaVersion !== 3 ||
    !Array.isArray(value.items) ||
    (value.nextCursor !== null && typeof value.nextCursor !== "string")
  ) {
    return null;
  }

  const items = value.items.map(parseRunBase);
  return items.some((item) => item === null)
    ? null
    : { items: items as RunSummaryView[], nextCursor: value.nextCursor };
}

export function parseRunEventHistoryResponse(
  value: unknown,
  expectedIncidentId: string,
  expectedRunId: string,
): EventPageView | null {
  if (!isObject(value) || value.schemaVersion !== 3) {
    return null;
  }
  const page = parseEventPage(value);
  return page === null ||
    page.items.some(
      (event) =>
        event.data.incidentId !== expectedIncidentId ||
        event.data.runId !== expectedRunId,
    )
    ? null
    : page;
}

export function parseIncidentDetailResponse(
  value: unknown,
): IncidentDetailView | null {
  if (
    !isObject(value) ||
    value.schemaVersion !== 3 ||
    !isValidEventId(value.eventCursor) ||
    !Array.isArray(value.evidence)
  ) {
    return null;
  }

  const incident = parseIncident(value.incident);
  const selectedRun = parseSelectedRun(value.selectedRun);
  const eventPage = parseEventPage(value.eventPage);
  const evidence = value.evidence.map(parseEvidence);
  const diagnosis =
    value.diagnosis === null ? null : parseDiagnosis(value.diagnosis);
  const alertSignal =
    value.alertSignal === null ? null : parseAlertSignal(value.alertSignal);
  if (
    incident === null ||
    selectedRun === null ||
    eventPage === null ||
    eventPage.items.some(
      (event) =>
        event.data.incidentId !== incident.id ||
        event.data.runId !== selectedRun.id,
    ) ||
    evidence.some((item) => item === null) ||
    (value.diagnosis !== null && diagnosis === null) ||
    (value.alertSignal !== null && alertSignal === null) ||
    (incident.source.type === "scenario" && value.alertSignal !== null) ||
    (incident.source.type === "alertmanager" && alertSignal === null)
  ) {
    return null;
  }

  return {
    incident,
    selectedRun,
    eventPage,
    eventCursor: value.eventCursor,
    evidence: evidence as EvidenceView[],
    diagnosis,
    alertSignal,
  };
}
