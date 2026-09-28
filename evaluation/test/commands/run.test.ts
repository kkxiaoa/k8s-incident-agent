import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { ScenarioCommandError } from "../../../scripts/scenario.mjs";
import { runCatalogEvaluation, type RunDependencies, type RunRequest } from "../../src/commands/run.ts";
import { loadEvaluationScenarioCatalog } from "../../src/contracts/dataset.ts";
import type { CatalogArtifact } from "../../src/contracts/records.ts";
import { buildCampaignReport } from "../../src/review/report.ts";
import { EvaluationError } from "../../src/shared/errors.ts";
import { datasetFile, REPOSITORY_ROOT } from "../support/fixtures.ts";
import { AUTH_PASSWORD, createHarness, type Harness, type HarnessOptions } from "../support/harness.ts";

const GOLDEN = path.resolve(import.meta.dirname, "../fixtures/golden");

function recorded(artifact: CatalogArtifact): CatalogArtifact {
  return JSON.parse(JSON.stringify(artifact));
}

// The recorded files are the artifact exactly as the evaluator writes it, so the bytes must match too.
function assertRecordedBytes(artifact: CatalogArtifact, name: string): void {
  assert.equal(`${JSON.stringify(artifact, null, 2)}\n`, readFileSync(path.join(GOLDEN, `${name}.json`), "utf8"), name);
}

const coded = (code: string) => (error: unknown) => error instanceof EvaluationError && error.code === code;

// The command reads the release through the fixture's git, exactly as the CLI would in a checkout.
async function run(harness: Harness, request: Omit<RunRequest, "releasePath"> & { releasePath?: string } = {}) {
  const previousPath = process.env.PATH;
  process.env.PATH = harness.release.environment.PATH;
  try {
    return await runCatalogEvaluation({ releasePath: harness.release.path, ...request }, harness.dependencies as RunDependencies);
  } finally {
    process.env.PATH = previousPath;
  }
}

function golden_(options: HarnessOptions = {}): Harness {
  const harness = createHarness(options);
  harness.dependencies.campaignSuffix = () => "0000aaaa";
  return harness;
}

test("a full catalog campaign reproduces the recorded artifact through the fake environment", async () => {
  const harness = golden_();
  const { artifact, artifactPath } = await run(harness, { profile: "kind-evaluation" });
  assertRecordedBytes(artifact, "catalog-full");
  assert.equal(artifactPath, "/artifacts/kind-evaluation.json");
  assert.equal(harness.calls.artifacts.length, 1);
  assert.equal(harness.calls.scenarioApply, 8);
  assert.equal(harness.calls.scenarioVerify, 8);
  assert.equal(harness.calls.alertmanagerRestarts, 1);
  assert.equal(harness.calls.tunnelClose, 1);
  assert.equal(harness.calls.sleepDurations.includes(330_000), false);
  const serialized = JSON.stringify(artifact);
  for (const forbidden of ["payload", "statement", "summary", "authorization", "token", AUTH_PASSWORD, harness.state.cookie, harness.state.csrf]) {
    assert.equal(serialized.includes(String(forbidden)), false, String(forbidden));
  }
});

test("a focused campaign runs only the selected cases and never claims omitted coverage", async () => {
  const harness = golden_();
  const selected = ["crash-loop-backoff", "liveness-probe-misconfigured", "pvc-binding-pending"];
  const touched = new Set<string>();
  const runner = harness.dependencies.runScenarioCommand;
  harness.dependencies.runScenarioCommand = async (action, id, options) => {
    touched.add(String(id));
    return runner(action, id, options);
  };
  const { artifact } = await run(harness, { profile: "kind-evaluation", scenarioIds: selected });
  assertRecordedBytes(artifact, "catalog-focused");
  assert.deepEqual(touched, new Set(selected));
  assert.equal(harness.calls.scenarioApply, 3);
  assert.equal(harness.calls.alertmanagerRestarts, 0);
});

