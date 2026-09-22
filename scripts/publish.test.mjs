import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fetchPublishedRelease, publishCandidate, selectCandidate } from "./publish.mjs";
import { createReleaseFixture } from "./test-support/release-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = "kkxiaoa/k8s-incident-agent";
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
let directory, source, revision, fixture, archive;

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "incident-publish-test-"));
  source = path.join(directory, "source");
  revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", root, source]);
  execFileSync("git", ["checkout", "--quiet", "--detach", revision], { cwd: source });
  fixture = createReleaseFixture(path.join(directory, "bundle"), revision);
  const transport = path.join(directory, "transport");
  execFileSync(process.execPath, [path.join(root, "scripts/release.mjs"), "pack", "--release", fixture.release, "--output", transport], { cwd: source });
  execFileSync("python3", ["-m", "zipfile", "-c", path.join(directory, "artifact.zip"), "candidate.tar.gz", "SHA256SUMS"], { cwd: transport });
  archive = await readFile(path.join(directory, "artifact.zip"));
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

async function harness(t) {
  const folder = await mkdtemp(path.join(directory, "case-"));
  const bin = path.join(folder, "bin");
  await mkdir(bin);
  await symlink(path.join(root, "scripts/test-support/publication-docker.mjs"), path.join(bin, "docker"));
  const stateFile = path.join(folder, "registry.json");
  const readRegistry = async () => JSON.parse(await readFile(stateFile, "utf8"));
  const patchRegistry = async patch => writeFile(stateFile, JSON.stringify({ ...await readRegistry(), ...patch }));
  await writeFile(stateFile, JSON.stringify({ content: {}, calls: [], authFiles: [] }));
  const environment = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, PUBLICATION_TEST_STATE: stateFile,
    GH_TOKEN: "test-only-token", GITHUB_ACTOR: "test-maintainer", GITHUB_REPOSITORY: repository,
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "22", GITHUB_SHA: revision };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  // Reduced official REST response shapes; no fixture field is invented as an authority.
  const run = { id: 11, workflow_id: 33, path: ".github/workflows/ci.yml", event: "push", head_branch: "main",
    head_sha: revision, status: "completed", conclusion: "success", run_attempt: 2,
    repository: { id: 44, full_name: repository }, head_repository: { id: 44, full_name: repository } };
  const jobs = ["Runtime checks", "Scripts and deployment contracts", "Console checks and fake E2E",
    "Public docs and CI security", "Same-source multi-platform OCI candidate"].map((name, index) => ({
    id: 100 + index, name, run_id: 11, head_sha: revision, status: "completed", conclusion: "success",
  }));
  const artifact = { id: 55, name: `oci-candidate-${revision}-2`, expired: false,
    expires_at: new Date(Date.now() + 3600_000).toISOString(), size_in_bytes: archive.length, digest: hash(archive),
    workflow_run: { id: 11, repository_id: 44, head_repository_id: 44, head_branch: "main", head_sha: revision } };
  const state = { run, jobs, artifact, approved: true, reviewers: true, release: null, assets: [], ref: null,
    mutations: [], downloads: [], zip: archive, failAsset: null, paginate: false };
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? "GET";
    if (url.hostname === "test.blob.core.windows.net") {
      assert.equal(options.headers, undefined, "signed URL must receive no GitHub token");
      return new Response(state.zip);
    }
    assert.ok(["api.github.com", "uploads.github.com"].includes(url.hostname));
    assert.equal(options.headers.Authorization, "Bearer test-only-token");
    const endpoint = url.pathname.replace(`/repos/${repository}`, "");
    const body = typeof options.body === "string" ? JSON.parse(options.body) : null;
    if (method !== "GET") state.mutations.push({ method, endpoint, body });
    if (endpoint === "/actions/workflows/ci.yml") return json({ id: 33 });
    if (endpoint === "/actions/runs/11") return json(state.run);
    if (endpoint === "/actions/runs/22") return json({ path: ".github/workflows/release.yml", event: "workflow_dispatch",
      head_branch: "main", head_sha: revision, run_attempt: 1, repository: { full_name: repository } });
    if (endpoint === "/environments/release") return json({ id: 66, name: "release", protection_rules:
      state.reviewers ? [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 77 } }] }] : [] });
    if (endpoint === "/actions/runs/22/approvals") return json(state.approved ? [{ state: "approved", environments: [{ id: 66, name: "release" }] }] : []);
    if (/\/attempts\/\d+\/jobs$/.test(endpoint)) {
      assert.equal(endpoint, `/actions/runs/11/attempts/${state.run.run_attempt}/jobs`);
      if (state.paginate && url.searchParams.get("page") === "1") return json({ jobs: Array.from({ length: 100 }, () => ({ name: "Other job" })) });
      return json({ jobs: state.jobs });
    }
    if (endpoint === "/actions/artifacts/55") return json(state.artifact);
    if (endpoint === "/actions/artifacts/55/zip") {
      state.downloads.push(endpoint);
      return new Response(null, { status: 302, headers: { location: "https://test.blob.core.windows.net/artifact.zip?signed=test" } });
    }
    if (endpoint === "/releases" && method === "GET") return json(state.release ? [state.release] : []);
    if (endpoint === "/releases" && method === "POST") {
      state.release = { id: 88, ...body };
      return json(state.release, 201);
    }
    if (endpoint === "/releases/88" && method === "PATCH") {
      assert.equal(state.assets.length, 3);
      const registry = await readRegistry();
      for (const image of Object.values(fixture.manifest.images)) {
        assert.equal(hash(registry.content[`${image.repository}:v0.1.0`]), image.indexDigest);
        for (const child of Object.values(image.platforms)) assert.equal(hash(registry.content[`${image.repository}@${child}`]), child);
      }
      Object.assign(state.release, body);
      return json(state.release);
    }
    if (endpoint === "/releases/88" || endpoint === "/releases/tags/v0.1.0") return json(state.release);
    if (endpoint === "/releases/88/assets" && method === "GET") return json(state.assets);
    if (endpoint === "/releases/88/assets" && method === "POST") {
      const name = url.searchParams.get("name");
      if (state.failAsset === name) return json({}, 502);
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      assert.equal(Number(options.headers["Content-Length"]), bytes.length);
      const asset = { id: 200 + state.assets.length, name, state: "uploaded", size: bytes.length, digest: hash(bytes) };
      state.assets.push(asset);
      state[`bytes${asset.id}`] = bytes;
      return json(asset, 201);
    }
    if (endpoint.startsWith("/releases/assets/")) return new Response(state[`bytes${endpoint.split("/").at(-1)}`]);
    if (endpoint === "/git/ref/tags/v0.1.0") return json(state.ref ?? {}, state.ref ? 200 : 404);
    if (endpoint === "/git/refs" && method === "POST") { state.ref = { object: { type: "commit", sha: body.sha } }; return json(state.ref, 201); }
    throw new Error(`Unhandled test boundary ${method} ${endpoint}`);
  };
  const options = { version: "v0.1.0", runId: 11, attempt: 2, artifactId: 55, source: revision,
    artifactDigest: artifact.digest, sourceDirectory: source };
  return { state, options, folder, readRegistry, patchRegistry };
}

