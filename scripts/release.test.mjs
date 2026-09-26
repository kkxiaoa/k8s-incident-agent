import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { ghcrRegistry, loadRelease, verifyRegistryRelease } from "./release.mjs";
import { createReleaseFixture } from "./test-support/release-fixture.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repositoryRoot, "scripts", "release.mjs");
let directory;
let source;
let revision;

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "incident-release-test-"));
  source = path.join(directory, "source");
  revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", repositoryRoot, source]);
  execFileSync("git", ["checkout", "--quiet", "--detach", revision], { cwd: source });
});

after(async () => { await rm(directory, { recursive: true, force: true }); });

async function fixture(t, options = {}) {
  const bundle = await mkdtemp(path.join(directory, "bundle-"));
  t.after(() => rm(bundle, { recursive: true, force: true }));
  return createReleaseFixture(bundle, revision, options);
}

test("full two-platform bundle is verified against an actual clean checkout", async t => {
  const f = await fixture(t);
  assert.deepEqual(await loadRelease(f.release, source), f.manifest);
  const result = spawnSync(process.execPath, [cli, "verify", "--release", f.release], { cwd: source, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), f.manifest);
});

for (const [name, mutate, code] of [
  ["foreign repository", m => { m.images.console.repository = "ghcr.io/another/project"; }, "release_contract_invalid"],
  ["mutable image reference", m => { m.images.console.indexDigest = "latest"; }, "release_contract_invalid"],
  ["different source", m => { m.sourceRevision = "f".repeat(40); }, "release_revision_mismatch"],
  ["missing component", m => { delete m.images.runtime; }, "release_contract_invalid"],
  ["unknown schema", m => { m.schemaVersion = 2; }, "release_contract_invalid"],
  ["legacy lock identity", m => { m.lockRevision = revision; }, "release_contract_invalid"],
  ["wrong child digest", m => { m.images.console.platforms["linux/arm64"] = `sha256:${"e".repeat(64)}`; }, "release_artifact_invalid"],
]) {
  test(`release rejects ${name}`, async t => {
    const f = await fixture(t);
    mutate(f.manifest);
    await f.save();
    await assert.rejects(loadRelease(f.release, source), { code });
  });
}

for (const [name, options, code] of [
  ["mixed image source", { runtimeRevision: "f".repeat(40) }, "release_revision_mismatch"],
  ["root image", { user: "0:0" }, "release_artifact_invalid"],
  ["config platform mismatch", { configArchitecture: "amd64" }, "release_artifact_invalid"],
]) {
  test(`OCI rejects ${name}`, async t => {
    const f = await fixture(t, options);
    await assert.rejects(loadRelease(f.release, source), { code });
  });
}

for (const [name, mutate] of [
  ["same-size layer corruption", async f => {
    const bytes = await readFile(f.files.runtimeLayer);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(f.files.runtimeLayer, bytes);
  }],
  ["truncated layer", f => writeFile(f.files.consoleLayer, Buffer.from("short"))],
  ["missing layer", f => rm(f.files.runtimeLayer)],
  ["symlink layer", async f => {
    const copy = path.join(f.bundle, "external-blob");
    await writeFile(copy, await readFile(f.files.consoleLayer));
    await rm(f.files.consoleLayer);
    await symlink(copy, f.files.consoleLayer);
  }],
  ["index corruption", f => writeFile(f.files.consoleIndex, "{}")],
]) {
  test(`OCI rejects ${name}`, async t => {
    const f = await fixture(t);
    await mutate(f);
    await assert.rejects(loadRelease(f.release, source), { code: "release_artifact_invalid" });
  });
}

