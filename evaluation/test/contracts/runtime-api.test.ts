import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeSseFrame,
  errorCode,
  isDiagnosisUnavailable,
  isHealthyMonitoring,
  isRerunAccepted,
  isRunHistoryPage,
  readIncident,
  readIncidentForRun,
  readIncidentIds,
  readIncidentSummaries,
  readMonitoringHealth,
  readPanel,
  readPanelCatalog,
  readRunEvents,
  readRunHistory,
  splitSseFrames,
  TRANSIENT_GATEWAY_STATUSES,
} from "../../src/contracts/runtime-api.ts";
import { EvaluationError } from "../../src/shared/errors.ts";
import type { ReadJson, ReadOptions } from "../../src/shared/json.ts";

const INCIDENT = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000001";
// Both paginated reads stop after ten pages.
const PAGE_BOUND = 10;

function uuid(index: number) {
  return `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function coded(code: string) {
  return (error: unknown) => error instanceof EvaluationError && error.code === code;
}

// Records every read so the tests can assert the paths and options the contracts send.
function reader(responses: Record<string, unknown> | ((pathname: string) => unknown)) {
  const calls: Array<{ pathname: string; options: ReadOptions | undefined }> = [];
  const read: ReadJson = async (pathname, options) => {
    calls.push({ pathname, options });
    return typeof responses === "function" ? responses(pathname) : responses[pathname];
  };
  return { read, calls };
}

function detail(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 5, incident: { id: INCIDENT }, selectedRun: { id: RUN }, ...overrides };
}

test("incident detail is read through the gateway-tolerant path and checked for identity", async () => {
  const { read, calls } = reader({ [`/api/v1/incidents/${INCIDENT}`]: detail() });
  const document = await readIncident(read, INCIDENT);
  assert.equal(document.selectedRun.id, RUN);
  assert.deepEqual(calls[0], { pathname: `/api/v1/incidents/${INCIDENT}`, options: { transientStatuses: TRANSIENT_GATEWAY_STATUSES } });

  for (const bad of [
    detail({ schemaVersion: 4 }),
    detail({ incident: { id: uuid(9) } }),
    detail({ selectedRun: { id: "run-1" } }),
    detail({ selectedRun: null }),
    [detail()],
    "detail",
  ]) {
    await assert.rejects(readIncident(reader(() => bad).read, INCIDENT), coded("upstream_contract_invalid"));
  }
});

test("an Incident read for a specific Run must select that Run", async () => {
  const path = `/api/v1/incidents/${INCIDENT}?runId=${RUN}`;
  const { read, calls } = reader({ [path]: detail() });
  await readIncidentForRun(read, INCIDENT, RUN);
  assert.deepEqual(calls[0], { pathname: path, options: undefined });
  await assert.rejects(
    readIncidentForRun(reader({ [path]: detail({ selectedRun: { id: uuid(2) } }) }).read, INCIDENT, RUN),
    coded("upstream_contract_invalid"),
  );
});

test("incident summaries follow cursors, keep every item once and bound the page count", async () => {
  const pages = (count: number, perPage: number) => (pathname: string) => {
    const cursor = new URL(pathname, "http://runtime").searchParams.get("cursor");
    const page = cursor === null ? 0 : Number(cursor);
    return {
      schemaVersion: 5,
      items: Array.from({ length: perPage }, (_, index) => ({ id: uuid(page * perPage + index + 1), updatedAt: "2026-09-05T00:00:00Z" })),
      nextCursor: page + 1 < count ? String(page + 1) : null,
    };
  };
  const { read, calls } = reader(pages(2, 100));
  const summaries = await readIncidentSummaries(read);
  assert.equal(summaries.size, 200);
  assert.deepEqual(calls.map((call) => call.pathname), ["/api/v1/incidents?limit=100", "/api/v1/incidents?limit=100&cursor=1"]);
  assert.equal((await readIncidentIds(read)).has(uuid(150)), true);

  await assert.rejects(readIncidentSummaries(reader(pages(PAGE_BOUND + 1, 1)).read), coded("response_too_large"));
  assert.equal((await readIncidentSummaries(reader(pages(PAGE_BOUND, 1)).read)).size, PAGE_BOUND);

  const duplicate = reader(() => ({ schemaVersion: 5, items: [{ id: uuid(1) }, { id: uuid(1) }], nextCursor: null }));
  await assert.rejects(readIncidentSummaries(duplicate.read), coded("upstream_contract_invalid"));
  const looping = reader(() => ({ schemaVersion: 5, items: [], nextCursor: "again" }));
  await assert.rejects(readIncidentSummaries(looping.read), coded("upstream_contract_invalid"));
  for (const bad of [
    { schemaVersion: 4, items: [], nextCursor: null },
    { schemaVersion: 5, items: [{ id: "not-a-uuid" }], nextCursor: null },
    { schemaVersion: 5, items: [null], nextCursor: null },
    { schemaVersion: 5, items: [], nextCursor: " padded" },
    { schemaVersion: 5, items: [], nextCursor: "c".repeat(2_049) },
    { schemaVersion: 5, items: {}, nextCursor: null },
  ]) {
    await assert.rejects(readIncidentSummaries(reader(() => bad).read), coded("upstream_contract_invalid"));
  }
});

test("run history is fetched for the deduplication gate to judge as a whole", async () => {
  const page = { schemaVersion: 5, items: [{ id: RUN, kind: "diagnosis", operation: null, attempt: 1, status: "COMPLETED" }], nextCursor: null };
  const { read, calls } = reader({ [`/api/v1/incidents/${INCIDENT}/runs?limit=50`]: page });
  const history = await readRunHistory(read, INCIDENT);
  assert.equal(calls.length, 1);
  assert.ok(isRunHistoryPage(history));
  assert.equal(history.items.length, 1);
  assert.equal(isRunHistoryPage({ schemaVersion: 5, items: [] }), true);
  assert.equal(isRunHistoryPage({ schemaVersion: 4, items: [] }), false);
  assert.equal(isRunHistoryPage({ schemaVersion: 5, items: null }), false);
  assert.equal(isRunHistoryPage({ schemaVersion: 5, items: [null] }), false);
  assert.equal(isRunHistoryPage({ schemaVersion: 5, items: [page.items[0], "run"] }), false);
  assert.equal(isRunHistoryPage(undefined), false);
});

test("run events are paginated up to the bound and marked truncated beyond it", async () => {
  const pages = (count: number) => (pathname: string) => {
    const cursor = new URL(pathname, "http://runtime").searchParams.get("cursor");
    const page = cursor === null ? 0 : Number(cursor);
    return { schemaVersion: 5, items: [{ id: String(page + 1), event: "tool.started", data: {} }], nextCursor: page + 1 < count ? String(page + 1) : null };
  };
  const { read, calls } = reader(pages(3));
  const complete = await readRunEvents(read, INCIDENT, RUN);
  assert.deepEqual({ count: complete.events.length, truncated: complete.truncated }, { count: 3, truncated: false });
  assert.equal(calls[1].pathname, `/api/v1/incidents/${INCIDENT}/runs/${RUN}/events?limit=100&cursor=1`);

  const truncated = await readRunEvents(reader(pages(PAGE_BOUND + 5)).read, INCIDENT, RUN);
  assert.deepEqual({ count: truncated.events.length, truncated: truncated.truncated }, { count: PAGE_BOUND, truncated: true });
  const exact = await readRunEvents(reader(pages(PAGE_BOUND)).read, INCIDENT, RUN);
  assert.deepEqual({ count: exact.events.length, truncated: exact.truncated }, { count: PAGE_BOUND, truncated: false });

  for (const bad of [
    { schemaVersion: 4, items: [], nextCursor: null },
    { schemaVersion: 5, items: "none", nextCursor: null },
    { schemaVersion: 5, items: [], nextCursor: "" },
    { schemaVersion: 5, items: [], nextCursor: 7 },
  ]) {
    await assert.rejects(readRunEvents(reader(() => bad).read, INCIDENT, RUN), coded("upstream_contract_invalid"));
  }
});

test("the panel catalog must hold one to eight panels of the current schema", async () => {
  const panel = (index: number) => ({ panelId: `panel-${index}`, signalRole: index === 0 ? "trigger" : "context", recommendedWindow: "15m" });
  const catalog = (count: number, schemaVersion = 4) => ({ schemaVersion, panels: Array.from({ length: count }, (_, index) => panel(index)) });
  const { read, calls } = reader({ [`/api/v1/incidents/${INCIDENT}/monitoring/panels`]: catalog(2) });
  const panels = await readPanelCatalog(read, INCIDENT);
  assert.equal(panels.length, 2);
  assert.equal(calls[0].options, undefined);
  for (const bad of [catalog(0), catalog(9), catalog(1, 3), { schemaVersion: 4, panels: "many" }]) {
    await assert.rejects(readPanelCatalog(reader(() => bad).read, INCIDENT), coded("upstream_contract_invalid"));
  }
});

test("a panel query must echo its identity, window and current anchor", async () => {
  const result = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 2,
    result: { panelId: "panel-0", window: "15m", anchor: "current", state: "ok", series: [], ...overrides },
  });
  const path = `/api/v1/incidents/${INCIDENT}/monitoring/panels/panel-0?window=15m`;
  const { read, calls } = reader({ [path]: result() });
  const panel = await readPanel(read, INCIDENT, "panel-0", "15m");
  assert.equal(panel.result.state, "ok");
  assert.deepEqual(calls[0], { pathname: path, options: { transientStatuses: TRANSIENT_GATEWAY_STATUSES } });
  for (const bad of [
    result({ panelId: "panel-1" }),
    result({ window: "1h" }),
    result({ anchor: "occurrence" }),
    { ...result(), schemaVersion: 1 },
    { schemaVersion: 2, result: null },
  ]) {
    await assert.rejects(readPanel(reader(() => bad).read, INCIDENT, "panel-0", "15m"), coded("upstream_contract_invalid"));
  }
});

test("monitoring health is read tolerantly and judged by the healthy predicate", async () => {
  const healthy = {
    state: "healthy", prometheus: "healthy", kubeStateMetrics: "healthy", ruleEvaluation: "healthy",
    alertmanager: "healthy", notification: "healthy", watchdogLastReceivedAt: "2026-09-05T00:00:00.000Z",
  };
  const { read, calls } = reader({ "/api/v1/monitoring/health": healthy });
  const health = await readMonitoringHealth(read);
  assert.deepEqual(calls[0].options, { transientStatuses: TRANSIENT_GATEWAY_STATUSES });
  assert.ok(isHealthyMonitoring(health));
  assert.equal(health.watchdogLastReceivedAt, healthy.watchdogLastReceivedAt);
  for (const component of ["state", "prometheus", "kubeStateMetrics", "ruleEvaluation", "alertmanager", "notification"]) {
    assert.equal(isHealthyMonitoring({ ...healthy, [component]: "degraded" }), false, component);
  }
  assert.equal(isHealthyMonitoring(null), false);
  assert.equal(isHealthyMonitoring("healthy"), false);
});

test("accepted reruns, error codes and diagnosis availability are recognised structurally", () => {
  assert.equal(isRerunAccepted({ schemaVersion: 5, runId: RUN }), true);
  assert.equal(isRerunAccepted({ schemaVersion: 5, runId: "run" }), false);
  assert.equal(isRerunAccepted({ schemaVersion: 4, runId: RUN }), false);

  assert.equal(errorCode({ error: { code: "active_run_exists" } }), "active_run_exists");
  assert.equal(errorCode({ error: { code: 409 } }), undefined);
  assert.equal(errorCode({ error: "busy" }), undefined);
  assert.equal(errorCode(null), undefined);

  assert.equal(isDiagnosisUnavailable({ status: "ok", diagnosis: { status: "unavailable", reason: "model_upstream_failed" } }), true);
  assert.equal(isDiagnosisUnavailable({ status: "ok", diagnosis: { status: "unavailable", reason: null } }), false);
  assert.equal(isDiagnosisUnavailable({ status: "ok", diagnosis: { status: "ready", reason: null } }), false);
});

test("SSE frames split on blank LF lines with CRLF line ends normalised and decode into identity-checked events", () => {
  const payload = (fields: Record<string, unknown>) => JSON.stringify({
    schemaVersion: 5, incidentId: INCIDENT, runId: RUN, runKind: "diagnosis", occurredAt: "2026-09-05T00:00:00.000Z", ...fields,
  });
  const stream = `id: 1\r\nevent: incident.created\r\ndata: ${payload({ attempt: 1 })}\n\nid: 2\nevent: run.started\ndata: ${payload({ attempt: 1 })}\n\nid: 3\nevent: diag`;
  const { frames, rest } = splitSseFrames(stream);
  assert.equal(frames.length, 2);
  assert.equal(rest, "id: 3\nevent: diag");
  assert.equal(frames[0].includes("\r"), false);
  // Only a bare LF pair ends a frame; a CRLF pair is not a boundary.
  assert.equal(splitSseFrames("id: 1\r\n\r\nid: 2").frames.length, 0);

  const identity = { incidentId: INCIDENT, runId: RUN };
  const first = decodeSseFrame(frames[0], identity, undefined);
  assert.deepEqual({ id: first.id, event: first.event, incidentId: first.data.incidentId }, { id: "1", event: "incident.created", incidentId: INCIDENT });
  const second = decodeSseFrame(frames[1], identity, first.id);
  assert.equal(second.id, "2");

  const invalid = (frame: string, previous?: string) => assert.throws(() => decodeSseFrame(frame, identity, previous), coded("sse_replay_invalid"));
  invalid(`event: run.started\ndata: ${payload({})}`);
  invalid(`id: 2\ndata: ${payload({})}`);
  invalid("id: 2\nevent: run.started");
  invalid(`id: 0\nevent: run.started\ndata: ${payload({})}`);
  invalid(`id: 2\nevent: run.started\ndata: ${payload({ schemaVersion: 4 })}`);
  invalid(`id: 2\nevent: run.started\ndata: ${payload({ runKind: "repair" })}`);
  invalid(`id: 2\nevent: run.started\ndata: ${payload({ incidentId: uuid(9) })}`);
  invalid(`id: 2\nevent: run.started\ndata: ${payload({ runId: uuid(9) })}`);
  invalid(`id: 2\nevent: run.started\ndata: ${payload({})}`, "2");
  invalid(`id: 2\nevent: run.started\ndata: ${payload({})}`, "3");
  invalid(`id: 2\nevent: \ndata: ${payload({})}`);
  assert.throws(() => decodeSseFrame("id: 2\nevent: run.started\ndata: {not json", identity, undefined), coded("upstream_contract_invalid"));

  const multiline = decodeSseFrame(`id: 4\nevent: tool.started\ndata: {"schemaVersion":5,\ndata: "incidentId":"${INCIDENT}","runId":"${RUN}","runKind":"diagnosis"}`, identity, "3");
  assert.equal(multiline.event, "tool.started");
});
