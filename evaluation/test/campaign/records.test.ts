import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { planCampaign, writeEvaluationArtifact, writeTrialPackage } from "../../src/campaign/records.ts";
import type { CatalogArtifact, OnlineArtifact } from "../../src/contracts/records.ts";
import { EvaluationError } from "../../src/shared/errors.ts";
import { temporaryDirectory } from "../support/fixtures.ts";

const GOLDEN = path.resolve(import.meta.dirname, "../fixtures/golden");
const STARTED_AT = "2026-09-05T00:00:00.000Z";
const DATASET = { id: "regression", version: 1 };

function golden<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(GOLDEN, `${name}.json`), "utf8"));
}

function catalogArtifact(id: string): CatalogArtifact {
  const artifact = golden<CatalogArtifact>("catalog-focused");
  return { ...artifact, campaign: { ...artifact.campaign, id } };
}

const coded = (code: string) => (error: unknown) => error instanceof EvaluationError && error.code === code;

function mode(file: string): number {
  return statSync(file).mode & 0o777;
}

function root(t: TestContext): string {
  return temporaryDirectory(t, "evaluation-records-");
}

test("campaign artifacts are created private, exactly once, under their profile directory", async (t) => {
  const repositoryRoot = root(t);
  const artifact = catalogArtifact("20260905T000000Z-0000aaaa");
  const output = await writeEvaluationArtifact(repositoryRoot, "kind-evaluation", artifact);
  assert.equal(output, path.join(repositoryRoot, ".runtime/evaluation/kind-evaluation/20260905T000000Z-0000aaaa.json"));
  assert.equal(readFileSync(output, "utf8"), `${JSON.stringify(artifact, null, 2)}\n`);
  assert.equal(mode(output), 0o600);
  for (const directory of [".runtime", ".runtime/evaluation", ".runtime/evaluation/kind-evaluation"]) {
    assert.equal(mode(path.join(repositoryRoot, directory)), 0o700, directory);
  }
  await assert.rejects(writeEvaluationArtifact(repositoryRoot, "kind-evaluation", { ...artifact, status: "failed" }), coded("evaluation_artifact_exists"));
  assert.equal(JSON.parse(readFileSync(output, "utf8")).status, artifact.status);
  const sibling = await writeEvaluationArtifact(repositoryRoot, "kind-evaluation", catalogArtifact("20260905T000000Z-0000bbbb"));
  assert.notEqual(sibling, output);
});

test("online artifacts replace the previous one atomically and stay private", async (t) => {
  const repositoryRoot = root(t);
  const artifact = golden<OnlineArtifact>("online");
  const output = await writeEvaluationArtifact(repositoryRoot, "k3s-public", artifact);
  assert.equal(output, path.join(repositoryRoot, ".runtime/evaluation/k3s-public.json"));
  assert.equal(mode(output), 0o600);
  await writeEvaluationArtifact(repositoryRoot, "k3s-public", { ...artifact, status: "failed" });
  assert.equal(JSON.parse(readFileSync(output, "utf8")).status, "failed");
  assert.deepEqual(readdirSync(path.join(repositoryRoot, ".runtime/evaluation")), ["k3s-public.json"]);
});

test("trial packages are written once per scenario under the campaign directory", async (t) => {
  const repositoryRoot = root(t);
  const relative = await writeTrialPackage(repositoryRoot, "kind-evaluation", "20260905T000000Z-0000aaaa", "crash-loop-backoff", '{"schemaVersion":1}\n');
  assert.equal(relative, "trials/crash-loop-backoff.json");
  const file = path.join(repositoryRoot, ".runtime/evaluation/kind-evaluation/20260905T000000Z-0000aaaa", relative);
  assert.equal(readFileSync(file, "utf8"), '{"schemaVersion":1}\n');
  assert.equal(mode(file), 0o600);
  assert.equal(mode(path.dirname(file)), 0o700);
  await assert.rejects(writeTrialPackage(repositoryRoot, "kind-evaluation", "20260905T000000Z-0000aaaa", "crash-loop-backoff", "{}\n"), coded("evaluation_artifact_exists"));
  assert.equal(readFileSync(file, "utf8"), '{"schemaVersion":1}\n');
});

