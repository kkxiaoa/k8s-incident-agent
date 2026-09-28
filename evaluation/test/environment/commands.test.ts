import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { DeploymentContractError, verifyDeploymentStatus } from "../../../scripts/deployment.mjs";
import { ScenarioCommandError } from "../../../scripts/scenario.mjs";
import { createReleaseFixture, gitFixtureEnvironment } from "../../../scripts/test-support/release-fixture.mjs";
import {
  adaptDeploymentExecutor,
  adaptScenarioExecutor,
  executeExternalCommand,
  executeKubectl,
  loadReleaseManifest,
  restartFixedPod,
  rotateWebhookCredential,
  runScenario,
  scaleMonitoringDeployment,
  type CommandFailure,
  type CommandOptions,
  type Execute,
} from "../../src/environment/commands.ts";
import { EvaluationError } from "../../src/shared/errors.ts";
import { COMMAND_TIMEOUT_MILLISECONDS } from "../../src/shared/wait.ts";
import { REPOSITORY_ROOT, temporaryDirectory } from "../support/fixtures.ts";

const coded = (code: string) => (error: unknown) => error instanceof EvaluationError && error.code === code;

function recording(answer: (args: readonly string[]) => string | { stdout: string; exitCode: number } = () => "") {
  const calls: Array<{ command: string; args: string[]; options: CommandOptions }> = [];
  const execute: Execute = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    return answer(args);
  };
  return { execute, calls };
}

test("the default executor returns stdout, carries exit codes and stdout on failure, and honours cwd and stdin", async (t) => {
  assert.equal(await executeExternalCommand(process.execPath, ["-e", "process.stdout.write('out')"]), "out");
  await assert.rejects(
    executeExternalCommand(process.execPath, ["-e", "process.stdout.write('partial'); process.exit(3)"]),
    (error: unknown) => {
      const failure = error as CommandFailure;
      assert.equal(failure.exitCode, 3);
      assert.equal(failure.stdout, "partial");
      return true;
    },
  );
  assert.equal(
    await executeExternalCommand(process.execPath, ["-e", "process.stdin.on('data', (d) => process.stdout.write(d))"], { stdin: "piped" }),
    "piped",
  );
  const directory = temporaryDirectory(t, "evaluation-command-");
  assert.equal(await executeExternalCommand(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: directory }), realpathSync(directory));
});

test("kubectl calls prefix the context, accept string or result-object answers and reject failures", async () => {
  const { execute, calls } = recording(() => "listed");
  assert.equal(await executeKubectl(execute, "ctx", ["get", "pods"], "manifest"), "listed");
  assert.deepEqual(calls[0], { command: "kubectl", args: ["--context", "ctx", "get", "pods"], options: { timeoutMilliseconds: COMMAND_TIMEOUT_MILLISECONDS, stdin: "manifest" } });
  assert.equal(await executeKubectl(recording(() => ({ stdout: "ok", exitCode: 0 })).execute, "ctx", ["x"]), "ok");
  await assert.rejects(executeKubectl(recording(() => ({ stdout: "no", exitCode: 1 })).execute, "ctx", ["x"]), coded("cluster_command_failed"));
});

test("monitoring deployments are scaled and only awaited when scaled back up", async () => {
  const { execute, calls } = recording();
  await scaleMonitoringDeployment("prometheus", 0, "ctx", execute);
  assert.deepEqual(calls.map((call) => call.args), [
    ["--context", "ctx", "scale", "deployment/prometheus", "--namespace", "k8s-incident-monitoring", "--replicas=0", "--timeout=120s"],
  ]);
  await scaleMonitoringDeployment("kube-state-metrics", 1, "ctx", execute);
  assert.deepEqual(calls.slice(1).map((call) => call.args), [
    ["--context", "ctx", "scale", "deployment/kube-state-metrics", "--namespace", "k8s-incident-monitoring", "--replicas=1", "--timeout=120s"],
    ["--context", "ctx", "rollout", "status", "deployment/kube-state-metrics", "--namespace", "k8s-incident-monitoring", "--timeout=300s"],
  ]);
});

