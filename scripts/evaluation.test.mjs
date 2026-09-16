import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { test, after } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runEvaluationCommand } from "./evaluation.mjs";
import {
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
const RELEASE_FIXTURE = createReleaseFixture(REVISION);
const releaseLock = (digest) => `
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
images:
  - name: k8s-incident-agent-console
    newName: k8s-incident-agent-console
    digest: ${digest}
  - name: k8s-incident-agent-runtime
    newName: k8s-incident-agent-runtime
    digest: ${digest}
`;
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

function createReleaseFixture(revision) {
  const files = new Map();
  const descriptor = (value, mediaType, extra = {}) => {
    const content = Buffer.from(JSON.stringify(value));
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    files.set(`blobs/sha256/${digest.slice(7)}`, content);
    return { mediaType, digest, size: content.byteLength, ...extra };
  };
  const manifests = ["amd64", "arm64"].map((architecture) => {
    const config = descriptor(
      {
        architecture,
        os: "linux",
        config: { Labels: { "org.opencontainers.image.revision": revision } },
      },
      "application/vnd.oci.image.config.v1+json",
    );
    return descriptor(
      {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config,
        layers: [],
      },
      "application/vnd.oci.image.manifest.v1+json",
      { platform: { os: "linux", architecture } },
    );
  });
  const top = descriptor(
    {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests,
    },
    "application/vnd.oci.image.index.v1+json",
  );
  files.set(
    "index.json",
    Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [top],
      }),
    ),
  );
  return { digest: top.digest, files };
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
  assert.equal(imagePull.scenarioVersion, 4);
  assert.equal(imagePull.requiredEvidence.includes("rollout_history"), true);
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
  assert.equal(result.artifact.schemaVersion, 2);
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
    code: "diagnosis_invalid",
    message: "The alert-driven diagnosis did not complete successfully",
  });
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

test("infrastructure recovery cleans a partially applied probe", async () => {
  const harness = createHarness();
  const imagePull = harness.dependencies.scenarios.find(
    (scenario) => scenario.scenarioId === "image-pull-backoff",
  );
  assert.ok(imagePull);
  harness.dependencies.scenarios = [
    ...harness.dependencies.scenarios.filter(
      (scenario) => scenario.scenarioId !== "image-pull-backoff",
    ),
    imagePull,
  ];
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
    { action: "run", profile: "kind-evaluation" },
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
      profile: "k3s-online",
      context: "k3s-k8s-incident-agent",
    },
    harness.dependencies,
  );

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
      profile: "k3s-online",
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
      { action: "online", profile: "k3s-online", context: "k3s-k8s-incident-agent" },
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
      { action: "online", profile: "k3s-online", context: "k3s-k8s-incident-agent" },
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
      profile: "k3s-online",
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
});

