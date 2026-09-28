import { upstreamContractError } from "../shared/errors.ts";
import { isPlainObject } from "../shared/guards.ts";
import type { ReadJson } from "../shared/json.ts";
import { TRANSIENT_GATEWAY_STATUSES } from "./runtime-api.ts";

// The alert a scenario is expected to raise and the resource it targets.
export interface AlertTarget {
  alertId: string;
  target: { cluster: string; namespace: string; kind: string; name: string };
}

export interface PrometheusSample {
  metric: Record<string, unknown>;
}

export interface AlertmanagerAlert {
  labels: Record<string, unknown>;
  status?: { state?: unknown };
}

export function alertTargetLabel(kind: string): string {
  const label = ({
    Deployment: "deployment",
    Service: "service",
    PersistentVolumeClaim: "persistentvolumeclaim",
  } as Record<string, string | undefined>)[kind];
  if (label === undefined) throw upstreamContractError();
  return label;
}

export function alertMatcher(scenario: AlertTarget, targetName?: string): string {
  const targetLabel = alertTargetLabel(scenario.target.kind);
  return `ALERTS{alertname="${scenario.alertId}",alertstate="firing",namespace="${scenario.target.namespace}",${targetLabel}="${targetName ?? scenario.target.name}"}`;
}

export function decodePrometheusVector(document: unknown): unknown[] {
  if (
    !isPlainObject(document) ||
    document.status !== "success" ||
    !isPlainObject(document.data) ||
    document.data.resultType !== "vector" ||
    !Array.isArray(document.data.result)
  ) {
    throw upstreamContractError();
  }
  return document.data.result;
}

export function findFiringSample(
  samples: readonly unknown[],
  scenario: AlertTarget,
  targetName?: string,
): PrometheusSample | undefined {
  return samples.find((item): item is PrometheusSample => {
    const metric = isPlainObject(item) ? item.metric : undefined;
    return (
      isPlainObject(metric) &&
      metric.alertname === scenario.alertId &&
      metric.alertstate === "firing" &&
      metric[alertTargetLabel(scenario.target.kind)] === (targetName ?? scenario.target.name)
    );
  });
}

export async function readPrometheusAlert(
  read: ReadJson,
  scenario: AlertTarget,
  targetName?: string,
): Promise<PrometheusSample | undefined> {
  const query = alertMatcher(scenario, targetName);
  const document = await read(`/api/v1/query?query=${encodeURIComponent(query)}`, {
    transientStatuses: TRANSIENT_GATEWAY_STATUSES,
  });
  return findFiringSample(decodePrometheusVector(document), scenario, targetName);
}

export function decodeAlertmanagerAlerts(document: unknown): unknown[] {
  if (!Array.isArray(document)) throw upstreamContractError();
  return document;
}

export function findActiveAlert(
  alerts: readonly unknown[],
  scenario: AlertTarget,
  targetName?: string,
): AlertmanagerAlert | undefined {
  return alerts.find((item): item is AlertmanagerAlert => {
    if (!isPlainObject(item)) return false;
    const labels = item.labels;
    const status = item.status;
    return (
      isPlainObject(labels) &&
      labels.alertname === scenario.alertId &&
      labels.cluster === scenario.target.cluster &&
      labels.namespace === scenario.target.namespace &&
      labels[alertTargetLabel(scenario.target.kind)] === (targetName ?? scenario.target.name) &&
      isPlainObject(status) &&
      status.state === "active"
    );
  });
}

export async function readAlertmanagerAlert(
  read: ReadJson,
  scenario: AlertTarget,
  targetName?: string,
): Promise<AlertmanagerAlert | undefined> {
  const document = await read("/api/v2/alerts?active=true&silenced=false&inhibited=false", {
    transientStatuses: TRANSIENT_GATEWAY_STATUSES,
  });
  return findActiveAlert(decodeAlertmanagerAlerts(document), scenario, targetName);
}
