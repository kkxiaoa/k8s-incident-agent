import assert from "node:assert/strict";
import test from "node:test";

import { readAlertmanagerAlert, readPrometheusAlert } from "../../src/contracts/monitoring.ts";
import {
  decodeSseFrame,
  isHealthyMonitoring,
  readIncident,
  readIncidentSummaries,
  readMonitoringHealth,
  readPanel,
  readPanelCatalog,
  readRunEvents,
  splitSseFrames,
} from "../../src/contracts/runtime-api.ts";
import { bindJsonReader, readEventStream, requestStatus, requestText } from "../../src/environment/http.ts";
import { operatorFetch } from "../../src/environment/operator-session.ts";
import { endpointOrigin } from "../../src/environment/tunnels.ts";
import { AUTH_PASSWORD, createHarness } from "./harness.ts";

// The fakes are the ground the later parity tests stand on, so they are checked against the
// contracts layer the way the evaluator will use them.
test("the fake environment answers the evaluator's reads through the real session and contracts", async () => {
  const harness = createHarness();
  const runtime = endpointOrigin("runtime");
  const authenticated = await operatorFetch(harness.dependencies.fetch, "kind-evaluation", harness.dependencies.environment);
  assert.equal(harness.state.logins, 1);
  const read = bindJsonReader(authenticated, runtime);

  assert.equal((await readIncidentSummaries(read)).size, 0);
  const health = await readMonitoringHealth(read);
  assert.ok(isHealthyMonitoring(health));

  const scenario = harness.dependencies.scenarios[0];
  assert.equal(await readPrometheusAlert(bindJsonReader(authenticated, endpointOrigin("prometheus")), scenario), undefined);
  await harness.dependencies.runScenarioCommand("apply", scenario.scenarioId, { release: harness.release.manifest });
  assert.equal(harness.calls.scenarioApply, 1);
  assert.notEqual(await readPrometheusAlert(bindJsonReader(authenticated, endpointOrigin("prometheus")), scenario), undefined);
  assert.notEqual(await readAlertmanagerAlert(bindJsonReader(authenticated, endpointOrigin("alertmanager")), scenario), undefined);

  const [incidentId] = [...(await readIncidentSummaries(read)).keys()];
  const detail = await readIncident(read, incidentId);
  assert.equal(detail.incident.target.name, scenario.target.name);
  assert.equal(detail.diagnosis?.outcome, "diagnosed");
  const panels = await readPanelCatalog(read, incidentId);
  assert.deepEqual(panels.map((panel) => panel.signalRole), ["trigger", "context"]);
  const trigger = await readPanel(read, incidentId, panels[0].panelId, panels[0].recommendedWindow);
  assert.equal(trigger.result.state, "ok");
  const events = await readRunEvents(read, incidentId, detail.selectedRun.id);
  assert.equal(events.events.length, 3);

  const frames: string[] = [];
  let rest = "";
  await readEventStream(authenticated, runtime, `/api/v1/incidents/${incidentId}/events`, (chunk) => {
    const split = splitSseFrames(rest + chunk);
    frames.push(...split.frames);
    rest = split.rest;
    return false;
  });
  const decoded = frames.map((frame, index) => decodeSseFrame(frame, { incidentId, runId: detail.selectedRun.id }, index === 0 ? undefined : String(index)));
  assert.deepEqual(decoded.map((event) => event.event), ["incident.created", "run.started", "diagnosis.completed"]);

  const consoleOrigin = endpointOrigin("console");
  assert.ok((await requestText(authenticated, consoleOrigin, `/incidents/${incidentId}`)).includes(scenario.target.name));
  assert.equal(await requestStatus(authenticated, runtime, "/api/v1/scenarios"), 404);
  assert.equal(await requestStatus(authenticated, runtime, "/api/v1/incidents", { method: "POST" }), 405);

  await harness.dependencies.execute("kubectl", ["--context", "kind", "scale", "deployment/kube-state-metrics", "--replicas=0"], {});
  assert.equal(isHealthyMonitoring(await readMonitoringHealth(read)), false);
  assert.equal((await readPanel(read, incidentId, panels[0].panelId, "15m")).result.state, "stale");
  await harness.dependencies.execute("kubectl", ["--context", "kind", "delete", "pod", "agent-runtime-pod"], {});
  assert.equal(await requestStatus(authenticated, runtime, "/api/v1/incidents"), 200);
  assert.equal(harness.state.logins, 2);

  await harness.dependencies.runScenarioCommand("cleanup", scenario.scenarioId, { release: harness.release.manifest });
  assert.equal((await readIncident(read, incidentId)).alertSignal?.status, "RESOLVED");
  assert.equal(JSON.stringify(harness.calls).includes(AUTH_PASSWORD), false);
});

test("the switches shape the fixture the campaign tests depend on", async () => {
  const online = createHarness({ onlineRerunStatus: 409 });
  online.state.online = true;
  const authenticated = await operatorFetch(online.dependencies.fetch, "k3s-public", online.dependencies.environment);
  const runtime = endpointOrigin("runtime");
  assert.ok((await requestText(authenticated, endpointOrigin("console"), "/")).includes("重新诊断"));
  const read = bindJsonReader(authenticated, runtime);
  const [incidentId] = [...(await readIncidentSummaries(read)).keys()];
  const rerun = await authenticated(`${runtime}/api/v1/incidents/${incidentId}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(rerun.status, 409);

  const failing = createHarness({ terminalByScenario: { "crash-loop-backoff": { outcome: "failed", errorCode: "tool_timeout", retryable: true } } });
  const session = await operatorFetch(failing.dependencies.fetch, "kind-evaluation", failing.dependencies.environment);
  await failing.dependencies.runScenarioCommand("apply", "crash-loop-backoff", { release: failing.release.manifest });
  const failedRead = bindJsonReader(session, runtime);
  const [failedId] = [...(await readIncidentSummaries(failedRead)).keys()];
  const detail = await readIncident(failedRead, failedId);
  assert.deepEqual({ status: detail.selectedRun.status, error: detail.selectedRun.error, diagnosis: detail.diagnosis }, {
    status: "FAILED",
    error: { code: "tool_timeout", retryable: true },
    diagnosis: null,
  });
});