test("focused evaluation still requires the full catalog and matching release", async () => {
  const request = { action: "run", profile: "kind-evaluation", scenarioIds: ["pvc-binding-pending"] };
  const partial = createHarness();
  partial.dependencies.scenarios = partial.dependencies.scenarios.slice(0, 1);
  await assert.rejects(runEvaluationCommand(request, partial.dependencies), {
    code: "evaluation_catalog_invalid",
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
    ["online", "k3s-online", "--context", "k3s", "--scenario", "pvc-binding-pending"],
  ]) {
    const result = spawnSync(process.execPath, [
      path.join(REPOSITORY_ROOT, "scripts/evaluation.mjs"), ...args,
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^FAIL invalid_arguments /);
  }
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

test("evaluation accepts a clean digest-only lock commit", async () => {
  const lockRevision = "d".repeat(40);
  const harness = createHarness({ headRevision: lockRevision });
  harness.state.online = true;

  const result = await runEvaluationCommand(
    { action: "online", profile: "k3s-online", context: "fixed-k3s" },
    harness.dependencies,
  );

  assert.equal(result.artifact.status, "passed");
  assert.equal(result.artifact.release.revision, REVISION);
  assert.equal(result.artifact.release.lockRevision, lockRevision);
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

test("ImagePull diagnosis alone cannot satisfy the repair evaluation slice", async () => {
  const harness = createHarness({
    diagnosisCodeByScenario: {
      "image-pull-backoff": "image_pull_forbidden_invalid_registry",
    },
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
  const scenarios = loadEvaluationScenarioCatalog(REPOSITORY_ROOT);
  const headRevision = options.headRevision ?? REVISION;
  const releaseFixture = options.releaseRevision === undefined
    ? RELEASE_FIXTURE
    : createReleaseFixture(options.releaseRevision);
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
    readFile: async (filename) => {
      if (filename.endsWith("deploy/application/base/workloads/kustomization.yaml")) {
        return releaseLock(releaseFixture.digest);
      }
      const relative = filename.split(/(?:console|runtime)-oci\//).at(-1);
      const content = releaseFixture.files.get(relative);
      if (content === undefined) throw new Error(`Unexpected read: ${filename}`);
      return content;
    },
    verifyDeploymentStatus: async () => ({ deployments: "ready" }),
    runScenarioCommand: async (action, scenarioId) => {
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
    execute: async (command, args, executionOptions) => {
      if (command === "git") {
        assert.equal(executionOptions.cwd, REPOSITORY_ROOT);
        if (args[0] === "status") {
          return options.dirtyWorktree === true ? " M scripts/evaluation.mjs\n" : "";
        }
        if (args[0] === "rev-parse") return `${headRevision}\n`;
        if (args[0] === "merge-base") {
          if (args[2] === REVISION && args[3] === headRevision) return "";
          const error = new Error("not an ancestor");
          error.exitCode = 1;
          throw error;
        }
        if (args[0] === "diff") {
          if (options.releaseSourceDrift === true) return "src/app/page.tsx\n";
          return headRevision === REVISION
            ? ""
            : "deploy/application/base/workloads/kustomization.yaml\n" +
                "deploy/monitoring/overlays/kind/kustomization.yaml\n";
        }
        assert.fail(`Unexpected git command: ${args.join(" ")}`);
      }
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
  };
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
  if (suffix === "/runs") {
    return jsonResponse({
      schemaVersion: 5,
      items: [{ id: scenario.runId, kind: "diagnosis", operation: null, attempt: 1, status: "COMPLETED" }],
      nextCursor: null,
    });
  }
  if (suffix === "/monitoring/panels") {
    return jsonResponse({
      schemaVersion: 3,
      panels: [
        {
          panelId: `${scenario.scenarioId}-metric`,
          recommendedWindow: "15m",
          riskDirection: "higher_is_worse",
          signalRole: "trigger",
          thresholdDuration: "30s",
        },
      ],
    });
  }
  if (suffix.startsWith("/monitoring/panels/")) {
    if (isOtherIncident) return new Response(null, { status: 404 });
    const panelId = suffix.split("/").at(-1);
    const panelState = !state.prometheus
      ? "monitoring_unavailable"
      : !state.kubeStateMetrics || scenario.resolved
        ? "stale"
        : "ok";
    const observed = !new Set(["monitoring_unavailable", "no_data"]).has(
      panelState,
    );
    return jsonResponse({
      schemaVersion: 1,
      result: {
        panelId,
        window: url.searchParams.get("window"),
        state: panelState,
        threshold: 1,
        riskDirection: "higher_is_worse",
        currentValue: observed ? 1 : null,
        samples: observed ? [{ timestamp: "2026-09-05T00:00:00Z", value: 1 }] : [],
      },
      markers: [],
      markersTruncated: false,
    });
  }
  if (suffix === "/events" && headers.get("Last-Event-ID") === "0") {
    const diagnosisCode = diagnosisCodeFor(scenario, options);
    const repair = repairProjection(scenario, diagnosisCode, options);
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
      ["diagnosis.completed", eventData({
        diagnosisId: "50000000-0000-4000-8000-000000000001",
        outcome: "diagnosed",
        incidentStatus: "DIAGNOSED",
        runStatus: repair === null ? "COMPLETED" : "RUNNING",
      })],
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

  const evidence = scenario.requiredEvidence.map((kind, index) => ({
    id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    evidenceKind: kind,
    toolName: EVIDENCE_TOOL[kind],
  }));
  const diagnosisCode = diagnosisCodeFor(scenario, options);
  const repair = repairProjection(scenario, diagnosisCode, options, evidence);
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
      status: repair === null ? "DIAGNOSED" : "WAITING_APPROVAL",
      displayName: scenario.displayName,
    },
    selectedRun: {
      kind: "diagnosis",
      operation: null,
      id: state.online && state.rerunId && !options.onlineWrongRun ? state.rerunId : scenario.runId,
      attempt: state.online && state.rerunId ? 2 : 1,
      status: state.online && options.onlineRerunStatus === 409 ? "RUNNING" : "COMPLETED",
      requestSource: state.online && state.rerunId ? "operator" : "system",
      error: null,
    },
    eventPage: {
      items: scenario.resolved ? [{ event: "alert.resolved" }] : [],
      nextCursor: null,
    },
    evidence,
    diagnosis: {
      outcome: options.failingScenarioId === scenario.scenarioId ? "insufficient_evidence" : "diagnosed",
      summary: "A diagnostic explanation requiring independent semantic review.",
      rootCauses: [
        {
          code: diagnosisCode,
          statement: options.diagnosisStatement ?? "A diagnostic explanation requiring independent semantic review.",
          confidence: "high",
          evidenceIds:
            options.omitDiagnosisEvidenceLinks === true ? [] : evidence.map((item) => item.id),
        },
      ],
    },
    repair,
    alertSignal: {
      status: scenario.resolved ? "RESOLVED" : "FIRING",
    },
    eventCursor: repair === null ? "3" : "6",
  });
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
    diagnosisCode !== "image_invalid_registry" ||
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
