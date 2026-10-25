"use client";


import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { OverviewDoughnutChart } from "@/components/charts/overview-doughnut-chart";
import { OverviewTrendChart } from "@/components/charts/overview-trend-chart";
import { CurrentAlertBadge } from "@/components/incidents/incident-status";
import { LocalTimestamp } from "@/components/local-timestamp";
import { UiIcon } from "@/components/ui/ui-icon";
import { targetLabel } from "@/lib/agent-runtime/view-models";
import type {
  MonitoringHealthView,
  MonitoringOverviewView,
  RuntimeHealthView,
} from "@/lib/agent-runtime/response-contracts";

import { MetricInfo } from "./metric-info";
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

      <section className="chart-card source-alerts" aria-label="当前源端告警">
        <header className="chart-card__header">
          <div><div className="source-alerts__title"><h2>当前源端告警</h2><MetricInfo label="来自源端规则的当前观察，按唯一 Kubernetes 目标统计，不按 Incident 或通知条数重复计数；不表示 Incident 已关闭或修复验证完成。" /></div><p>按唯一目标统计规则活动，不按历史 Incident 重复计数。</p></div>
          {overview?.currentAlerts.oldestObservedAt ? <span className="source-alerts__observed">最早一项观察 <LocalTimestamp timestamp={overview.currentAlerts.oldestObservedAt} /></span> : null}
        </header>
        {overview === null ? <p className="source-alerts__empty">当前观察暂不可用。</p> : <>
          <dl className="source-alerts__counts">
            <div><dt>已知 FIRING<MetricInfo label="当前观察中能确认处于 FIRING（告警触发）状态的规则数量。同一目标的不同规则分别计数，不是 Incident 或通知条数。" /></dt><dd className="source-alerts__firing">{overview.currentAlerts.firingRules}</dd></div>
            <div><dt>已知 PENDING<MetricInfo label="当前观察中处于 PENDING（等待触发）状态的规则数量：已满足告警条件，但尚未达到规则要求的持续时长。同一目标的不同规则分别计数。" /></dt><dd className="source-alerts__pending">{overview.currentAlerts.pendingRules}</dd></div>
            <div><dt>UNKNOWN 目标<MetricInfo label="当前状态无法完整确认的目标数量 / 全部已知目标数量。观察缺失、过期、身份无法核对或输入不完整都可能记为 UNKNOWN；不等于没有告警。" /></dt><dd className="source-alerts__pending">{overview.currentAlerts.unknownTargets}<span> / {overview.currentAlerts.totalTargets}</span></dd></div>
          </dl>
          <p className="source-alerts__note">UNKNOWN 表示观察不完整或已过期，不能解释为没有活动。目标观察未证明与具体通知一一对应。</p>
          {overview.currentAlerts.activities.length === 0 ? <p className="source-alerts__empty">{overview.currentAlerts.oldestObservedAt === null ? "尚无源端观察。" : "本次观察未确认 FIRING 或 PENDING 活动。"}</p> : <ul className="source-alerts__list" tabIndex={0} aria-label="当前活动目标">{overview.currentAlerts.activities.map(activity => <li key={`${activity.target.cluster}:${activity.target.namespace}:${activity.target.kind}:${activity.target.name}`}>
            <div className="source-alerts__item-heading"><strong>{targetLabel(activity.target)}</strong>{activity.observedAt === null ? null : <LocalTimestamp timestamp={activity.observedAt} />}</div>
            <div className="source-alerts__rules">{activity.rules.map(rule => <span key={rule.alertId}><span>{rule.alertId}</span><CurrentAlertBadge state={rule.state} /></span>)}</div>
          </li>)}</ul>}
          <p className="source-alerts__note">当前活动最多展示 20 个目标，包含尚无通知的源端活动。</p>
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
      {overview === null ? null : <section className="chart-card source-alerts" aria-labelledby="unassigned-signals-heading">
        <header className="chart-card__header"><div>
          <h2 id="unassigned-signals-heading">待归属告警信号（{overview.counts.unassignedSignals}）</h2>
          <p>信号已持久化，尚未归属 Incident。最多展示最近 20 条；通知状态不代表源端当前状态。</p>
        </div></header>
        {overview.unassignedSignals.length === 0 ? <p className="source-alerts__empty">暂无待归属信号。</p> : <ul className="source-alerts__list" tabIndex={0} aria-label="待归属告警信号">
          {overview.unassignedSignals.map(signal => <li key={`${signal.fingerprint}:${signal.startsAt}`}>
            <div className="source-alerts__item-heading"><strong>{signal.displayName}</strong><span className="status-badge status-badge--neutral">末次通知 {signal.status}</span></div>
            <p className="source-alerts__target">{targetLabel(signal.target)}</p>
            <div className="source-alerts__metadata">
              <span>{PENDING_REASON_LABELS[signal.reason]}</span><span>开始于 <LocalTimestamp timestamp={signal.startsAt} /></span>
              {signal.lastReceivedAt === null ? null : <span>最近接收 <LocalTimestamp timestamp={signal.lastReceivedAt} /></span>}
              {signal.endsAt === null ? null : <span>历史通知中的结束时间 <LocalTimestamp timestamp={signal.endsAt} /></span>}
            </div>
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