test("same-attempt job pagination retains trusted candidate identity", async t => {
  const h = await harness(t);
  h.state.paginate = true;
  assert.equal((await selectCandidate(11, 55)).source, revision);
  assert.deepEqual(h.state.mutations, []);
});

for (const [name, mutate] of [
  ["fork producer", s => { s.run.head_repository.id = 999; }],
  ["PR event", s => { s.run.event = "pull_request"; }],
  ["other branch", s => { s.run.head_branch = "topic"; }],
  ["wrong workflow", s => { s.run.workflow_id = 999; }],
  ["failed run", s => { s.run.conclusion = "failure"; }],
  ["skipped quality gate", s => { s.jobs[0].conclusion = "skipped"; }],
  ["other source job", s => { s.jobs[1].head_sha = "f".repeat(40); }],
  ["missing job", s => { s.jobs.pop(); }],
  ["expired artifact", s => { s.artifact.expired = true; }],
  ["elapsed artifact deadline", s => { s.artifact.expires_at = "2000-01-01T00:00:00Z"; }],
  ["another attempt", s => { s.artifact.name = `oci-candidate-${revision}-1`; }],
  ["another artifact run", s => { s.artifact.workflow_run.id = 999; }],
  ["unverifiable artifact", s => { s.artifact.digest = null; }],
]) test(`selection rejects ${name} without mutation`, async t => {
  const h = await harness(t); mutate(h.state);
  await assert.rejects(selectCandidate(11, 55));
  assert.deepEqual(h.state.mutations, []);
});

