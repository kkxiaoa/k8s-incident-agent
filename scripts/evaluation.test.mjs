import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { test, after } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runEvaluationCommand as evaluate } from "./evaluation.mjs";
import { buildCampaignReport } from "./evaluation-report.mjs";
import { createReleaseFixture, gitFixtureEnvironment } from "./test-support/release-fixture.mjs";
import {
  loadEvaluationDataset,
  loadEvaluationScenarioCatalog,
  ScenarioCommandError,
} from "./scenario.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REVISION = "a".repeat(40);
const AUTH_DIRECTORY = mkdtempSync(path.join(tmpdir(), "evaluation-operator-test-"));
const AUTH_PASSWORD = randomBytes(32).toString("base64url");
const AUTH_FILE = path.join(AUTH_DIRECTORY, "password");
writeFileSync(AUTH_FILE, AUTH_PASSWORD, { mode: 0o600 });
after(() => rmSync(AUTH_DIRECTORY, { recursive: true, force: true }));
const RELEASE_SELECTION = Symbol("test release selection");
const EVIDENCE_TOOL = Object.freeze({
  workload: "get_workload",
  rollout_history: "get_rollout_history",
  pods: "get_pods",
  events: "get_events",
  container_logs: "get_container_logs",
  service_network: "get_service_network",
  pvc_storage: "get_pvc_storage",
  metrics: "query_prometheus",
});

// Test-only capture of this implementation's outputs as parity fixtures for the evaluation module.
const GOLDEN_DIRECTORY = process.env.EVALUATION_GOLDEN_DIR;
function recordGolden(name, value) {
  if (GOLDEN_DIRECTORY === undefined) return;
  writeFileSync(path.join(GOLDEN_DIRECTORY, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

async function runEvaluationCommand(request, dependencies) {
  const selection = dependencies[RELEASE_SELECTION];
  const previousPath = process.env.PATH;
  process.env.PATH = selection.environment.PATH;
  try {
    return await evaluate({ releasePath: selection.release, ...request }, dependencies);
  } finally {
    process.env.PATH = previousPath;
  }
}

test("the committed scenario catalog exposes seven entries across five families", () => {
  const scenarios = loadEvaluationScenarioCatalog(REPOSITORY_ROOT);

  assert.equal(scenarios.length, 7);
  assert.deepEqual(
    new Set(scenarios.map((scenario) => scenario.verifierKind)),
    new Set([
      "image_pull_backoff",
      "crash_loop_backoff",
      "service_selector_mismatch",
      "readiness_probe_failure",
      "liveness_probe_failure",
      "pvc_pending",
    ]),
  );
  assert.equal(
    scenarios.every(
      (scenario) => scenario.requiredEvidence.length > 0,
    ),
    true,
  );
  const imagePull = scenarios.find(
    (scenario) => scenario.scenarioId === "image-pull-backoff",
  );
  assert.equal(imagePull.scenarioVersion, 5);
  assert.equal(imagePull.requiredEvidence.includes("rollout_history"), true);
  // The evaluator's cited-Evidence gate must name what the Runtime requires.
  assert.equal(imagePull.identityEvidence, "workload");
  for (const scenario of scenarios) {
    assert.equal(
      scenario.requiredEvidence.includes(scenario.identityEvidence),
      true,
    );
  }
  assert.equal(imagePull.allowedTools.includes("get_rollout_history"), true);
  assert.deepEqual(imagePull.expectedPatchConstraints, {
    action: "set_container_image",
    containerIndex: 0,
    containerName: "workload",
    currentImage: "registry.invalid/k8s-incident-agent/missing:v1",
    replacementImage:
      "registry.k8s.io/e2e-test-images/agnhost:2.53@sha256:99c6b4bb4a1e1df3f0b3752168c89358794d02258ebebc26bf21c29399011a85",
  });
});

test("authentication failures stop before scenarios and never enter artifacts", async () => {
  for (const missingCredential of [true, false]) {
    const harness = createHarness();
    if (missingCredential) harness.dependencies.environment.OPERATOR_PASSWORD_FILE = undefined;
    else harness.dependencies.fetch = async () => new Response("sensitive upstream detail", { status: 401 });
    const result = await runEvaluationCommand({ action: "run", profile: "kind-evaluation" }, harness.dependencies);
    if (!missingCredential) recordGolden("catalog-aborted", result.artifact);
    assert.equal(result.artifact.status, "failed");
    assert.equal(result.artifact.failure.code, "operator_authentication_failed");
    assert.equal(harness.calls.scenarioApply, 0);
    assert.equal(harness.calls.tunnelClose, 1);
    const artifact = JSON.stringify(result.artifact);
    assert.equal(artifact.includes(AUTH_PASSWORD), false);
    assert.equal(artifact.includes("sensitive upstream detail"), false);
    assert.equal(artifact.includes(AUTH_FILE), false);
  }
});

test("Runtime restart renews read sessions without exposing credentials to monitoring or artifacts", async () => {
  const harness = createHarness();
  const result = await runEvaluationCommand({ action: "run", profile: "kind-evaluation" }, harness.dependencies);
  assert.equal(result.artifact.status, "pending_manual_review");
  assert.equal(harness.state.logins, 2);
  const artifact = JSON.stringify(result.artifact);
  for (const value of [AUTH_PASSWORD, harness.state.cookie, harness.state.csrf]) assert.equal(artifact.includes(value), false);
});

test("rejected renewal preserves authentication failure and stops without polling", async () => {
  const harness = createHarness();
  const originalFetch = harness.dependencies.fetch;
  let loginAttempts = 0;
  harness.dependencies.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/operator/login") {
      loginAttempts += 1;
      if (loginAttempts > 1) return new Response("private authentication failure", { status: 401 });
    } else if (url.port === "18080" && url.pathname.startsWith("/api/v1/")) {
      harness.state.cookie = undefined;
    }
    return originalFetch(input, init);
  };
  harness.dependencies.sleep = async () => { throw new Error("Authentication failure must not poll"); };
  const result = await runEvaluationCommand({ action: "run", profile: "kind-evaluation" }, harness.dependencies);
  assert.equal(result.artifact.status, "failed");
  assert.equal(result.artifact.failure.code, "operator_authentication_failed");
  assert.equal(loginAttempts, 2);
  assert.equal(harness.calls.scenarioApply, 0);
  assert.equal(harness.calls.tunnelClose, 1);
  assert.equal(JSON.stringify(result.artifact).includes("private authentication failure"), false);
});

test("catalog checks complete with exact Run references but require manual diagnosis review", async () => {
  const harness = createHarness();
  const fetch = harness.dependencies.fetch;
  const alertQueries = [];
  harness.dependencies.fetch = async (input, init) => {
    const url = new URL(String(input));
    const query = url.searchParams.get("query");
    if (url.port === "19090" && query?.startsWith("ALERTS{")) {
      alertQueries.push(query);
    }
    return fetch(input, init);
  };

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );
  recordGolden("catalog-full", result.artifact);
  recordGolden("review-package", harness.calls.packages[0]);

  assert.equal(
    result.artifact.status,
    "pending_manual_review",
    JSON.stringify(result.artifact),
  );
  assert.equal(result.artifact.scenarios.length, 7);
  assert.equal(result.artifact.families.length, 5);
  assert.equal(
    result.artifact.scenarios.every((scenario) => scenario.status === "pending_manual_review"),
    true,
  );
  assert.equal(result.artifact.monitoring.infrastructure.status, "passed");
  assert.equal(
    result.artifact.monitoring.infrastructure.checks.persistedIncidentReplay,
    true,
  );
  assert.equal(harness.calls.scenarioApply, 8);
  assert.equal(harness.calls.scenarioVerify, 8);
  assert.equal(harness.calls.sleepDurations.includes(330_000), false);
  assert.equal(harness.calls.alertmanagerRestarts, 1);
  assert.equal(harness.calls.tunnelClose, 1);
  assert.equal(harness.calls.artifacts.length, 1);
  assert.equal(result.artifact.schemaVersion, 4);
  assert.deepEqual(result.artifact.dataset, { id: "regression", version: 1 });
  assert.match(result.artifact.campaign.id, /^20260905T000000Z-[a-f0-9]{8}$/);
  assert.equal(result.artifact.campaign.startedAt, "2026-09-05T00:00:00.000Z");
  assert.equal(result.artifact.campaign.retryOf, null);
  assert.equal(result.artifact.coverage.plannedCases, 7);
  assert.equal(result.artifact.coverage.notRunCases, 0);
  assert.equal(result.artifact.coverage.mechanisms.length, 5);
  assert.equal(result.artifact.scope, "full");
  assert.equal(result.artifact.selectedScenarioIds.length, 7);
  for (const scenario of result.artifact.scenarios) {
    assert.match(scenario.incidentId, /^[0-9a-f-]{36}$/);
    assert.match(scenario.runId, /^[0-9a-f-]{36}$/);
    assert.ok(Number.isInteger(scenario.scenarioVersion));
  }
  assert.equal(alertQueries.length > 0, true);
  assert.equal(alertQueries.every((query) => !query.includes("cluster=")), true);
  assert.deepEqual(
    result.artifact.scenarios.find(
      (scenario) => scenario.scenarioId === "image-pull-backoff",
    )?.checks.repair,
    {
      action: "set_container_image",
      proposalDigest:
        "sha256:bc924be471167c459ae2d28e0e8b443d7d66bf4b7b329e2e81252f2aa9af97bf",
      validation: "passed",
      terminalStatus: "WAITING_APPROVAL",
    },
  );
  assert.equal(
    result.artifact.scenarios
      .filter((scenario) => scenario.scenarioId !== "image-pull-backoff")
      .every((scenario) => scenario.checks.repair === undefined),
    true,
  );

  const serialized = JSON.stringify(result.artifact);
  assert.equal(serialized.includes("payload"), false);
  assert.equal(serialized.includes("statement"), false);
  assert.equal(serialized.includes("summary"), false);
  assert.equal(serialized.includes("authorization"), false);
  assert.equal(serialized.includes("token"), false);
});

