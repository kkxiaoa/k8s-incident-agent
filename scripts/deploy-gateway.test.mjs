import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { loadAll } from "js-yaml";
import { backupJob, containsDeclared, deploy, loadConfig, parseRequest, planScope, prefetchJob } from "./deploy-gateway.mjs";
import { executeExternalCommand, renderSourceProfile } from "./deployment.mjs";
import { createReleaseFixture } from "./test-support/release-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gateway = path.join(root, "scripts", "deploy-gateway.mjs");
const revision = "a".repeat(40);
const previousRuntimeImage = `ghcr.io/kkxiaoa/k8s-incident-agent-runtime@sha256:${"b".repeat(64)}`;
let directory;
let manifest;
let pins;
const renders = {};

// Answers the version checks with the pinned baseline and renders with the real Kustomize.
function pinnedCluster(serverVersion = pins.k3s) {
  return async (program, args, options) => {
    if (args.includes("version")) {
      return { exitCode: 0, stdout: JSON.stringify(args.includes("--client")
        ? { clientVersion: { gitVersion: pins.kubectl } } : { serverVersion: { gitVersion: serverVersion } }) };
    }
    return executeExternalCommand(program, args, options);
  };
}

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "deploy-gateway-test-"));
  manifest = createReleaseFixture(path.join(directory, "bundle"), revision).manifest;
  pins = { kubectl: JSON.parse(await readFile(path.join(root, "deploy/kind/versions.json"), "utf8")).kubectl,
    k3s: JSON.parse(await readFile(path.join(root, "deploy/application/versions.json"), "utf8")).k3s };
  for (const profile of ["k3s-public", "k3s-evaluation"]) {
    renders[profile] = await renderSourceProfile(root, manifest, profile, "deploy", pinnedCluster());
  }
});

after(async () => { await rm(directory, { recursive: true, force: true }); });

const clone = resources => new Map([...resources].map(([key, value]) => [key, structuredClone(value)]));

async function config(t, overrides = {}) {
  const workRoot = await mkdtemp(path.join(directory, "work-"));
  t.after(() => rm(workRoot, { recursive: true, force: true }));
  return { schemaVersion: 1, profiles: ["k3s-public", "k3s-evaluation"], kubeconfig: "/var/lib/deploy/kubeconfig", context: "deploy",
    workRoot, registryProxy: "http://proxy.example.test:3128", ...overrides };
}

test("the caller contract is one bounded line with a stable version and an allowed profile", () => {
  assert.deepEqual(parseRequest('{"version":"v0.2.0","profile":"k3s-public"}\n', {}, ["k3s-public"]),
    { version: "v0.2.0", profile: "k3s-public" });
  for (const [input, environment] of [
    ['{"version":"v0.2.0","profile":"k3s-public"}', { SSH_ORIGINAL_COMMAND: "sh -c id" }],
    ['{"version":"v0.2.0","profile":"k3s-online"}', {}],
    ['{"version":"latest","profile":"k3s-public"}', {}],
    ['{"version":"v0.2.0-rc.1","profile":"k3s-public"}', {}],
    ['{"version":"v0.2.0","profile":"k3s-public","manifest":"/tmp/x.yaml"}', {}],
    ['{"version":"v0.2.0","profile":"k3s-public"}\n{"version":"v0.2.1","profile":"k3s-public"}', {}],
    [`{"version":"v0.2.0","profile":"k3s-public","pad":"${"x".repeat(300)}"}`, {}],
    ["not json", {}],
  ]) {
    assert.throws(() => parseRequest(input, environment, ["k3s-public"]), { code: "request_invalid" }, input.slice(0, 40));
  }
});

test("host configuration is a closed contract that the caller cannot redirect", async t => {
  const base = await config(t);
  const file = path.join(base.workRoot, "gateway.json");
  await writeFile(file, JSON.stringify(base));
  assert.deepEqual(await loadConfig(file), base);
  for (const change of [
    { profiles: ["kind-evaluation"] },
    { profiles: ["k3s-online"] },
    { workRoot: "relative/work" },
    { kubeconfig: "/var/lib/deploy/../root/.kube/config" },
    { registryProxy: "http://user:secret@proxy.example.test:3128" },
    { registryProxy: "socks5://proxy.example.test:1080" },
    { context: "deploy --token=x" },
    { extra: true },
  ]) {
    await writeFile(file, JSON.stringify({ ...base, ...change }));
    await assert.rejects(loadConfig(file), { code: "config_invalid" }, JSON.stringify(change));
  }
  const link = path.join(base.workRoot, "linked.json");
  await writeFile(file, JSON.stringify(base));
  await symlink(file, link);
  await assert.rejects(loadConfig(link), { code: "config_invalid" });
});

test("declared labels and claim specs must hold while server defaults may add more", () => {
  const claim = { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } };
  assert.ok(containsDeclared(claim, { ...claim, volumeName: "pvc-1", volumeMode: "Filesystem" }));
  assert.ok(!containsDeclared(claim, { ...claim, accessModes: ["ReadWriteMany"] }));
  assert.ok(containsDeclared({ team: "incident" }, { team: "incident", "kubernetes.io/metadata.name": "k8s-incident-agent" }));
  assert.ok(!containsDeclared({ team: "incident" }, { "kubernetes.io/metadata.name": "k8s-incident-agent" }));
});

