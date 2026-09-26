// Restricted deployment entry for the fixed K3s host. An SSH forced command runs it as the
// dedicated deploy user; the caller supplies only a published version and a fixed profile.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { DeploymentContractError, executeExternalCommand, renderSourceProfile, requireCutoverObjectsAbsent,
  requireReadyIngress } from "./deployment.mjs";
import { fetchPublishedManifest } from "./publish.mjs";
import { ReleaseError, ghcrRegistry, verifyRegistryRelease } from "./release.mjs";

const REQUEST_LIMIT_BYTES = 256;
const CONFIG_LIMIT_BYTES = 4096;
const OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const VERSION = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const REVISION = /^[a-f0-9]{40}$/;
const SOURCE_REPOSITORY = "https://github.com/kkxiaoa/k8s-incident-agent.git";
// k3s-online renders no operator origin, so install and upgrade refuse it as it stands.
const GATEWAY_PROFILES = new Set(["k3s-evaluation", "k3s-public"]);
const APPLICATION_NAMESPACE = "k8s-incident-agent";
const PROJECT_NAMESPACES = new Set([APPLICATION_NAMESPACE, "k8s-incident-monitoring"]);
// Daily deploys may only update objects that bootstrap already created; everything else
// in a render belongs to bootstrap and must already match the cluster.
const DAILY_KINDS = new Set(["ConfigMap", "Deployment", "Service", "NetworkPolicy", "Ingress"]);
const DAILY_RESOURCES = "configmaps,services,deployments.apps,networkpolicies.networking.k8s.io,ingresses.networking.k8s.io";
const PROJECT_SELECTOR = "app.kubernetes.io/part-of=k8s-incident-agent";
const BOOTSTRAP_KINDS = new Set(["Namespace", "ServiceAccount", "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding",
  "PersistentVolumeClaim", "ValidatingAdmissionPolicy", "ValidatingAdmissionPolicyBinding"]);
// The API server adds defaults to these specs; everything else that grants or limits access must match exactly.
const DEFAULTED_SPEC_KINDS = new Set(["Namespace", "PersistentVolumeClaim"]);
const RUNTIME_DEPLOYMENT = "agent-runtime";
const RUNTIME_CONFIG_IDENTITY = `ConfigMap/${APPLICATION_NAMESPACE}/agent-runtime-config`;
const RUNTIME_DATA_MOUNT = "/var/lib/k8s-incident-agent";
const BACKUP_MOUNT = "/var/backups/k8s-incident-agent";
const BACKUP_NAME = /^\d{8}T\d{6}Z$/;
const JOB_ACCOUNT = "deploy-jobs";
const BACKUP_CLAIM = "runtime-backup";
const APPROVAL_CONFIGMAP = "agent-runtime-public-approval";
const APPROVAL_IDENTITY = `ConfigMap/${APPLICATION_NAMESPACE}/${APPROVAL_CONFIGMAP}`;
const ACCESS_MODE_KEY = "CONSOLE_ACCESS_MODE";
const APPROVAL_KEY = "PUBLIC_DEMO_DATA_APPROVED";
const APPROVAL_REFERENCE = { name: APPROVAL_KEY, valueFrom: { configMapKeyRef: { name: APPROVAL_CONFIGMAP, key: APPROVAL_KEY } } };
// The Runtime parses its approval as a pydantic bool; only these spellings mean approved.
const APPROVED_VALUES = new Set(["1", "on", "t", "true", "y", "yes"]);
const READ_TIMEOUT = 60_000;
const WRITE_TIMEOUT = 5 * 60_000;
const PREFETCH_SECONDS = 30 * 60;
const BACKUP_SECONDS = 20 * 60;
const DRAIN_SECONDS = 180;
const ROLLOUT_SECONDS = 600;
const POLL_MILLISECONDS = 5_000;

class GatewayError extends Error {
  constructor(code, phase, message) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.phase = phase;
    this.details = {};
  }
}

