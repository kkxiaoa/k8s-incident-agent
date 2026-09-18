import type { components } from "./generated";
import { isVerificationOutcome, isVerificationReason, type VerificationView } from "./verification-contracts";
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
  requestSource?: "system" | "operator" | null;
  initiatedByYou?: boolean;
  sourceRunId?: string | null;
  selection?: components["schemas"]["RepairHistorySelectionResponse"] | null;
  waitingExpiresAt?: string | null;
  endReason?: "expired" | "superseded" | "rejected" | "execution_expired" | "withdrawn" | null;
}

export type RunSummaryView = Omit<SelectedRunView, "error" | "selection" | "waitingExpiresAt" | "endReason">;

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
export type IncidentActionsView = components["schemas"]["IncidentActions"];
export type RepairRunRequest = components["schemas"]["CreateRepairRunRequest"];
export type ApprovalRequest = components["schemas"]["ApprovalRequest"];

export interface IncidentDetailView {
  incident: IncidentView;
  selectedRun: SelectedRunView;
  eventPage: EventPageView;
  eventCursor: string;
  evidence: EvidenceView[];
  diagnosis: DiagnosisView | null;
  repair: RepairProposalView | null;
  approval?: components["schemas"]["ApprovalResponse"] | null;
  verification?: VerificationView | null;
  actions: IncidentActionsView;
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
  | "healthAlerts"
>;

export interface MonitoringOverviewView {
  window: ApiMonitoringOverview["window"];
  generatedAt: string;
  counts: ApiMonitoringOverviewCounts;
  families: ApiMonitoringOverviewFamily[];
  samples: ApiMonitoringOverviewSample[];
}

export type MetricRiskDirectionView = components["schemas"]["MetricRiskDirection"];
export type MetricSeriesBindingView =
  components["schemas"]["MetricSeriesBinding"];
export type MetricTimeAnchorView = components["schemas"]["MetricTimeAnchor"];

export interface MonitoringPanelReferenceView {
  panelId: string;
  title: string;
  unit: string;
  purpose: string;
  seriesBinding: MetricSeriesBindingView;
  recommendedWindow: MetricWindowView;
  riskDirection: MetricRiskDirectionView;
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
export type MetricSeriesView = components["schemas"]["MetricSeries"];
export type MetricPanelResultView = Pick<
  ApiMetricPanel,
  | "riskDirection"
  | "panelId"
  | "title"
  | "unit"
  | "purpose"
  | "threshold"
  | "seriesBinding"
  | "window"
  | "anchor"
  | "state"
  | "queriedAt"
  | "rangeStart"
  | "rangeEnd"
  | "latestSampleAt"
  | "currentValue"
  | "series"
>;

const SERIES_LABEL_NAMES = new Set(["pod", "uid", "container", "series"]);
const SERIES_LABEL_SETS: Record<MetricSeriesBindingView, string[][]> = {
  target: [[]],
  pod: [["pod", "uid"]],
  pod_container: [
    ["container", "pod", "uid"],
    ["container", "pod", "series", "uid"],
  ],
};

export function isMetricRiskDirection(
  value: unknown,
): value is MetricRiskDirectionView {
  return (
    value === "higher_is_worse" ||
    value === "lower_is_worse" ||
    value === "neutral"
  );
}

export function isMetricSeriesBinding(
  value: unknown,
): value is MetricSeriesBindingView {
  return value === "target" || value === "pod" || value === "pod_container";
}


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
    value === "APPLYING" ||
    value === "VERIFYING" ||
    value === "RESOLVED" ||
    value === "ROLLED_BACK" ||
    value === "REJECTED" ||
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
    || (value.requestSource !== undefined && value.requestSource !== null && value.requestSource !== "system" && value.requestSource !== "operator")
    || (value.initiatedByYou !== undefined && typeof value.initiatedByYou !== "boolean")
    || (value.sourceRunId !== undefined && value.sourceRunId !== null && !isUuid(value.sourceRunId))
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
    ...(value.requestSource !== undefined ? { requestSource: value.requestSource as SelectedRunView["requestSource"] } : {}),
    ...(value.initiatedByYou !== undefined ? { initiatedByYou: value.initiatedByYou as boolean } : {}),
    ...(value.sourceRunId !== undefined ? { sourceRunId: value.sourceRunId as string | null } : {}),
  };
}

