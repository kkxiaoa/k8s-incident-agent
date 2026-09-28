import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";

import type { ReleaseManifest } from "../../../scripts/release.mjs";
import { createReleaseFixture, gitFixtureEnvironment } from "../../../scripts/test-support/release-fixture.mjs";
import { loadEvaluationScenarioCatalog, type EvaluationScenario } from "../../src/contracts/dataset.ts";
import type { CatalogArtifact, OnlineArtifact } from "../../src/contracts/records.ts";
import type { DeploymentStatusCheck, Execute, ScenarioRunner } from "../../src/environment/commands.ts";
import type { FetchLike } from "../../src/environment/http.ts";
import type { Tunnels } from "../../src/environment/tunnels.ts";
import type { Sleep } from "../../src/shared/wait.ts";
import { fakeDeploymentStatus, fakeExecute, fakeScenarioRunner, fakeTunnels } from "./fake-cluster.ts";
import { consoleResponse } from "./fake-console.ts";
import { alertmanagerResponse, prometheusResponse } from "./fake-monitoring.ts";
import { runtimeResponse } from "./fake-runtime.ts";
import { REPOSITORY_ROOT } from "./fixtures.ts";
import { jsonResponse } from "./responses.ts";

export const REVISION = "a".repeat(40);
export const AUTH_DIRECTORY = mkdtempSync(path.join(tmpdir(), "evaluation-operator-test-"));
export const AUTH_PASSWORD = randomBytes(32).toString("base64url");
export const AUTH_FILE = path.join(AUTH_DIRECTORY, "password");
writeFileSync(AUTH_FILE, AUTH_PASSWORD, { mode: 0o600 });
after(() => rmSync(AUTH_DIRECTORY, { recursive: true, force: true }));

const ONLINE_ORIGIN = "https://console.example.test";
const FORWARDED_CONSOLE_ORIGIN = "http://127.0.0.1:13000";

export interface HarnessTerminal {
  outcome: "diagnosed" | "insufficient_evidence" | "failed";
  errorCode?: string;
  retryable?: boolean;
  incidentStatus?: string;
}

// Every switch a test can flip; each one is a deliberate deviation from the healthy fixture.
export interface HarnessOptions {
  scenarios?: EvaluationScenario[];
  headRevision?: string;
  releaseRevision?: string;
  dirtyWorktree?: boolean;
  staleWatchdogAfterRotation?: boolean;
  anonymousRerunAllowed?: boolean;
  consoleEchoOnly?: boolean;
  controlAlertScenarioId?: string;
  controlIncidentScenarioId?: string;
  otherAlertSameTargetScenarioId?: string;
  paginatedIncidents?: boolean;
  onlineManualRoutes?: boolean;
  onlineRerunStatus?: 202 | 409 | 422 | 503;
  onlineEmpty?: boolean;
  onlineWrongRun?: boolean;
  manyRunEvents?: { pages: number; perPage: number; fields: number };
  bulkyRunEvents?: boolean;
  contextPanelState?: string;
  uncollectedEvidenceKind?: string;
  forbiddenToolUsed?: boolean;
  terminalByScenario?: Record<string, HarnessTerminal>;
  failingScenarioId?: string;
  incidentStatusDrift?: boolean;
  staleSseTerminal?: boolean;
  sseTerminalStateDrift?: boolean;
  invalidSseContract?: boolean;
  duplicateRepairEvent?: boolean;
  diagnosisCodeByScenario?: Record<string, string>;
  omitRepair?: boolean;
  omitDiagnosisEvidenceLinks?: boolean;
  citeOnlyNonIdentityEvidence?: boolean;
  citeOnlyIdentityEvidence?: boolean;
  diagnosisStatement?: string;
  insufficientWithRootCauses?: boolean;
  emptyMissingInformation?: boolean;
  repairDrift?: boolean;
  retryableDrift?: boolean;
  sourceExecutionId?: string;
  invalidRepairDigest?: boolean;
}

