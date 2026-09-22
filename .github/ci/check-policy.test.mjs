import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";
import { checkPolicy } from "./check-policy.mjs";

const current = () => load(readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8"));

test("current workflow and non-security presentation changes are allowed", () => {
  const workflow = current();
  assert.deepEqual(checkPolicy(workflow), []);
  workflow.name = "Renamed checks";
  workflow.jobs = Object.fromEntries(Object.entries(workflow.jobs).reverse());
  for (const job of Object.values(workflow.jobs)) job.name = "Presentation only";
  assert.deepEqual(checkPolicy(workflow), []);
});

test("implementation choices are reviewed without being frozen by policy", () => {
  const workflow = current();
  workflow.on.push.branches = ["main", "release/**"];
  workflow.on.pull_request = { paths: ["src/**"] };
  delete workflow.concurrency;
  workflow.jobs.web["runs-on"] = "windows-2025";
  workflow.jobs.web["timeout-minutes"] = 45;
  workflow.jobs.web.steps[1].with["package-manager-cache"] = true;
  workflow.jobs.web.steps[1].with.cache = "npm";
  workflow.jobs.runtime.steps[1].with["enable-cache"] = true;
  workflow.jobs.web.steps.push({ uses: `actions/upload-artifact@${"a".repeat(40)}` });
  assert.deepEqual(checkPolicy(workflow), []);
});

test("read-only and disabled token permissions are both allowed", () => {
  for (const permissions of [{}, { contents: "read", actions: "read" }, "read-all"]) {
    const workflow = current();
    workflow.permissions = permissions;
    workflow.jobs.runtime.permissions = {};
    workflow.jobs.runtime.steps[0].with["persist-credentials"] = "false";
    assert.deepEqual(checkPolicy(workflow), []);
  }
});

test("supported event shorthand retains the same trust restriction", () => {
  for (const events of ["pull_request", ["pull_request", "push"]]) {
    const workflow = current();
    workflow.on = events;
    assert.deepEqual(checkPolicy(workflow), []);
  }
});

for (const [name, mutate, expected] of [
  ["privileged PR event", w => { w.on.pull_request_target = {}; }, /Only pull_request/],
  ["privileged event shorthand", w => { w.on = "pull_request_target"; }, /Only pull_request/],
  ["write token", w => { w.permissions.contents = "write"; }, /read-only token/],
  ["implicit token permissions", w => { delete w.permissions; }, /read-only token/],
  ["write-all token", w => { w.permissions = "write-all"; }, /read-only token/],
  ["job escalation", w => { w.jobs.runtime.permissions = { "id-token": "write" }; }, /escalate/],
  ["secret access", w => { w.env.TOKEN = "${{ secrets.DEPLOY_KEY }}"; }, /secrets context/],
  ["whole secrets context", w => { w.env.DATA = "${{ toJSON(secrets) }}"; }, /secrets context/],
  ["inherited secrets", w => { w.jobs.shared = { uses: `example/checks/.github/workflows/check.yml@${"a".repeat(40)}`, secrets: "inherit" }; }, /pass secrets/],
  ["floating Action", w => { w.jobs.runtime.steps[0].uses = "actions/checkout@v6"; }, /full commit SHAs/],
  ["floating reusable workflow", w => { w.jobs.shared = { uses: "example/checks/.github/workflows/check.yml@main" }; }, /full commit SHAs/],
  ["persisted credential", w => { delete w.jobs.runtime.steps[0].with["persist-credentials"]; }, /persist credentials/],
]) {
  test(`rejects ${name}`, () => {
    const workflow = current();
    mutate(workflow);
    assert.match(checkPolicy(workflow).join("\n"), expected);
  });
}
