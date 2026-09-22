import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

// A regression check for contribution CI, not a security boundary or a YAML validator.
export function checkPolicy(workflow) {
  const failures = [];
  const require = (condition, message) => { if (!condition) failures.push(message); };
  const readOnly = (permissions) => permissions === "read-all"
    || (permissions !== null && typeof permissions === "object"
      && Object.values(permissions).every(value => value === "read" || value === "none"));
  const events = typeof workflow.on === "string" ? [workflow.on]
    : Array.isArray(workflow.on) ? workflow.on : Object.keys(workflow.on ?? {});
  require(events.every(event => ["pull_request", "push"].includes(event)),
    "Only pull_request and push may trigger contribution CI");
  require(readOnly(workflow.permissions), "Contribution CI requires explicit read-only token permissions");
  require(!/\$\{\{[^}]*\bsecrets\b/i.test(JSON.stringify(workflow)), "No secrets context in contribution CI");
  for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
    require(job.permissions === undefined || readOnly(job.permissions), `${name}: cannot escalate token permissions`);
    require(job.secrets === undefined, `${name}: do not pass secrets to reusable workflows`);
    for (const step of [job, ...(job.steps ?? [])]) {
      if (!step.uses) continue;
      require(step.uses.startsWith("./") || /^[\w.-]+(?:\/[\w.-]+)+@[0-9a-f]{40}$/i.test(step.uses),
        `${name}: external actions and workflows need full commit SHAs`);
      const action = step.uses.split("@")[0];
      if (action === "actions/checkout") require([false, "false"].includes(step.with?.["persist-credentials"]),
        `${name}: checkout must not persist credentials`);
    }
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkPolicy(load(readFileSync(".github/workflows/ci.yml", "utf8")));
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else console.log("Contribution workflow permission/event policy passed");
}