test("the three expected terminals, a mismatch and an aborted campaign reproduce their recorded artifacts", async (t) => {
  const insufficient = golden_({ terminalByScenario: { "crash-loop-backoff": { outcome: "insufficient_evidence" } } });
  const insufficientDataset = datasetFile(t, (manifest) => { manifest.cases[0].expected_terminal = { outcome: "insufficient_evidence" }; });
  assertRecordedBytes((await run(insufficient, { profile: "kind-evaluation", datasetPath: insufficientDataset, scenarioIds: ["crash-loop-backoff"] })).artifact, "catalog-terminal-insufficient_evidence");

  const failed = golden_({ terminalByScenario: { "crash-loop-backoff": { outcome: "failed", errorCode: "model_output_invalid", retryable: false } } });
  const failedDataset = datasetFile(t, (manifest) => { manifest.cases[0].expected_terminal = { outcome: "failed", error_code: "model_output_invalid" }; });
  assertRecordedBytes((await run(failed, { profile: "kind-evaluation", datasetPath: failedDataset, scenarioIds: ["crash-loop-backoff"] })).artifact, "catalog-terminal-failed");

  const mismatch = golden_({ terminalByScenario: { "crash-loop-backoff": { outcome: "failed", errorCode: "tool_timeout", retryable: true, incidentStatus: "STALE_RESOURCE" } } });
  assertRecordedBytes((await run(mismatch, { profile: "kind-evaluation", datasetPath: failedDataset, scenarioIds: ["crash-loop-backoff"] })).artifact, "catalog-terminal-mismatch");

  const aborted = golden_();
  aborted.dependencies.fetch = async () => new Response("sensitive upstream detail", { status: 401 });
  const abortedRun = await run(aborted, { profile: "kind-evaluation" });
  assertRecordedBytes(abortedRun.artifact, "catalog-aborted");
  assert.equal(aborted.calls.scenarioApply, 0);
  assert.equal(aborted.calls.tunnelClose, 1);
  assert.equal(JSON.stringify(abortedRun.artifact).includes("sensitive upstream detail"), false);
});

test("a missing credential aborts before scenarios while still reporting the complete planned denominator", async () => {
  const harness = createHarness();
  harness.dependencies.environment.OPERATOR_PASSWORD_FILE = undefined;
  const { artifact } = await run(harness, { profile: "kind-evaluation", scenarioIds: ["crash-loop-backoff"] });
  assert.equal(artifact.status, "failed");
  assert.equal(artifact.failure?.code, "operator_authentication_failed");
  assert.equal(artifact.coverage.plannedCases, 7);
  assert.equal(artifact.coverage.notRunCases, 7);
  assert.equal(artifact.scenarios.every((entry) => entry.status === "not_run" && entry.reason === "evaluation_aborted"), true);
  assert.equal(JSON.stringify(artifact).includes(String(harness.dependencies.environment.OPERATOR_PASSWORD_FILE)), false);
});

test("one failed scenario does not stop the remaining cases, and the probe still runs after them", async () => {
  const harness = createHarness({ failingScenarioId: "image-pull-backoff" });
  const { artifact } = await run(harness, { profile: "kind-evaluation" });
  assert.equal(artifact.status, "failed");
  assert.equal(artifact.scenarios.filter((entry) => entry.status === "pending_manual_review").length, 6);
  const failed = artifact.scenarios.find((entry) => entry.scenarioId === "image-pull-backoff");
  assert.deepEqual(failed?.failure, { code: "terminal_outcome_mismatch", message: "The Run ended COMPLETED/insufficient_evidence while the case expects diagnosed" });
  assert.deepEqual(failed?.checks.run, { attempt: 1, status: "COMPLETED", errorCode: null, retryable: null, outcome: "insufficient_evidence" });
  assert.equal(failed?.outcomeClass, "outcome_mismatch");
  assert.equal(harness.calls.scenarioApply, 8);
  assert.equal(artifact.monitoring?.infrastructure.status, "passed");

  const other = createHarness({ failingScenarioId: "service-selector-mismatch", otherAlertSameTargetScenarioId: "readiness-probe-misconfigured" });
  const probed = await run(other, { profile: "kind-evaluation" });
  assert.equal(probed.artifact.scenarios.find((entry) => entry.scenarioId === "readiness-probe-misconfigured")?.status, "pending_manual_review");
  assert.equal(probed.artifact.monitoring?.infrastructure.status, "passed");
});

test("a probe that breaks a fixture reports the scenario script's own failure after cleaning up", async (t) => {
  const harness = createHarness();
  const datasetPath = datasetFile(t, (manifest) => {
    const imagePull = manifest.cases.find((entry) => entry.scenario_id === "image-pull-backoff")!;
    manifest.cases = [...manifest.cases.filter((entry) => entry !== imagePull), imagePull];
  });
  const runner = harness.dependencies.runScenarioCommand;
  const actions: string[] = [];
  let applies = 0;
  harness.dependencies.runScenarioCommand = async (action, scenarioId, dependencies) => {
    if (scenarioId === "image-pull-backoff") actions.push(action);
    if (action === "apply" && scenarioId === "image-pull-backoff" && ++applies === 2) {
      throw new ScenarioCommandError("upstream_unavailable", "The healthy rollout did not complete");
    }
    return runner(action, scenarioId, dependencies);
  };
  const { artifact } = await run(harness, { profile: "kind-evaluation", datasetPath });
  assert.deepEqual(artifact.monitoring?.infrastructure, { status: "failed", failure: { code: "upstream_unavailable", message: "The healthy rollout did not complete" } });
  assert.equal(artifact.status, "failed");
  assert.deepEqual(actions, ["cleanup", "apply", "verify", "cleanup", "apply", "cleanup"]);
});