function requireGateway(condition, code, phase, message) {
  if (!condition) throw new GatewayError(code, phase, message);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The whole caller contract: one JSON line with a published version and an allowed profile. */
export function parseRequest(input, environment, profiles) {
  requireGateway(!environment.SSH_ORIGINAL_COMMAND, "request_invalid", "request", "The gateway accepts no command, only a request on stdin");
  requireGateway(typeof input === "string" && Buffer.byteLength(input) <= REQUEST_LIMIT_BYTES && /^[^\r\n]+\n?$/.test(input),
    "request_invalid", "request", "Send exactly one bounded JSON line");
  let request;
  try { request = JSON.parse(input); } catch { request = undefined; }
  requireGateway(object(request) && isDeepStrictEqual(Object.keys(request).sort(), ["profile", "version"])
    && typeof request.version === "string" && VERSION.test(request.version) && request.version.length <= 64
    && typeof request.profile === "string" && profiles.includes(request.profile),
  "request_invalid", "request", "Request needs only a stable version and an allowed profile");
  return { version: request.version, profile: request.profile };
}

/** Host settings written by bootstrap; the caller cannot influence any of them. */
export async function loadConfig(file) {
  requireGateway(path.isAbsolute(file), "config_invalid", "config", "Gateway configuration path must be absolute");
  let config;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      requireGateway(stat.isFile() && stat.size <= CONFIG_LIMIT_BYTES, "config_invalid", "config", "Gateway configuration must be a small regular file");
      config = JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError("config_invalid", "config", "Gateway configuration is unreadable or invalid");
  }
  const absolute = value => typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value;
  requireGateway(object(config)
    && isDeepStrictEqual(Object.keys(config).sort(), ["context", "kubeconfig", "profiles", "registryProxy", "schemaVersion", "workRoot"])
    && config.schemaVersion === 1 && Array.isArray(config.profiles) && config.profiles.length > 0
    && config.profiles.every(profile => GATEWAY_PROFILES.has(profile)) && new Set(config.profiles).size === config.profiles.length
    && absolute(config.kubeconfig) && absolute(config.workRoot)
    && typeof config.context === "string" && /^[A-Za-z0-9._@:-]{1,100}$/.test(config.context)
    && (config.registryProxy === null || proxyUrl(config.registryProxy)),
  "config_invalid", "config", "Gateway configuration does not match its contract");
  return config;
}

function proxyUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Only the declared fields of a rendered object must hold in the cluster; server defaults may add more. */
export function containsDeclared(desired, live) {
  if (Array.isArray(desired)) {
    return Array.isArray(live) && live.length === desired.length && desired.every((item, index) => containsDeclared(item, live[index]));
  }
  if (object(desired)) {
    return object(live) && Object.entries(desired).every(([key, value]) => containsDeclared(value, live[key]));
  }
  return desired === live;
}

function bootstrapMatches(desired, live) {
  const labels = desired.metadata?.labels;
  if (labels !== undefined && !containsDeclared(labels, live.metadata?.labels)) return false;
  if (DEFAULTED_SPEC_KINDS.has(desired.kind)) return desired.spec === undefined || containsDeclared(desired.spec, live.spec);
  return ["spec", "rules", "roleRef", "subjects", "automountServiceAccountToken"]
    .every(field => isDeepStrictEqual(desired[field], live[field]));
}

function identity(document) {
  const namespace = document.metadata?.namespace;
  return `${document.kind}/${namespace ? `${namespace}/` : ""}${document.metadata?.name}`;
}

// Only the installer approves public data: a release may point at its approval, never carry one.
// Settings read environment names case-insensitively, so every spelling of these keys counts.
function envLeavesApprovalToInstaller(entry) {
  const name = String(entry?.name).toUpperCase();
  return name !== ACCESS_MODE_KEY && (name !== APPROVAL_KEY || isDeepStrictEqual(entry, APPROVAL_REFERENCE));
}

function configurationLeavesApprovalToInstaller(document) {
  return Object.entries(document.data ?? {}).every(([key, value]) => {
    const name = key.toUpperCase();
    if (name === APPROVAL_KEY) return !APPROVED_VALUES.has(String(value).toLowerCase());
    return name !== ACCESS_MODE_KEY || (identity(document) === RUNTIME_CONFIG_IDENTITY && key === ACCESS_MODE_KEY);
  });
}

