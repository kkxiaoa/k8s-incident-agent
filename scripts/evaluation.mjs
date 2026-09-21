import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { load } from "js-yaml";

import { verifyDeploymentStatus } from "./deployment.mjs";
import {
  loadEvaluationScenarioCatalog,
  runScenarioCommand,
  ScenarioCommandError,
  supportedScenarioVersion,
} from "./scenario.mjs";

const KIND_CONTEXT = "kind-k8s-incident-agent";
const APPLICATION_NAMESPACE = "k8s-incident-agent";
const MONITORING_NAMESPACE = "k8s-incident-monitoring";
const ARTIFACT_SCHEMA_VERSION = 2;
const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;
const MAX_INCIDENT_PAGES = 10;
const HTTP_TIMEOUT_MILLISECONDS = 15_000;
const POLL_INTERVAL_MILLISECONDS = 2_000;
const HEALTH_TIMEOUT_MILLISECONDS = 2 * 60_000;
const ALERT_TIMEOUT_MILLISECONDS = 7 * 60_000;
const DIAGNOSIS_TIMEOUT_MILLISECONDS = 5 * 60_000;
const RESOLUTION_TIMEOUT_MILLISECONDS = 3 * 60_000;
const POST_RESOLUTION_TIMEOUT_MILLISECONDS = 90_000;
const ALERT_REPEAT_WAIT_MILLISECONDS = 5 * 60_000 + 30_000;
const PORT_FORWARD_TIMEOUT_MILLISECONDS = 60_000;
const COMMAND_TIMEOUT_MILLISECONDS = 5 * 60_000;
const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "FAILED"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOT_CAUSE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const RELEASE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RELEASE_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const OCI_INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const OCI_CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json";
const RELEASE_PLATFORMS = new Set(["linux/amd64", "linux/arm64"]);
const RELEASE_LOCK_FILES = new Set([
  "deploy/application/base/workloads/kustomization.yaml",
  "deploy/monitoring/overlays/kind/kustomization.yaml",
]);
const PROFILE_DEFINITIONS = Object.freeze({
  "kind-evaluation": Object.freeze({
    context: KIND_CONTEXT,
    intakeMode: "manual",
  }),
  "k3s-evaluation": Object.freeze({
    context: undefined,
    intakeMode: "manual",
  }),
  "k3s-online": Object.freeze({
    context: undefined,
    intakeMode: "online",
  }),
});
const ENDPOINTS = Object.freeze({
  runtime: Object.freeze({
    namespace: APPLICATION_NAMESPACE,
    resource: "service/agent-runtime",
    localPort: 18_080,
    remotePort: 8_000,
    readyPath: "/healthz",
  }),
  console: Object.freeze({
    namespace: APPLICATION_NAMESPACE,
    resource: "service/incident-console",
    localPort: 13_000,
    remotePort: 80,
    readyPath: "/api/healthz",
  }),
  prometheus: Object.freeze({
    namespace: MONITORING_NAMESPACE,
    resource: "service/prometheus",
    localPort: 19_090,
    remotePort: 9_090,
    readyPath: "/-/ready",
  }),
  alertmanager: Object.freeze({
    namespace: MONITORING_NAMESPACE,
    resource: "service/alertmanager",
    localPort: 19_093,
    remotePort: 9_093,
    readyPath: "/-/ready",
  }),
});

export class EvaluationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EvaluationError";
    this.code = code;
  }
}

class TransientEvaluationError extends EvaluationError {}

export async function runEvaluationCommand(request, dependencies = {}) {
  const repositoryRoot = path.resolve(
    dependencies.repositoryRoot ?? repositoryRootFromModule(),
  );
  const profile = requireProfile(request?.profile);
  const context = resolveContext(profile, request?.context);
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? defaultSleep;
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const execute = dependencies.execute ?? executeExternalCommand;
  const deploymentStatus =
    dependencies.verifyDeploymentStatus ?? verifyDeploymentStatus;
  const scenarios =
    dependencies.scenarios ??
    loadEvaluationScenarioCatalog(repositoryRoot, dependencies.environment);
  const scenarioRunner = dependencies.runScenarioCommand ?? runScenarioCommand;
  if (!new Set(["run", "online"]).has(request.action)) throw invalidArguments();
  if ((request.action === "online") !== (profile === "k3s-online")) {
    throw invalidArguments();
  }
  const focused = request.scenarioIds !== undefined;
  if (request.action === "online" && focused) throw invalidArguments();
  if (request.action === "run") requireEvaluationCatalog(scenarios);
  if (
    focused &&
    (!Array.isArray(request.scenarioIds) ||
      request.scenarioIds.length === 0 ||
      new Set(request.scenarioIds).size !== request.scenarioIds.length ||
      request.scenarioIds.some(
        (id) => !scenarios.some((scenario) => scenario.scenarioId === id),
      ))
  ) {
    throw invalidArguments();
  }
  const selectedScenarioIds = focused
    ? request.scenarioIds
    : scenarios.map((scenario) => scenario.scenarioId);
  const release = await loadReleaseIdentity(
    repositoryRoot,
    dependencies.readFile ?? readFile,
    execute,
  );
  const startedAt = requireDate(now()).toISOString();

  await deploymentStatus(profile, context, {
    repositoryRoot,
    execute: adaptDeploymentExecutor(execute),
  });

  const tunnels = await (dependencies.openTunnels ?? openPortForwards)(
    context,
    { fetchImpl, sleep },
  );
  let artifact;
  try {
    try {
      const authenticatedFetch = await operatorFetch(fetchImpl, profile, dependencies.environment ?? process.env);
      if (request.action === "online") {
        artifact = await evaluateOnlineBoundary({
          profile,
          release,
          startedAt,
          completedAt: () => requireDate(now()).toISOString(),
          fetchImpl: authenticatedFetch,
          anonymousFetch: fetchImpl,
        });
      } else {
        artifact = await evaluateCatalog({
          profile,
          context,
          release,
          startedAt,
          completedAt: () => requireDate(now()).toISOString(),
          scenarios,
          focused,
          selectedScenarioIds,
          scenarioRunner,
          repositoryRoot,
          execute,
          fetchImpl: authenticatedFetch,
          sleep,
          tunnels,
          now,
        });
      }
    } catch (error) {
      artifact = {
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        kind:
          request.action === "online"
            ? "online-boundary-evaluation"
            : "catalog-evaluation",
        profile,
        release,
        startedAt,
        completedAt: requireDate(now()).toISOString(),
        status: "failed",
        ...(request.action === "run"
          ? { scope: focused ? "focused" : "full", selectedScenarioIds }
          : {}),
        failure: safeFailure(error),
      };
    }
  } finally {
    await tunnels.close();
  }

  const artifactPath = await (
    dependencies.writeArtifact ?? writeEvaluationArtifact
  )(repositoryRoot, profile, artifact);
  return { artifact, artifactPath };
}

async function operatorFetch(fetchImpl, profile, environment) {
  const failure = () => contractError("operator_authentication_failed", "Evaluation operator authentication failed");
  let origin;
  let password;
  try {
    const configured = environment.OPERATOR_ORIGIN;
    origin = new URL(configured);
    if (origin.origin !== configured || origin.username || origin.password ||
        (profile === "kind-evaluation" ? configured !== endpointOrigin("console") : origin.protocol !== "https:")) throw failure();
    const filename = environment.OPERATOR_PASSWORD_FILE;
    if (typeof filename !== "string" || !path.isAbsolute(filename)) throw failure();
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 1024) throw failure();
      const bytes = Buffer.alloc(1025);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead < 1 || bytesRead > 1024) throw failure();
      password = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
    } finally { await file.close(); }
  } catch { throw failure(); }
  let cookie;
  let csrf;
  let expiresAt = 0;
  let pendingLogin;
  async function login() {
    if (pendingLogin) return pendingLogin;
    pendingLogin = (async () => {
      try {
        const response = await fetchImpl(`${endpointOrigin("runtime")}/api/v1/operator/login`, {
          method: "POST", headers: { "content-type": "application/json", Origin: origin.origin },
          body: JSON.stringify({ password }), redirect: "error", signal: AbortSignal.timeout(HTTP_TIMEOUT_MILLISECONDS),
        });
        if (response.status !== 200) throw failure();
        const bytes = await readResponseBytes(response, 8192);
        const session = JSON.parse(new TextDecoder().decode(bytes));
        const cookies = response.headers.getSetCookie();
        if (cookies.length !== 1 || cookies[0].length > 512 ||
            !/^__Host-k8s-incident-session=[A-Za-z0-9_-]{43};/.test(cookies[0]) ||
            !/(?:^|;\s*)HttpOnly(?:;|$)/i.test(cookies[0]) ||
            !/(?:^|;\s*)Secure(?:;|$)/i.test(cookies[0]) ||
            !/(?:^|;\s*)SameSite=strict(?:;|$)/i.test(cookies[0]) ||
            !/(?:^|;\s*)Path=\/(?:;|$)/i.test(cookies[0]) ||
            /(?:^|;\s*)Domain=/i.test(cookies[0]) ||
            session.operatorRef !== "sandbox-operator" || !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= Date.now() / 1000 ||
            typeof session.csrfToken !== "string" || !/^[a-f0-9]{64}$/.test(session.csrfToken)) throw failure();
        cookie = cookies[0].split(";")[0];
        csrf = session.csrfToken;
        expiresAt = session.expiresAt;
      } catch { throw failure(); }
    })();
    try { await pendingLogin; } finally { pendingLogin = undefined; }
  }
  await login();
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const runtime = url.origin === endpointOrigin("runtime");
    const console = url.origin === endpointOrigin("console");
    if ((!runtime && !console) || url.pathname === "/healthz" || url.pathname === "/api/healthz") return fetchImpl(input, { ...init, redirect: "error" });
    if (expiresAt <= Date.now() / 1000) await login();
    const method = init.method ?? "GET";
    const send = () => {
      const headers = new Headers(init.headers);
      headers.set("Cookie", cookie);
      if (!["GET", "HEAD"].includes(method)) {
        headers.set("Origin", origin.origin);
        headers.set("X-CSRF-Token", csrf);
      }
      return fetchImpl(input, { ...init, headers, redirect: "error" });
    };
    let response = await send();
    // Only reads can be retried after Runtime restart/revocation. Mutations keep
    // their original failure; a lost response is never permission to replay.
    if (response.status === 401 && ["GET", "HEAD"].includes(method)) {
      await response.body?.cancel();
      await login();
      response = await send();
    }
    return response;
  };
}

