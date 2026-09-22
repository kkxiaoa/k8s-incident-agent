import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { load } from "js-yaml";

const workflow = load(readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8"));
const candidate = workflow.jobs.candidate;

test("candidate requires all quality jobs and only the owning repository main push", () => {
  assert.deepEqual([...candidate.needs].sort(), Object.keys(workflow.jobs).filter(name => name !== "candidate").sort());
  // Evaluate the workflow's actual conjunction, not a separately copied predicate.
  const terms = candidate.if.split("&&").map(term => {
    const match = /^\s*github\.(repository|event_name|ref) == '([^']+)'\s*$/.exec(term);
    assert.ok(match, "Review new trigger expression semantics before accepting a different gate");
    return match.slice(1);
  });
  for (const [repository, event_name, ref, expected] of [
    ["kkxiaoa/k8s-incident-agent", "push", "refs/heads/main", true],
    ["fork/k8s-incident-agent", "push", "refs/heads/main", false],
    ["kkxiaoa/k8s-incident-agent", "pull_request", "refs/heads/main", false],
    ["kkxiaoa/k8s-incident-agent", "push", "refs/heads/topic", false],
  ]) assert.equal(terms.every(([key, value]) => ({ repository, event_name, ref })[key] === value), expected);
  assert.equal(candidate["continue-on-error"], undefined);
  assert.ok(candidate.steps.every(step => step.if === undefined && step["continue-on-error"] === undefined));
  const checkout = candidate.steps.find(step => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.sha }}");
});

test("candidate uploads only packaged content after exact-image smoke, with bounded retention", () => {
  const smoke = candidate.steps.findIndex(step => step.run?.includes("scripts/release-smoke.mjs"));
  const pack = candidate.steps.findIndex(step => step.run?.includes("scripts/release.mjs pack"));
  const upload = candidate.steps.findIndex(step => step.uses?.startsWith("actions/upload-artifact@"));
  assert.ok(smoke > 0 && pack > smoke && upload > pack);
  assert.deepEqual(candidate.steps[upload].with.path.trim().split("\n"),
    ["${{ runner.temp }}/incident-candidate/candidate.tar.gz", "${{ runner.temp }}/incident-candidate/SHA256SUMS"]);
  assert.equal(candidate.steps[upload].with["retention-days"], 7);
  assert.equal(candidate.steps[upload].with["if-no-files-found"], "error");
  assert.equal(candidate.steps[upload].with.overwrite, false);
  const pins = JSON.parse(readFileSync(new URL("release-tools.json", import.meta.url), "utf8"));
  assert.match(pins.buildx, /^v\d+\.\d+\.\d+$/);
  for (const key of ["buildkit", "qemu", "skopeo"]) assert.match(pins[key], /:[^@]+@sha256:[a-f0-9]{64}$/);
});