test("manual inputs never become executable shell or paths", async t => {
  const h = await harness(t);
  await assert.rejects(selectCandidate("11;touch bad", 55), /identity/);
  await assert.rejects(publishCandidate({ ...h.options, version: "v1.0.0;bad" }), /stable version/);
  assert.deepEqual(h.state.mutations, []);
});

for (const [name, mutate, message] of [
  ["no human approval", h => { h.state.approved = false; }, /human approval/],
  ["unprotected Environment", h => { h.state.reviewers = false; }, /required reviewers/],
  ["rerun of an old dispatch", () => { process.env.GITHUB_RUN_ATTEMPT = "2"; }, /fresh/],
  ["candidate changed during approval", h => { h.options.artifactDigest = `sha256:${"a".repeat(64)}`; }, /changed while/],
  ["download substituted", h => { h.state.zip = Buffer.from("not the approved archive"); }, /digest mismatch/],
]) test(`publish stops before writes: ${name}`, async t => {
  const h = await harness(t); mutate(h);
  await assert.rejects(publishCandidate(h.options), message);
  assert.deepEqual(h.state.mutations, []);
});

test("real pack/import/OCI validation, simulated publication, install download and idempotent retry", async t => {
  const h = await harness(t);
  assert.equal((await publishCandidate(h.options)).status, "published");
  assert.equal(h.state.release.draft, false);
  assert.equal(h.state.ref.object.sha, revision);
  assert.deepEqual(await fetchPublishedRelease("v0.1.0", path.join(h.folder, "installed"), source), fixture.manifest);
  const count = h.state.mutations.length;
  assert.equal((await publishCandidate(h.options)).status, "already-published");
  assert.equal(h.state.mutations.length, count);
  const registry = await h.readRegistry();
  assert.equal(registry.calls.filter(args => args.includes("copy")).length, 2);
  for (const filename of registry.authFiles) await assert.rejects(access(filename));
});

test("partial second-image upload leaves a draft; fresh approval resumes only missing content", async t => {
  const h = await harness(t);
  await h.patchRegistry({ failRuntimeOnce: true });
  await assert.rejects(publishCandidate(h.options), /Registry operation failed/);
  assert.equal(h.state.release.draft, true);
  assert.equal(h.state.ref, null);
  await assert.rejects(fetchPublishedRelease("v0.1.0", path.join(h.folder, "draft-install"), source), /Only a published/);
  await assert.rejects(access(path.join(h.folder, "draft-install")));
  assert.equal((await publishCandidate(h.options)).status, "published");
  const registry = await h.readRegistry();
  assert.equal(registry.calls.filter(args => args.includes("copy") && args.at(-1).includes("-console:")).length, 1);
  assert.equal(h.state.mutations.filter(item => item.endpoint === "/releases/88/assets").length, 3);
});

