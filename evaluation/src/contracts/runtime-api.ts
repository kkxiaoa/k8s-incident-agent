import { contractError, upstreamContractError } from "../shared/errors.ts";
import { isNormalizedString, isPlainObject, isUuid } from "../shared/guards.ts";
import type { components } from "./runtime-api.generated.ts";

type Schemas = components["schemas"];

export type IncidentDetail = Schemas["IncidentDetailResponse"];
export type IncidentSummary = Schemas["IncidentListItem"];
export type RunHistoryPage = Schemas["RunHistoryResponse"];
export type RunSummary = Schemas["RunSummaryResponse"];
export type RunEvent = Schemas["RunEventStreamItem"];
export type PanelReference = Schemas["MonitoringPanelReference"];
export type MetricPanel = Schemas["IncidentMetricPanel"];
export type MonitoringHealth = Schemas["MonitoringHealthSnapshot"];
export type OperatorSession = Schemas["OperatorSessionResponse"];
export type RerunAccepted = Schemas["CreateRunResponse"];

const RUNTIME_SCHEMA_VERSION = 5;
export const TRANSIENT_GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
const MAX_INCIDENT_PAGES = 10;
const MAX_RUN_EVENT_PAGES = 10;

export interface ReadOptions {
  transientStatuses?: ReadonlySet<number>;
}

// A JSON read bound to one endpoint origin; the transport owns HTTP failures and body limits.
export type ReadJson = (pathname: string, options?: ReadOptions) => Promise<unknown>;

// Runtime checks stay exactly as strict as before the generated types existed; the types only
// name what a validated document is trusted to contain.
function requireIncidentDetail(document: unknown, incidentId: string): IncidentDetail {
  if (
    !isPlainObject(document) ||
    document.schemaVersion !== RUNTIME_SCHEMA_VERSION ||
    !isPlainObject(document.incident) ||
    document.incident.id !== incidentId ||
    !isPlainObject(document.selectedRun) ||
    !isUuid(document.selectedRun.id)
  ) {
    throw upstreamContractError();
  }
  return document as unknown as IncidentDetail;
}

export async function readIncident(read: ReadJson, incidentId: string): Promise<IncidentDetail> {
  const document = await read(`/api/v1/incidents/${incidentId}`, {
    transientStatuses: TRANSIENT_GATEWAY_STATUSES,
  });
  return requireIncidentDetail(document, incidentId);
}

export async function readIncidentForRun(
  read: ReadJson,
  incidentId: string,
  runId: string,
): Promise<IncidentDetail> {
  const detail = requireIncidentDetail(
    await read(`/api/v1/incidents/${incidentId}?runId=${runId}`),
    incidentId,
  );
  if (detail.selectedRun.id !== runId) throw upstreamContractError();
  return detail;
}

export async function readIncidentSummaries(read: ReadJson): Promise<Map<string, IncidentSummary>> {
  const incidents = new Map<string, IncidentSummary>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_INCIDENT_PAGES; page += 1) {
    const query = cursor === undefined
      ? "/api/v1/incidents?limit=100"
      : `/api/v1/incidents?limit=100&cursor=${encodeURIComponent(cursor)}`;
    const document = await read(query);
    if (
      !isPlainObject(document) ||
      document.schemaVersion !== RUNTIME_SCHEMA_VERSION ||
      !Array.isArray(document.items) ||
      document.items.some((item) => !isPlainObject(item) || !isUuid(item.id)) ||
      !(document.nextCursor === null ||
        (isNormalizedString(document.nextCursor) && document.nextCursor.length <= 2_048))
    ) {
      throw upstreamContractError();
    }
    for (const item of document.items as IncidentSummary[]) {
      if (incidents.has(item.id)) throw upstreamContractError();
      incidents.set(item.id, item);
    }
    if (document.nextCursor === null) return incidents;
    if (cursors.has(document.nextCursor)) throw upstreamContractError();
    cursors.add(document.nextCursor);
    cursor = document.nextCursor;
  }
  throw responseTooLarge();
}

export async function readIncidentIds(read: ReadJson): Promise<Set<string>> {
  return new Set((await readIncidentSummaries(read)).keys());
}

// The deduplication gate judges this page's shape together with its content.
export function readRunHistory(read: ReadJson, incidentId: string): Promise<unknown> {
  return read(`/api/v1/incidents/${incidentId}/runs?limit=50`);
}

export function isRunHistoryPage(value: unknown): value is RunHistoryPage {
  return (
    isPlainObject(value) &&
    value.schemaVersion === RUNTIME_SCHEMA_VERSION &&
    Array.isArray(value.items) &&
    value.items.every(isPlainObject)
  );
}

