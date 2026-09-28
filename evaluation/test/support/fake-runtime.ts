import assert from "node:assert/strict";

import type { HarnessContext, HarnessScenario, HarnessTerminal } from "./harness.ts";
import { jsonResponse } from "./responses.ts";

export const EVIDENCE_TOOL: Readonly<Record<string, string>> = Object.freeze({
  workload: "get_workload",
  rollout_history: "get_rollout_history",
  pods: "get_pods",
  events: "get_events",
  container_logs: "get_container_logs",
  service_network: "get_service_network",
  pvc_storage: "get_pvc_storage",
  metrics: "query_prometheus",
});

const DIAGNOSIS_ID = "50000000-0000-4000-8000-000000000001";
const REPAIR_ID = "70000000-0000-4000-8000-000000000001";
const RERUN_ID = "10000000-0000-4000-8000-000000000099";
export const REPAIR_DIGEST = "sha256:bc924be471167c459ae2d28e0e8b443d7d66bf4b7b329e2e81252f2aa9af97bf";

interface EvidenceItem {
  id: string;
  evidenceKind: string;
  toolName?: string;
}

function terminalFor(scenario: HarnessScenario, options: HarnessContext["options"]): HarnessTerminal {
  const configured = options.terminalByScenario?.[scenario.scenarioId];
  if (configured !== undefined) return configured;
  return { outcome: options.failingScenarioId === scenario.scenarioId ? "insufficient_evidence" : "diagnosed" };
}

function diagnosisCodeFor(scenario: HarnessScenario, options: HarnessContext["options"]): string {
  return options.diagnosisCodeByScenario?.[scenario.scenarioId] ??
    (scenario.expectedPatchConstraints === undefined ? "observed_cause" : "image_invalid_registry");
}

function incidentStatusFor(terminal: HarnessTerminal, repair: unknown, options: HarnessContext["options"]): string {
  if (options.incidentStatusDrift === true && terminal.outcome !== "diagnosed") return "DIAGNOSED";
  if (terminal.outcome === "insufficient_evidence") return "INSUFFICIENT_EVIDENCE";
  if (terminal.outcome === "failed") return terminal.incidentStatus ?? "FAILED";
  return repair === null ? "DIAGNOSED" : "WAITING_APPROVAL";
}

function repairProjection(
  scenario: HarnessScenario,
  options: HarnessContext["options"],
  evidence?: EvidenceItem[],
): Record<string, unknown> | null {
  const expected = scenario.expectedPatchConstraints;
  if (expected === undefined || options.omitRepair === true || options.omitDiagnosisEvidenceLinks === true) {
    return null;
  }
  const evidenceItems = evidence ?? scenario.requiredEvidence.map((kind, index) => ({
    id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    evidenceKind: kind,
  }));
  const evidenceIds = ["workload", "rollout_history"]
    .map((kind) => evidenceItems.find((item) => item.evidenceKind === kind)?.id)
    .sort();
  const imagePath = `/spec/template/spec/containers/${expected.containerIndex}/image`;
  const patch = [
    { op: "test", path: "/metadata/uid", value: "deployment-uid" },
    { op: "test", path: "/metadata/resourceVersion", value: "42" },
    { op: "test", path: `/spec/template/spec/containers/${expected.containerIndex}/name`, value: expected.containerName },
    { op: "test", path: imagePath, value: expected.currentImage },
    { op: "replace", path: imagePath, value: expected.replacementImage },
  ];
  return {
    schemaVersion: 1,
    id: REPAIR_ID,
    action: expected.action,
    target: { ...scenario.target },
    targetUid: "deployment-uid",
    targetResourceVersion: "42",
    containerIndex: expected.containerIndex,
    containerName: expected.containerName,
    currentImage: expected.currentImage,
    replacementImage: expected.replacementImage,
    evidenceIds,
    sourceExecutionId: options.sourceExecutionId ?? null,
    patch,
    digest: options.invalidRepairDigest === true ? `sha256:${"f".repeat(64)}` : REPAIR_DIGEST,
    diff: { path: imagePath, before: expected.currentImage, after: expected.replacementImage },
    schemaCheckedAt: "2026-09-05T00:00:00.000Z",
    policyCheckedAt: "2026-09-05T00:00:01.000Z",
    diffCheckedAt: "2026-09-05T00:00:02.000Z",
    validation: { outcome: "passed", checkedAt: "2026-09-05T00:00:03.000Z", error: null },
  };
}

