import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

const exec = promisify(execFile);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const JSON_LIMIT = 2 * 1024 * 1024;
const INDEX = "application/vnd.oci.image.index.v1+json";
const MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const CONFIG = "application/vnd.oci.image.config.v1+json";
const LAYERS = new Set([
  "application/vnd.oci.image.layer.v1.tar",
  "application/vnd.oci.image.layer.v1.tar+gzip",
  "application/vnd.oci.image.layer.v1.tar+zstd",
]);
const PLATFORMS = ["linux/amd64", "linux/arm64"];
const REPOSITORIES = {
  console: "ghcr.io/kkxiaoa/k8s-incident-agent-console",
  runtime: "ghcr.io/kkxiaoa/k8s-incident-agent-runtime",
};
// GHCR serves blobs through a redirect to GitHub's package CDN.
const REGISTRY_HOSTS = new Set(["ghcr.io", "pkg-containers.githubusercontent.com"]);
const REGISTRY_TIMEOUT = 30_000;

export class ReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseError";
    this.code = code;
  }
}

function requireContract(condition, code, message) {
  if (!condition) throw new ReleaseError(code, message);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keys(value, expected) {
  return object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

async function command(program, args, cwd, timeout = 30_000) {
  try {
    return (await exec(program, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch {
    throw new ReleaseError("release_command_failed", `${program} failed while preparing or checking the release`);
  }
}

async function sourceRevision(repositoryRoot) {
  const root = await realpath(repositoryRoot);
  const top = (await command("git", ["rev-parse", "--show-toplevel"], root)).trim();
  requireContract(await realpath(top) === root, "release_source_invalid", "Use the repository root");
  const status = await command("git", ["status", "--porcelain=v1", "--untracked-files=all"], root);
  requireContract(status.trim() === "", "release_worktree_dirty", "Release operations require a clean committed source tree");
  const revision = (await command("git", ["rev-parse", "HEAD"], root)).trim();
  requireContract(REVISION.test(revision), "release_source_invalid", "Source must be a full Git commit SHA");
  return revision;
}

async function directory(filename) {
  const stat = await lstat(filename);
  requireContract(stat.isDirectory() && !stat.isSymbolicLink(), "release_artifact_invalid", "Release directories must not be links");
}

async function readContent(filename, descriptor, json) {
  const stat = await lstat(filename);
  requireContract(stat.isFile() && !stat.isSymbolicLink(), "release_artifact_invalid", "Release content must be a regular file");
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await handle.stat();
    requireContract(actual.isFile() && (!json || actual.size <= JSON_LIMIT), "release_artifact_invalid", "Invalid release content size or type");
    if (descriptor) requireContract(actual.size === descriptor.size, "release_artifact_invalid", "OCI descriptor size does not match content");
    const hash = createHash("sha256");
    const chunks = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      requireContract(size <= actual.size, "release_artifact_invalid", "Release content changed during verification");
      hash.update(chunk);
      if (json) chunks.push(chunk);
    }
    requireContract(size === actual.size && (!descriptor || `sha256:${hash.digest("hex")}` === descriptor.digest),
      "release_artifact_invalid", "OCI content checksum does not match");
    if (!json) return;
    return decodeJson(Buffer.concat(chunks));
  } finally {
    await handle.close();
  }
}

function decodeJson(bytes) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ReleaseError("release_artifact_invalid", "Release JSON is invalid");
  }
}

function indexShape(value) {
  return object(value) && value.schemaVersion === 2 && (!value.mediaType || value.mediaType === INDEX) && Array.isArray(value.manifests);
}

// A transport bundle's OCI layout; `files` records the verified graph for packing.
function bundleLayout(bundleRoot, component, files) {
  const layout = path.join(bundleRoot, `${component}-oci`);
  return {
    async index() {
      for (const dir of [layout, path.join(layout, "blobs"), path.join(layout, "blobs", "sha256")]) await directory(dir);
      const header = await readContent(path.join(layout, "oci-layout"), undefined, true);
      files?.add(`${component}-oci/oci-layout`);
      requireContract(header?.imageLayoutVersion === "1.0.0", "release_artifact_invalid", "Unsupported OCI layout");
      const root = await readContent(path.join(layout, "index.json"), undefined, true);
      files?.add(`${component}-oci/index.json`);
      requireContract(indexShape(root) && root.manifests.length === 1, "release_artifact_invalid", "OCI layout must select exactly one image index");
      return root.manifests[0];
    },
    async read(descriptor, json) {
      const value = await readContent(path.join(layout, "blobs", "sha256", descriptor.digest.slice(7)), descriptor, json);
      files?.add(`${component}-oci/blobs/sha256/${descriptor.digest.slice(7)}`);
      return value;
    },
  };
}

// A published image in the registry, addressed from the release manifest's index digest.
function registryLayout(registry, image) {
  return {
    index: () => registry.describe(image.repository, image.indexDigest),
    // Layers are not fetched here: the node's pull verifies them by digest against these checked manifests.
    read: (descriptor, json) => json ? registry.read(image.repository, descriptor) : undefined,
  };
}

async function inspectImage(layout, component, revision) {
  const seen = new Map();
  async function blob(descriptor, mediaTypes, json = true) {
    requireContract(object(descriptor) && mediaTypes.has(descriptor.mediaType) && DIGEST.test(descriptor.digest)
      && Number.isSafeInteger(descriptor.size) && descriptor.size > 0,
    "release_artifact_invalid", "Invalid OCI descriptor");
    const previous = seen.get(descriptor.digest);
    if (previous) {
      requireContract(previous.size === descriptor.size && previous.mediaType === descriptor.mediaType,
        "release_artifact_invalid", "Conflicting OCI descriptors");
      return previous.value;
    }
    const value = await layout.read(descriptor, json);
    seen.set(descriptor.digest, { size: descriptor.size, mediaType: descriptor.mediaType, value });
    return value;
  }
  const root = await layout.index();
  const index = await blob(root, new Set([INDEX]));
  requireContract(indexShape(index) && index.manifests.length === PLATFORMS.length,
    "release_artifact_invalid", "Release index must contain exactly two runnable platforms without attestations");
  const platforms = {};
  for (const child of index.manifests) {
    const platform = `${child?.platform?.os}/${child?.platform?.architecture}`;
    requireContract(PLATFORMS.includes(platform) && !Object.hasOwn(platforms, platform), "release_artifact_invalid", "Invalid or repeated release platform");
    const manifest = await blob(child, new Set([MANIFEST]));
    requireContract(object(manifest) && manifest.schemaVersion === 2 && (!manifest.mediaType || manifest.mediaType === MANIFEST)
      && Array.isArray(manifest.layers), "release_artifact_invalid", "Invalid OCI image manifest");
    const config = await blob(manifest.config, new Set([CONFIG]));
    requireContract(`${config?.os}/${config?.architecture}` === platform && config?.config?.User === "10001:10001",
      "release_artifact_invalid", "Image platform or non-root identity does not match the release contract");
    requireContract(config?.config?.Labels?.["org.opencontainers.image.revision"] === revision,
      "release_revision_mismatch", "Image revision differs from the selected source");
    for (const layer of manifest.layers) await blob(layer, LAYERS, false);
    platforms[platform] = child.digest;
  }
  return { repository: REPOSITORIES[component], indexDigest: root.digest, platforms };
}

function validateManifest(manifest) {
  requireContract(keys(manifest, ["schemaVersion", "sourceRevision", "images"]) && manifest.schemaVersion === 1
    && REVISION.test(manifest.sourceRevision) && keys(manifest.images, Object.keys(REPOSITORIES)),
  "release_contract_invalid", "Invalid release manifest");
  for (const [component, repository] of Object.entries(REPOSITORIES)) {
    const image = manifest.images[component];
    requireContract(keys(image, ["repository", "indexDigest", "platforms"]) && image.repository === repository
      && DIGEST.test(image.indexDigest) && keys(image.platforms, PLATFORMS)
      && Object.values(image.platforms).every(digest => DIGEST.test(digest)),
    "release_contract_invalid", "Invalid release image identity");
  }
}

/** Verify content and source once before passing this manifest to deployment/evaluation. */
export async function loadRelease(releasePath, repositoryRoot) {
  return (await verifyRelease(releasePath, repositoryRoot)).manifest;
}

async function verifyRelease(releasePath, repositoryRoot) {
  try {
    requireContract(typeof releasePath === "string" && path.basename(releasePath) === "release.json",
      "release_contract_invalid", "Select an explicit bundle release.json");
    const revision = await sourceRevision(repositoryRoot);
    const manifestPath = path.resolve(releasePath);
    const bundleRoot = await realpath(path.dirname(manifestPath));
    const manifest = await readContent(path.join(bundleRoot, path.basename(manifestPath)), undefined, true);
    validateManifest(manifest);
    requireContract(manifest.sourceRevision === revision, "release_revision_mismatch", "Release source does not match the current committed source");
    const files = new Set(["release.json"]);
    for (const component of Object.keys(REPOSITORIES)) {
      const actual = await inspectImage(bundleLayout(bundleRoot, component, files), component, revision);
      requireContract(isDeepStrictEqual(actual, manifest.images[component]), "release_artifact_invalid", "OCI content differs from the release manifest");
    }
    requireContract(await sourceRevision(repositoryRoot) === revision, "release_revision_mismatch", "Source changed during verification");
    return { manifest, files, bundleRoot };
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError("release_artifact_invalid", "Release files are missing, inaccessible or unsafe");
  }
}

/** Verify a published manifest against its registry images and the checked-out source it names. */
export async function verifyRegistryRelease(manifest, repositoryRoot, registry) {
  try {
    validateManifest(manifest);
    const revision = await sourceRevision(repositoryRoot);
    requireContract(manifest.sourceRevision === revision, "release_revision_mismatch", "Release source does not match the checked-out source");
    for (const component of Object.keys(REPOSITORIES)) {
      const image = manifest.images[component];
      const actual = await inspectImage(registryLayout(registry, image), component, revision);
      requireContract(isDeepStrictEqual(actual, image), "release_artifact_invalid", "Registry content differs from the release manifest");
    }
    requireContract(await sourceRevision(repositoryRoot) === revision, "release_revision_mismatch", "Source changed during verification");
    return manifest;
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError("release_registry_unavailable", "Published images could not be read from the registry");
  }
}

/** Anonymous reads of the published images; `agent` carries the host's route to the registry. */
export function ghcrRegistry(agent) {
  const tokens = new Map();
  const endpoint = (repository, kind, digest) => `https://ghcr.io/v2/${repository.slice("ghcr.io/".length)}/${kind}/${digest}`;
  async function authorization(repository) {
    if (!tokens.has(repository)) {
      const scope = encodeURIComponent(`repository:${repository.slice("ghcr.io/".length)}:pull`);
      const res = await registryRequest(agent, `https://ghcr.io/token?scope=${scope}&service=ghcr.io`, {}, "GET", 64 * 1024);
      requireRegistryStatus(res.status);
      let token;
      try { token = JSON.parse(res.body.toString("utf8")).token; } catch { token = undefined; }
      requireContract(typeof token === "string" && token !== "", "release_registry_unavailable", "Registry issued no pull token");
      tokens.set(repository, `Bearer ${token}`);
    }
    return tokens.get(repository);
  }
  return {
    async describe(repository, digest) {
      const res = await registryRequest(agent, endpoint(repository, "manifests", digest),
        { accept: INDEX, authorization: await authorization(repository) }, "HEAD", 0);
      requireRegistryStatus(res.status);
      requireContract(res.headers["docker-content-digest"] === digest, "release_artifact_invalid", "Registry serves a different image index");
      return { mediaType: String(res.headers["content-type"] ?? "").split(";")[0].trim(), digest, size: Number(res.headers["content-length"]) };
    },
    async read(repository, descriptor) {
      const res = await registryRequest(agent, endpoint(repository, descriptor.mediaType === CONFIG ? "blobs" : "manifests", descriptor.digest),
        { accept: descriptor.mediaType, authorization: await authorization(repository) }, "GET", descriptor.size);
      requireRegistryStatus(res.status);
      requireContract(res.body.length === descriptor.size && `sha256:${createHash("sha256").update(res.body).digest("hex")}` === descriptor.digest,
        "release_artifact_invalid", "OCI content checksum does not match");
      return decodeJson(res.body);
    },
  };
}

function requireRegistryStatus(status) {
  requireContract(status < 500 && status !== 429, "release_registry_unavailable", `Registry is unavailable (${status})`);
  requireContract(status === 200, "release_artifact_invalid", `Registry refused the published content (${status})`);
}

// One bounded exchange. A blob redirect may go once to the package CDN, whose signed URL
// replaces the registry credential.
function registryRequest(agent, url, headers, method, limit, redirects = 1) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== "https:" || !REGISTRY_HOSTS.has(target.hostname) || target.port || target.username || target.password) {
      reject(new ReleaseError("release_artifact_invalid", "Registry redirected outside the package hosts"));
      return;
    }
    const request = https.request(target, { method, agent, headers, timeout: REGISTRY_TIMEOUT }, response => {
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && location && redirects > 0) {
        response.resume();
        const forwarded = { ...headers };
        delete forwarded.authorization;
        let next;
        try {
          next = new URL(location, target).href;
        } catch {
          reject(new ReleaseError("release_artifact_invalid", "Registry returned an invalid redirect"));
          return;
        }
        registryRequest(agent, next, forwarded, method, limit, redirects - 1).then(resolve, reject);
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > limit) request.destroy(new ReleaseError("release_artifact_invalid", "Registry content exceeds its descriptor"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", () => reject(new ReleaseError("release_registry_unavailable", "Registry response was interrupted")));
    });
    request.on("timeout", () => request.destroy(new ReleaseError("release_registry_unavailable", "Registry request timed out")));
    request.on("error", error => reject(error instanceof ReleaseError ? error : new ReleaseError("release_registry_unavailable", "Registry is unreachable")));
    request.end();
  });
}

