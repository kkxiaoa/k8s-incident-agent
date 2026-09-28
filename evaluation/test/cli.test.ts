import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseArguments, runCli, type CliCommands, type CliOutput } from "../src/cli.ts";
import { runReportCommand } from "../src/commands/report.ts";
import { contractError, EvaluationError } from "../src/shared/errors.ts";
import { campaign, review } from "./review/layout.ts";
import { REPOSITORY_ROOT } from "./support/fixtures.ts";

const CLI = path.join(REPOSITORY_ROOT, "evaluation/src/cli.ts");
const RELEASE = "release.json";
const coded = (code: string) => (error: unknown) => error instanceof EvaluationError && error.code === code;

function invoke(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: REPOSITORY_ROOT });
}

test("arguments parse into the requests the commands accept and nothing else", () => {
  const empty = { context: undefined, datasetPath: undefined, releasePath: RELEASE, split: undefined, retryOf: undefined };
  assert.deepEqual(parseArguments(["run", "kind-evaluation", "--release", RELEASE]), {
    action: "run",
    request: { profile: "kind-evaluation", ...empty },
  });
  assert.deepEqual(
    parseArguments([
      "run", "k3s-evaluation", "--context", "k3s", "--release", RELEASE, "--scenario", "crash-loop-backoff", "--scenario", "pvc-binding-pending",
      "--dataset", "dataset.json", "--split", "regression", "--retry-of", "20260901T000000Z-0123abcd",
    ]),
    {
      action: "run",
      request: {
        profile: "k3s-evaluation",
        context: "k3s",
        datasetPath: "dataset.json",
        releasePath: RELEASE,
        split: "regression",
        retryOf: "20260901T000000Z-0123abcd",
        scenarioIds: ["crash-loop-backoff", "pvc-binding-pending"],
      },
    },
  );
  assert.deepEqual(parseArguments(["online", "k3s-public", "--context", "k3s", "--release", RELEASE]), {
    action: "online",
    request: { profile: "k3s-public", ...empty, context: "k3s" },
  });
  assert.deepEqual(parseArguments(["report", "artifact.json"]), { action: "report", artifactPath: "artifact.json" });
  for (const argv of [
    [],
    ["run"],
    ["report"],
    ["report", "artifact.json", "extra"],
    ["verify", "kind-evaluation"],
    ["run", "kind-evaluation", "--scenario"],
    ["run", "kind-evaluation", "--scenario", "--context"],
    ["run", "kind-evaluation", "--release", "-x"],
    ["run", "kind-evaluation", "--context", "a", "--context", "b"],
    ["run", "kind-evaluation", "--unknown", "value"],
    ["online", "k3s-public", "--context", "k3s", "--scenario", "pvc-binding-pending"],
    ["online", "k3s-public", "--context", "k3s", "--retry-of", "20260901T000000Z-0123abcd"],
    ["online", "k3s-public", "--context", "k3s", "--dataset", "regression.json"],
    ["online", "k3s-public", "--context", "k3s", "--split", "regression"],
  ]) {
    assert.throws(() => parseArguments(argv), coded("invalid_arguments"), argv.join(" "));
  }
});

test("the entry point fails closed on invalid arguments before any side effect", () => {
  for (const args of [
    [],
    ["run", "kind-evaluation"],
    ["run", "kind-evaluation", "--scenario"],
    ["run", "kind-evaluation", "--scenario", "--context"],
    ["online", "k3s-public", "--context", "k3s", "--scenario", "pvc-binding-pending"],
    ["run", "kind-evaluation", "--dataset"],
    ["run", "kind-evaluation", "--split", "unknown"],
    ["run", "kind-evaluation", "--retry-of"],
    ["online", "k3s-public", "--context", "k3s", "--retry-of", "20260901T000000Z-0123abcd"],
    ["online", "k3s-public", "--context", "k3s", "--dataset", "regression.json"],
  ]) {
    const result = invoke(...args);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /^FAIL invalid_arguments /, args.join(" "));
    assert.equal(result.stdout, "");
  }
});