async function evaluateCatalog(options) {
  const initialHealth = await waitForHealthyMonitoring(
    options.fetchImpl,
    options.sleep,
  );
  const results = [];
  for (const scenario of options.scenarios) {
    results.push(
      options.selectedScenarioIds.includes(scenario.scenarioId)
        ? await evaluateScenario(scenario, options)
        : { ...emptyScenarioResult(scenario), status: "not_run", cleanup: "not_run" },
    );
  }

  const passedScenarios = results.filter(
    (result) => result.status === "pending_manual_review",
  );
  let infrastructure;
  if (options.focused) {
    infrastructure = { status: "not_run", reason: "focused_evaluation" };
  } else if (passedScenarios.length === 0) {
    infrastructure = {
      status: "not_run",
      reason: "no_scenario_passed",
    };
  } else {
    try {
      infrastructure = await evaluateInfrastructureRecovery(
        passedScenarios.at(-1),
        options,
      );
    } catch (error) {
      infrastructure = {
        status: "failed",
        failure: safeFailure(error),
      };
    }
  }

  const families = summarizeFamilies(results);
  const passed =
    passedScenarios.length === options.selectedScenarioIds.length &&
    (options.focused || infrastructure.status === "passed");
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    kind: "catalog-evaluation",
    profile: options.profile,
    release: options.release,
    startedAt: options.startedAt,
    completedAt: options.completedAt(),
    status: passed ? "pending_manual_review" : "failed",
    scope: options.focused ? "focused" : "full",
    selectedScenarioIds: options.selectedScenarioIds,
    monitoring: {
      initialState: initialHealth.state,
      infrastructure,
    },
    families,
    scenarios: results,
  };
}

async function evaluateScenario(scenario, options) {
  const result = emptyScenarioResult(scenario);
  let applied = false;
  let incidentId;
  try {
    await options.scenarioRunner("cleanup", scenario.scenarioId, {
      repositoryRoot: options.repositoryRoot,
      profile: options.profile,
      context: options.profile === "kind-evaluation" ? undefined : options.context,
      execute: adaptScenarioExecutor(options.execute),
    });
    await waitForAlertState(scenario, false, options);
    result.checks.healthyBaseline = true;

    const incidentsBefore = await listIncidentIds(options.fetchImpl);
    // The operator may fail after creating only part of a fixture.
    applied = true;
    await options.scenarioRunner("apply", scenario.scenarioId, {
      repositoryRoot: options.repositoryRoot,
      profile: options.profile,
      context: options.profile === "kind-evaluation" ? undefined : options.context,
      execute: adaptScenarioExecutor(options.execute),
    });
    await options.scenarioRunner("verify", scenario.scenarioId, {
      repositoryRoot: options.repositoryRoot,
      profile: options.profile,
      context: options.profile === "kind-evaluation" ? undefined : options.context,
      execute: adaptScenarioExecutor(options.execute),
    });
    result.checks.fixtureVerified = true;

    await waitForAlertState(scenario, true, options);
    result.checks.prometheusFiring = true;
    result.checks.alertmanagerFiring = true;
    await requireControlAlertsAbsent(scenario, options.fetchImpl);

    const detail = await waitForNewIncident(
      scenario,
      incidentsBefore,
      options.fetchImpl,
      options.sleep,
    );
    incidentId = detail.incident.id;
    result.incidentId = incidentId;
    result.checks.uniqueIncident = true;

    const terminal = await waitForTerminalIncident(
      incidentId,
      options.fetchImpl,
      options.sleep,
    );
    result.runId = terminal.selectedRun.id;
    const diagnosisSummary = validateTerminalDiagnosis(scenario, terminal);
    result.checks.run = diagnosisSummary.run;
    result.checks.evidenceKinds = diagnosisSummary.evidenceKinds;
    result.checks.uncitedExpectedEvidence =
      diagnosisSummary.uncitedExpectedEvidence;
    result.checks.diagnosisCodes = diagnosisSummary.diagnosisCodes;
    result.checks.repair = diagnosisSummary.repair;

    const panels = await validateFiringPanels(
      incidentId,
      options.fetchImpl,
    );
    result.checks.panels = panels;
    const replay = await validateSseReplay(
      incidentId,
      terminal.eventCursor,
      terminal.selectedRun.id,
      terminal.repair,
      options.fetchImpl,
    );
    result.checks.sseReplay = replay;
    await requireConsoleIncident(terminal, options.fetchImpl);
    result.checks.consoleDetail = true;

    const repeatBaseline = await requireIncidentUpdatedAt(
      incidentId,
      options.fetchImpl,
    );
    await waitForAlertmanagerRepeat(
      scenario,
      incidentId,
      repeatBaseline,
      options,
    );
    await requireSingleIncidentAndRun(
      scenario,
      incidentsBefore,
      incidentId,
      options.fetchImpl,
    );
    result.checks.repeatDeliveryDeduplicated = true;
    await requireControlAlertsAbsent(scenario, options.fetchImpl);
    await requireControlIncidentsAbsent(
      scenario,
      incidentsBefore,
      options.fetchImpl,
    );
    result.checks.healthyControls = true;

    await options.scenarioRunner("cleanup", scenario.scenarioId, {
      repositoryRoot: options.repositoryRoot,
      profile: options.profile,
      context: options.profile === "kind-evaluation" ? undefined : options.context,
      execute: adaptScenarioExecutor(options.execute),
    });
    applied = false;
    await waitForAlertState(scenario, false, options);
    const resolved = await waitForResolvedIncident(
      incidentId,
      options.fetchImpl,
      options.sleep,
    );
    result.checks.alertResolved = true;
    result.checks.postResolutionPanelStates = await waitForPostResolutionPanels(
      incidentId,
      panels,
      options.fetchImpl,
      options.sleep,
    );
    if (resolved.incident.status === "RESOLVED") {
      throw contractError(
        "incident_resolution_invalid",
        "Alert resolution must not resolve the Incident",
      );
    }
    result.status = "pending_manual_review";
  } catch (error) {
    result.failure = safeFailure(error);
  } finally {
    if (applied) {
      try {
        await options.scenarioRunner("cleanup", scenario.scenarioId, {
          repositoryRoot: options.repositoryRoot,
          profile: options.profile,
          context:
            options.profile === "kind-evaluation" ? undefined : options.context,
          execute: adaptScenarioExecutor(options.execute),
        });
      } catch {
        result.cleanup = "failed";
      }
    }
  }
  return result;
}

async function evaluateInfrastructureRecovery(probe, options) {
  const panel = probe.checks.panels?.find(
    (panel) => panel.signalRole === "trigger",
  );
  const scenario = options.scenarios.find(
    (candidate) => candidate.scenarioId === probe.scenarioId,
  );
  if (panel === undefined || scenario === undefined) {
    return { status: "failed", failureCode: "panel_probe_unavailable" };
  }
  const incidentId = await findLatestIncidentIdForScenario(
    scenario,
    options.fetchImpl,
  );
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
  let applied = false;
  try {
    applied = true;
    await options.scenarioRunner("apply", scenario.scenarioId, {
      repositoryRoot: options.repositoryRoot,
      profile: options.profile,
      context:
        options.profile === "kind-evaluation" ? undefined : options.context,
      execute: adaptScenarioExecutor(options.execute),
    });
    await options.scenarioRunner("verify", scenario.scenarioId, {
      repositoryRoot: options.repositoryRoot,
      profile: options.profile,
      context:
        options.profile === "kind-evaluation" ? undefined : options.context,
      execute: adaptScenarioExecutor(options.execute),
    });
    await waitForRiskyPanel(
      incidentId,
      panel.panelId,
      panel.window,
      options.fetchImpl,
      options.sleep,
    );

    try {
      await scaleMonitoringDeployment(
        "kube-state-metrics",
        0,
        options.context,
        options.execute,
      );
      await waitForPanelState(
        incidentId,
        panel.panelId,
        panel.window,
        new Set(["stale"]),
        options.fetchImpl,
        options.sleep,
        POST_RESOLUTION_TIMEOUT_MILLISECONDS,
      );
      checks.kubeStateMetricsStale = true;
    } finally {
      await scaleMonitoringDeployment(
        "kube-state-metrics",
        1,
        options.context,
        options.execute,
      );
    }
    await waitForPanelState(
      incidentId,
      panel.panelId,
      panel.window,
      new Set(["ok"]),
      options.fetchImpl,
      options.sleep,
      HEALTH_TIMEOUT_MILLISECONDS,
    );

    try {
      await scaleMonitoringDeployment(
        "prometheus",
        0,
        options.context,
        options.execute,
      );
      await waitForPanelState(
        incidentId,
        panel.panelId,
        panel.window,
        new Set(["monitoring_unavailable"]),
        options.fetchImpl,
        options.sleep,
        HEALTH_TIMEOUT_MILLISECONDS,
      );
      checks.prometheusUnavailable = true;
    } finally {
      await scaleMonitoringDeployment(
        "prometheus",
        1,
        options.context,
        options.execute,
      );
    }

    await options.tunnels.restart();
    await waitForHealthyMonitoring(options.fetchImpl, options.sleep);
    await waitForPanelState(
      incidentId,
      panel.panelId,
      panel.window,
      new Set(["ok"]),
      options.fetchImpl,
      options.sleep,
      HEALTH_TIMEOUT_MILLISECONDS,
    );
    const watchdogBeforeRotation = await requireWatchdogTimestamp(
      options.fetchImpl,
      options.sleep,
    );
    await rotateWebhookCredential(options.context, options.execute);
    await restartFixedPod(
      APPLICATION_NAMESPACE,
      "agent-runtime",
      options.context,
      options.execute,
    );
    await restartFixedPod(
      MONITORING_NAMESPACE,
      "alertmanager",
      options.context,
      options.execute,
    );
    await options.tunnels.restart();
    await waitForFreshWatchdog(
      watchdogBeforeRotation,
      options.fetchImpl,
      options.sleep,
    );
    const recovered = await getIncident(incidentId, options.fetchImpl);
    await validateSseReplay(
      incidentId,
      recovered.eventCursor,
      recovered.selectedRun.id,
      recovered.repair,
      options.fetchImpl,
    );
    await requireConsoleIncident(recovered, options.fetchImpl);
    checks.secretRotation = true;
    checks.workloadRecovery = true;
    checks.persistedIncidentReplay = true;
    return { status: "passed", checks };
  } finally {
    if (applied) {
      await options.scenarioRunner("cleanup", scenario.scenarioId, {
        repositoryRoot: options.repositoryRoot,
        profile: options.profile,
        context:
          options.profile === "kind-evaluation" ? undefined : options.context,
        execute: adaptScenarioExecutor(options.execute),
      });
    }
  }
}

