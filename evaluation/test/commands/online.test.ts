import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { runOnlineEvaluation } from "../../src/commands/online.ts";
import type { RunRequest, SessionDependencies } from "../../src/commands/run.ts";
import type { OnlineArtifact } from "../../src/contracts/records.ts";
import { EvaluationError } from "../../src/shared/errors.ts";
import { REPOSITORY_ROOT, temporaryDirectory } from "../support/fixtures.ts";
import { AUTH_PASSWORD, createHarness, type Harness, type HarnessOptions } from "../support/harness.ts";
import { jsonResponse } from "../support/responses.ts";

const GOLDEN = path.resolve(import.meta.dirname, "../fixtures/golden");
const coded = (code: string) => (error: unknown) => error instanceof EvaluationError && error.code === code;

function online(options: HarnessOptions = {}): Harness {
  const harness = createHarness(options);
  harness.state.online = true;
  return harness;
}

async function run(harness: Harness, request: RunRequest = { profile: "k3s-public", context: "k3s-k8s-incident-agent" }) {
  const previousPath = process.env.PATH;
  process.env.PATH = harness.release.environment.PATH;
  try {
    return await runOnlineEvaluation({ releasePath: harness.release.path, ...request }, harness.dependencies as SessionDependencies);
  } finally {
    process.env.PATH = previousPath;
  }
}

test("the public boundary proves read-only routes, the Console launcher's absence and an accepted operator rerun, exactly as recorded", async () => {
  const harness = online();
  const { artifact, artifactPath } = await run(harness);
  assert.equal(`${JSON.stringify(artifact, null, 2)}\n`, readFileSync(path.join(GOLDEN, "online.json"), "utf8"));
  assert.equal(artifactPath, "/artifacts/k3s-public.json");
  assert.equal(harness.calls.tunnelClose, 1);
  assert.equal(harness.calls.scenarioApply, 0);
  const serialized = JSON.stringify(artifact);
  for (const secret of [AUTH_PASSWORD, harness.state.cookie, harness.state.csrf]) assert.equal(serialized.includes(String(secret)), false);
});

test("an assembled manual route or a Console launcher fails the boundary with its own code", async () => {
  const routes = await run(online({ onlineManualRoutes: true }));
  assert.equal(routes.artifact.status, "failed");
  assert.deepEqual(routes.artifact.failure, { code: "online_route_set_invalid", message: "Online profile exposes a manual intake route" });
  assert.equal("checks" in routes.artifact, false);

  const launcher = online();
  const fetch = launcher.dependencies.fetch;
  launcher.dependencies.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.port === "13000" && url.pathname === "/") return new Response("K8s Incident Agent 创建 Incident", { status: 200 });
    return fetch(input, init);
  };
  const consoleResult = await run(launcher);
  assert.equal(consoleResult.artifact.failure?.code, "online_console_invalid");
});