test("one failed scenario does not prevent the remaining catalog entries", async () => {
  const harness = createHarness({ failingScenarioId: "image-pull-backoff" });

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  assert.equal(result.artifact.status, "failed");
  assert.equal(result.artifact.scenarios.length, 7);
  assert.equal(
    result.artifact.scenarios.filter((scenario) => scenario.status === "pending_manual_review")
      .length,
    6,
  );
  const failed = result.artifact.scenarios.find(
    (scenario) => scenario.scenarioId === "image-pull-backoff",
  );
  assert.deepEqual(failed.failure, {
    code: "terminal_outcome_mismatch",
    message: "The Run ended COMPLETED/insufficient_evidence while the case expects diagnosed",
  });
  // The Runtime's own terminal stays on record even though the expectation failed.
  assert.deepEqual(failed.checks.run, { attempt: 1, status: "COMPLETED", errorCode: null, retryable: null, outcome: "insufficient_evidence" });
  assert.equal(failed.outcomeClass, "outcome_mismatch");
  assert.equal(harness.calls.scenarioApply, 8);
  assert.equal(harness.calls.scenarioVerify, 8);
});

test("infrastructure probe ignores another alert for the same Deployment", async () => {
  const harness = createHarness({
    failingScenarioId: "service-selector-mismatch",
    otherAlertSameTargetScenarioId: "readiness-probe-misconfigured",
  });

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  assert.equal(result.artifact.status, "failed");
  assert.equal(
    result.artifact.scenarios.find(
      (scenario) => scenario.scenarioId === "readiness-probe-misconfigured",
    )?.status,
    "pending_manual_review",
  );
  assert.equal(
    result.artifact.scenarios.find(
      (scenario) => scenario.scenarioId === "service-selector-mismatch",
    )?.status,
    "failed",
  );
  assert.equal(result.artifact.monitoring.infrastructure.status, "passed");
});

test("infrastructure recovery cleans a partially applied probe", async (t) => {
  const harness = createHarness();
  const datasetPath = datasetFile(t, (manifest) => {
    const imagePull = manifest.cases.find((entry) => entry.scenario_id === "image-pull-backoff");
    manifest.cases = [...manifest.cases.filter((entry) => entry !== imagePull), imagePull];
  });
  const scenarioRunner = harness.dependencies.runScenarioCommand;
  const imagePullActions = [];
  let imagePullApplyCount = 0;
  harness.dependencies.runScenarioCommand = async (
    action,
    scenarioId,
    dependencies,
  ) => {
    if (scenarioId === "image-pull-backoff") imagePullActions.push(action);
    if (action === "apply" && scenarioId === "image-pull-backoff") {
      imagePullApplyCount += 1;
      if (imagePullApplyCount === 2) {
        throw new ScenarioCommandError(
          "upstream_unavailable",
          "The healthy rollout did not complete",
        );
      }
    }
    return scenarioRunner(action, scenarioId, dependencies);
  };

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation", datasetPath },
    harness.dependencies,
  );

  assert.deepEqual(result.artifact.monitoring.infrastructure, {
    status: "failed",
    failure: {
      code: "upstream_unavailable",
      message: "The healthy rollout did not complete",
    },
  });
  assert.deepEqual(imagePullActions, [
    "cleanup",
    "apply",
    "verify",
    "cleanup",
    "apply",
    "cleanup",
  ]);
});

test("scenario failures keep their safe operator classification", async () => {
  const harness = createHarness();
  const scenarioRunner = harness.dependencies.runScenarioCommand;
  harness.dependencies.runScenarioCommand = async (
    action,
    scenarioId,
    dependencies,
  ) => {
    if (action === "verify" && scenarioId === "crash-loop-backoff") {
      throw new ScenarioCommandError(
        "verification_failed",
        "Scenario did not reach its deterministic evidence condition",
      );
    }
    return scenarioRunner(action, scenarioId, dependencies);
  };

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  const failed = result.artifact.scenarios.find(
    (scenario) => scenario.scenarioId === "crash-loop-backoff",
  );
  assert.deepEqual(failed.failure, {
    code: "verification_failed",
    message: "Scenario did not reach its deterministic evidence condition",
  });
});

test("a partial scenario apply is cleaned before evaluation continues", async () => {
  const harness = createHarness();
  const scenarioRunner = harness.dependencies.runScenarioCommand;
  const imagePullActions = [];
  harness.dependencies.runScenarioCommand = async (
    action,
    scenarioId,
    dependencies,
  ) => {
    if (scenarioId === "image-pull-backoff") imagePullActions.push(action);
    if (action === "apply" && scenarioId === "image-pull-backoff") {
      throw new ScenarioCommandError(
        "upstream_unavailable",
        "The healthy rollout did not complete",
      );
    }
    return scenarioRunner(action, scenarioId, dependencies);
  };

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  const failed = result.artifact.scenarios.find(
    (scenario) => scenario.scenarioId === "image-pull-backoff",
  );
  assert.deepEqual(failed.failure, {
    code: "upstream_unavailable",
    message: "The healthy rollout did not complete",
  });
  assert.deepEqual(imagePullActions.slice(0, 3), ["cleanup", "apply", "cleanup"]);
});

test("a healthy control Incident fails only its owning scenario", async () => {
  const harness = createHarness({
    controlIncidentScenarioId: "readiness-probe-misconfigured",
  });

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  const failed = result.artifact.scenarios.find(
    (scenario) => scenario.scenarioId === "readiness-probe-misconfigured",
  );
  assert.deepEqual(failed.failure, {
    code: "healthy_control_incident_created",
    message: "A healthy scenario control created an Incident",
  });
  assert.equal(failed.checks.healthyControls, false);
  assert.equal(
    result.artifact.scenarios.filter((scenario) => scenario.status === "pending_manual_review")
      .length,
    6,
  );
});

test("online evaluation proves the manual route and control boundary", async () => {
  const harness = createHarness();
  harness.state.online = true;

  const result = await runEvaluationCommand(
    {
      action: "online",
      profile: "k3s-public",
      context: "k3s-k8s-incident-agent",
    },
    harness.dependencies,
  );

  recordGolden("online", result.artifact);
  assert.equal(result.artifact.status, "passed");
  assert.deepEqual(result.artifact.checks, {
    readRoutesAvailable: true,
    manualCreationAbsent: true,
    manualConsoleCreationAbsent: true,
    anonymousRerunDenied: true,
    authenticatedRerun: "accepted",
  });
});

test("online evaluation rejects an assembled manual runtime route", async () => {
  const harness = createHarness({ onlineManualRoutes: true });
  harness.state.online = true;

  const result = await runEvaluationCommand(
    {
      action: "online",
      profile: "k3s-public",
      context: "k3s-k8s-incident-agent",
    },
    harness.dependencies,
  );

  assert.equal(result.artifact.status, "failed");
  assert.deepEqual(result.artifact.failure, {
    code: "online_route_set_invalid",
    message: "Online profile exposes a manual intake route",
  });
});

for (const [options, code] of [
  [{ onlineEmpty: true }, "online_existing_incident_required"],
  [{ anonymousRerunAllowed: true }, "online_rerun_boundary_invalid"],
  [{ onlineRerunStatus: 200 }, "online_rerun_boundary_invalid"],
  [{ onlineRerunStatus: 422 }, "online_rerun_boundary_invalid"],
  [{ onlineWrongRun: true }, "upstream_contract_invalid"],
]) {
  test(`online rerun oracle rejects ${JSON.stringify(options)}`, async () => {
    const harness = createHarness(options);
    harness.state.online = true;
    const result = await runEvaluationCommand(
      { action: "online", profile: "k3s-public", context: "k3s-k8s-incident-agent" },
      harness.dependencies,
    );
    assert.equal(result.artifact.status, "failed");
    assert.equal(result.artifact.failure.code, code);
  });
}

for (const [status, reason] of [[409, "active_run_exists"], [503, "diagnosis_unavailable"]]) {
  test(`online rerun accepts a state-backed ${reason} rejection`, async () => {
    const harness = createHarness({ onlineRerunStatus: status });
    harness.state.online = true;
    const result = await runEvaluationCommand(
      { action: "online", profile: "k3s-public", context: "k3s-k8s-incident-agent" },
      harness.dependencies,
    );
    assert.equal(result.artifact.status, "passed");
    assert.equal(result.artifact.checks.authenticatedRerun, reason);
  });
}

test("deployment checks receive expected nonzero command results", async () => {
  const harness = createHarness();
  harness.state.online = true;
  const execute = harness.dependencies.execute;
  harness.dependencies.execute = async (command, args, options) => {
    if (command === "git") return execute(command, args, options);
    const error = new Error("expected access denial");
    error.exitCode = 1;
    error.stdout = "no\n";
    throw error;
  };
  harness.dependencies.verifyDeploymentStatus = async (
    _profile,
    _context,
    dependencies,
  ) => {
    assert.deepEqual(
      await dependencies.execute("kubectl", ["auth", "can-i"], {}),
      { stdout: "no\n", exitCode: 1 },
    );
    return { deployments: "ready" };
  };

  const result = await runEvaluationCommand(
    {
      action: "online",
      profile: "k3s-public",
      context: "k3s-k8s-incident-agent",
    },
    harness.dependencies,
  );

  assert.equal(result.artifact.status, "passed");
});

test("scenario commands receive their external command options unchanged", async () => {
  const harness = createHarness();
  const execute = harness.dependencies.execute;
  const scenarioRunner = harness.dependencies.runScenarioCommand;
  let inspected = false;
  harness.dependencies.execute = async (command, args, options) => {
    if (args[0] === "adapter-contract-probe") {
      assert.deepEqual(options, {
        timeoutMilliseconds: 123,
        maxBufferBytes: 456,
      });
      inspected = true;
      return "ok";
    }
    return execute(command, args, options);
  };
  harness.dependencies.runScenarioCommand = async (
    action,
    scenarioId,
    dependencies,
  ) => {
    if (!inspected) {
      assert.equal(
        await dependencies.execute("kubectl", ["adapter-contract-probe"], {
          timeoutMilliseconds: 123,
          maxBufferBytes: 456,
        }),
        "ok",
      );
    }
    return scenarioRunner(action, scenarioId, dependencies);
  };

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  assert.equal(inspected, true);
  assert.equal(result.artifact.status, "pending_manual_review");
});

