import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
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
      (scenario) =>
        scenario.expectedRootCauses.length > 0 &&
        scenario.requiredEvidence.length > 0,
    ),
    true,
  );
});

test("catalog evaluation records independent passing results and redacted evidence", async () => {
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

  assert.equal(result.artifact.status, "passed");
  assert.equal(result.artifact.scenarios.length, 7);
  assert.equal(result.artifact.families.length, 5);
  assert.equal(
    result.artifact.scenarios.every((scenario) => scenario.status === "passed"),
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
  assert.equal(alertQueries.length > 0, true);
  assert.equal(alertQueries.every((query) => !query.includes("cluster=")), true);

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
    result.artifact.scenarios.filter((scenario) => scenario.status === "passed")
      .length,
    6,
  );
  const failed = result.artifact.scenarios.find(
    (scenario) => scenario.scenarioId === "image-pull-backoff",
  );
  assert.deepEqual(failed.failure, {
    code: "diagnosis_root_cause_mismatch",
    message: "Diagnosis did not identify an expected root cause",
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
    "passed",
  );
  assert.equal(
    result.artifact.scenarios.find(
      (scenario) => scenario.scenarioId === "service-selector-mismatch",
    )?.status,
    "failed",
  );
  assert.equal(result.artifact.monitoring.infrastructure.status, "passed");
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
    result.artifact.scenarios.filter((scenario) => scenario.status === "passed")
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
    manualRuntimeRoutesAbsent: true,
    manualConsoleControlsAbsent: true,
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
  assert.equal(result.artifact.status, "passed");
});

test("invalid CLI arguments fail before any evaluation side effect", () => {
  const result = spawnSync(process.execPath, [
    path.join(REPOSITORY_ROOT, "scripts/evaluation.mjs"),
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL invalid_arguments /);
});

test("catalog evaluation consumes retained Incident history through pagination", async () => {
  const harness = createHarness({ paginatedIncidents: true });

  const result = await runEvaluationCommand(
    { action: "run", profile: "kind-evaluation" },
    harness.dependencies,
  );

  assert.equal(result.artifact.status, "passed");
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

test("diagnosis requires expected root causes to link all required Evidence", async () => {
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

test("diagnosis accepts Evidence-backed codes in approved root cause namespaces", async (t) => {
  for (const [imageCode, pvcCode] of [
    ["image_pull_failed_dns_resolution", "no_provisioner_storageclass_no_matching_pv"],
    ["invalid_image_registry_dns", "unmatched_no_provisioner_plugin"],
    ["image_registry_dns_resolution_failure", "no_matching_provisioner_plugin"],
    ["image_pull_forbidden_invalid_registry", "invalid_provisioner_no_volume_plugin"],
    ["image_pull_forbidden_unreachable_registry", "provisioner_not_available"],
  ]) {
    await t.test(`${imageCode} / ${pvcCode}`, async () => {
      const harness = createHarness({
        diagnosisCodeByScenario: {
          "image-pull-backoff": imageCode,
          "pvc-binding-pending": pvcCode,
        },
      });

      const result = await runEvaluationCommand(
        { action: "run", profile: "kind-evaluation" },
        harness.dependencies,
      );

      assert.equal(result.artifact.status, "passed");
    });
  }
});

test("diagnosis rejects codes outside approved root cause namespaces", async (t) => {
  for (const [scenarioId, diagnosisCode] of [
    ["image-pull-backoff", "image_pull_registry_credentials_failure"],
    ["image-pull-backoff", "image_reference_unavailable_or_unauthenticated"],
    [
      "image-pull-backoff",
      "image_reference_unavailable_due_to_registry_credentials_failure",
    ],
    ["pvc-binding-pending", "pvc_storageclass_not_found"],
  ]) {
    await t.test(scenarioId, async () => {
      const harness = createHarness({
        diagnosisCodeByScenario: { [scenarioId]: diagnosisCode },
      });

      const result = await runEvaluationCommand(
        { action: "run", profile: "kind-evaluation" },
        harness.dependencies,
      );

      const scenario = result.artifact.scenarios.find(
        (candidate) => candidate.scenarioId === scenarioId,
      );
      assert.equal(scenario.status, "failed");
      assert.equal(scenario.failure.code, "diagnosis_root_cause_mismatch");
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
    online: false,
    prometheus: true,
    kubeStateMetrics: true,
    watchdogLastReceivedAt: "2026-09-05T00:00:00.000Z",
  };

  const dependencies = {
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
  const active = [...scenarioById.values()].find((scenario) => scenario.applied);

  if (url.port === "13000") {
    if (url.pathname === "/api/healthz") return new Response(null, { status: 204 });
    if (url.pathname === "/") {
      return textResponse(state.online ? "K8s Incident Agent" : "离线评估入口");
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
  if (url.pathname === "/healthz") return jsonResponse({ status: "ok" });
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
  if (
    url.pathname === "/api/v1/incidents/not-a-uuid/runs" &&
    method === "POST"
  ) {
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
          .filter((scenario) => scenario.applied || scenario.resolved)
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
        schemaVersion: 3,
        items: cursor === null ? items.slice(0, 100) : items.slice(100),
        nextCursor: cursor === null ? "next-page" : null,
      });
    }
    return jsonResponse({
      schemaVersion: 3,
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
  if (suffix === "/runs") {
    return jsonResponse({
      schemaVersion: 3,
      items: [{ id: scenario.runId, attempt: 1, status: "COMPLETED" }],
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
  if (suffix === "/events" && init?.headers?.["Last-Event-ID"] === "0") {
    const eventData = (event) =>
      JSON.stringify({
        schemaVersion: 3,
        incidentId: options.invalidSseContract === true
          ? "90000000-0000-4000-8000-000000000001"
          : scenario.incidentId,
        runId: scenario.runId,
        event,
      });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `id: 1\nevent: incident.created\ndata: ${eventData("incident.created")}\n\n` +
                `id: 2\nevent: run.started\ndata: ${eventData("run.started")}\n\n` +
                `id: 3\nevent: diagnosis.completed\ndata: ${eventData("diagnosis.completed")}\n\n`,
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
  return jsonResponse({
    schemaVersion: 3,
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
      status: "DIAGNOSED",
      displayName: scenario.displayName,
    },
    selectedRun: {
      id: scenario.runId,
      attempt: 1,
      status: "COMPLETED",
      error: null,
    },
    eventPage: {
      items: scenario.resolved ? [{ event: "alert.resolved" }] : [],
      nextCursor: null,
    },
    evidence,
    diagnosis: {
      outcome: "diagnosed",
      rootCauses: [
        {
          code:
            options.diagnosisCodeByScenario?.[scenario.scenarioId] ??
            (options.failingScenarioId === scenario.scenarioId
              ? "unexpected_root_cause"
              : representativeRootCauseCode(scenario.expectedRootCauses[0])),
          evidenceIds:
            options.omitDiagnosisEvidenceLinks === true ? [] : evidence.map((item) => item.id),
        },
      ],
    },
    alertSignal: {
      status: scenario.resolved ? "RESOLVED" : "FIRING",
    },
    eventCursor: "3",
  });
}

function representativeRootCauseCode(expected) {
  return expected.includes("*")
    ? expected.replaceAll("*", "observed_") + "failure"
    : expected;
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

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(value) {
  return new Response(value, { status: 200 });
}
