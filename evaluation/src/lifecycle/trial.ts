import { isDeepStrictEqual } from "node:util";
import type { ReleaseManifest } from "../../../scripts/release.mjs";
import type { ScenarioCommandDependencies } from "../../../scripts/scenario.mjs";
import { requireConsoleIncidentIdentity, requireConsoleIncidentPage } from "../contracts/console.ts";
import type { EvaluationCase, ExecutionProfile, ExpectedTerminal } from "../contracts/dataset.ts";
import { readAlertmanagerAlert, readPrometheusAlert } from "../contracts/monitoring.ts";
import type { Campaign, LifecycleResult, OutcomeClass, PanelCheck, ScenarioResult, SseReplayCheck, Trial } from "../contracts/records.ts";
import {
  decodeSseFrame,
  readIncident,
  readIncidentIds,
  readIncidentForRun,
  readPanel,
  readPanelCatalog,
  readRunHistory,
  splitSseFrames,
  type IncidentDetail,
  type IncidentWithRun,
  type RunEvent,
} from "../contracts/runtime-api.ts";
import { adaptScenarioExecutor, runScenario, type Execute, type ScenarioRunner } from "../environment/commands.ts";
import { bindJsonReader, readEventStream, requestText, type FetchLike } from "../environment/http.ts";
import { endpointOrigin } from "../environment/tunnels.ts";
import { contractError, responseTooLarge, safeFailure, upstreamContractError } from "../shared/errors.ts";
import { parseInstant, requireDate, isPlainObject } from "../shared/guards.ts";
import type { ReadJson } from "../shared/json.ts";
import {
  ALERT_REPEAT_WAIT_MILLISECONDS,
  DIAGNOSIS_TIMEOUT_MILLISECONDS,
  POST_RESOLUTION_TIMEOUT_MILLISECONDS,
  RESOLUTION_TIMEOUT_MILLISECONDS,
  waitUntil,
  type Sleep,
} from "../shared/wait.ts";
import { classifyFailure } from "./classification.ts";
import { emptyScenarioResult } from "./coverage.ts";
import {
  isResolvedIncident,
  isTerminalRun,
  matchesScenarioIncident,
  requireIncidentNotResolved,
  requireSingleTargetRun,
  selectNewTargetIncident,
} from "./gates/incident.ts";
import { assessFiringPanel, isPostResolutionSettled, requireTriggerPanel } from "./gates/panels.ts";
import { requireReplayIdentity, validateReplayEvents } from "./gates/sse.ts";
import { sameTarget } from "./gates/repair.ts";
import { assessTerminal, observedRun } from "./gates/terminal.ts";
import { captureReviewPackage, type TrialPackageWriter } from "./review-package.ts";

export interface TrialEnvironment {
  profile: ExecutionProfile;
  context: string;
  release: ReleaseManifest;
  repositoryRoot: string;
  campaign: Campaign;
  fetchImpl: FetchLike;
  execute: Execute;
  scenarioRunner: ScenarioRunner;
  sleep: Sleep;
  now: () => Date;
  writeTrialPackage: TrialPackageWriter;
}

interface RuntimeReaders {
  runtime: ReadJson;
  prometheus: ReadJson;
  alertmanager: ReadJson;
}

export function runtimeReaders(fetchImpl: FetchLike): RuntimeReaders {
  return {
    runtime: bindJsonReader(fetchImpl, endpointOrigin("runtime")),
    prometheus: bindJsonReader(fetchImpl, endpointOrigin("prometheus")),
    alertmanager: bindJsonReader(fetchImpl, endpointOrigin("alertmanager")),
  };
}

// Kind uses its fixed context, so the scenario runner is only told about explicit K3s contexts.
export function scenarioDependencies(
  environment: Pick<TrialEnvironment, "profile" | "context" | "release" | "repositoryRoot" | "execute">,
): ScenarioCommandDependencies {
  return {
    repositoryRoot: environment.repositoryRoot,
    release: environment.release,
    profile: environment.profile,
    context: environment.profile === "kind-evaluation" ? undefined : environment.context,
    execute: adaptScenarioExecutor(environment.execute),
  };
}