function terminalFrame(
  terminal: HarnessTerminal,
  repair: unknown,
  eventData: (fields: Record<string, unknown>) => string,
  options: HarnessContext["options"],
): [string, string] {
  const outcome = options.staleSseTerminal === true ? "diagnosed" : terminal.outcome;
  // The right event name with the wrong persisted states: the replay gate must read the payload too.
  const drift = options.sseTerminalStateDrift === true;
  if (outcome === "insufficient_evidence") {
    return ["diagnosis.insufficient", eventData({
      diagnosisId: DIAGNOSIS_ID,
      outcome,
      incidentStatus: "INSUFFICIENT_EVIDENCE",
      runStatus: drift ? "RUNNING" : "COMPLETED",
    })];
  }
  if (outcome === "failed") {
    return ["run.failed", eventData({
      errorCode: drift ? "another_error" : terminal.errorCode,
      retryable: terminal.retryable ?? false,
      incidentStatus: terminal.incidentStatus ?? "FAILED",
      runStatus: "FAILED",
    })];
  }
  return ["diagnosis.completed", eventData({
    diagnosisId: DIAGNOSIS_ID,
    outcome: "diagnosed",
    incidentStatus: "DIAGNOSED",
    runStatus: repair === null ? "COMPLETED" : "RUNNING",
  })];
}

function lifecycleFrames(scenario: HarnessScenario, options: HarnessContext["options"]): Array<[string, string]> {
  const terminal = terminalFor(scenario, options);
  const repair = terminal.outcome === "diagnosed" ? repairProjection(scenario, options) : null;
  const incidentId = options.invalidSseContract === true ? "90000000-0000-4000-8000-000000000001" : scenario.incidentId;
  const eventData = (fields: Record<string, unknown>) => JSON.stringify({
    schemaVersion: 5,
    incidentId,
    runId: scenario.runId,
    runKind: "diagnosis",
    occurredAt: "2026-09-05T00:00:00.000Z",
    ...fields,
  });
  const frames: Array<[string, string]> = [
    ["incident.created", eventData({ attempt: 1, incidentStatus: "RECEIVED", runStatus: "QUEUED" })],
    ["run.started", eventData({ attempt: 1, incidentStatus: "TRIAGING", runStatus: "RUNNING" })],
    terminalFrame(terminal, repair, eventData, options),
    ...(repair === null
      ? []
      : ([
          ["repair.patch_ready", eventData({ proposalId: repair.id, proposalDigest: repair.digest, incidentStatus: "PATCH_READY", runStatus: "RUNNING" })],
          ["repair.dry_run_passed", eventData({ proposalId: repair.id, proposalDigest: repair.digest, incidentStatus: "DRY_RUN_PASSED", runStatus: "RUNNING" })],
          ["repair.waiting_approval", eventData({ proposalId: repair.id, proposalDigest: repair.digest, incidentStatus: "WAITING_APPROVAL", runStatus: "COMPLETED" })],
        ] as Array<[string, string]>)),
  ];
  if (repair !== null && options.duplicateRepairEvent === true) frames.splice(4, 0, frames[3]);
  return frames;
}

function monitoringHealth(context: HarnessContext) {
  const { state } = context;
  const healthy = state.prometheus && state.kubeStateMetrics;
  return {
    state: healthy ? "healthy" : "unavailable",
    prometheus: state.prometheus ? "healthy" : "unavailable",
    kubeStateMetrics: state.kubeStateMetrics ? "healthy" : "unavailable",
    ruleEvaluation: state.prometheus ? "healthy" : "unavailable",
    alertmanager: "healthy",
    notification: "healthy",
    watchdogLastReceivedAt: state.watchdogLastReceivedAt,
  };
}