test("a fixed Pod is restarted only when its selector resolves exactly one named Pod", async () => {
  const list = (items: unknown[]) => JSON.stringify({ apiVersion: "v1", kind: "List", items });
  const { execute, calls } = recording((args) => (args.includes("get") ? list([{ metadata: { name: "agent-runtime-pod" } }]) : ""));
  await restartFixedPod("k8s-incident-agent", "agent-runtime", "ctx", execute);
  assert.deepEqual(calls.map((call) => call.args), [
    ["--context", "ctx", "get", "pods", "--namespace", "k8s-incident-agent", "--selector", "app.kubernetes.io/name=agent-runtime", "--output=json"],
    ["--context", "ctx", "delete", "pod", "agent-runtime-pod", "--namespace", "k8s-incident-agent", "--wait=true", "--timeout=120s"],
    ["--context", "ctx", "rollout", "status", "deployment/agent-runtime", "--namespace", "k8s-incident-agent", "--timeout=300s"],
  ]);
  for (const answer of [list([]), list([{ metadata: { name: "a" } }, { metadata: { name: "b" } }]), list([{ metadata: {} }]), list([null]), JSON.stringify({ kind: "PodList", items: [{ metadata: { name: "a" } }] }), "not json"]) {
    const failing = recording(() => answer);
    await assert.rejects(restartFixedPod("k8s-incident-agent", "agent-runtime", "ctx", failing.execute), coded("upstream_contract_invalid"));
    assert.equal(failing.calls.length, 1);
  }
});

test("webhook credential rotation applies a fresh random token to both namespaces through stdin", async () => {
  const { execute, calls } = recording();
  await rotateWebhookCredential("ctx", execute);
  assert.equal(calls.length, 2);
  const manifests = calls.map((call) => JSON.parse(call.options.stdin as string));
  assert.deepEqual(manifests.map((manifest) => manifest.metadata.namespace), ["k8s-incident-agent", "k8s-incident-monitoring"]);
  const tokens = manifests.map((manifest) => Buffer.from(manifest.data.token, "base64").toString("utf8"));
  assert.match(tokens[0], /^[a-f0-9]{64}$/);
  assert.equal(tokens[0], tokens[1]);
  assert.ok(calls.every((call) => call.args.slice(2).join(" ") === "apply --filename=- --validate=strict --request-timeout=30s"));
  assert.deepEqual(manifests[0].metadata, { name: "alertmanager-webhook", namespace: "k8s-incident-agent", labels: { "app.kubernetes.io/part-of": "k8s-incident-agent" } });
  const again = recording();
  await rotateWebhookCredential("ctx", again.execute);
  assert.notEqual(JSON.parse(again.calls[0].options.stdin as string).data.token, manifests[0].data.token);
});

test("executor adapters translate between the string and result-object contracts without losing failures", async () => {
  const scenario = adaptScenarioExecutor(async (_command, _args, options) => (options.timeoutMilliseconds === 1 ? "text" : { stdout: "object", exitCode: 0 }));
  assert.equal(await scenario("kubectl", [], { timeoutMilliseconds: 1, maxBufferBytes: 1 }), "text");
  assert.equal(await scenario("kubectl", [], { timeoutMilliseconds: 2, maxBufferBytes: 1 }), "object");
  await assert.rejects(
    adaptScenarioExecutor(async () => ({ stdout: "denied", exitCode: 7 }))("kubectl", [], {}),
    (error: unknown) => (error as CommandFailure).exitCode === 7 && (error as CommandFailure).stdout === "denied",
  );

  const deployment = adaptDeploymentExecutor(async () => "text");
  assert.deepEqual(await deployment("kubectl", [], { timeoutMilliseconds: 1, maxBufferBytes: 1 }), { stdout: "text", exitCode: 0 });
  assert.deepEqual(await adaptDeploymentExecutor(async () => ({ stdout: "o", exitCode: 2 }))("kubectl", [], { timeoutMilliseconds: 1, maxBufferBytes: 1 }), { stdout: "o", exitCode: 2 });
  const denied = Object.assign(new Error("expected access denial"), { exitCode: 1, stdout: "no\n" });
  assert.deepEqual(await adaptDeploymentExecutor(async () => { throw denied; })("kubectl", ["auth", "can-i"], { timeoutMilliseconds: 1, maxBufferBytes: 1 }), { stdout: "no\n", exitCode: 1 });
  const crash = new Error("spawn failed");
  await assert.rejects(adaptDeploymentExecutor(async () => { throw crash; })("kubectl", [], { timeoutMilliseconds: 1, maxBufferBytes: 1 }), (error: unknown) => error === crash);
});