async function evaluateOnlineBoundary(options) {
  const incidents = await listIncidentSummaries(options.fetchImpl);
  const [scenariosStatus, createIncidentStatus] =
    await Promise.all([
      requestStatus(
        options.fetchImpl,
        endpointOrigin("runtime"),
        "/api/v1/scenarios",
      ),
      requestStatus(
        options.fetchImpl,
        endpointOrigin("runtime"),
        "/api/v1/incidents",
        { method: "POST" },
      ),
    ]);
  if (
    scenariosStatus !== 404 ||
    createIncidentStatus !== 405
  ) {
    throw contractError(
      "online_route_set_invalid",
      "Online profile exposes a manual intake route",
    );
  }
  const incidentId = incidents.keys().next().value;
  if (incidentId === undefined) {
    throw contractError("online_existing_incident_required", "Rerun boundary requires an existing Incident");
  }
  const before = await getIncident(incidentId, options.fetchImpl);
  if (!Number.isSafeInteger(before.selectedRun?.attempt) || before.selectedRun.attempt < 1) throw upstreamContractError();
  const path = `/api/v1/incidents/${incidentId}/runs`;
  const mutation = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
  const anonymous = await request(options.anonymousFetch, endpointOrigin("runtime"), path, mutation);
  if (anonymous.status !== 401 || parseJson(anonymous.body)?.error?.code !== "operator_authentication_required") {
    throw contractError("online_rerun_boundary_invalid", "Anonymous rerun was not rejected by authentication");
  }
  const response = await request(options.fetchImpl, endpointOrigin("runtime"), path, mutation);
  const document = parseJson(response.body);
  let authenticatedRerun;
  if (response.status === 202 && document?.schemaVersion === 5 && UUID_PATTERN.test(document.runId ?? "")) {
    const created = await requestJson(options.fetchImpl, endpointOrigin("runtime"), `/api/v1/incidents/${incidentId}?runId=${document.runId}`);
    if (created?.schemaVersion !== 5 || created.incident?.id !== incidentId || created.selectedRun?.id !== document.runId
        || created.selectedRun.kind !== "diagnosis" || created.selectedRun.requestSource !== "operator"
        || !Number.isSafeInteger(created.selectedRun.attempt) || created.selectedRun.attempt <= before.selectedRun.attempt
        || !["QUEUED", "RUNNING", "COMPLETED", "FAILED"].includes(created.selectedRun.status)) throw upstreamContractError();
    authenticatedRerun = "accepted";
  } else if (response.status === 409 && document?.error?.code === "active_run_exists"
      && ["QUEUED", "RUNNING", "WAITING_APPROVAL"].includes(before.selectedRun.status)) {
    authenticatedRerun = "active_run_exists";
  } else if (response.status === 503 && document?.error?.code === "diagnosis_unavailable") {
    const health = await requestJson(options.fetchImpl, endpointOrigin("runtime"), "/healthz");
    if (health.diagnosis?.status !== "unavailable" || typeof health.diagnosis.reason !== "string") throw upstreamContractError();
    authenticatedRerun = "diagnosis_unavailable";
  } else {
    throw contractError("online_rerun_boundary_invalid", "Authenticated rerun did not match the Runtime state");
  }
  const home = await requestText(
    options.fetchImpl,
    endpointOrigin("console"),
    "/",
  );
  if (
    home.includes("离线评估入口") ||
    home.includes("创建 Incident")
  ) {
    throw contractError(
      "online_console_invalid",
      "Online Console exposes a manual intake control",
    );
  }
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    kind: "online-boundary-evaluation",
    profile: options.profile,
    release: options.release,
    startedAt: options.startedAt,
    completedAt: options.completedAt(),
    status: "passed",
    checks: {
      readRoutesAvailable: true,
      manualCreationAbsent: true,
      manualConsoleCreationAbsent: true,
      anonymousRerunDenied: true,
      authenticatedRerun,
    },
  };
}

function emptyScenarioResult(scenario) {
  return {
    scenarioId: scenario.scenarioId,
    scenarioVersion: scenario.scenarioVersion,
    familyId: scenarioFamily(scenario.verifierKind),
    alertId: scenario.alertId,
    status: "failed",
    cleanup: "passed",
    checks: {
      healthyBaseline: false,
      fixtureVerified: false,
      prometheusFiring: false,
      alertmanagerFiring: false,
      healthyControls: false,
      uniqueIncident: false,
      run: undefined,
      evidenceKinds: [],
      uncitedExpectedEvidence: [],
      diagnosisCodes: [],
      panels: [],
      sseReplay: undefined,
      consoleDetail: false,
      repair: undefined,
      repeatDeliveryDeduplicated: false,
      alertResolved: false,
      postResolutionPanelStates: [],
    },
  };
}

function requireEvaluationCatalog(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length !== 7) {
    throw contractError(
      "evaluation_catalog_invalid",
      "Evaluation catalog must contain the seven approved scenarios",
    );
  }
  const scenarioIds = new Set();
  const families = new Set();
  let repairExpectations = 0;
  for (const scenario of scenarios) {
    const expectedRepair = scenario?.expectedPatchConstraints;
    if (
      !isNormalizedString(scenario?.scenarioId) ||
      scenario.scenarioVersion !== supportedScenarioVersion(scenario.scenarioId) ||
      !isNormalizedString(scenario.alertId) ||
      !isPlainObject(scenario.target) ||
      !Array.isArray(scenario.requiredEvidence) ||
      scenario.requiredEvidence.length === 0 ||
      !Array.isArray(scenario.allowedTools) ||
      !Array.isArray(scenario.forbiddenTools) ||
      !Array.isArray(scenario.healthyControlNames) ||
      !(
        expectedRepair === undefined ||
        (isPlainObject(expectedRepair) &&
          hasExactKeys(expectedRepair, [
            "action",
            "containerIndex",
            "containerName",
            "currentImage",
            "replacementImage",
          ]) &&
          expectedRepair.action === "set_container_image" &&
          Number.isInteger(expectedRepair.containerIndex) &&
          expectedRepair.containerIndex >= 0 &&
          expectedRepair.containerIndex <= 255 &&
          isNormalizedString(expectedRepair.containerName) &&
          isNormalizedString(expectedRepair.currentImage) &&
          isNormalizedString(expectedRepair.replacementImage) &&
          expectedRepair.currentImage !== expectedRepair.replacementImage &&
          scenario.target.apiVersion === "apps/v1" &&
          scenario.target.kind === "Deployment" &&
          scenario.requiredEvidence.includes("workload") &&
          scenario.requiredEvidence.includes("rollout_history"))
      ) ||
      scenarioIds.has(scenario.scenarioId)
    ) {
      throw contractError(
        "evaluation_catalog_invalid",
        "Evaluation catalog does not satisfy the approved contract",
      );
    }
    scenarioIds.add(scenario.scenarioId);
    families.add(scenarioFamily(scenario.verifierKind));
    if (expectedRepair !== undefined) repairExpectations += 1;
  }
  if (families.size !== 5 || repairExpectations !== 1) {
    throw contractError(
      "evaluation_catalog_invalid",
      "Evaluation catalog must cover five fault families and one repair slice",
    );
  }
}

function scenarioFamily(verifierKind) {
  const family = {
    image_pull_backoff: "image-pull-backoff",
    crash_loop_backoff: "crash-loop-backoff",
    service_selector_mismatch: "service-selector-mismatch",
    readiness_probe_failure: "probe-misconfiguration",
    liveness_probe_failure: "probe-misconfiguration",
    pvc_pending: "pvc-pending",
  }[verifierKind];
  if (family === undefined) throw upstreamContractError();
  return family;
}

function summarizeFamilies(results) {
  const grouped = new Map();
  for (const result of results) {
    const statuses = grouped.get(result.familyId) ?? [];
    statuses.push(result.status);
    grouped.set(result.familyId, statuses);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([familyId, statuses]) => ({
      familyId,
      scenarios: statuses.length,
      status: statuses.includes("failed")
        ? "failed"
        : statuses.includes("not_run") ? "not_run" : "pending_manual_review",
    }));
}

async function waitForAlertState(scenario, firing, options) {
  await waitUntil(
    firing ? "alert_firing_timeout" : "alert_clear_timeout",
    () => requireAlertState(scenario, firing, options.fetchImpl),
    firing ? ALERT_TIMEOUT_MILLISECONDS : RESOLUTION_TIMEOUT_MILLISECONDS,
    options.sleep,
  );
}

async function requireAlertState(scenario, firing, fetchImpl) {
  const [prometheus, alertmanager] = await Promise.all([
    findPrometheusAlert(scenario, fetchImpl),
    findAlertmanagerAlert(scenario, fetchImpl),
  ]);
  return firing
    ? prometheus !== undefined && alertmanager !== undefined
    : prometheus === undefined && alertmanager === undefined;
}

async function findPrometheusAlert(scenario, fetchImpl, targetName) {
  const query = alertMatcher(scenario, targetName);
  const document = await requestJson(
    fetchImpl,
    endpointOrigin("prometheus"),
    `/api/v1/query?query=${encodeURIComponent(query)}`,
    { transientStatuses: new Set([502, 503, 504]) },
  );
  if (
    document?.status !== "success" ||
    document.data?.resultType !== "vector" ||
    !Array.isArray(document.data.result)
  ) {
    throw upstreamContractError();
  }
  return document.data.result.find((item) => {
    const metric = item?.metric;
    return (
      isPlainObject(metric) &&
      metric.alertname === scenario.alertId &&
      metric.alertstate === "firing" &&
      metric[alertTargetLabel(scenario.target.kind)] ===
        (targetName ?? scenario.target.name)
    );
  });
}