test("the public render splits into bootstrap-owned objects and daily updates", () => {
  const { daily, bootstrap } = planScope(clone(renders["k3s-public"]));
  const kinds = documents => [...new Set(documents.map(document => document.kind))].sort();
  assert.deepEqual(kinds(daily), ["ConfigMap", "Deployment", "Ingress", "NetworkPolicy", "Service"]);
  assert.deepEqual(kinds(bootstrap), ["ClusterRole", "ClusterRoleBinding", "Namespace", "PersistentVolumeClaim", "Role", "RoleBinding",
    "ServiceAccount", "ValidatingAdmissionPolicy", "ValidatingAdmissionPolicyBinding"]);
  assert.ok(daily.every(document => ["k8s-incident-agent", "k8s-incident-monitoring"].includes(document.metadata.namespace)));
});

for (const [name, mutate, code] of [
  ["a Secret", resources => resources.set("Secret/k8s-incident-agent/x", { apiVersion: "v1", kind: "Secret",
    metadata: { name: "x", namespace: "k8s-incident-agent" } }), "bootstrap_required"],
  ["a Pod outside a controller", resources => resources.set("Pod/k8s-incident-agent/x", { apiVersion: "v1", kind: "Pod",
    metadata: { name: "x", namespace: "k8s-incident-agent" }, spec: {} }), "bootstrap_required"],
  ["a workload outside the project namespaces", resources => {
    const deployment = structuredClone(resources.get("Deployment/k8s-incident-agent/incident-console"));
    deployment.metadata.namespace = "k8s-incident-scenarios";
    resources.set("Deployment/k8s-incident-scenarios/incident-console", deployment);
  }, "bootstrap_required"],
  ["the installer's approval", resources => resources.set("ConfigMap/k8s-incident-agent/agent-runtime-public-approval", { apiVersion: "v1",
    kind: "ConfigMap", metadata: { name: "agent-runtime-public-approval", namespace: "k8s-incident-agent" }, data: { PUBLIC_DEMO_DATA_APPROVED: "true" } }),
  "bootstrap_required"],
  ["a hostPath volume", resources => resources.get("Deployment/k8s-incident-agent/agent-runtime").spec.template.spec.volumes
    .push({ name: "host", hostPath: { path: "/" } }), "workload_forbidden"],
  ["a privileged container", resources => { resources.get("Deployment/k8s-incident-agent/incident-console").spec.template.spec.containers[0]
    .securityContext = { privileged: true }; }, "workload_forbidden"],
  ["host networking", resources => { resources.get("Deployment/k8s-incident-monitoring/prometheus").spec.template.spec.hostNetwork = true; },
    "workload_forbidden"],
  ["the host PID namespace", resources => { resources.get("Deployment/k8s-incident-monitoring/prometheus").spec.template.spec.hostPID = true; },
    "workload_forbidden"],
  ["the host IPC namespace", resources => { resources.get("Deployment/k8s-incident-monitoring/prometheus").spec.template.spec.hostIPC = true; },
    "workload_forbidden"],
  ["a host port", resources => { resources.get("Deployment/k8s-incident-agent/incident-console").spec.template.spec.containers[0]
    .ports = [{ containerPort: 3000, hostPort: 443 }]; }, "workload_forbidden"],
  ["an added capability", resources => { resources.get("Deployment/k8s-incident-agent/incident-console").spec.template.spec.containers[0]
    .securityContext = { capabilities: { add: ["NET_ADMIN"] } }; }, "workload_forbidden"],
  ["a foreign ServiceAccount", resources => { resources.get("Deployment/k8s-incident-agent/incident-console").spec.template.spec
    .serviceAccountName = "agent-runtime-admin"; }, "workload_forbidden"],
  ["a literal public data approval", resources => resources.get("Deployment/k8s-incident-agent/agent-runtime").spec.template.spec.containers[0]
    .env.push({ name: "PUBLIC_DEMO_DATA_APPROVED", value: "true" }), "bootstrap_required"],
  ["an access mode spelled for the environment", resources => resources.get("Deployment/k8s-incident-agent/agent-runtime").spec.template.spec
    .containers[0].env.push({ name: "console_access_mode", value: "public_demo" }), "bootstrap_required"],
  ["an approval in its own configuration", resources => { resources.get("ConfigMap/k8s-incident-agent/agent-runtime-config")
    .data.PUBLIC_DEMO_DATA_APPROVED = "True"; }, "bootstrap_required"],
  ["an access mode in the Console configuration", resources => { resources.get("ConfigMap/k8s-incident-agent/incident-console-config")
    .data.CONSOLE_ACCESS_MODE = "public_demo"; }, "bootstrap_required"],
]) {
  test(`a release carrying ${name} never reaches a daily apply`, () => {
    const resources = clone(renders["k3s-public"]);
    mutate(resources);
    assert.throws(() => planScope(resources), { code });
  });
}

test("gateway Jobs run the release images without credentials, privileges or foreign accounts", () => {
  for (const document of [prefetchJob(manifest, "aaaaaaaaaaaa-1"), backupJob(manifest, "aaaaaaaaaaaa-1")]) {
    const pod = document.spec.template.spec;
    assert.equal(document.metadata.namespace, "k8s-incident-agent");
    assert.equal(pod.serviceAccountName, "deploy-jobs");
    assert.equal(pod.automountServiceAccountToken, false);
    assert.equal(pod.securityContext.fsGroupChangePolicy, "OnRootMismatch");
    // Finished Pods must not join the project's Pod set that status counts, nor any NetworkPolicy's selection.
    assert.deepEqual(document.spec.template.metadata.labels, { "app.kubernetes.io/name": document.metadata.labels["app.kubernetes.io/name"] });
    assert.ok(["deploy-prefetch", "runtime-backup"].includes(document.spec.template.metadata.labels["app.kubernetes.io/name"]));
    assert.equal(document.spec.backoffLimit, 0);
    for (const container of pod.containers) {
      assert.match(container.image, /^ghcr\.io\/kkxiaoa\/k8s-incident-agent-(console|runtime)@sha256:[a-f0-9]{64}$/);
      assert.deepEqual(container.securityContext, { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } });
    }
    assert.ok((pod.volumes ?? []).every(volume => ["runtime-data", "runtime-backup"].includes(volume.persistentVolumeClaim?.claimName)));
  }
  assert.deepEqual(backupJob(manifest, "x").spec.template.spec.containers[0].command,
    ["runtime", "backup", "--destination", "/var/backups/k8s-incident-agent"]);
});