test("attachment outage leaves a draft and performs no registry push; retry fills only missing assets", async t => {
  const h = await harness(t); h.state.failAsset = "candidate.tar.gz";
  await assert.rejects(publishCandidate(h.options), /attachment upload failed/);
  assert.equal(h.state.release.draft, true);
  assert.equal((await h.readRegistry()).calls.filter(args => args.includes("copy")).length, 0);
  h.state.failAsset = null;
  assert.equal((await publishCandidate(h.options)).status, "published");
  assert.equal(h.state.assets.length, 3);
});

test("registry rewrite never updates manifest or makes release installable", async t => {
  const h = await harness(t);
  await h.patchRegistry({ rewriteIndex: true });
  await assert.rejects(publishCandidate(h.options), /rewrote/);
  assert.equal(h.state.release.draft, true);
  assert.equal(h.state.ref, null);
  assert.equal(h.state.mutations.filter(item => item.method === "PATCH").length, 0);
});

test("registry authentication failures are not interpreted as an unused version", async t => {
  const h = await harness(t); await h.patchRegistry({ authFailure: true });
  await assert.rejects(publishCandidate(h.options), /Registry operation failed/);
  assert.deepEqual(h.state.mutations, []);
});

test("same version with a conflicting registry digest refuses all publication writes", async t => {
  const h = await harness(t);
  await h.patchRegistry({ content: { [`${fixture.manifest.images.runtime.repository}:v0.1.0`]: "{}" } });
  await assert.rejects(publishCandidate(h.options), /rewrote/);
  assert.deepEqual(h.state.mutations, []);
});

test("conflicting or incomplete existing attachment is retained without overwrite", async t => {
  const h = await harness(t);
  h.state.release = { id: 88, tag_name: "v0.1.0", target_commitish: revision, draft: true, prerelease: false };
  h.state.assets = [{ id: 200, name: "release.json", state: "starter", size: 0, digest: null }];
  await assert.rejects(publishCandidate(h.options), /conflicts or is incomplete/);
  assert.deepEqual(h.state.mutations, []);
});

test("version source conflicts stop before registry and attachment writes", async t => {
  const h = await harness(t);
  h.state.ref = { object: { type: "commit", sha: "f".repeat(40) } };
  await assert.rejects(publishCandidate(h.options), /different source/);
  assert.deepEqual(h.state.mutations, []);
});

test("private GHCR packages leave a draft until public reads succeed, without repushing", async t => {
  const h = await harness(t);
  await h.patchRegistry({ privatePackages: true });
  await assert.rejects(publishCandidate(h.options), /Registry operation failed/);
  assert.equal(h.state.release.draft, true);
  assert.equal(h.state.ref, null);
  assert.equal((await h.readRegistry()).calls.filter(args => args.includes("copy")).length, 2);
  await h.patchRegistry({ privatePackages: false });
  assert.equal((await publishCandidate(h.options)).status, "published");
  assert.equal((await h.readRegistry()).calls.filter(args => args.includes("copy")).length, 2);
});

test("incomplete published release cannot be installed or silently repaired", async t => {
  const h = await harness(t);
  await publishCandidate(h.options);
  h.state.assets.pop();
  const before = h.state.mutations.length;
  await assert.rejects(fetchPublishedRelease("v0.1.0", path.join(h.folder, "incomplete"), source), /incomplete/);
  await assert.rejects(publishCandidate(h.options), /incomplete/);
  assert.equal(h.state.mutations.length, before);
});

test("download redirect cannot leak a token or escape the artifact storage boundary", async t => {
  const h = await harness(t);
  const rest = globalThis.fetch;
  globalThis.fetch = (url, options) => String(url).endsWith("/zip")
    ? Promise.resolve(new Response(null, { status: 302, headers: { location: "https://attacker.invalid/archive" } }))
    : rest(url, options);
  await assert.rejects(publishCandidate(h.options), /Unexpected artifact download/);
  assert.deepEqual(h.state.mutations, []);
});
