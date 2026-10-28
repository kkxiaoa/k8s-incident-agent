import { loadEvaluationDataset, type EvaluationCase } from "../../src/contracts/dataset.ts";
import type { Campaign } from "../../src/contracts/records.ts";
import type { FetchLike } from "../../src/environment/http.ts";
import { operatorFetch } from "../../src/environment/operator-session.ts";
import type { TrialEnvironment } from "../../src/lifecycle/trial.ts";
import { REPOSITORY_ROOT } from "../support/fixtures.ts";
import { createHarness, type Harness, type HarnessOptions } from "../support/harness.ts";

export const CAMPAIGN: Campaign = { id: "20260905T000000Z-0000aaaa", startedAt: "2026-09-05T00:00:00.000Z", retryOf: null };

export interface TrialFixture {
  harness: Harness;
  cases: EvaluationCase[];
  environment: TrialEnvironment;
}

// The Trial's environment exactly as the campaign command will assemble it from a harness; a
// fetch wrapper is installed before the operator session is opened, as a test would do with the
// harness's own dependency.
export async function trialFixture(
  options: HarnessOptions = {},
  wrapFetch: (fetch: FetchLike, harness: Harness) => FetchLike = (fetch) => fetch,
): Promise<TrialFixture> {
  const harness = createHarness(options);
  harness.dependencies.fetch = wrapFetch(harness.dependencies.fetch, harness);
  const fetchImpl = await operatorFetch(harness.dependencies.fetch, "kind-evaluation", harness.dependencies.environment);
  const cases = loadEvaluationDataset(REPOSITORY_ROOT, harness.dependencies.scenarios).cases;
  const environment: TrialEnvironment = {
    profile: "kind-evaluation",
    context: "kind-k8s-incident-agent",
    release: harness.release.manifest,
    repositoryRoot: REPOSITORY_ROOT,
    campaign: CAMPAIGN,
    fetchImpl,
    execute: harness.dependencies.execute,
    scenarioRunner: harness.dependencies.runScenarioCommand,
    sleep: harness.dependencies.sleep,
    now: harness.dependencies.now,
    writeTrialPackage: harness.dependencies.writeTrialPackage!,
  };
  return { harness, cases, environment };
}

export function caseNamed(cases: readonly EvaluationCase[], scenarioId: string, overrides: Partial<EvaluationCase> = {}): EvaluationCase {
  const entry = cases.find((candidate) => candidate.scenarioId === scenarioId);
  if (entry === undefined) throw new Error(`unknown scenario ${scenarioId}`);
  return { ...entry, ...overrides };
}