function parseSelectedRun(value: unknown): SelectedRunView | null {
  const run = parseRunBase(value);
  if (run === null || !isObject(value)) {
    return null;
  }

  const error = value.error === null ? null : parseRunError(value.error);
  if (value.error !== null && error === null) return null;
  if (value.waitingExpiresAt !== undefined && value.waitingExpiresAt !== null && !isTimestamp(value.waitingExpiresAt)) return null;
  if (value.endReason !== undefined && value.endReason !== null && value.endReason !== "expired" && value.endReason !== "superseded" && value.endReason !== "rejected" && value.endReason !== "execution_expired" && value.endReason !== "withdrawn") return null;
  const selection = value.selection;
  if (selection !== undefined && selection !== null && !isHistorySelection(selection)) return null;
  return {
    ...run, error,
    ...(selection !== undefined ? { selection: selection as SelectedRunView["selection"] } : {}),
    ...(value.waitingExpiresAt !== undefined ? { waitingExpiresAt: value.waitingExpiresAt as string | null } : {}),
    ...(value.endReason !== undefined ? { endReason: value.endReason as SelectedRunView["endReason"] } : {}),
  };
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
    (value.sourceExecutionId != null && !isUuid(value.sourceExecutionId)) ||
    value.evidenceIds.length !== (value.sourceExecutionId != null ? 1 : 2) ||
    !value.evidenceIds.every(isUuid) ||
    new Set(value.evidenceIds).size !== value.evidenceIds.length ||
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
    ...(value.sourceExecutionId !== undefined ? { sourceExecutionId: value.sourceExecutionId as string | null } : {}),
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

function parseExecutionResult(value: unknown): components["schemas"]["ExecutionResultResponse"] | null {
  if (!isObject(value)) return null;
  if (value.outcome === "APPLIED") {
    const receipt = value.receipt;
    if (value.error !== null || !isObject(receipt) || typeof receipt.uid !== "string" || !receipt.uid || typeof receipt.resourceVersion !== "string" || !receipt.resourceVersion || !Number.isSafeInteger(receipt.generation) || (receipt.generation as number) < 1 || !Number.isSafeInteger(receipt.beforeGeneration) || (receipt.beforeGeneration as number) < 1) return null;
    return { outcome: "APPLIED", error: null, receipt: { uid: receipt.uid, resourceVersion: receipt.resourceVersion, generation: receipt.generation as number, beforeGeneration: receipt.beforeGeneration as number } };
  }
  if (value.receipt !== null) return null;
  if (value.outcome === "UNKNOWN" && value.error === "outcome_unknown") return { outcome: "UNKNOWN", receipt: null, error: "outcome_unknown" };
  if (value.outcome === "STALE_RESOURCE" && value.error === "precondition_failed") return { outcome: "STALE_RESOURCE", receipt: null, error: "precondition_failed" };
  if (value.outcome === "REJECTED" && (value.error === "permission_denied" || value.error === "admission_denied" || value.error === "precondition_failed" || value.error === "upstream_failed")) return { outcome: "REJECTED", receipt: null, error: value.error };
  return null;
}

export function parseApprovalResponse(value: unknown): components["schemas"]["ApprovalResponse"] | null {
  if (!isObject(value) || !isUuid(value.id) || !isUuid(value.runId) || !isUuid(value.proposalId) || typeof value.proposalDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.proposalDigest) || typeof value.validationDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.validationDigest) || (value.decision !== "approve" && value.decision !== "reject") || typeof value.actor !== "string" || !value.actor || !isTimestamp(value.decidedAt) || !isTimestamp(value.expiresAt)) return null;
  let execution: components["schemas"]["ExecutionResponse"] | null = null;
  if (value.execution !== null) {
    const item = value.execution;
    if (!isObject(item) || !isUuid(item.id) || (item.status !== "PENDING" && item.status !== "CLAIMED" && item.status !== "APPLIED" && item.status !== "EXPIRED" && item.status !== "STALE_RESOURCE" && item.status !== "REJECTED" && item.status !== "UNKNOWN") || !isTimestamp(item.startBefore) || (item.claimedAt !== null && !isTimestamp(item.claimedAt)) || (item.reportedAt !== null && !isTimestamp(item.reportedAt))) return null;
    const result = item.result === null ? null : parseExecutionResult(item.result);
    const lateResult = item.lateResult === null ? null : parseExecutionResult(item.lateResult);
    if ((item.result !== null && result === null) || (item.lateResult !== null && lateResult === null) || (item.status === "APPLIED" && result?.outcome !== "APPLIED") || (lateResult !== null && (item.status !== "UNKNOWN" || lateResult.outcome !== "APPLIED"))) return null;
    execution = { id: item.id, status: item.status, startBefore: item.startBefore, claimedAt: item.claimedAt, reportedAt: item.reportedAt, result, lateResult };
  }
  if ((value.decision === "approve") !== (execution !== null)) return null;
  return { id: value.id, runId: value.runId, proposalId: value.proposalId, proposalDigest: value.proposalDigest, validationDigest: value.validationDigest, decision: value.decision, actor: value.actor, decidedAt: value.decidedAt, expiresAt: value.expiresAt, execution };
}