async function findAlertmanagerAlert(scenario, fetchImpl, targetName) {
  const document = await requestJson(
    fetchImpl,
    endpointOrigin("alertmanager"),
    "/api/v2/alerts?active=true&silenced=false&inhibited=false",
    { transientStatuses: new Set([502, 503, 504]) },
  );
  if (!Array.isArray(document)) throw upstreamContractError();
  return document.find((item) => {
    const labels = item?.labels;
    return (
      isPlainObject(labels) &&
      labels.alertname === scenario.alertId &&
      labels.cluster === scenario.target.cluster &&
      labels.namespace === scenario.target.namespace &&
      labels[alertTargetLabel(scenario.target.kind)] ===
        (targetName ?? scenario.target.name) &&
      item?.status?.state === "active"
    );
  });
}

async function requireControlAlertsAbsent(scenario, fetchImpl) {
  for (const name of scenario.healthyControlNames) {
    const [prometheus, alertmanager] = await Promise.all([
      findPrometheusAlert(scenario, fetchImpl, name),
      findAlertmanagerAlert(scenario, fetchImpl, name),
    ]);
    if (prometheus !== undefined || alertmanager !== undefined) {
      throw contractError(
        "healthy_control_alerted",
        "A healthy scenario control produced the target alert",
      );
    }
  }
}

async function requireControlIncidentsAbsent(
  scenario,
  incidentsBefore,
  fetchImpl,
) {
  const current = await listIncidentIds(fetchImpl);
  for (const incidentId of current) {
    if (incidentsBefore.has(incidentId)) continue;
    const detail = await getIncident(incidentId, fetchImpl);
    if (scenario.healthyControlNames.includes(detail.incident?.target?.name)) {
      throw contractError(
        "healthy_control_incident_created",
        "A healthy scenario control created an Incident",
      );
    }
  }
}

function alertMatcher(scenario, targetName) {
  const targetLabel = alertTargetLabel(scenario.target.kind);
  return `ALERTS{alertname="${scenario.alertId}",alertstate="firing",namespace="${scenario.target.namespace}",${targetLabel}="${targetName ?? scenario.target.name}"}`;
}

function alertTargetLabel(kind) {
  const label = {
    Deployment: "deployment",
    Service: "service",
    PersistentVolumeClaim: "persistentvolumeclaim",
  }[kind];
  if (label === undefined) throw upstreamContractError();
  return label;
}

async function listIncidentIds(fetchImpl) {
  return new Set((await listIncidentSummaries(fetchImpl)).keys());
}