async function requireAlertState(scenario: EvaluationCase, firing: boolean, readers: RuntimeReaders): Promise<boolean> {
  const [prometheus, alertmanager] = await Promise.all([
    readPrometheusAlert(readers.prometheus, scenario),
    readAlertmanagerAlert(readers.alertmanager, scenario),
  ]);
  return firing
    ? prometheus !== undefined && alertmanager !== undefined
    : prometheus === undefined && alertmanager === undefined;
}

async function waitForAlertState(scenario: EvaluationCase, firing: boolean, readers: RuntimeReaders, sleep: Sleep): Promise<void> {
  await waitUntil(
    firing ? "alert_firing_timeout" : "alert_clear_timeout",
    () => requireAlertState(scenario, firing, readers),
    firing ? scenario.alertWaitMilliseconds : RESOLUTION_TIMEOUT_MILLISECONDS,
    sleep,
  );
}

async function requireControlAlertsAbsent(scenario: EvaluationCase, readers: RuntimeReaders): Promise<void> {
  for (const name of scenario.healthyControlNames) {
    const [prometheus, alertmanager] = await Promise.all([
      readPrometheusAlert(readers.prometheus, scenario, name),
      readAlertmanagerAlert(readers.alertmanager, scenario, name),
    ]);
    if (prometheus !== undefined || alertmanager !== undefined) {
      throw contractError("healthy_control_alerted", "A healthy scenario control produced the target alert");
    }
  }
}

async function requireControlIncidentsAbsent(scenario: EvaluationCase, incidentsBefore: Set<string>, runtime: ReadJson): Promise<void> {
  const current = await readIncidentIds(runtime);
  for (const incidentId of current) {
    if (incidentsBefore.has(incidentId)) continue;
    const detail = await readIncident(runtime, incidentId);
    if (scenario.healthyControlNames.includes(detail.incident.target?.name)) {
      throw contractError("healthy_control_incident_created", "A healthy scenario control created an Incident");
    }
  }
}

async function waitForNewIncident(scenario: EvaluationCase, incidentsBefore: Set<string>, runtime: ReadJson, sleep: Sleep): Promise<IncidentDetail> {
  return waitUntil(
    "incident_not_created",
    async () => {
      const current = await readIncidentIds(runtime);
      const candidates: IncidentDetail[] = [];
      for (const incidentId of current) {
        if (incidentsBefore.has(incidentId)) continue;
        const detail = await readIncident(runtime, incidentId);
        if (matchesScenarioIncident(detail, scenario)) candidates.push(detail);
      }
      return selectNewTargetIncident(candidates);
    },
    DIAGNOSIS_TIMEOUT_MILLISECONDS,
    sleep,
  );
}

async function waitForTerminalIncident(incidentId: string, runtime: ReadJson, sleep: Sleep): Promise<IncidentWithRun> {
  return waitUntil(
    "diagnosis_not_terminal",
    async () => {
      const detail = await readIncident(runtime, incidentId);
      return isTerminalRun(detail) ? detail : undefined;
    },
    DIAGNOSIS_TIMEOUT_MILLISECONDS,
    sleep,
  );
}

async function validateFiringPanels(detail: IncidentWithRun, runtime: ReadJson): Promise<PanelCheck[]> {
  const incidentId = detail.incident.id;
  const runId = detail.selectedRun.id;
  const results: PanelCheck[] = [];
  for (const reference of await readPanelCatalog(runtime, incidentId, runId)) {
    const panel = await readPanel(runtime, incidentId, reference.panelId, reference.recommendedWindow, runId);
    results.push(assessFiringPanel(reference, panel));
  }
  requireTriggerPanel(results);
  return results;
}

export async function validateSseReplay(
  incidentId: string,
  cursor: unknown,
  runId: unknown,
  repair: IncidentDetail["repair"],
  expectedTerminal: ExpectedTerminal,
  fetchImpl: FetchLike,
): Promise<SseReplayCheck> {
  requireReplayIdentity(cursor, runId);
  const events = await readIncidentReplay(incidentId, cursor as string, new Set([runId as string]), fetchImpl);
  return validateReplayEvents(events, cursor as string, repair, expectedTerminal, runId as string);
}

