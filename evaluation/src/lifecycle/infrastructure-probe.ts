import type { EvaluationCase } from "../contracts/dataset.ts";
import type { InfrastructureResult, PanelCheck, ScenarioResult } from "../contracts/records.ts";
import {
  isHealthyMonitoring,
  readIncident,
  readIncidentIds,
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
import {
  requireConsoleIncident,
  runtimeReaders,
  scenarioDependencies,
  validateSseReplay,
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

async function findLatestIncidentIdForScenario(scenario: EvaluationCase, runtime: ReadJson): Promise<string | undefined> {
  for (const incidentId of await readIncidentIds(runtime)) {
    const detail = await readIncident(runtime, incidentId);
    if (matchesScenarioIncident(detail.incident, scenario)) return incidentId;
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
  const incidentId = await findLatestIncidentIdForScenario(scenario, runtime);
  if (incidentId === undefined) {
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
  let applied = false;
  try {
    applied = true;
    await runScenario(environment.scenarioRunner, "apply", scenario.scenarioId, dependencies);
    await runScenario(environment.scenarioRunner, "verify", scenario.scenarioId, dependencies);
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
    await validateSseReplay(
      incidentId,
      recovered.eventCursor,
      recovered.selectedRun.id,
      recovered.repair,
      probe.expectedTerminal,
      environment.fetchImpl,
    );
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
