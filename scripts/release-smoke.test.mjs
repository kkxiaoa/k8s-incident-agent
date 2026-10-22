import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createReleaseFixture, gitFixtureEnvironment } from "./test-support/release-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function smokeFixture(t, transform = () => {}, entrypoint) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "release-smoke-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = createReleaseFixture(directory, "a".repeat(40));
  if (entrypoint) {
    const layout = path.join(directory, "console-oci");
    const readBlob = digest => JSON.parse(readFileSync(path.join(layout, "blobs/sha256", digest.slice(7)), "utf8"));
    const replaceBlob = (descriptor, value) => {
      const bytes = Buffer.from(JSON.stringify(value));
      descriptor.digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
      descriptor.size = bytes.length;
      writeFileSync(path.join(layout, "blobs/sha256", descriptor.digest.slice(7)), bytes);
    };
    const outer = JSON.parse(readFileSync(path.join(layout, "index.json"), "utf8"));
    const index = readBlob(outer.manifests[0].digest);
    for (const child of index.manifests) {
      const manifest = readBlob(child.digest);
      const config = readBlob(manifest.config.digest);
      config.config.Entrypoint = entrypoint;
      replaceBlob(manifest.config, config);
      replaceBlob(child, manifest);
      fixture.manifest.images.console.platforms["linux/" + child.platform.architecture] = child.digest;
    }
    replaceBlob(outer.manifests[0], index);
    fixture.manifest.images.console.indexDigest = outer.manifests[0].digest;
    writeFileSync(path.join(layout, "index.json"), JSON.stringify(outer));
    fixture.save();
  }
  const environment = gitFixtureEnvironment(directory, fixture.manifest.sourceRevision);
  const images = {};
  for (const [component, identity] of Object.entries(fixture.manifest.images)) {
    const readBlob = digest => JSON.parse(readFileSync(path.join(directory, `${component}-oci/blobs/sha256`, digest.slice(7)), "utf8"));
    for (const digest of Object.values(identity.platforms)) {
      const manifest = readBlob(digest);
      const config = readBlob(manifest.config.digest);
      images[manifest.config.digest] = {
        Id: `sha256:${"f".repeat(64)}`,
        Os: config.os,
        Architecture: config.architecture,
        Config: config.config,
        RootFS: { Type: config.rootfs.type, Layers: config.rootfs.diff_ids },
      };
      transform(images[manifest.config.digest]);
    }
  }
  const log = path.join(directory, "docker.jsonl");
  writeFileSync(path.join(directory, "bin", "docker"), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const images = ${JSON.stringify(images)};
if (args[0] === 'run' && args.includes('copy')) {
  const destination = args.find(value => value.endsWith(':/output:rw')).slice(0, -11);
  const archive = args.at(-1).split('/').at(-1).split(':')[0];
  fs.writeFileSync(path.join(destination, archive), 'synthetic transport');
} else if (args[0] === 'image' && args[1] === 'inspect') {
  const image = images['sha256:' + args[2].split('-').at(-1)];
  if (process.env.SMOKE_TEST_WRONG_PLATFORM === '1') image.Architecture = 'wrong';
  if (process.env.SMOKE_TEST_WRONG_ROOTFS === '1') image.RootFS.Layers = ['sha256:' + '0'.repeat(64)];
  console.log(JSON.stringify([image]));
} else if (args[0] === 'run' && args.includes('--pull=never')) {
  if (process.env.SMOKE_TEST_PERMISSIONS_FAIL === '1' && args.includes('--cap-add=CHOWN')) process.exit(3);
  if (process.env.SMOKE_TEST_FAIL === '1') {
    fs.writeSync(2, process.env.SMOKE_TEST_STDERR ?? '');
    process.exit(3);
  }
} else if (!['pull', 'load', 'container'].includes(args[0])) process.exit(2);
`, { mode: 0o755 });
  return { fixture, log, environment };
}

// Docker 28.0.4 container.Config serializes these zero values without omitempty.
// Reproduced with API 1.48 against the same locally imported OCI images.
const legacyDefaults = {
  Hostname: "", Domainname: "", AttachStdin: false, AttachStdout: false,
  AttachStderr: false, Tty: false, OpenStdin: false, StdinOnce: false,
  Image: "", OnBuild: null, Volumes: null, Entrypoint: null,
};
const additions = values => image => Object.assign(image.Config, values);

for (const [name, env, expected, transform] of [["executes both exact platforms", {}, 0],
  ["accepts Docker API 1.48 defaults", {}, 0, additions(legacyDefaults)],
  ["accepts additional inspection metadata", {}, 0, additions({ Image: "transport-reference", AdditionalMetadata: "ignored" })],
  ["accepts empty optional startup fields", {}, 0, additions({ Env: [], Entrypoint: [], Volumes: {}, WorkingDir: "", Healthcheck: null })],
  ["rejects changed candidate command", {}, 1, additions({ Cmd: ["unexpected-command"] })],
  ["rejects changed candidate user", {}, 1, additions({ User: "0" })],
  ["rejects changed source revision", {}, 1, additions({ Labels: { "org.opencontainers.image.revision": "b".repeat(40) } })],
  ["rejects missing declared config", {}, 1, image => { delete image.Config.User; }],
  ["rejects missing inspect config", {}, 1, image => { delete image.Config; }],
  ...Object.entries({ Entrypoint: ["unexpected-command"], Env: ["UNEXPECTED=1"], WorkingDir: "/unexpected",
    Volumes: { "/unexpected": {} }, ExposedPorts: { "9999/tcp": {} }, StopSignal: "SIGKILL",
    Healthcheck: { Test: ["CMD", "false"] }, Shell: ["sh"], OnBuild: ["RUN false"],
    StopTimeout: 0, ArgsEscaped: true, NetworkDisabled: true, Tty: true,
  }).map(([key, value]) => [`rejects added non-default ${key}`, {}, 1, additions({ [key]: value })]),
  ["stops on startup failure", { SMOKE_TEST_FAIL: "1" }, 1],
  ["stops on volume initialization failure", { SMOKE_TEST_PERMISSIONS_FAIL: "1" }, 1],
  ["rejects a substituted image", { SMOKE_TEST_WRONG_PLATFORM: "1" }, 1],
  ["rejects substituted rootfs", { SMOKE_TEST_WRONG_ROOTFS: "1" }, 1]]) {
  test(`candidate smoke orchestration ${name} (fake Docker boundary, not smoke evidence)`, t => {
    const f = smokeFixture(t, transform);
    const result = spawnSync(process.execPath, [path.join(root, "scripts/release-smoke.mjs"), "--release", f.fixture.release],
      { cwd: root, env: { ...process.env, ...f.environment, ...env }, encoding: "utf8" });
    assert.equal(result.status, expected, result.stderr);
    const calls = readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const copies = calls.filter(args => args[0] === "run" && args.includes("copy"));
    const runs = calls.filter(args => args[0] === "run" &&
      (args.includes("/smoke/console.mjs") || args.includes("/smoke/runtime.py")));
    const permissions = calls.filter(args => args[0] === "run" && args.includes("--cap-add=CHOWN"));
    assert.ok(calls.filter(args => args[0] === "run").every(args => args.includes("--network=none")));
    if (expected === 0) {
      assert.equal(copies.length, 4);
      assert.ok(copies.every(args => args.includes("/var/tmp:rw,nosuid,nodev,mode=1777")));
      assert.equal(runs.length, 4);
      assert.equal(permissions.length, 2);
      for (const args of permissions) {
        assert.ok(args.includes("--cap-drop=ALL"));
        assert.equal(args[args.indexOf("--user") + 1], "0:0");
        assert.ok(args.includes("/permissions:rw,nosuid,nodev,mode=0700"));
        assert.ok(args.includes("--read-only"));
      }
      assert.deepEqual(JSON.parse(result.stdout).checks.map(check => [check.component, check.platform]),
        [["console", "linux/amd64"], ["console", "linux/arm64"], ["runtime", "linux/amd64"], ["runtime", "linux/arm64"]]);
      for (const args of runs) {
        assert.ok(args.includes(`sha256:${"f".repeat(64)}`));
        assert.ok(args.includes("--read-only"));
        assert.ok(!args.includes("--cap-add=CHOWN") && !args.includes("--user"));
        if (args.includes("/smoke/runtime.py")) {
          assert.ok(args.includes("/var/backups/k8s-incident-agent:rw,nosuid,nodev,uid=10001,gid=10001,mode=0700"));
        }
        assert.ok(!args.some(value => value.includes("docker.sock") || value.startsWith("--env-file")));
      }
    } else {
      assert.match(result.stderr, /release_smoke_failed/);
      assert.ok(runs.length < 4);
      if (!env.SMOKE_TEST_FAIL && !env.SMOKE_TEST_PERMISSIONS_FAIL) assert.equal(runs.length, 0);
    }
  });
}

test("candidate smoke forwards the inherited entrypoint before the default command (fake Docker boundary)", t => {
  const f = smokeFixture(t, undefined, ["docker-entrypoint.sh"]);
  const result = spawnSync(process.execPath, [path.join(root, "scripts/release-smoke.mjs"), "--release", f.fixture.release],
    { cwd: root, env: { ...process.env, ...f.environment }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const runs = readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line))
    .filter(args => args.includes("/smoke/console.mjs"));
  assert.equal(runs.length, 2);
  for (const args of runs) assert.deepEqual(JSON.parse(args.at(-1)), ["docker-entrypoint.sh", "node", "server.js"]);
});

test("candidate smoke failure names the check and keeps bounded container output on one line (fake Docker boundary, not smoke evidence)", t => {
  const f = smokeFixture(t);
  const stderr = `${"x".repeat(5000)}\n::error::forged\nRuntimeError: Candidate Runtime did not become ready`;
  const result = spawnSync(process.execPath, [path.join(root, "scripts/release-smoke.mjs"), "--release", f.fixture.release],
    { cwd: root, env: { ...process.env, ...f.environment, SMOKE_TEST_FAIL: "1", SMOKE_TEST_STDERR: stderr }, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  const lines = result.stderr.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^FAIL release_smoke_failed: console linux\/amd64 startup failed during isolated candidate smoke \(exit 3\): "x+\\n::error::forged\\nRuntimeError: Candidate Runtime did not become ready"$/);
  assert.equal(JSON.parse(lines[0].slice(lines[0].indexOf(": \"") + 2)), stderr.slice(-4000));
});