export async function readIncidentReplay(incidentId: string, cursor: string, runIds: ReadonlySet<string>, fetchImpl: FetchLike): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  let buffer = "";
  await readEventStream(fetchImpl, endpointOrigin("runtime"), `/api/v1/incidents/${incidentId}/events`, (chunk) => {
    const split = splitSseFrames(buffer + chunk);
    buffer = split.rest;
    for (const frame of split.frames) {
      const event = decodeSseFrame(frame, { incidentId, runId: runIds }, events.at(-1)?.id);
      events.push(event);
      if (events.length > 10_000) throw responseTooLarge();
      if (event.id === cursor) return true;
    }
    return false;
  });
  if (events.at(-1)?.id !== cursor) throw contractError("sse_replay_incomplete", "Incident replay did not reach its persisted cursor");
  return events;
}

export async function requireConsoleIncident(detail: IncidentDetail, fetchImpl: FetchLike): Promise<void> {
  const identity = requireConsoleIncidentIdentity(detail);
  const document = await requestText(fetchImpl, endpointOrigin("console"), `/incidents/${identity.incidentId}`);
  requireConsoleIncidentPage(document, identity);
}

async function requireAlertReceipt(incidentId: string, runId: string, runtime: ReadJson): Promise<number> {
  const detail = await readIncidentForRun(runtime, incidentId, runId);
  const timestamp = parseInstant(detail.alertSignal?.lastReceivedAt);
  if (timestamp === undefined) throw upstreamContractError();
  return timestamp;
}

async function waitForAlertmanagerRepeat(
  scenario: EvaluationCase,
  incidentId: string,
  runId: string,
  baselineReceivedAt: number,
  readers: RuntimeReaders,
  sleep: Sleep,
): Promise<void> {
  await waitUntil(
    "alertmanager_repeat_not_observed",
    async () => {
      const stillFiring = await requireAlertState(scenario, true, readers);
      if (!stillFiring) return undefined;
      const current = await requireAlertReceipt(incidentId, runId, readers.runtime);
      return current > baselineReceivedAt ? current : undefined;
    },
    ALERT_REPEAT_WAIT_MILLISECONDS,
    sleep,
  );
}

async function requireSingleIncidentAndRun(
  scenario: EvaluationCase,
  incidentsBefore: Set<string>,
  incidentId: string,
  runtime: ReadJson,
): Promise<void> {
  const current = await readIncidentIds(runtime);
  const targetIncidents: string[] = [];
  for (const candidateId of current) {
    if (incidentsBefore.has(candidateId)) continue;
    const detail = await readIncident(runtime, candidateId);
    if (matchesScenarioIncident(detail, scenario)) targetIncidents.push(candidateId);
  }
  const runs = await readRunHistory(runtime, incidentId);
  requireSingleTargetRun(targetIncidents, incidentId, runs);
}

async function waitForResolvedIncident(incidentId: string, runtime: ReadJson, sleep: Sleep): Promise<IncidentDetail> {
  return waitUntil(
    "alert_resolution_not_persisted",
    async () => {
      const detail = await readIncident(runtime, incidentId);
      return isResolvedIncident(detail) ? detail : undefined;
    },
    RESOLUTION_TIMEOUT_MILLISECONDS,
    sleep,
  );
}

async function waitForPostResolutionPanels(
  incidentId: string,
  runId: string,
  panels: readonly PanelCheck[],
  runtime: ReadJson,
  sleep: Sleep,
): Promise<Array<{ panelId: string; state: PanelCheck["state"] }>> {
  const states: Array<{ panelId: string; state: PanelCheck["state"] }> = [];
  for (const reference of panels) {
    const panel = await waitUntil(
      "post_resolution_panel_not_settled",
      async () => {
        const document = await readPanel(runtime, incidentId, reference.panelId, reference.window, runId);
        return isPostResolutionSettled(reference, document.result) ? document : undefined;
      },
      POST_RESOLUTION_TIMEOUT_MILLISECONDS,
      sleep,
    );
    states.push({ panelId: reference.panelId, state: panel.result.state });
  }
  return states;
}