test("selections are validated before deployment, tunnels or scenario commands", async (t) => {
  for (const scenarioIds of [[], ["unknown"], ["../outside"], ["pvc-binding-pending", "pvc-binding-pending"]]) {
    await t.test(JSON.stringify(scenarioIds), async () => {
      const harness = createHarness();
      harness.dependencies.verifyDeploymentStatus = async () => assert.fail("deployment preflight reached");
      harness.dependencies.openTunnels = async () => assert.fail("tunnel opened");
      await assert.rejects(run(harness, { profile: "kind-evaluation", scenarioIds }), coded("invalid_arguments"));
      assert.equal(harness.calls.scenarioApply, 0);
    });
  }
  for (const request of [
    { profile: "k3s-public", context: "k3s" },
    { profile: "kind-evaluation", context: "kind" },
    { profile: "k3s-evaluation" },
    { profile: "k3s-evaluation", context: "-x" },
    { profile: "unknown" },
    { profile: "kind-evaluation", split: "validation" },
  ]) {
    await t.test(JSON.stringify(request), async () => {
      const harness = createHarness();
      harness.dependencies.verifyDeploymentStatus = async () => assert.fail("deployment preflight reached");
      await assert.rejects(run(harness, request), coded("invalid_arguments"));
    });
  }
  // The public profile is refused before the dataset is even read.
  const publicProfile = createHarness();
  const unreadable = datasetFile(t, (manifest) => { manifest.schema_version = 2; });
  await assert.rejects(run(publicProfile, { profile: "k3s-public", context: "k3s", datasetPath: unreadable }), coded("invalid_arguments"));
  const holdout = createHarness();
  await assert.rejects(run(holdout, { profile: "kind-evaluation", split: "holdout" }), coded("evaluation_holdout_unavailable"));
  const release = createHarness();
  await assert.rejects(runCatalogEvaluation({ profile: "kind-evaluation" }, release.dependencies as RunDependencies), coded("invalid_arguments"));
});

test("a focused campaign still requires every planned revision and a matching release", async () => {
  const request = { profile: "kind-evaluation", scenarioIds: ["pvc-binding-pending"] };
  const partial = createHarness();
  partial.dependencies.scenarios = partial.dependencies.scenarios.slice(0, 1);
  await assert.rejects(run(partial, request), coded("evaluation_dataset_invalid"));
  const dirty = createHarness({ dirtyWorktree: true });
  await assert.rejects(run(dirty, request), coded("release_worktree_dirty"));
  const drift = createHarness({ headRevision: "b".repeat(40) });
  await assert.rejects(run(drift, request), coded("release_revision_mismatch"));
  assert.equal(partial.calls.scenarioApply + dirty.calls.scenarioApply + drift.calls.scenarioApply, 0);
});