function incidentList(url: URL, context: HarnessContext): Response {
  const { scenarioById, state, options } = context;
  const scenarios = [...scenarioById.values()];
  const controlScenario = scenarios.find(
    (scenario) => scenario.scenarioId === options.controlIncidentScenarioId && scenario.applied && scenario.repeated,
  );
  const scenarioItems = scenarios
    .filter((scenario) => scenario.scenarioId === options.otherAlertSameTargetScenarioId && (scenario.applied || scenario.resolved))
    .map((scenario) => ({ id: scenario.otherIncidentId, updatedAt: scenario.updatedAt }))
    .concat(
      scenarios
        .filter((scenario, index) => scenario.applied || scenario.resolved || (state.online && index === 0 && !options.onlineEmpty))
        .map((scenario) => ({ id: scenario.incidentId, updatedAt: scenario.updatedAt })),
    )
    .concat(controlScenario === undefined ? [] : [{ id: controlScenario.controlIncidentId, updatedAt: controlScenario.updatedAt }]);
  if (options.paginatedIncidents === true) {
    const retainedItems = Array.from({ length: 101 }, (_, index) => ({
      id: `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      updatedAt: "2026-09-04T00:00:00.000Z",
    }));
    const items = [...scenarioItems, ...retainedItems];
    const cursor = url.searchParams.get("cursor");
    return jsonResponse({
      schemaVersion: 5,
      items: cursor === null ? items.slice(0, 100) : items.slice(100),
      nextCursor: cursor === null ? "next-page" : null,
    });
  }
  return jsonResponse({ schemaVersion: 5, items: scenarioItems, nextCursor: null });
}

function runEvents(url: URL, scenario: HarnessScenario, context: HarnessContext): Response {
  const { options } = context;
  const items = lifecycleFrames(scenario, options).map(([event, data], index) => ({ id: String(index + 1), event, data: JSON.parse(data) }));
  if (options.manyRunEvents !== undefined) {
    // Many small fields per event: the shape whose bytes a formatter inflates most.
    const page = Number(url.searchParams.get("cursor") ?? "0");
    const { pages, perPage, fields } = options.manyRunEvents;
    const pageItems = Array.from({ length: perPage }, (_, index) => ({
      id: String(page * perPage + index + 1),
      event: "tool.started",
      data: Object.fromEntries(Array.from({ length: fields }, (_, field) => [`f${String(field).padStart(3, "0")}`, "0123456789"])),
    }));
    return jsonResponse({ schemaVersion: 5, items: pageItems, nextCursor: page + 1 < pages ? String(page + 1) : null });
  }
  if (options.bulkyRunEvents === true) {
    // One oversized event per page, so the bound is crossed only by the sum of the pages.
    const page = Number(url.searchParams.get("cursor") ?? "0");
    const item = { ...items[Math.min(page, items.length - 1)], padding: "x".repeat(1_500_000) };
    return jsonResponse({ schemaVersion: 5, items: [item], nextCursor: page < 2 ? String(page + 1) : null });
  }
  return jsonResponse({ schemaVersion: 5, items, nextCursor: null });
}

function panelCatalog(scenario: HarnessScenario): Response {
  return jsonResponse({
    schemaVersion: 4,
    panels: [
      {
        panelId: `${scenario.scenarioId}-metric`,
        title: "Trigger metric",
        unit: "pods",
        purpose: "Registered purpose.",
        seriesBinding: "target",
        recommendedWindow: "15m",
        riskDirection: "higher_is_worse",
        signalRole: "trigger",
        thresholdDuration: "30s",
      },
      {
        panelId: `${scenario.scenarioId}-context`,
        title: "Context metric",
        unit: "cores",
        purpose: "Registered purpose.",
        seriesBinding: "pod_container",
        recommendedWindow: "15m",
        riskDirection: "neutral",
        signalRole: "context",
        thresholdDuration: null,
      },
    ],
  });
}

function panelQuery(url: URL, suffix: string, scenario: HarnessScenario, isOtherIncident: boolean, context: HarnessContext): Response {
  if (isOtherIncident) return new Response(null, { status: 404 });
  const { state, options } = context;
  const panelId = suffix.split("/").at(-1) ?? "";
  const contextPanel = panelId.endsWith("-context");
  const panelState = contextPanel
    ? options.contextPanelState ?? "no_data"
    : !state.prometheus
      ? "monitoring_unavailable"
      : !state.kubeStateMetrics || scenario.resolved
        ? "stale"
        : "ok";
  const observed = !new Set(["monitoring_unavailable", "no_data", "query_error"]).has(panelState);
  return jsonResponse({
    schemaVersion: 2,
    result: {
      panelId,
      window: url.searchParams.get("window"),
      anchor: "current",
      state: panelState,
      threshold: contextPanel ? null : 1,
      riskDirection: contextPanel ? "neutral" : "higher_is_worse",
      seriesBinding: contextPanel ? "pod_container" : "target",
      currentValue: observed && !contextPanel ? 1 : null,
      series: observed
        ? [{
            labels: contextPanel ? { pod: "web-1", uid: "u1", container: "app" } : {},
            samples: [{ timestamp: "2026-09-05T00:00:00Z", value: 1 }],
          }]
        : [],
    },
    markers: [],
    markersTruncated: false,
  });
}

function eventStream(scenario: HarnessScenario, context: HarnessContext): Response {
  const frames = lifecycleFrames(scenario, context.options);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames.map(([event, data], index) => `id: ${index + 1}\nevent: ${event}\ndata: ${data}\n\n`).join("")));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function incidentDetail(scenario: HarnessScenario, isOtherIncident: boolean, isControlIncident: boolean, context: HarnessContext): Response {
  const { state, options } = context;
  const evidence: EvidenceItem[] = scenario.requiredEvidence
    .filter((kind) => options.uncollectedEvidenceKind === undefined || kind !== options.uncollectedEvidenceKind)
    .map((kind, index) => ({
      id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      evidenceKind: kind,
      toolName: options.forbiddenToolUsed === true && index === 0 ? "execute_shell" : EVIDENCE_TOOL[kind],
    }));
  const diagnosisCode = diagnosisCodeFor(scenario, options);
  const terminal = terminalFor(scenario, options);
  const repair = terminal.outcome === "diagnosed" ? repairProjection(scenario, options, evidence) : null;
  const citedEvidence = options.omitDiagnosisEvidenceLinks === true
    ? []
    : options.citeOnlyNonIdentityEvidence === true
      ? evidence.filter((item) => item.evidenceKind !== scenario.identityEvidence).map((item) => item.id)
      : options.citeOnlyIdentityEvidence === true
        ? evidence.filter((item) => item.evidenceKind === scenario.identityEvidence).map((item) => item.id)
        : evidence.map((item) => item.id);
  return jsonResponse({
    schemaVersion: 5,
    incident: {
      id: isControlIncident ? scenario.controlIncidentId : isOtherIncident ? scenario.otherIncidentId : scenario.incidentId,
      source: {
        type: "alertmanager",
        ref: isOtherIncident ? "K8sIncidentDeploymentReplicasUnavailable" : scenario.alertId,
        revision: "catalog-v1",
      },
      target: isControlIncident ? { ...scenario.target, name: scenario.healthyControlNames[0] } : scenario.target,
      status: incidentStatusFor(terminal, repair, options),
      displayName: scenario.displayName,
    },
    selectedRun: {
      kind: "diagnosis",
      operation: null,
      id: state.online && state.rerunId !== undefined && !options.onlineWrongRun ? state.rerunId : scenario.runId,
      attempt: state.online && state.rerunId !== undefined ? 2 : 1,
      status: state.online && options.onlineRerunStatus === 409 ? "RUNNING" : terminal.outcome === "failed" ? "FAILED" : "COMPLETED",
      requestSource: state.online && state.rerunId !== undefined ? "operator" : "system",
      error: terminal.outcome === "failed"
        ? { code: terminal.errorCode, retryable: options.retryableDrift === true ? "yes" : terminal.retryable ?? false }
        : null,
    },
    eventPage: { items: scenario.resolved ? [{ event: "alert.resolved" }] : [], nextCursor: null },
    evidence,
    diagnosis: terminal.outcome === "failed" ? null : terminal.outcome === "insufficient_evidence" ? {
      outcome: "insufficient_evidence",
      summary: "The collected evidence does not support a root cause.",
      rootCauses: options.insufficientWithRootCauses === true
        ? [{ code: "observed_cause", statement: "A cause the outcome does not allow.", confidence: "low", evidenceIds: [] }]
        : [],
      missingInformation: options.emptyMissingInformation === true ? [] : ["current container status of the target"],
      recommendations: [],
    } : {
      outcome: "diagnosed",
      summary: "A diagnostic explanation requiring independent semantic review.",
      rootCauses: [{
        code: diagnosisCode,
        statement: options.diagnosisStatement ?? "A diagnostic explanation requiring independent semantic review.",
        confidence: "high",
        evidenceIds: citedEvidence,
      }],
    },
    repair: options.repairDrift === true && terminal.outcome !== "diagnosed" ? { drift: true } : repair,
    alertSignal: { status: scenario.resolved ? "RESOLVED" : "FIRING" },
    eventCursor: repair === null ? "3" : "6",
  });
}

// The Runtime API behind the forwarded port: every route the evaluator reads or mutates.
export function runtimeResponse(url: URL, init: RequestInit | undefined, headers: Headers, context: HarnessContext): Response {
  const { scenarioById, state, options } = context;
  const method = init?.method ?? "GET";
  if (url.pathname === "/healthz") {
    return jsonResponse({
      status: "ok",
      diagnosis: {
        status: options.onlineRerunStatus === 503 ? "unavailable" : "ready",
        reason: options.onlineRerunStatus === 503 ? "model_upstream_failed" : null,
      },
    });
  }
  if (url.pathname === "/api/v1/scenarios") return new Response(null, { status: options.onlineManualRoutes === true ? 200 : 404 });
  if (url.pathname === "/api/v1/incidents" && method === "POST") {
    return new Response(null, { status: options.onlineManualRoutes === true ? 422 : 405 });
  }
  if (url.pathname === "/api/v1/monitoring/health") return jsonResponse(monitoringHealth(context));
  if (url.pathname === "/api/v1/incidents") return incidentList(url, context);

  const match = url.pathname.match(/^\/api\/v1\/incidents\/([^/]+)(.*)$/);
  if (match === null) return new Response(null, { status: 404 });
  const scenario = [...scenarioById.values()].find(
    (candidate) => candidate.incidentId === match[1] || candidate.otherIncidentId === match[1] || candidate.controlIncidentId === match[1],
  );
  if (scenario === undefined) return new Response(null, { status: 404 });
  const isOtherIncident = scenario.otherIncidentId === match[1];
  const isControlIncident = scenario.controlIncidentId === match[1];
  const suffix = match[2];
  if (state.online && suffix === "/runs" && method === "POST") {
    assert.deepEqual(JSON.parse(init?.body as string), {});
    if (options.onlineRerunStatus === 409) return jsonResponse({ error: { code: "active_run_exists" } }, 409);
    if (options.onlineRerunStatus === 503) return jsonResponse({ error: { code: "diagnosis_unavailable" } }, 503);
    if (options.onlineRerunStatus === 422) return jsonResponse({ error: { code: "invalid_request" } }, 422);
    state.rerunId = RERUN_ID;
    return jsonResponse({ schemaVersion: 5, runId: state.rerunId }, options.onlineRerunStatus ?? 202);
  }
  const events = suffix.match(/^\/runs\/([^/]+)\/events$/);
  if (events !== null) {
    if (events[1] !== scenario.runId) return new Response(null, { status: 404 });
    return runEvents(url, scenario, context);
  }
  if (suffix === "/runs") {
    return jsonResponse({
      schemaVersion: 5,
      items: [{ id: scenario.runId, kind: "diagnosis", operation: null, attempt: 1, status: "COMPLETED" }],
      nextCursor: null,
    });
  }
  if (suffix === "/monitoring/panels") return panelCatalog(scenario);
  if (suffix.startsWith("/monitoring/panels/")) return panelQuery(url, suffix, scenario, isOtherIncident, context);
  if (suffix === "/events" && headers.get("Last-Event-ID") === "0") return eventStream(scenario, context);
  if (suffix !== "") return new Response(null, { status: 404 });
  return incidentDetail(scenario, isOtherIncident, isControlIncident, context);
}