function parseVerification(value: unknown): VerificationView | null {
  if (!isObject(value) || !isUuid(value.executionId) || !isTimestamp(value.startedAt) || !isTimestamp(value.deadlineAt) ||
      !isVerificationOutcome(value.outcome) || !isVerificationReason(value.reason) ||
      !Number.isInteger(value.sampleCount) || (value.sampleCount as number) < 0 || (value.sampleCount as number) > 120 ||
      (value.completedAt !== null && !isTimestamp(value.completedAt)) ||
      (value.lastObservedAt !== null && !isTimestamp(value.lastObservedAt)) ||
      (value.healthySince !== null && !isTimestamp(value.healthySince))) return null;
  if (Date.parse(value.deadlineAt) - Date.parse(value.startedAt) !== 600_000 ||
      (value.outcome === "observing") !== (value.completedAt === null) ||
      (value.sampleCount === 0) !== (value.lastObservedAt === null) ||
      (value.lastObservedAt !== null && (Date.parse(value.lastObservedAt) < Date.parse(value.startedAt) || Date.parse(value.lastObservedAt) >= Date.parse(value.deadlineAt))) ||
      (value.healthySince !== null && (value.lastObservedAt === null || Date.parse(value.healthySince) < Date.parse(value.startedAt) || Date.parse(value.healthySince) > Date.parse(value.lastObservedAt))) ||
      (value.completedAt !== null && Date.parse(value.completedAt) < Date.parse(value.lastObservedAt ?? value.startedAt)) ||
      (value.outcome !== "observing" && value.outcome !== "recovered" && value.reason === null) ||
      (value.outcome === "recovered" && (value.healthySince === null || value.lastObservedAt === null ||
       value.reason !== null || (value.sampleCount as number) < 13 || Date.parse(value.lastObservedAt) - Date.parse(value.healthySince) < 60_000))) return null;
  return { executionId: value.executionId, startedAt: value.startedAt, deadlineAt: value.deadlineAt,
    completedAt: value.completedAt, outcome: value.outcome, reason: value.reason, sampleCount: value.sampleCount as number,
    lastObservedAt: value.lastObservedAt, healthySince: value.healthySince };
}

