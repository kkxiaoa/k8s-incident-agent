import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { loadConfig } from "./deploy-gateway.mjs";
import { deploymentRequest, interpretResult, resultSummary, runDeployment, selectDeployment, sshArguments, takeSecrets }
  from "./deploy-dispatch.mjs";
import { createReleaseFixture } from "./test-support/release-fixture.mjs";

const repository = "kkxiaoa/k8s-incident-agent";
const revision = "a".repeat(40);
const workflowSha = "c".repeat(40);
const previousRuntimeImage = `ghcr.io/kkxiaoa/k8s-incident-agent-runtime@sha256:${"b".repeat(64)}`;
let directory;
let manifest;
let selection;

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "deploy-dispatch-test-"));
  manifest = createReleaseFixture(path.join(directory, "bundle"), revision).manifest;
  selection = { version: "v0.2.0", profile: "k3s-public", sourceRevision: revision, images: manifest.images };
});

after(async () => { await rm(directory, { recursive: true, force: true }); });

// Reduced official REST response shapes for a protected deploy Environment and one published release.
function github(t, overrides = {}) {
  const state = {
    environment: { id: 7, name: "deploy", protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 1 } }] }],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, can_admins_bypass: false },
    branches: { total_count: 1, branch_policies: [{ id: 3, name: "main", type: "branch" }] },
    release: { id: 9, draft: false, prerelease: false, tag_name: "v0.2.0", target_commitish: revision },
    manifest,
    approvals: [{ state: "approved", environments: [{ id: 7, name: "deploy" }] }],
    run: { path: ".github/workflows/deploy.yml", event: "workflow_dispatch", head_branch: "main", head_sha: workflowSha, run_attempt: 1,
      repository: { full_name: repository } },
    ...overrides,
  };
  const assets = () => [["candidate.tar.gz", Buffer.from("candidate")], ["SHA256SUMS", Buffer.from("sums")],
    ["release.json", Buffer.from(JSON.stringify(state.manifest))]].map(([name, bytes], index) => ({ id: 70 + index, name, bytes,
    state: "uploaded", digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.hostname, "api.github.com");
    const endpoint = url.pathname.replace(`/repos/${repository}`, "");
    const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (endpoint === "/environments/deploy") return json(state.environment);
    if (endpoint === "/environments/deploy/deployment-branch-policies") return json(state.branches);
    if (endpoint === "/actions/runs/22") return json(state.run);
    if (endpoint === "/actions/runs/22/approvals") return json(state.approvals);
    if (endpoint === "/releases/tags/v0.2.0" || endpoint === "/releases/9") return json(state.release);
    if (endpoint === "/git/ref/tags/v0.2.0") return json({ object: { type: "commit", sha: state.release.target_commitish } });
    if (endpoint === "/releases/9/assets") return json(assets().map(({ id, name, state: assetState, digest }) => ({ id, name, state: assetState, digest })));
    const asset = assets().find(item => endpoint === `/releases/assets/${item.id}`);
    assert.ok(asset?.name === "release.json" && options.headers.Accept === "application/octet-stream", endpoint);
    return new Response(asset.bytes);
  };
  return state;
}

function dispatch(t, overrides = {}) {
  const environment = { GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ATTEMPT: "1", GITHUB_RUN_ID: "22", GITHUB_SHA: workflowSha, ...overrides };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
}

const secrets = {
  DEPLOY_SSH_PRIVATE_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\r\nb3BlbnNzaC1rZXktdjEAAAAA\r\n-----END OPENSSH PRIVATE KEY-----",
  DEPLOY_SSH_KNOWN_HOSTS: "gateway.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample",
  DEPLOY_SSH_HOST: "gateway.example.test",
  DEPLOY_SSH_USER: "deploy-fixture",
};
const deployed = { status: "deployed", version: "v0.2.0", profile: "k3s-public", sourceRevision: revision, previousRuntimeImage,
  backup: "20260926T071500Z", alembicHead: "20260919_0013" };

