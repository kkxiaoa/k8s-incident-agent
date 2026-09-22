import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createReleaseFixture, gitFixtureEnvironment } from "./test-support/release-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function smokeFixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "release-smoke-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = createReleaseFixture(directory, "a".repeat(40));
  const environment = gitFixtureEnvironment(directory, fixture.manifest.sourceRevision);
  const images = {};
  for (const [component, identity] of Object.entries(fixture.manifest.images)) {
    const readBlob = digest => JSON.parse(readFileSync(path.join(directory, `${component}-oci/blobs/sha256`, digest.slice(7)), "utf8"));
    for (const digest of Object.values(identity.platforms)) {
      const manifest = readBlob(digest);
      const config = readBlob(manifest.config.digest);
      images[manifest.config.digest] = { Id: manifest.config.digest, Os: config.os, Architecture: config.architecture, Config: config.config };
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
  const archive = args.at(-1).split('/').at(-1);
  fs.writeFileSync(path.join(destination, archive), 'synthetic transport');
} else if (args[0] === 'image' && args[1] === 'inspect') {
  const image = images[args[2]];
  if (process.env.SMOKE_TEST_WRONG_PLATFORM === '1') image.Architecture = 'wrong';
  console.log(JSON.stringify([image]));
} else if (args[0] === 'run' && args.includes('--pull=never')) {
  if (process.env.SMOKE_TEST_FAIL === '1') process.exit(3);
} else if (!['pull', 'load', 'container'].includes(args[0])) process.exit(2);
`, { mode: 0o755 });
  return { fixture, log, environment };
}

for (const [name, env, expected] of [["executes both exact platforms", {}, 0],
  ["stops on startup failure", { SMOKE_TEST_FAIL: "1" }, 1],
  ["rejects a substituted image", { SMOKE_TEST_WRONG_PLATFORM: "1" }, 1]]) {
  test(`candidate smoke orchestration ${name} (fake Docker boundary, not smoke evidence)`, t => {
    const f = smokeFixture(t);
    const result = spawnSync(process.execPath, [path.join(root, "scripts/release-smoke.mjs"), "--release", f.fixture.release],
      { cwd: root, env: { ...process.env, ...f.environment, ...env }, encoding: "utf8" });
    assert.equal(result.status, expected, result.stderr);
    const calls = readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const runs = calls.filter(args => args[0] === "run" && args.includes("--pull=never"));
    assert.ok(calls.filter(args => args[0] === "run").every(args => args.includes("--network=none")));
    if (expected === 0) {
      assert.equal(runs.length, 4);
      assert.deepEqual(JSON.parse(result.stdout).checks.map(check => [check.component, check.platform]),
        [["console", "linux/amd64"], ["console", "linux/arm64"], ["runtime", "linux/amd64"], ["runtime", "linux/arm64"]]);
      for (const args of runs) {
        assert.ok(args.some(value => /^sha256:[a-f0-9]{64}$/.test(value)));
        assert.ok(args.includes("--read-only"));
        assert.ok(!args.some(value => value.includes("docker.sock") || value.startsWith("--env-file")));
      }
    } else {
      assert.match(result.stderr, /release_smoke_failed/);
      assert.ok(runs.length < 4);
    }
  });
}