async function listIncidentSummaries(fetchImpl) {
  const incidents = new Map();
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < MAX_INCIDENT_PAGES; page += 1) {
    const query = cursor === undefined
      ? "/api/v1/incidents?limit=100"
      : `/api/v1/incidents?limit=100&cursor=${encodeURIComponent(cursor)}`;
    const document = await requestJson(
      fetchImpl,
      endpointOrigin("runtime"),
      query,
    );
    if (
      document?.schemaVersion !== 5 ||
      !Array.isArray(document.items) ||
      document.items.some((item) => !UUID_PATTERN.test(item?.id ?? "")) ||
      !(document.nextCursor === null ||
        isNormalizedString(document.nextCursor) &&
          document.nextCursor.length <= 2_048)
    ) {
      throw upstreamContractError();
    }
    for (const item of document.items) {
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

async function requireIncidentUpdatedAt(incidentId, fetchImpl) {
  const incident = (await listIncidentSummaries(fetchImpl)).get(incidentId);
  const timestamp = parseInstant(incident?.updatedAt);
  if (timestamp === undefined) throw upstreamContractError();
  return timestamp;
}

async function waitForNewIncident(scenario, incidentsBefore, fetchImpl, sleep) {
  return waitUntil(
    "incident_not_created",
    async () => {
      const current = await listIncidentIds(fetchImpl);
      const candidates = [];
      for (const incidentId of current) {
        if (incidentsBefore.has(incidentId)) continue;
        const detail = await getIncident(incidentId, fetchImpl);
        if (matchesScenarioIncident(detail.incident, scenario)) {
          candidates.push(detail);
        }
      }
      if (candidates.length > 1) {
        throw contractError(
          "duplicate_target_incident",
          "One alert occurrence created multiple Incidents for the target",
        );
      }
      if (candidates.length === 0) return undefined;
      return candidates[0];
    },
    DIAGNOSIS_TIMEOUT_MILLISECONDS,
    sleep,
  );
}

async function waitForTerminalIncident(incidentId, fetchImpl, sleep) {
  return waitUntil(
    "diagnosis_not_terminal",
    async () => {
      const detail = await getIncident(incidentId, fetchImpl);
      return TERMINAL_RUN_STATUSES.has(detail.selectedRun?.status)
        ? detail
        : undefined;
    },
    DIAGNOSIS_TIMEOUT_MILLISECONDS,
    sleep,
  );
}

function validateTerminalDiagnosis(scenario, detail) {
  if (
    detail.schemaVersion !== 5 ||
    detail.selectedRun?.kind !== "diagnosis" ||
    detail.selectedRun?.operation !== null ||
    detail.selectedRun?.attempt !== 1 ||
    detail.selectedRun?.status !== "COMPLETED" ||
    detail.selectedRun?.error !== null ||
    !Array.isArray(detail.evidence) ||
    !isPlainObject(detail.diagnosis) ||
    detail.diagnosis.outcome !== "diagnosed" ||
    typeof detail.diagnosis.summary !== "string" ||
    detail.diagnosis.summary.length === 0 ||
    !Array.isArray(detail.diagnosis.rootCauses) ||
    detail.diagnosis.rootCauses.length === 0 ||
    detail.diagnosis.rootCauses.length > 5
  ) {
    throw contractError(
      "diagnosis_invalid",
      "The alert-driven diagnosis did not complete successfully",
    );
  }
  const evidenceById = new Map();
  for (const item of detail.evidence) {
    if (
      !UUID_PATTERN.test(item?.id ?? "") ||
      !isNormalizedString(item?.evidenceKind) ||
      !isNormalizedString(item?.toolName) ||
      evidenceById.has(item.id)
    ) {
      throw upstreamContractError();
    }
    evidenceById.set(item.id, item);
  }
  const evidenceKinds = [
    ...new Set([...evidenceById.values()].map((item) => item.evidenceKind)),
  ].sort();
  const tools = new Set(detail.evidence.map((item) => item.toolName));
  const uncollected = scenario.requiredEvidence.filter(
    (kind) => !evidenceKinds.includes(kind),
  );
  if (uncollected.length > 0) {
    throw contractError(
      "diagnosis_evidence_missing",
      `Diagnosis did not collect ${uncollected.join(", ")}`,
    );
  }
  if (
    [...tools].some(
      (tool) =>
        !scenario.allowedTools.includes(tool) ||
        scenario.forbiddenTools.includes(tool),
    )
  ) {
    throw contractError(
      "diagnosis_tools_invalid",
      "Diagnosis used a tool the scenario does not permit",
    );
  }
  const diagnosisCodes = [];
  const citedEvidenceKinds = new Set();
  for (const rootCause of detail.diagnosis.rootCauses) {
    if (
      typeof rootCause?.statement !== "string" ||
      rootCause.statement.length === 0 ||
      !new Set(["low", "medium", "high"]).has(rootCause.confidence)
    ) {
      throw contractError(
        "diagnosis_invalid",
        "Diagnosis statement or confidence is invalid",
      );
    }
    if (
      !ROOT_CAUSE_CODE_PATTERN.test(rootCause?.code ?? "") ||
      rootCause.code === "unknown" ||
      !Array.isArray(rootCause.evidenceIds) ||
      rootCause.evidenceIds.length === 0 ||
      new Set(rootCause.evidenceIds).size !== rootCause.evidenceIds.length ||
      rootCause.evidenceIds.some(
        (evidenceId) =>
          !UUID_PATTERN.test(evidenceId ?? "") || !evidenceById.has(evidenceId),
      )
    ) {
      throw contractError(
        "diagnosis_evidence_links_invalid",
        "Diagnosis root causes do not reference persisted Run Evidence",
      );
    }
    diagnosisCodes.push(rootCause.code);
    for (const evidenceId of rootCause.evidenceIds) {
      citedEvidenceKinds.add(evidenceById.get(evidenceId).evidenceKind);
    }
  }
  diagnosisCodes.sort();
  // The Runtime requires the target's identity Evidence to be cited and tells
  // the model so; the scenario's remaining kinds were never put to the model,
  // so they stay an observation rather than a gate.
  if (!citedEvidenceKinds.has(scenario.identityEvidence)) {
    throw contractError(
      "diagnosis_evidence_links_invalid",
      `Diagnosis does not reference ${scenario.identityEvidence}`,
    );
  }
  const repair = validateTerminalRepair(scenario, detail, evidenceById);
  return {
    run: { attempt: 1, status: "COMPLETED" },
    evidenceKinds,
    // Collected and expected by the scenario, yet left out of every root cause.
    // The reviewer reading the diagnosis decides whether that weakens it.
    uncitedExpectedEvidence: scenario.requiredEvidence.filter(
      (kind) => !citedEvidenceKinds.has(kind),
    ),
    diagnosisCodes,
    repair,
  };
}

function validateTerminalRepair(scenario, detail, evidenceById) {
  const expected = scenario.expectedPatchConstraints;
  if (expected === undefined) {
    if (detail.incident?.status !== "DIAGNOSED" || detail.repair !== null) {
      throw contractError(
        "repair_validation_invalid",
        "A diagnosis without an approved repair slice exposed repair state",
      );
    }
    return undefined;
  }

  const repair = detail.repair;
  const imagePath =
    `/spec/template/spec/containers/${expected.containerIndex}/image`;
  const expectedPatch = [
    { op: "test", path: "/metadata/uid", value: repair?.targetUid },
    {
      op: "test",
      path: "/metadata/resourceVersion",
      value: repair?.targetResourceVersion,
    },
    {
      op: "test",
      path: `/spec/template/spec/containers/${expected.containerIndex}/name`,
      value: expected.containerName,
    },
    { op: "test", path: imagePath, value: expected.currentImage },
    { op: "replace", path: imagePath, value: expected.replacementImage },
  ];
  const evidenceIds = repair?.evidenceIds;
  const gateTimes = [
    parseInstant(repair?.schemaCheckedAt),
    parseInstant(repair?.policyCheckedAt),
    parseInstant(repair?.diffCheckedAt),
    parseInstant(repair?.validation?.checkedAt),
  ];
  if (
    detail.incident?.status !== "WAITING_APPROVAL" ||
    !isPlainObject(repair) ||
    !hasExactKeys(repair, [
      "schemaVersion",
      "id",
      "action",
      "target",
      "targetUid",
      "targetResourceVersion",
      "containerIndex",
      "containerName",
      "currentImage",
      "replacementImage",
      "evidenceIds",
      "sourceExecutionId",
      "patch",
      "digest",
      "diff",
      "schemaCheckedAt",
      "policyCheckedAt",
      "diffCheckedAt",
      "validation",
    ]) ||
    repair.schemaVersion !== 1 ||
    !UUID_PATTERN.test(repair.id ?? "") ||
    repair.action !== expected.action ||
    !isPlainObject(repair.target) ||
    !hasExactKeys(repair.target, [
      "cluster",
      "namespace",
      "apiVersion",
      "kind",
      "name",
    ]) ||
    !sameTarget(repair.target, scenario.target) ||
    !isNormalizedString(repair.targetUid) ||
    !isNormalizedString(repair.targetResourceVersion) ||
    repair.containerIndex !== expected.containerIndex ||
    repair.containerName !== expected.containerName ||
    repair.currentImage !== expected.currentImage ||
    repair.replacementImage !== expected.replacementImage ||
    // A proposal carries a source execution only when it rolls one back, and the
    // repair contract pairs that with a single Evidence instead of two.
    repair.sourceExecutionId !== null ||
    !Array.isArray(evidenceIds) ||
    evidenceIds.length !== 2 ||
    new Set(evidenceIds).size !== 2 ||
    JSON.stringify(evidenceIds) !==
      JSON.stringify([...evidenceIds].sort((left, right) => left.localeCompare(right))) ||
    evidenceIds.some((id) => !UUID_PATTERN.test(id ?? "") || !evidenceById.has(id)) ||
    !isPlainObject(repair.diff) ||
    !hasExactKeys(repair.diff, ["path", "before", "after"]) ||
    repair.diff.path !== imagePath ||
    repair.diff.before !== expected.currentImage ||
    repair.diff.after !== expected.replacementImage ||
    !Array.isArray(repair.patch) ||
    repair.patch.length !== 5 ||
    repair.patch.some(
      (operation) =>
        !isPlainObject(operation) ||
        !hasExactKeys(operation, ["op", "path", "value"]),
    ) ||
    JSON.stringify(repair.patch) !== JSON.stringify(expectedPatch) ||
    !RELEASE_DIGEST_PATTERN.test(repair.digest ?? "") ||
    gateTimes.some((value) => value === undefined) ||
    gateTimes.some(
      (value, index) => index > 0 && value < gateTimes[index - 1],
    ) ||
    !isPlainObject(repair.validation) ||
    !hasExactKeys(repair.validation, ["outcome", "checkedAt", "error"]) ||
    repair.validation.outcome !== "passed" ||
    repair.validation.error !== null
  ) {
    throw contractError(
      "repair_validation_invalid",
      "The ImagePull repair did not satisfy the evidence-bound contract",
    );
  }
  const repairKinds = new Set(
    evidenceIds.map((evidenceId) => evidenceById.get(evidenceId).evidenceKind),
  );
  // The proposal is bound to the Evidence a root cause cites, not to how the
  // model named that root cause; the Runtime decides the action from the facts.
  const repairRootCause = detail.diagnosis.rootCauses.find(
    (rootCause) =>
      Array.isArray(rootCause.evidenceIds) &&
      evidenceIds.every((evidenceId) =>
        rootCause.evidenceIds.includes(evidenceId)),
  );
  if (
    repairKinds.size !== 2 ||
    !repairKinds.has("workload") ||
    !repairKinds.has("rollout_history") ||
    repairRootCause === undefined ||
    repair.digest !== expectedRepairDigest(detail.selectedRun.id, repair)
  ) {
    throw contractError(
      "repair_validation_invalid",
      "The ImagePull repair identity is not bound to its exact Run Evidence",
    );
  }
  return {
    action: repair.action,
    proposalDigest: repair.digest,
    validation: "passed",
    terminalStatus: "WAITING_APPROVAL",
  };
}

function expectedRepairDigest(runId, repair) {
  const change = {
    schema_version: 1,
    run_id: runId,
    action: repair.action,
    target: {
      cluster: repair.target.cluster,
      namespace: repair.target.namespace,
      api_version: repair.target.apiVersion,
      kind: repair.target.kind,
      name: repair.target.name,
    },
    target_uid: repair.targetUid,
    target_resource_version: repair.targetResourceVersion,
    container_index: repair.containerIndex,
    container_name: repair.containerName,
    current_image: repair.currentImage,
    replacement_image: repair.replacementImage,
    evidence_ids: repair.evidenceIds,
  };
  return `sha256:${createHash("sha256").update(canonicalJson({
    domain: "k8s-incident-agent.repair-proposal.v1",
    change,
    patch: repair.patch,
  })).digest("hex")}`;
}

async function validateFiringPanels(incidentId, fetchImpl) {
  const catalog = await requestJson(
    fetchImpl,
    endpointOrigin("runtime"),
    `/api/v1/incidents/${incidentId}/monitoring/panels`,
  );
  if (
    catalog?.schemaVersion !== 4 ||
    !Array.isArray(catalog.panels) ||
    catalog.panels.length === 0 ||
    catalog.panels.length > 8
  ) {
    throw upstreamContractError();
  }
  const results = [];
  for (const reference of catalog.panels) {
    const panel = await getPanel(
      incidentId,
      reference.panelId,
      reference.recommendedWindow,
      fetchImpl,
    );
    if (!Array.isArray(panel.result.series)) {
      throw upstreamContractError();
    }
    // Only the alert's own trigger panel must be observable and firing; context
    // panels (including kubelet-backed ones that a profile may not collect) may be
    // empty, but a failing query or unavailable Prometheus is never acceptable.
    const unobservable =
      panel.result.state === "query_error" ||
      panel.result.state === "monitoring_unavailable";
    if (
      unobservable ||
      (reference.signalRole === "trigger" &&
        (panel.result.state !== "ok" ||
          panel.result.currentValue === null ||
          panel.result.series.length !== 1))
    ) {
      throw contractError(
        "firing_panel_invalid",
        "A required firing metric panel is not observable",
      );
    }
    if (reference.signalRole === "trigger") {
      requireRiskyTriggerValue(panel.result);
    }
    results.push({
      panelId: reference.panelId,
      signalRole: reference.signalRole,
      state: panel.result.state,
      window: panel.result.window,
    });
  }
  if (!results.some((panel) => panel.signalRole === "trigger")) {
    throw upstreamContractError();
  }
  return results;
}

function requireRiskyTriggerValue(result) {
  if (typeof result.threshold !== "number") throw upstreamContractError();
  if (!isRiskyValue(result)) {
    throw contractError(
      "trigger_panel_not_firing",
      "The trigger panel value does not satisfy its risk threshold",
    );
  }
}

function isRiskyValue(result) {
  if (typeof result.threshold !== "number") return false;
  return (
    result.riskDirection === "higher_is_worse"
      ? result.currentValue >= result.threshold
      : result.riskDirection === "lower_is_worse"
        ? result.currentValue < result.threshold
        : false
  );
}

async function getPanel(incidentId, panelId, window, fetchImpl) {
  const document = await requestJson(
    fetchImpl,
    endpointOrigin("runtime"),
    `/api/v1/incidents/${incidentId}/monitoring/panels/${panelId}?window=${window}`,
    { transientStatuses: new Set([502, 503, 504]) },
  );
  if (
    document?.schemaVersion !== 2 ||
    document.result?.panelId !== panelId ||
    document.result?.window !== window ||
    document.result?.anchor !== "current"
  ) {
    throw upstreamContractError();
  }
  return document;
}

async function validateSseReplay(incidentId, cursor, runId, repair, fetchImpl) {
  if (!/^[1-9][0-9]*$/.test(cursor ?? "")) throw upstreamContractError();
  if (!UUID_PATTERN.test(runId ?? "")) throw upstreamContractError();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MILLISECONDS);
  try {
    const response = await fetchImpl(
      `${endpointOrigin("runtime")}/api/v1/incidents/${incidentId}/events`,
      {
        headers: { "Last-Event-ID": "0", Accept: "text/event-stream" },
        signal: controller.signal,
      },
    );
    if (response.status !== 200 || response.body === null) {
      throw contractError("sse_replay_failed", "SSE replay was not available");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let bytes = 0;
    const events = [];
    let reachedCursor = false;
    while (!reachedCursor) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HTTP_BODY_BYTES) throw responseTooLarge();
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary).replaceAll("\r\n", "\n");
        buffer = buffer.slice(boundary + 2);
        const lines = frame.split("\n");
        const idLine = lines.find((line) => line.startsWith("id: "));
        const eventLine = lines.find((line) => line.startsWith("event: "));
        const dataLines = lines
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6));
        if (
          idLine === undefined ||
          eventLine === undefined ||
          dataLines.length === 0
        ) {
          throw contractError(
            "sse_replay_invalid",
            "SSE replay contained an incomplete event frame",
          );
        }
        const id = idLine.slice(4);
        const event = eventLine.slice(7);
        const data = parseJson(dataLines.join("\n"));
        if (
          !/^[1-9][0-9]*$/.test(id) ||
          !isNormalizedString(event) ||
          data?.schemaVersion !== 5 ||
          data.runKind !== "diagnosis" ||
          data.incidentId !== incidentId ||
          data.runId !== runId ||
          (events.length > 0 && BigInt(id) <= BigInt(events.at(-1).id))
        ) {
          throw contractError(
            "sse_replay_invalid",
            "SSE replay did not preserve the persisted event contract",
          );
        }
        events.push({ id, event, data });
        reachedCursor = id === cursor;
        if (reachedCursor) break;
      }
    }
    await reader.cancel();
    if (events.length === 0 || events.at(-1).id !== cursor) {
      throw contractError(
        "sse_replay_incomplete",
        "SSE replay did not reach the persisted event cursor",
      );
    }
    const eventTypes = new Set(events.map((item) => item.event));
    if (
      !eventTypes.has("incident.created") ||
      !eventTypes.has("run.started") ||
      !eventTypes.has("diagnosis.completed")
    ) {
      throw contractError(
        "sse_replay_invalid",
        "SSE replay omitted a required Incident lifecycle event",
      );
    }
    requireRepairEventSequence(events, repair);
    return {
      events: events.length,
      eventTypes: [...eventTypes].sort(),
      finalCursorMatched: true,
    };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function requireRepairEventSequence(events, repair) {
  const repairNames = [
    "repair.patch_ready",
    "repair.dry_run_passed",
    "repair.waiting_approval",
  ];
  const matchingRepairEvents = repairNames.map((name) =>
    events.filter((event) => event.event === name));
  const repairEvents = matchingRepairEvents.map(([event]) => event);
  const diagnosis = events.find((event) => event.event === "diagnosis.completed");
  if (repair === null) {
    if (
      repairEvents.some((event) => event !== undefined) ||
      diagnosis?.data?.incidentStatus !== "DIAGNOSED" ||
      diagnosis?.data?.runStatus !== "COMPLETED"
    ) {
      throw contractError(
        "sse_replay_invalid",
        "SSE replay exposed repair events for a diagnosis-only Run",
      );
    }
    return;
  }
  const statuses = [
    ["PATCH_READY", "RUNNING"],
    ["DRY_RUN_PASSED", "RUNNING"],
    ["WAITING_APPROVAL", "COMPLETED"],
  ];
  if (
    !isPlainObject(repair) ||
    diagnosis?.data?.incidentStatus !== "DIAGNOSED" ||
    diagnosis?.data?.runStatus !== "RUNNING" ||
    matchingRepairEvents.some((matching) => matching.length !== 1) ||
    repairEvents.some((event) => event === undefined) ||
    repairEvents.some(
      (event, index) =>
        event.data?.proposalId !== repair.id ||
        event.data?.proposalDigest !== repair.digest ||
        event.data?.incidentStatus !== statuses[index][0] ||
        event.data?.runStatus !== statuses[index][1],
    )
  ) {
    throw contractError(
      "sse_replay_invalid",
      "SSE replay omitted or changed the repair lifecycle contract",
    );
  }
  const positions = [
    events.indexOf(diagnosis),
    ...repairEvents.map((event) => events.indexOf(event)),
  ];
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
    throw contractError(
      "sse_replay_invalid",
      "SSE replay changed the repair lifecycle order",
    );
  }
}