test("a symbolic link anywhere on the record path is refused before anything is written through it", async (t) => {
  const repositoryRoot = root(t);
  const elsewhere = path.join(repositoryRoot, "elsewhere");
  mkdirSync(path.join(repositoryRoot, ".runtime/evaluation"), { recursive: true });
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, path.join(repositoryRoot, ".runtime/evaluation/kind-evaluation"));
  await assert.rejects(writeEvaluationArtifact(repositoryRoot, "kind-evaluation", catalogArtifact("20260905T000000Z-0000aaaa")), coded("artifact_directory_invalid"));
  await assert.rejects(writeTrialPackage(repositoryRoot, "kind-evaluation", "20260905T000000Z-0000aaaa", "crash-loop-backoff", "{}\n"), coded("artifact_directory_invalid"));
  assert.deepEqual(readdirSync(elsewhere), []);

  const linkedRoot = root(t);
  symlinkSync(elsewhere, path.join(linkedRoot, ".runtime"));
  await assert.rejects(writeEvaluationArtifact(linkedRoot, "k3s-public", golden<OnlineArtifact>("online")), coded("artifact_directory_invalid"));
  assert.deepEqual(readdirSync(elsewhere), []);
});

test("a campaign is named by its start instant and may only retry a real sibling of the same dataset", async (t) => {
  const repositoryRoot = root(t);
  const suffix = () => "0000cccc";
  assert.deepEqual(await planCampaign({}, "kind-evaluation", DATASET, STARTED_AT, repositoryRoot, suffix), {
    id: "20260905T000000Z-0000cccc",
    startedAt: STARTED_AT,
    retryOf: null,
  });
  await assert.rejects(planCampaign({ retryOf: "not-a-campaign" }, "kind-evaluation", DATASET, STARTED_AT, repositoryRoot, suffix), coded("invalid_arguments"));
  const target = "20260905T000000Z-0000aaaa";
  await assert.rejects(planCampaign({ retryOf: target }, "kind-evaluation", DATASET, STARTED_AT, repositoryRoot, suffix), coded("evaluation_retry_target_invalid"));

  await writeEvaluationArtifact(repositoryRoot, "kind-evaluation", catalogArtifact(target));
  assert.equal((await planCampaign({ retryOf: target }, "kind-evaluation", DATASET, STARTED_AT, repositoryRoot, suffix)).retryOf, target);
  await assert.rejects(planCampaign({ retryOf: target }, "kind-evaluation", { id: "regression", version: 2 }, STARTED_AT, repositoryRoot, suffix), coded("evaluation_retry_target_invalid"));
  await assert.rejects(planCampaign({ retryOf: target }, "k3s-evaluation", DATASET, STARTED_AT, repositoryRoot, suffix), coded("evaluation_retry_target_invalid"));

  const directory = path.join(repositoryRoot, ".runtime/evaluation/kind-evaluation");
  writeFileSync(path.join(directory, "20260905T000000Z-0000dddd.json"), "not json\n");
  await assert.rejects(planCampaign({ retryOf: "20260905T000000Z-0000dddd" }, "kind-evaluation", DATASET, STARTED_AT, repositoryRoot, suffix), coded("evaluation_retry_target_invalid"));
  // A link to a record that would qualify if it were followed: the reader must refuse the link itself.
  const linked = path.join(repositoryRoot, "outside-eeee.json");
  writeFileSync(linked, JSON.stringify({ ...catalogArtifact("20260905T000000Z-0000eeee") }));
  symlinkSync(linked, path.join(directory, "20260905T000000Z-0000eeee.json"));
  await assert.rejects(planCampaign({ retryOf: "20260905T000000Z-0000eeee" }, "kind-evaluation", DATASET, STARTED_AT, repositoryRoot, suffix), coded("evaluation_retry_target_invalid"));
  assert.equal(existsSync(path.join(directory, `${target}.json`)), true);
});
