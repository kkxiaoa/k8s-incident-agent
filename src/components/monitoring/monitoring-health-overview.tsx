import { LocalTimestamp } from "@/components/local-timestamp";
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

type HealthAlerts = MonitoringHealthView["healthAlerts"];

function healthNodes(health: MonitoringHealthView | null) {
  const alertsOf = (component: HealthAlerts[number]["component"]) =>
    health?.healthAlerts.filter((alert) => alert.component === component) ??
    [];
  const none: HealthAlerts = [];
  return [
    {
      id: "kube-state-metrics",
      label: "指标采集",
      state: health?.kubeStateMetrics ?? "unknown",
      alerts: alertsOf("collection"),
    },
    {
      id: "prometheus",
      label: "Prometheus",
      state: health?.prometheus ?? "unknown",
      alerts: none,
    },
    {
      id: "rules",
      label: "规则计算",
      state: health?.ruleEvaluation ?? "unknown",
      alerts: alertsOf("rules"),
    },
    {
      id: "alertmanager",
      label: "Alertmanager",
      state: health?.alertmanager ?? "unknown",
      alerts: none,
    },
    {
      id: "runtime",
      label: "Runtime",
      state: health?.notification ?? "unknown",
      alerts: none,
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
          const detailId = `monitoring-health-${node.id}-detail`;
          return (
            <li
              key={node.id}
              className={`monitoring-health__node is-${node.state}`}
              aria-label={status}
              aria-describedby={abnormal ? detailId : undefined}
              tabIndex={abnormal ? 0 : undefined}
            >
              <span className="monitoring-health__dot" aria-hidden="true">
                <UiIcon name={abnormal ? "activity" : "check"} />
              </span>
              <strong>{node.label}</strong>
              {abnormal ? (
                <span
                  className="monitoring-health__tooltip"
                  id={detailId}
                  role="tooltip"
                >
                  <span>{status}</span>
                  {node.alerts.map((alert) => (
                    <span key={alert.alertId}>
                      {alert.displayName}，条件自{" "}
                      <LocalTimestamp timestamp={alert.activeSince} /> 起
                    </span>
                  ))}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
