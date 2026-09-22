import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadRelease } from "./release.mjs";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = "kkxiaoa/k8s-incident-agent";
const apiRoot = `https://api.github.com/repos/${repository}`;
const sha = /^[a-f0-9]{40}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const gib = 1024 ** 3;

function requireValue(value, message) {
  if (!value) throw new Error(message);
}

function id(value) {
  requireValue(/^[1-9][0-9]{0,14}$/.test(String(value)), "Invalid GitHub identity");
  return Number(value);
}

function version(value) {
  requireValue(/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value) && value.length <= 64,
    "Use a stable version such as v0.1.0");
  return value;
}

function headers(accept = "application/vnd.github+json") {
  return { Accept: accept, "X-GitHub-Api-Version": "2022-11-28",
    ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) };
}

async function response(url, options = {}) {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: "manual", ...options });
  } catch {
    throw new Error("Release HTTP request failed; retry with the same candidate after checking service availability");
  }
}

async function jsonRequest(endpoint, { method = "GET", body, missing = false } = {}) {
  const res = await response(`${apiRoot}${endpoint}`, { method, headers: { ...headers(), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (missing && res.status === 404) return null;
  requireValue(res.ok, `GitHub ${method} failed (${res.status}); no automatic overwrite or rollback`);
  const bytes = await limitedBytes(res, 2 * 1024 * 1024);
  try { return JSON.parse(bytes); } catch { throw new Error("Invalid GitHub JSON response"); }
}

async function limitedBytes(res, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    requireValue(size <= limit, "HTTP response exceeded size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function pages(endpoint, field) {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const result = await jsonRequest(`${endpoint}?per_page=100&page=${page}`);
    const batch = field ? result[field] : result;
    requireValue(Array.isArray(batch), "Invalid GitHub list response");
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error("GitHub pagination budget exceeded");
}

async function download(endpoint, filename, expectedDigest, limit) {
  let res = await response(`${apiRoot}${endpoint}`, { headers: headers("application/octet-stream") });
  if (res.status === 302) {
    const location = new URL(res.headers.get("location"));
    requireValue(location.protocol === "https:" && !location.username && !location.password && !location.port &&
      (location.hostname.endsWith(".blob.core.windows.net") || location.hostname.endsWith(".actions.githubusercontent.com") ||
       location.hostname === "release-assets.githubusercontent.com"), "Unexpected artifact download destination");
    // The signed download receives no API authorization header.
    res = await response(location.href);
  }
  requireValue(res.status === 200, `Artifact download failed (${res.status}); missing/expired content cannot be rebuilt here`);
  const output = await open(filename, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of res.body) {
      size += chunk.length;
      requireValue(size <= limit, "Artifact download exceeded size limit");
      hash.update(chunk);
      await output.writeFile(chunk);
    }
  } finally { await output.close(); }
  requireValue(`sha256:${hash.digest("hex")}` === expectedDigest, "Downloaded artifact digest mismatch");
}

async function command(program, args, timeout = 120_000) {
  try { return (await exec(program, args, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout; }
  catch { throw new Error(`${program} failed in release preparation; remote partial state is retained`); }
}

async function protectedEnvironment() {
  const environment = await jsonRequest("/environments/release");
  requireValue(environment.name === "release" && environment.protection_rules?.some(rule =>
    rule.type === "required_reviewers" && rule.reviewers?.length > 0),
  "Configure required reviewers on the release Environment before publishing");
  return environment;
}

/** The read-only selection job and approved publisher use the same authority. */
export async function selectCandidate(runId, artifactId) {
  runId = id(runId); artifactId = id(artifactId);
  const workflow = await jsonRequest("/actions/workflows/ci.yml");
  const run = await jsonRequest(`/actions/runs/${runId}`);
  requireValue(run.id === runId && run.workflow_id === workflow.id && run.path === ".github/workflows/ci.yml" &&
    run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
    run.repository.id === run.head_repository.id && run.event === "push" && run.head_branch === "main" &&
    sha.test(run.head_sha) && run.status === "completed" && run.conclusion === "success", "Candidate is not a successful owning-main CI run");
  const attempt = id(run.run_attempt);
  const jobs = await pages(`/actions/runs/${runId}/attempts/${attempt}/jobs`, "jobs");
  for (const name of ["Runtime checks", "Scripts and deployment contracts", "Console checks and fake E2E",
    "Public docs and CI security", "Same-source multi-platform OCI candidate"]) {
    const matches = jobs.filter(job => job.name === name);
    requireValue(matches.length === 1 && matches[0].head_sha === run.head_sha && matches[0].run_id === runId &&
      matches[0].status === "completed" && matches[0].conclusion === "success", "Required candidate CI job did not succeed in this attempt");
  }
  const artifact = await jsonRequest(`/actions/artifacts/${artifactId}`);
  requireValue(artifact.id === artifactId && artifact.name === `oci-candidate-${run.head_sha}-${attempt}` &&
    artifact.expired === false && Date.parse(artifact.expires_at) > Date.now() && digest.test(artifact.digest) &&
    Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= gib &&
    artifact.workflow_run?.id === runId && artifact.workflow_run.head_sha === run.head_sha &&
    artifact.workflow_run.head_branch === "main" && artifact.workflow_run.repository_id === run.repository.id &&
    artifact.workflow_run.head_repository_id === run.repository.id, "Candidate artifact is missing, expired or belongs to another source/attempt");
  return { runId, attempt, artifactId, source: run.head_sha, artifactDigest: artifact.digest };
}

async function approveDispatch() {
  requireValue(process.env.GITHUB_REPOSITORY === repository && process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    process.env.GITHUB_REF === "refs/heads/main" && process.env.GITHUB_RUN_ATTEMPT === "1", "Publish requires a fresh owning-main manual dispatch");
  const runId = id(process.env.GITHUB_RUN_ID);
  const run = await jsonRequest(`/actions/runs/${runId}`);
  requireValue(run.path === ".github/workflows/release.yml" && run.event === "workflow_dispatch" && run.head_branch === "main" &&
    run.head_sha === process.env.GITHUB_SHA && run.run_attempt === 1 && run.repository?.full_name === repository,
  "Unexpected publication workflow source");
  const environment = await protectedEnvironment();
  const approvals = await jsonRequest(`/actions/runs/${runId}/approvals`);
  requireValue(Array.isArray(approvals) && approvals.some(review => review.state === "approved" &&
    review.environments?.some(item => item.id === environment.id && item.name === "release")),
  "No recorded human approval for this release dispatch");
}

function sameSelection(actual, expected) {
  requireValue(Object.keys(actual).every(key => String(actual[key]) === String(expected[key])),
    "Candidate identity changed while awaiting approval; start a fresh dispatch");
}

async function unpack(transport, bundle, source) {
  await command("python3", [path.join(root, "scripts/release-archive.py"), "tar", transport, bundle]);
  return loadRelease(path.join(bundle, "release.json"), source);
}

async function fileDigest(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

async function registryClient(scratch) {
  const tools = JSON.parse(await readFile(path.join(root, ".github/ci/release-tools.json"), "utf8"));
  const auth = path.join(scratch, "auth.json");
  const anonymousAuth = path.join(scratch, "anonymous-auth.json");
  requireValue(process.env.GH_TOKEN && process.env.GITHUB_ACTOR, "Publishing token and actor are required");
  await writeFile(auth, JSON.stringify({ auths: { "ghcr.io": {
    auth: Buffer.from(`${process.env.GITHUB_ACTOR}:${process.env.GH_TOKEN}`).toString("base64"),
  } } }), { flag: "wx", mode: 0o600 });
  await writeFile(anonymousAuth, JSON.stringify({ auths: {} }), { flag: "wx", mode: 0o600 });
  await command("docker", ["pull", tools.skopeo], 300_000);
  async function skopeo(args, bundle, missing = false) {
    const dockerArgs = ["run", "--rm", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--user", `${process.getuid()}:${process.getgid()}`, "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777",
      "--tmpfs", "/var/tmp:rw,nosuid,nodev,mode=1777", "--volume", `${auth}:/auth.json:ro`,
      "--volume", `${anonymousAuth}:/anonymous-auth.json:ro`,
      ...(bundle ? ["--volume", `${bundle}:/bundle:ro`] : []), tools.skopeo, ...args];
    try { return (await exec("docker", dockerArgs, { timeout: 20 * 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout; }
    catch (error) {
      // A network/authentication/unknown CLI error must never be mistaken for an unused tag.
      if (missing && /(?:manifest unknown|name unknown)/i.test(error.stderr ?? "")) return null;
      throw new Error("Registry operation failed; any draft/assets/images already uploaded remain partial");
    }
  }
  return {
    inspect: (reference, missing = false, anonymous = false) => skopeo(["inspect", "--authfile",
      anonymous ? "/anonymous-auth.json" : "/auth.json", "--raw", `docker://${reference}`], undefined, missing),
    copy: (component, reference, bundle) => skopeo(["copy", "--authfile", "/auth.json", "--all", "--preserve-digests",
      `oci:/bundle/${component}-oci`, `docker://${reference}`], bundle),
  };
}

function checkRaw(raw, expected) {
  requireValue(raw !== null && `sha256:${createHash("sha256").update(raw).digest("hex")}` === expected,
    "Registry rewrote or substituted OCI content");
}

async function registryVerify(registry, image, tag, anonymous = false) {
  checkRaw(await registry.inspect(`${image.repository}:${tag}`, false, anonymous), image.indexDigest);
  checkRaw(await registry.inspect(`${image.repository}@${image.indexDigest}`, false, anonymous), image.indexDigest);
  for (const child of Object.values(image.platforms)) checkRaw(await registry.inspect(`${image.repository}@${child}`, false, anonymous), child);
}

async function releaseByVersion(tag) {
  const releases = await pages("/releases");
  const matching = releases.filter(release => release.tag_name === tag);
  requireValue(matching.length <= 1, "Multiple releases claim this version");
  return matching[0] ?? null;
}

async function checkTag(tag, source) {
  const ref = await jsonRequest(`/git/ref/tags/${tag}`, { missing: true });
  if (ref) requireValue(ref.object?.type === "commit" && ref.object.sha === source, "Version tag already points at a different source");
  return ref;
}

async function uploadAsset(releaseId, file, existing) {
  const { name, filename, size, digest: expectedDigest } = file;
  if (existing) {
    requireValue(existing.state === "uploaded" && existing.size === size && existing.digest === expectedDigest,
      "Existing release attachment conflicts or is incomplete; retain draft for manual inspection");
    return;
  }
  const res = await response(`https://uploads.github.com/repos/${repository}/releases/${id(releaseId)}/assets?name=${name}`, {
    method: "POST", headers: { ...headers(), "Content-Type": "application/octet-stream", "Content-Length": String(size) },
    body: createReadStream(filename), duplex: "half",
  });
  requireValue(res.status === 201, `Release attachment upload failed (${res.status}); retain draft`);
  let asset;
  try { asset = JSON.parse(await limitedBytes(res, 2 * 1024 * 1024)); }
  catch { throw new Error("Invalid upload response; retain draft for inspection"); }
  requireValue(asset.name === name && asset.state === "uploaded" && asset.size === size && asset.digest === expectedDigest,
    "Uploaded attachment identity differs; retain draft");
}

/** Called only by the protected publication job; no build or artifact code execution. */
export async function publishCandidate(options) {
  const tag = version(options.version);
  await approveDispatch();
  const selection = await selectCandidate(options.runId, options.artifactId);
  sameSelection(selection, options);
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "incident-publish-")));
  try {
    const archive = path.join(scratch, "artifact.zip");
    const transport = path.join(scratch, "transport");
    const bundle = path.join(scratch, "bundle");
    await download(`/actions/artifacts/${selection.artifactId}/zip`, archive, selection.artifactDigest, gib);
    await command("python3", [path.join(root, "scripts/release-archive.py"), "zip", archive, transport]);
    const manifest = await unpack(transport, bundle, options.sourceDirectory);
    requireValue(manifest.sourceRevision === selection.source, "Bundle source differs from approved CI source");
    const assetPaths = { "release.json": path.join(bundle, "release.json"), "candidate.tar.gz": path.join(transport, "candidate.tar.gz"),
      SHA256SUMS: path.join(transport, "SHA256SUMS") };
    const assets = Object.fromEntries(await Promise.all(Object.entries(assetPaths).map(async ([name, filename]) =>
      [name, { name, filename, size: (await stat(filename)).size, digest: await fileDigest(filename) }])));
    let release = await releaseByVersion(tag);
    const ref = await checkTag(tag, manifest.sourceRevision);
    if (release) requireValue(release.target_commitish === manifest.sourceRevision && release.prerelease === false &&
      typeof release.draft === "boolean",
      "Existing release version belongs to another candidate");
    const existingAssets = release ? await pages(`/releases/${id(release.id)}/assets`) : [];
    requireValue(existingAssets.every(item => Object.hasOwn(assets, item.name)) &&
      new Set(existingAssets.map(item => item.name)).size === existingAssets.length, "Unexpected or duplicate release attachments");
    // Reject all known collisions before the first remote mutation.
    for (const asset of existingAssets) await uploadAsset(release.id, assets[asset.name], asset);
    const registry = await registryClient(scratch);
    const present = {};
    for (const [component, image] of Object.entries(manifest.images)) {
      const raw = await registry.inspect(`${image.repository}:${tag}`, true);
      present[component] = raw !== null;
      if (raw !== null) checkRaw(raw, image.indexDigest);
    }
    if (release?.draft === false) {
      requireValue(ref && existingAssets.length === 3 && Object.values(present).every(Boolean), "Published release is incomplete; refuse mutation");
      for (const image of Object.values(manifest.images)) await registryVerify(registry, image, tag, true);
      return { version: tag, source: manifest.sourceRevision, status: "already-published" };
    }
    if (!release) release = await jsonRequest("/releases", { method: "POST", body: {
      tag_name: tag, target_commitish: manifest.sourceRevision, name: tag, draft: true, prerelease: false,
      body: `Source: ${manifest.sourceRevision}\nCandidate CI: https://github.com/${repository}/actions/runs/${selection.runId}/attempts/${selection.attempt}\nArtifact: ${selection.artifactId}\n\nBoth platforms passed container startup checks in candidate CI. Cluster diagnosis, controlled repair and public HTTPS acceptance remain deferred. Use exact OCI digests from release.json.`,
    } });
    for (const file of Object.values(assets)) {
      await uploadAsset(release.id, file, existingAssets.find(item => item.name === file.name));
    }
    for (const [component, image] of Object.entries(manifest.images)) {
      if (!present[component]) await registry.copy(component, `${image.repository}:${tag}`, bundle);
      await registryVerify(registry, image, tag);
    }
    // New GHCR packages default to private; settings changes require the maintainer.
    for (const image of Object.values(manifest.images)) await registryVerify(registry, image, tag, true);
    sameSelection(await selectCandidate(selection.runId, selection.artifactId), selection);
    const finalAssets = await pages(`/releases/${id(release.id)}/assets`);
    requireValue(finalAssets.length === 3 && new Set(finalAssets.map(item => item.name)).size === 3, "Release attachments changed before publication");
    for (const file of Object.values(assets)) {
      const asset = finalAssets.find(item => item.name === file.name);
      requireValue(asset, "Missing final attachment");
      await uploadAsset(release.id, file, asset);
    }
    if (!await checkTag(tag, manifest.sourceRevision)) await jsonRequest("/git/refs", { method: "POST", body: {
      ref: `refs/tags/${tag}`, sha: manifest.sourceRevision,
    } });
    requireValue(await checkTag(tag, manifest.sourceRevision), "Version tag creation not confirmed; retain draft");
    const current = await jsonRequest(`/releases/${id(release.id)}`);
    requireValue(current.draft === true && current.tag_name === tag && current.target_commitish === manifest.sourceRevision &&
      current.prerelease === false, "Draft changed before publication; inspect remote state");
    const published = await jsonRequest(`/releases/${id(release.id)}`, { method: "PATCH", body: { draft: false, make_latest: "false" } });
    requireValue(published.draft === false && published.tag_name === tag, "Publication not confirmed; inspect remote state before retry");
    return { version: tag, source: manifest.sourceRevision, status: "published" };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** Only a complete, published Release can become an installation bundle via this entry. */
export async function fetchPublishedRelease(tag, output, sourceDirectory) {
  version(tag);
  const release = await jsonRequest(`/releases/tags/${tag}`);
  requireValue(release.draft === false && release.prerelease === false && release.tag_name === tag && sha.test(release.target_commitish),
    "Only a published stable release can be installed");
  requireValue(await checkTag(tag, release.target_commitish), "Published source tag is missing");
  const assets = await pages(`/releases/${id(release.id)}/assets`);
  requireValue(assets.length === 3 && ["candidate.tar.gz", "SHA256SUMS", "release.json"].every(name =>
    assets.filter(item => item.name === name && item.state === "uploaded" && digest.test(item.digest)).length === 1), "Published release is incomplete");
  await mkdir(output, { mode: 0o700 });
  const transport = path.join(output, "transport");
  await mkdir(transport, { mode: 0o700 });
  for (const asset of assets) await download(`/releases/assets/${id(asset.id)}`, path.join(transport, asset.name), asset.digest,
    asset.name === "candidate.tar.gz" ? gib : 2 * 1024 * 1024);
  const manifest = await unpack(transport, path.join(output, "bundle"), sourceDirectory);
  requireValue(manifest.sourceRevision === release.target_commitish &&
    await fileDigest(path.join(output, "bundle/release.json")) === assets.find(item => item.name === "release.json").digest,
  "Published manifest differs from bundle/source");
  const latest = await jsonRequest(`/releases/${id(release.id)}`);
  requireValue(latest.draft === false && latest.tag_name === tag && latest.target_commitish === manifest.sourceRevision &&
    latest.prerelease === false && await checkTag(tag, manifest.sourceRevision), "Release publication changed during download");
  return manifest;
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (action === "select" && args.length === 0) {
    version(process.env.RELEASE_VERSION);
    await protectedEnvironment();
    const selection = await selectCandidate(process.env.CANDIDATE_RUN_ID, process.env.CANDIDATE_ARTIFACT_ID);
    for (const [key, value] of Object.entries(selection)) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `Release ${process.env.RELEASE_VERSION}\n\nSource: ${selection.source}\n\nCI run: ${selection.runId}, attempt: ${selection.attempt}\n\nArtifact: ${selection.artifactId}\n\nZIP digest: ${selection.artifactDigest}\n`);
  } else if (action === "publish" && args.length === 0) {
    console.log(JSON.stringify(await publishCandidate({ version: process.env.RELEASE_VERSION, runId: process.env.CANDIDATE_RUN_ID,
      artifactId: process.env.CANDIDATE_ARTIFACT_ID, attempt: process.env.CANDIDATE_ATTEMPT, source: process.env.CANDIDATE_SOURCE,
      artifactDigest: process.env.CANDIDATE_DIGEST, sourceDirectory: process.env.CANDIDATE_SOURCE_DIR })));
  } else if (action === "fetch" && args.length === 4 && args[0] === "--version" && args[2] === "--output") {
    console.log(JSON.stringify(await fetchPublishedRelease(args[1], path.resolve(args[3]), process.cwd()), null, 2));
  } else throw new Error("Use publish.mjs select|publish in the release workflow, or fetch --version vX.Y.Z --output <new-directory>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`FAIL release_publication: ${error.message}`); process.exitCode = 1; });
}