export async function readRunEvents(
  read: ReadJson,
  incidentId: string,
  runId: string,
): Promise<{ events: RunEvent[]; truncated: boolean }> {
  const events: RunEvent[] = [];
  let truncated = false;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_RUN_EVENT_PAGES; page += 1) {
    const query = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const history = await read(
      `/api/v1/incidents/${incidentId}/runs/${runId}/events?limit=100${query}`,
    );
    if (
      !isPlainObject(history) ||
      history.schemaVersion !== RUNTIME_SCHEMA_VERSION ||
      !Array.isArray(history.items) ||
      (history.nextCursor !== null && !isNormalizedString(history.nextCursor))
    ) {
      throw upstreamContractError();
    }
    events.push(...(history.items as RunEvent[]));
    cursor = history.nextCursor as string | null;
    if (cursor === null) break;
    if (page === MAX_RUN_EVENT_PAGES - 1) truncated = true;
  }
  return { events, truncated };
}

export async function readPanelCatalog(read: ReadJson, incidentId: string): Promise<PanelReference[]> {
  const catalog = await read(`/api/v1/incidents/${incidentId}/monitoring/panels`);
  if (
    !isPlainObject(catalog) ||
    catalog.schemaVersion !== 4 ||
    !Array.isArray(catalog.panels) ||
    catalog.panels.length === 0 ||
    catalog.panels.length > 8
  ) {
    throw upstreamContractError();
  }
  return catalog.panels as PanelReference[];
}

export async function readPanel(
  read: ReadJson,
  incidentId: string,
  panelId: string,
  window: string,
): Promise<MetricPanel> {
  const document = await read(
    `/api/v1/incidents/${incidentId}/monitoring/panels/${panelId}?window=${window}`,
    { transientStatuses: TRANSIENT_GATEWAY_STATUSES },
  );
  if (
    !isPlainObject(document) ||
    document.schemaVersion !== 2 ||
    !isPlainObject(document.result) ||
    document.result.panelId !== panelId ||
    document.result.window !== window ||
    document.result.anchor !== "current"
  ) {
    throw upstreamContractError();
  }
  return document as unknown as MetricPanel;
}

// Health is polled until it satisfies the predicate, so the read itself rejects nothing.
export function readMonitoringHealth(read: ReadJson): Promise<unknown> {
  return read("/api/v1/monitoring/health", { transientStatuses: TRANSIENT_GATEWAY_STATUSES });
}

export function isHealthyMonitoring(value: unknown): value is MonitoringHealth {
  return (
    isPlainObject(value) &&
    value.state === "healthy" &&
    value.prometheus === "healthy" &&
    value.kubeStateMetrics === "healthy" &&
    value.ruleEvaluation === "healthy" &&
    value.alertmanager === "healthy" &&
    value.notification === "healthy"
  );
}

export function isOperatorSession(value: unknown, nowSeconds: number): value is OperatorSession {
  return (
    isPlainObject(value) &&
    value.operatorRef === "sandbox-operator" &&
    Number.isSafeInteger(value.expiresAt) &&
    (value.expiresAt as number) > nowSeconds &&
    typeof value.csrfToken === "string" &&
    /^[a-f0-9]{64}$/.test(value.csrfToken)
  );
}

export function isRerunAccepted(value: unknown): value is RerunAccepted {
  return isPlainObject(value) && value.schemaVersion === RUNTIME_SCHEMA_VERSION && isUuid(value.runId);
}

export function errorCode(value: unknown): string | undefined {
  if (!isPlainObject(value) || !isPlainObject(value.error)) return undefined;
  return typeof value.error.code === "string" ? value.error.code : undefined;
}

export function isDiagnosisUnavailable(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isPlainObject(value.diagnosis) &&
    value.diagnosis.status === "unavailable" &&
    typeof value.diagnosis.reason === "string"
  );
}

export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;
  let boundary;
  while ((boundary = rest.indexOf("\n\n")) !== -1) {
    frames.push(rest.slice(0, boundary).replaceAll("\r\n", "\n"));
    rest = rest.slice(boundary + 2);
  }
  return { frames, rest };
}

export interface SseIdentity {
  incidentId: string;
  runId: string;
}

export function decodeSseFrame(
  frame: string,
  expected: SseIdentity,
  previousId: string | undefined,
): RunEvent {
  const lines = frame.split("\n");
  const idLine = lines.find((line) => line.startsWith("id: "));
  const eventLine = lines.find((line) => line.startsWith("event: "));
  const dataLines = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6));
  if (idLine === undefined || eventLine === undefined || dataLines.length === 0) {
    throw contractError("sse_replay_invalid", "SSE replay contained an incomplete event frame");
  }
  const id = idLine.slice(4);
  const event = eventLine.slice(7);
  const data = parseJson(dataLines.join("\n"));
  if (
    !/^[1-9][0-9]*$/.test(id) ||
    !isNormalizedString(event) ||
    !isPlainObject(data) ||
    data.schemaVersion !== RUNTIME_SCHEMA_VERSION ||
    data.runKind !== "diagnosis" ||
    data.incidentId !== expected.incidentId ||
    data.runId !== expected.runId ||
    (previousId !== undefined && BigInt(id) <= BigInt(previousId))
  ) {
    throw contractError("sse_replay_invalid", "SSE replay did not preserve the persisted event contract");
  }
  return { id, event, data } as unknown as RunEvent;
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw upstreamContractError();
  }
}

export function responseTooLarge() {
  return contractError("response_too_large", "An evaluation endpoint exceeded its response budget");
}
