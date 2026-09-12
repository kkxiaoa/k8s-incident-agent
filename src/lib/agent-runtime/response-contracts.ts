import type { components } from "./generated";
import {
  isCanonicalAlertTimestamp,
  isValidEventId,
  parseRunEventItem,
  type RunEventStreamItem,
} from "./event-contracts";

type ApiDiagnosis = components["schemas"]["DiagnosisResponse"];
export type RuntimeHealthView = components["schemas"]["RuntimeHealthResponse"];
type ApiEvidence = components["schemas"]["EvidenceResponse"];
type ApiAlertSignal = components["schemas"]["AlertSignalResponse"];
type ApiRootCause = components["schemas"]["RootCauseResponse"];
type ApiRunError = components["schemas"]["RunErrorResponse"];
type ApiScenario = components["schemas"]["ScenarioResponse"];
type ApiMonitoringHealth = components["schemas"]["MonitoringHealthSnapshot"];
type ApiMonitoringOverview = components["schemas"]["MonitoringOverviewSnapshot"];
type ApiMonitoringOverviewCounts = components["schemas"]["MonitoringOverviewCounts"];
type ApiMonitoringOverviewFamily = components["schemas"]["MonitoringOverviewFamily"];
type ApiMonitoringOverviewSample = components["schemas"]["MonitoringOverviewSample"];
type ApiMetricPanel = components["schemas"]["MetricPanelResult"];
type ApiMetricMarker = components["schemas"]["MetricMarker"];
type ApiRepairProposal = components["schemas"]["RepairProposalResponse"];
type ApiRepairPatchOperation =
  components["schemas"]["RepairPatchOperationResponse"];
type ApiRepairValidation = components["schemas"]["RepairValidationResponse"];

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
  kind: components["schemas"]["RunKind"];
  operation: components["schemas"]["RepairOperation"] | null;
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

export type RepairProposalView = ApiRepairProposal;

export interface IncidentDetailView {
  incident: IncidentView;
  selectedRun: SelectedRunView;
  eventPage: EventPageView;
  eventCursor: string;
  evidence: EvidenceView[];
  diagnosis: DiagnosisView | null;
  repair: RepairProposalView | null;
  alertSignal: AlertSignalView | null;
}

export type MetricWindowView = components["schemas"]["MetricWindow"];
export type MetricPanelSignalRoleView =
  components["schemas"]["MetricPanelSignalRole"];
export type MetricQueryStateView = components["schemas"]["MetricQueryState"];
export type MonitoringComponentStateView =
  components["schemas"]["MonitoringComponentState"];
export type MonitoringOverallStateView =
  components["schemas"]["MonitoringOverallState"];

export type MonitoringHealthView = Pick<
  ApiMonitoringHealth,
  | "state"
  | "checkedAt"
  | "prometheus"
  | "kubeStateMetrics"
  | "ruleEvaluation"
  | "alertmanager"
  | "notification"
  | "watchdogLastReceivedAt"
>;

export interface MonitoringOverviewView {
  window: ApiMonitoringOverview["window"];
  generatedAt: string;
  counts: ApiMonitoringOverviewCounts;
  families: ApiMonitoringOverviewFamily[];
  samples: ApiMonitoringOverviewSample[];
}

export interface MonitoringPanelReferenceView {
  panelId: string;
  recommendedWindow: MetricWindowView;
  riskDirection: "higher_is_worse" | "lower_is_worse";
  signalRole: MetricPanelSignalRoleView;
  thresholdDuration: string | null;
}

export interface MonitoringPanelListView {
  panels: MonitoringPanelReferenceView[];
}

export type MetricSampleView = components["schemas"]["MetricSample"];
export type MetricMarkerView = Pick<
  ApiMetricMarker,
  "kind" | "occurredAt" | "runAttempt"
>;
export type MetricPanelResultView = Pick<
  ApiMetricPanel,
  | "riskDirection"
  | "panelId"
  | "title"
  | "unit"
  | "threshold"
  | "window"
  | "state"
  | "queriedAt"
  | "latestSampleAt"
  | "currentValue"
  | "samples"
>;

