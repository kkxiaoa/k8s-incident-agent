"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { OverviewDoughnutChart } from "@/components/charts/overview-doughnut-chart";
import { OverviewTrendChart } from "@/components/charts/overview-trend-chart";
import { LocalTimestamp } from "@/components/local-timestamp";
import { UiIcon } from "@/components/ui/ui-icon";
import { targetLabel } from "@/lib/agent-runtime/view-models";
import type {
  MonitoringHealthView,
  MonitoringOverviewView,
  RuntimeHealthView,
} from "@/lib/agent-runtime/response-contracts";

import { MonitoringHealthOverview } from "./monitoring-health-overview";

const COUNT_CARDS = [
  {
    key: "totalIncidents",
    label: "已记录 Incident",
    tone: "neutral",
    info: "Runtime 已持久化的 Incident 累计数，含已结束的记录；不是当前未恢复的数量。",
  },
  { key: "firingAlerts", label: "末次通知 FIRING", tone: "danger", info: null },
  { key: "triagingIncidents", label: "诊断中", tone: "active", info: null },
  { key: "waitingApprovalIncidents", label: "待审批", tone: "waiting", info: null },
] as const;

const PENDING_REASON_LABELS = {
  awaiting_association: "待归属",
  awaiting_observation: "等待新鲜观察",
  rule_mismatch: "规则契约待核对",
  not_firing: "未确认当前触发",
  identity_unverified: "目标身份待核对",
  closed_conflict: "已关闭事件冲突",
  ambiguous_incident: "事件归属不明确",
} as const;

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
            : `模型诊断暂不可用（${diagnosisReason(runtimeHealth.diagnosis.reason)}）。暂不创建新的诊断；合法告警仍会持久化，历史记录可读取。`}
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
                    aria-describedby="total-incidents-tooltip"
                    aria-label="说明已记录 Incident 的统计口径"
                    tabIndex={0}
                  >
                    <UiIcon name="info" />
                    <span
                      className="overview-count__tooltip"
                      id="total-incidents-tooltip"
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

      <section className="chart-card" aria-label="当前源端告警">
        <h2>当前源端告警</h2>
        {overview === null ? <p>当前观察暂不可用。</p> : <>
          <p>已知 FIRING {overview.currentAlerts.firingRules} · 已知 PENDING {overview.currentAlerts.pendingRules} · UNKNOWN 目标 {overview.currentAlerts.unknownTargets} / {overview.currentAlerts.totalTargets}</p>
          <p>按唯一目标统计源端规则活动，尚未归属具体通知；不按历史 Incident 重复计数。UNKNOWN 表示观察不完整或已过期，不能解释为没有活动。</p>
          {overview.currentAlerts.oldestObservedAt === null ? <p>尚无源端观察。</p> : <p>最早一项观察 <LocalTimestamp timestamp={overview.currentAlerts.oldestObservedAt} /></p>}
        </>}
      </section>

      <div className="home-monitoring__charts">
        <article className="chart-card chart-card--families">
          <header className="chart-card__header">
            <div>
              <h2>末次通知 FIRING 信号分布</h2>
              <p>含未归属信号；通知状态不代表源端当前状态</p>
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
              <p>每小时新增与已结束的次数（含拒绝、证据不足与失败，重开会再次计入）</p>
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
      {overview === null ? null : <section className="console-section" aria-labelledby="unassigned-signals-heading">
        <h2 id="unassigned-signals-heading">待归属告警信号（{overview.counts.unassignedSignals}）</h2>
        <p>信号已持久化，尚未归属 Incident。最多展示最近 20 条；通知状态不代表源端当前状态。</p>
        {overview.unassignedSignals.length === 0 ? <p>暂无待归属信号。</p> : <ul>
          {overview.unassignedSignals.map((signal) => <li key={`${signal.fingerprint}:${signal.startsAt}`}>
            <strong>{signal.displayName}</strong> · {targetLabel(signal.target)} · 末次通知 {signal.status}
            <span> · {PENDING_REASON_LABELS[signal.reason]} · 开始于 <LocalTimestamp timestamp={signal.startsAt} /></span>
            {signal.lastReceivedAt === null ? null : <span> · 最近接收 <LocalTimestamp timestamp={signal.lastReceivedAt} /></span>}
            {signal.endsAt === null ? null : <span> · 历史通知中的结束时间 <LocalTimestamp timestamp={signal.endsAt} /></span>}
          </li>)}
        </ul>}
      </section>}
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