test("invalid CLI arguments fail before any evaluation side effect", () => {
  const result = spawnSync(process.execPath, [
    path.join(REPOSITORY_ROOT, "scripts/evaluation.mjs"),
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL invalid_arguments /);
});

test("focused evaluation runs only selected fixtures and never claims omitted coverage", async () => {
  const harness = createHarness();
  const selected = ["crash-loop-backoff", "liveness-probe-misconfigured", "pvc-binding-pending"];
  const touched = new Set();
  const runScenario = harness.dependencies.runScenarioCommand;
  harness.dependencies.runScenarioCommand = async (action, id, options) => {
    touched.add(id);
    return runScenario(action, id, options);
  };
  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation", scenarioIds: selected },
    harness.dependencies,
  );
  recordGolden("catalog-focused", result.artifact);
  assert.deepEqual(touched, new Set(selected));
  assert.equal(harness.calls.scenarioApply, 3);
  assert.equal(harness.calls.alertmanagerRestarts, 0);
  assert.equal(result.artifact.status, "pending_manual_review");
  assert.equal(result.artifact.scope, "focused");
  assert.deepEqual(result.artifact.selectedScenarioIds, selected);
  assert.deepEqual(result.artifact.monitoring.infrastructure, {
    status: "not_run", reason: "focused_evaluation",
  });
  assert.equal(result.artifact.scenarios.length, 7);
  assert.equal(result.artifact.families.length, 5);
  for (const scenario of result.artifact.scenarios) {
    assert.equal(scenario.status,
      selected.includes(scenario.scenarioId) ? "pending_manual_review" : "not_run");
  }
  for (const family of result.artifact.families) {
    assert.equal(family.status,
      family.familyId === "crash-loop-backoff" ? "pending_manual_review" : "not_run");
  }
});

test("invalid selections fail before deployment, tunnels, or scenario commands", async (t) => {
  for (const scenarioIds of [[], ["unknown"], ["../outside"], ["pvc-binding-pending", "pvc-binding-pending"]]) {
    await t.test(JSON.stringify(scenarioIds), async () => {
      const harness = createHarness();
      harness.dependencies.verifyDeploymentStatus = async () => assert.fail("deployment preflight reached");
      harness.dependencies.openTunnels = async () => assert.fail("tunnel opened");
      await assert.rejects(runEvaluationCommand(
        { action: "run", profile: "kind-evaluation", scenarioIds },
        harness.dependencies,
      ), { code: "invalid_arguments" });
      assert.equal(harness.calls.scenarioApply, 0);
    });
  }
  // Scenario runs never target the public deployment, and the online boundary only does.
  for (const request of [{ action: "run", profile: "k3s-public", context: "k3s" }, { action: "online", profile: "k3s-evaluation", context: "k3s" }]) {
    await t.test(`${request.action} ${request.profile}`, async () => {
      const harness = createHarness();
      harness.dependencies.verifyDeploymentStatus = async () => assert.fail("deployment preflight reached");
      harness.dependencies.openTunnels = async () => assert.fail("tunnel opened");
      await assert.rejects(runEvaluationCommand(request, harness.dependencies), { code: "invalid_arguments" });
      assert.equal(harness.calls.scenarioApply, 0);
    });
  }
});

test("focused evaluation still requires every planned revision and a matching release", async () => {
  const request = { action: "run", profile: "kind-evaluation", scenarioIds: ["pvc-binding-pending"] };
  const partial = createHarness();
  partial.dependencies.scenarios = partial.dependencies.scenarios.slice(0, 1);
  await assert.rejects(runEvaluationCommand(request, partial.dependencies), {
    code: "evaluation_dataset_invalid",
  });
  const dirty = createHarness({ dirtyWorktree: true });
  await assert.rejects(runEvaluationCommand(request, dirty.dependencies), {
    code: "release_worktree_dirty",
  });
  const drift = createHarness({ releaseSourceDrift: true, headRevision: "b".repeat(40) });
  await assert.rejects(runEvaluationCommand(request, drift.dependencies), {
    code: "release_revision_mismatch",
  });
  assert.equal(partial.calls.scenarioApply + dirty.calls.scenarioApply + drift.calls.scenarioApply, 0);
});

test("CLI rejects missing selection values and online selections", () => {
  for (const args of [
    ["run", "kind-evaluation", "--scenario"],
    ["run", "kind-evaluation", "--scenario", "--context"],
    ["online", "k3s-public", "--context", "k3s", "--scenario", "pvc-binding-pending"],
    ["run", "kind-evaluation", "--dataset"],
    ["run", "kind-evaluation", "--split", "unknown"],
    ["run", "kind-evaluation", "--retry-of"],
    ["online", "k3s-public", "--context", "k3s", "--retry-of", "20260901T000000Z-0123abcd"],
    ["online", "k3s-public", "--context", "k3s", "--dataset", "regression.json"],
  ]) {
    const result = spawnSync(process.execPath, [
      path.join(REPOSITORY_ROOT, "scripts/evaluation.mjs"), ...args,
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^FAIL invalid_arguments /);
  }
});

function datasetFile(t, mutate) {
  const manifest = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "evaluation/datasets/regression-v1.json"), "utf8"));
  mutate(manifest);
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "evaluation-dataset-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "dataset.json");
  writeFileSync(filename, JSON.stringify(manifest));
  return filename;
}

test("dataset selection preserves complete mechanism and historical coverage", async (t) => {
  const datasetPath = datasetFile(t, (manifest) => {
    manifest.cases[0].split = "development";
    manifest.cases[1].profiles = ["k3s-evaluation"];
  });
  const harness = createHarness();
  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation", datasetPath, split: "regression" },
    harness.dependencies,
  );
  assert.equal(harness.calls.scenarioApply, 5);
  assert.equal(result.artifact.status, "pending_manual_review");
  assert.equal(result.artifact.coverage.plannedCases, 7);
  assert.equal(result.artifact.coverage.notRunCases, 2);
  assert.equal(result.artifact.coverage.mechanisms.length, 5);
  assert.equal(result.artifact.families.reduce((total, family) => total + family.scenarios, 0), 7);
  const [development, unavailable] = result.artifact.scenarios;
  assert.equal(development.status, "not_run");
  assert.equal(development.reason, "not_selected");
  assert.equal(unavailable.reason, "profile_not_supported");
  assert.deepEqual(development.expectedTerminal, { outcome: "diagnosed" });
  assert.deepEqual(development.limitations, ["legacy_name_cues"]);
  assert.equal(development.scenarioId, "crash-loop-backoff");
  assert.equal(development.scenarioVersion, 3);
});

test("a dataset subset no longer requires seven catalog entries or an image repair slice", async (t) => {
  const datasetPath = datasetFile(t, (manifest) => { manifest.cases = [manifest.cases[0]]; });
  const harness = createHarness();
  harness.dependencies.scenarios = [harness.dependencies.scenarios[0]];
  const { artifact } = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation", datasetPath, scenarioIds: ["crash-loop-backoff"] },
    harness.dependencies,
  );
  assert.equal(artifact.status, "pending_manual_review");
  assert.equal(harness.calls.scenarioApply, 1);
  assert.equal(artifact.coverage.plannedCases, 1);
  assert.equal(artifact.coverage.mechanisms.length, 1);
  assert.equal(artifact.families.length, 5);
  assert.equal(artifact.families.filter((family) => family.status === "not_run").length, 4);
  assert.equal(artifact.families.reduce((total, family) => total + family.scenarios, 0), 7);
});

test("an eighth neutral case does not inherit historical coverage or create a new mechanism", async (t) => {
  const scenarios = loadEvaluationScenarioCatalog(REPOSITORY_ROOT);
  const variant = structuredClone(scenarios[0]);
  variant.scenarioId = "case-001";
  variant.scenarioVersion = 1;
  variant.target.name = "case-001";
  variant.healthyControlNames = ["case-001-healthy-control"];
  scenarios.push(variant);
  const datasetPath = datasetFile(t, (manifest) => {
    manifest.cases.push({ ...manifest.cases[0], scenario_id: "case-001", scenario_version: 1 });
  });
  const harness = createHarness({ scenarios });
  const { artifact } = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation", datasetPath, scenarioIds: ["case-001"] }, harness.dependencies,
  );
  assert.equal(artifact.status, "pending_manual_review");
  assert.equal(artifact.coverage.plannedCases, 8);
  assert.equal(artifact.coverage.notRunCases, 7);
  assert.equal(artifact.coverage.mechanisms.length, 5);
  assert.equal(artifact.families.every((family) => family.status === "not_run"), true);
  assert.equal(artifact.scenarios.at(-1).scenarioId, "case-001");
  assert.deepEqual(artifact.scenarios.at(-1).limitations, []);
});