export interface IncidentMetricPanelView {
  result: MetricPanelResultView;
  markers: MetricMarkerView[];
  markersTruncated: boolean;
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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isMetricWindow(value: unknown): value is MetricWindowView {
  return (
    value === "15m" ||
    value === "1h" ||
    value === "6h" ||
    value === "7d" ||
    value === "15d"
  );
}

function isMetricQueryState(value: unknown): value is MetricQueryStateView {
  return (
    value === "ok" ||
    value === "no_data" ||
    value === "stale" ||
    value === "partial" ||
    value === "query_error" ||
    value === "monitoring_unavailable"
  );
}

function isMonitoringComponentState(
  value: unknown,
): value is MonitoringComponentStateView {
  return (
    value === "healthy" ||
    value === "degraded" ||
    value === "unavailable" ||
    value === "stale" ||
    value === "unknown"
  );
}

function isIncidentStatus(
  value: unknown,
): value is components["schemas"]["IncidentStatus"] {
  return (
    value === "RECEIVED" ||
    value === "TRIAGING" ||
    value === "DIAGNOSED" ||
    value === "PATCH_READY" ||
    value === "DRY_RUN_PASSED" ||
    value === "WAITING_APPROVAL" ||
    value === "INSUFFICIENT_EVIDENCE" ||
    value === "STALE_RESOURCE" ||
    value === "FAILED"
  );
}

function isRunStatus(
  value: unknown,
): value is components["schemas"]["RunStatus"] {
  return (
    value === "QUEUED" ||
    value === "RUNNING" ||
    value === "WAITING_APPROVAL" ||
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
    !(value.kind === "diagnosis"
      ? value.operation === null && value.status !== "WAITING_APPROVAL"
      : value.kind === "repair" && (value.operation === "apply" || value.operation === "rollback")) ||
    !isTimestamp(value.createdAt) ||
    (value.startedAt !== null && !isTimestamp(value.startedAt)) ||
    (value.completedAt !== null && !isTimestamp(value.completedAt))
  ) {
    return null;
  }

  return {
    id: value.id,
    kind: value.kind as SelectedRunView["kind"],
    operation: value.operation as SelectedRunView["operation"],
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

function parseRepairPatchOperation(
  value: unknown,
): ApiRepairPatchOperation | null {
  return isObject(value) &&
    (value.op === "test" || value.op === "replace") &&
    typeof value.path === "string" &&
    value.path.startsWith("/") &&
    typeof value.value === "string"
    ? { op: value.op, path: value.path, value: value.value }
    : null;
}

function isPatchValidationErrorCode(
  value: unknown,
): value is components["schemas"]["PatchValidationErrorCode"] {
  return (
    value === "stale_resource" ||
    value === "patch_validator_authentication_failed" ||
    value === "patch_validator_replay_rejected" ||
    value === "patch_validator_permission_denied" ||
    value === "patch_validator_admission_denied" ||
    value === "patch_validator_timeout" ||
    value === "patch_validator_upstream_failed" ||
    value === "patch_validator_contract_invalid"
  );
}

function parseRepairValidation(value: unknown): ApiRepairValidation | null {
  if (
    !isObject(value) ||
    (value.outcome !== "passed" && value.outcome !== "failed") ||
    !isTimestamp(value.checkedAt)
  ) {
    return null;
  }
  if (value.outcome === "passed") {
    return value.error === null
      ? { outcome: "passed", checkedAt: value.checkedAt, error: null }
      : null;
  }
  if (
    !isObject(value.error) ||
    !isPatchValidationErrorCode(value.error.code) ||
    typeof value.error.retryable !== "boolean"
  ) {
    return null;
  }
  return {
    outcome: "failed",
    checkedAt: value.checkedAt,
    error: { code: value.error.code, retryable: value.error.retryable },
  };
}

function parseRepairProposal(value: unknown): RepairProposalView | null {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    !isUuid(value.id) ||
    value.action !== "set_container_image" ||
    !isNonNegativeInteger(value.containerIndex) ||
    value.containerIndex > 255 ||
    typeof value.containerName !== "string" ||
    value.containerName.length === 0 ||
    value.containerName.length > 253 ||
    typeof value.currentImage !== "string" ||
    value.currentImage.length === 0 ||
    value.currentImage.length > 2048 ||
    typeof value.replacementImage !== "string" ||
    value.replacementImage.length === 0 ||
    value.replacementImage.length > 2048 ||
    value.currentImage === value.replacementImage ||
    typeof value.targetUid !== "string" ||
    value.targetUid.length === 0 ||
    value.targetUid.length > 253 ||
    typeof value.targetResourceVersion !== "string" ||
    value.targetResourceVersion.length === 0 ||
    value.targetResourceVersion.length > 253 ||
    typeof value.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.digest) ||
    !isTimestamp(value.schemaCheckedAt) ||
    !isTimestamp(value.policyCheckedAt) ||
    !isTimestamp(value.diffCheckedAt) ||
    !Array.isArray(value.evidenceIds) ||
    value.evidenceIds.length !== 2 ||
    !value.evidenceIds.every(isUuid) ||
    new Set(value.evidenceIds).size !== 2 ||
    !Array.isArray(value.patch) ||
    value.patch.length !== 5 ||
    !isObject(value.target) ||
    typeof value.target.cluster !== "string" ||
    value.target.cluster.length === 0 ||
    value.target.namespace === null ||
    typeof value.target.namespace !== "string" ||
    typeof value.target.apiVersion !== "string" ||
    value.target.apiVersion !== "apps/v1" ||
    value.target.kind !== "Deployment" ||
    typeof value.target.name !== "string" ||
    value.target.name.length === 0 ||
    !isObject(value.diff)
  ) {
    return null;
  }
  const patch = value.patch.map(parseRepairPatchOperation);
  const validation = parseRepairValidation(value.validation);
  const imagePath =
    `/spec/template/spec/containers/${value.containerIndex}/image`;
  const expectedPatch: ApiRepairPatchOperation[] = [
    { op: "test", path: "/metadata/uid", value: value.targetUid },
    {
      op: "test",
      path: "/metadata/resourceVersion",
      value: value.targetResourceVersion,
    },
    {
      op: "test",
      path: `/spec/template/spec/containers/${value.containerIndex}/name`,
      value: value.containerName,
    },
    { op: "test", path: imagePath, value: value.currentImage },
    { op: "replace", path: imagePath, value: value.replacementImage },
  ];
  const gateTimes = [
    Date.parse(value.schemaCheckedAt),
    Date.parse(value.policyCheckedAt),
    Date.parse(value.diffCheckedAt),
  ];
  if (
    patch.some((operation) => operation === null) ||
    JSON.stringify(patch) !== JSON.stringify(expectedPatch) ||
    value.diff.path !== imagePath ||
    value.diff.before !== value.currentImage ||
    value.diff.after !== value.replacementImage ||
    validation === null ||
    gateTimes[0] > gateTimes[1] ||
    gateTimes[1] > gateTimes[2] ||
    Date.parse(validation.checkedAt) < gateTimes[2]
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    id: value.id,
    action: "set_container_image",
    target: {
      cluster: value.target.cluster,
      namespace: value.target.namespace,
      apiVersion: "apps/v1",
      kind: "Deployment",
      name: value.target.name,
    },
    targetUid: value.targetUid,
    targetResourceVersion: value.targetResourceVersion,
    containerIndex: value.containerIndex,
    containerName: value.containerName,
    currentImage: value.currentImage,
    replacementImage: value.replacementImage,
    evidenceIds: value.evidenceIds,
    patch: patch as ApiRepairPatchOperation[],
    digest: value.digest,
    diff: {
      path: value.diff.path,
      before: value.diff.before,
      after: value.diff.after,
    },
    schemaCheckedAt: value.schemaCheckedAt,
    policyCheckedAt: value.policyCheckedAt,
    diffCheckedAt: value.diffCheckedAt,
    validation,
  };
}

export function parseCreateIncidentResponse(
  value: unknown,
): CreateIncidentView | null {
  return isObject(value) && value.schemaVersion === 5 && isUuid(value.incidentId)
    ? { incidentId: value.incidentId }
    : null;
}

export function parseCreateRunResponse(value: unknown): CreateRunView | null {
  return isObject(value) && value.schemaVersion === 5 && isUuid(value.runId)
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
    value.schemaVersion !== 5 ||
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
    value.schemaVersion !== 5 ||
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
  if (!isObject(value) || value.schemaVersion !== 5) {
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
    value.schemaVersion !== 5 ||
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
  const repair = value.repair === null ? null : parseRepairProposal(value.repair);
  const alertSignal =
    value.alertSignal === null ? null : parseAlertSignal(value.alertSignal);
  if (
    incident === null ||
    selectedRun === null ||
    eventPage === null ||
    eventPage.items.some(
      (event) =>
        event.data.incidentId !== incident.id ||
        event.data.runId !== selectedRun.id ||
        event.data.runKind !== selectedRun.kind,
    ) ||
    evidence.some((item) => item === null) ||
    (value.diagnosis !== null && diagnosis === null) ||
    (selectedRun.kind === "repair" && diagnosis !== null) ||
    (value.repair !== null && repair === null) ||
    (value.alertSignal !== null && alertSignal === null) ||
    (incident.source.type === "scenario" && value.alertSignal !== null) ||
    (incident.source.type === "alertmanager" && alertSignal === null)
  ) {
    return null;
  }
  if (repair !== null) {
    const evidenceIds = new Set(
      (evidence as EvidenceView[]).map((item) => item.id),
    );
    const passed = repair.validation.outcome === "passed";
    if (
      (selectedRun.kind === "diagnosis" && diagnosis?.outcome !== "diagnosed") ||
      repair.target.kind !== incident.target.kind ||
      repair.target.namespace !== incident.target.namespace ||
      repair.target.name !== incident.target.name ||
      repair.evidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId)) ||
      (passed && selectedRun.kind === "diagnosis" &&
        (selectedRun.status !== "COMPLETED" ||
          selectedRun.error !== null)) ||
      (!passed &&
        (selectedRun.status !== "FAILED" ||
          selectedRun.error?.code !== repair.validation.error?.code ||
          selectedRun.error?.retryable !==
            repair.validation.error?.retryable))
    ) {
      return null;
    }
  }

