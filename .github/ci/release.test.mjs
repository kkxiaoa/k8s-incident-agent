import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";

const workflow = load(readFileSync(new URL("../workflows/release.yml", import.meta.url), "utf8"));
const releasePr = load(readFileSync(new URL("../workflows/release-please.yml", import.meta.url), "utf8"));
const config = JSON.parse(readFileSync(new URL("../../release-please-config.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../../.release-please-manifest.json", import.meta.url), "utf8"));

test("publication has a manual owning-main boundary and one protected writer", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["release_pr"]);
  assert.deepEqual(workflow.permissions, { contents: "read", actions: "read", "pull-requests": "read" });
  assert.match(workflow.jobs.select.if, /github.repository == 'kkxiaoa\/k8s-incident-agent'/);
  assert.match(workflow.jobs.select.if, /github.ref == 'refs\/heads\/main'/);
  assert.equal(workflow.jobs.publish.needs, "select");
  assert.equal(workflow.jobs.publish.environment, "release");
  assert.deepEqual(workflow.jobs.publish.permissions,
    { contents: "write", packages: "write", actions: "read", "pull-requests": "write", issues: "write" });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
});

test("Release Please only maintains the release PR on trusted main and never runs repository code", () => {
  assert.deepEqual(releasePr.on, { push: { branches: ["main"] } });
  assert.deepEqual(releasePr.permissions, {});
  assert.deepEqual(Object.keys(releasePr.jobs), ["release-pr"]);
  const job = releasePr.jobs["release-pr"];
  assert.match(job.if, /github.repository == 'kkxiaoa\/k8s-incident-agent'/);
  assert.match(job.if, /github.ref == 'refs\/heads\/main'/);
  assert.deepEqual(job.permissions, { contents: "write", "pull-requests": "write", issues: "write" });
  assert.equal(job.steps.length, 1);
  assert.match(job.steps[0].uses, /^googleapis\/release-please-action@[a-f0-9]{40}$/);
  assert.deepEqual(job.steps[0].with, { "skip-github-release": true, "config-file": "release-please-config.json",
    "manifest-file": ".release-please-manifest.json" });
  assert.doesNotMatch(JSON.stringify(releasePr), /secrets\.|actions\/checkout|"run"/);
});

test("Release Please config cannot create releases and tags v-prefixed root versions", () => {
  assert.deepEqual(Object.keys(config.packages), ["."]);
  const root = config.packages["."];
  assert.equal(root["release-type"], "simple");
  assert.equal(root["skip-github-release"], true);
  assert.equal(root["include-component-in-tag"], false);
  for (const key of ["draft", "force-tag-creation", "include-v-in-tag", "release-as"]) {
    assert.equal(Object.hasOwn(root, key) || Object.hasOwn(config, key), false, key);
  }
  assert.match(config["bootstrap-sha"], /^[a-f0-9]{40}$/);
  assert.deepEqual(Object.keys(manifest), ["."]);
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
  const select = workflow.jobs.select.steps.find(step => step.run === "node scripts/publish.mjs select");
  assert.deepEqual(select.env, { GH_TOKEN: "${{ github.token }}", RELEASE_PR: "${{ inputs.release_pr }}" });
  const publish = workflow.jobs.publish.steps.find(step => step.run === "node scripts/publish.mjs publish");
  assert.equal(publish["working-directory"], "tooling");
  for (const [variable, field] of Object.entries({ RELEASE_PR: "releasePr", RELEASE_VERSION: "version",
    CANDIDATE_RUN_ID: "runId", CANDIDATE_ARTIFACT_ID: "artifactId", CANDIDATE_ATTEMPT: "attempt",
    CANDIDATE_SOURCE: "source", CANDIDATE_DIGEST: "artifactDigest" })) {
    assert.equal(publish.env[variable], `\${{ needs.select.outputs.${field} }}`);
  }
  assert.doesNotMatch(JSON.stringify(workflow), /secrets\.|actions\/cache|download-artifact/);
});