function requireUnchangedRuns(before: ReadonlySet<string>, after: readonly string[]): void {
  if (before.size !== after.length || after.some((id) => !before.has(id))) {
    throw contractError("alert_repeat_not_deduplicated", "Repeated delivery or recovery changed the diagnosis Run set");
  }
}

async function observeRepeats(scenario: EvaluationCase, incidentId: string, runtime: ReadJson, readers: RuntimeReaders, environment: TrialEnvironment, observationMilliseconds = scenario.lifecycle!.observation_seconds * 1000): Promise<void> {
  const started = Date.now();
  const detail = await readIncident(runtime, incidentId);
  if (detail.selectedRun === null || scenario.lifecycle === undefined) throw upstreamContractError();
  for (let repeat = 0; repeat < 2; repeat += 1) {
    const received = await requireAlertReceipt(incidentId, detail.selectedRun.id, runtime);
    await waitForAlertmanagerRepeat(scenario, incidentId, detail.selectedRun.id, received, readers, environment.sleep);
  }
  const deadline = started + observationMilliseconds;
  while (Date.now() < deadline) {
    if (!await requireAlertState(scenario, true, readers)) throw contractError("alert_clear_timeout", "The persistent fault cleared during the observation window");
    await environment.sleep(Math.min(30_000, deadline - Date.now()));
  }
}

async function collectLifecycleRuns(
  scenario: EvaluationCase, incidentId: string, lifecycle: LifecycleResult, snapshots: IncidentWithRun[],
  eventsByIncident: Map<string, RunEvent[]>, environment: TrialEnvironment,
): Promise<void> {
  const runtime = runtimeReaders(environment.fetchImpl).runtime;
  const history = await readRunHistory(runtime, incidentId);
  if (history.items.length < 1 || history.items.length > 3) throw contractError("diagnosis_invalid", "An episode must have one to three automatic diagnoses");
  for (const run of [...history.items].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    if (lifecycle.runs.some((saved) => saved.runId === run.id)) continue;
    const detail = await waitUntil("diagnosis_not_terminal", async () => {
      const current = await readIncidentForRun(runtime, incidentId, run.id);
      return isTerminalRun(current) ? current : undefined;
    }, DIAGNOSIS_TIMEOUT_MILLISECONDS, environment.sleep);
    // Retain every real outcome before checking it; a later Run cannot erase a failure.
    snapshots.push(detail);
    const selected = detail.selectedRun;
    const usage = selected.diagnosisUsage;
    const trigger = selected.diagnosisTrigger;
    const start = parseInstant(selected.startedAt);
    const end = parseInstant(selected.completedAt);
    if (selected.requestSource !== "system" || !trigger || !usage || trigger.reason === "manual" ||
      ![usage.maxModelCalls, usage.maxToolCalls, usage.timeoutSeconds].every((value) => Number.isSafeInteger(value) && value > 0) ||
      ![usage.modelCalls, usage.toolCalls].every((value) => value !== null && Number.isSafeInteger(value) && value >= 0) ||
      usage.modelCalls! > usage.maxModelCalls || usage.toolCalls! > usage.maxToolCalls || start === undefined || end === undefined || end < start) {
      throw contractError("diagnosis_invalid", "A diagnosis lacks its fixed trigger, measured usage or budget");
    }
    lifecycle.runs.push({ incidentId, runId: run.id, run: observedRun(detail), trigger, usage,
      panels: [], elapsedSeconds: (end - start) / 1000, evidenceIds: detail.evidence.map((evidence) => evidence.id) });
    assessTerminal(scenario, detail);
    lifecycle.runs.at(-1)!.panels = await validateFiringPanels(detail, runtime);
    await requireConsoleIncident(detail, environment.fetchImpl);
  }
  const final = await readIncident(runtime, incidentId);
  const events = await readIncidentReplay(incidentId, final.eventCursor, new Set(history.items.map((run) => run.id)), environment.fetchImpl);
  for (const detail of snapshots.filter((item) => item.incident.id === incidentId)) {
    validateReplayEvents(events, final.eventCursor, detail.repair, scenario.expectedTerminal, detail.selectedRun.id);
  }
  const associations = events.filter((event) => event.event === "alert.associated");
  const uids = new Set(associations.map((event) => (event.data as unknown as { targetUid: string }).targetUid));
  if (uids.size !== 1 || ![...uids][0]) throw contractError("diagnosis_invalid", "Episode associations must preserve one Kubernetes UID");
  const targetUid = [...uids][0];
  const previous = lifecycle.incidents.find((item) => item.incidentId === incidentId);
  if (previous === undefined) lifecycle.incidents.push({ incidentId, targetUid, final });
  else {
    if (previous.targetUid !== targetUid) throw upstreamContractError();
    previous.final = final;
  }
  const times = history.items.map((run) => Date.parse(run.createdAt)).sort((a, b) => a - b);
  if (times.some((time, index) => !Number.isFinite(time) || (index > 0 && time - times[index - 1] < 600_000))) {
    throw contractError("diagnosis_invalid", "Automatic diagnoses did not preserve their minimum interval");
  }
  eventsByIncident.set(incidentId, events);
}

