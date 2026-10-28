import type { EvaluationCase } from "../contracts/dataset.ts";
import type { InfrastructureResult, PanelCheck, ScenarioResult } from "../contracts/records.ts";
import {
  isHealthyMonitoring,
  readIncident,
  readIncidentIds,
  readIncidentForRun,
  readRunHistory,
  readMonitoringHealth,
  readPanel,
  type MetricPanel,
  type MonitoringHealth,
} from "../contracts/runtime-api.ts";
import { APPLICATION_NAMESPACE, MONITORING_NAMESPACE } from "../environment/cluster.ts";
import {
  restartFixedPod,
  rotateWebhookCredential,
  runScenario,
  scaleMonitoringDeployment,
} from "../environment/commands.ts";
import type { Tunnels } from "../environment/tunnels.ts";
import { upstreamContractError } from "../shared/errors.ts";
import { parseInstant } from "../shared/guards.ts";
import type { ReadJson } from "../shared/json.ts";
import {
  HEALTH_TIMEOUT_MILLISECONDS,
  POST_RESOLUTION_TIMEOUT_MILLISECONDS,
  waitUntil,
  type Sleep,
} from "../shared/wait.ts";
import { matchesScenarioIncident } from "./gates/incident.ts";
import { isRiskyValue } from "./gates/panels.ts";
import { validateReplayEvents } from "./gates/sse.ts";
import {
  requireConsoleIncident,
  runtimeReaders,
  scenarioDependencies,
  readIncidentReplay,
  type TrialEnvironment,
} from "./trial.ts";

export interface ProbeEnvironment extends Omit<TrialEnvironment, "campaign" | "writeTrialPackage" | "now"> {
  scenarios: readonly EvaluationCase[];
  tunnels: Tunnels;
}

export async function waitForHealthyMonitoring(runtime: ReadJson, sleep: Sleep): Promise<MonitoringHealth> {
  return waitUntil(
    "monitoring_not_healthy",
    async () => {
      const health = await readMonitoringHealth(runtime);
      return isHealthyMonitoring(health) ? health : undefined;
    },
    HEALTH_TIMEOUT_MILLISECONDS,
    sleep,
  );
}

async function requireWatchdogTimestamp(runtime: ReadJson, sleep: Sleep): Promise<number> {
  const health = await waitForHealthyMonitoring(runtime, sleep);
  const timestamp = parseInstant(health.watchdogLastReceivedAt);
  if (timestamp === undefined) throw upstreamContractError();
  return timestamp;
}

async function waitForFreshWatchdog(baseline: number, runtime: ReadJson, sleep: Sleep): Promise<MonitoringHealth> {
  return waitUntil(
    "rotated_webhook_not_observed",
    async () => {
      const health = await readMonitoringHealth(runtime);
      if (!isHealthyMonitoring(health)) return undefined;
      const current = parseInstant(health.watchdogLastReceivedAt);
      return current !== undefined && current > baseline ? health : undefined;
    },
    HEALTH_TIMEOUT_MILLISECONDS,
    sleep,
  );
}

async function findLatestIncidentIdForScenario(scenario: EvaluationCase, runtime: ReadJson, excluded: ReadonlySet<string> = new Set()): Promise<string | undefined> {
  for (const incidentId of await readIncidentIds(runtime)) {
    if (excluded.has(incidentId)) continue;
    const detail = await readIncident(runtime, incidentId);
    if (matchesScenarioIncident(detail, scenario)) return incidentId;
  }
  return undefined;
}

async function waitForPanelState(
  incidentId: string,
  panel: PanelCheck,
  states: ReadonlySet<string>,
  runtime: ReadJson,
  sleep: Sleep,
  timeout: number,
): Promise<MetricPanel> {
  return waitUntil(
    "metric_state_not_observed",
    async () => {
      const document = await readPanel(runtime, incidentId, panel.panelId, panel.window);
      return states.has(document.result.state) ? document : undefined;
    },
    timeout,
    sleep,
  );
}

async function waitForRiskyPanel(incidentId: string, panel: PanelCheck, runtime: ReadJson, sleep: Sleep): Promise<MetricPanel> {
  return waitUntil(
    "metric_probe_not_observable",
    async () => {
      const document = await readPanel(runtime, incidentId, panel.panelId, panel.window);
      return document.result.state === "ok" && isRiskyValue(document.result) ? document : undefined;
    },
    HEALTH_TIMEOUT_MILLISECONDS,
    sleep,
  );
}

