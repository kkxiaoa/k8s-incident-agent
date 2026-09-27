// Runner side of a restricted deployment: the selection job binds a published release before
// approval, and the approved job hands exactly that release to the fixed host's gateway.
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { appendFile, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { approveDispatch, fetchPublishedManifest, jsonRequest, protectedEnvironment } from "./publish.mjs";

const WORKFLOW = ".github/workflows/deploy.yml";
const ENVIRONMENT = "deploy";
const VERSION = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const REVISION = /^[a-f0-9]{40}$/;
const PROFILES = new Set(["k3s-evaluation", "k3s-public"]);
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.:-]{0,252})$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const SECRET_NAMES = ["DEPLOY_SSH_PRIVATE_KEY", "DEPLOY_SSH_KNOWN_HOSTS", "DEPLOY_SSH_HOST", "DEPLOY_SSH_USER"];
const OUTPUT_LIMIT_BYTES = 64 * 1024;
// Above the gateway's own worst case (prefetch, drain, backup and six rollouts) and below the job timeout.
const SSH_TIMEOUT_MILLISECONDS = 145 * 60_000;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

/** The only request the gateway accepts: one line naming a stable version and a gateway profile. */
export function deploymentRequest(version, profile) {
  requireValue(typeof version === "string" && VERSION.test(version) && version.length <= 64 && PROFILES.has(profile),
    "Choose a stable published version and one of the gateway profiles");
  return `${JSON.stringify({ version, profile })}\n`;
}

// Reviewers alone are not enough: the Environment must refuse every branch but main and must not let
// administrators skip its reviewers, which would release the credentials without an approval.
async function requireDeploymentProtection(environment) {
  requireValue(environment.can_admins_bypass === false, "Turn off administrator bypass on the deploy Environment before deploying");
  const policy = environment.deployment_branch_policy;
  const branches = policy?.custom_branch_policies === true && policy.protected_branches === false
    ? await jsonRequest(`/environments/${ENVIRONMENT}/deployment-branch-policies`) : null;
  requireValue(Array.isArray(branches?.branch_policies) && branches.branch_policies.length === 1
    && branches.branch_policies[0].name === "main" && branches.branch_policies[0].type === "branch",
  "Limit the deploy Environment to the main branch before deploying");
}

/** Before approval: the reviewer approves exactly this published release (source and image digests) and profile. */
export async function selectDeployment(version, profile, workDirectory) {
  deploymentRequest(version, profile);
  await requireDeploymentProtection(await protectedEnvironment(ENVIRONMENT));
  const manifest = await fetchPublishedManifest(version, path.join(workDirectory, "release"));
  return { version, profile, sourceRevision: manifest.sourceRevision, images: manifest.images };
}

/** Moves the deployment credentials out of an environment: they are read once, and nothing started later may inherit them. */
export function takeSecrets(environment) {
  const secrets = Object.fromEntries(SECRET_NAMES.map(name => [name, environment[name]]));
  for (const name of SECRET_NAMES) delete environment[name];
  return secrets;
}

function credentialsFrom(environment) {
  const text = name => String(environment[name] ?? "").replaceAll("\r\n", "\n").trim();
  const key = text("DEPLOY_SSH_PRIVATE_KEY");
  const knownHosts = text("DEPLOY_SSH_KNOWN_HOSTS").split("\n").map(line => line.trim()).filter(Boolean);
  const host = text("DEPLOY_SSH_HOST");
  const user = text("DEPLOY_SSH_USER");
  // Messages name the secret, never its value.
  requireValue(key.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----") && key.endsWith("-----END OPENSSH PRIVATE KEY-----"),
    "DEPLOY_SSH_PRIVATE_KEY is not an OpenSSH private key");
  requireValue(knownHosts.length > 0 && knownHosts.every(line => !line.startsWith("@") && line.split(/\s+/).length >= 3),
    "DEPLOY_SSH_KNOWN_HOSTS needs the host's verified known_hosts lines");
  requireValue(HOST.test(host), "DEPLOY_SSH_HOST is not a host name or address");
  requireValue(USER.test(user), "DEPLOY_SSH_USER is not a user name");
  return { key: `${key}\n`, knownHosts: `${knownHosts.join("\n")}\n`, host, user };
}