// A kubectl (and git) stand-in answering from the rendered objects, as a cluster installed by bootstrap would.
function cluster(profile, scenario = {}) {
  const resources = clone(renders[profile]);
  const calls = [];
  const gitCalls = [];
  const prerequisites = [{ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "deploy-jobs", namespace: "k8s-incident-agent" } },
    { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: "runtime-backup", namespace: "k8s-incident-agent" }, spec: {} }]
    .filter(document => `${document.kind}/${document.metadata.name}` !== scenario.withoutPrerequisite);
  const byKey = new Map([...resources.values(), ...prerequisites]
    .map(document => [`${document.kind}/${document.metadata.namespace ?? ""}/${document.metadata.name}`, document]));
  // Bootstrap labels its approval like the rest of the project, so every listing includes it.
  const approval = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "agent-runtime-public-approval", namespace: "k8s-incident-agent",
    labels: { "app.kubernetes.io/part-of": "k8s-incident-agent" } } };
  let runtimePodsPolls = 0;
  // What the API server adds to objects it stores; the gateway must tolerate exactly these.
  const stored = document => {
    const live = structuredClone(document);
    live.metadata.uid = "live";
    if (live.kind === "ServiceAccount") live.secrets = [];
    if (live.kind === "Namespace") {
      live.metadata.labels = { ...live.metadata.labels, "kubernetes.io/metadata.name": live.metadata.name };
      live.spec = { finalizers: ["kubernetes"] };
    }
    if (live.kind === "PersistentVolumeClaim") live.spec = { ...live.spec, volumeName: "pvc-1", volumeMode: "Filesystem" };
    if (live.kind === "Ingress") live.status = { loadBalancer: { ingress: [{ ip: "192.0.2.10" }] } };
    scenario.live?.(live);
    return live;
  };
  const execute = async (program, args, options) => {
    const ok = stdout => ({ stdout, exitCode: 0 });
    if (program === "git") {
      assert.ok(scenario.git, "git is not expected in this test");
      gitCalls.push(args.slice(2));
      if (args[2] === "rev-parse") return ok(`${scenario.gitRevision ?? revision}\n`);
      if (args[2] === "ls-tree") return ok(scenario.gitModes ?? "100644\n100755\n");
      return ok("");
    }
    assert.equal(program, "kubectl");
    assert.deepEqual(args.slice(0, 4), ["--kubeconfig", "/var/lib/deploy/kubeconfig", "--context", "deploy"]);
    const command = args.slice(4);
    calls.push({ command, input: options.input });
    const [verb, kind, ...rest] = command;
    const namespaceIndex = command.indexOf("--namespace");
    const namespace = namespaceIndex === -1 ? "" : command[namespaceIndex + 1];
    if (verb === "get" && kind === "ConfigMap" && rest[0] === "agent-runtime-public-approval") {
      if (scenario.approval === undefined) return ok(JSON.stringify({ kind: "ConfigMap", data: { PUBLIC_DEMO_DATA_APPROVED: "True" } }));
      return ok(scenario.approval === null ? "" : JSON.stringify({ kind: "ConfigMap", data: { PUBLIC_DEMO_DATA_APPROVED: scenario.approval } }));
    }
    if (verb === "get" && kind === "job" && rest[0] === "runtime-data-cutover") {
      return ok(scenario.cutover ? JSON.stringify({ kind: "Job", metadata: { name: "runtime-data-cutover" } }) : "");
    }
    if (verb === "get" && kind === "job") {
      const failed = scenario.failJob && rest[0].startsWith(scenario.failJob);
      return ok(JSON.stringify({ status: failed ? { failed: 1 } : { succeeded: 1 } }));
    }
    if (verb === "get" && kind === "deployment") {
      return ok(JSON.stringify({ spec: { replicas: 1, template: { spec: { containers: [{ name: "runtime", image: previousRuntimeImage }] } } } }));
    }
    if (verb === "get" && kind === "pods" && command.includes("--selector=app.kubernetes.io/name=agent-runtime")) {
      return ok(JSON.stringify({ kind: "List", items: runtimePodsPolls++ === 0 ? [{ metadata: { name: "agent-runtime-0" } }] : [] }));
    }
    if (verb === "get" && kind === "pods") return ok(JSON.stringify({ kind: "List", items: [] }));
    if (verb === "get" && kind.includes(",")) {
      assert.ok(command.includes("--selector=app.kubernetes.io/part-of=k8s-incident-agent"));
      const items = [...resources.values(), approval, scenario.leftover].filter(document => document
        && ["ConfigMap", "Deployment", "Service", "NetworkPolicy", "Ingress"].includes(document.kind)
        && document.metadata.namespace === namespace && `${document.kind}/${document.metadata.name}` !== scenario.missing);
      return ok(JSON.stringify({ kind: "List", items }));
    }
    if (verb === "get") {
      if (scenario.readFails === kind) return { stdout: "", exitCode: 1 };
      const names = rest.filter(arg => !arg.startsWith("--") && arg !== namespace);
      const found = names.map(name => byKey.get(`${kind}/${namespace}/${name}`)).filter(Boolean).map(stored);
      if (found.length === 0) return ok("");
      return ok(JSON.stringify(names.length > 1 ? { kind: "List", items: found } : found[0]));
    }
    if (verb === "apply" && command.includes("--dry-run=server")) return { stdout: "", exitCode: scenario.dryRunFails ? 1 : 0 };
    if (verb === "rollout") return { stdout: "", exitCode: scenario.rolloutFails ? 1 : 0 };
    if (verb === "logs") {
      return ok(scenario.backupLog ?? 'progress\n{"alembicHead":"20260919_0013","backup":"20260926T071500Z","bytes":10,"files":3,"removed":[]}\n');
    }
    if (verb === "scale") return { stdout: "", exitCode: scenario.scaleFails === command.at(-1) ? 1 : 0 };
    if (["apply", "create"].includes(verb)) return ok("");
    throw new Error(`unexpected kubectl ${command.join(" ")}`);
  };
  const mutations = () => calls.filter(({ command }) => ["create", "scale", "delete", "patch"].includes(command[0])
    || (command[0] === "apply" && !command.includes("--dry-run=server")));
  return { execute, calls, gitCalls, mutations };
}