// Re-applies the last passing scenario and proves the fixed cluster recovers from monitoring
// outages, credential rotation and workload restarts with its persisted Incident intact.
export async function runInfrastructureProbe(probe: ScenarioResult, environment: ProbeEnvironment): Promise<InfrastructureResult> {
  const panel = probe.checks.panels.find((candidate) => candidate.signalRole === "trigger");
  const scenario = environment.scenarios.find((candidate) => candidate.scenarioId === probe.scenarioId);
  if (panel === undefined || scenario === undefined) {
    return { status: "failed", failureCode: "panel_probe_unavailable" };
  }
  const readers = runtimeReaders(environment.fetchImpl);
  const runtime = readers.runtime;
  const existingId = await findLatestIncidentIdForScenario(scenario, runtime);
  if (existingId === undefined) {
    return { status: "failed", failureCode: "incident_probe_unavailable" };
  }

  const checks = {
    kubeStateMetricsStale: false,
    prometheusUnavailable: false,
    secretRotation: false,
    workloadRecovery: false,
    persistedIncidentReplay: false,
  };
  const dependencies = scenarioDependencies(environment);
  const { context, execute, sleep } = environment;
  const before = await readIncidentIds(runtime);
  let applied = false;
  try {
    applied = true;
    await runScenario(environment.scenarioRunner, "apply", scenario.scenarioId, dependencies);
    await runScenario(environment.scenarioRunner, "verify", scenario.scenarioId, dependencies);
    const incidentId = await waitUntil("incident_not_created", () => findLatestIncidentIdForScenario(scenario, runtime, before), scenario.alertWaitMilliseconds, sleep);
    const initial = await readIncident(runtime, incidentId);
    const initialRuns = await readRunHistory(runtime, incidentId);
    const initialEvents = await readIncidentReplay(incidentId, initial.eventCursor, new Set(initialRuns.items.map((run) => run.id)), environment.fetchImpl);
    const uids = new Set(initialEvents.filter((event) => event.event === "alert.associated").map((event) => (event.data as unknown as { targetUid: string }).targetUid));
    if (uids.size !== 1 || ![...uids][0] || probe.lifecycle?.incidents.some((episode) => uids.has(episode.targetUid))) throw upstreamContractError();
    await waitForRiskyPanel(incidentId, panel, runtime, sleep);

    try {
      await scaleMonitoringDeployment("kube-state-metrics", 0, context, execute);
      await waitForPanelState(incidentId, panel, new Set(["stale"]), runtime, sleep, POST_RESOLUTION_TIMEOUT_MILLISECONDS);
      checks.kubeStateMetricsStale = true;
    } finally {
      await scaleMonitoringDeployment("kube-state-metrics", 1, context, execute);
    }
    await waitForPanelState(incidentId, panel, new Set(["ok"]), runtime, sleep, HEALTH_TIMEOUT_MILLISECONDS);

    try {
      await scaleMonitoringDeployment("prometheus", 0, context, execute);
      await waitForPanelState(incidentId, panel, new Set(["monitoring_unavailable"]), runtime, sleep, HEALTH_TIMEOUT_MILLISECONDS);
      checks.prometheusUnavailable = true;
    } finally {
      await scaleMonitoringDeployment("prometheus", 1, context, execute);
    }

    await environment.tunnels.restart();
    await waitForHealthyMonitoring(runtime, sleep);
    await waitForPanelState(incidentId, panel, new Set(["ok"]), runtime, sleep, HEALTH_TIMEOUT_MILLISECONDS);
    const watchdogBeforeRotation = await requireWatchdogTimestamp(runtime, sleep);
    await rotateWebhookCredential(context, execute);
    await restartFixedPod(APPLICATION_NAMESPACE, "agent-runtime", context, execute);
    await restartFixedPod(MONITORING_NAMESPACE, "alertmanager", context, execute);
    await environment.tunnels.restart();
    await waitForFreshWatchdog(watchdogBeforeRotation, runtime, sleep);
    const recovered = await readIncident(runtime, incidentId);
    if (recovered.selectedRun === null) throw upstreamContractError();
    const history = await readRunHistory(runtime, incidentId);
    const events = await readIncidentReplay(incidentId, recovered.eventCursor, new Set(history.items.map((run) => run.id)), environment.fetchImpl);
    for (const run of history.items) {
      const detail = await readIncidentForRun(runtime, incidentId, run.id);
      validateReplayEvents(events, recovered.eventCursor, detail.repair, probe.expectedTerminal, run.id);
    }
    await requireConsoleIncident(recovered, environment.fetchImpl);
    checks.secretRotation = true;
    checks.workloadRecovery = true;
    checks.persistedIncidentReplay = true;
    return { status: "passed", checks };
  } finally {
    if (applied) {
      await runScenario(environment.scenarioRunner, "cleanup", scenario.scenarioId, dependencies);
    }
  }
}
