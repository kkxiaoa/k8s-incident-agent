import type { MetricPanelResultView } from "@/lib/agent-runtime/response-contracts";

const UNIT_LABELS: Record<string, string> = {
  containers: "个",
  endpoints: "个",
  pods: "个",
  replicas: "个",
  restarts: "次",
};

export function metricUnitLabel(unit: MetricPanelResultView["unit"]): string {
  return UNIT_LABELS[unit] ?? unit;
}

export function formatMetricDuration(duration: string): string {
  const match = /^(\d+)(ms|s|m|h)$/.exec(duration);
  if (match === null) {
    return duration;
  }
  const labels = { ms: "毫秒", s: "秒", m: "分钟", h: "小时" } as const;
  return `${match[1]} ${labels[match[2] as keyof typeof labels]}`;
}

export function metricRiskDescription(
  title: string,
  riskDirection: "higher_is_worse" | "lower_is_worse",
  unit: MetricPanelResultView["unit"],
): string {
  if (riskDirection === "lower_is_worse" && unit === "replicas") {
    return `${title}，按“当前可用副本 / 期望副本”展示；低于期望值表示容量未达标。`;
  }
  return riskDirection === "higher_is_worse"
    ? `${title}，数值越高表示影响范围越大。`
    : `${title}，数值越低表示可用能力越弱。`;
}

export function metricThresholdDescription(
  riskDirection: "higher_is_worse" | "lower_is_worse",
): string {
  return riskDirection === "higher_is_worse"
    ? "达到或超过此值时进入风险区间。"
    : "低于此最低值时进入风险区间。";
}
