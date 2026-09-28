import type { ReleaseManifest } from "../../../scripts/release.mjs";
import type { ScenarioCommandDependencies } from "../../../scripts/scenario.mjs";
import { requireConsoleIncidentIdentity, requireConsoleIncidentPage } from "../contracts/console.ts";
import type { EvaluationCase, ExecutionProfile, ExpectedTerminal } from "../contracts/dataset.ts";
import { readAlertmanagerAlert, readPrometheusAlert } from "../contracts/monitoring.ts";
import type { Campaign, OutcomeClass, PanelCheck, ScenarioResult, SseReplayCheck, Trial } from "../contracts/records.ts";
import {
  decodeSseFrame,
  readIncident,
  readIncidentIds,
  readIncidentSummaries,
  readPanel,
  readPanelCatalog,
  readRunHistory,
  splitSseFrames,
  type IncidentDetail,
  type RunEvent,
} from "../contracts/runtime-api.ts";
import { adaptScenarioExecutor, runScenario, type Execute, type ScenarioRunner } from "../environment/commands.ts";
import { bindJsonReader, readEventStream, requestText, type FetchLike } from "../environment/http.ts";
import { endpointOrigin } from "../environment/tunnels.ts";
import { contractError, safeFailure, upstreamContractError } from "../shared/errors.ts";
import { parseInstant, requireDate } from "../shared/guards.ts";
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
        if (matchesScenarioIncident(detail.incident, scenario)) candidates.push(detail);
      }
      return selectNewTargetIncident(candidates);
    },
    DIAGNOSIS_TIMEOUT_MILLISECONDS,
    sleep,
  );
}

async function waitForTerminalIncident(incidentId: string, runtime: ReadJson, sleep: Sleep): Promise<IncidentDetail> {
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

async function validateFiringPanels(incidentId: string, runtime: ReadJson): Promise<PanelCheck[]> {
  const results: PanelCheck[] = [];
  for (const reference of await readPanelCatalog(runtime, incidentId)) {
    const panel = await readPanel(runtime, incidentId, reference.panelId, reference.recommendedWindow);
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
  const identity = { incidentId, runId: runId as string };
  const events: RunEvent[] = [];
  let buffer = "";
  await readEventStream(fetchImpl, endpointOrigin("runtime"), `/api/v1/incidents/${incidentId}/events`, (chunk) => {
    const split = splitSseFrames(buffer + chunk);
    buffer = split.rest;
    for (const frame of split.frames) {
      const event = decodeSseFrame(frame, identity, events.at(-1)?.id);
      events.push(event);
      if (event.id === cursor) return true;
    }
    return false;
  });
  return validateReplayEvents(events, cursor as string, repair, expectedTerminal);
}

export async function requireConsoleIncident(detail: IncidentDetail, fetchImpl: FetchLike): Promise<void> {
  const identity = requireConsoleIncidentIdentity(detail);
  const document = await requestText(fetchImpl, endpointOrigin("console"), `/incidents/${identity.incidentId}`);
  requireConsoleIncidentPage(document, identity);
}

async function requireIncidentUpdatedAt(incidentId: string, runtime: ReadJson): Promise<number> {
  const incident = (await readIncidentSummaries(runtime)).get(incidentId);
  const timestamp = parseInstant(incident?.updatedAt);
  if (timestamp === undefined) throw upstreamContractError();
  return timestamp;
}

async function waitForAlertmanagerRepeat(
  scenario: EvaluationCase,
  incidentId: string,
  baselineUpdatedAt: number,
  readers: RuntimeReaders,
  sleep: Sleep,
): Promise<void> {
  await waitUntil(
    "alertmanager_repeat_not_observed",
    async () => {
      const stillFiring = await requireAlertState(scenario, true, readers);
      if (!stillFiring) return undefined;
      const current = await requireIncidentUpdatedAt(incidentId, readers.runtime);
      return current > baselineUpdatedAt ? current : undefined;
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
    if (matchesScenarioIncident(detail.incident, scenario)) targetIncidents.push(candidateId);
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
  panels: readonly PanelCheck[],
  runtime: ReadJson,
  sleep: Sleep,
): Promise<Array<{ panelId: string; state: PanelCheck["state"] }>> {
  const states: Array<{ panelId: string; state: PanelCheck["state"] }> = [];
  for (const reference of panels) {
    const panel = await waitUntil(
      "post_resolution_panel_not_settled",
      async () => {
        const document = await readPanel(runtime, incidentId, reference.panelId, reference.window);
        return isPostResolutionSettled(reference, document.result) ? document : undefined;
      },
      POST_RESOLUTION_TIMEOUT_MILLISECONDS,
      sleep,
    );
    states.push({ panelId: reference.panelId, state: panel.result.state });
  }
  return states;
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
  try {
    await runScenario(environment.scenarioRunner, "cleanup", scenarioId, dependencies);
    await waitForAlertState(scenario, false, readers, environment.sleep);
    result.checks.healthyBaseline = true;

    const incidentsBefore = await readIncidentIds(runtime);
    // The operator may fail after creating only part of a fixture.
    applied = true;
    await runScenario(environment.scenarioRunner, "apply", scenarioId, dependencies);
    await runScenario(environment.scenarioRunner, "verify", scenarioId, dependencies);
    result.checks.fixtureVerified = true;

    await waitForAlertState(scenario, true, readers, environment.sleep);
    result.checks.prometheusFiring = true;
    result.checks.alertmanagerFiring = true;
    await requireControlAlertsAbsent(scenario, readers);

    const detail = await waitForNewIncident(scenario, incidentsBefore, runtime, environment.sleep);
    const incidentId = detail.incident.id;
    result.incidentId = incidentId;
    result.checks.uniqueIncident = true;

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

    const panels = await validateFiringPanels(incidentId, runtime);
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

    const repeatBaseline = await requireIncidentUpdatedAt(incidentId, runtime);
    await waitForAlertmanagerRepeat(scenario, incidentId, repeatBaseline, readers, environment.sleep);
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
    result.checks.postResolutionPanelStates = await waitForPostResolutionPanels(incidentId, panels, runtime, environment.sleep);
    requireIncidentNotResolved(resolved);
    result.status = "pending_manual_review";
    outcomeClass = "pending_manual_review";
  } catch (error) {
    result.failure = safeFailure(error);
    outcomeClass = classifyFailure(result);
  } finally {
    if (applied) {
      try {
        await runScenario(environment.scenarioRunner, "cleanup", scenarioId, dependencies);
      } catch {
        result.cleanup = "failed";
      }
    }
    trial.completedAt = requireDate(environment.now()).toISOString();
  }
  return { ...result, outcomeClass };
}