test("dataset contract errors fail before any external work", async (t) => {
  const mutations = [
    ["schema revision", (m) => { m.schema_version = 2; }],
    ["dataset version", (m) => { m.dataset_version = "1"; }],
    ["dataset id type", (m) => { m.dataset_id = null; }],
    ["unsafe dataset id", (m) => { m.dataset_id = "../private"; }],
    ["extra field", (m) => { m.cases[0].target = { namespace: "default" }; }],
    ["duplicate case", (m) => { m.cases.push(m.cases[0]); }],
    ["unknown scenario", (m) => { m.cases[0].scenario_id = "case-999"; }],
    ["scenario revision", (m) => { m.cases[0].scenario_version = 999; }],
    ["split", (m) => { m.cases[0].split = "validation"; }],
    ["cross-split ancestry", (m) => { m.cases[2].split = "development"; }],
    ["outcome", (m) => { m.cases[0].expected_terminal.outcome = "passed"; }],
    ["failure without code", (m) => { m.cases[0].expected_terminal = { outcome: "failed" }; }],
    ["outcome extra field", (m) => { m.cases[0].expected_terminal.answer = "private"; }],
    ["profile", (m) => { m.cases[0].profiles = ["k3s-public"]; }],
    ["unbounded wait", (m) => { m.cases[0].alert_wait_seconds = 1801; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async (subtest) => {
      const datasetPath = datasetFile(subtest, mutate);
      const harness = createHarness();
      harness.dependencies.execute = async () => assert.fail("external command reached");
      harness.dependencies.openTunnels = async () => assert.fail("tunnel opened");
      await assert.rejects(runEvaluationCommand(
        { action: "run", profile: "kind-evaluation", datasetPath }, harness.dependencies,
      ), { code: "evaluation_dataset_invalid" });
      assert.equal(harness.calls.scenarioApply, 0);
    });
  }
});

test("public catalog inputs cannot be relabelled as a private holdout", async (t) => {
  const datasetPath = datasetFile(t, (manifest) => { manifest.cases[0].split = "holdout"; });
  for (const selection of [{ datasetPath }, { split: "holdout" }]) {
    const harness = createHarness();
    harness.dependencies.execute = async () => assert.fail("external command reached");
    await assert.rejects(runEvaluationCommand(
      { action: "run", profile: "kind-evaluation", ...selection }, harness.dependencies,
    ), { code: "evaluation_holdout_unavailable" });
    assert.equal(harness.calls.artifacts.length, 0);
  }
});

test("expected insufficient-evidence and typed-failure terminals pass their gates and keep the Runtime's raw Run", async (t) => {
  for (const [expected, terminal, run] of [
    [{ outcome: "insufficient_evidence" }, { outcome: "insufficient_evidence" },
      { attempt: 1, status: "COMPLETED", errorCode: null, retryable: null, outcome: "insufficient_evidence" }],
    [{ outcome: "failed", error_code: "model_output_invalid" }, { outcome: "failed", errorCode: "model_output_invalid", retryable: false },
      { attempt: 1, status: "FAILED", errorCode: "model_output_invalid", retryable: false, outcome: null }],
  ]) {
    const datasetPath = datasetFile(t, (manifest) => { manifest.cases[0].expected_terminal = expected; });
    const harness = createHarness({ terminalByScenario: { "crash-loop-backoff": terminal } });
    const { artifact } = await runEvaluationCommand(
      { action: "run", profile: "kind-evaluation", datasetPath, scenarioIds: ["crash-loop-backoff"] },
      harness.dependencies,
    );
    recordGolden(`catalog-terminal-${expected.outcome}`, artifact);
    const [result, unselected] = artifact.scenarios;
    assert.equal(result.status, "pending_manual_review", JSON.stringify(result.failure));
    assert.equal(result.outcomeClass, "pending_manual_review");
    assert.deepEqual(result.expectedTerminal, expected.error_code ? { outcome: "failed", errorCode: expected.error_code } : expected);
    assert.deepEqual(result.checks.run, run);
    assert.deepEqual(result.checks.diagnosisCodes, []);
    assert.equal(result.checks.repair, undefined);
    assert.ok(result.checks.sseReplay.eventTypes.includes(expected.outcome === "failed" ? "run.failed" : "diagnosis.insufficient"));
    assert.deepEqual(result.trial, { index: 1, startedAt: "2026-09-05T00:00:00.000Z", completedAt: "2026-09-05T00:00:00.000Z" });
    assert.equal(unselected.status, "not_run");
    assert.equal(unselected.outcomeClass, "not_run");
    assert.equal(unselected.trial, null);
  }
});

test("a terminal that differs from the case's expectation is a mismatch that keeps the raw Run", async (t) => {
  const datasetPath = datasetFile(t, (manifest) => {
    manifest.cases[0].expected_terminal = { outcome: "failed", error_code: "model_output_invalid" };
  });
  const harness = createHarness({
    terminalByScenario: { "crash-loop-backoff": { outcome: "failed", errorCode: "tool_timeout", retryable: true, incidentStatus: "STALE_RESOURCE" } },
  });
  const { artifact } = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation", datasetPath, scenarioIds: ["crash-loop-backoff"] },
    harness.dependencies,
  );
  recordGolden("catalog-terminal-mismatch", artifact);
  const [result] = artifact.scenarios;
  assert.equal(result.status, "failed");
  assert.equal(result.outcomeClass, "outcome_mismatch");
  assert.deepEqual(result.failure, {
    code: "terminal_outcome_mismatch",
    message: "The Run ended FAILED/tool_timeout while the case expects failed/model_output_invalid",
  });
  assert.deepEqual(result.checks.run, { attempt: 1, status: "FAILED", errorCode: "tool_timeout", retryable: true, outcome: null });
});

test("the persisted terminal event and the diagnosis shape are gated for non-diagnosed expectations", async (t) => {
  const failed = { outcome: "failed", errorCode: "model_output_invalid", retryable: false };
  for (const [options, code, terminal] of [
    [{ staleSseTerminal: true }, "sse_replay_invalid"],
    [{ sseTerminalStateDrift: true }, "sse_replay_invalid"],
    [{ sseTerminalStateDrift: true }, "sse_replay_invalid", failed],
    [{ emptyMissingInformation: true }, "diagnosis_invalid"],
    [{ insufficientWithRootCauses: true }, "diagnosis_invalid"],
    [{ incidentStatusDrift: true }, "diagnosis_invalid"],
    [{ repairDrift: true }, "diagnosis_invalid"],
    [{ incidentStatusDrift: true }, "run_failure_invalid", failed],
    [{ repairDrift: true }, "run_failure_invalid", failed],
    [{ retryableDrift: true }, "run_failure_invalid", failed],
  ]) {
    const expected = terminal === undefined ? { outcome: "insufficient_evidence" } : { outcome: "failed", error_code: terminal.errorCode };
    const datasetPath = datasetFile(t, (manifest) => { manifest.cases[0].expected_terminal = expected; });
    const harness = createHarness({ terminalByScenario: { "crash-loop-backoff": terminal ?? { outcome: "insufficient_evidence" } }, ...options });
    const { artifact } = await runEvaluationCommand(
      { action: "run", profile: "kind-evaluation", datasetPath, scenarioIds: ["crash-loop-backoff"] },
      harness.dependencies,
    );
    assert.equal(artifact.scenarios[0].failure.code, code, JSON.stringify(options));
    assert.equal(artifact.scenarios[0].outcomeClass, "contract_failed");
  }
});

test("a fixture that breaks before an Incident exists is an infrastructure failure, not a model one", async () => {
  const harness = createHarness();
  const original = harness.dependencies.runScenarioCommand;
  harness.dependencies.runScenarioCommand = async (action, scenarioId, args) => {
    if (action === "verify" && scenarioId === "crash-loop-backoff") throw new Error("fixture did not converge");
    return original(action, scenarioId, args);
  };
  const { artifact } = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation", scenarioIds: ["crash-loop-backoff"] },
    harness.dependencies,
  );
  const [result] = artifact.scenarios;
  assert.equal(result.status, "failed");
  assert.equal(result.outcomeClass, "infrastructure_invalid");
  assert.equal(result.reviewPackage, null);
  assert.equal(result.checks.alertmanagerFiring, false);
  assert.equal(result.checks.uniqueIncident, false);
  assert.equal(result.failure.message.includes("converge"), false);
});

test("a fired alert that fails before a unique Incident exists is an intake failure of the product", async () => {
  const harness = createHarness({ controlAlertScenarioId: "crash-loop-backoff" });
  const { artifact } = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation", scenarioIds: ["crash-loop-backoff"] },
    harness.dependencies,
  );
  const [result] = artifact.scenarios;
  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "healthy_control_alerted");
  assert.equal(result.checks.alertmanagerFiring, true);
  assert.equal(result.checks.uniqueIncident, false);
  assert.equal(result.outcomeClass, "intake_failed");
  assert.equal(result.reviewPackage, null);
});

test("dataset reader rejects oversized or linked files without exposing their content", async (t) => {
  const datasetPath = datasetFile(t, () => {});
  const scenarios = loadEvaluationScenarioCatalog(REPOSITORY_ROOT);
  const linked = path.join(path.dirname(datasetPath), "linked.json");
  symlinkSync(datasetPath, linked);
  assert.throws(() => loadEvaluationDataset(REPOSITORY_ROOT, scenarios, linked), { code: "evaluation_dataset_invalid" });
  writeFileSync(datasetPath, "sensitive-canary".repeat(80_000));
  assert.throws(() => loadEvaluationDataset(REPOSITORY_ROOT, scenarios, datasetPath), (error) => {
    assert.equal(error.code, "evaluation_dataset_invalid");
    assert.equal(error.message.includes("sensitive-canary"), false);
    return true;
  });
});

test("pre-scenario failure still reports the complete planned denominator", async () => {
  const harness = createHarness();
  harness.dependencies.environment.OPERATOR_PASSWORD_FILE = undefined;
  const { artifact } = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation", scenarioIds: ["crash-loop-backoff"] }, harness.dependencies,
  );
  assert.equal(artifact.status, "failed");
  assert.equal(artifact.coverage.plannedCases, 7);
  assert.equal(artifact.coverage.notRunCases, 7);
  assert.equal(artifact.scenarios.every((entry) => entry.status === "not_run" && entry.reason === "evaluation_aborted"), true);
});

test("alert maturity uses the selected case budget instead of the old seven-minute ceiling", async (t) => {
  const datasetPath = datasetFile(t, (manifest) => { manifest.cases[0].alert_wait_seconds = 540; });
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-05T00:00:00Z") });
  const harness = createHarness();
  const fetch = harness.dependencies.fetch;
  const runner = harness.dependencies.runScenarioCommand;
  const sleep = harness.dependencies.sleep;
  let readyAt = 0;
  harness.dependencies.runScenarioCommand = async (action, id, options) => {
    readyAt = action === "apply" ? Date.now() + 480_000 : action === "cleanup" ? 0 : readyAt;
    return runner(action, id, options);
  };
  harness.dependencies.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (Date.now() < readyAt && url.port === "19090" && url.searchParams.get("query")?.startsWith("ALERTS{")) {
      return jsonResponse({ status: "success", data: { resultType: "vector", result: [] } });
    }
    return fetch(input, init);
  };
  harness.dependencies.sleep = async (milliseconds) => {
    t.mock.timers.tick(milliseconds);
    // The repeat notification belongs after the initial firing/diagnosis, not
    // to the synthetic time spent waiting for the first alert to mature.
    if (Date.now() > readyAt) await sleep(milliseconds);
  };
  const { artifact } = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation", datasetPath, scenarioIds: ["crash-loop-backoff"] }, harness.dependencies,
  );
  assert.equal(artifact.status, "pending_manual_review", JSON.stringify(artifact));
  assert.ok(Date.now() - Date.parse("2026-09-05T00:00:00Z") >= 480_000);
});