  return {
    incident,
    selectedRun,
    eventPage,
    eventCursor: value.eventCursor,
    evidence: evidence as EvidenceView[],
    diagnosis,
    repair,
    alertSignal,
  };
}

export function parseRuntimeHealthResponse(value: unknown): RuntimeHealthView | null {
  if (!isObject(value) || value.status !== "ok" || !isObject(value.diagnosis)) {
    return null;
  }
  const { status, reason } = value.diagnosis;
  if (status === "ready" && reason === null) {
    return { status: "ok", diagnosis: { status, reason } };
  }
  if (status !== "unavailable") return null;
  switch (reason) {
    case "configuration_invalid":
    case "authentication_failed":
    case "model_not_found":
    case "provider_rate_limited":
    case "provider_unavailable":
    case "provider_contract_invalid":
    case "tool_arguments_invalid":
    case "structured_output_invalid":
    case "reasoning_roundtrip_failed":
      return { status: "ok", diagnosis: { status, reason } };
    default:
      return null;
  }
}

export function parseMonitoringHealthResponse(
  value: unknown,
): MonitoringHealthView | null {
  if (
    !isObject(value) ||
    (value.state !== "healthy" &&
      value.state !== "degraded" &&
      value.state !== "unavailable") ||
    !isTimestamp(value.checkedAt) ||
    !isMonitoringComponentState(value.prometheus) ||
    !isMonitoringComponentState(value.kubeStateMetrics) ||
    !isMonitoringComponentState(value.ruleEvaluation) ||
    !isMonitoringComponentState(value.alertmanager) ||
    !isMonitoringComponentState(value.notification) ||
    (value.watchdogLastReceivedAt !== null &&
      !isTimestamp(value.watchdogLastReceivedAt))
  ) {
    return null;
  }
  return {
    state: value.state,
    checkedAt: value.checkedAt,
    prometheus: value.prometheus,
    kubeStateMetrics: value.kubeStateMetrics,
    ruleEvaluation: value.ruleEvaluation,
    alertmanager: value.alertmanager,
    notification: value.notification,
    watchdogLastReceivedAt: value.watchdogLastReceivedAt,
  };
}