async function requireConsoleIncident(detail, fetchImpl) {
  const incidentId = detail?.incident?.id;
  const displayName = detail?.incident?.displayName;
  const targetName = detail?.incident?.target?.name;
  if (
    !UUID_PATTERN.test(incidentId ?? "") ||
    !isNormalizedString(displayName) ||
    !isNormalizedString(targetName)
  ) {
    throw upstreamContractError();
  }
  const document = await requestText(
    fetchImpl,
    endpointOrigin("console"),
    `/incidents/${incidentId}`,
  );
  if (
    !document.includes(incidentId) ||
    !document.includes(displayName) ||
    !document.includes(targetName)
  ) {
    throw contractError(
      "console_incident_incomplete",
      "Console did not render stable details for the evaluated Incident",
    );
  }
}

async function waitForAlertmanagerRepeat(
  scenario,
  incidentId,
  baselineUpdatedAt,
  options,
) {
  await waitUntil(
    "alertmanager_repeat_not_observed",
    async () => {
      const stillFiring = await requireAlertState(
        scenario,
        true,
        options.fetchImpl,
      );
      if (!stillFiring) return undefined;
      const current = await requireIncidentUpdatedAt(
        incidentId,
        options.fetchImpl,
      );
      return current > baselineUpdatedAt ? current : undefined;
    },
    ALERT_REPEAT_WAIT_MILLISECONDS,
    options.sleep,
  );
}

async function requireSingleIncidentAndRun(
  scenario,
  incidentsBefore,
  incidentId,
  fetchImpl,
) {
  const current = await listIncidentIds(fetchImpl);
  const targetIncidents = [];
  for (const candidateId of current) {
    if (incidentsBefore.has(candidateId)) continue;
    const detail = await getIncident(candidateId, fetchImpl);
    if (matchesScenarioIncident(detail.incident, scenario)) {
      targetIncidents.push(candidateId);
    }
  }
  const runs = await requestJson(
    fetchImpl,
    endpointOrigin("runtime"),
    `/api/v1/incidents/${incidentId}/runs?limit=50`,
  );
  if (
    targetIncidents.length !== 1 ||
    targetIncidents[0] !== incidentId ||
    runs?.schemaVersion !== 5 ||
    !Array.isArray(runs?.items) ||
    runs.items.length !== 1 ||
    runs.items[0]?.attempt !== 1 ||
    runs.items[0]?.kind !== "diagnosis" ||
    runs.items[0]?.operation !== null
  ) {
    throw contractError(
      "alert_repeat_not_deduplicated",
      "Repeated Alertmanager delivery created another Incident or Run",
    );
  }
}

async function waitForResolvedIncident(incidentId, fetchImpl, sleep) {
  return waitUntil(
    "alert_resolution_not_persisted",
    async () => {
      const detail = await getIncident(incidentId, fetchImpl);
      const resolvedEvent = detail.eventPage?.items?.some(
        (item) => item?.event === "alert.resolved",
      );
      return detail.alertSignal?.status === "RESOLVED" && resolvedEvent
        ? detail
        : undefined;
    },
    RESOLUTION_TIMEOUT_MILLISECONDS,
    sleep,
  );
}

async function waitForPostResolutionPanels(
  incidentId,
  panels,
  fetchImpl,
  sleep,
) {
  const states = [];
  for (const reference of panels) {
    const { panelId, window } = reference;
    const panel = await waitUntil(
      "post_resolution_panel_not_settled",
      async () => {
        const document = await getPanel(incidentId, panelId, window, fetchImpl);
        if (new Set(["no_data", "stale", "partial"]).has(document.result.state)) {
          return document;
        }
        if (
          document.result.state === "ok" &&
          (reference.signalRole !== "trigger" || !isRiskyValue(document.result))
        ) {
          return document;
        }
        return undefined;
      },
      POST_RESOLUTION_TIMEOUT_MILLISECONDS,
      sleep,
    );
    states.push({ panelId, state: panel.result.state });
  }
  return states;
}

async function waitForPanelState(
  incidentId,
  panelId,
  window,
  states,
  fetchImpl,
  sleep,
  timeout,
) {
  return waitUntil(
    "metric_state_not_observed",
    async () => {
      const panel = await getPanel(incidentId, panelId, window, fetchImpl);
      return states.has(panel.result.state) ? panel : undefined;
    },
    timeout,
    sleep,
  );
}

async function waitForRiskyPanel(
  incidentId,
  panelId,
  window,
  fetchImpl,
  sleep,
) {
  return waitUntil(
    "metric_probe_not_observable",
    async () => {
      const panel = await getPanel(incidentId, panelId, window, fetchImpl);
      return panel.result.state === "ok" && isRiskyValue(panel.result)
        ? panel
        : undefined;
    },
    HEALTH_TIMEOUT_MILLISECONDS,
    sleep,
  );
}

async function getIncident(incidentId, fetchImpl) {
  const document = await requestJson(
    fetchImpl,
    endpointOrigin("runtime"),
    `/api/v1/incidents/${incidentId}`,
    { transientStatuses: new Set([502, 503, 504]) },
  );
  if (
    document?.schemaVersion !== 5 ||
    document.incident?.id !== incidentId ||
    !UUID_PATTERN.test(document.selectedRun?.id ?? "")
  ) {
    throw upstreamContractError();
  }
  return document;
}

async function findLatestIncidentIdForScenario(scenario, fetchImpl) {
  const ids = await listIncidentIds(fetchImpl);
  for (const incidentId of ids) {
    const detail = await getIncident(incidentId, fetchImpl);
    if (matchesScenarioIncident(detail.incident, scenario)) return incidentId;
  }
  return undefined;
}

function sameTarget(actual, expected) {
  return (
    actual?.cluster === expected.cluster &&
    actual?.namespace === expected.namespace &&
    actual?.apiVersion === expected.apiVersion &&
    actual?.kind === expected.kind &&
    actual?.name === expected.name
  );
}

function matchesScenarioIncident(incident, scenario) {
  return (
    sameTarget(incident?.target, scenario.target) &&
    incident?.source?.type === "alertmanager" &&
    incident?.source?.ref === scenario.alertId
  );
}

async function waitForHealthyMonitoring(fetchImpl, sleep) {
  return waitUntil(
    "monitoring_not_healthy",
    async () => {
      const health = await requestJson(
        fetchImpl,
        endpointOrigin("runtime"),
        "/api/v1/monitoring/health",
        { transientStatuses: new Set([502, 503, 504]) },
      );
      return isHealthyMonitoring(health) ? health : undefined;
    },
    HEALTH_TIMEOUT_MILLISECONDS,
    sleep,
  );
}

function isHealthyMonitoring(health) {
  return (
    health?.state === "healthy" &&
    health.prometheus === "healthy" &&
    health.kubeStateMetrics === "healthy" &&
    health.ruleEvaluation === "healthy" &&
    health.alertmanager === "healthy" &&
    health.notification === "healthy"
  );
}

async function requireWatchdogTimestamp(fetchImpl, sleep) {
  const health = await waitForHealthyMonitoring(fetchImpl, sleep);
  const timestamp = parseInstant(health.watchdogLastReceivedAt);
  if (timestamp === undefined) throw upstreamContractError();
  return timestamp;
}

async function waitForFreshWatchdog(baseline, fetchImpl, sleep) {
  return waitUntil(
    "rotated_webhook_not_observed",
    async () => {
      const health = await requestJson(
        fetchImpl,
        endpointOrigin("runtime"),
        "/api/v1/monitoring/health",
        { transientStatuses: new Set([502, 503, 504]) },
      );
      const current = parseInstant(health?.watchdogLastReceivedAt);
      return isHealthyMonitoring(health) &&
        current !== undefined &&
        current > baseline
        ? health
        : undefined;
    },
    HEALTH_TIMEOUT_MILLISECONDS,
    sleep,
  );
}