// Runs one focused campaign with the real record writers and reader under a temporary repository root.
function realCampaign(t, root, { suffix, options = {}, ...request }) {
  const harness = createHarness(options);
  harness.dependencies.repositoryRoot = root;
  harness.dependencies.campaignSuffix = () => suffix;
  const execute = harness.dependencies.execute;
  harness.dependencies.execute = (command, args, settings) => execute(command, args, { ...settings, cwd: REPOSITORY_ROOT });
  delete harness.dependencies.writeArtifact;
  delete harness.dependencies.writeTrialPackage;
  const result = runEvaluationCommand(
    { action: "run", profile: "kind-evaluation", scenarioIds: ["crash-loop-backoff"], ...request },
    harness.dependencies,
  );
  return { harness, result };
}

test("each campaign lands in its own files, never overwrites another and leaves earlier results untouched", async (t) => {
  const datasetPath = datasetFile(t, () => {});
  const root = path.dirname(datasetPath);
  const outputDirectory = path.join(root, ".runtime/evaluation");
  mkdirSync(outputDirectory, { recursive: true });
  const historicalPath = path.join(outputDirectory, "kind-evaluation-regression-v1-focused.json");
  writeFileSync(historicalPath, '{"schemaVersion":3,"historical":true}\n');
  const first = await realCampaign(t, root, { datasetPath, suffix: "0000aaaa" }).result;
  assert.equal(first.artifact.status, "pending_manual_review");
  const campaignDirectory = path.join(outputDirectory, "kind-evaluation");
  assert.equal(first.artifactPath, path.join(campaignDirectory, "20260905T000000Z-0000aaaa.json"));
  assert.equal(statSync(first.artifactPath).mode & 0o777, 0o600);
  assert.equal(statSync(campaignDirectory).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(first.artifactPath, "utf8")), JSON.parse(JSON.stringify(first.artifact)));
  const packagePath = path.join(campaignDirectory, first.artifact.campaign.id, first.artifact.scenarios[0].reviewPackage);
  assert.equal(statSync(packagePath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(packagePath, "utf8")).runId, first.artifact.scenarios[0].runId);

  const second = await realCampaign(t, root, { datasetPath, suffix: "0000bbbb" }).result;
  assert.notEqual(second.artifactPath, first.artifactPath);
  assert.deepEqual(JSON.parse(readFileSync(first.artifactPath, "utf8")), JSON.parse(JSON.stringify(first.artifact)));
  // The same identity again is refused before the Trial's own record could be replaced.
  await assert.rejects(realCampaign(t, root, { datasetPath, suffix: "0000aaaa" }).result, { code: "evaluation_artifact_exists" });
  assert.deepEqual(JSON.parse(readFileSync(packagePath, "utf8")).runId, first.artifact.scenarios[0].runId);
  assert.equal(readFileSync(historicalPath, "utf8"), '{"schemaVersion":3,"historical":true}\n');
});

test("a retry names the campaign it continues and only a real sibling record of the same dataset qualifies", async (t) => {
  const datasetPath = datasetFile(t, () => {});
  const root = path.dirname(datasetPath);
  const first = await realCampaign(t, root, { datasetPath, suffix: "0000aaaa" }).result;
  const campaignDirectory = path.dirname(first.artifactPath);
  const retry = await realCampaign(t, root, { datasetPath, suffix: "0000cccc", retryOf: first.artifact.campaign.id }).result;
  assert.equal(retry.artifact.campaign.retryOf, first.artifact.campaign.id);
  assert.notEqual(retry.artifact.campaign.id, first.artifact.campaign.id);

  // A link to a record that would qualify if it were followed: the reader must refuse the link itself.
  const linked = path.join(root, "outside-eeee.json");
  writeFileSync(linked, JSON.stringify({
    ...first.artifact, campaign: { ...first.artifact.campaign, id: "20260905T000000Z-0000eeee" },
  }));
  symlinkSync(linked, path.join(campaignDirectory, "20260905T000000Z-0000eeee.json"));
  writeFileSync(path.join(campaignDirectory, "20260905T000000Z-0000dddd.json"), "not json\n");
  const manifest = JSON.parse(readFileSync(datasetPath, "utf8"));
  const otherVersion = path.join(root, "dataset-v2.json");
  writeFileSync(otherVersion, JSON.stringify({ ...manifest, dataset_version: 2 }));
  for (const [request, code] of [
    [{ retryOf: "not-a-campaign" }, "invalid_arguments"],
    [{ retryOf: "20260905T000000Z-0000ffff" }, "evaluation_retry_target_invalid"],
    [{ retryOf: "20260905T000000Z-0000eeee" }, "evaluation_retry_target_invalid"],
    [{ retryOf: "20260905T000000Z-0000dddd" }, "evaluation_retry_target_invalid"],
    [{ retryOf: first.artifact.campaign.id, datasetPath: otherVersion }, "evaluation_retry_target_invalid"],
  ]) {
    const { harness, result } = realCampaign(t, root, { datasetPath, suffix: "0000ffff", ...request });
    await assert.rejects(result, { code }, JSON.stringify(request));
    assert.equal(harness.calls.scenarioApply, 0, JSON.stringify(request));
  }
});

test("records are refused when a directory on their path is a symbolic link", async (t) => {
  const datasetPath = datasetFile(t, () => {});
  const root = path.dirname(datasetPath);
  const elsewhere = path.join(root, "elsewhere");
  mkdirSync(path.join(root, ".runtime/evaluation"), { recursive: true });
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, path.join(root, ".runtime/evaluation/kind-evaluation"));
  await assert.rejects(realCampaign(t, root, { datasetPath, suffix: "0000aaaa" }).result, { code: "artifact_directory_invalid" });
  assert.deepEqual(readdirSync(elsewhere), []);
});

test("a review package near its size bound is written with the bytes that were measured and stays readable", async (t) => {
  const datasetPath = datasetFile(t, () => {});
  const root = path.dirname(datasetPath);
  const { harness, result } = realCampaign(t, root, {
    datasetPath, suffix: "0000aaaa", options: { manyRunEvents: { pages: 10, perPage: 100, fields: 200 } },
  });
  const { artifact, artifactPath } = await result;
  const [scenario] = artifact.scenarios;
  assert.equal(scenario.status, "pending_manual_review", JSON.stringify(scenario.failure));
  const packagePath = path.join(path.dirname(artifactPath), artifact.campaign.id, scenario.reviewPackage);
  const size = statSync(packagePath).size;
  assert.ok(size > 3.5 * 1024 * 1024 && size <= 4 * 1024 * 1024, `package is ${size} bytes`);
  const record = JSON.parse(readFileSync(packagePath, "utf8"));
  assert.equal(record.truncated, false);
  assert.equal(record.events.length, 1000);
  assert.equal(harness.calls.packages.length, 0);
  const report = await buildCampaignReport(artifactPath);
  assert.deepEqual(report.scenarios[0].reviewPackage, { truncated: false });
});

test("each Trial's review package holds the projected Incident and its Run events without credentials", async () => {
  const harness = createHarness();
  const { artifact } = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation", scenarioIds: ["image-pull-backoff"] }, harness.dependencies,
  );
  const result = artifact.scenarios.find((scenario) => scenario.scenarioId === "image-pull-backoff");
  assert.equal(result.reviewPackage, "trials/image-pull-backoff.json");
  assert.equal(harness.calls.packages.length, 1);
  const [record] = harness.calls.packages;
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.campaignId, artifact.campaign.id);
  assert.equal(record.trial, 1);
  assert.equal(record.runId, result.runId);
  assert.equal(record.incident.diagnosis.outcome, "diagnosed");
  assert.ok(record.incident.evidence.length > 0);
  assert.deepEqual(record.events.map((event) => event.event).slice(0, 3), ["incident.created", "run.started", "diagnosis.completed"]);
  assert.equal(record.truncated, false);
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes(harness.state.cookie), false);
  assert.equal(serialized.includes(harness.state.csrf), false);
  assert.equal(serialized.includes(AUTH_PASSWORD), false);
  assert.equal(artifact.scenarios.find((scenario) => scenario.status === "not_run").reviewPackage, null);
});

test("a review package that would exceed its size bound drops the event history and says so", async () => {
  const harness = createHarness({ bulkyRunEvents: true });
  const { artifact } = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation", scenarioIds: ["crash-loop-backoff"] }, harness.dependencies,
  );
  assert.equal(artifact.scenarios[0].status, "pending_manual_review");
  const [record] = harness.calls.packages;
  assert.equal(record.truncated, true);
  assert.deepEqual(record.events, []);
  assert.equal(record.incident.diagnosis.outcome, "diagnosed");
  // What reaches the writer after truncation is itself within the bound.
  assert.ok(harness.calls.packageBytes[0] <= 4 * 1024 * 1024);
});

test("catalog evaluation consumes retained Incident history through pagination", async () => {
  const harness = createHarness({ paginatedIncidents: true });

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  assert.equal(result.artifact.status, "pending_manual_review");
});

test("evaluation rejects a dirty worktree before live side effects", async () => {
  const harness = createHarness({ dirtyWorktree: true });

  await assert.rejects(
    runEvaluationCommand(
      { action: "run", profile: "kind-evaluation" },
      harness.dependencies,
    ),
    { code: "release_worktree_dirty" },
  );
  assert.equal(harness.calls.scenarioApply, 0);
  assert.equal(harness.calls.tunnelClose, 0);
});

test("evaluation rejects OCI images built from another revision", async () => {
  const harness = createHarness({ releaseRevision: "c".repeat(40) });

  await assert.rejects(
    runEvaluationCommand(
      { action: "run", profile: "kind-evaluation" },
      harness.dependencies,
    ),
    { code: "release_revision_mismatch" },
  );
  assert.equal(harness.calls.scenarioApply, 0);
});