export function parseMonitoringOverviewResponse(
  value: unknown,
): MonitoringOverviewView | null {
  if (
    !isObject(value) ||
    value.schemaVersion !== 2 ||
    value.window !== "24h" ||
    !isTimestamp(value.generatedAt) ||
    !isObject(value.counts) ||
    !Array.isArray(value.families) ||
    value.families.length > 64 ||
    !Array.isArray(value.samples) ||
    value.samples.length !== 24
  ) {
    return null;
  }
  const counts = value.counts;
  if (
    !isNonNegativeInteger(counts.totalIncidents) ||
    !isNonNegativeInteger(counts.firingAlerts) ||
    !isNonNegativeInteger(counts.triagingIncidents) ||
    !isNonNegativeInteger(counts.waitingApprovalIncidents)
  ) {
    return null;
  }
  const families: ApiMonitoringOverviewFamily[] = [];
  const familyRefs = new Set<string>();
  for (const family of value.families) {
    if (
      !isObject(family) ||
      typeof family.sourceRef !== "string" ||
      family.sourceRef.length === 0 ||
      family.sourceRef.length > 128 ||
      typeof family.displayName !== "string" ||
      family.displayName.length === 0 ||
      family.displayName.length > 160 ||
      !isPositiveInteger(family.count) ||
      familyRefs.has(family.sourceRef)
    ) {
      return null;
    }
    familyRefs.add(family.sourceRef);
    families.push({
      sourceRef: family.sourceRef,
      displayName: family.displayName,
      count: family.count,
    });
  }
  if (
    families.reduce((total, family) => total + family.count, 0) !==
    counts.firingAlerts
  ) {
    return null;
  }
  const samples: ApiMonitoringOverviewSample[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const sample of value.samples) {
    if (
      !isObject(sample) ||
      !isTimestamp(sample.timestamp) ||
      !isNonNegativeInteger(sample.incidentsCreated) ||
      !isNonNegativeInteger(sample.alertConditionsResolved)
    ) {
      return null;
    }
    const timestamp = Date.parse(sample.timestamp);
    if (
      timestamp % 3_600_000 !== 0 ||
      (previous !== Number.NEGATIVE_INFINITY &&
        timestamp - previous !== 3_600_000)
    ) {
      return null;
    }
    previous = timestamp;
    samples.push({
      timestamp: sample.timestamp,
      incidentsCreated: sample.incidentsCreated,
      alertConditionsResolved: sample.alertConditionsResolved,
    });
  }
  const generatedAt = Date.parse(value.generatedAt);
  const currentHour = Math.floor(generatedAt / 3_600_000) * 3_600_000;
  if (previous !== currentHour) {
    return null;
  }
  return {
    window: "24h",
    generatedAt: value.generatedAt,
    counts: {
      totalIncidents: counts.totalIncidents,
      firingAlerts: counts.firingAlerts,
      triagingIncidents: counts.triagingIncidents,
      waitingApprovalIncidents: counts.waitingApprovalIncidents,
    },
    families,
    samples,
  };
}

