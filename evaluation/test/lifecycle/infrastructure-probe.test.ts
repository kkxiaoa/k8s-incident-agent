import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { ScenarioCommandError } from "../../../scripts/scenario.mjs";
import { runInfrastructureProbe, waitForHealthyMonitoring, type ProbeEnvironment } from "../../src/lifecycle/infrastructure-probe.ts";
import { runTrial, runtimeReaders } from "../../src/lifecycle/trial.ts";
import { EvaluationError } from "../../src/shared/errors.ts";
import { caseNamed, trialFixture, type TrialFixture } from "./support.ts";

function probeEnvironment(fixture: TrialFixture): ProbeEnvironment {
  const { profile, context, release, repositoryRoot, fetchImpl, execute, scenarioRunner, sleep } = fixture.environment;
  return {
    profile,
    context,
    release,
    repositoryRoot,
    fetchImpl,
    execute,
    scenarioRunner,
    sleep,
    scenarios: fixture.cases,
    tunnels: {
      async restart() {
        fixture.harness.calls.tunnelRestart += 1;
      },
      async close() {
        fixture.harness.calls.tunnelClose += 1;
      },
    },
  };
}

test("the probe re-applies the last passing scenario and proves monitoring, credential and workload recovery", async () => {
  const fixture = await trialFixture();
  const passing = await runTrial(caseNamed(fixture.cases, "image-pull-backoff"), fixture.environment);
  assert.equal(passing.status, "pending_manual_review");
  const actions: string[] = [];
  const original = fixture.harness.dependencies.runScenarioCommand;
  const environment = probeEnvironment(fixture);
  environment.scenarioRunner = async (action, scenarioId, dependencies) => {
    actions.push(`${action}:${scenarioId}`);
    return original(action, scenarioId, dependencies);
  };

  const result = await runInfrastructureProbe(passing, environment);
  assert.deepEqual(result, {
    status: "passed",
    checks: { kubeStateMetricsStale: true, prometheusUnavailable: true, secretRotation: true, workloadRecovery: true, persistedIncidentReplay: true },
  });
  assert.deepEqual(actions, ["apply:image-pull-backoff", "verify:image-pull-backoff", "cleanup:image-pull-backoff"]);
  assert.equal(fixture.harness.calls.alertmanagerRestarts, 1);
  assert.equal(fixture.harness.calls.tunnelRestart, 2);
  assert.equal(fixture.harness.state.prometheus, true);
  assert.equal(fixture.harness.state.kubeStateMetrics, true);
  assert.equal(fixture.harness.state.logins, 2);
});

test("the probe ignores another alert on the same Deployment and cleans a partially applied fixture", async () => {
  const fixture = await trialFixture({ otherAlertSameTargetScenarioId: "readiness-probe-misconfigured" });
  const passing = await runTrial(caseNamed(fixture.cases, "readiness-probe-misconfigured"), fixture.environment);
  assert.equal(passing.status, "pending_manual_review", JSON.stringify(passing.failure));
  assert.equal((await runInfrastructureProbe(passing, probeEnvironment(fixture))).status, "passed");

  const partial = await trialFixture();
  const applied = await runTrial(caseNamed(partial.cases, "image-pull-backoff"), partial.environment);
  const environment = probeEnvironment(partial);
  const actions: string[] = [];
  const original = partial.harness.dependencies.runScenarioCommand;
  environment.scenarioRunner = async (action, scenarioId, dependencies) => {
    actions.push(action);
    if (action === "apply") throw new ScenarioCommandError("upstream_unavailable", "The healthy rollout did not complete");
    return original(action, scenarioId, dependencies);
  };
  await assert.rejects(runInfrastructureProbe(applied, environment), (error: unknown) => {
    assert.ok(error instanceof EvaluationError);
    assert.deepEqual({ code: error.code, message: error.message }, { code: "upstream_unavailable", message: "The healthy rollout did not complete" });
    return true;
  });
  assert.deepEqual(actions, ["apply", "cleanup"]);
});

test("a probe without a trigger panel, a known scenario or a persisted Incident reports why it could not run", async () => {
  const fixture = await trialFixture();
  const passing = await runTrial(caseNamed(fixture.cases, "crash-loop-backoff"), fixture.environment);
  const environment = probeEnvironment(fixture);
  assert.deepEqual(await runInfrastructureProbe({ ...passing, checks: { ...passing.checks, panels: [] } }, environment), {
    status: "failed",
    failureCode: "panel_probe_unavailable",
  });
  assert.deepEqual(await runInfrastructureProbe(passing, { ...environment, scenarios: [] }), { status: "failed", failureCode: "panel_probe_unavailable" });

  const fresh = await trialFixture();
  assert.deepEqual(await runInfrastructureProbe(passing, probeEnvironment(fresh)), { status: "failed", failureCode: "incident_probe_unavailable" });
});

test("a rotated credential that never produces a fresh watchdog is reported after the health budget", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-05T00:00:00Z") });
  const fixture = await trialFixture({ staleWatchdogAfterRotation: true });
  const passing = await runTrial(caseNamed(fixture.cases, "crash-loop-backoff"), fixture.environment);
  const environment = probeEnvironment(fixture);
  const sleep = environment.sleep;
  environment.sleep = async (milliseconds) => {
    t.mock.timers.tick(milliseconds);
    await sleep(milliseconds);
  };
  await assert.rejects(runInfrastructureProbe(passing, environment), (error: unknown) => error instanceof EvaluationError && error.code === "rotated_webhook_not_observed");
  assert.equal(fixture.harness.calls.alertmanagerRestarts, 1);
});

test("monitoring health is awaited through the same reader the campaign uses", async () => {
  const fixture = await trialFixture();
  const health = await waitForHealthyMonitoring(runtimeReaders(fixture.environment.fetchImpl).runtime, fixture.environment.sleep);
  assert.equal(health.state, "healthy");
});