/** Split a render into daily updates and bootstrap-owned objects, and check what workloads may run. */
export function planScope(resources) {
  const daily = [];
  const bootstrap = [];
  for (const document of resources.values()) {
    const namespace = document.metadata?.namespace;
    if (DAILY_KINDS.has(document.kind) && PROJECT_NAMESPACES.has(namespace)) daily.push(document);
    else if (BOOTSTRAP_KINDS.has(document.kind)) bootstrap.push(document);
    else throw new GatewayError("bootstrap_required", "scope", `${identity(document)} is outside the daily deployment scope`);
  }
  requireGateway(!daily.some(document => identity(document) === APPROVAL_IDENTITY),
    "bootstrap_required", "scope", "The public data approval belongs to the installer, never to a release");
  for (const document of daily.filter(item => item.kind === "ConfigMap")) {
    requireGateway(configurationLeavesApprovalToInstaller(document), "bootstrap_required", "scope",
      `${identity(document)} sets public data access that only the installer may grant`);
  }
  const accounts = new Set(bootstrap.filter(document => document.kind === "ServiceAccount").map(identity));
  for (const deployment of daily.filter(document => document.kind === "Deployment")) {
    const pod = deployment.spec?.template?.spec ?? {};
    const containers = [...(pod.initContainers ?? []), ...(pod.containers ?? [])];
    requireGateway(!pod.hostNetwork && !pod.hostPID && !pod.hostIPC && !(pod.volumes ?? []).some(volume => volume.hostPath)
      && containers.every(container => container.securityContext?.privileged !== true && !container.securityContext?.capabilities?.add?.length
        && !(container.ports ?? []).some(port => port.hostPort))
      && accounts.has(`ServiceAccount/${deployment.metadata.namespace}/${pod.serviceAccountName}`),
    "workload_forbidden", "scope", `${identity(deployment)} asks for host access, privileges or a foreign ServiceAccount`);
    requireGateway(containers.every(container => (container.env ?? []).every(envLeavesApprovalToInstaller)), "bootstrap_required", "scope",
      `${identity(deployment)} sets public data access that only the installer may grant`);
  }
  return { daily, bootstrap };
}

function kubectl(execute, config, args, options = {}) {
  return runCommand(execute, "kubectl", ["--kubeconfig", config.kubeconfig, "--context", config.context, ...args],
    { ...options, label: `kubectl ${args[0]}` });
}

async function runCommand(execute, program, args, { input, timeout = READ_TIMEOUT, phase, label = program, accept = [0] } = {}) {
  let result;
  try {
    result = await execute(program, args, { timeoutMilliseconds: timeout, maxBufferBytes: OUTPUT_LIMIT_BYTES, input });
  } catch {
    result = undefined;
  }
  requireGateway(object(result) && typeof result.stdout === "string" && accept.includes(result.exitCode),
    "command_failed", phase, `${label} failed`);
  return result.stdout;
}

function parseJson(text, phase, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayError("command_failed", phase, `${what} returned invalid JSON`);
  }
}

async function checkoutSource(execute, version, revision, directory) {
  requireGateway(VERSION.test(version) && REVISION.test(revision), "release_invalid", "source", "Release source must be a tagged full commit");
  await mkdir(directory, { mode: 0o700 });
  const git = (args, timeout = READ_TIMEOUT) => runCommand(execute, "git", ["-C", directory, ...args],
    { timeout, phase: "source", label: `git ${args[0]}` });
  await git(["init", "--quiet"]);
  // The published tag was already checked to name this commit; HEAD is verified again below.
  await git(["fetch", "--quiet", "--depth", "1", "--no-tags", SOURCE_REPOSITORY, `refs/tags/${version}`], WRITE_TIMEOUT);
  await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  requireGateway((await git(["rev-parse", "HEAD"])).trim() === revision, "release_invalid", "source", "Fetched source differs from the release");
  const modes = (await git(["ls-tree", "-r", "--format=%(objectmode)", "HEAD"])).trim().split("\n");
  requireGateway(modes.every(mode => mode === "100644" || mode === "100755"), "release_invalid", "source",
    "Release source must not contain symlinks or submodules");
  return directory;
}

async function readLive(execute, config, document, phase) {
  const namespace = document.metadata?.namespace;
  const text = await kubectl(execute, config, ["get", document.kind, document.metadata.name,
    ...(namespace ? ["--namespace", namespace] : []), "--ignore-not-found=true", "--output=json"], { phase });
  return text.trim() === "" ? null : parseJson(text, phase, identity(document));
}

async function requireBootstrapUnchanged(execute, config, bootstrap) {
  for (const document of bootstrap) {
    const live = await readLive(execute, config, document, "bootstrap");
    requireGateway(live !== null && bootstrapMatches(document, live), "bootstrap_required", "bootstrap",
      `${identity(document)} differs from the release; update it through bootstrap`);
  }
}