function parseMonitoringPanelReference(
  value: unknown,
): MonitoringPanelReferenceView | null {
  const thresholdDuration = isObject(value) ? value.thresholdDuration : undefined;
  return isObject(value) &&
    typeof value.panelId === "string" &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.panelId) &&
    value.panelId.length <= 128 &&
    isMetricWindow(value.recommendedWindow) &&
    (value.riskDirection === "higher_is_worse" ||
      value.riskDirection === "lower_is_worse") &&
    (value.signalRole === "trigger" || value.signalRole === "context") &&
    (thresholdDuration === null ||
      (typeof thresholdDuration === "string" &&
        /^[1-9][0-9]*(?:ms|s|m|h)$/.test(thresholdDuration)))
    ? {
        panelId: value.panelId,
        recommendedWindow: value.recommendedWindow,
        riskDirection: value.riskDirection,
        signalRole: value.signalRole,
        thresholdDuration,
      }
    : null;
}

export function parseMonitoringPanelListResponse(
  value: unknown,
): MonitoringPanelListView | null {
  if (
    !isObject(value) ||
    value.schemaVersion !== 3 ||
    !Array.isArray(value.panels) ||
    value.panels.length > 8
  ) {
    return null;
  }
  const panels = value.panels.map(parseMonitoringPanelReference);
  if (
    panels.some((panel) => panel === null) ||
    new Set(panels.map((panel) => panel?.panelId)).size !== panels.length
  ) {
    return null;
  }
  return { panels: panels as MonitoringPanelReferenceView[] };
}

function parseMetricSamples(value: unknown): MetricSampleView[] | null {
  if (!Array.isArray(value) || value.length > 512) {
    return null;
  }
  const samples: MetricSampleView[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const sample of value) {
    if (
      !isObject(sample) ||
      !isTimestamp(sample.timestamp) ||
      !isFiniteNumber(sample.value)
    ) {
      return null;
    }
    const timestamp = Date.parse(sample.timestamp);
    if (timestamp <= previous) {
      return null;
    }
    previous = timestamp;
    samples.push({ timestamp: sample.timestamp, value: sample.value });
  }
  return samples;
}

