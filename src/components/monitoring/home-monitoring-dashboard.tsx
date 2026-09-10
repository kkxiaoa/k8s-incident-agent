"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { OverviewDoughnutChart } from "@/components/charts/overview-doughnut-chart";
import { OverviewTrendChart } from "@/components/charts/overview-trend-chart";
import { LocalTimestamp } from "@/components/local-timestamp";
import { UiIcon } from "@/components/ui/ui-icon";
import type {
  MonitoringHealthView,
  MonitoringOverviewView,
  RuntimeHealthView,
} from "@/lib/agent-runtime/response-contracts";

import { MonitoringHealthOverview } from "./monitoring-health-overview";

const COUNT_CARDS = [
  {
    key: "totalIncidents",
    label: "活跃 Incident",
    tone: "neutral",
    info: "已进入 Runtime、尚未完成受控修复与恢复验证的 Incident。",
  },
  { key: "firingAlerts", label: "告警中", tone: "danger", info: null },
  { key: "triagingIncidents", label: "诊断中", tone: "active", info: null },
  { key: "diagnosedIncidents", label: "已诊断", tone: "success", info: null },
] as const;

export function HomeMonitoringDashboard({
  initialHealth,
  initialOverview,
  runtimeHealth,
}: {
  initialHealth: MonitoringHealthView | null;
  initialOverview: MonitoringOverviewView | null;
  runtimeHealth: RuntimeHealthView | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const overview = initialOverview;
  const error = overview === null;
  const lastUpdatedAt = overview?.generatedAt ?? initialHealth?.checkedAt ?? null;

  const refresh = () => {
    if (pending) {
      return;
    }
    startTransition(() => router.refresh());
  };

  return (
    <section className="home-monitoring" aria-label="运行监控概览">
      <div className="home-monitoring__toolbar" aria-live="polite">
        {lastUpdatedAt === null ? (
          <span>最近更新时间暂不可用</span>
        ) : (
          <span>
            最近更新 <LocalTimestamp timestamp={lastUpdatedAt} />
          </span>
        )}
        <button
          className="icon-button"
          type="button"
          onClick={refresh}
          disabled={pending}
          aria-label="刷新运行概览"
          title="刷新运行概览"
        >
          <UiIcon name="refresh" className={pending ? "is-spinning" : undefined} />
        </button>
      </div>

      {error ? (
        <p className="home-monitoring__error" role="status">
          暂时无法读取完整统计；监控链路和最近 Incident 仍可独立查看。
        </p>
      ) : null}

      {runtimeHealth?.diagnosis.status === "ready" ? null : (
        <p className="home-monitoring__error" role="status">
          {runtimeHealth === null
            ? "暂时无法读取模型诊断状态；已保存的 Incident 可独立查看。"
            : `模型诊断暂不可用（${diagnosisReason(runtimeHealth.diagnosis.reason)}）。暂不创建新的诊断；历史记录与告警恢复信号仍可读取。`}
        </p>
      )}

      <div className="home-monitoring__status-grid">
        <MonitoringHealthOverview initialHealth={initialHealth} />
        <div className="overview-counts" aria-label="Incident 状态统计">
          {COUNT_CARDS.map((card) => (
            <article
              key={card.key}
              className={`overview-count overview-count--${card.tone}`}
            >
              <span className="overview-count__label">
                {card.label}
                {card.info === null ? null : (
                  <span
                    className="overview-count__info"
                    aria-describedby="active-incidents-tooltip"
                    aria-label="说明活跃 Incident 的统计口径"
                    tabIndex={0}
                  >
                    <UiIcon name="info" />
                    <span
                      className="overview-count__tooltip"
                      id="active-incidents-tooltip"
                      role="tooltip"
                    >
                      {card.info}
                    </span>
                  </span>
                )}
              </span>
              <strong>{overview?.counts[card.key] ?? "—"}</strong>
            </article>
          ))}
        </div>
      </div>

      <div className="home-monitoring__charts">
        <article className="chart-card chart-card--families">
          <header className="chart-card__header">
            <div>
              <h2>告警中 Incident 分布</h2>
              <p>按受支持的故障族</p>
            </div>
          </header>
          {overview === null ? (
            <div className="chart-card__unavailable">统计数据暂不可用。</div>
          ) : (
            <OverviewDoughnutChart
              families={overview.families}
              total={overview.counts.firingAlerts}
            />
          )}
        </article>

        <article className="chart-card chart-card--trend">
          <header className="chart-card__header">
            <div>
              <h2>近 24 小时 Incident 趋势</h2>
              <p>新增记录与告警条件解除</p>
            </div>
            <span className="chart-window" aria-label="固定时间窗口：最近 24 小时">
              <UiIcon name="clock" />
              最近 24 小时
            </span>
          </header>
          {overview === null ? (
            <div className="chart-card__unavailable">趋势数据暂不可用。</div>
          ) : (
            <OverviewTrendChart samples={overview.samples} />
          )}
        </article>
      </div>
    </section>
  );
}

function diagnosisReason(reason: RuntimeHealthView["diagnosis"]["reason"]): string {
  switch (reason) {
    case "configuration_invalid": return "模型配置缺失或无效";
    case "authentication_failed": return "模型认证失败";
    case "model_not_found": return "配置的模型不可用";
    case "provider_rate_limited": return "模型服务限流";
    case "provider_contract_invalid": return "模型服务响应无效";
    default: return "模型服务暂不可用";
  }
}