async function scaleMonitoringDeployment(
  name,
  replicas,
  context,
  execute,
) {
  await executeKubectl(execute, context, [
    "scale",
    `deployment/${name}`,
    "--namespace",
    MONITORING_NAMESPACE,
    `--replicas=${replicas}`,
    "--timeout=120s",
  ]);
  if (replicas === 1) {
    await executeKubectl(execute, context, [
      "rollout",
      "status",
      `deployment/${name}`,
      "--namespace",
      MONITORING_NAMESPACE,
      "--timeout=300s",
    ]);
  }
}

async function restartFixedPod(namespace, appName, context, execute) {
  const raw = await executeKubectl(execute, context, [
    "get",
    "pods",
    "--namespace",
    namespace,
    "--selector",
    `app.kubernetes.io/name=${appName}`,
    "--output=json",
  ]);
  const document = parseJson(raw);
  if (
    document?.kind !== "List" ||
    !Array.isArray(document.items) ||
    document.items.length !== 1 ||
    !isNormalizedString(document.items[0]?.metadata?.name)
  ) {
    throw upstreamContractError();
  }
  await executeKubectl(execute, context, [
    "delete",
    "pod",
    document.items[0].metadata.name,
    "--namespace",
    namespace,
    "--wait=true",
    "--timeout=120s",
  ]);
  await executeKubectl(execute, context, [
    "rollout",
    "status",
    `deployment/${appName}`,
    "--namespace",
    namespace,
    "--timeout=300s",
  ]);
}

async function rotateWebhookCredential(context, execute) {
  const token = randomBytes(32).toString("hex");
  const encodedToken = Buffer.from(token, "utf8").toString("base64");
  for (const namespace of [APPLICATION_NAMESPACE, MONITORING_NAMESPACE]) {
    const manifest = JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: "alertmanager-webhook",
        namespace,
        labels: { "app.kubernetes.io/part-of": "k8s-incident-agent" },
      },
      type: "Opaque",
      data: { token: encodedToken },
    });
    await executeKubectl(execute, context, [
      "apply",
      "--filename=-",
      "--validate=strict",
      "--request-timeout=30s",
    ], manifest);
  }
}

async function executeKubectl(execute, context, args, stdin) {
  const result = await execute(
    "kubectl",
    ["--context", context, ...args],
    { timeoutMilliseconds: COMMAND_TIMEOUT_MILLISECONDS, stdin },
  );
  if (typeof result === "string") return result;
  if (result?.exitCode === 0 && typeof result.stdout === "string") {
    return result.stdout;
  }
  throw contractError(
    "cluster_command_failed",
    "A fixed evaluation cluster command failed",
  );
}

async function openPortForwards(context, dependencies) {
  let active = [];
  const start = async () => {
    active = Object.entries(ENDPOINTS).map(([name, endpoint]) =>
      startPortForward(name, endpoint, context),
    );
    try {
      await Promise.all(active.map((process) => process.ready));
      await Promise.all(
        Object.entries(ENDPOINTS).map(([name, endpoint]) =>
          waitUntil(
            "port_forward_not_ready",
            async () => {
              requirePortForwardRunning(active, name);
              try {
                const response = await dependencies.fetchImpl(
                  `${endpointOrigin(name)}${endpoint.readyPath}`,
                  { signal: AbortSignal.timeout(HTTP_TIMEOUT_MILLISECONDS) },
                );
                requirePortForwardRunning(active, name);
                return response.status >= 200 && response.status < 500;
              } catch {
                return false;
              }
            },
            PORT_FORWARD_TIMEOUT_MILLISECONDS,
            dependencies.sleep,
          ),
        ),
      );
    } catch (error) {
      await stopAll(active);
      active = [];
      throw error;
    }
  };
  await start();
  return {
    async restart() {
      await stopAll(active);
      active = [];
      await start();
    },
    async close() {
      await stopAll(active);
      active = [];
    },
  };
}

function startPortForward(name, endpoint, context) {
  const child = spawn(
    "kubectl",
    [
      "--context",
      context,
      "--namespace",
      endpoint.namespace,
      "port-forward",
      endpoint.resource,
      `${endpoint.localPort}:${endpoint.remotePort}`,
      "--address=127.0.0.1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let failed = false;
  let readinessOutput = "";
  const expectedReadyLine =
    `Forwarding from 127.0.0.1:${endpoint.localPort} -> `;
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      failed = true;
      reject(portForwardFailed(name));
    }, PORT_FORWARD_TIMEOUT_MILLISECONDS);
    const finish = (operation) => {
      clearTimeout(timeout);
      operation();
    };
    const inspect = (chunk) => {
      readinessOutput = `${readinessOutput}${String(chunk)}`.slice(-1024);
      if (readinessOutput.includes(expectedReadyLine)) {
        finish(resolve);
      }
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("error", () => {
      failed = true;
      finish(() => reject(portForwardFailed(name)));
    });
    child.once("exit", () => {
      failed = true;
      finish(() => reject(portForwardFailed(name)));
    });
  });
  return { name, child, ready, isFailed: () => failed };
}

function requirePortForwardRunning(processes, name) {
  const process = processes.find((candidate) => candidate.name === name);
  if (
    process === undefined ||
    process.isFailed() ||
    process.child.exitCode !== null ||
    process.child.signalCode !== null
  ) {
    throw portForwardFailed(name);
  }
}

function portForwardFailed(name) {
  return contractError(
    "port_forward_failed",
    `The fixed ${name} evaluation port forward did not become or remain available`,
  );
}

async function stopAll(processes) {
  for (const { child } of processes) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(
    processes.map(
      ({ child }) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", resolve);
          setTimeout(resolve, 2_000);
        }),
    ),
  );
}

async function requestJson(fetchImpl, origin, pathname, options = {}) {
  const raw = await requestText(fetchImpl, origin, pathname, options);
  return parseJson(raw);
}

async function requestStatus(fetchImpl, origin, pathname, options = {}) {
  return (await request(fetchImpl, origin, pathname, options)).status;
}

async function requestText(fetchImpl, origin, pathname, options = {}) {
  const result = await request(fetchImpl, origin, pathname, options);
  if (!result.ok) {
    if (options.transientStatuses?.has(result.status)) {
      throw new TransientEvaluationError(
        "http_unavailable",
        "An evaluation endpoint is temporarily unavailable",
      );
    }
    throw contractError(
      "http_request_failed",
      "An evaluation endpoint returned an unexpected status",
    );
  }
  return result.body;
}

async function request(fetchImpl, origin, pathname, options = {}) {
  let response;
  try {
    response = await fetchImpl(`${origin}${pathname}`, {
      headers: { Accept: options.accept ?? "application/json", ...options.headers },
      method: options.method ?? "GET",
      ...(options.body !== undefined ? { body: options.body } : {}),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MILLISECONDS),
    });
  } catch (error) {
    if (error instanceof EvaluationError) throw error;
    throw new TransientEvaluationError(
      "http_unavailable",
      "An evaluation endpoint is temporarily unavailable",
    );
  }
  const body = await readResponseBytes(response, MAX_HTTP_BODY_BYTES);
  return {
    body: new TextDecoder("utf-8", { fatal: true }).decode(body),
    ok: response.ok,
    status: response.status,
  };
}

async function readResponseBytes(response, limit) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw responseTooLarge();
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel(); }
}

async function waitUntil(code, operation, timeoutMilliseconds, sleep) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastTransient;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      if (!(error instanceof TransientEvaluationError)) throw error;
      lastTransient = error;
    }
    await sleep(Math.min(POLL_INTERVAL_MILLISECONDS, deadline - Date.now()));
  }
  if (lastTransient !== undefined) throw lastTransient;
  throw contractError(code, "A bounded evaluation condition was not observed");
}

async function loadReleaseIdentity(repositoryRoot, read, execute) {
  const worktreeResult = await execute(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: repositoryRoot,
      timeoutMilliseconds: HTTP_TIMEOUT_MILLISECONDS,
    },
  );
  if (commandOutput(worktreeResult).trim() !== "") {
    throw contractError(
      "release_worktree_dirty",
      "Evaluation requires a clean committed release worktree",
    );
  }
  const revisionResult = await execute(
    "git",
    ["rev-parse", "HEAD"],
    {
      cwd: repositoryRoot,
      timeoutMilliseconds: HTTP_TIMEOUT_MILLISECONDS,
    },
  );
  const lockRevision = commandOutput(revisionResult).trim();
  if (!RELEASE_REVISION_PATTERN.test(lockRevision)) {
    throw contractError(
      "release_revision_invalid",
      "Release source revision is invalid",
    );
  }

  const source = await read(
    path.join(
      repositoryRoot,
      "deploy/application/base/workloads/kustomization.yaml",
    ),
    "utf8",
  );
  const document = load(requireText(source));
  if (!isPlainObject(document) || !Array.isArray(document.images)) {
    throw contractError(
      "release_contract_invalid",
      "Application image lock is invalid",
    );
  }
  const images = {};
  for (const name of [
    "k8s-incident-agent-console",
    "k8s-incident-agent-runtime",
  ]) {
    const matches = document.images.filter((image) => image?.name === name);
    if (
      matches.length !== 1 ||
      matches[0].newName !== name ||
      !RELEASE_DIGEST_PATTERN.test(matches[0].digest ?? "")
    ) {
      throw contractError(
        "release_contract_invalid",
        "Application image lock is invalid",
      );
    }
    images[name === "k8s-incident-agent-console" ? "console" : "runtime"] =
      matches[0].digest;
  }

  const sourceRevisions = new Set();
  for (const image of ["console", "runtime"]) {
    sourceRevisions.add(await requireReleaseOciLayout(
      path.join(repositoryRoot, ".runtime", "release", `${image}-oci`),
      images[image],
      read,
    ));
  }
  if (sourceRevisions.size !== 1) {
    throw releaseRevisionMismatch();
  }
  const revision = [...sourceRevisions][0];
  await requireReleaseSourceRevision(
    repositoryRoot,
    revision,
    lockRevision,
    execute,
  );
  return { revision, lockRevision, images };
}