test("dirty checkout stops both verification and build before any Docker command", async t => {
  const f = await fixture(t);
  const changed = path.join(source, "uncommitted-test-input");
  await writeFile(changed, "uncommitted");
  try {
    await assert.rejects(loadRelease(f.release, source), { code: "release_worktree_dirty" });
    const result = spawnSync(process.execPath, [cli, "build", "--output", path.join(f.bundle, "new-output")], { cwd: source, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /release_worktree_dirty/);
    await assert.rejects(access(path.join(f.bundle, "new-output")));
  } finally {
    await rm(changed);
  }
});

test("build refuses to overwrite an existing candidate directory", async t => {
  const f = await fixture(t);
  const result = spawnSync(process.execPath, [cli, "build", "--output", f.bundle], { cwd: source, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release_output_exists/);
  assert.deepEqual(JSON.parse(await readFile(f.release, "utf8")), f.manifest);
});

test("CLI rejects arbitrary actions and extra arguments", () => {
  for (const args of [["publish"], ["verify", "--release", "missing", "--skip-source"], ["build", "--output", "--overwrite"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: source, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid_arguments/);
  }
});

for (const [name, platforms] of [["missing platform", ["amd64"]], ["repeated platform", ["amd64", "arm64", "arm64"]],
  ["additional platform or attestation", ["amd64", "arm64", "unknown"]]]) {
  test(`OCI rejects ${name} even when release declares the expected two platforms`, async t => {
    const f = await fixture(t, { platforms });
    for (const image of Object.values(f.manifest.images)) {
      delete image.platforms["linux/unknown"];
      image.platforms["linux/arm64"] ??= `sha256:${"f".repeat(64)}`;
    }
    await f.save();
    await assert.rejects(loadRelease(f.release, source), { code: "release_artifact_invalid" });
  });
}

test("transport archive contains only the verified OCI graph and a matching checksum", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.bundle, "private-not-for-upload"), "local unrelated data");
  await writeFile(path.join(f.bundle, "console-oci", "blobs", "sha256", "f".repeat(64)), "unreferenced data");
  const output = path.join(f.bundle, "transport");
  const result = spawnSync(process.execPath, [cli, "pack", "--release", f.release, "--output", output], { cwd: source, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const archive = path.join(output, "candidate.tar.gz");
  const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
  assert.ok(listing.includes("release.json"));
  for (const component of ["console", "runtime"]) {
    assert.ok(listing.includes(`${component}-oci/index.json`));
    assert.ok(listing.includes(`${component}-oci/oci-layout`));
    assert.ok(listing.includes(`${component}-oci/blobs/sha256/${path.basename(f.files[`${component}Layer`])}`));
  }
  assert.ok(listing.every(name => /^(?:release\.json|(?:console|runtime)-oci\/(?:index\.json|oci-layout|blobs\/sha256\/[a-f0-9]{64}))$/.test(name)));
  assert.ok(!listing.some(name => name.includes("f".repeat(64))));
  const hash = createHash("sha256").update(await readFile(archive)).digest("hex");
  assert.equal(await readFile(path.join(output, "SHA256SUMS"), "utf8"), `${hash}  candidate.tar.gz\n`);
});

test("build exports only committed input and emits identity from inspected output", async t => {
  const f = await fixture(t);
  const bin = path.join(f.bundle, "bin");
  const calls = path.join(f.bundle, "calls.jsonl");
  const output = path.join(f.bundle, "built");
  await mkdir(bin);
  const docker = path.join(bin, "docker");
  await writeFile(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const file = args[args.indexOf('--file') + 1];
const component = file === 'Dockerfile.console' ? 'console' : 'runtime';
const dest = args[args.indexOf('--output') + 1].match(/dest=([^,]+)/)[1];
fs.appendFileSync(process.env.RELEASE_TEST_CALLS, JSON.stringify({args,
  ignoredPresent: fs.existsSync('.env.release-test') || fs.existsSync('.runtime'),
  dockerfile: fs.readFileSync(file, 'utf8'), readme: fs.readFileSync('README.md', 'utf8')}) + '\\n');
if (process.env.RELEASE_TEST_BUILD_FAIL === '1') process.exit(2);
fs.cpSync(path.join(process.env.RELEASE_TEST_FIXTURE, component + '-oci'), dest, {recursive: true});
`, { mode: 0o755 });
  const ignored = path.join(source, ".env.release-test");
  await writeFile(ignored, "synthetic ignored input, not a credential");
  t.after(() => rm(ignored));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    RELEASE_TEST_CALLS: calls, RELEASE_TEST_FIXTURE: f.bundle };
  const result = await promisify(execFile)(process.execPath, [cli, "build", "--output", output], { cwd: source, env });
  assert.deepEqual(JSON.parse(result.stdout), f.manifest);
  assert.deepEqual(await loadRelease(path.join(output, "release.json"), source), f.manifest);
  const captured = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(captured.length, 2);
  for (const call of captured) {
    assert.equal(call.ignoredPresent, false);
    assert.equal(call.readme, execFileSync("git", ["show", `${revision}:README.md`], { cwd: source, encoding: "utf8" }));
    assert.ok(call.dockerfile.includes("USER 10001:10001"));
    assert.ok(call.args.includes(`SOURCE_REVISION=${revision}`));
    assert.ok(call.args.includes("linux/amd64,linux/arm64"));
    assert.ok(call.args.includes("--provenance=false"));
    assert.ok(call.args.includes("--sbom=false"));
    assert.ok(!call.args.includes("--push"));
  }
  const failed = path.join(f.bundle, "failed");
  await assert.rejects(promisify(execFile)(process.execPath, [cli, "build", "--output", failed], {
    cwd: source, env: { ...env, RELEASE_TEST_BUILD_FAIL: "1" },
  }), error => /release_command_failed/.test(error.stderr));
  await assert.rejects(access(path.join(failed, "release.json")));
});

// The registry path reads the same fixture graph; content checks live in the GHCR client.
function fixtureRegistry(f) {
  const blob = (repository, digest) => path.join(f.bundle, `${repository.split("-").at(-1)}-oci`, "blobs", "sha256", digest.slice(7));
  return {
    async describe(repository, digest) {
      const bytes = await readFile(blob(repository, digest));
      return { mediaType: JSON.parse(bytes).mediaType, digest, size: bytes.length };
    },
    read: async (repository, descriptor) => JSON.parse(await readFile(blob(repository, descriptor.digest))),
  };
}

test("published registry images pass the same OCI rules as a bundle", async t => {
  const f = await fixture(t);
  assert.deepEqual(await verifyRegistryRelease(f.manifest, source, fixtureRegistry(f)), f.manifest);
});

for (const [name, options, mutate, code] of [
  ["mixed image source", { runtimeRevision: "f".repeat(40) }, undefined, "release_revision_mismatch"],
  ["root image", { user: "0:0" }, undefined, "release_artifact_invalid"],
  ["config platform mismatch", { configArchitecture: "amd64" }, undefined, "release_artifact_invalid"],
  ["different source", {}, m => { m.sourceRevision = "f".repeat(40); }, "release_revision_mismatch"],
  ["wrong child digest", {}, m => { m.images.console.platforms["linux/arm64"] = `sha256:${"e".repeat(64)}`; }, "release_artifact_invalid"],
  ["foreign repository", {}, m => { m.images.console.repository = "ghcr.io/another/project"; }, "release_contract_invalid"],
]) {
  test(`registry release rejects ${name}`, async t => {
    const f = await fixture(t, options);
    mutate?.(f.manifest);
    await assert.rejects(verifyRegistryRelease(f.manifest, source, fixtureRegistry(f)), { code });
  });
}

async function testCertificates(t) {
  const dir = await mkdtemp(path.join(directory, "tls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const openssl = args => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  const key = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  openssl(["req", "-x509", ...key, "-days", "1", "-subj", "/CN=registry-test-ca", "-keyout", "ca.key", "-out", "ca.pem"]);
  openssl(["req", ...key, "-subj", "/CN=ghcr.io", "-keyout", "leaf.key", "-out", "leaf.csr"]);
  await writeFile(path.join(dir, "ext"), "subjectAltName=DNS:ghcr.io,DNS:pkg-containers.githubusercontent.com\n");
  openssl(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1", "-extfile", "ext", "-out", "leaf.pem"]);
  const read = name => readFile(path.join(dir, name));
  return { ca: await read("ca.pem"), key: await read("leaf.key"), cert: await read("leaf.pem") };
}

test("GHCR reads use the host proxy, stay on package hosts and drop the credential at the CDN", async t => {
  const f = await fixture(t);
  const blobs = new Map();
  for (const component of ["console", "runtime"]) {
    const dir = path.join(f.bundle, `${component}-oci`, "blobs", "sha256");
    for (const name of await readdir(dir)) {
      const bytes = await readFile(path.join(dir, name));
      let mediaType = "application/octet-stream";
      try { mediaType = JSON.parse(bytes).mediaType ?? mediaType; } catch { /* layer */ }
      blobs.set(`sha256:${name}`, { bytes, mediaType });
    }
  }
  const tls = await testCertificates(t);
  const seen = { connects: [], cdnAuthorization: [] };
  let scenario = {};
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const host = req.headers.host;
    const url = new URL(req.url, `https://${host}`);
    const registry = url.pathname.match(/^\/v2\/kkxiaoa\/k8s-incident-agent-(?:console|runtime)\/(manifests|blobs)\/(sha256:[a-f0-9]{64})$/);
    const cdn = url.pathname.match(/^\/ghcr1\/blobs\/(sha256:[a-f0-9]{64})$/);
    if (host === "ghcr.io" && url.pathname === "/token") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: "fixture-token" }));
    } else if (host === "ghcr.io" && registry && req.headers.authorization !== "Bearer fixture-token") {
      res.writeHead(401).end();
    } else if (host === "ghcr.io" && registry && scenario.unavailable) {
      res.writeHead(503).end();
    } else if (host === "ghcr.io" && registry?.[1] === "blobs") {
      res.writeHead(307, { location: `https://${scenario.cdnHost ?? "pkg-containers.githubusercontent.com"}/ghcr1/blobs/${registry[2]}?signed=1` }).end();
    } else if (host === "ghcr.io" && registry && blobs.has(registry[2])) {
      const blob = blobs.get(registry[2]);
      res.writeHead(200, { "content-type": blob.mediaType, "content-length": blob.bytes.length, "docker-content-digest": registry[2] });
      res.end(req.method === "HEAD" ? undefined : blob.bytes);
    } else if (host === "pkg-containers.githubusercontent.com" && cdn && blobs.has(cdn[1])) {
      seen.cdnAuthorization.push(req.headers.authorization ?? null);
      const bytes = Buffer.from(blobs.get(cdn[1]).bytes);
      if (scenario.tamper) bytes[bytes.length - 2] ^= 1;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length }).end(bytes);
    } else {
      res.writeHead(404).end();
    }
  });
  const proxy = net.createServer(client => {
    client.once("data", chunk => {
      const [method, authority] = chunk.toString("latin1").split("\r\n")[0].split(" ");
      seen.connects.push(authority);
      if (method !== "CONNECT") return client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
      const upstream = net.connect(server.address().port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const agent = new https.Agent({ proxyEnv: { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}` }, ca: tls.ca });
  t.after(() => { agent.destroy(); server.close(); proxy.close(); });

  assert.deepEqual(await verifyRegistryRelease(f.manifest, source, ghcrRegistry(agent)), f.manifest);
  assert.deepEqual([...new Set(seen.connects)].sort(), ["ghcr.io:443", "pkg-containers.githubusercontent.com:443"]);
  assert.ok(seen.cdnAuthorization.length > 0);
  assert.deepEqual([...new Set(seen.cdnAuthorization)], [null]);

  for (const [name, value, code] of [
    ["redirect outside the package hosts", { cdnHost: "objects.example.com" }, "release_artifact_invalid"],
    ["tampered blob", { tamper: true }, "release_artifact_invalid"],
    ["unavailable registry", { unavailable: true }, "release_registry_unavailable"],
  ]) {
    scenario = value;
    seen.connects.length = 0;
    await assert.rejects(verifyRegistryRelease(f.manifest, source, ghcrRegistry(agent)), { code }, name);
    assert.ok(!seen.connects.includes("objects.example.com:443"), name);
  }
});