export function sshArguments(keyFile, knownHostsFile, user, host) {
  return ["-F", "/dev/null", "-T",
    "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", `IdentityFile=${keyFile}`,
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsFile}`, "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "UpdateHostKeys=no", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "RequestTTY=no",
    // Keepalives hold the session through the gateway's quiet phases; a dead link ends it within three minutes.
    "-o", "ConnectTimeout=30", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=6", "-o", "LogLevel=ERROR",
    "--", `${user}@${host}`];
}

function runSsh(args, input, onProgress) {
  return new Promise(resolve => {
    // ssh needs none of the job's variables: the key is already a private file, and the token is for GitHub only.
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    const chunks = [];
    let size = 0;
    let pending = "";
    let gatewayStarted = false;
    const timer = setTimeout(() => child.kill("SIGTERM"), SSH_TIMEOUT_MILLISECONDS);
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT_BYTES) child.kill("SIGTERM");
      else chunks.push(chunk);
    });
    // Only the gateway's phase lines reach the log; ssh's own errors could name the host.
    child.stderr.on("data", chunk => {
      const lines = `${pending}${chunk}`.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!/^phase [a-z]+$/.test(line)) continue;
        gatewayStarted = true;
        onProgress(line);
      }
    });
    // ssh may exit before reading the request, for example on an unverified host key.
    child.stdin.on("error", () => {});
    child.on("error", () => { clearTimeout(timer); resolve({ exitCode: null, stdout: "", started: false, gatewayStarted }); });
    child.on("close", exitCode => {
      clearTimeout(timer);
      resolve({ exitCode, stdout: Buffer.concat(chunks).toString("utf8"), started: true, gatewayStarted });
    });
    child.stdin.end(input);
  });
}

/** Reads the gateway's one-line result and holds it to the approved selection; any result is kept for the summary. */
export function interpretResult({ exitCode, stdout, started = true, gatewayStarted = false }, selection) {
  requireValue(started, "Could not start ssh on the runner");
  let result;
  try { result = JSON.parse(stdout.trim().split("\n").at(-1)); } catch { result = undefined; }
  if (result?.status === "deployed") {
    if (result.version !== selection.version || result.profile !== selection.profile || result.sourceRevision !== selection.sourceRevision) {
      return { ok: false, result, problem: "The gateway reported a deployment other than the approved one" };
    }
    if (exitCode !== 0) return { ok: false, result, problem: "The gateway reported success but the session did not end cleanly; check the cluster" };
    return { ok: true, result };
  }
  if (result?.status === "failed" && typeof result.code === "string" && typeof result.phase === "string") return { ok: false, result };
  // ssh also exits 255 when an open session drops, so a gateway that already started may still be working on the host.
  if (exitCode === 255 && !gatewayStarted) throw new Error("Could not reach the deployment gateway over SSH");
  throw new Error("The deployment gateway returned no readable result; check the cluster before a fresh dispatch");
}

export function resultSummary(selection, { ok, result, problem }) {
  const lines = [ok
    ? `Deployed ${selection.version} (${selection.profile}) from ${selection.sourceRevision}.`
    : problem ?? `Deployment of ${selection.version} (${selection.profile}) failed in phase \`${result.phase}\`: \`${result.code}\` ${result.message ?? ""}`.trim()];
  for (const [label, key] of [["Replaced Runtime image", "previousRuntimeImage"], ["Backup", "backup"], ["Alembic head of the backup", "alembicHead"]]) {
    if (Object.hasOwn(result, key)) lines.push(`- ${label}: \`${result[key] ?? "unknown"}\``);
  }
  return `${lines.join("\n")}\n`;
}

/** After approval: this run's recorded approval, the same release, then one request to the gateway. */
export async function runDeployment(selection, environment, { workRoot, ssh = runSsh, onProgress = () => {} }) {
  requireValue(REVISION.test(selection.sourceRevision) && selection.images !== null && typeof selection.images === "object",
    "The selection carries no source revision or image digests");
  const request = deploymentRequest(selection.version, selection.profile);
  const credentials = credentialsFrom(environment);
  await requireDeploymentProtection(await approveDispatch(WORKFLOW, ENVIRONMENT));
  const manifest = await fetchPublishedManifest(selection.version, path.join(workRoot, "release"));
  requireValue(manifest.sourceRevision === selection.sourceRevision && isDeepStrictEqual(manifest.images, selection.images),
    "The release changed while awaiting approval; start a fresh dispatch");
  const secrets = await mkdtemp(path.join(workRoot, "ssh-"));
  try {
    await chmod(secrets, 0o700);
    const keyFile = path.join(secrets, "id");
    const knownHostsFile = path.join(secrets, "known_hosts");
    await writeFile(keyFile, credentials.key, { mode: 0o600, flag: "wx" });
    await writeFile(knownHostsFile, credentials.knownHosts, { mode: 0o600, flag: "wx" });
    return interpretResult(await ssh(sshArguments(keyFile, knownHostsFile, credentials.user, credentials.host), request, onProgress), selection);
  } finally {
    await rm(secrets, { recursive: true, force: true });
  }
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  requireValue(args.length === 0 && ["select", "deploy"].includes(action), "Use deploy-dispatch.mjs select|deploy in the deploy workflow");
  const workRoot = await mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "deploy-dispatch-"));
  try {
    if (action === "select") {
      const selection = await selectDeployment(process.env.DEPLOY_VERSION, process.env.DEPLOY_PROFILE, workRoot);
      for (const key of ["version", "profile", "sourceRevision"]) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${selection[key]}\n`);
      await appendFile(process.env.GITHUB_OUTPUT, `images=${JSON.stringify(selection.images)}\n`);
      await appendFile(process.env.GITHUB_STEP_SUMMARY, [`Deploy ${selection.version} with profile \`${selection.profile}\` to the fixed host.`, "",
        `Source: ${selection.sourceRevision}`, "",
        ...Object.entries(selection.images).map(([component, image]) => `- ${component}: \`${image.repository}@${image.indexDigest}\``), "",
        "Approving the deploy Environment deploys exactly this release; a changed release or a rerun needs a fresh dispatch.", ""].join("\n"));
      return;
    }
    let images;
    try { images = JSON.parse(process.env.DEPLOY_IMAGES ?? ""); } catch { images = null; }
    const selection = { version: process.env.DEPLOY_VERSION, profile: process.env.DEPLOY_PROFILE, sourceRevision: process.env.DEPLOY_SOURCE, images };
    const outcome = await runDeployment(selection, takeSecrets(process.env), { workRoot, onProgress: line => console.log(line) });
    await appendFile(process.env.GITHUB_STEP_SUMMARY, resultSummary(selection, outcome));
    console.log(JSON.stringify(outcome.result));
    if (outcome.problem) console.error(`FAIL deployment_dispatch: ${outcome.problem}`);
    if (!outcome.ok) process.exitCode = 1;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`FAIL deployment_dispatch: ${error.message}`); process.exitCode = 1; });
}