test("the rerun oracle rejects every response that is not backed by the Runtime's own state", async (t) => {
  for (const [options, code] of [
    [{ onlineEmpty: true }, "online_existing_incident_required"],
    [{ anonymousRerunAllowed: true }, "online_rerun_boundary_invalid"],
    [{ onlineRerunStatus: 200 }, "online_rerun_boundary_invalid"],
    [{ onlineRerunStatus: 422 }, "online_rerun_boundary_invalid"],
    [{ onlineWrongRun: true }, "upstream_contract_invalid"],
  ] as const) {
    await t.test(JSON.stringify(options), async () => {
      const { artifact } = await run(online(options));
      assert.equal(artifact.status, "failed");
      assert.equal(artifact.failure?.code, code);
    });
  }
  for (const [status, reason] of [[409, "active_run_exists"], [503, "diagnosis_unavailable"]] as const) {
    await t.test(reason, async () => {
      const { artifact } = await run(online({ onlineRerunStatus: status }));
      assert.equal(artifact.status, "passed");
      assert.equal(artifact.checks?.authenticatedRerun, reason);
    });
  }
  // The fake pairs each answer with the Runtime state that justifies it; each pair is broken one at a time.
  const rerunRequest = (url: URL, init?: RequestInit) => url.pathname.endsWith("/runs") && init?.method === "POST";
  const authenticated = (init?: RequestInit) => new Headers(init?.headers).has("cookie");
  const operatorRerun = (url: URL, init?: RequestInit) => rerunRequest(url, init) && authenticated(init);
  const anonymousRerun = (url: URL, init?: RequestInit) => rerunRequest(url, init) && !authenticated(init);
  const unmatched = [
    ["only the scenario catalog route is assembled", {}, (url: URL) =>
      url.pathname === "/api/v1/scenarios" ? new Response(null, { status: 200 }) : undefined, "online_route_set_invalid"],
    ["only the manual intake route is assembled", {}, (url: URL, init?: RequestInit) =>
      url.pathname === "/api/v1/incidents" && init?.method === "POST" ? new Response(null, { status: 422 }) : undefined, "online_route_set_invalid"],
    ["anonymous rerun denied with the wrong status", {}, (url: URL, init?: RequestInit) =>
      anonymousRerun(url, init) ? jsonResponse({ error: { code: "operator_authentication_required" } }, 403) : undefined, "online_rerun_boundary_invalid"],
    ["anonymous rerun denied with the wrong code", {}, (url: URL, init?: RequestInit) =>
      anonymousRerun(url, init) ? jsonResponse({ error: { code: "invalid_request" } }, 401) : undefined, "online_rerun_boundary_invalid"],
    ["409 without an active run", {}, (url: URL, init?: RequestInit) =>
      operatorRerun(url, init) ? jsonResponse({ error: { code: "active_run_exists" } }, 409) : undefined, "online_rerun_boundary_invalid"],
    ["409 with a foreign code while a run is active", { onlineRerunStatus: 409 }, (url: URL, init?: RequestInit) =>
      operatorRerun(url, init) ? jsonResponse({ error: { code: "conflict" } }, 409) : undefined, "online_rerun_boundary_invalid"],
    ["503 with a ready diagnosis", {}, (url: URL, init?: RequestInit) =>
      operatorRerun(url, init) ? jsonResponse({ error: { code: "diagnosis_unavailable" } }, 503) : undefined, "upstream_contract_invalid"],
    ["503 with a foreign code while diagnosis is unavailable", { onlineRerunStatus: 503 }, (url: URL, init?: RequestInit) =>
      operatorRerun(url, init) ? jsonResponse({ error: { code: "unavailable" } }, 503) : undefined, "online_rerun_boundary_invalid"],
  ] as const;
  for (const [name, options, answer, code] of unmatched) {
    await t.test(name, async () => {
      const harness = online(options);
      const fetch = harness.dependencies.fetch;
      harness.dependencies.fetch = async (input, init) => answer(new URL(String(input)), init) ?? fetch(input, init);
      const { artifact } = await run(harness);
      assert.equal(artifact.status, "failed");
      assert.equal(artifact.failure?.code, code);
    });
  }
  // The incident detail read before the rerun ("before") and the one read for the accepted run ("after").
  for (const [name, target, patch] of [
    ["the existing incident's attempt is zero", "before", { attempt: 0 }],
    ["the existing incident's attempt is not an integer", "before", { attempt: 1.5 }],
    ["an accepted rerun's attempt did not advance", "after", { attempt: 1 }],
    ["an accepted rerun's attempt is not an integer", "after", { attempt: 2.5 }],
    ["an accepted rerun's attempt is a numeric string", "after", { attempt: "2" }],
    ["an accepted rerun was not requested by the operator", "after", { requestSource: "system" }],
    ["an accepted rerun is not a diagnosis", "after", { kind: "repair" }],
    ["an accepted rerun's status is not a run status", "after", { status: "PENDING" }],
  ] as const) {
    await t.test(name, async () => {
      const harness = online();
      const fetch = harness.dependencies.fetch;
      harness.dependencies.fetch = async (input, init) => {
        const response = await fetch(input, init);
        const url = new URL(String(input));
        const detailRead = url.pathname.startsWith("/api/v1/incidents/") && !url.pathname.endsWith("/runs") && (init?.method ?? "GET") === "GET";
        if (!detailRead || url.searchParams.has("runId") !== (target === "after")) return response;
        const detail = (await response.json()) as { selectedRun: Record<string, unknown> };
        return jsonResponse({ ...detail, selectedRun: { ...detail.selectedRun, ...patch } });
      };
      const { artifact } = await run(harness);
      assert.equal(artifact.failure?.code, "upstream_contract_invalid");
    });
  }
});