async function run(t, profile, scenario, dependencies = {}) {
  const fake = cluster(profile, scenario);
  const settings = await config(t);
  const phases = [];
  // A dependency set to undefined falls back to the gateway's production implementation.
  const overrides = Object.fromEntries(Object.entries({
    execute: fake.execute,
    fetchManifest: async () => manifest,
    checkoutSource: async () => root,
    verifyImages: async () => manifest,
    render: async () => clone(renders[profile]),
    sleep: async () => {},
    suffix: () => "0a1b2c3d",
    progress: phase => phases.push(phase),
    ...dependencies,
  }).filter(([, value]) => value !== undefined));
  const outcome = deploy({ version: "v0.2.0", profile }, settings, overrides);
  return { fake, outcome, phases, settings };
}

test("a published release is prefetched, backed up behind a drained Runtime, applied and rolled out", async t => {
  const { fake, outcome, phases } = await run(t, "k3s-public");
  assert.deepEqual(await outcome, { status: "deployed", version: "v0.2.0", profile: "k3s-public", sourceRevision: revision,
    previousRuntimeImage, backup: "20260926T071500Z", alembicHead: "20260919_0013" });
  assert.deepEqual(phases, ["release", "source", "images", "render", "scope", "bootstrap", "preflight", "prefetch", "drain", "backup", "apply", "rollout"]);
  const order = fake.mutations().map(({ command, input }) => command[0] === "create" ? `create ${JSON.parse(input).metadata.name}` : command.slice(0, 3).join(" "));
  assert.deepEqual(order, [
    "create deploy-prefetch-aaaaaaaaaaaa-0a1b2c3d",
    "scale deployment/agent-runtime --namespace",
    "create runtime-backup-aaaaaaaaaaaa-0a1b2c3d",
    "apply --filename=-",
  ]);
  const applied = JSON.parse(fake.mutations().at(-1).input).items;
  assert.ok(applied.every(document => ["ConfigMap", "Deployment", "Service", "NetworkPolicy", "Ingress"].includes(document.kind)));
  assert.equal(fake.calls.filter(({ command }) => command[0] === "rollout").length, 6);
  const dryRun = fake.calls.findIndex(({ command }) => command.includes("--dry-run=server"));
  assert.ok(dryRun !== -1 && dryRun < fake.calls.indexOf(fake.mutations()[0]));
});

test("a private profile needs no public approval and exposes no Ingress", async t => {
  const { fake, outcome } = await run(t, "k3s-evaluation");
  assert.equal((await outcome).status, "deployed");
  assert.ok(!fake.calls.some(({ command }) => command.includes("agent-runtime-public-approval")));
  assert.ok(!fake.calls.some(({ command }) => command[1] === "Ingress"));
});

const patchValidatorBoundary = "k8s-incident-agent-patch-validator-dry-run-only";
const drift = (kind, name, change) => ({ live: live => { if (live.kind === kind && live.metadata.name === name) change(live); } });