async function workRoot(t) {
  const folder = await mkdtemp(path.join(directory, "run-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

// An ssh stand-in that records what it was given, including the files' state while it runs.
function fakeSsh(reply) {
  const calls = [];
  const ssh = async (args, input) => {
    const option = name => args.find(arg => arg.startsWith(`${name}=`)).slice(name.length + 1);
    const keyFile = option("IdentityFile");
    const known = option("UserKnownHostsFile");
    calls.push({ args, input, keyMode: (await stat(keyFile)).mode & 0o777, knownMode: (await stat(known)).mode & 0o777,
      directoryMode: (await stat(path.dirname(keyFile))).mode & 0o777, keyFile });
    return reply;
  };
  return { ssh, calls };
}

test("the request is one bounded line with a stable version and a gateway profile", () => {
  assert.equal(deploymentRequest("v0.2.0", "k3s-public"), '{"version":"v0.2.0","profile":"k3s-public"}\n');
  for (const [version, profile] of [["latest", "k3s-public"], ["v0.2.0-rc.1", "k3s-public"], ["v0.2.0", "k3s-online"], ["v0.2.0", "kind-evaluation"]]) {
    assert.throws(() => deploymentRequest(version, profile), /stable published version/, `${version} ${profile}`);
  }
});

test("the workflow offers exactly the profiles the runner request and the host gateway accept", async t => {
  const workflow = load(await readFile(fileURLToPath(new URL("../.github/workflows/deploy.yml", import.meta.url)), "utf8"));
  const offered = workflow.on.workflow_dispatch.inputs.profile.options;
  assert.deepEqual(offered, ["k3s-evaluation", "k3s-public"]);
  for (const profile of offered) assert.doesNotThrow(() => deploymentRequest("v0.2.0", profile));
  const folder = await workRoot(t);
  const file = path.join(folder, "gateway.json");
  const config = profiles => ({ schemaVersion: 2, profiles, kubeconfig: "/var/lib/deploy/kubeconfig", context: "deploy",
    workRoot: "/var/lib/deploy/work", proxy: null });
  await writeFile(file, JSON.stringify(config(offered)));
  assert.deepEqual((await loadConfig(file)).profiles, offered);
  await writeFile(file, JSON.stringify(config(["k3s-online"])));
  await assert.rejects(loadConfig(file), { code: "config_invalid" });
});

test("selection binds a published release before approval and refuses an unprotected Environment", async t => {
  github(t);
  const bound = await selectDeployment("v0.2.0", "k3s-public", await workRoot(t));
  assert.deepEqual(bound, selection);
  for (const [name, overrides, message] of [
    ["no required reviewers", { environment: { id: 7, name: "deploy", protection_rules: [],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } } }, /required reviewers/],
    ["every branch allowed", { environment: { id: 7, name: "deploy", protection_rules: [{ type: "required_reviewers", reviewers: [{}] }],
      deployment_branch_policy: null, can_admins_bypass: false } }, /main branch/],
    ["another branch allowed", { branches: { total_count: 2, branch_policies: [{ id: 3, name: "main", type: "branch" },
      { id: 4, name: "release/*", type: "branch" }] } }, /main branch/],
    ["administrator bypass allowed", { environment: { id: 7, name: "deploy", can_admins_bypass: true,
      protection_rules: [{ type: "required_reviewers", reviewers: [{}] }],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } } }, /administrator bypass/],
    ["an Environment that does not report administrator bypass", { environment: { id: 7, name: "deploy",
      protection_rules: [{ type: "required_reviewers", reviewers: [{}] }],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } } }, /administrator bypass/],
    ["a draft release", { release: { id: 9, draft: true, prerelease: false, tag_name: "v0.2.0", target_commitish: revision } }, /published stable/],
  ]) {
    github(t, overrides);
    await assert.rejects(selectDeployment("v0.2.0", "k3s-public", await workRoot(t)), message, name);
  }
});