// Apply never deletes, so the project's live objects must already be exactly the rendered ones. Bootstrap
// creates what a release adds and removes what it drops, such as the Console Ingress of a public profile.
async function requireDailyObjectsMatch(execute, config, daily) {
  const rendered = new Set(daily.map(identity));
  for (const namespace of PROJECT_NAMESPACES) {
    const listed = parseJson(await kubectl(execute, config, ["get", DAILY_RESOURCES, "--namespace", namespace,
      `--selector=${PROJECT_SELECTOR}`, "--output=json"], { phase: "preflight" }), "preflight", `${namespace} objects`);
    requireGateway(Array.isArray(listed.items), "command_failed", "preflight", `${namespace} objects are unavailable`);
    const live = new Set(listed.items.map(identity));
    const missing = daily.filter(document => document.metadata.namespace === namespace).map(identity).find(key => !live.has(key));
    requireGateway(missing === undefined, "bootstrap_required", "preflight",
      `${missing} is missing or not labeled as part of this project; create it through bootstrap`);
    const leftover = [...live].find(key => !rendered.has(key) && key !== APPROVAL_IDENTITY);
    requireGateway(leftover === undefined, "bootstrap_required", "preflight",
      `${leftover} is not part of this release; remove it through bootstrap`);
  }
}

// Secrets belong to bootstrap: a release may keep or drop the ones the running version uses, never add one.
function secretReferences(deployment) {
  const pod = deployment?.spec?.template?.spec ?? {};
  const keyed = (name, items) => (items?.length ? items.map(item => `${name}/${item.key}`) : [name]);
  return new Set([
    ...(pod.imagePullSecrets ?? []).map(item => item.name),
    ...(pod.volumes ?? []).flatMap(volume => [
      ...(volume.secret ? keyed(volume.secret.secretName, volume.secret.items) : []),
      ...(volume.projected?.sources ?? []).flatMap(source => (source.secret ? keyed(source.secret.name, source.secret.items) : [])),
    ]),
    ...[...(pod.initContainers ?? []), ...(pod.containers ?? [])].flatMap(container => [
      ...(container.envFrom ?? []).flatMap(entry => (entry.secretRef ? [entry.secretRef.name] : [])),
      ...(container.env ?? []).flatMap(entry => {
        const reference = entry.valueFrom?.secretKeyRef;
        return reference ? [`${reference.name}/${reference.key}`] : [];
      }),
    ]),
  ]);
}

async function requireKnownSecrets(execute, config, daily) {
  for (const deployment of daily.filter(document => document.kind === "Deployment")) {
    const running = secretReferences(await readLive(execute, config, deployment, "preflight"));
    const added = [...secretReferences(deployment)].find(reference => !running.has(reference));
    requireGateway(added === undefined, "bootstrap_required", "preflight",
      `${identity(deployment)} uses Secret ${added} that the running version does not; create it through bootstrap`);
  }
}

// The gateway's own Jobs need what only bootstrap creates; a missing claim would keep the Runtime stopped until the backup times out.
async function requireGatewayPrerequisites(execute, config) {
  for (const document of [{ kind: "ServiceAccount", metadata: { name: JOB_ACCOUNT, namespace: APPLICATION_NAMESPACE } },
    { kind: "PersistentVolumeClaim", metadata: { name: BACKUP_CLAIM, namespace: APPLICATION_NAMESPACE } }]) {
    requireGateway(await readLive(execute, config, document, "preflight") !== null, "bootstrap_required", "preflight",
      `${identity(document)} does not exist; install the gateway through bootstrap`);
  }
}

async function requirePublicApproval(execute, config, daily) {
  if (daily.find(document => identity(document) === RUNTIME_CONFIG_IDENTITY)?.data?.[ACCESS_MODE_KEY] !== "public_demo") return;
  const approval = await readLive(execute, config, { kind: "ConfigMap", metadata: { name: APPROVAL_CONFIGMAP, namespace: APPLICATION_NAMESPACE } },
    "preflight");
  const value = approval?.data?.[APPROVAL_KEY];
  requireGateway(typeof value === "string" && APPROVED_VALUES.has(value.toLowerCase()), "approval_missing", "preflight",
    "Public data is not approved by the installer; the Runtime would refuse to start");
}

function applyList(items) {
  return JSON.stringify({ apiVersion: "v1", kind: "List", items });
}

