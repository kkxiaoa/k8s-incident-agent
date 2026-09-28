import type { HarnessContext } from "./harness.ts";
import { jsonResponse, textResponse } from "./responses.ts";

function targetLabel(kind: string): string {
  return ({
    Deployment: "deployment",
    Service: "service",
    PersistentVolumeClaim: "persistentvolumeclaim",
  } as Record<string, string>)[kind];
}

function prometheusVector(value?: number, metric: Record<string, string> = {}) {
  return {
    status: "success",
    data: {
      resultType: "vector",
      result: value === undefined ? [] : [{ metric, value: [1_788_566_400, String(value)] }],
    },
  };
}

// Prometheus answers the ALERTS query for the active scenario's target, or for a healthy control
// when the harness is told that control alerted.
export function prometheusResponse(url: URL, context: HarnessContext): Response {
  if (url.pathname === "/-/ready") return textResponse("ready");
  const active = context.activeScenario();
  const query = url.searchParams.get("query") ?? "";
  const matchesActive =
    active !== undefined &&
    query.includes(`alertname="${active.alertId}"`) &&
    query.includes(`="${active.target.name}"`);
  const control = active === undefined || context.options.controlAlertScenarioId !== active.scenarioId
    ? undefined
    : active.healthyControlNames.find((name) => query.includes(`="${name}"`));
  if (control !== undefined && active !== undefined) {
    return jsonResponse(prometheusVector(1, {
      alertname: active.alertId,
      alertstate: "firing",
      cluster: active.target.cluster,
      namespace: active.target.namespace,
      [targetLabel(active.target.kind)]: control,
    }));
  }
  return jsonResponse(
    matchesActive && active !== undefined
      ? prometheusVector(1, {
          alertname: active.alertId,
          alertstate: "firing",
          cluster: active.target.cluster,
          namespace: active.target.namespace,
          [targetLabel(active.target.kind)]: active.target.name,
        })
      : prometheusVector(),
  );
}

export function alertmanagerResponse(url: URL, context: HarnessContext): Response {
  if (url.pathname === "/-/ready") return textResponse("ready");
  const active = context.activeScenario();
  return jsonResponse(
    active === undefined
      ? []
      : [
          {
            labels: {
              alertname: active.alertId,
              cluster: active.target.cluster,
              namespace: active.target.namespace,
              [targetLabel(active.target.kind)]: active.target.name,
            },
            status: { state: "active" },
          },
        ],
  );
}