function requireLifecycleCoverage(scenario: EvaluationCase, lifecycle: LifecycleResult, eventsByIncident: ReadonlyMap<string, RunEvent[]>): void {
  for (const episode of lifecycle.incidents) {
    const events = eventsByIncident.get(episode.incidentId)!;
    const associations = events.filter((event) => event.event === "alert.associated").map((event) => event.data);
    const runs = lifecycle.runs.filter((run) => run.incidentId === episode.incidentId);
    const references = runs.flatMap((run) => run.trigger.changes);
    for (const run of runs) {
      if (!isDeepStrictEqual(run.trigger.source, run.trigger.changes[0]?.source)) throw upstreamContractError();
    }
    for (const reference of references) {
      const change = events.find((event) => event.id === reference.eventId);
      if (change?.event !== "diagnosis.change_recorded" || !isPlainObject(change.data) ||
        !isDeepStrictEqual(change.data.change, reference)) throw upstreamContractError();
    }
    for (const association of associations) {
      // Comparable new occurrences may reuse the successful source's fact baseline.
      if (!references.some((change) => isDeepStrictEqual(change.source, association.source))) {
        throw contractError("diagnosis_evidence_missing", "An associated symptom was omitted from every diagnosis trigger");
      }
    }
    const expectedSymptoms = scenario.lifecycle?.kind === "correlated-deployment"
      ? ["K8sIncidentLivenessProbeRestart", "K8sIncidentCrashLoopBackOff", "K8sIncidentDeploymentReplicasUnavailable"]
      : scenario.lifecycle?.kind === "reconfigured-deployment" && episode.incidentId === lifecycle.incidents[0].incidentId
        ? ["K8sIncidentCrashLoopBackOff", "K8sIncidentDeploymentReplicasUnavailable"] : [];
    if (!expectedSymptoms.every((alert) => associations.some((item) => item.source.ref === alert))) {
      throw contractError("diagnosis_evidence_missing", "The episode did not receive its required real symptoms");
    }
    if (episode.final.incident.lifecycleStatus === "CLOSED") {
      const closed = events.findLast((event) => event.event === "incident.closed")?.data as unknown as { targetUid: string; healthySince: string; lastHealthyAt: string } | undefined;
      if (closed === undefined || closed.targetUid !== episode.targetUid ||
          !Number.isFinite(Date.parse(closed.healthySince)) || !Number.isFinite(Date.parse(closed.lastHealthyAt)) ||
          Date.parse(closed.lastHealthyAt) - Date.parse(closed.healthySince) < 300_000) throw upstreamContractError();
    }
    if (scenario.lifecycle?.kind === "persistent-pvc" && (episode.final.incident.lifecycleStatus !== "OPEN" || episode.final.alertSummary.state !== "FIRING")) {
      throw contractError("incident_resolution_invalid", "The pending PVC must remain an open fault before cleanup");
    }
  }
}