function job(name, component, containers, volumes, deadline) {
  return {
    apiVersion: "batch/v1", kind: "Job",
    metadata: { name, namespace: APPLICATION_NAMESPACE, labels: { "app.kubernetes.io/name": component, "app.kubernetes.io/part-of": "k8s-incident-agent" } },
    spec: {
      backoffLimit: 0, activeDeadlineSeconds: deadline, ttlSecondsAfterFinished: 3600,
      template: {
        // Without the project label, finished Pods stay out of the status checks that count the project's running Pods.
        metadata: { labels: { "app.kubernetes.io/name": component } },
        spec: {
          restartPolicy: "Never", serviceAccountName: JOB_ACCOUNT, automountServiceAccountToken: false,
          // As for the Runtime itself: a recursive ownership change would widen its private file modes.
          securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" } },
          containers: containers.map(container => ({ ...container, imagePullPolicy: "IfNotPresent",
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } } })),
          ...(volumes.length ? { volumes } : {}),
        },
      },
    },
  };
}

/** Pulls both release images onto the node while the current version keeps serving. */
export function prefetchJob(manifest, suffix) {
  return job(`deploy-prefetch-${suffix}`, "deploy-prefetch", ["console", "runtime"].map(component => ({
    name: component, image: `${manifest.images[component].repository}@${manifest.images[component].indexDigest}`, command: ["/bin/true"],
  })), [], PREFETCH_SECONDS);
}

/** Copies the stopped Runtime's data with the release's own backup command. */
export function backupJob(manifest, suffix) {
  return job(`runtime-backup-${suffix}`, "runtime-backup", [{
    name: "backup", image: `${manifest.images.runtime.repository}@${manifest.images.runtime.indexDigest}`,
    command: ["runtime", "backup", "--destination", BACKUP_MOUNT],
    env: [{ name: "RUNTIME_DATA_DIR", value: `${RUNTIME_DATA_MOUNT}/runtime` }],
    volumeMounts: [{ name: "runtime-data", mountPath: RUNTIME_DATA_MOUNT }, { name: BACKUP_CLAIM, mountPath: BACKUP_MOUNT }],
  }], [
    { name: "runtime-data", persistentVolumeClaim: { claimName: "runtime-data" } },
    { name: BACKUP_CLAIM, persistentVolumeClaim: { claimName: BACKUP_CLAIM } },
  ], BACKUP_SECONDS);
}

async function runJob(execute, config, document, phase, sleep) {
  await kubectl(execute, config, ["create", "--filename=-"], { input: JSON.stringify(document), timeout: WRITE_TIMEOUT, phase });
  const deadline = document.spec.activeDeadlineSeconds * 1000;
  for (let waited = 0; ; waited += POLL_MILLISECONDS) {
    const status = parseJson(await kubectl(execute, config, ["get", "job", document.metadata.name, "--namespace", APPLICATION_NAMESPACE,
      "--output=json"], { phase }), phase, "Job").status ?? {};
    if (status.succeeded >= 1) return;
    requireGateway(!(status.failed >= 1) && !(status.conditions ?? []).some(condition => condition.type === "Failed" && condition.status === "True"),
      `${phase}_failed`, phase, `${document.metadata.name} failed`);
    requireGateway(waited < deadline, `${phase}_failed`, phase, `${document.metadata.name} did not finish in time`);
    await sleep(POLL_MILLISECONDS);
  }
}

// The backup command ends with one JSON line: the directory it kept, or why it refused.
async function backupReport(execute, config, document) {
  const text = await kubectl(execute, config, ["logs", `job/${document.metadata.name}`, "--namespace", APPLICATION_NAMESPACE],
    { phase: "backup" });
  for (const line of text.trim().split("\n").reverse()) {
    let report;
    try { report = JSON.parse(line); } catch { continue; }
    if (object(report)) return report;
  }
  return {};
}

async function runBackup(execute, config, document, sleep) {
  try {
    await runJob(execute, config, document, "backup", sleep);
  } catch (error) {
    const reason = await backupReport(execute, config, document).then(report => report.error?.code, () => undefined);
    if (typeof reason === "string" && /^[a-z_]{1,64}$/.test(reason)) throw new GatewayError("backup_failed", "backup", `${error.message}: ${reason}`);
    throw error;
  }
  const report = await backupReport(execute, config, document);
  requireGateway(typeof report.backup === "string" && BACKUP_NAME.test(report.backup)
    && (report.alembicHead === null || (typeof report.alembicHead === "string" && /^[0-9a-z_]{1,64}$/.test(report.alembicHead))),
  "backup_failed", "backup", "Backup finished without naming its directory and schema");
  return { backup: report.backup, alembicHead: report.alembicHead };
}

