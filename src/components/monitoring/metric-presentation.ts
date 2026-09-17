import type {
  MetricPanelResultView,
  MetricRiskDirectionView,
} from "@/lib/agent-runtime/response-contracts";

const UNIT_LABELS: Record<string, string> = {
  containers: "个",
  claims: "个",
  endpoints: "个",
  pods: "个",
  replicas: "个",
  restarts: "次",
  seconds: "秒",
  cores: "核",
  probes: "次",
};

const COUNT_UNITS = new Set([
  "containers",
  "claims",
  "endpoints",
  "pods",
  "replicas",
  "restarts",
  "probes",
]);

export function metricUnitLabel(unit: MetricPanelResultView["unit"]): string {
  return UNIT_LABELS[unit] ?? (unit === "bytes" || unit === "ratio" ? "" : unit);
}

export function isCountUnit(unit: MetricPanelResultView["unit"]): boolean {
  return COUNT_UNITS.has(unit);
}

export function formatMetricValue(
  value: number,
  unit: MetricPanelResultView["unit"],
): string {
  if (unit === "bytes") {
    const magnitude = Math.abs(value);
    if (magnitude >= 1024 ** 3) {
      return `${(value / 1024 ** 3).toFixed(2)} GiB`;
    }
    if (magnitude >= 1024 ** 2) {
      return `${(value / 1024 ** 2).toFixed(1)} MiB`;
    }
    if (magnitude >= 1024) {
      return `${(value / 1024).toFixed(1)} KiB`;
    }
    return `${value} B`;
  }
  if (unit === "ratio") {
    return `${(value * 100).toFixed(1)}%`;
  }
  if (unit === "cores") {
    return Number(value.toFixed(3)).toString();
  }
  return Number.isInteger(value) ? String(value) : Number(value.toFixed(3)).toString();
}

export function metricSeriesLabel(labels: Record<string, string>): string {
  const owner =
    labels.container !== undefined
      ? `${labels.container}@${labels.pod ?? "?"}`
      : (labels.pod ?? "目标整体");
  return labels.series === undefined ? owner : `${owner} · ${labels.series}`;
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
  riskDirection: MetricRiskDirectionView,
  unit: MetricPanelResultView["unit"],
): string {
  if (riskDirection === "neutral") {
    return `${title}，中性上下文指标，不设风险方向；请结合配置与其他 Evidence 解读。`;
  }
  if (riskDirection === "lower_is_worse" && unit === "replicas") {
    return `${title}，按“当前可用副本 / 期望副本”展示；低于期望值表示容量未达标。`;
  }
  return riskDirection === "higher_is_worse"
    ? `${title}，数值越高表示影响范围越大。`
    : `${title}，数值越低表示可用能力越弱。`;
}

export function metricThresholdDescription(
  riskDirection: MetricRiskDirectionView,
): string {
  if (riskDirection === "neutral") {
    return "中性指标不设阈值；数值本身不是症状。";
  }
  return riskDirection === "higher_is_worse"
    ? "达到或超过此值时进入风险区间。"
    : "低于此最低值时进入风险区间。";
}