for (const [name, scenario, code, phase] of [
  ["drifted bootstrap RBAC", drift("Role", "diagnostic-agent-read", live => live.rules.push({ apiGroups: [""], resources: ["secrets"],
    verbs: ["get"] })), "bootstrap_required", "bootstrap"],
  ["a narrowed bootstrap rule", drift("Role", "diagnostic-agent-read", live => { live.rules[0].resourceNames = ["only-this"]; }),
    "bootstrap_required", "bootstrap"],
  ["an admission binding that skips labeled objects", drift("ValidatingAdmissionPolicyBinding", patchValidatorBoundary, live => {
    live.spec.matchResources = { ...live.spec.matchResources, objectSelector: { matchLabels: { skip: "true" } } };
  }), "bootstrap_required", "bootstrap"],
  ["an admission policy that never matches", drift("ValidatingAdmissionPolicy", patchValidatorBoundary, live => {
    live.spec.matchConditions = [{ name: "never", expression: "false" }];
  }), "bootstrap_required", "bootstrap"],
  ["an interrupted Runtime data cutover", { cutover: true }, "cutover_residue_present", "preflight"],
  ["a Secret the running version never used", drift("Deployment", "agent-runtime", live => {
    const [runtime] = live.spec.template.spec.containers;
    runtime.env = runtime.env.filter(entry => entry.name !== "DEEPSEEK_API_KEY");
  }), "bootstrap_required", "preflight"],
  ["a missing backup claim", { withoutPrerequisite: "PersistentVolumeClaim/runtime-backup" }, "bootstrap_required", "preflight"],
  ["a missing Job account", { withoutPrerequisite: "ServiceAccount/deploy-jobs" }, "bootstrap_required", "preflight"],
  ["a daily object bootstrap never created or labeled", { missing: "NetworkPolicy/allow-traefik-to-console" }, "bootstrap_required", "preflight"],
  ["missing public approval", { approval: null }, "approval_missing", "preflight"],
  ["a withdrawn public approval", { approval: "false" }, "approval_missing", "preflight"],
  ["a server dry-run rejection", { dryRunFails: true }, "command_failed", "preflight"],
  ["an image pull failure", { failJob: "deploy-prefetch" }, "prefetch_failed", "prefetch"],
]) {
  test(`${name} stops before the running version is touched`, async t => {
    const { fake, outcome } = await run(t, "k3s-public", scenario);
    await assert.rejects(outcome, { code, phase, details: {} });
    assert.ok(!fake.mutations().some(({ command }) => command[0] === "scale" || (command[0] === "apply")), name);
  });
}

test("a public entry the selected profile no longer renders is never left behind", async t => {
  const leftover = structuredClone(renders["k3s-public"].get("Ingress/k8s-incident-agent/incident-console"));
  const { fake, outcome } = await run(t, "k3s-evaluation", { leftover });
  await assert.rejects(outcome, { code: "bootstrap_required", phase: "preflight",
    message: /^Ingress\/k8s-incident-agent\/incident-console is not part of this release/ });
  assert.equal(fake.mutations().length, 0);
});

for (const [name, scenario, code, phase] of [
  ["a failed backup", { failJob: "runtime-backup" }, "backup_failed", "backup"],
  ["a failed scale-down", { scaleFails: "--replicas=0" }, "command_failed", "drain"],
]) {
  test(`${name} resumes the unchanged version and applies nothing`, async t => {
    const { fake, outcome } = await run(t, "k3s-public", scenario);
    await assert.rejects(outcome, { code, phase, details: { previousRuntimeImage } });
    const scales = fake.mutations().filter(({ command }) => command[0] === "scale").map(({ command }) => command.at(-1));
    assert.deepEqual(scales, ["--replicas=0", "--replicas=1"]);
    assert.ok(!fake.mutations().some(({ command }) => command[0] === "apply"));
  });
}

test("a backup the release refuses names its reason and leaves the running version in place", async t => {
  const { fake, outcome } = await run(t, "k3s-public", { failJob: "runtime-backup",
    backupLog: '{"error":{"code":"schema_unknown","phase":"backup"}}\n' });
  await assert.rejects(outcome, { code: "backup_failed", phase: "backup", message: /: schema_unknown$/, details: { previousRuntimeImage } });
  const scales = fake.mutations().filter(({ command }) => command[0] === "scale").map(({ command }) => command.at(-1));
  assert.deepEqual(scales, ["--replicas=0", "--replicas=1"]);
  assert.ok(!fake.mutations().some(({ command }) => command[0] === "apply"));
});

test("a release the host cannot verify is reported with its reason before anything else runs", async t => {
  const { fake, outcome } = await run(t, "k3s-public", {}, {
    fetchManifest: async () => { throw new Error("Only a published stable release can be installed"); },
  });
  await assert.rejects(outcome, { code: "release_unverified", phase: "release", message: "Only a published stable release can be installed" });
  assert.equal(fake.calls.length, 0);
});

test("a read that fails after apply is reported in the phase it happened", async t => {
  const { outcome } = await run(t, "k3s-public", { readFails: "Ingress" });
  await assert.rejects(outcome, { code: "command_failed", phase: "rollout" });
});

test("the production release and source readers run inside the gateway's own work directory", async t => {
  const assets = [["candidate.tar.gz", Buffer.from("candidate")], ["SHA256SUMS", Buffer.from("sums")],
    ["release.json", Buffer.from(JSON.stringify(manifest))]].map(([name, bytes], index) => ({ id: 70 + index, name, bytes,
    state: "uploaded", digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }));
  const release = { id: 9, draft: false, prerelease: false, tag_name: "v0.2.0", target_commitish: revision };
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.hostname, "api.github.com");
    const endpoint = url.pathname.replace("/repos/kkxiaoa/k8s-incident-agent", "");
    const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (endpoint === "/releases/tags/v0.2.0" || endpoint === "/releases/9") return json(release);
    if (endpoint === "/git/ref/tags/v0.2.0") return json({ object: { type: "commit", sha: revision } });
    if (endpoint === "/releases/9/assets") return json(assets.map(({ id, name, state, digest }) => ({ id, name, state, digest })));
    const asset = assets.find(item => endpoint === `/releases/assets/${item.id}`);
    assert.ok(asset?.name === "release.json" && options.headers.Accept === "application/octet-stream", endpoint);
    return new Response(asset.bytes);
  };
  const { fake, outcome, settings } = await run(t, "k3s-public", { git: true }, {
    fetchManifest: undefined, checkoutSource: undefined,
  });
  assert.equal((await outcome).status, "deployed");
  assert.deepEqual(fake.gitCalls.map(args => args[0]), ["init", "fetch", "checkout", "rev-parse", "ls-tree"]);
  assert.deepEqual(fake.gitCalls[1].slice(-2), ["https://github.com/kkxiaoa/k8s-incident-agent.git", "refs/tags/v0.2.0"]);
  assert.deepEqual(await readdir(settings.workRoot), []);
});