export interface HarnessScenario extends EvaluationScenario {
  displayName: string;
  incidentId: string;
  otherIncidentId: string;
  controlIncidentId: string;
  runId: string;
  applied: boolean;
  resolved: boolean;
  repeated: boolean;
  updatedAt: string;
}

export interface HarnessState {
  cookie: string | undefined;
  csrf: string | undefined;
  logins: number;
  online: boolean;
  prometheus: boolean;
  kubeStateMetrics: boolean;
  watchdogLastReceivedAt: string;
  rerunId: string | undefined;
}

export interface HarnessCalls {
  artifacts: Array<CatalogArtifact | OnlineArtifact>;
  packages: unknown[];
  packageBytes: number[];
  scenarioApply: number;
  scenarioVerify: number;
  tunnelClose: number;
  tunnelRestart: number;
  sleepDurations: number[];
  alertmanagerRestarts: number;
}

export interface HarnessContext {
  scenarioById: Map<string, HarnessScenario>;
  state: HarnessState;
  options: HarnessOptions;
  activeScenario(): HarnessScenario | undefined;
}

export interface HarnessDependencies {
  environment: { readonly OPERATOR_ORIGIN: string; OPERATOR_PASSWORD_FILE: string | undefined };
  repositoryRoot: string;
  scenarios: EvaluationScenario[];
  now: () => Date;
  sleep: Sleep;
  verifyDeploymentStatus: DeploymentStatusCheck;
  runScenarioCommand: ScenarioRunner;
  openTunnels: () => Promise<Tunnels>;
  execute: Execute;
  fetch: FetchLike;
  writeArtifact?: (repositoryRoot: string, profile: string, artifact: CatalogArtifact | OnlineArtifact) => Promise<string>;
  writeTrialPackage?: (repositoryRoot: string, profile: string, campaignId: string, scenarioId: string, serialized: string) => Promise<string>;
  campaignSuffix?: () => string;
}