test("an approved dispatch sends the bound request over a pinned, non-interactive SSH session and removes the key", async t => {
  github(t);
  dispatch(t);
  const { ssh, calls } = fakeSsh({ exitCode: 0, stdout: `${JSON.stringify(deployed)}\n`, started: true });
  const outcome = await runDeployment(selection, secrets, { workRoot: await workRoot(t), ssh });
  assert.deepEqual(outcome, { ok: true, result: deployed });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.input, '{"version":"v0.2.0","profile":"k3s-public"}\n');
  assert.deepEqual([call.keyMode, call.knownMode, call.directoryMode], [0o600, 0o600, 0o700]);
  assert.deepEqual(call.args, sshArguments(call.keyFile, path.join(path.dirname(call.keyFile), "known_hosts"),
    "deploy-fixture", "gateway.example.test"));
  assert.deepEqual(call.args.slice(0, 3), ["-F", "/dev/null", "-T"]);
  for (const option of ["BatchMode=yes", "IdentitiesOnly=yes", "StrictHostKeyChecking=yes", "GlobalKnownHostsFile=/dev/null",
    "UpdateHostKeys=no", "ForwardAgent=no", "ForwardX11=no", "RequestTTY=no", "ServerAliveInterval=30"]) {
    assert.ok(call.args.includes(option), option);
  }
  assert.deepEqual(call.args.slice(-2), ["--", "deploy-fixture@gateway.example.test"]);
  await assert.rejects(stat(call.keyFile), { code: "ENOENT" });
  assert.match(resultSummary(selection, outcome), /Replaced Runtime image: `ghcr\.io\/kkxiaoa\/k8s-incident-agent-runtime@sha256:b{64}`/);
});

for (const [name, change, run, message] of [
  ["no recorded approval", state => { state.approvals = []; }, {}, /human approval/],
  ["a rerun of an old dispatch", () => {}, { GITHUB_RUN_ATTEMPT: "2" }, /fresh/],
  ["another workflow's run", state => { state.run = { ...state.run, path: ".github/workflows/release.yml" }; }, {}, /Unexpected workflow source/],
  // The tag was moved and the release republished from another commit while the run waited.
  ["a release that changed while awaiting approval", state => {
    state.release = { ...state.release, target_commitish: "d".repeat(40) };
    state.manifest = { ...manifest, sourceRevision: "d".repeat(40) };
  }, {}, /changed while awaiting approval/],
  // Same source, but the published manifest now names other images than the reviewer saw.
  ["image digests replaced while awaiting approval", state => {
    state.manifest = { ...manifest, images: { ...manifest.images,
      runtime: { ...manifest.images.runtime, indexDigest: `sha256:${"e".repeat(64)}` } } };
  }, {}, /changed while awaiting approval/],
  ["administrator bypass turned on after selection", state => {
    state.environment = { ...state.environment, can_admins_bypass: true };
  }, {}, /administrator bypass/],
  ["a branch policy widened after selection", state => {
    state.branches = { total_count: 2, branch_policies: [{ id: 3, name: "main", type: "branch" }, { id: 4, name: "*", type: "branch" }] };
  }, {}, /main branch/],
]) {
  test(`${name} stops before any SSH connection`, async t => {
    const state = github(t);
    dispatch(t, run);
    change(state);
    const { ssh, calls } = fakeSsh({ exitCode: 0, stdout: `${JSON.stringify(deployed)}\n`, started: true });
    await assert.rejects(runDeployment(selection, secrets, { workRoot: await workRoot(t), ssh }), message);
    assert.equal(calls.length, 0);
  });
}

test("malformed secrets are named without echoing their values", async t => {
  github(t);
  dispatch(t);
  for (const [key, value] of [["DEPLOY_SSH_PRIVATE_KEY", "not-a-key"], ["DEPLOY_SSH_KNOWN_HOSTS", "@revoked * ssh-ed25519 AAAA"],
    ["DEPLOY_SSH_HOST", "-oProxyCommand=sh"], ["DEPLOY_SSH_USER", "root; id"]]) {
    const { ssh, calls } = fakeSsh({ exitCode: 0, stdout: "", started: true });
    const outcome = runDeployment(selection, { ...secrets, [key]: value }, { workRoot: await workRoot(t), ssh });
    await assert.rejects(outcome, error => error.message.startsWith(key) && !error.message.includes(value));
    assert.equal(calls.length, 0);
  }
});