async function requireReleaseOciLayout(
  layoutDirectory,
  expectedDigest,
  read,
) {
  const rootIndex = parseJsonBuffer(
    await read(path.join(layoutDirectory, "index.json")),
  );
  if (
    rootIndex?.schemaVersion !== 2 ||
    rootIndex.mediaType !== OCI_INDEX_MEDIA_TYPE ||
    !Array.isArray(rootIndex.manifests) ||
    rootIndex.manifests.length !== 1
  ) {
    throw releaseArtifactError();
  }
  const topDescriptor = rootIndex.manifests[0];
  if (
    topDescriptor?.mediaType !== OCI_INDEX_MEDIA_TYPE ||
    topDescriptor.digest !== expectedDigest
  ) {
    throw releaseArtifactError();
  }
  const topIndex = await readVerifiedOciJson(
    layoutDirectory,
    topDescriptor,
    read,
  );
  if (
    topIndex?.schemaVersion !== 2 ||
    topIndex.mediaType !== OCI_INDEX_MEDIA_TYPE ||
    !Array.isArray(topIndex.manifests) ||
    topIndex.manifests.length !== RELEASE_PLATFORMS.size
  ) {
    throw releaseArtifactError();
  }
  const platforms = new Set();
  const revisions = new Set();
  for (const manifestDescriptor of topIndex.manifests) {
    const platform = `${manifestDescriptor?.platform?.os}/${manifestDescriptor?.platform?.architecture}`;
    if (
      !RELEASE_PLATFORMS.has(platform) ||
      platforms.has(platform) ||
      manifestDescriptor?.mediaType !== OCI_MANIFEST_MEDIA_TYPE
    ) {
      throw releaseArtifactError();
    }
    platforms.add(platform);
    const manifest = await readVerifiedOciJson(
      layoutDirectory,
      manifestDescriptor,
      read,
    );
    if (
      manifest?.schemaVersion !== 2 ||
      manifest.mediaType !== OCI_MANIFEST_MEDIA_TYPE ||
      manifest.config?.mediaType !== OCI_CONFIG_MEDIA_TYPE ||
      !Array.isArray(manifest.layers)
    ) {
      throw releaseArtifactError();
    }
    const config = await readVerifiedOciJson(
      layoutDirectory,
      manifest.config,
      read,
    );
    const revision = config?.config?.Labels?.[
      "org.opencontainers.image.revision"
    ];
    if (!RELEASE_REVISION_PATTERN.test(revision ?? "")) {
      throw releaseRevisionMismatch();
    }
    revisions.add(revision);
  }
  if (
    platforms.size !== RELEASE_PLATFORMS.size ||
    [...RELEASE_PLATFORMS].some((platform) => !platforms.has(platform))
  ) {
    throw releaseArtifactError();
  }
  if (revisions.size !== 1) throw releaseRevisionMismatch();
  return [...revisions][0];
}

async function requireReleaseSourceRevision(
  repositoryRoot,
  sourceRevision,
  lockRevision,
  execute,
) {
  try {
    await execute(
      "git",
      ["merge-base", "--is-ancestor", sourceRevision, lockRevision],
      {
        cwd: repositoryRoot,
        timeoutMilliseconds: HTTP_TIMEOUT_MILLISECONDS,
      },
    );
  } catch {
    throw releaseRevisionMismatch();
  }
  const diffResult = await execute(
    "git",
    ["diff", "--name-only", "--no-renames", sourceRevision, lockRevision, "--"],
    {
      cwd: repositoryRoot,
      timeoutMilliseconds: HTTP_TIMEOUT_MILLISECONDS,
    },
  );
  const changedFiles = commandOutput(diffResult)
    .split("\n")
    .filter((value) => value.length > 0);
  if (changedFiles.some((filename) => !RELEASE_LOCK_FILES.has(filename))) {
    throw releaseRevisionMismatch();
  }
}

async function readVerifiedOciJson(layoutDirectory, descriptor, read) {
  if (
    !isPlainObject(descriptor) ||
    !RELEASE_DIGEST_PATTERN.test(descriptor.digest ?? "") ||
    !Number.isSafeInteger(descriptor.size) ||
    descriptor.size <= 0 ||
    descriptor.size > MAX_HTTP_BODY_BYTES
  ) {
    throw releaseArtifactError();
  }
  const content = requireBuffer(
    await read(
      path.join(
        layoutDirectory,
        "blobs",
        "sha256",
        descriptor.digest.slice("sha256:".length),
      ),
    ),
  );
  if (
    content.byteLength !== descriptor.size ||
    `sha256:${createHash("sha256").update(content).digest("hex")}` !==
      descriptor.digest
  ) {
    throw releaseArtifactError();
  }
  return parseJsonBuffer(content);
}

function parseJsonBuffer(raw) {
  return parseJson(
    new TextDecoder("utf-8", { fatal: true }).decode(requireBuffer(raw)),
  );
}

function requireBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw releaseArtifactError();
}

function requireText(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  }
  throw releaseArtifactError();
}

function commandOutput(result) {
  if (typeof result === "string") return result;
  if (typeof result?.stdout === "string") return result.stdout;
  throw upstreamContractError();
}

function releaseArtifactError() {
  return contractError(
    "release_artifact_invalid",
    "Fixed OCI release artifact does not match the image lock",
  );
}

function releaseRevisionMismatch() {
  return contractError(
    "release_revision_mismatch",
    "OCI image source does not match the clean release-lock revision",
  );
}

async function writeEvaluationArtifact(repositoryRoot, profile, artifact) {
  const runtimeDirectory = path.join(repositoryRoot, ".runtime");
  const directory = path.join(runtimeDirectory, "evaluation");
  await requireDirectoryNotSymlink(runtimeDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await requireDirectoryNotSymlink(directory);
  await chmod(directory, 0o700);
  const suffix = artifact.scope === "focused" ? "-focused" : "";
  const output = path.join(directory, `${profile}${suffix}.json`);
  const temporary = path.join(
    directory,
    `.${profile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, output);
    await chmod(output, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return output;
}

async function requireDirectoryNotSymlink(directory) {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw contractError(
        "artifact_directory_invalid",
        "Evaluation artifact directory is unsafe",
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function endpointOrigin(name) {
  const endpoint = ENDPOINTS[name];
  if (endpoint === undefined) throw upstreamContractError();
  return `http://127.0.0.1:${endpoint.localPort}`;
}

function resolveContext(profile, context) {
  if (profile === "kind-evaluation") {
    if (context !== undefined) throw invalidArguments();
    return KIND_CONTEXT;
  }
  if (!isNormalizedString(context) || context.startsWith("-")) {
    throw invalidArguments();
  }
  return context;
}

function requireProfile(profile) {
  if (!Object.hasOwn(PROFILE_DEFINITIONS, profile)) throw invalidArguments();
  return profile;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length < 2) throw invalidArguments();
  const [action, profile, ...rest] = argv;
  if (!new Set(["run", "online"]).has(action)) throw invalidArguments();
  let context;
  const scenarioIds = [];
  for (let index = 0; index < rest.length; index += 2) {
    const value = rest[index + 1];
    if (!isNormalizedString(value) || value.startsWith("-")) throw invalidArguments();
    if (rest[index] === "--context" && context === undefined) context = value;
    else if (rest[index] === "--scenario" && action === "run") scenarioIds.push(value);
    else throw invalidArguments();
  }
  return {
    action,
    profile,
    context,
    ...(scenarioIds.length > 0 ? { scenarioIds } : {}),
  };
}

function adaptDeploymentExecutor(execute) {
  return async (command, args, options) => {
    try {
      const result = await execute(command, args, options);
      return typeof result === "string"
        ? { stdout: result, exitCode: 0 }
        : result;
    } catch (error) {
      if (
        Number.isInteger(error?.exitCode) &&
        typeof error?.stdout === "string"
      ) {
        return { stdout: error.stdout, exitCode: error.exitCode };
      }
      throw error;
    }
  };
}

function adaptScenarioExecutor(execute) {
  return async (command, args, options) => {
    const result = await execute(command, args, options);
    if (typeof result === "string") return result;
    if (result?.exitCode === 0 && typeof result.stdout === "string") {
      return result.stdout;
    }
    const error = new Error("Scenario command failed");
    error.exitCode = result?.exitCode;
    error.stdout = result?.stdout ?? "";
    throw error;
  };
}

function executeExternalCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: options.timeoutMilliseconds ?? COMMAND_TIMEOUT_MILLISECONDS,
      },
      (error, stdout) => {
        if (error !== null) {
          error.stdout = typeof stdout === "string" ? stdout : "";
          error.exitCode = Number.isInteger(error.code) ? error.code : undefined;
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(options.stdin ?? options.input ?? "");
  });
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw upstreamContractError();
  }
}

function parseInstant(value) {
  if (!isNormalizedString(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function safeFailure(error) {
  if (
    error instanceof EvaluationError ||
    error instanceof ScenarioCommandError
  ) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "evaluation_failed",
    message: "Scenario evaluation failed without exposing upstream content",
  };
}

function contractError(code, message) {
  return new EvaluationError(code, message);
}

function upstreamContractError() {
  return contractError(
    "upstream_contract_invalid",
    "An evaluation producer returned an invalid contract",
  );
}

function responseTooLarge() {
  return contractError(
    "response_too_large",
    "An evaluation endpoint exceeded its response budget",
  );
}

function invalidArguments() {
  return contractError(
    "invalid_arguments",
    "Usage: evaluation.mjs run <kind-evaluation|k3s-evaluation> [--context <context>] [--scenario <id> ...], or evaluation.mjs online k3s-online --context <context>",
  );
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(value, expected) {
  return isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort());
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw upstreamContractError();
}

function isNormalizedString(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function requireDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw upstreamContractError();
  }
  return value;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function repositoryRootFromModule() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  try {
    const request = parseArguments(process.argv.slice(2));
    const result = await runEvaluationCommand(request);
    process.stdout.write(
      `${JSON.stringify({
        status: result.artifact.status,
        profile: result.artifact.profile,
        artifact: result.artifactPath,
      })}\n`,
    );
    if (result.artifact.status === "pending_manual_review") process.exitCode = 2;
    else if (result.artifact.status !== "passed") process.exitCode = 1;
  } catch (error) {
    const failure = safeFailure(error);
    console.error(`FAIL ${failure.code} ${failure.message}`);
    process.exitCode = 1;
  }
}
