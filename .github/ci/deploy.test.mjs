import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";

const workflow = load(await readFile(new URL("../workflows/deploy.yml", import.meta.url), "utf8"));
const secretNames = ["DEPLOY_SSH_PRIVATE_KEY", "DEPLOY_SSH_KNOWN_HOSTS", "DEPLOY_SSH_HOST", "DEPLOY_SSH_USER"];

test("deployment is a manual owning-main dispatch of one version and one gateway profile", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  const { inputs } = workflow.on.workflow_dispatch;
  assert.deepEqual(Object.keys(inputs), ["version", "profile"]);
  assert.equal(inputs.version.type, "string");
  assert.equal(inputs.profile.type, "choice");
  assert.deepEqual(workflow.permissions, { contents: "read", actions: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  for (const job of Object.values(workflow.jobs)) {
    assert.match(job.if, /github\.repository == 'kkxiaoa\/k8s-incident-agent'/);
    assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
    assert.match(job.if, /github\.run_attempt == 1/);
    assert.equal(job.permissions, undefined);
    for (const step of job.steps) {
      if (!step.uses) continue;
      assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      if (step.uses.startsWith("actions/checkout@")) assert.equal(step.with["persist-credentials"], false);
    }
  }
});

test("only the approved job can read the deployment credentials", () => {
  const { select, deploy } = workflow.jobs;
  assert.equal(select.environment, undefined);
  assert.doesNotMatch(JSON.stringify(select), /secrets\./);
  assert.equal(select.steps.at(-1).run, "node scripts/deploy-dispatch.mjs select");
  assert.equal(deploy.needs, "select");
  assert.equal(deploy.environment, "deploy");
  const step = deploy.steps.at(-1);
  assert.equal(step.run, "node scripts/deploy-dispatch.mjs deploy");
  for (const name of secretNames) assert.equal(step.env[name], `\${{ secrets.${name} }}`);
  // The approved job compares the release it rereads with every identity the reviewer saw.
  for (const [output, variable] of [["version", "DEPLOY_VERSION"], ["profile", "DEPLOY_PROFILE"], ["sourceRevision", "DEPLOY_SOURCE"],
    ["images", "DEPLOY_IMAGES"]]) {
    assert.equal(select.outputs[output], `\${{ steps.release.outputs.${output} }}`);
    assert.equal(step.env[variable], `\${{ needs.select.outputs.${output} }}`);
  }
  const referenced = [...JSON.stringify(workflow).matchAll(/secrets\.(\w+)/g)].map(match => match[1]).sort();
  assert.deepEqual(referenced, [...secretNames].sort());
  assert.doesNotMatch(JSON.stringify(deploy.steps.slice(0, -1)), /secrets\./);
});