// A wire-contract fixture for the evaluator. The separate Python integration executes
// the real intake/reconcile/graph; this fixture supplies controlled consumer failures.
export async function lifecycleTrialFixture(t: import("node:test").TestContext, options: {
  scenarioId?: string;
  missingSymptom?: boolean;
  unknownUsage?: boolean;
  earlyClosure?: boolean;
  extraIncident?: boolean;
  cleanupFailure?: boolean;
  invalidFirstEvidence?: boolean;
  repeatRun?: boolean;
  delayedRepeatRun?: boolean;
  newOccurrence?: boolean;
  revertedFactChange?: boolean;
  unconsumedSymptom?: boolean;
  supersededFactChange?: boolean;
  changeSourceMismatch?: "type" | "ref" | "revision";
  primarySourceMismatch?: boolean;
  configurationRunAbsent?: boolean;
} = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-05T00:00:00Z") });
  const fixture = await trialFixture();
  const scenarioId = options.scenarioId ?? "liveness-probe-misconfigured";
  const scenario = loadEvaluationDataset(REPOSITORY_ROOT, fixture.harness.dependencies.scenarios, "evaluation/datasets/lifecycle-v1.json").cases.find((entry) => entry.scenarioId === scenarioId)!;
  const { environment } = fixture;
  const originalFetch = environment.fetchImpl;
  const originalRunner = environment.scenarioRunner;
  let applied = false;
  let recovered = false;
  let reconfiguredAt: number | undefined;
  let applicationCount = 0;
  const started = Date.now();
  const bases = new Map<string, import("../../src/contracts/runtime-api.ts").IncidentWithRun>();
  const selectedReads: string[] = [];
  environment.now = () => new Date();
  environment.sleep = async (milliseconds) => { t.mock.timers.tick(milliseconds); };
  environment.scenarioRunner = async (action, id, dependencies) => {
    if (action === "cleanup" && applied && options.cleanupFailure) throw new Error("injected cleanup failure");
    if (action === "lifecycle-apply" || action === "apply") {
      applied = true;
      applicationCount += 1;
    }
    if (action === "reconfigure") reconfiguredAt = Date.now();
    if (action === "recover") recovered = true;
    return originalRunner(action === "lifecycle-apply" ? "apply" : action === "lifecycle-verify" ? "verify" : action === "recover" ? "cleanup" : action, id, dependencies);
  };
  const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  environment.fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    if (url.port !== "18080" || !url.pathname.startsWith("/api/v1/incidents") || url.pathname.includes("/monitoring/")) return originalFetch(input, init);
    const firstBase = bases.values().next().value;
    const original = await originalFetch(firstBase && url.pathname.endsWith("/10000000-0000-4000-8000-000000000099") ? String(input).replace("10000000-0000-4000-8000-000000000099", firstBase.incident.id) : input, init);
    if (!applied || url.pathname === "/api/v1/incidents") {
      if (applied && recovered && options.extraIncident && firstBase) {
        const document = await original.json() as { items: Array<{ id: string }> };
        document.items.push({ id: "10000000-0000-4000-8000-000000000099" });
        return response(document);
      }
      return original;
    }
    const requestedId = url.pathname.split("/")[4];
    const replacement = requestedId.startsWith("11000000");
    let base = bases.get(requestedId);
    if (!url.pathname.endsWith("/events") && !url.pathname.endsWith("/runs")) {
      const document = await original.json() as import("../../src/contracts/runtime-api.ts").IncidentWithRun;
      if (document.selectedRun && base === undefined) {
        base = document;
        bases.set(requestedId, base);
      }
    }
    if (!base) throw new Error("fixture detail missing");
    const incidentId = base.incident.id;
    const first = replacement ? base.selectedRun.id.replace(/^20000000/, "21000000") : base.selectedRun.id;
    const second = "20000000-0000-4000-8000-000000000099";
    const correlated = scenario.lifecycle?.kind === "correlated-deployment";
    const reconfigured = scenario.lifecycle?.kind === "reconfigured-deployment" && !replacement;
    const extra = !replacement && Date.now() - started >= 600_000 && (correlated || reconfigured || options.repeatRun === true);
    const configurationDiagnosed = reconfigured && reconfiguredAt !== undefined && Date.now() - reconfiguredAt >= 300_000 && !options.configurationRunAbsent;
    const runIds = extra && !options.missingSymptom && !options.unconsumedSymptom ? [first, second] : [first];
    if (configurationDiagnosed || (options.delayedRepeatRun && Date.now() - started >= 1_500_000)) runIds.push("20000000-0000-4000-8000-000000000098");
    const targetUid = replacement ? "replacement-object-uid" : "same-object-uid";
    const closed = recovered && (applicationCount === 1 || replacement);
    const alerts = correlated
      ? [scenario.alertId, "K8sIncidentCrashLoopBackOff", ...(options.missingSymptom ? [] : ["K8sIncidentDeploymentReplicasUnavailable"])]
      : reconfigured ? [scenario.alertId, "K8sIncidentDeploymentReplicasUnavailable"] : [scenario.alertId];
    type Event = { id: string; event: string; data: Record<string, unknown> };
    const events: Event[] = [];
    const changes: Array<Array<Record<string, unknown>>> = [[], [], []];
    const add = (event: string, data: Record<string, unknown>) => {
      const item = { id: String(events.length + 1), event, data: { schemaVersion: 6, incidentId, runId: null, runKind: null, occurredAt: new Date().toISOString(), ...data } };
      events.push(item);
      return item;
    };
    const addSymptom = (alert: string, index: number, run: number) => {
      const occurrence = { source: { type: "alertmanager", ref: alert, revision: "12" }, fingerprint: String(index + 1).padStart(16, "0"), startsAt: "2026-09-05T00:00:00.000000000Z" };
      add("alert.associated", { ...occurrence, targetUid });
      if (run === 1 && options.unconsumedSymptom) return;
      if (run === 1 && options.supersededFactChange) add("diagnosis.change_recorded", { change: { ...occurrence, eventId: String(events.length + 1) } });
      const change = { ...occurrence, eventId: String(events.length + 1) };
      add("diagnosis.change_recorded", { change });
      changes[run].push(change);
    };
    for (const [index, alert] of alerts.slice(0, correlated ? 2 : 1).entries()) addSymptom(alert, index, 0);
    for (const [index, runId] of runIds.entries()) {
      if (index === 1 && alerts[correlated ? 2 : 1]) addSymptom(alerts[correlated ? 2 : 1], correlated ? 2 : 1, 1);
      if (index === 2) {
        if (configurationDiagnosed) {
          const change = { ...changes[0][0], eventId: String(events.length + 1) };
          add("diagnosis.change_recorded", { change });
          changes[2].push(change);
        } else changes[2] = [...changes[1]];
      }
      const owner = { runId, runKind: "diagnosis" };
      add("run.queued", owner);
      add("run.started", owner);
      add("diagnosis.completed", { ...owner, incidentStatus: "DIAGNOSED", runStatus: "COMPLETED" });
    }
    if (options.unconsumedSymptom && extra) addSymptom(alerts[correlated ? 2 : 1], correlated ? 2 : 1, 1);
    if (options.newOccurrence && extra) add("alert.associated", { ...changes[0][0], eventId: undefined, targetUid, startsAt: "2026-09-05T00:09:00.000000000Z" });
    if (options.revertedFactChange && extra) add("diagnosis.change_recorded", { change: { ...changes[0][0], eventId: String(events.length + 1) } });
    if (options.changeSourceMismatch && extra) {
      const event = events.find((item) => item.id === changes[1][0]?.eventId)!;
      const change = structuredClone(event.data.change) as { source: Record<string, string> };
      change.source[options.changeSourceMismatch] = options.changeSourceMismatch === "type" ? "development" : options.changeSourceMismatch === "ref" ? scenario.alertId : "11";
      event.data.change = change;
    }
    if (closed) add("incident.closed", { targetUid, basis: "observed_stable", healthySince: new Date(Date.now() - (options.earlyClosure ? 1 : 300_000)).toISOString(), lastHealthyAt: new Date().toISOString() });
    const details = runIds.map((runId, index) => {
      const detail = structuredClone(base!);
      detail.incident.lifecycleStatus = closed ? "CLOSED" : "OPEN";
      const createdAt = index === 2 && configurationDiagnosed ? reconfiguredAt! + 300_000 : started + index * 600_000;
      detail.selectedRun = { ...detail.selectedRun, id: runId, attempt: index + 1, requestSource: "system", createdAt: new Date(createdAt).toISOString(), startedAt: new Date(createdAt).toISOString(), completedAt: new Date(createdAt + 9000).toISOString(),
        diagnosisUsage: { modelCalls: options.unknownUsage ? null : 2, toolCalls: 2, maxModelCalls: 5, maxToolCalls: 4, timeoutSeconds: 90 },
        diagnosisTrigger: { source: { type: "alertmanager", ref: String(changes[index][0]?.source ? (changes[index][0].source as { ref: string }).ref : scenario.alertId), revision: "12" }, summary: "Observed source activity", occurredAt: new Date().toISOString(), reason: index === 0 ? "first_observation" : index === 2 && configurationDiagnosed ? "facts_changed" : "new_symptom", changes: changes[index] as never },
      };
      if (options.primarySourceMismatch && index === 1) detail.selectedRun.diagnosisTrigger!.source = { ...detail.selectedRun.diagnosisTrigger!.source, ref: scenario.alertId };
      detail.alertSummary = { state: closed ? "CLEAR" : "FIRING", complete: true, targetHealthy: closed, observedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), reason: null, rules: [], lastKnownState: null, lastKnownAt: null };
      detail.closure = closed ? { basis: "observed_stable", closedAt: new Date().toISOString() } : null;
      detail.alertSignal = { status: "FIRING", startsAt: "2026-09-05T00:00:00.000000000Z", endsAt: null, lastReceivedAt: new Date().toISOString() };
      detail.eventCursor = events.at(-1)!.id;
      if (options.invalidFirstEvidence && index === 0) detail.evidence = [];
      return detail;
    });
    if (url.pathname.endsWith("/events")) return new Response(events.map((event) => `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    if (url.pathname.endsWith("/runs")) return response({ schemaVersion: 6, items: details.map((detail) => detail.selectedRun), nextCursor: null });
    const selected = url.searchParams.get("runId");
    if (selected) selectedReads.push(selected);
    const detail = details.find((candidate) => candidate.selectedRun.id === selected) ?? details.at(-1)!;
    if (url.pathname.endsWith("000000000099")) detail.incident.id = "10000000-0000-4000-8000-000000000099";
    return response(detail);
  };
  return { ...fixture, scenario, selectedReads };
}