test("deployment checks receive expected nonzero command results", async () => {
  const harness = online();
  const execute = harness.dependencies.execute;
  harness.dependencies.execute = async (command, args, options) => {
    if (command === "git") return execute(command, args, options);
    throw Object.assign(new Error("expected access denial"), { exitCode: 1, stdout: "no\n" });
  };
  harness.dependencies.verifyDeploymentStatus = async (_profile, _context, dependencies) => {
    assert.deepEqual(await dependencies?.execute?.("kubectl", ["auth", "can-i"], { timeoutMilliseconds: 1, maxBufferBytes: 1 }), { stdout: "no\n", exitCode: 1 });
    return { deployments: "ready" };
  };
  assert.equal((await run(harness)).artifact.status, "passed");
});

test("the online command only serves the public profile with a context, a release and no campaign selection", async (t) => {
  for (const request of [
    { profile: "k3s-evaluation", context: "k3s" },
    { profile: "kind-evaluation" },
    { profile: "k3s-public" },
    { profile: "k3s-public", context: "-x" },
    { profile: "k3s-public", context: "k3s", scenarioIds: ["pvc-binding-pending"] },
    { profile: "k3s-public", context: "k3s", datasetPath: "regression.json" },
    { profile: "k3s-public", context: "k3s", split: "regression" },
    { profile: "k3s-public", context: "k3s", retryOf: "20260901T000000Z-0123abcd" },
    { profile: "unknown", context: "k3s" },
  ] as const) {
    await t.test(JSON.stringify(request), async () => {
      const harness = online();
      harness.dependencies.verifyDeploymentStatus = async () => assert.fail("deployment preflight reached");
      harness.dependencies.openTunnels = async () => assert.fail("tunnel opened");
      await assert.rejects(run(harness, request), coded("invalid_arguments"));
    });
  }
  await assert.rejects(runOnlineEvaluation({ profile: "k3s-public", context: "k3s" }, online().dependencies as SessionDependencies), coded("invalid_arguments"));
  const dirty = online({ dirtyWorktree: true });
  await assert.rejects(run(dirty), coded("release_worktree_dirty"));
});

test("an authentication failure produces a failed boundary artifact without checks", async () => {
  const harness = online();
  harness.dependencies.environment.OPERATOR_PASSWORD_FILE = undefined;
  const { artifact } = await run(harness);
  const recorded: OnlineArtifact = JSON.parse(JSON.stringify(artifact));
  assert.deepEqual(Object.keys(recorded), ["schemaVersion", "kind", "profile", "release", "startedAt", "completedAt", "status", "failure"]);
  assert.deepEqual({ schemaVersion: recorded.schemaVersion, kind: recorded.kind, profile: recorded.profile, status: recorded.status, code: recorded.failure?.code }, {
    schemaVersion: 2, kind: "online-boundary-evaluation", profile: "k3s-public", status: "failed", code: "operator_authentication_failed",
  });
  assert.equal(harness.calls.tunnelClose, 1);
});

test("the boundary artifact is written to the profile file and replaced on the next run", async (t) => {
  const root = temporaryDirectory(t, "evaluation-online-");
  const first = online();
  first.dependencies.repositoryRoot = root;
  delete first.dependencies.writeArtifact;
  const execute = first.dependencies.execute;
  first.dependencies.execute = (command, args, settings) => execute(command, args, { ...settings, cwd: REPOSITORY_ROOT });
  const { artifactPath } = await run(first);
  assert.equal(artifactPath, path.join(root, ".runtime/evaluation/k3s-public.json"));
  assert.equal(statSync(artifactPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(artifactPath, "utf8")).status, "passed");

  const second = online({ onlineManualRoutes: true });
  second.dependencies.repositoryRoot = root;
  delete second.dependencies.writeArtifact;
  second.dependencies.execute = (command, args, settings) => execute(command, args, { ...settings, cwd: REPOSITORY_ROOT });
  assert.equal((await run(second)).artifactPath, artifactPath);
  assert.equal(JSON.parse(readFileSync(artifactPath, "utf8")).status, "failed");
  assert.deepEqual(readdirSync(path.join(root, ".runtime/evaluation")), ["k3s-public.json"]);
});