for (const [name, scenario] of [
  ["a fetched commit that differs from the release", { git: true, gitRevision: "b".repeat(40) }],
  ["a symbolic link in the release source", { git: true, gitModes: "100644\n120000\n" }],
  ["a submodule in the release source", { git: true, gitModes: "100644\n160000\n" }],
]) {
  test(`${name} is refused before any cluster call`, async t => {
    const { fake, outcome } = await run(t, "k3s-public", scenario, { checkoutSource: undefined });
    await assert.rejects(outcome, { code: "release_invalid", phase: "source" });
    assert.equal(fake.calls.length, 0);
  });
}

test("a cluster off the pinned baseline is refused before anything is rendered", async () => {
  await assert.rejects(renderSourceProfile(root, manifest, "k3s-public", "deploy", pinnedCluster("v1.37.0+k3s1")),
    { code: "server_version_mismatch" });
});

test("a render the installer would refuse never reaches the cluster", async () => {
  let changed = false;
  const pinned = pinnedCluster();
  const execute = async (program, args, options) => {
    const result = await pinned(program, args, options);
    return { ...result, stdout: result.stdout.replace("OPERATOR_ORIGIN: https://incident.kubesmith.cloud", () => {
      changed = true;
      return "OPERATOR_ORIGIN: http://incident.kubesmith.cloud";
    }) };
  };
  await assert.rejects(renderSourceProfile(root, manifest, "k3s-public", "deploy", execute), { code: "installation_not_ready" });
  assert.ok(changed);
});

test("a Runtime left stopped is reported as such rather than as the backup failure", async t => {
  const { fake, outcome } = await run(t, "k3s-public", { failJob: "runtime-backup", scaleFails: "--replicas=1" });
  await assert.rejects(outcome, { code: "runtime_not_restored", phase: "backup", message: /must be scaled manually$/,
    details: { previousRuntimeImage } });
  assert.ok(!fake.mutations().some(({ command }) => command[0] === "apply"));
});

test("a failed rollout is reported with what a manual rollback needs, without rollback, reset or a second write", async t => {
  const { fake, outcome } = await run(t, "k3s-public", { rolloutFails: true });
  await assert.rejects(outcome, { code: "command_failed", phase: "rollout",
    details: { previousRuntimeImage, backup: "20260926T071500Z", alembicHead: "20260919_0013" } });
  const after = fake.mutations().slice(fake.mutations().findIndex(({ command }) => command[0] === "apply"));
  assert.equal(after.length, 1);
});

test("a concurrent deployment is refused before any cluster read", async t => {
  const settings = await config(t);
  await mkdir(settings.workRoot, { recursive: true });
  await writeFile(path.join(settings.workRoot, "deploy.lock"), "");
  const fake = cluster("k3s-public");
  await assert.rejects(deploy({ version: "v0.2.0", profile: "k3s-public" }, settings, { execute: fake.execute,
    fetchManifest: async () => manifest, progress: () => {} }), { code: "deployment_in_progress" });
  assert.equal(fake.calls.length, 0);
});

test("the forced command entry refuses arguments, SSH commands and malformed requests", async t => {
  const settings = await config(t);
  const file = path.join(settings.workRoot, "gateway.json");
  await writeFile(file, JSON.stringify(settings));
  for (const [args, environment, input, code] of [
    [[], {}, '{"version":"v0.2.0","profile":"k3s-public"}', "config_invalid"],
    [[file, "--release", "/tmp/release.json"], {}, '{"version":"v0.2.0","profile":"k3s-public"}', "config_invalid"],
    [[file], { SSH_ORIGINAL_COMMAND: "kubectl delete ns" }, '{"version":"v0.2.0","profile":"k3s-public"}', "request_invalid"],
    [[file], {}, '{"version":"v0.2.0","profile":"kind-evaluation"}', "request_invalid"],
  ]) {
    const result = spawnSync(process.execPath, [gateway, ...args], { input, encoding: "utf8", env: { PATH: process.env.PATH, ...environment } });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).code, code, JSON.stringify(args));
  }
});

