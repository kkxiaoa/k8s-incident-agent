"use client";

import { useState } from "react";

import { LocalTimestamp } from "@/components/local-timestamp";
import { fetchMonitoringHealthFromBrowser } from "@/lib/agent-runtime/browser-client";
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
  compact = false,
}: {
  initialHealth: MonitoringHealthView | null;
  compact?: boolean;
}) {
  const [health, setHealth] = useState(initialHealth);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(initialHealth === null);

  const refresh = async () => {
    if (pending) {
      return;
    }
    setPending(true);
    const result = await fetchMonitoringHealthFromBrowser();
    if (result.ok) {
      setHealth(result.data);
      setError(false);
    } else {
      setHealth(null);
      setError(true);
    }
    setPending(false);
  };

  const nodes = healthNodes(health);
  const overall = health?.state ?? "unavailable";
  const heading = compact ? (
    <h3 id="monitoring-health-heading">监控链路</h3>
  ) : (
    <h2 id="monitoring-health-heading">监控链路</h2>
  );

  return (
    <section
      className={`monitoring-health${compact ? " monitoring-health--compact" : ""}`}
      aria-labelledby="monitoring-health-heading"
    >
      <header className="monitoring-health__header">
        <div>
          <span className="eyebrow">Signal path</span>
          {heading}
        </div>
        <div className="monitoring-health__actions">
          {overall === "healthy" ? (
            <span className="monitoring-health__ok" aria-label="监控链路正常">
              <span aria-hidden="true">✓</span>
            </span>
          ) : (
            <span className={`monitoring-health__overall is-${overall}`}>
              {overall === "degraded" ? "链路需关注" : "链路不可用"}
            </span>
          )}
          <button
            className="icon-button"
            type="button"
            onClick={refresh}
            disabled={pending}
            aria-label="刷新监控链路状态"
            title="刷新监控链路状态"
          >
            <span aria-hidden="true" className={pending ? "is-spinning" : ""}>
              ↻
            </span>
          </button>
        </div>
      </header>

      <ol className="monitoring-health__path">
        {nodes.map((node) => (
          <li
            key={node.id}
            className={`monitoring-health__node is-${node.state}`}
            aria-label={`${node.label}：${STATE_LABELS[node.state]}`}
            title={`${node.label}：${STATE_LABELS[node.state]}`}
          >
            <span className="monitoring-health__dot" aria-hidden="true">
              {node.state === "healthy" ? "✓" : "!"}
            </span>
            <strong>{node.label}</strong>
            {node.state === "healthy" ? null : (
              <small>{STATE_LABELS[node.state]}</small>
            )}
          </li>
        ))}
      </ol>

      <footer className="monitoring-health__footer" aria-live="polite">
        {error ? (
          <span className="monitoring-health__error">
            暂时无法确认完整链路状态，不能据此判断集群正常。
          </span>
        ) : health === null ? null : (
          <span>
            更新于 <LocalTimestamp timestamp={health.checkedAt} />
          </span>
        )}
      </footer>
    </section>
  );
}