test("dataset selection preserves the complete denominator and refuses contract violations before any external work", async (t) => {
  const datasetPath = datasetFile(t, (manifest) => {
    manifest.cases[0].split = "development";
    manifest.cases[1].profiles = ["k3s-evaluation"];
  });
  const harness = createHarness();
  const { artifact } = await run(harness, { profile: "kind-evaluation", datasetPath, split: "regression" });
  assert.equal(harness.calls.scenarioApply, 5);
  assert.equal(artifact.status, "pending_manual_review");
  assert.deepEqual({ planned: artifact.coverage.plannedCases, notRun: artifact.coverage.notRunCases, mechanisms: artifact.coverage.mechanisms.length }, { planned: 7, notRun: 2, mechanisms: 5 });
  const [development, unavailable] = artifact.scenarios;
  assert.deepEqual({ status: development.status, reason: development.reason, other: unavailable.reason }, { status: "not_run", reason: "not_selected", other: "profile_not_supported" });
  assert.deepEqual(development.limitations, ["legacy_name_cues"]);

  const subset = datasetFile(t, (manifest) => { manifest.cases = [manifest.cases[0]]; });
  const single = createHarness();
  single.dependencies.scenarios = [single.dependencies.scenarios[0]];
  const reduced = await run(single, { profile: "kind-evaluation", datasetPath: subset, scenarioIds: ["crash-loop-backoff"] });
  assert.equal(reduced.artifact.status, "pending_manual_review");
  assert.equal(single.calls.scenarioApply, 1);
  assert.deepEqual({ planned: reduced.artifact.coverage.plannedCases, mechanisms: reduced.artifact.coverage.mechanisms.length, families: reduced.artifact.families.length }, { planned: 1, mechanisms: 1, families: 5 });
  assert.equal(reduced.artifact.families.filter((family) => family.status === "not_run").length, 4);
  assert.equal(reduced.artifact.families.reduce((total, family) => total + family.scenarios, 0), 7);

  const catalog = loadEvaluationScenarioCatalog(REPOSITORY_ROOT);
  const variant = structuredClone(catalog[0]);
  variant.scenarioId = "case-001";
  variant.scenarioVersion = 1;
  variant.target.name = "case-001";
  variant.healthyControlNames = ["case-001-healthy-control"];
  const eighth = datasetFile(t, (manifest) => { manifest.cases.push({ ...manifest.cases[0], scenario_id: "case-001", scenario_version: 1 }); });
  const neutral = await run(createHarness({ scenarios: [...catalog, variant] }), { profile: "kind-evaluation", datasetPath: eighth, scenarioIds: ["case-001"] });
  assert.equal(neutral.artifact.status, "pending_manual_review");
  assert.deepEqual({ planned: neutral.artifact.coverage.plannedCases, notRun: neutral.artifact.coverage.notRunCases }, { planned: 8, notRun: 7 });
  assert.equal(neutral.artifact.families.every((family) => family.status === "not_run"), true);
  assert.deepEqual(neutral.artifact.scenarios.at(-1)?.limitations, []);

  const invalidDataset = datasetFile(t, (manifest) => { manifest.cases[0].split = "validation"; });
  const guarded = createHarness();
  guarded.dependencies.execute = async () => assert.fail("external command reached");
  guarded.dependencies.openTunnels = async () => assert.fail("tunnel opened");
  await assert.rejects(run(guarded, { profile: "kind-evaluation", datasetPath: invalidDataset }), coded("evaluation_dataset_invalid"));
  const relabelled = datasetFile(t, (manifest) => { manifest.cases[0].split = "holdout"; });
  await assert.rejects(run(guarded, { profile: "kind-evaluation", datasetPath: relabelled }), coded("evaluation_holdout_unavailable"));
  assert.equal(guarded.calls.artifacts.length, 0);
});

// Runs one focused campaign with the real record writers and reader under a temporary repository root.
function realCampaign(root: string, { suffix, options = {}, ...request }: { suffix: string; options?: HarnessOptions } & RunRequest) {
  const harness = createHarness(options);
  harness.dependencies.repositoryRoot = root;
  harness.dependencies.campaignSuffix = () => suffix;
  const execute = harness.dependencies.execute;
  harness.dependencies.execute = (command, args, settings) => execute(command, args, { ...settings, cwd: REPOSITORY_ROOT });
  delete harness.dependencies.writeArtifact;
  delete harness.dependencies.writeTrialPackage;
  const result = run(harness, { profile: "kind-evaluation", scenarioIds: ["crash-loop-backoff"], ...request });
  return { harness, result };
}

test("each campaign lands in its own files, never overwrites another and leaves earlier results untouched", async (t) => {
  const datasetPath = datasetFile(t, () => {});
  const root = path.dirname(datasetPath);
  const outputDirectory = path.join(root, ".runtime/evaluation");
  mkdirSync(outputDirectory, { recursive: true });
  const historicalPath = path.join(outputDirectory, "kind-evaluation-regression-v1-focused.json");
  writeFileSync(historicalPath, '{"schemaVersion":3,"historical":true}\n');
  const first = await realCampaign(root, { datasetPath, suffix: "0000aaaa" }).result;
  assert.equal(first.artifact.status, "pending_manual_review");
  const campaignDirectory = path.join(outputDirectory, "kind-evaluation");
  assert.equal(first.artifactPath, path.join(campaignDirectory, "20260905T000000Z-0000aaaa.json"));
  assert.equal(statSync(first.artifactPath).mode & 0o777, 0o600);
  assert.equal(statSync(campaignDirectory).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(first.artifactPath, "utf8")), recorded(first.artifact));
  const packagePath = path.join(campaignDirectory, first.artifact.campaign.id, first.artifact.scenarios[0].reviewPackage as string);
  assert.equal(statSync(packagePath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(packagePath, "utf8")).runId, first.artifact.scenarios[0].runId);

  const second = await realCampaign(root, { datasetPath, suffix: "0000bbbb" }).result;
  assert.notEqual(second.artifactPath, first.artifactPath);
  assert.deepEqual(JSON.parse(readFileSync(first.artifactPath, "utf8")), recorded(first.artifact));
  // The same identity again is refused before the Trial's own record could be replaced.
  await assert.rejects(realCampaign(root, { datasetPath, suffix: "0000aaaa" }).result, coded("evaluation_artifact_exists"));
  assert.equal(JSON.parse(readFileSync(packagePath, "utf8")).runId, first.artifact.scenarios[0].runId);
  assert.equal(readFileSync(historicalPath, "utf8"), '{"schemaVersion":3,"historical":true}\n');
});

