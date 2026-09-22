import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";

const workflow = load(readFileSync(new URL("../workflows/release.yml", import.meta.url), "utf8"));

test("publication has a manual owning-main boundary and one protected writer", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read", actions: "read" });
  assert.match(workflow.jobs.select.if, /github.repository == 'kkxiaoa\/k8s-incident-agent'/);
  assert.match(workflow.jobs.select.if, /github.ref == 'refs\/heads\/main'/);
  assert.equal(workflow.jobs.publish.needs, "select");
  assert.equal(workflow.jobs.publish.environment, "release");
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: "write", packages: "write", actions: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
});

test("privileged steps execute trusted tooling, never selected source/artifacts or interpolated inputs", () => {
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
    if (step.uses?.startsWith("actions/checkout@")) assert.equal(step.with["persist-credentials"], false);
    assert.doesNotMatch(step.run ?? "", /\$\{\{|docker\s+build|npm\s+(?:ci|install)|uv\s+sync/);
    assert.notEqual(step["working-directory"], "candidate-source");
  }
  const checkouts = workflow.jobs.publish.steps.filter(step => step.uses?.startsWith("actions/checkout@"));
  assert.deepEqual(checkouts.map(step => [step.with.path, step.with.ref]), [
    ["tooling", "${{ github.sha }}"], ["candidate-source", "${{ needs.select.outputs.source }}"],
  ]);
  const publish = workflow.jobs.publish.steps.find(step => step.run === "node scripts/publish.mjs publish");
  assert.equal(publish["working-directory"], "tooling");
  for (const [variable, field] of Object.entries({ CANDIDATE_RUN_ID: "runId", CANDIDATE_ARTIFACT_ID: "artifactId",
    CANDIDATE_ATTEMPT: "attempt", CANDIDATE_SOURCE: "source", CANDIDATE_DIGEST: "artifactDigest" })) {
    assert.equal(publish.env[variable], `\${{ needs.select.outputs.${field} }}`);
  }
  assert.doesNotMatch(JSON.stringify(workflow), /secrets\.|actions\/cache|download-artifact/);
});