function parseMetricMarker(value: unknown): MetricMarkerView | null {
  if (
    !isObject(value) ||
    (value.kind !== "alert_firing" &&
      value.kind !== "alert_resolved" &&
      value.kind !== "run_started" &&
      value.kind !== "run_completed") ||
    !isTimestamp(value.occurredAt)
  ) {
    return null;
  }
  const runMarker = value.kind === "run_started" || value.kind === "run_completed";
  let runAttempt: number | null;
  if (runMarker) {
    if (!isPositiveInteger(value.runAttempt)) {
      return null;
    }
    runAttempt = value.runAttempt;
  } else {
    if (value.runAttempt !== null) {
      return null;
    }
    runAttempt = null;
  }
  return {
    kind: value.kind,
    occurredAt: value.occurredAt,
    runAttempt,
  };
}

function metricWindowMilliseconds(window: MetricWindowView): number {
  return window === "15m"
    ? 15 * 60_000
    : window === "1h"
      ? 60 * 60_000
      : window === "6h"
        ? 6 * 60 * 60_000
        : window === "7d"
          ? 7 * 24 * 60 * 60_000
          : 15 * 24 * 60 * 60_000;
}

export function parseIncidentMetricPanelResponse(
  value: unknown,
  expectedPanelId: string,
  expectedWindow: MetricWindowView,
): IncidentMetricPanelView | null {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.markersTruncated !== "boolean" ||
    !Array.isArray(value.markers) ||
    value.markers.length > 102 ||
    !isObject(value.result)
  ) {
    return null;
  }
  const result = value.result;
  if (
    result.panelId !== expectedPanelId ||
    result.window !== expectedWindow ||
    typeof result.title !== "string" ||
    result.title.length === 0 ||
    result.title.length > 160 ||
    typeof result.unit !== "string" ||
    result.unit.length === 0 ||
    result.unit.length > 32 ||
    (result.riskDirection !== "higher_is_worse" &&
      result.riskDirection !== "lower_is_worse") ||
    (result.threshold !== null && !isFiniteNumber(result.threshold)) ||
    (result.riskDirection === "higher_is_worse" && result.threshold === null) ||
    !isMetricQueryState(result.state) ||
    !isTimestamp(result.queriedAt) ||
    (result.latestSampleAt !== null && !isTimestamp(result.latestSampleAt)) ||
    (result.currentValue !== null && !isFiniteNumber(result.currentValue))
  ) {
    return null;
  }
  const samples = parseMetricSamples(result.samples);
  if (samples === null) {
    return null;
  }
  const populated =
    samples.length > 0 &&
    result.latestSampleAt !== null &&
    result.currentValue !== null;
  const empty =
    samples.length === 0 &&
    result.latestSampleAt === null &&
    result.currentValue === null;
  if (
    (!populated && !empty) ||
    ((result.state === "no_data" ||
      result.state === "query_error" ||
      result.state === "monitoring_unavailable") &&
      !empty) ||
    ((result.state === "ok" || result.state === "stale") && !populated) ||
    (populated &&
      (result.latestSampleAt !== samples.at(-1)?.timestamp ||
        result.currentValue !== samples.at(-1)?.value))
  ) {
    return null;
  }
  const queriedAt = Date.parse(result.queriedAt);
  const windowStart = queriedAt - metricWindowMilliseconds(expectedWindow);
  if (
    populated &&
    (Date.parse(result.latestSampleAt as string) > queriedAt ||
      samples.some((sample) => Date.parse(sample.timestamp) < windowStart))
  ) {
    return null;
  }
  const markers = value.markers.map(parseMetricMarker);
  if (markers.some((marker) => marker === null)) {
    return null;
  }
  let previousMarker = Number.NEGATIVE_INFINITY;
  for (const marker of markers as MetricMarkerView[]) {
    const timestamp = Date.parse(marker.occurredAt);
    if (
      timestamp < windowStart ||
      timestamp > queriedAt ||
      timestamp < previousMarker
    ) {
      return null;
    }
    previousMarker = timestamp;
  }
  return {
    result: {
      panelId: expectedPanelId,
      title: result.title,
      unit: result.unit,
      threshold: result.threshold,
      riskDirection: result.riskDirection,
      window: expectedWindow,
      state: result.state,
      queriedAt: result.queriedAt,
      latestSampleAt: result.latestSampleAt,
      currentValue: result.currentValue,
      samples,
    },
    markers: markers as MetricMarkerView[],
    markersTruncated: value.markersTruncated,
  };
}
