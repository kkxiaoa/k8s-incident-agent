import { UiIcon } from "@/components/ui/ui-icon";
import type {
  MonitoringComponentStateView,
  MonitoringHealthView,
} from "@/lib/agent-runtime/response-contracts";

const STATE_LABELS: Record<MonitoringComponentStateView, string> = {
  healthy: "正常",
  degraded: "需关注",
  unavailable: "不可用",
  stale: "信号陈旧",
  unknown: "未知",
};

function healthNodes(health: MonitoringHealthView | null) {
  return [
    {
      id: "kube-state-metrics",
      label: "指标采集",
      state: health?.kubeStateMetrics ?? "unknown",
    },
    {
      id: "prometheus",
      label: "Prometheus",
      state: health?.prometheus ?? "unknown",
    },
    {
      id: "rules",
      label: "规则计算",
      state: health?.ruleEvaluation ?? "unknown",
    },
    {
      id: "alertmanager",
      label: "Alertmanager",
      state: health?.alertmanager ?? "unknown",
    },
    {
      id: "runtime",
      label: "Runtime",
      state: health?.notification ?? "unknown",
    },
  ] as const;
}

export function MonitoringHealthOverview({
  initialHealth,
}: {
  initialHealth: MonitoringHealthView | null;
}) {
  const nodes = healthNodes(initialHealth);

  return (
    <section
      className="monitoring-health"
      aria-label="监控链路"
    >
      <ol className="monitoring-health__path">
        {nodes.map((node) => {
          const status = `${node.label}：${STATE_LABELS[node.state]}`;
          const abnormal = node.state !== "healthy";
          return (
            <li
              key={node.id}
              className={`monitoring-health__node is-${node.state}`}
              aria-label={status}
              data-tooltip={abnormal ? status : undefined}
              tabIndex={abnormal ? 0 : undefined}
            >
              <span className="monitoring-health__dot" aria-hidden="true">
              <UiIcon name={abnormal ? "activity" : "check"} />
              </span>
              <strong>{node.label}</strong>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