// The replaced image names the release a manual rollback returns to, next to the backup taken of its data.
async function runningRuntime(execute, config) {
  const deployment = parseJson(await kubectl(execute, config, ["get", "deployment", RUNTIME_DEPLOYMENT, "--namespace", APPLICATION_NAMESPACE,
    "--output=json"], { phase: "drain" }), "drain", "Runtime Deployment");
  const replicas = deployment.spec?.replicas;
  requireGateway(Number.isInteger(replicas) && replicas >= 0 && replicas <= 1, "command_failed", "drain", "Runtime replica count is not a single writer");
  const image = (deployment.spec?.template?.spec?.containers ?? []).find(container => container?.name === "runtime")?.image;
  return { replicas, image: typeof image === "string" && image.length <= 512 ? image : null };
}

async function scaleRuntime(execute, config, replicas, phase) {
  await kubectl(execute, config, ["scale", `deployment/${RUNTIME_DEPLOYMENT}`, "--namespace", APPLICATION_NAMESPACE, `--replicas=${replicas}`],
    { timeout: WRITE_TIMEOUT, phase });
}

async function waitForRuntimeStopped(execute, config, sleep) {
  for (let waited = 0; ; waited += POLL_MILLISECONDS) {
    const pods = parseJson(await kubectl(execute, config, ["get", "pods", "--namespace", APPLICATION_NAMESPACE,
      "--selector=app.kubernetes.io/name=agent-runtime", "--output=json"], { phase: "drain" }), "drain", "Runtime Pods");
    if (Array.isArray(pods.items) && pods.items.length === 0) return;
    requireGateway(waited < DRAIN_SECONDS * 1000, "drain_failed", "drain", "Runtime did not stop in time");
    await sleep(POLL_MILLISECONDS);
  }
}

async function acquireLock(workRoot) {
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const stat = await lstat(workRoot);
  requireGateway(stat.isDirectory() && !stat.isSymbolicLink(), "config_invalid", "lock", "Gateway work root must be a real directory");
  const lock = path.join(workRoot, "deploy.lock");
  let handle;
  try {
    handle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new GatewayError("deployment_in_progress", "lock", "Another deployment holds the gateway lock");
    throw error;
  }
  await handle.close();
  return () => rm(lock, { force: true });
}

const productionDependencies = {
  execute: executeExternalCommand,
  fetchManifest: fetchPublishedManifest,
  checkoutSource,
  verifyImages: (manifest, source, config) => verifyRegistryRelease(manifest, source, ghcrRegistry(new https.Agent({
    keepAlive: true, ...(config.registryProxy ? { proxyEnv: { HTTPS_PROXY: config.registryProxy } } : {}),
  }))),
  render: renderSourceProfile,
  sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  suffix: () => randomBytes(4).toString("hex"),
  progress: phase => process.stderr.write(`phase ${phase}\n`),
};