async function packRelease(releasePath, outputDirectory, repositoryRoot) {
  const { manifest, files, bundleRoot } = await verifyRelease(releasePath, repositoryRoot);
  const output = path.resolve(outputDirectory);
  await mkdir(output, { mode: 0o700 });
  const scratch = await mkdtemp(path.join(os.tmpdir(), "incident-release-pack-"));
  try {
    const listing = path.join(scratch, "files");
    await writeFile(listing, `${[...files].sort().join("\n")}\n`);
    const archive = path.join(output, "candidate.tar.gz");
    // Host extended attributes can add AppleDouble files outside the verified graph.
    await command("tar", ["-czf", archive, "--no-xattrs", ...(process.platform === "darwin" ? ["--no-mac-metadata"] : []),
      "--no-recursion", "-T", listing], bundleRoot, 10 * 60_000);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    await writeFile(path.join(output, "SHA256SUMS"), `${hash.digest("hex")}  candidate.tar.gz\n`, { flag: "wx", mode: 0o600 });
    requireContract(await sourceRevision(repositoryRoot) === manifest.sourceRevision,
      "release_revision_mismatch", "Source changed while packaging");
    return manifest;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function buildRelease(outputDirectory, repositoryRoot) {
  const root = await realpath(repositoryRoot);
  const revision = await sourceRevision(root);
  const modes = await command("git", ["ls-tree", "-r", "--format=%(objectmode)", revision], root);
  requireContract(modes.trim().split("\n").every(mode => ["100644", "100755"].includes(mode)),
    "release_source_invalid", "Release source must not include symlinks or unmaterialized submodules");
  const output = path.resolve(outputDirectory);
  requireContract(!/[,\r\n]/.test(output), "invalid_arguments", "Output path cannot contain OCI exporter separators");
  await directory(path.dirname(output));
  try {
    await mkdir(output, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") throw new ReleaseError("release_output_exists", "Build output must be a new directory");
    throw error;
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), "incident-release-build-"));
  try {
    const source = path.join(scratch, "source");
    await mkdir(source);
    await command("git", ["archive", "--format=tar", `--output=${path.join(scratch, "source.tar")}`, revision], root);
    await command("tar", ["-xf", path.join(scratch, "source.tar"), "-C", source], root);
    const images = {};
    for (const component of Object.keys(REPOSITORIES)) {
      await command("docker", ["buildx", "build", "--platform", PLATFORMS.join(","), "--provenance=false", "--sbom=false",
        "--build-arg", `SOURCE_REVISION=${revision}`, "--build-arg", `SOURCE_VERSION=sha-${revision}`,
        "--file", component === "console" ? "Dockerfile.console" : "services/agent-runtime/Dockerfile",
        "--output", `type=oci,dest=${path.join(output, `${component}-oci`)},tar=false`, "."], source, 60 * 60_000);
      images[component] = await inspectImage(bundleLayout(output, component), component, revision);
    }
    requireContract(await sourceRevision(root) === revision, "release_revision_mismatch", "Source changed during the build");
    const manifest = { schemaVersion: 1, sourceRevision: revision, images };
    await writeFile(path.join(output, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return manifest;
  } finally {
    // Only the scratch directory allocated by this invocation; retain failed build output for inspection.
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const [action, option, value, ...extra] = process.argv.slice(2);
  if (action === "pack" && option === "--release" && value && extra.length === 2 && extra[0] === "--output" && extra[1] && !extra[1].startsWith("-")) {
    console.log(JSON.stringify(await packRelease(value, extra[1], process.cwd()), null, 2));
    return;
  }
  requireContract(extra.length === 0 && typeof value === "string" && value.length > 0 && !value.startsWith("-")
    && ((action === "verify" && option === "--release") || (action === "build" && option === "--output")),
  "invalid_arguments", "Use release.mjs verify --release <release.json>, build --output <new-directory>, or pack --release <release.json> --output <new-directory> from the repository root");
  const manifest = action === "build" ? await buildRelease(value, process.cwd()) : await loadRelease(value, process.cwd());
  console.log(JSON.stringify(manifest, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof ReleaseError ? `FAIL ${error.code}: ${error.message}` : "FAIL release_artifact_invalid: Release files are missing, inaccessible or unsafe");
    process.exitCode = 1;
  });
}