test("evaluation rejects the former digest-only lock commit exception", async () => {
  const lockRevision = "d".repeat(40);
  const harness = createHarness({ headRevision: lockRevision });
  harness.state.online = true;

  await assert.rejects(runEvaluationCommand(
    { action: "online", profile: "k3s-public", context: "fixed-k3s" },
    harness.dependencies,
  ), { code: "release_revision_mismatch" });
  assert.equal(harness.calls.tunnelClose, 0);
});

test("evaluation rejects source drift after the image revision", async () => {
  const harness = createHarness({
    headRevision: "d".repeat(40),
    releaseSourceDrift: true,
  });

  await assert.rejects(
    runEvaluationCommand(
      { action: "run", profile: "kind-evaluation" },
      harness.dependencies,
    ),
    { code: "release_revision_mismatch" },
  );
  assert.equal(harness.calls.scenarioApply, 0);
});

test("diagnosis requires root causes to link all required Evidence regardless of code", async () => {
  const harness = createHarness({ omitDiagnosisEvidenceLinks: true });

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  assert.equal(result.artifact.status, "failed");
  assert.equal(
    result.artifact.scenarios[0].failure.code,
    "diagnosis_evidence_links_invalid",
  );
});

test("ordinary code naming does not block lifecycle checks or prove diagnosis correctness", async () => {
  const harness = createHarness({
    diagnosisCodeByScenario: {
      "liveness-probe-misconfigured": "liveness_probe_port_mismatch",
      "pvc-binding-pending": "a_different_model_generated_label",
    },
  });
  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );
  assert.equal(result.artifact.status, "pending_manual_review");
  for (const scenario of result.artifact.scenarios) {
    assert.equal(scenario.status, "pending_manual_review");
    assert.equal(scenario.checks.repeatDeliveryDeduplicated, true);
    assert.equal(scenario.checks.alertResolved, true);
    assert.ok(scenario.checks.panels.length > 0);
  }
});

test("context panels may be empty on a profile without kubelet collection, but never unqueryable", async () => {
  const healthy = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    createHarness().dependencies,
  );
  for (const scenario of healthy.artifact.scenarios) {
    if (scenario.status !== "passed") continue;
    const context = scenario.checks.panels.find((panel) => panel.signalRole === "context");
    assert.equal(context?.state, "no_data");
  }

  const broken = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    createHarness({ contextPanelState: "query_error" }).dependencies,
  );
  assert.ok(broken.artifact.scenarios.length > 0);
  for (const scenario of broken.artifact.scenarios) {
    assert.equal(scenario.status, "failed");
    assert.equal(scenario.failure.code, "firing_panel_invalid");
  }
});

test("ImagePull repair is judged by cited Evidence, not by the root-cause name", async () => {
  const harness = createHarness({
    diagnosisCodeByScenario: {
      "image-pull-backoff": "registry_host_unresolvable",
    },
  });

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  const imagePull = result.artifact.scenarios.find(
    (scenario) => scenario.scenarioId === "image-pull-backoff",
  );
  assert.notEqual(imagePull.status, "failed");
  assert.equal(imagePull.checks.repair.validation, "passed");
  assert.equal(imagePull.checks.repair.terminalStatus, "WAITING_APPROVAL");
});

test("ImagePull diagnosis alone cannot satisfy the repair evaluation slice", async () => {
  const harness = createHarness({
    diagnosisCodeByScenario: {
      "image-pull-backoff": "image_pull_forbidden_invalid_registry",
    },
    omitRepair: true,
  });

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  const imagePull = result.artifact.scenarios.find(
    (scenario) => scenario.scenarioId === "image-pull-backoff",
  );
  assert.equal(imagePull.status, "failed");
  assert.equal(imagePull.failure.code, "repair_validation_invalid");
});

test("an old expected code with an unsupported statement remains pending manual review", async () => {
  const harness = createHarness({
    diagnosisCodeByScenario: { "pvc-binding-pending": "persistent_volume_claim_unbound" },
    diagnosisStatement: "The claim was continuously Pending throughout a full hour despite only five minutes of samples.",
  });
  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation", scenarioIds: ["pvc-binding-pending"] },
    harness.dependencies,
  );
  assert.equal(result.artifact.status, "pending_manual_review");
  assert.equal(result.artifact.scenarios.find(
    (scenario) => scenario.scenarioId === "pvc-binding-pending",
  ).status, "pending_manual_review");
});

test("diagnosis rejects malformed or unknown placeholder codes", async (t) => {
  for (const code of ["unknown", "Not a code", "a".repeat(65)]) {
    await t.test(code, async () => {
      const harness = createHarness({ diagnosisCodeByScenario: { "pvc-binding-pending": code } });
      const result = await runEvaluationCommand(
        { action: "run", profile: "kind-evaluation", scenarioIds: ["pvc-binding-pending"] },
        harness.dependencies,
      );
      assert.equal(result.artifact.status, "failed");
      assert.equal(result.artifact.scenarios.find(
        (scenario) => scenario.scenarioId === "pvc-binding-pending",
      ).failure.code, "diagnosis_evidence_links_invalid");
    });
  }
});

test("Console proof requires stable Incident details, not an echoed id", async () => {
  const harness = createHarness({ consoleEchoOnly: true });

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  assert.equal(result.artifact.status, "failed");
  assert.equal(
    result.artifact.scenarios[0].failure.code,
    "console_incident_incomplete",
  );
});

test("SSE replay proof validates lifecycle payload identity", async () => {
  const harness = createHarness({ invalidSseContract: true });

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  assert.equal(result.artifact.status, "failed");
  assert.equal(result.artifact.scenarios[0].failure.code, "sse_replay_invalid");
});

test("ImagePull SSE replay rejects duplicate repair lifecycle events", async () => {
  const harness = createHarness({ duplicateRepairEvent: true });

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  const imagePull = result.artifact.scenarios.find(
    (scenario) => scenario.scenarioId === "image-pull-backoff",
  );
  assert.equal(imagePull.status, "failed");
  assert.equal(imagePull.failure.code, "sse_replay_invalid");
});

test("a diagnosis citing only non-identity Evidence fails closed", async () => {
  const harness = createHarness({ citeOnlyNonIdentityEvidence: true });

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  const scenario = result.artifact.scenarios.find(
    (item) => item.scenarioId === "crash-loop-backoff",
  );
  assert.equal(scenario.status, "failed");
  assert.equal(scenario.failure.code, "diagnosis_evidence_links_invalid");
});

test("citing the identity Evidence alone passes and records what was not cited", async () => {
  // The Runtime asks the model for this one kind; the scenario's other
  // expectations were never put to it, so they are reported, not enforced.
  const harness = createHarness({ citeOnlyIdentityEvidence: true });

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  const scenario = result.artifact.scenarios.find(
    (item) => item.scenarioId === "crash-loop-backoff",
  );
  assert.equal(scenario.status, "pending_manual_review");
  assert.deepEqual(scenario.checks.uncitedExpectedEvidence, [
    "pods",
    "events",
    "container_logs",
  ]);
});

test("Evidence produced by a tool the scenario forbids has its own code", async () => {
  const harness = createHarness({ forbiddenToolUsed: true });

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  const scenario = result.artifact.scenarios.find(
    (item) => item.scenarioId === "crash-loop-backoff",
  );
  assert.equal(scenario.status, "failed");
  assert.equal(scenario.failure.code, "diagnosis_tools_invalid");
});

test("an uncollected expected Evidence kind is named by its own code", async () => {
  const harness = createHarness({ uncollectedEvidenceKind: "container_logs" });

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  const scenario = result.artifact.scenarios.find(
    (item) => item.scenarioId === "crash-loop-backoff",
  );
  assert.equal(scenario.status, "failed");
  assert.equal(scenario.failure.code, "diagnosis_evidence_missing");
});

test("ImagePull evaluation rejects a proposal that rolls back an execution", async () => {
  const harness = createHarness({
    sourceExecutionId: "70000000-0000-4000-8000-0000000000ff",
  });

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  const imagePull = result.artifact.scenarios.find(
    (scenario) => scenario.scenarioId === "image-pull-backoff",
  );
  assert.equal(imagePull.status, "failed");
  assert.equal(imagePull.failure.code, "repair_validation_invalid");
});

test("ImagePull evaluation rejects a proposal digest outside the compiler contract", async () => {
  const harness = createHarness({ invalidRepairDigest: true });

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  const imagePull = result.artifact.scenarios.find(
    (scenario) => scenario.scenarioId === "image-pull-backoff",
  );
  assert.equal(imagePull.status, "failed");
  assert.equal(imagePull.failure.code, "repair_validation_invalid");
});