/** Deploy one published release; the Runtime stays stopped only between drain and rollout. */
export async function deploy(request, config, overrides = {}) {
  const { execute, fetchManifest, checkoutSource: checkout, verifyImages, render, sleep, suffix, progress } =
    { ...productionDependencies, ...overrides };
  const unlock = await acquireLock(config.workRoot);
  const run = path.join(config.workRoot, `run-${suffix()}`);
  // The installer's shared checks issue their own kubectl calls; the deploy identity is added here.
  const installerExecute = (program, args, options) => execute(program, ["--kubeconfig", config.kubeconfig, ...args], options);
  let phase = "release";
  const enter = name => { phase = name; progress(name); };
  // What a manual rollback needs, reported on failure too as far as the run got.
  const known = {};
  try {
    enter("release");
    await mkdir(run, { mode: 0o700 });
    let manifest;
    try {
      manifest = await fetchManifest(request.version, path.join(run, "release"));
    } catch (error) {
      throw new GatewayError("release_unverified", phase, error instanceof Error && error.message ? error.message : "Release was not verified");
    }
    enter("source");
    const source = await checkout(execute, request.version, manifest.sourceRevision, path.join(run, "source"));
    enter("images");
    await verifyImages(manifest, source, config);
    enter("render");
    const resources = await render(source, manifest, request.profile, config.context, installerExecute);
    enter("scope");
    const { daily, bootstrap } = planScope(resources);
    enter("bootstrap");
    await requireBootstrapUnchanged(execute, config, bootstrap);
    enter("preflight");
    await requireDailyObjectsMatch(execute, config, daily);
    await requireKnownSecrets(execute, config, daily);
    await requireGatewayPrerequisites(execute, config);
    // An interrupted Runtime data cutover still owns the data; install and upgrade refuse it the same way.
    await requireCutoverObjectsAbsent({ context: config.context }, installerExecute);
    await requirePublicApproval(execute, config, daily);
    await kubectl(execute, config, ["apply", "--dry-run=server", "--filename=-"], { input: applyList(daily), timeout: WRITE_TIMEOUT, phase });
    const name = `${manifest.sourceRevision.slice(0, 12)}-${suffix()}`;
    enter("prefetch");
    await runJob(execute, config, prefetchJob(manifest, name), "prefetch", sleep);
    enter("drain");
    const { replicas, image } = await runningRuntime(execute, config);
    known.previousRuntimeImage = image;
    try {
      await scaleRuntime(execute, config, 0, phase);
      await waitForRuntimeStopped(execute, config, sleep);
      enter("backup");
      Object.assign(known, await runBackup(execute, config, backupJob(manifest, name), sleep));
    } catch (error) {
      // Nothing has changed yet, so the stopped version resumes unchanged.
      try {
        await scaleRuntime(execute, config, replicas, phase);
      } catch {
        throw new GatewayError("runtime_not_restored", phase,
          `${error.message}; the Runtime could not be scaled back to ${replicas} and must be scaled manually`);
      }
      throw error;
    }
    enter("apply");
    await kubectl(execute, config, ["apply", "--filename=-"], { input: applyList(daily), timeout: WRITE_TIMEOUT, phase });
    enter("rollout");
    for (const deployment of daily.filter(document => document.kind === "Deployment")) {
      await kubectl(execute, config, ["rollout", "status", `deployment/${deployment.metadata.name}`, "--namespace", deployment.metadata.namespace,
        `--timeout=${ROLLOUT_SECONDS}s`], { timeout: (ROLLOUT_SECONDS + 30) * 1000, phase });
    }
    for (const ingress of daily.filter(document => document.kind === "Ingress")) {
      try {
        requireReadyIngress(await readLive(execute, config, ingress, phase), ingress);
      } catch (error) {
        if (error instanceof DeploymentContractError) throw new GatewayError("rollout_failed", phase, error.message);
        throw error;
      }
    }
    return { status: "deployed", version: request.version, profile: request.profile, sourceRevision: manifest.sourceRevision, ...known };
  } catch (error) {
    let failure;
    if (error instanceof GatewayError) failure = error;
    else if (error instanceof ReleaseError || error instanceof DeploymentContractError) failure = new GatewayError(error.code, phase, error.message);
    else failure = new GatewayError("gateway_failed", phase, error instanceof Error && error.message ? error.message : "Deployment failed");
    failure.details = { ...known };
    throw failure;
  } finally {
    await rm(run, { recursive: true, force: true });
    await unlock();
  }
}

async function readRequest() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    requireGateway(size <= REQUEST_LIMIT_BYTES, "request_invalid", "request", "Send exactly one bounded JSON line");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  // Output is best effort: a dropped SSH session must not end a run between drain and apply.
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
  const args = process.argv.slice(2);
  requireGateway(args.length === 1, "config_invalid", "config", "The forced command passes only the configuration path");
  const environment = { ...process.env };
  // Children see only a fixed environment, never what the SSH session carried.
  for (const key of Object.keys(process.env)) delete process.env[key];
  const config = await loadConfig(args[0]);
  Object.assign(process.env, { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: config.workRoot, TMPDIR: config.workRoot, LANG: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0" });
  const request = parseRequest(await readRequest(), environment, config.profiles);
  process.stdout.write(`${JSON.stringify(await deploy(request, config))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const failure = error instanceof GatewayError ? error : new GatewayError("gateway_failed", "request", "Deployment failed");
    process.stdout.write(`${JSON.stringify({ status: "failed", code: failure.code, phase: failure.phase, message: failure.message,
      ...failure.details })}\n`);
    process.exitCode = 1;
  });
}