test("a dropped SSH session neither ends the run early nor leaves its lock behind", async t => {
  const settings = await config(t);
  const file = path.join(settings.workRoot, "gateway.json");
  await writeFile(file, JSON.stringify(settings));
  const offline = path.join(settings.workRoot, "offline.mjs");
  await writeFile(offline, 'globalThis.fetch = async () => { throw new Error("offline"); };\n');
  const child = spawn(process.execPath, ["--import", pathToFileURL(offline).href, gateway, file],
    { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  // sshd closes the session's pipes when the client disconnects; every later write then fails.
  child.stdout.destroy();
  child.stderr.destroy();
  child.stdin.end('{"version":"v0.2.0","profile":"k3s-public"}\n');
  assert.equal(await new Promise(resolve => child.on("exit", resolve)), 1);
  assert.deepEqual((await readdir(settings.workRoot)).sort(), ["gateway.json", "offline.mjs"]);
});

// The bootstrap-installed identity, read the way the API server would evaluate it.
function gatewayBundle() {
  const result = spawnSync(process.env.KUBECTL_BINARY ?? "kubectl", ["kustomize", path.join(root, "deploy/application/gateway")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return loadAll(result.stdout).filter(Boolean);
}

const RESOURCES = {
  ConfigMap: ["", "configmaps"], Service: ["", "services"], ServiceAccount: ["", "serviceaccounts"], Namespace: ["", "namespaces"],
  PersistentVolumeClaim: ["", "persistentvolumeclaims"], Deployment: ["apps", "deployments"],
  NetworkPolicy: ["networking.k8s.io", "networkpolicies"], Ingress: ["networking.k8s.io", "ingresses"],
  Role: ["rbac.authorization.k8s.io", "roles"], RoleBinding: ["rbac.authorization.k8s.io", "rolebindings"],
  ClusterRole: ["rbac.authorization.k8s.io", "clusterroles"], ClusterRoleBinding: ["rbac.authorization.k8s.io", "clusterrolebindings"],
  ValidatingAdmissionPolicy: ["admissionregistration.k8s.io", "validatingadmissionpolicies"],
  ValidatingAdmissionPolicyBinding: ["admissionregistration.k8s.io", "validatingadmissionpolicybindings"],
};

function authorizer(bundle) {
  const subject = { kind: "ServiceAccount", name: "deploy-gateway", namespace: "k8s-incident-agent" };
  const bound = binding => binding.subjects.some(item => isDeepStrictEqual(item, subject));
  const rules = [];
  for (const binding of bundle.filter(document => document.kind.endsWith("RoleBinding") && bound(document))) {
    const role = bundle.find(document => document.kind === binding.roleRef.kind && document.metadata.name === binding.roleRef.name
      && (binding.roleRef.kind === "ClusterRole" || document.metadata.namespace === binding.metadata.namespace));
    for (const rule of role.rules) rules.push({ ...rule, namespace: binding.kind === "RoleBinding" ? binding.metadata.namespace : null });
  }
  return { rules, allows: ({ namespace, group, resource, verb, name }) => rules.some(rule => (rule.namespace === null || rule.namespace === namespace)
    && rule.apiGroups.includes(group) && rule.resources.includes(resource) && rule.verbs.includes(verb)
    && (!rule.resourceNames || rule.resourceNames.includes(name))) };
}

// What each gateway kubectl call asks the API server for.
function apiRequests({ command, input }) {
  const [verb, target, ...rest] = command;
  const index = command.indexOf("--namespace");
  const namespace = index === -1 ? "" : command[index + 1];
  const item = (kind, name, apiVerb, itemNamespace = namespace) => ({ namespace: itemNamespace, group: RESOURCES[kind][0],
    resource: RESOURCES[kind][1], verb: apiVerb, name });
  if (verb === "get" && target === "pods") return [{ namespace, group: "", resource: "pods", verb: "list" }];
  if (verb === "get" && target === "job") return [{ namespace, group: "batch", resource: "jobs", verb: "get", name: rest[0] }];
  if (verb === "get" && target === "deployment") return [item("Deployment", rest[0], "get")];
  if (verb === "get" && target.includes(",")) return target.split(",").map(type => {
    const [resource, ...group] = type.split(".");
    return { namespace, group: group.join("."), resource, verb: "list" };
  });
  if (verb === "get") return rest.filter(arg => !arg.startsWith("--") && arg !== namespace).map(name => item(target, name, "get"));
  if (verb === "apply") return JSON.parse(input).items.flatMap(document => ["get", "patch"].map(apiVerb =>
    item(document.kind, document.metadata.name, apiVerb, document.metadata.namespace)));
  if (verb === "create") return [{ namespace: JSON.parse(input).metadata.namespace, group: "batch", resource: "jobs", verb: "create" }];
  if (verb === "scale") return ["get", "patch"].map(apiVerb => ({ namespace, group: "apps", resource: "deployments/scale", verb: apiVerb,
    name: target.split("/")[1] }));
  if (verb === "logs") return [{ namespace, group: "batch", resource: "jobs", verb: "get", name: target.split("/")[1] },
    { namespace, group: "", resource: "pods", verb: "list" }, { namespace, group: "", resource: "pods/log", verb: "get" }];
  if (verb === "rollout") return [item("Deployment", rest[0].split("/")[1], "get"), { namespace, group: "apps", resource: "deployments", verb: "watch" }];
  throw new Error(`unmapped gateway call ${command.join(" ")}`);
}

test("the deploy identity is authorized for exactly what a gateway deployment does", async t => {
  const { allows } = authorizer(gatewayBundle());
  for (const [profile, scenario] of [["k3s-public", {}], ["k3s-evaluation", {}], ["k3s-public", { failJob: "runtime-backup" }]]) {
    const { fake, outcome } = await run(t, profile, scenario);
    await outcome.catch(() => {});
    for (const call of fake.calls) for (const request of apiRequests(call)) {
      assert.ok(allows(request), `${profile}: ${call.command.slice(0, 3).join(" ")} needs ${JSON.stringify(request)}`);
    }
  }
});

test("the deploy identity patches only rendered daily objects and holds no direct secret, token, node or RBAC write access", () => {
  const { rules, allows } = authorizer(gatewayBundle());
  const { daily, bootstrap } = planScope(clone(renders["k3s-public"]));
  for (const document of daily) {
    const [group, resource] = RESOURCES[document.kind];
    assert.ok(allows({ namespace: document.metadata.namespace, group, resource, verb: "patch", name: document.metadata.name }), `patch ${document.kind}/${document.metadata.name}`);
  }
  for (const document of bootstrap) {
    const [group, resource] = RESOURCES[document.kind];
    const request = { namespace: document.metadata.namespace ?? "", group, resource, name: document.metadata.name };
    assert.ok(allows({ ...request, verb: "get" }), `get ${document.kind}/${document.metadata.name}`);
    assert.ok(!["patch", "update", "create", "delete"].some(verb => allows({ ...request, verb })), `write ${document.kind}/${document.metadata.name}`);
  }
  const patchable = new Set(daily.map(document => `${document.metadata.namespace}/${RESOURCES[document.kind][1]}/${document.metadata.name}`));
  for (const rule of rules) {
    assert.ok(rule.verbs.every(verb => ["get", "list", "watch", "patch", "create"].includes(verb)), JSON.stringify(rule));
    assert.ok(!rule.resources.some(resource => ["secrets", "serviceaccounts/token", "pods/exec", "pods/attach", "pods/portforward",
      "nodes", "nodes/proxy", "persistentvolumes"].includes(resource)), JSON.stringify(rule));
    if (rule.verbs.includes("list")) {
      assert.ok(rule.resources.every(resource => ["configmaps", "services", "deployments", "networkpolicies", "ingresses", "pods"].includes(resource)),
        JSON.stringify(rule));
    }
    if (rule.verbs.includes("create")) assert.deepEqual([rule.apiGroups, rule.resources], [["batch"], ["jobs"]]);
    if (rule.verbs.includes("patch") && rule.resources[0] !== "deployments/scale") {
      for (const resource of rule.resources) for (const name of rule.resourceNames) {
        assert.ok(patchable.has(`${rule.namespace}/${resource}/${name}`), `${rule.namespace}/${resource}/${name} is not a rendered daily object`);
      }
    }
  }
});

test("admission pins the release repositories, the locked third-party digests and the rendered accounts", async () => {
  const bundle = gatewayBundle();
  const policy = bundle.find(document => document.kind === "ValidatingAdmissionPolicy");
  const expressions = policy.spec.validations.map(validation => validation.expression).join("\n");
  const versions = JSON.parse(await readFile(path.join(root, "deploy/application/versions.json"), "utf8"));
  const pinned = Object.values(versions.monitoring).map(image => `${image.repository}@${image.digest}`);
  const quoted = [...expressions.matchAll(/'([a-z0-9./-]+@sha256:[a-f0-9]{64})'/g)].map(match => match[1]);
  assert.deepEqual(quoted.sort(), pinned.sort());
  const accounts = [...renders["k3s-public"].values()].filter(document => document.kind === "ServiceAccount");
  for (const namespace of ["k8s-incident-agent", "k8s-incident-monitoring"]) {
    const names = accounts.filter(document => document.metadata.namespace === namespace).map(document => `'${document.metadata.name}'`).sort();
    assert.ok(expressions.includes(`[${names.join(", ")}]`), namespace);
  }
  assert.equal(policy.spec.matchConditions[0].expression,
    "request.userInfo.username == 'system:serviceaccount:k8s-incident-agent:deploy-gateway'");
  const hosts = renders["k3s-public"].get("Ingress/k8s-incident-agent/incident-console").spec.rules.map(rule => rule.host);
  assert.deepEqual(hosts, ["incident.kubesmith.cloud"]);
  assert.ok(expressions.includes(`rule.host == '${hosts[0]}'`));
  assert.deepEqual(policy.spec.matchConstraints.resourceRules.map(rule => rule.resources[0]).sort(),
    ["deployments", "ingresses", "jobs", "services"]);
  const claims = new Set(backupJob(manifest, "x").spec.template.spec.volumes.map(volume => volume.persistentVolumeClaim.claimName));
  assert.ok(expressions.includes(`['${[...claims].join("', '")}']`));
  // The policy admits the gateway's Jobs only in the shape the gateway builds them, and no workload may bind a host port.
  for (const guard of ["!has(object.spec.template.spec.imagePullSecrets)", "!has(container.lifecycle)", "!has(container.livenessProbe)",
    "!has(container.readinessProbe)",
    "!has(container.startupProbe)", "!has(port.hostPort) || port.hostPort == 0",
    "object.spec.template.metadata.labels['app.kubernetes.io/name'] in ['deploy-prefetch', 'runtime-backup']"]) {
    assert.ok(expressions.includes(guard), guard);
  }
  for (const container of [prefetchJob(manifest, "x"), backupJob(manifest, "x")].flatMap(document => document.spec.template.spec.containers)) {
    assert.ok(expressions.includes(`container.command == [${container.command.map(part => `'${part}'`).join(", ")}]`), container.name);
    for (const variable of container.env ?? []) {
      assert.ok(expressions.includes(`variable.name == '${variable.name}'`) && expressions.includes(`variable.value == '${variable.value}'`));
    }
    for (const mount of container.volumeMounts ?? []) {
      assert.ok(expressions.includes(`mount.name == '${mount.name}' && mount.mountPath == '${mount.mountPath}'`), mount.name);
    }
  }
  const backends = renders["k3s-public"].get("Ingress/k8s-incident-agent/incident-console").spec.rules
    .flatMap(rule => rule.http.paths.map(entry => entry.backend.service.name));
  assert.deepEqual([...new Set(backends)], ["incident-console"]);
  assert.ok(expressions.includes(`entry.backend.service.name == '${backends[0]}'`));
  const backupClaim = bundle.find(document => document.kind === "PersistentVolumeClaim");
  assert.deepEqual([backupClaim.metadata.name, backupClaim.spec.storageClassName, backupClaim.spec.resources.requests.storage],
    ["runtime-backup", "local-path", "5Gi"]);
});