test("scenario runner failures keep the scenario script's code under the module's error class", async () => {
  const dependencies = { repositoryRoot: REPOSITORY_ROOT };
  assert.deepEqual(await runScenario(async () => ({ status: "applied" }), "apply", "crash-loop-backoff", dependencies), { status: "applied" });
  await assert.rejects(
    runScenario(async () => { throw new ScenarioCommandError("upstream_unavailable", "The healthy rollout did not complete"); }, "apply", "x", dependencies),
    (error: unknown) => {
      assert.ok(error instanceof EvaluationError);
      assert.equal(error.code, "upstream_unavailable");
      assert.equal(error.message, "The healthy rollout did not complete");
      return true;
    },
  );
  const other = new TypeError("boom");
  await assert.rejects(runScenario(async () => { throw other; }, "verify", "x", dependencies), (error: unknown) => error === other);
});

async function withFixtureGit<T>(directory: string, revision: string, dirty: boolean, run: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = gitFixtureEnvironment(directory, revision, dirty).PATH;
  try {
    return await run();
  } finally {
    process.env.PATH = previous;
  }
}

test("the release loader returns the verified manifest and carries release failures under their own codes", async (t: TestContext) => {
  const revision = "c".repeat(40);
  const clean = temporaryDirectory(t, "evaluation-release-");
  const fixture = createReleaseFixture(clean, revision);
  const manifest = await withFixtureGit(clean, revision, false, () => loadReleaseManifest(fixture.release, clean));
  assert.deepEqual(manifest, fixture.manifest);

  await assert.rejects(withFixtureGit(clean, revision, true, () => loadReleaseManifest(fixture.release, clean)), coded("release_worktree_dirty"));
  await assert.rejects(withFixtureGit(clean, revision, false, () => loadReleaseManifest(path.join(clean, "manifest.json"), clean)), coded("release_contract_invalid"));
  const other = temporaryDirectory(t, "evaluation-release-other-");
  await assert.rejects(withFixtureGit(clean, revision, false, () => loadReleaseManifest(path.join(other, "release.json"), clean)), coded("release_artifact_invalid"));
  writeFileSync(fixture.release, JSON.stringify({ ...fixture.manifest, sourceRevision: "d".repeat(40) }));
  await assert.rejects(withFixtureGit(clean, revision, false, () => loadReleaseManifest(fixture.release, clean)), coded("release_revision_mismatch"));
});

test("the deployment status gate rejects unknown profiles, option-shaped contexts and failing commands with its own error class", async (t) => {
  const fixture = createReleaseFixture(temporaryDirectory(t, "evaluation-deployment-"), "a".repeat(40));
  const deploymentError = (code: string) => (error: unknown) => {
    assert.ok(error instanceof DeploymentContractError);
    assert.equal(error.name, "DeploymentContractError");
    assert.equal(error.code, code);
    return true;
  };
  await assert.rejects(verifyDeploymentStatus("nope", "ctx", { repositoryRoot: REPOSITORY_ROOT, release: fixture.manifest }), deploymentError("usage_invalid"));
  await assert.rejects(verifyDeploymentStatus("k3s-evaluation", "-bad", { repositoryRoot: REPOSITORY_ROOT, release: fixture.manifest }), deploymentError("invalid_argument"));
  const commands: string[][] = [];
  await assert.rejects(
    verifyDeploymentStatus("k3s-evaluation", "ctx", {
      repositoryRoot: REPOSITORY_ROOT,
      release: fixture.manifest,
      execute: async (command, args) => {
        commands.push([command, ...args]);
        return { stdout: "", exitCode: 1 };
      },
    }),
    deploymentError("external_command_failed"),
  );
  assert.deepEqual(commands, [["kubectl", "version", "--client", "--output=json"]]);
});