function isHistorySelection(value: unknown): value is components["schemas"]["RepairHistorySelectionResponse"] {
  return isObject(value) && typeof value.revision === "string" && /^[1-9][0-9]{0,18}$/.test(value.revision)
    && BigInt(value.revision) <= BigInt("9223372036854775807")
    && typeof value.replicaSetUid === "string" && value.replicaSetUid.length > 0 && value.replicaSetUid.length <= 253
    && value.replicaSetUid.trim() === value.replicaSetUid && !/[\x00-\x1f\x7f]/.test(value.replicaSetUid);
}

function parseIncidentActions(value: unknown): IncidentActionsView | null {
  if (!isObject(value) || !Array.isArray(value.historyCandidates)) return null;
  const reasons: ReadonlyArray<Exclude<IncidentActionsView["approve"], null>> = [
    "not_applicable", "active_run", "execution_held", "target_occupied", "execution_disabled",
    "outside_scope", "proposal_expired", "no_history_candidates", "diagnosis_unavailable",
    "authentication_required", "not_owner",
  ];
  const keys = ["prepare", "refresh", "edit", "approve", "reject", "rerun", "rollback"] as const;
  if (keys.some((key) => value[key] !== null && !reasons.some((reason) => reason === value[key]))) return null;
  if (value.withdraw !== undefined && value.withdraw !== null && !reasons.some((reason) => reason === value.withdraw)) return null;
  const source = value.preparationSource;
  if (source !== null && (!isObject(source) || !isUuid(source.sourceRunId)
    || (source.sourceExecutionId !== null && !isUuid(source.sourceExecutionId)))) return null;
  const candidates: IncidentActionsView["historyCandidates"] = [];
  for (const candidate of value.historyCandidates) {
    if (!isObject(candidate) || typeof candidate.image !== "string" || !candidate.image) return null;
    const image = candidate.image;
    if (!isHistorySelection(candidate)) return null;
    candidates.push({ revision: candidate.revision, replicaSetUid: candidate.replicaSetUid, image });
  }
  return {
    prepare: value.prepare as IncidentActionsView["prepare"], refresh: value.refresh as IncidentActionsView["refresh"],
    edit: value.edit as IncidentActionsView["edit"], approve: value.approve as IncidentActionsView["approve"],
    reject: value.reject as IncidentActionsView["reject"], rerun: value.rerun as IncidentActionsView["rerun"],
    rollback: value.rollback as IncidentActionsView["rollback"],
    withdraw: value.withdraw === undefined ? "not_applicable" : value.withdraw as IncidentActionsView["withdraw"],
    preparationSource: source === null ? null : {
      sourceRunId: source.sourceRunId as string, sourceExecutionId: source.sourceExecutionId as string | null,
    }, historyCandidates: candidates,
  };
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
  const actions = parseIncidentActions(value.actions);
  if (actions === null) return null;
  const selectedRun = parseSelectedRun(value.selectedRun);
  const eventPage = parseEventPage(value.eventPage);
  const evidence = value.evidence.map(parseEvidence);
  const diagnosis =
    value.diagnosis === null ? null : parseDiagnosis(value.diagnosis);
  const repair = value.repair === null ? null : parseRepairProposal(value.repair);
  const approval = value.approval == null ? null : parseApprovalResponse(value.approval);
  const verification = value.verification == null ? null : parseVerification(value.verification);
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
    (value.approval != null && approval === null) ||
    (value.verification != null && verification === null) ||
    (verification !== null && (selectedRun.kind !== "repair" || approval?.execution?.status !== "APPLIED" ||
      verification.executionId !== approval.execution.id || approval.execution.reportedAt === null || Date.parse(verification.startedAt) !== Date.parse(approval.execution.reportedAt) || selectedRun.status !== (verification.outcome === "observing" ? "RUNNING" : verification.outcome === "recovered" || selectedRun.operation === "rollback" ? "COMPLETED" : "FAILED"))) ||
    (approval !== null && (selectedRun.kind !== "repair" || approval.runId !== selectedRun.id || approval.proposalId !== repair?.id || approval.proposalDigest !== repair?.digest)) ||
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
      (selectedRun.operation === "rollback") !== (repair.sourceExecutionId != null) ||
      (repair.sourceExecutionId != null && (!selectedRun.sourceRunId || repair.sourceExecutionId === approval?.execution?.id)) ||
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
    ...(value.approval !== undefined ? { approval } : {}),
    ...(value.verification !== undefined ? { verification } : {}),
    actions,
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

function parseMonitoringHealthAlerts(
  value: unknown,
): MonitoringHealthView["healthAlerts"] | null {
  if (!Array.isArray(value) || value.length > 16) {
    return null;
  }
  const alerts: MonitoringHealthView["healthAlerts"] = [];
  for (const item of value) {
    if (
      !isObject(item) ||
      !isBoundedText(item.alertId, 128) ||
      !isBoundedText(item.displayName, 160) ||
      (item.component !== "collection" && item.component !== "rules") ||
      !isTimestamp(item.activeSince)
    ) {
      return null;
    }
    alerts.push({
      alertId: item.alertId,
      displayName: item.displayName,
      component: item.component,
      activeSince: item.activeSince,
    });
  }
  return alerts;
}

export function parseMonitoringHealthResponse(
  value: unknown,
): MonitoringHealthView | null {
  if (!isObject(value)) {
    return null;
  }
  const healthAlerts = parseMonitoringHealthAlerts(value.healthAlerts);
  if (
    healthAlerts === null ||
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
    healthAlerts,
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

function isBoundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function parseMonitoringPanelReference(
  value: unknown,
): MonitoringPanelReferenceView | null {
  const thresholdDuration = isObject(value) ? value.thresholdDuration : undefined;
  return isObject(value) &&
    typeof value.panelId === "string" &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.panelId) &&
    value.panelId.length <= 128 &&
    isBoundedText(value.title, 160) &&
    isBoundedText(value.unit, 32) &&
    isBoundedText(value.purpose, 320) &&
    isMetricSeriesBinding(value.seriesBinding) &&
    isMetricWindow(value.recommendedWindow) &&
    isMetricRiskDirection(value.riskDirection) &&
    (value.signalRole === "trigger" || value.signalRole === "context") &&
    (thresholdDuration === null ||
      (typeof thresholdDuration === "string" &&
        /^[1-9][0-9]*(?:ms|s|m|h)$/.test(thresholdDuration)))
    ? {
        panelId: value.panelId,
        title: value.title,
        unit: value.unit,
        purpose: value.purpose,
        seriesBinding: value.seriesBinding,
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
    value.schemaVersion !== 4 ||
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

function parseMetricSamples(
  value: unknown,
  rangeStart: number,
  rangeEnd: number,
): MetricSampleView[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) {
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
    if (timestamp <= previous || timestamp < rangeStart || timestamp > rangeEnd) {
      return null;
    }
    previous = timestamp;
    samples.push({ timestamp: sample.timestamp, value: sample.value });
  }
  return samples;
}

function parseMetricSeries(
  value: unknown,
  binding: MetricSeriesBindingView,
  rangeStart: number,
  rangeEnd: number,
): MetricSeriesView[] | null {
  if (!Array.isArray(value) || value.length > 8) {
    return null;
  }
  const identities = new Set<string>();
  const series: MetricSeriesView[] = [];
  for (const item of value) {
    if (!isObject(item) || !isObject(item.labels)) {
      return null;
    }
    const names = Object.keys(item.labels).sort();
    if (
      !SERIES_LABEL_SETS[binding].some(
        (allowed) =>
          allowed.length === names.length &&
          allowed.every((name, index) => name === names[index]),
      ) ||
      names.some(
        (name) =>
          !SERIES_LABEL_NAMES.has(name) ||
          !isBoundedText((item.labels as Record<string, unknown>)[name], 253),
      )
    ) {
      return null;
    }
    const identity = JSON.stringify(names.map((name) => [name, (item.labels as Record<string, string>)[name]]));
    if (identities.has(identity)) {
      return null;
    }
    identities.add(identity);
    const samples = parseMetricSamples(item.samples, rangeStart, rangeEnd);
    if (samples === null) {
      return null;
    }
    series.push({ labels: { ...(item.labels as Record<string, string>) }, samples });
  }
  return series;
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
  expectedAnchor: MetricTimeAnchorView = "current",
): IncidentMetricPanelView | null {
  if (
    !isObject(value) ||
    value.schemaVersion !== 2 ||
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
    result.anchor !== expectedAnchor ||
    !isBoundedText(result.title, 160) ||
    !isBoundedText(result.unit, 32) ||
    !isBoundedText(result.purpose, 320) ||
    !isMetricRiskDirection(result.riskDirection) ||
    !isMetricSeriesBinding(result.seriesBinding) ||
    (result.threshold !== null && !isFiniteNumber(result.threshold)) ||
    (result.riskDirection === "higher_is_worse" && result.threshold === null) ||
    (result.riskDirection === "neutral" && result.threshold !== null) ||
    !isMetricQueryState(result.state) ||
    !isTimestamp(result.queriedAt) ||
    !isTimestamp(result.rangeStart) ||
    !isTimestamp(result.rangeEnd) ||
    (result.latestSampleAt !== null && !isTimestamp(result.latestSampleAt)) ||
    (result.currentValue !== null && !isFiniteNumber(result.currentValue))
  ) {
    return null;
  }
  const queriedAt = Date.parse(result.queriedAt);
  const rangeStart = Date.parse(result.rangeStart);
  const rangeEnd = Date.parse(result.rangeEnd);
  if (
    rangeEnd - rangeStart !== metricWindowMilliseconds(expectedWindow) ||
    rangeEnd > queriedAt
  ) {
    return null;
  }
  const series = parseMetricSeries(
    result.series,
    result.seriesBinding,
    rangeStart,
    rangeEnd,
  );
  if (series === null) {
    return null;
  }
  const singleSeries = result.seriesBinding === "target";
  const latest = series.reduce<string | null>((current, item) => {
    const last = item.samples.at(-1)?.timestamp ?? null;
    return current === null || (last !== null && Date.parse(last) > Date.parse(current))
      ? last
      : current;
  }, null);
  const populated = series.length > 0 && result.latestSampleAt === latest;
  const empty =
    series.length === 0 &&
    result.latestSampleAt === null &&
    result.currentValue === null;
  if (
    (!populated && !empty) ||
    (populated && singleSeries && series.length !== 1) ||
    (populated &&
      (singleSeries
        ? result.currentValue !== series[0]?.samples.at(-1)?.value
        : result.currentValue !== null)) ||
    ((result.state === "no_data" ||
      result.state === "query_error" ||
      result.state === "monitoring_unavailable") &&
      !empty) ||
    ((result.state === "ok" || result.state === "stale") && !populated)
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
      timestamp < rangeStart ||
      timestamp > rangeEnd ||
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
      purpose: result.purpose,
      threshold: result.threshold,
      riskDirection: result.riskDirection,
      seriesBinding: result.seriesBinding,
      window: expectedWindow,
      anchor: expectedAnchor,
      state: result.state,
      queriedAt: result.queriedAt,
      rangeStart: result.rangeStart,
      rangeEnd: result.rangeEnd,
      latestSampleAt: result.latestSampleAt,
      currentValue: result.currentValue,
      series,
    },
    markers: markers as MetricMarkerView[],
    markersTruncated: value.markersTruncated,
  };
}
