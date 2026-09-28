import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  loadScenarioCatalog,
  runScenarioCommand,
  ScenarioCommandError,
  supportedScenarioVersion,
  type ScenarioCatalogEntry,
  type ScenarioDefinition,
} from "../../../scripts/scenario.mjs";
import {
  createReleaseFixture,
  gitFixtureEnvironment,
  type ReleaseFixture,
} from "../../../scripts/test-support/release-fixture.mjs";
import { REPOSITORY_ROOT, temporaryDirectory } from "../support/fixtures.ts";

const VERIFIER_KINDS = new Set([
  "image_pull_backoff",
  "crash_loop_backoff",
  "service_selector_mismatch",
  "readiness_probe_failure",
  "liveness_probe_failure",
  "pvc_pending",
]);

// tsc never checks the .mjs implementations against their declarations; these calls do.
test("the scenario catalog export delivers validated definitions with the declared fields", () => {
  const entries: ScenarioCatalogEntry[] = loadScenarioCatalog(REPOSITORY_ROOT);
  assert.equal(entries.length, 7);
  for (const { definition, manifestPaths } of entries) {
    const shape: ScenarioDefinition = definition;
    assert.equal(typeof shape.scenario_id, "string");
    assert.equal(typeof shape.scenario_version, "number");
    assert.equal(typeof shape.monitoring_alert_id, "string");
    assert.equal(shape.trigger.type, "manual");
    assert.deepEqual(Object.keys(shape.target).sort(), ["api_version", "cluster", "kind", "name", "namespace"]);
    assert.ok(VERIFIER_KINDS.has(shape.deterministic_verifier.kind));
    assert.equal(typeof shape.deterministic_verifier.timeout_seconds, "number");
    for (const field of [shape.fixture_manifests, shape.expected_root_causes, shape.required_evidence, shape.allowed_tools, shape.forbidden_tools]) {
      assert.ok(Array.isArray(field) && field.length > 0 && field.every((item) => typeof item === "string"));
    }
    assert.equal(typeof shape.identity_evidence, "string");
    assert.equal(shape.expected_patch_constraints !== undefined, shape.scenario_id === "image-pull-backoff");
    assert.ok(manifestPaths.length > 0 && manifestPaths.every((file) => existsSync(file)));
  }
  const imagePull = entries.find(({ definition }) => definition.scenario_id === "image-pull-backoff");
  assert.equal(imagePull?.definition.expected_patch_constraints?.action, "set_container_image");
  assert.equal(imagePull?.definition.expected_patch_constraints?.container_index, 0);
});

test("supported scenario versions come from the script's overrides", () => {
  assert.equal(supportedScenarioVersion("image-pull-backoff"), 5);
  assert.equal(supportedScenarioVersion("crash-loop-backoff"), 3);
  assert.equal(supportedScenarioVersion("case-001"), 1);
});

test("the scenario command lists the public catalog and raises its own typed error", async () => {
  const listed = await runScenarioCommand("list", undefined, { repositoryRoot: REPOSITORY_ROOT });
  assert.ok(Array.isArray(listed) && listed.length === 7);
  await assert.rejects(
    runScenarioCommand("list", "crash-loop-backoff", { repositoryRoot: REPOSITORY_ROOT }),
    (error: unknown) => {
      assert.ok(error instanceof ScenarioCommandError);
      assert.equal(error.code, "invalid_arguments");
      assert.equal(error.name, "ScenarioCommandError");
      return true;
    },
  );
});

test("the shared release fixture produces a manifest and an isolated git with the declared shapes", (t) => {
  const directory = temporaryDirectory(t, "evaluation-release-fixture-");
  const revision = "b".repeat(40);
  const fixture: ReleaseFixture = createReleaseFixture(directory, revision);
  assert.equal(fixture.bundle, directory);
  assert.equal(fixture.release, path.join(directory, "release.json"));
  assert.equal(fixture.manifest.schemaVersion, 1);
  assert.equal(fixture.manifest.sourceRevision, revision);
  for (const component of ["console", "runtime"] as const) {
    const image = fixture.manifest.images[component];
    assert.equal(image.repository, `ghcr.io/kkxiaoa/k8s-incident-agent-${component}`);
    assert.match(image.indexDigest, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(image.platforms).sort(), ["linux/amd64", "linux/arm64"]);
    assert.ok(existsSync(fixture.files[`${component}Index`]));
  }
  assert.deepEqual(JSON.parse(readFileSync(fixture.release, "utf8")), fixture.manifest);
  assert.equal(typeof fixture.save, "function");

  const environment = gitFixtureEnvironment(directory, revision);
  const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", env: { ...process.env, PATH: environment.PATH } });
  assert.equal(git.status, 0);
  assert.equal(git.stdout.trim(), revision);
  const dirty = spawnSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
    env: { ...process.env, PATH: gitFixtureEnvironment(temporaryDirectory(t, "evaluation-dirty-"), revision, true).PATH },
  });
  assert.equal(dirty.stdout, " M source-file\n");
});