test("gateway results are held to the approved selection", () => {
  const failed = { status: "failed", code: "command_failed", phase: "rollout", message: "kubectl rollout failed", previousRuntimeImage,
    backup: "20260926T071500Z", alembicHead: "20260919_0013" };
  const outcome = interpretResult({ exitCode: 1, stdout: `phase noise\n${JSON.stringify(failed)}\n` }, selection);
  assert.deepEqual(outcome, { ok: false, result: failed });
  const summary = resultSummary(selection, outcome);
  assert.match(summary, /failed in phase `rollout`: `command_failed` kubectl rollout failed/);
  assert.match(summary, /Backup: `20260926T071500Z`/);
  assert.match(resultSummary(selection, { ok: false, result: { status: "failed", code: "release_unverified", phase: "release", message: "x" } }),
    /^[^\n]*\n$/);
  for (const change of [{ version: "v0.3.0" }, { profile: "k3s-evaluation" }, { sourceRevision: "d".repeat(40) }]) {
    const mismatch = interpretResult({ exitCode: 0, stdout: JSON.stringify({ ...deployed, ...change }) }, selection);
    assert.equal(mismatch.ok, false, JSON.stringify(change));
    assert.match(mismatch.problem, /other than the approved one/);
    // What was actually deployed stays in the summary for the rollback decision.
    assert.match(resultSummary(selection, mismatch), /Replaced Runtime image: `ghcr/);
  }
  assert.match(interpretResult({ exitCode: 1, stdout: JSON.stringify(deployed) }, selection).problem, /did not end cleanly/);
  assert.throws(() => interpretResult({ exitCode: 255, stdout: "" }, selection), /reach the deployment gateway/);
  assert.throws(() => interpretResult({ exitCode: 255, stdout: "", gatewayStarted: true }, selection), /check the cluster/);
  assert.throws(() => interpretResult({ exitCode: null, stdout: "partial" }, selection), /no readable result/);
  assert.throws(() => interpretResult({ exitCode: null, stdout: "", started: false }, selection), /start ssh/);
});

// Puts a stand-in ssh first on PATH; its body runs once the request has arrived on stdin as `input`.
async function fakeSshOnPath(t, body) {
  const bin = await mkdtemp(path.join(directory, "bin-"));
  const script = path.join(bin, "ssh");
  await writeFile(script, `#!/usr/bin/env node
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
${body}
});
`);
  await chmod(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
}

test("the credentials leave the environment once read", () => {
  const environment = { ...secrets, GH_TOKEN: "test-only-token", PATH: "/usr/bin" };
  assert.deepEqual(takeSecrets(environment), secrets);
  assert.deepEqual(environment, { GH_TOKEN: "test-only-token", PATH: "/usr/bin" });
});

test("the real ssh process path passes only the gateway's phase lines to the log", async t => {
  github(t);
  dispatch(t);
  // Present in the job's environment, yet ssh must not inherit them.
  const inherited = { GH_TOKEN: "test-only-token", DEPLOY_SSH_PRIVATE_KEY: secrets.DEPLOY_SSH_PRIVATE_KEY };
  const previous = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  await fakeSshOnPath(t, `  process.stderr.write("phase release\\nssh: connect to host 192.0.2.7 port 22: warning\\nphase rollout\\n");
  process.stdout.write(JSON.stringify({ ...${JSON.stringify(deployed)}, echoed: input.trim(), environment: Object.keys(process.env) }) + "\\n");`);
  const progress = [];
  const root = await workRoot(t);
  const outcome = await runDeployment(selection, secrets, { workRoot: root, onProgress: line => progress.push(line) });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.echoed, '{"version":"v0.2.0","profile":"k3s-public"}');
  // macOS adds __CF_USER_TEXT_ENCODING to every child process; nothing else may reach ssh.
  assert.deepEqual(outcome.result.environment.filter(name => name !== "PATH" && name !== "__CF_USER_TEXT_ENCODING"), []);
  assert.deepEqual(progress, ["phase release", "phase rollout"]);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith("ssh-")), []);
});

// ssh exits 255 both when it never connects and when an open session drops; only the second may leave a deployment running.
for (const [name, body, message] of [
  ["a session that drops after the gateway started", '  process.stderr.write("phase release\\n");\n  process.exitCode = 255;', /check the cluster/],
  ["a host that cannot be reached", '  process.stderr.write("ssh: connect to host 192.0.2.7 port 22: Connection refused\\n");\n  process.exitCode = 255;',
    /reach the deployment gateway/],
]) {
  test(`${name} is reported as such through the real ssh process`, async t => {
    github(t);
    dispatch(t);
    await fakeSshOnPath(t, body);
    await assert.rejects(runDeployment(selection, secrets, { workRoot: await workRoot(t) }), message);
  });
}