test("a retry names the campaign it continues and only a real sibling record of the same dataset qualifies", async (t) => {
  const datasetPath = datasetFile(t, () => {});
  const root = path.dirname(datasetPath);
  const first = await realCampaign(root, { datasetPath, suffix: "0000aaaa" }).result;
  const campaignDirectory = path.dirname(first.artifactPath);
  const retry = await realCampaign(root, { datasetPath, suffix: "0000cccc", retryOf: first.artifact.campaign.id }).result;
  assert.equal(retry.artifact.campaign.retryOf, first.artifact.campaign.id);
  assert.notEqual(retry.artifact.campaign.id, first.artifact.campaign.id);

  const linked = path.join(root, "outside-eeee.json");
  writeFileSync(linked, JSON.stringify({ ...first.artifact, campaign: { ...first.artifact.campaign, id: "20260905T000000Z-0000eeee" } }));
  symlinkSync(linked, path.join(campaignDirectory, "20260905T000000Z-0000eeee.json"));
  writeFileSync(path.join(campaignDirectory, "20260905T000000Z-0000dddd.json"), "not json\n");
  const manifest = JSON.parse(readFileSync(datasetPath, "utf8"));
  const otherVersion = path.join(root, "dataset-v2.json");
  writeFileSync(otherVersion, JSON.stringify({ ...manifest, dataset_version: 2 }));
  for (const [request, code] of [
    [{ retryOf: "not-a-campaign" }, "invalid_arguments"],
    [{ retryOf: "20260905T000000Z-0000ffff" }, "evaluation_retry_target_invalid"],
    [{ retryOf: "20260905T000000Z-0000eeee" }, "evaluation_retry_target_invalid"],
    [{ retryOf: "20260905T000000Z-0000dddd" }, "evaluation_retry_target_invalid"],
    [{ retryOf: first.artifact.campaign.id, datasetPath: otherVersion }, "evaluation_retry_target_invalid"],
  ] as const) {
    const { harness, result } = realCampaign(root, { datasetPath, suffix: "0000ffff", ...request });
    await assert.rejects(result, coded(code), JSON.stringify(request));
    assert.equal(harness.calls.scenarioApply, 0, JSON.stringify(request));
  }
});

test("records are refused when a directory on their path is a symbolic link, and a near-bound package stays readable", async (t) => {
  const datasetPath = datasetFile(t, () => {});
  const root = path.dirname(datasetPath);
  const elsewhere = path.join(root, "elsewhere");
  mkdirSync(path.join(root, ".runtime/evaluation"), { recursive: true });
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, path.join(root, ".runtime/evaluation/kind-evaluation"));
  await assert.rejects(realCampaign(root, { datasetPath, suffix: "0000aaaa" }).result, coded("artifact_directory_invalid"));
  assert.deepEqual(readdirSync(elsewhere), []);

  const bounded = datasetFile(t, () => {});
  const boundedRoot = path.dirname(bounded);
  const { harness, result } = realCampaign(boundedRoot, { datasetPath: bounded, suffix: "0000aaaa", options: { manyRunEvents: { pages: 10, perPage: 100, fields: 200 } } });
  const { artifact, artifactPath } = await result;
  const [scenario] = artifact.scenarios;
  assert.equal(scenario.status, "pending_manual_review", JSON.stringify(scenario.failure));
  const packagePath = path.join(path.dirname(artifactPath), artifact.campaign.id, scenario.reviewPackage as string);
  const size = statSync(packagePath).size;
  assert.ok(size > 3.5 * 1024 * 1024 && size <= 4 * 1024 * 1024, `package is ${size} bytes`);
  const record = JSON.parse(readFileSync(packagePath, "utf8"));
  assert.equal(record.truncated, false);
  assert.equal(record.events.length, 1000);
  assert.equal(harness.calls.packages.length, 0);
  const report = await buildCampaignReport(artifactPath);
  assert.deepEqual(report.scenarios[0].reviewPackage, { truncated: false });
  assert.equal(report.status, "pending_manual_review");
});