export interface Harness {
  calls: HarnessCalls;
  dependencies: HarnessDependencies;
  state: HarnessState;
  release: { path: string; manifest: ReleaseManifest; environment: { PATH: string } };
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const scenarios = options.scenarios ?? loadEvaluationScenarioCatalog(REPOSITORY_ROOT);
  const headRevision = options.headRevision ?? REVISION;
  const releaseDirectory = mkdtempSync(path.join(AUTH_DIRECTORY, "release-"));
  const releaseFixture = createReleaseFixture(releaseDirectory, options.releaseRevision ?? REVISION);
  const releaseEnvironment = gitFixtureEnvironment(releaseDirectory, headRevision, options.dirtyWorktree);
  const scenarioById = new Map<string, HarnessScenario>(
    scenarios.map((scenario, index) => [
      scenario.scenarioId,
      {
        ...scenario,
        displayName: scenario.scenarioId,
        incidentId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        otherIncidentId: `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        controlIncidentId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        runId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        applied: false,
        resolved: false,
        repeated: false,
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
    ]),
  );
  const calls: HarnessCalls = {
    artifacts: [],
    packages: [],
    packageBytes: [],
    scenarioApply: 0,
    scenarioVerify: 0,
    tunnelClose: 0,
    tunnelRestart: 0,
    sleepDurations: [],
    alertmanagerRestarts: 0,
  };
  const state: HarnessState = {
    cookie: undefined,
    csrf: undefined,
    logins: 0,
    online: false,
    prometheus: true,
    kubeStateMetrics: true,
    watchdogLastReceivedAt: "2026-09-05T00:00:00.000Z",
    rerunId: undefined,
  };
  const context: HarnessContext = {
    scenarioById,
    state,
    options,
    activeScenario: () => [...scenarioById.values()].find((scenario) => scenario.applied),
  };

  const dependencies: HarnessDependencies = {
    environment: {
      get OPERATOR_ORIGIN() {
        return state.online ? ONLINE_ORIGIN : FORWARDED_CONSOLE_ORIGIN;
      },
      OPERATOR_PASSWORD_FILE: AUTH_FILE,
    },
    repositoryRoot: REPOSITORY_ROOT,
    scenarios,
    now: () => new Date("2026-09-05T00:00:00.000Z"),
    // Sleeping is how time passes in the fixture: the first wait after an apply is the repeated
    // Alertmanager delivery.
    sleep: async (milliseconds) => {
      calls.sleepDurations.push(milliseconds);
      const active = context.activeScenario();
      if (active !== undefined && !active.repeated) {
        active.repeated = true;
        active.updatedAt = "2026-09-05T00:00:01.000Z";
      }
    },
    verifyDeploymentStatus: fakeDeploymentStatus(releaseFixture.manifest),
    runScenarioCommand: fakeScenarioRunner(context, calls, releaseFixture.manifest),
    openTunnels: fakeTunnels(calls),
    execute: fakeExecute(context, calls),
    fetch: async (input, init) => fakeFetch(String(input), init, context),
    writeArtifact: async (_root, profile, artifact) => {
      calls.artifacts.push(structuredClone(artifact));
      return `/artifacts/${profile}.json`;
    },
    writeTrialPackage: async (_root, _profile, _campaignId, scenarioId, serialized) => {
      calls.packages.push(JSON.parse(serialized));
      calls.packageBytes.push(Buffer.byteLength(serialized));
      return `trials/${scenarioId}.json`;
    },
  };
  return {
    calls,
    dependencies,
    state,
    release: { path: releaseFixture.release, manifest: releaseFixture.manifest, environment: releaseEnvironment },
  };
}

// Dispatches by forwarded port: the operator session rules are checked here, then each fake system answers.
function fakeFetch(rawUrl: string, init: RequestInit | undefined, context: HarnessContext): Response {
  const { state, options } = context;
  const url = new URL(rawUrl);
  const headers = new Headers(init?.headers);
  const origin = state.online ? ONLINE_ORIGIN : FORWARDED_CONSOLE_ORIGIN;
  if (url.port === "18080" && url.pathname === "/api/v1/operator/login") {
    assert.equal(init?.method, "POST");
    assert.equal(headers.get("origin"), origin);
    assert.equal(JSON.parse(init?.body as string).password === AUTH_PASSWORD, true);
    state.logins += 1;
    state.cookie = `__Host-k8s-incident-session=${randomBytes(32).toString("base64url")}`;
    state.csrf = randomBytes(32).toString("hex");
    return new Response(
      JSON.stringify({ operatorRef: "sandbox-operator", expiresAt: Math.floor(Date.now() / 1000) + 3600, csrfToken: state.csrf }),
      { headers: { "content-type": "application/json", "set-cookie": `${state.cookie}; HttpOnly; Secure; SameSite=strict; Path=/; Max-Age=3600` } },
    );
  }
  if ((url.port === "18080" && url.pathname.startsWith("/api/v1/")) || (url.port === "13000" && url.pathname !== "/api/healthz")) {
    if (!state.cookie || headers.get("cookie") !== state.cookie) {
      if (options.anonymousRerunAllowed && url.pathname.endsWith("/runs") && init?.method === "POST") return jsonResponse({}, 202);
      return jsonResponse({ error: { code: "operator_authentication_required" } }, 401);
    }
    if (![undefined, "GET", "HEAD"].includes(init?.method)) {
      assert.equal(headers.get("origin"), origin);
      assert.equal(headers.get("x-csrf-token") === state.csrf, true);
    }
  } else {
    assert.equal(headers.has("cookie"), false);
    assert.equal(headers.has("x-csrf-token"), false);
  }
  if (url.port === "13000") return consoleResponse(url, context) ?? new Response(null, { status: 404 });
  if (url.port === "19090") return prometheusResponse(url, context);
  if (url.port === "19093") return alertmanagerResponse(url, context);
  if (url.port !== "18080") return new Response(null, { status: 404 });
  return runtimeResponse(url, init, headers, context);
}
