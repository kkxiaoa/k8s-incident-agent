import assert from "node:assert/strict";
import test from "node:test";

import {
  alertMatcher,
  alertTargetLabel,
  decodeAlertmanagerAlerts,
  decodePrometheusVector,
  findActiveAlert,
  findFiringSample,
  readAlertmanagerAlert,
  readPrometheusAlert,
  type AlertTarget,
} from "../../src/contracts/monitoring.ts";
import { TRANSIENT_GATEWAY_STATUSES, type ReadJson, type ReadOptions } from "../../src/contracts/runtime-api.ts";
import { EvaluationError } from "../../src/shared/errors.ts";

const scenario: AlertTarget = {
  alertId: "K8sIncidentCrashLoopBackOff",
  target: { cluster: "kind", namespace: "scenarios", kind: "Deployment", name: "crash-loop-backoff" },
};

const upstreamInvalid = (error: unknown) => error instanceof EvaluationError && error.code === "upstream_contract_invalid";

function labels(overrides: Record<string, unknown> = {}) {
  return { alertname: scenario.alertId, alertstate: "firing", cluster: "kind", namespace: "scenarios", deployment: "crash-loop-backoff", ...overrides };
}

function reader(response: unknown) {
  const calls: Array<{ pathname: string; options: ReadOptions | undefined }> = [];
  const read: ReadJson = async (pathname, options) => {
    calls.push({ pathname, options });
    return response;
  };
  return { read, calls };
}

test("alert matchers name the alert, firing state, namespace and the kind's target label", () => {
  assert.equal(alertTargetLabel("Deployment"), "deployment");
  assert.equal(alertTargetLabel("Service"), "service");
  assert.equal(alertTargetLabel("PersistentVolumeClaim"), "persistentvolumeclaim");
  assert.throws(() => alertTargetLabel("StatefulSet"), upstreamInvalid);
  assert.equal(
    alertMatcher(scenario),
    'ALERTS{alertname="K8sIncidentCrashLoopBackOff",alertstate="firing",namespace="scenarios",deployment="crash-loop-backoff"}',
  );
  assert.ok(alertMatcher(scenario, "crash-loop-backoff-healthy-control").endsWith('deployment="crash-loop-backoff-healthy-control"}'));
  assert.equal(alertMatcher(scenario).includes("cluster="), false);
});

test("Prometheus vectors are decoded strictly and matched on the firing labels", async () => {
  const vector = (result: unknown) => ({ status: "success", data: { resultType: "vector", result } });
  const firing = { metric: labels(), value: [1, "1"] };
  const samples = decodePrometheusVector(vector([{ metric: labels({ deployment: "other" }) }, firing, "junk", { metric: null }]));
  assert.equal(findFiringSample(samples, scenario), firing);
  assert.equal(findFiringSample(samples, scenario, "crash-loop-backoff-healthy-control"), undefined);
  assert.equal(findFiringSample([{ metric: labels({ alertstate: "pending" }) }], scenario), undefined);
  for (const bad of [vector("none"), { status: "error", data: { resultType: "vector", result: [] } }, { status: "success", data: { resultType: "matrix", result: [] } }, null]) {
    assert.throws(() => decodePrometheusVector(bad), upstreamInvalid);
  }

  const { read, calls } = reader(vector([firing]));
  assert.equal(await readPrometheusAlert(read, scenario), firing);
  assert.deepEqual(calls[0], {
    pathname: `/api/v1/query?query=${encodeURIComponent(alertMatcher(scenario))}`,
    options: { transientStatuses: TRANSIENT_GATEWAY_STATUSES },
  });
});

test("Alertmanager alerts are matched on labels including the cluster and must be active", async () => {
  const active = { labels: labels(), status: { state: "active" } };
  const alerts = decodeAlertmanagerAlerts([{ labels: labels({ cluster: "k3s" }), status: { state: "active" } }, { labels: labels(), status: { state: "suppressed" } }, 7, active]);
  assert.equal(findActiveAlert(alerts, scenario), active);
  assert.equal(findActiveAlert(alerts, scenario, "crash-loop-backoff-healthy-control"), undefined);
  assert.equal(findActiveAlert([{ labels: labels() }], scenario), undefined);
  assert.throws(() => decodeAlertmanagerAlerts({ alerts: [] }), upstreamInvalid);

  const { read, calls } = reader([active]);
  assert.equal(await readAlertmanagerAlert(read, scenario), active);
  assert.deepEqual(calls[0], {
    pathname: "/api/v2/alerts?active=true&silenced=false&inhibited=false",
    options: { transientStatuses: TRANSIENT_GATEWAY_STATUSES },
  });
});