function createHarness(options = {}) {
  const scenarios = options.scenarios ?? loadEvaluationScenarioCatalog(REPOSITORY_ROOT);
  const headRevision = options.headRevision ?? REVISION;
  const releaseDirectory = mkdtempSync(path.join(AUTH_DIRECTORY, "release-"));
  const releaseFixture = createReleaseFixture(releaseDirectory, options.releaseRevision ?? REVISION);
  const releaseEnvironment = gitFixtureEnvironment(releaseDirectory, headRevision, options.dirtyWorktree);
  const scenarioById = new Map(
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
  const calls = {
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
  const state = {
    cookie: undefined,
    csrf: undefined,
    logins: 0,
    online: false,
    prometheus: true,
    kubeStateMetrics: true,
    watchdogLastReceivedAt: "2026-09-05T00:00:00.000Z",
  };

  const dependencies = {
    [RELEASE_SELECTION]: { release: releaseFixture.release, environment: releaseEnvironment },
    environment: {
      get OPERATOR_ORIGIN() { return state.online ? "https://console.example.test" : "http://127.0.0.1:13000"; },
      OPERATOR_PASSWORD_FILE: AUTH_FILE,
    },
    repositoryRoot: REPOSITORY_ROOT,
    scenarios,
    now: () => new Date("2026-09-05T00:00:00.000Z"),
    sleep: async (milliseconds) => {
      calls.sleepDurations.push(milliseconds);
      const active = [...scenarioById.values()].find(
        (scenario) => scenario.applied,
      );
      if (active !== undefined && !active.repeated) {
        active.repeated = true;
        active.updatedAt = "2026-09-05T00:00:01.000Z";
      }
    },
    verifyDeploymentStatus: async (_profile, _context, { release }) => {
      assert.deepEqual(release, releaseFixture.manifest);
      return { deployments: "ready" };
    },
    runScenarioCommand: async (action, scenarioId, { release }) => {
      assert.deepEqual(release, releaseFixture.manifest);
      const scenario = scenarioById.get(scenarioId);
      assert.ok(scenario);
      if (action === "apply") {
        calls.scenarioApply += 1;
        scenario.applied = true;
        scenario.resolved = false;
        scenario.repeated = false;
        scenario.updatedAt = "2026-09-05T00:00:00.000Z";
      } else if (action === "verify") {
        calls.scenarioVerify += 1;
        assert.equal(scenario.applied, true);
      } else if (action === "cleanup") {
        if (scenario.applied) scenario.resolved = true;
        scenario.applied = false;
      }
      return { status: "ok" };
    },
    openTunnels: async () => ({
      async restart() {
        calls.tunnelRestart += 1;
      },
      async close() {
        calls.tunnelClose += 1;
      },
    }),
    execute: async (command, args) => {
      assert.equal(command, "kubectl");
      const replicas = args.find((value) => value.startsWith("--replicas="));
      const deployment = args.find((value) => value.startsWith("deployment/"));
      if (replicas !== undefined && deployment !== undefined) {
        const available = replicas === "--replicas=1";
        if (deployment === "deployment/prometheus") state.prometheus = available;
        if (deployment === "deployment/kube-state-metrics") {
          state.kubeStateMetrics = available;
        }
      }
      if (args.includes("get") && args.includes("pods")) {
        const selector = args[args.indexOf("--selector") + 1];
        const name = selector.split("=").at(-1);
        return JSON.stringify({
          apiVersion: "v1",
          kind: "List",
          items: [{ metadata: { name: `${name}-pod` } }],
        });
      }
      if (args.includes("delete") && args.includes("alertmanager-pod")) {
        calls.alertmanagerRestarts += 1;
        if (options.staleWatchdogAfterRotation !== true) {
          state.watchdogLastReceivedAt = "2026-09-05T00:01:00.000Z";
        }
      }
      if (args.includes("delete") && args.includes("agent-runtime-pod")) state.cookie = undefined;
      return "";
    },
    fetch: async (input, init) =>
      fakeFetch(String(input), init, scenarioById, state, options),
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
  if (GOLDEN_DIRECTORY !== undefined) dependencies.campaignSuffix = () => "0000aaaa";
  return { calls, dependencies, state };
}

function fakeFetch(rawUrl, init, scenarioById, state, options) {
  const url = new URL(rawUrl);
  const headers = new Headers(init?.headers);
  const origin = state.online ? "https://console.example.test" : "http://127.0.0.1:13000";
  if (url.port === "18080" && url.pathname === "/api/v1/operator/login") {
    assert.equal(init?.method, "POST");
    assert.equal(headers.get("origin"), origin);
    assert.equal(JSON.parse(init.body).password === AUTH_PASSWORD, true);
    state.logins += 1;
    state.cookie = "__Host-k8s-incident-session=" + randomBytes(32).toString("base64url");
    state.csrf = randomBytes(32).toString("hex");
    return new Response(JSON.stringify({ operatorRef: "sandbox-operator", expiresAt: Math.floor(Date.now() / 1000) + 3600, csrfToken: state.csrf }), {
      headers: { "content-type": "application/json", "set-cookie": state.cookie + "; HttpOnly; Secure; SameSite=strict; Path=/; Max-Age=3600" },
    });
  }
  if ((url.port === "18080" && url.pathname.startsWith("/api/v1/")) ||
      (url.port === "13000" && url.pathname !== "/api/healthz")) {
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
  const active = [...scenarioById.values()].find((scenario) => scenario.applied);

  if (url.port === "13000") {
    if (url.pathname === "/api/healthz") return new Response(null, { status: 204 });
    if (url.pathname === "/") {
      return textResponse(state.online ? "K8s Incident Agent 重新诊断" : "离线评估入口");
    }
    if (url.pathname.startsWith("/incidents/")) {
      const incidentId = url.pathname.split("/").at(-1);
      const scenario = [...scenarioById.values()].find(
        (candidate) => candidate.incidentId === incidentId,
      );
      if (scenario === undefined || options.consoleEchoOnly === true) {
        return textResponse(incidentId);
      }
      return textResponse(
        `${incidentId} ${scenario.displayName} ${scenario.target.name}`,
      );
    }
  }

  if (url.port === "19090") {
    if (url.pathname === "/-/ready") return textResponse("ready");
    const query = url.searchParams.get("query") ?? "";
    const matchesActive =
      active !== undefined &&
      query.includes(`alertname=\"${active.alertId}\"`) &&
      query.includes(`=\"${active.target.name}\"`);
    const control = active === undefined || options.controlAlertScenarioId !== active.scenarioId
      ? undefined
      : active.healthyControlNames.find((name) => query.includes(`="${name}"`));
    if (control !== undefined) {
      return jsonResponse(prometheusVector(1, {
        alertname: active.alertId,
        alertstate: "firing",
        cluster: active.target.cluster,
        namespace: active.target.namespace,
        [targetLabel(active.target.kind)]: control,
      }));
    }
    return jsonResponse(
      matchesActive
        ? prometheusVector(1, {
            alertname: active.alertId,
            alertstate: "firing",
            cluster: active.target.cluster,
            namespace: active.target.namespace,
            [targetLabel(active.target.kind)]: active.target.name,
          })
        : prometheusVector(),
    );
  }

  if (url.port === "19093") {
    if (url.pathname === "/-/ready") return textResponse("ready");
    return jsonResponse(
      active === undefined
        ? []
        : [
            {
              labels: {
                alertname: active.alertId,
                cluster: active.target.cluster,
                namespace: active.target.namespace,
                [targetLabel(active.target.kind)]: active.target.name,
              },
              status: { state: "active" },
            },
          ],
    );
  }

  if (url.port !== "18080") return new Response(null, { status: 404 });
  if (url.pathname === "/healthz") return jsonResponse({ status: "ok", diagnosis: {
    status: options.onlineRerunStatus === 503 ? "unavailable" : "ready",
    reason: options.onlineRerunStatus === 503 ? "model_upstream_failed" : null,
  } });
  const method = init?.method ?? "GET";
  if (url.pathname === "/api/v1/scenarios") {
    return new Response(null, {
      status: options.onlineManualRoutes === true ? 200 : 404,
    });
  }
  if (url.pathname === "/api/v1/incidents" && method === "POST") {
    return new Response(null, {
      status: options.onlineManualRoutes === true ? 422 : 405,
    });
  }
  if (url.pathname === "/api/v1/monitoring/health") {
    const healthy = state.prometheus && state.kubeStateMetrics;
    return jsonResponse({
      state: healthy ? "healthy" : "unavailable",
      prometheus: state.prometheus ? "healthy" : "unavailable",
      kubeStateMetrics: state.kubeStateMetrics ? "healthy" : "unavailable",
      ruleEvaluation: state.prometheus ? "healthy" : "unavailable",
      alertmanager: "healthy",
      notification: "healthy",
      watchdogLastReceivedAt: state.watchdogLastReceivedAt,
    });
  }
  if (url.pathname === "/api/v1/incidents") {
    const controlScenario = [...scenarioById.values()].find(
      (scenario) =>
        scenario.scenarioId === options.controlIncidentScenarioId &&
        scenario.applied &&
        scenario.repeated,
    );
    const scenarioItems = [...scenarioById.values()]
      .filter(
        (scenario) =>
          scenario.scenarioId === options.otherAlertSameTargetScenarioId &&
          (scenario.applied || scenario.resolved),
      )
      .map((scenario) => ({
        id: scenario.otherIncidentId,
        updatedAt: scenario.updatedAt,
      }))
      .concat(
        [...scenarioById.values()]
          .filter((scenario, index) => scenario.applied || scenario.resolved ||
            (state.online && index === 0 && !options.onlineEmpty))
          .map((scenario) => ({
            id: scenario.incidentId,
            updatedAt: scenario.updatedAt,
          })),
      )
      .concat(
        controlScenario === undefined
          ? []
          : [
              {
                id: controlScenario.controlIncidentId,
                updatedAt: controlScenario.updatedAt,
              },
            ],
      );
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
    return jsonResponse({
      schemaVersion: 5,
      items: scenarioItems,
      nextCursor: null,
    });
  }

  const match = url.pathname.match(/^\/api\/v1\/incidents\/([^/]+)(.*)$/);
  if (match === null) return new Response(null, { status: 404 });
  const scenario = [...scenarioById.values()].find(
    (candidate) =>
      candidate.incidentId === match[1] ||
      candidate.otherIncidentId === match[1] ||
      candidate.controlIncidentId === match[1],
  );
  if (scenario === undefined) return new Response(null, { status: 404 });
  const isOtherIncident = scenario.otherIncidentId === match[1];
  const isControlIncident = scenario.controlIncidentId === match[1];
  const suffix = match[2];
  if (state.online && suffix === "/runs" && method === "POST") {
    assert.deepEqual(JSON.parse(init.body), {});
    if (options.onlineRerunStatus === 409) return jsonResponse({ error: { code: "active_run_exists" } }, 409);
    if (options.onlineRerunStatus === 503) return jsonResponse({ error: { code: "diagnosis_unavailable" } }, 503);
    if (options.onlineRerunStatus === 422) return jsonResponse({ error: { code: "invalid_request" } }, 422);
    state.rerunId = "10000000-0000-4000-8000-000000000099";
    return jsonResponse({ schemaVersion: 5, runId: state.rerunId }, options.onlineRerunStatus ?? 202);
  }
  const runEvents = suffix.match(/^\/runs\/([^/]+)\/events$/);
  if (runEvents !== null) {
    if (runEvents[1] !== scenario.runId) return new Response(null, { status: 404 });
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
  if (suffix === "/runs") {
    return jsonResponse({
      schemaVersion: 5,
      items: [{ id: scenario.runId, kind: "diagnosis", operation: null, attempt: 1, status: "COMPLETED" }],
      nextCursor: null,
    });
  }
  if (suffix === "/monitoring/panels") {
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
  if (suffix.startsWith("/monitoring/panels/")) {
    if (isOtherIncident) return new Response(null, { status: 404 });
    const panelId = suffix.split("/").at(-1);
    const contextPanel = panelId.endsWith("-context");
    const panelState = contextPanel
      ? options.contextPanelState ?? "no_data"
      : !state.prometheus
        ? "monitoring_unavailable"
        : !state.kubeStateMetrics || scenario.resolved
          ? "stale"
          : "ok";
    const observed = !new Set(["monitoring_unavailable", "no_data", "query_error"]).has(
      panelState,
    );
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
  if (suffix === "/events" && headers.get("Last-Event-ID") === "0") {
    const frames = lifecycleFrames(scenario, options);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              frames.map(([event, data], index) =>
                `id: ${index + 1}\nevent: ${event}\ndata: ${data}\n\n`
              ).join(""),
            ),
          );
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }
  if (suffix !== "") return new Response(null, { status: 404 });

  const evidence = scenario.requiredEvidence
    .filter(
      (kind) =>
        options.uncollectedEvidenceKind === undefined ||
        kind !== options.uncollectedEvidenceKind,
    )
    .map((kind, index) => ({
    id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    evidenceKind: kind,
    toolName:
      options.forbiddenToolUsed === true && index === 0
        ? "execute_shell"
        : EVIDENCE_TOOL[kind],
  }));
  const diagnosisCode = diagnosisCodeFor(scenario, options);
  const terminal = terminalFor(scenario, options);
  const repair = terminal.outcome === "diagnosed" ? repairProjection(scenario, diagnosisCode, options, evidence) : null;
  return jsonResponse({
    schemaVersion: 5,
    incident: {
      id: isControlIncident
        ? scenario.controlIncidentId
        : isOtherIncident
          ? scenario.otherIncidentId
          : scenario.incidentId,
      source: {
        type: "alertmanager",
        ref: isOtherIncident
          ? "K8sIncidentDeploymentReplicasUnavailable"
          : scenario.alertId,
        revision: "catalog-v1",
      },
      target: isControlIncident
        ? { ...scenario.target, name: scenario.healthyControlNames[0] }
        : scenario.target,
      status: incidentStatusFor(terminal, repair, options),
      displayName: scenario.displayName,
    },
    selectedRun: {
      kind: "diagnosis",
      operation: null,
      id: state.online && state.rerunId && !options.onlineWrongRun ? state.rerunId : scenario.runId,
      attempt: state.online && state.rerunId ? 2 : 1,
      status: state.online && options.onlineRerunStatus === 409 ? "RUNNING" : terminal.outcome === "failed" ? "FAILED" : "COMPLETED",
      requestSource: state.online && state.rerunId ? "operator" : "system",
      error: terminal.outcome === "failed"
        ? { code: terminal.errorCode, retryable: options.retryableDrift === true ? "yes" : terminal.retryable ?? false }
        : null,
    },
    eventPage: {
      items: scenario.resolved ? [{ event: "alert.resolved" }] : [],
      nextCursor: null,
    },
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
      rootCauses: [
        {
          code: diagnosisCode,
          statement: options.diagnosisStatement ?? "A diagnostic explanation requiring independent semantic review.",
          confidence: "high",
          evidenceIds:
            options.omitDiagnosisEvidenceLinks === true
              ? []
              : options.citeOnlyNonIdentityEvidence === true
                ? evidence
                    .filter((item) => item.evidenceKind !== scenario.identityEvidence)
                    .map((item) => item.id)
                : options.citeOnlyIdentityEvidence === true
                  ? evidence
                      .filter(
                        (item) => item.evidenceKind === scenario.identityEvidence,
                      )
                      .map((item) => item.id)
                  : evidence.map((item) => item.id),
        },
      ],
    },
    repair: options.repairDrift === true && terminal.outcome !== "diagnosed" ? { drift: true } : repair,
    alertSignal: {
      status: scenario.resolved ? "RESOLVED" : "FIRING",
    },
    eventCursor: repair === null ? "3" : "6",
  });
}

function lifecycleFrames(scenario, options) {
  const diagnosisCode = diagnosisCodeFor(scenario, options);
  const terminal = terminalFor(scenario, options);
  const repair = terminal.outcome === "diagnosed" ? repairProjection(scenario, diagnosisCode, options) : null;
  const incidentId = options.invalidSseContract === true
    ? "90000000-0000-4000-8000-000000000001"
    : scenario.incidentId;
  const eventData = (fields) => JSON.stringify({
    schemaVersion: 5,
    incidentId,
    runId: scenario.runId,
    runKind: "diagnosis",
    occurredAt: "2026-09-05T00:00:00.000Z",
    ...fields,
  });
  const frames = [
    ["incident.created", eventData({
      attempt: 1,
      incidentStatus: "RECEIVED",
      runStatus: "QUEUED",
    })],
    ["run.started", eventData({
      attempt: 1,
      incidentStatus: "TRIAGING",
      runStatus: "RUNNING",
    })],
    terminalFrame(terminal, repair, eventData, options),
    ...(repair === null
      ? []
      : [
          ["repair.patch_ready", eventData({
            proposalId: repair.id,
            proposalDigest: repair.digest,
            incidentStatus: "PATCH_READY",
            runStatus: "RUNNING",
          })],
          ["repair.dry_run_passed", eventData({
            proposalId: repair.id,
            proposalDigest: repair.digest,
            incidentStatus: "DRY_RUN_PASSED",
            runStatus: "RUNNING",
          })],
          ["repair.waiting_approval", eventData({
            proposalId: repair.id,
            proposalDigest: repair.digest,
            incidentStatus: "WAITING_APPROVAL",
            runStatus: "COMPLETED",
          })],
        ]),
  ];
  if (repair !== null && options.duplicateRepairEvent === true) {
    frames.splice(4, 0, frames[3]);
  }
  return frames;
}

function terminalFor(scenario, options) {
  const configured = options.terminalByScenario?.[scenario.scenarioId];
  if (configured !== undefined) return configured;
  return { outcome: options.failingScenarioId === scenario.scenarioId ? "insufficient_evidence" : "diagnosed" };
}

function incidentStatusFor(terminal, repair, options) {
  if (options.incidentStatusDrift === true && terminal.outcome !== "diagnosed") return "DIAGNOSED";
  if (terminal.outcome === "insufficient_evidence") return "INSUFFICIENT_EVIDENCE";
  if (terminal.outcome === "failed") return terminal.incidentStatus ?? "FAILED";
  return repair === null ? "DIAGNOSED" : "WAITING_APPROVAL";
}

function terminalFrame(terminal, repair, eventData, options) {
  const outcome = options.staleSseTerminal === true ? "diagnosed" : terminal.outcome;
  // The right event name with the wrong persisted states: the replay gate must read the payload too.
  const drift = options.sseTerminalStateDrift === true;
  if (outcome === "insufficient_evidence") {
    return ["diagnosis.insufficient", eventData({
      diagnosisId: "50000000-0000-4000-8000-000000000001",
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
    diagnosisId: "50000000-0000-4000-8000-000000000001",
    outcome: "diagnosed",
    incidentStatus: "DIAGNOSED",
    runStatus: repair === null ? "COMPLETED" : "RUNNING",
  })];
}

function diagnosisCodeFor(scenario, options) {
  return options.diagnosisCodeByScenario?.[scenario.scenarioId] ??
    (scenario.expectedPatchConstraints === undefined
      ? "observed_cause"
      : "image_invalid_registry");
}

function repairProjection(scenario, diagnosisCode, options, evidence) {
  const expected = scenario.expectedPatchConstraints;
  if (
    expected === undefined ||
    options.omitRepair === true ||
    options.omitDiagnosisEvidenceLinks === true
  ) {
    return null;
  }
  const evidenceItems = evidence ?? scenario.requiredEvidence.map((kind, index) => ({
    id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    evidenceKind: kind,
  }));
  const evidenceIds = ["workload", "rollout_history"]
    .map((kind) => evidenceItems.find((item) => item.evidenceKind === kind)?.id)
    .sort();
  const imagePath =
    `/spec/template/spec/containers/${expected.containerIndex}/image`;
  const patch = [
    { op: "test", path: "/metadata/uid", value: "deployment-uid" },
    { op: "test", path: "/metadata/resourceVersion", value: "42" },
    {
      op: "test",
      path: `/spec/template/spec/containers/${expected.containerIndex}/name`,
      value: expected.containerName,
    },
    { op: "test", path: imagePath, value: expected.currentImage },
    { op: "replace", path: imagePath, value: expected.replacementImage },
  ];
  return {
    schemaVersion: 1,
    id: "70000000-0000-4000-8000-000000000001",
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
    digest:
      options.invalidRepairDigest === true
        ? `sha256:${"f".repeat(64)}`
        : "sha256:bc924be471167c459ae2d28e0e8b443d7d66bf4b7b329e2e81252f2aa9af97bf",
    diff: {
      path: imagePath,
      before: expected.currentImage,
      after: expected.replacementImage,
    },
    schemaCheckedAt: "2026-09-05T00:00:00.000Z",
    policyCheckedAt: "2026-09-05T00:00:01.000Z",
    diffCheckedAt: "2026-09-05T00:00:02.000Z",
    validation: {
      outcome: "passed",
      checkedAt: "2026-09-05T00:00:03.000Z",
      error: null,
    },
  };
}

function prometheusVector(value, metric = {}) {
  return {
    status: "success",
    data: {
      resultType: "vector",
      result:
        value === undefined
          ? []
          : [{ metric, value: [1_788_566_400, String(value)] }],
    },
  };
}

function targetLabel(kind) {
  return {
    Deployment: "deployment",
    Service: "service",
    PersistentVolumeClaim: "persistentvolumeclaim",
  }[kind];
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(value) {
  return new Response(value, { status: 200 });
}