// One planned Trial: the fixture's whole life from cleanup to cleanup, with every gate the
// Runtime must pass and the review package captured before the terminal is judged.
export async function runTrial(scenario: EvaluationCase, environment: TrialEnvironment): Promise<ScenarioResult> {
  const trial: Trial = { index: 1, startedAt: requireDate(environment.now()).toISOString(), completedAt: null };
  const result = { ...emptyScenarioResult(scenario), trial };
  const readers = runtimeReaders(environment.fetchImpl);
  const runtime = readers.runtime;
  const dependencies = scenarioDependencies(environment);
  const scenarioId = scenario.scenarioId;
  let outcomeClass: OutcomeClass;
  let applied = false;
  const snapshots: IncidentWithRun[] = [];
  const eventsByIncident = new Map<string, RunEvent[]>();
  try {
    await runScenario(environment.scenarioRunner, "cleanup", scenarioId, dependencies);
    await waitForAlertState(scenario, false, readers, environment.sleep);
    result.checks.healthyBaseline = true;

    const incidentsBefore = await readIncidentIds(runtime);
    // The operator may fail after creating only part of a fixture.
    applied = true;
    await runScenario(environment.scenarioRunner, scenario.lifecycle?.kind === "correlated-deployment" ? "lifecycle-apply" : "apply", scenarioId, dependencies);
    await runScenario(environment.scenarioRunner, scenario.lifecycle?.kind === "correlated-deployment" ? "lifecycle-verify" : "verify", scenarioId, dependencies);
    result.checks.fixtureVerified = true;

    await waitForAlertState(scenario, true, readers, environment.sleep);
    result.checks.prometheusFiring = true;
    result.checks.alertmanagerFiring = true;
    await requireControlAlertsAbsent(scenario, readers);

    const detail = await waitForNewIncident(scenario, incidentsBefore, runtime, environment.sleep);
    const incidentId = detail.incident.id;
    result.incidentId = incidentId;
    result.checks.uniqueIncident = true;

    if (scenario.lifecycle !== undefined) {
      result.lifecycle = { version: scenario.lifecycle.lifecycle_version, runs: [], incidents: [] };
      const capture = async (id: string) => collectLifecycleRuns(scenario, id, result.lifecycle!, snapshots, eventsByIncident, environment);
      await waitForTerminalIncident(incidentId, runtime, environment.sleep);
      await capture(incidentId);
      const initialIds = new Set(result.lifecycle.runs.map((run) => run.runId));
      await observeRepeats(scenario, incidentId, runtime, readers, environment);
      await capture(incidentId);
      if (scenario.lifecycle.kind === "correlated-deployment" || scenario.lifecycle.kind === "reconfigured-deployment") {
        requireLifecycleCoverage(scenario, result.lifecycle, eventsByIncident);
        const settledIds = new Set(result.lifecycle.runs.map((run) => run.runId));
        await observeRepeats(scenario, incidentId, runtime, readers, environment, 2 * ALERT_REPEAT_WAIT_MILLISECONDS);
        await capture(incidentId);
        requireUnchangedRuns(settledIds, result.lifecycle.runs.map((run) => run.runId));
        requireLifecycleCoverage(scenario, result.lifecycle, eventsByIncident);
      } else requireUnchangedRuns(initialIds, result.lifecycle.runs.map((run) => run.runId));
      if (scenario.lifecycle.kind === "reconfigured-deployment") {
        const beforeConfiguration = new Set((await readRunHistory(runtime, incidentId)).items.map((run) => run.id));
        await runScenario(environment.scenarioRunner, "reconfigure", scenarioId, dependencies);
        await waitUntil("diagnosis_not_terminal", async () => {
          const history = await readRunHistory(runtime, incidentId);
          return history.items.some((run) => !beforeConfiguration.has(run.id) && run.status === "COMPLETED");
        }, scenario.lifecycle.recovery_timeout_seconds! * 1000, environment.sleep);
        await capture(incidentId);
        if (!result.lifecycle.runs.some((run) => !beforeConfiguration.has(run.runId) && run.trigger.reason === "facts_changed")) throw upstreamContractError();
        requireLifecycleCoverage(scenario, result.lifecycle, eventsByIncident);
        // Clearing the old alert before creating the same name gives the producer a real
        // new occurrence; deletion itself is never counted as recovery of the old UID.
        await runScenario(environment.scenarioRunner, "cleanup", scenarioId, dependencies);
        await waitForAlertState(scenario, false, readers, environment.sleep);
        const beforeReplacement = await readIncidentIds(runtime);
        await runScenario(environment.scenarioRunner, "apply", scenarioId, dependencies);
        await waitForAlertState(scenario, true, readers, environment.sleep);
        const replacement = await waitForNewIncident(scenario, beforeReplacement, runtime, environment.sleep);
        await waitForTerminalIncident(replacement.incident.id, runtime, environment.sleep);
        await capture(replacement.incident.id);
        if (result.lifecycle.incidents.length !== 2 || new Set(result.lifecycle.incidents.map((item) => item.targetUid)).size !== 2) throw upstreamContractError();
      }
      const currentId = result.lifecycle.incidents.at(-1)!.incidentId;
      if (scenario.lifecycle.kind !== "persistent-pvc") {
        const beforeRecovery = new Set(result.lifecycle.runs.map((run) => run.runId));
        await runScenario(environment.scenarioRunner, "recover", scenarioId, dependencies);
        await waitUntil("incident_resolution_invalid", async () => {
          const final = await readIncident(runtime, currentId);
          return final.incident.lifecycleStatus === "CLOSED" && final.alertSummary.state === "CLEAR" && final.alertSummary.complete &&
            final.alertSummary.targetHealthy === true && final.closure?.basis === "observed_stable" ? final : undefined;
        }, scenario.lifecycle.recovery_timeout_seconds! * 1000, environment.sleep);
        await capture(currentId);
        requireUnchangedRuns(beforeRecovery, result.lifecycle.runs.map((run) => run.runId));
        result.checks.alertResolved = (await readIncident(runtime, currentId)).alertSignal?.status === "RESOLVED";
      }
      for (const episode of result.lifecycle.incidents) {
        episode.final = await readIncident(runtime, episode.incidentId);
        const history = await readRunHistory(runtime, episode.incidentId);
        requireUnchangedRuns(new Set(result.lifecycle.runs.filter((run) => run.incidentId === episode.incidentId).map((run) => run.runId)), history.items.map((run) => run.id));
      }
      const allTargetIncidents: string[] = [];
      for (const id of await readIncidentIds(runtime)) {
        if (!incidentsBefore.has(id) && sameTarget((await readIncident(runtime, id)).incident.target, scenario.target)) allTargetIncidents.push(id);
      }
      if (allTargetIncidents.length !== result.lifecycle.incidents.length || allTargetIncidents.some((id) => !result.lifecycle!.incidents.some((item) => item.incidentId === id))) {
        throw contractError("duplicate_target_incident", "The lifecycle case created an unaccounted target Incident");
      }
      requireLifecycleCoverage(scenario, result.lifecycle, eventsByIncident);
      const first = snapshots[0];
      result.runId = first.selectedRun.id;
      result.checks.run = observedRun(first);
      result.checks.panels = result.lifecycle.runs[0].panels;
      result.checks.consoleDetail = true;
      result.checks.repeatDeliveryDeduplicated = true;
      await requireControlAlertsAbsent(scenario, readers);
      await requireControlIncidentsAbsent(scenario, incidentsBefore, runtime);
      result.checks.healthyControls = true;
      result.reviewPackage = await captureReviewPackage(scenarioId, trial.index, first, {
        runtime, campaign: environment.campaign, profile: environment.profile, repositoryRoot: environment.repositoryRoot,
        now: environment.now, writeTrialPackage: environment.writeTrialPackage,
      }, { runs: snapshots, finalIncidents: result.lifecycle.incidents.map((item) => item.final), events: [...eventsByIncident.values()].flat() });
      result.status = "pending_manual_review";
      outcomeClass = "pending_manual_review";
    } else {
    const terminal = await waitForTerminalIncident(incidentId, runtime, environment.sleep);
    result.runId = terminal.selectedRun.id;
    // The Runtime's own terminal values, kept before any expectation is applied to them.
    result.checks.run = observedRun(terminal);
    result.reviewPackage = await captureReviewPackage(scenarioId, trial.index, terminal, {
      runtime,
      campaign: environment.campaign,
      profile: environment.profile,
      repositoryRoot: environment.repositoryRoot,
      now: environment.now,
      writeTrialPackage: environment.writeTrialPackage,
    });
    const summary = assessTerminal(scenario, terminal);
    result.checks.evidenceKinds = summary.evidenceKinds;
    result.checks.uncitedExpectedEvidence = summary.uncitedExpectedEvidence;
    result.checks.diagnosisCodes = summary.diagnosisCodes;
    result.checks.repair = summary.repair;

    const panels = await validateFiringPanels(terminal, runtime);
    result.checks.panels = panels;
    result.checks.sseReplay = await validateSseReplay(
      incidentId,
      terminal.eventCursor,
      terminal.selectedRun.id,
      terminal.repair,
      scenario.expectedTerminal,
      environment.fetchImpl,
    );
    await requireConsoleIncident(terminal, environment.fetchImpl);
    result.checks.consoleDetail = true;

    const repeatBaseline = await requireAlertReceipt(incidentId, terminal.selectedRun.id, runtime);
    await waitForAlertmanagerRepeat(scenario, incidentId, terminal.selectedRun.id, repeatBaseline, readers, environment.sleep);
    await requireSingleIncidentAndRun(scenario, incidentsBefore, incidentId, runtime);
    result.checks.repeatDeliveryDeduplicated = true;
    await requireControlAlertsAbsent(scenario, readers);
    await requireControlIncidentsAbsent(scenario, incidentsBefore, runtime);
    result.checks.healthyControls = true;

    await runScenario(environment.scenarioRunner, "cleanup", scenarioId, dependencies);
    applied = false;
    await waitForAlertState(scenario, false, readers, environment.sleep);
    const resolved = await waitForResolvedIncident(incidentId, runtime, environment.sleep);
    result.checks.alertResolved = true;
    result.checks.postResolutionPanelStates = await waitForPostResolutionPanels(incidentId, terminal.selectedRun.id, panels, runtime, environment.sleep);
    requireIncidentNotResolved(resolved);
    result.status = "pending_manual_review";
    outcomeClass = "pending_manual_review";
    }
  } catch (error) {
    result.failure = safeFailure(error);
    outcomeClass = classifyFailure(result);
  } finally {
    if (scenario.lifecycle !== undefined && snapshots.length > 0 && result.reviewPackage === null) {
      try {
        result.reviewPackage = await captureReviewPackage(scenarioId, trial.index, snapshots[0], {
          runtime, campaign: environment.campaign, profile: environment.profile, repositoryRoot: environment.repositoryRoot,
          now: environment.now, writeTrialPackage: environment.writeTrialPackage,
        }, { runs: snapshots, finalIncidents: result.lifecycle?.incidents.map((item) => item.final) ?? [], events: [...eventsByIncident.values()].flat() });
      } catch (error) {
        result.failure ??= safeFailure(error);
        result.status = "failed";
        outcomeClass = classifyFailure(result);
      }
    }
    if (applied) {
      try {
        await runScenario(environment.scenarioRunner, "cleanup", scenarioId, dependencies);
      } catch {
        result.cleanup = "failed";
        result.status = "failed";
        result.failure ??= safeFailure(contractError("cluster_command_failed", "Scenario cleanup failed"));
        outcomeClass = classifyFailure(result);
      }
    }
    trial.completedAt = requireDate(environment.now()).toISOString();
  }
  return { ...result, outcomeClass };
}