test("the report action prints the campaign report and fails closed, and both npm scripts are wired to the entry point", async (t) => {
  const { file } = campaign(t, { reviews: [review()] });
  const ok = invoke("report", file);
  assert.equal(ok.status, 0, ok.stderr);
  const printed = JSON.parse(ok.stdout);
  assert.equal(printed.scenarios[0].review.status, "pass");
  assert.deepEqual(printed, JSON.parse(JSON.stringify(await runReportCommand(file))));
  const missing = invoke("report", path.join(path.dirname(file), "20260905T000000Z-0000ffff.json"));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^FAIL evaluation_artifact_invalid /);
  const usage = invoke("report");
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /^FAIL invalid_arguments /);

  const { scripts } = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
  assert.equal(scripts.evaluation, "node evaluation/src/cli.ts");
  assert.equal(scripts["evaluation-report"], "node evaluation/src/cli.ts report");
  assert.match(scripts.test, /tsc -p evaluation\/tsconfig\.json --noEmit/);
  assert.match(scripts.test, /node --test "evaluation\/test\/\*\*\/\*\.test\.ts"/);
});

test("artifact statuses and failures map to the documented exit codes and output lines", async () => {
  const lines = { stdout: [] as string[], stderr: [] as string[] };
  const output: CliOutput = { stdout: (text) => lines.stdout.push(text), stderr: (text) => lines.stderr.push(text) };
  const outcome = (status: string) => async () => ({ artifact: { status, profile: "kind-evaluation" }, artifactPath: "/artifacts/kind-evaluation/a.json" });
  const commands = (run: CliCommands["run"], report: CliCommands["report"] = async () => ({ status: "passed" })): CliCommands => ({ run, online: run, report });
  const runArgs = ["run", "kind-evaluation", "--release", RELEASE];
  const onlineArgs = ["online", "k3s-public", "--context", "k3s", "--release", RELEASE];

  assert.equal(await runCli(runArgs, output, commands(outcome("passed"))), 0);
  assert.equal(await runCli(onlineArgs, output, commands(outcome("pending_manual_review"))), 2);
  assert.equal(await runCli(runArgs, output, commands(outcome("failed"))), 1);
  assert.deepEqual(lines.stdout, [
    '{"status":"passed","profile":"kind-evaluation","artifact":"/artifacts/kind-evaluation/a.json"}\n',
    '{"status":"pending_manual_review","profile":"kind-evaluation","artifact":"/artifacts/kind-evaluation/a.json"}\n',
    '{"status":"failed","profile":"kind-evaluation","artifact":"/artifacts/kind-evaluation/a.json"}\n',
  ]);
  assert.deepEqual(lines.stderr, []);

  assert.equal(await runCli(runArgs, output, commands(async () => { throw contractError("monitoring_not_healthy", "Monitoring did not become healthy"); })), 1);
  assert.equal(await runCli(runArgs, output, commands(async () => { throw new Error("private upstream detail"); })), 1);
  assert.equal(await runCli(["report", "artifact.json"], output, commands(outcome("passed"), async () => { throw new TypeError("private upstream detail"); })), 1);
  assert.equal(await runCli(["report", "artifact.json"], output, commands(outcome("passed"), async () => { throw contractError("evaluation_review_invalid", "reviews/a.json is not a valid review"); })), 1);
  assert.equal(await runCli(["verify"], output, commands(outcome("passed"))), 1);
  assert.deepEqual(lines.stderr, [
    "FAIL monitoring_not_healthy Monitoring did not become healthy\n",
    "FAIL evaluation_failed Scenario evaluation failed without exposing upstream content\n",
    "FAIL evaluation_report_failed The report could not be produced\n",
    "FAIL evaluation_review_invalid reviews/a.json is not a valid review\n",
    "FAIL invalid_arguments Evaluation arguments do not match the supported usage\n",
  ]);
  assert.equal(lines.stdout.length, 3);

  assert.equal(await runCli(["report", "artifact.json"], output, commands(outcome("passed"))), 0);
  assert.equal(lines.stdout.at(-1), '{\n  "status": "passed"\n}\n');
});
