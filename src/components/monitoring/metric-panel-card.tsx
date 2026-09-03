"use client";

import { useEffect, useState } from "react";

import { LocalTimestamp } from "@/components/local-timestamp";
import { UiIcon } from "@/components/ui/ui-icon";
import { fetchMonitoringPanelFromBrowser } from "@/lib/agent-runtime/browser-client";
import type {
  AlertSignalView,
  IncidentMetricPanelView,
  MetricQueryStateView,
  MetricPanelResultView,
  MetricWindowView,
  MonitoringPanelReferenceView,
} from "@/lib/agent-runtime/response-contracts";

import { METRIC_WINDOW_LABELS } from "./metric-window";
import { MetricInfo } from "./metric-info";
import {
  formatMetricDuration,
  metricRiskDescription,
  metricThresholdDescription,
  metricUnitLabel,
} from "./metric-presentation";
import { MetricMarkerEvents, TimeSeriesChart } from "./time-series-chart";

const STATE_LABELS: Record<MetricQueryStateView, string> = {
  ok: "数据有效",
  no_data: "暂无数据",
  stale: "数据陈旧",
  partial: "部分数据",
  query_error: "查询失败",
  monitoring_unavailable: "监控不可用",
};

const STATE_COPY: Record<
  Exclude<MetricQueryStateView, "ok" | "stale">,
  string
> = {
  no_data: "Prometheus 没有返回可验证样本；这不等于指标值为 0。",
  partial: "Prometheus 报告了部分结果，图表只展示当前可验证样本。",
  query_error: "固定 catalog 查询未能完成，请稍后重试。",
  monitoring_unavailable: "当前无法连接监控数据源，请先检查监控链路。",
};

export type MetricPanelLoadSnapshot =
  | { state: "loading"; result: null }
  | { state: "ready"; result: MetricPanelResultView }
  | { state: "error"; result: null };

function emptyStateCopy(state: MetricQueryStateView): string {
  if (state === "no_data") {
    return STATE_COPY.no_data;
  }
  if (state === "partial") {
    return STATE_COPY.partial;
  }
  if (state === "query_error") {
    return STATE_COPY.query_error;
  }
  if (state === "monitoring_unavailable") {
    return STATE_COPY.monitoring_unavailable;
  }
  return "当前查询没有可展示的样本。";
}

function failureCopy(
  failure: "invalid_response" | "not_found" | "unavailable",
) {
  if (failure === "not_found") {
    return "当前 Incident 不再支持这个指标 panel。";
  }
  if (failure === "invalid_response") {
    return "监控响应无法验证，未展示可能失真的数据。";
  }
  return "暂时无法读取指标，请稍后重试。";
}

export function MetricPanelCard({
  incidentId,
  panel,
  refreshKey,
  alertStatus = null,
  desiredReplicas = null,
  onLoadSnapshot,
}: {
  incidentId: string;
  panel: MonitoringPanelReferenceView;
  refreshKey: string;
  alertStatus?: AlertSignalView["status"] | null;
  desiredReplicas?: number | null;
  onLoadSnapshot?: (panelId: string, snapshot: MetricPanelLoadSnapshot) => void;
}) {
  const [window, setWindow] = useState(panel.recommendedWindow);
  const [reload, setReload] = useState(0);
  const requestKey = [
    incidentId,
    panel.panelId,
    window,
    refreshKey,
    reload,
  ].join(":");
  const [load, setLoad] = useState<
    | {
        requestKey: string;
        data: IncidentMetricPanelView;
        failure: null;
      }
    | {
        requestKey: string;
        data: null;
        failure: "invalid_response" | "not_found" | "unavailable";
      }
    | null
  >(null);

  useEffect(() => {
    let active = true;
    onLoadSnapshot?.(panel.panelId, { state: "loading", result: null });
    void fetchMonitoringPanelFromBrowser(
      incidentId,
      panel.panelId,
      window,
    ).then((result) => {
      if (!active) {
        return;
      }
      if (
        result.ok &&
        result.data.result.riskDirection === panel.riskDirection
      ) {
        setLoad({ requestKey, data: result.data, failure: null });
        onLoadSnapshot?.(panel.panelId, {
          state: "ready",
          result: result.data.result,
        });
      } else {
        setLoad({
          requestKey,
          data: null,
          failure: result.ok ? "invalid_response" : result.failure,
        });
        onLoadSnapshot?.(panel.panelId, { state: "error", result: null });
      }
    });
    return () => {
      active = false;
    };
  }, [
    incidentId,
    onLoadSnapshot,
    panel.panelId,
    panel.riskDirection,
    requestKey,
    window,
  ]);

  const current = load?.requestKey === requestKey ? load : null;
  const pending = current === null;
  const data = current?.data ?? null;
  const failure = current?.failure ?? null;

  if (pending && data === null) {
    return (
      <article className="metric-panel metric-panel--loading" aria-busy="true">
        <span className="skeleton skeleton--short" />
        <span className="skeleton skeleton--metric" />
        <span className="skeleton skeleton--chart" />
      </article>
    );
  }

  if (data === null) {
    return (
      <article className="metric-panel metric-panel--error">
        <div>
          <span className="eyebrow">Metric panel</span>
          <h3>指标暂不可用</h3>
        </div>
        <p role="alert">
          {failure === null ? "暂时无法读取指标。" : failureCopy(failure)}
        </p>
        <button
          className="secondary-button"
          type="button"
          onClick={() => setReload((value) => value + 1)}
        >
          重新读取
        </button>
      </article>
    );
  }

  const { result } = data;
  const hasSamples = result.samples.length > 0;
  const timestamp = result.latestSampleAt ?? result.queriedAt;
  const unitLabel = metricUnitLabel(result.unit);
  const referenceValue =
    result.riskDirection === "lower_is_worse" && result.unit === "replicas"
      ? desiredReplicas
      : null;
  const currentValue =
    result.currentValue === null
      ? "—"
      : result.riskDirection === "lower_is_worse" && referenceValue !== null
        ? `${result.currentValue} / ${referenceValue}`
        : result.currentValue;
  const thresholdCopy =
    result.threshold !== null
      ? `${result.riskDirection === "higher_is_worse" ? "≥" : "<"} ${result.threshold}`
      : referenceValue === null
        ? "—"
        : `< ${referenceValue}`;
  const thresholdDuration =
    panel.thresholdDuration === null
      ? null
      : `持续 ${formatMetricDuration(panel.thresholdDuration)}`;
  const metricDescription = metricRiskDescription(
    result.title,
    result.riskDirection,
    result.unit,
  );
  const currentValueDescription =
    result.riskDirection === "lower_is_worse" &&
    result.unit === "replicas" &&
    referenceValue !== null
      ? `前一个数字是 Prometheus 观测到的当前可用副本，后一个数字是同一次诊断 Run 的 workload Evidence 中记录的期望副本。`
      : "Prometheus 返回的最新有效样本值。";
  const thresholdDescription =
    result.threshold !== null
      ? metricThresholdDescription(result.riskDirection)
      : result.riskDirection === "lower_is_worse"
      ? referenceValue === null
        ? "等待同一次诊断 Run 的 workload Evidence 提供期望副本，当前不推测风险边界。"
        : `可用副本少于期望的 ${referenceValue} 个时进入风险区间。`
      : metricThresholdDescription(result.riskDirection);

  return (
    <article className={`metric-panel is-${result.state}`} aria-busy={pending}>
      <header className="metric-panel__header">
        <div>
          <span className="eyebrow">Necessary metric</span>
          <div className="metric-panel__title">
            <h3>{result.title}</h3>
            <MetricInfo label={metricDescription} />
          </div>
        </div>
        <div className="metric-panel__header-actions">
          <div className="metric-panel__states">
            {alertStatus === null ? null : (
              <span
                className={`metric-signal-state is-${alertStatus.toLowerCase()}`}
                title={
                  alertStatus === "RESOLVED"
                    ? "Alertmanager 已报告 resolved；不代表 Incident 关闭或恢复验证完成。"
                    : undefined
                }
              >
                {alertStatus === "FIRING" ? "告警中" : "条件已解除"}
              </span>
            )}
            {result.state === "ok" ? null : (
              <span className={`metric-state is-${result.state}`}>
                {STATE_LABELS[result.state]}
              </span>
            )}
          </div>
          <div className="metric-panel__toolbar">
            <label className="window-dropdown">
              <span className="sr-only">{result.title} 时间窗口</span>
              <select
                aria-label={`${result.title} 时间窗口`}
                value={window}
                onChange={(event) =>
                  setWindow(event.target.value as MetricWindowView)
                }
              >
                {(Object.keys(METRIC_WINDOW_LABELS) as MetricWindowView[]).map(
                  (value) => (
                    <option key={value} value={value}>
                      {METRIC_WINDOW_LABELS[value]}
                    </option>
                  ),
                )}
              </select>
              <UiIcon name="chevron-down" />
            </label>
          </div>
        </div>
      </header>

      <dl className="metric-panel__summary">
        <div>
          <dt>
            当前值
            <MetricInfo label={currentValueDescription} />
          </dt>
          <dd>
            <span className="metric-panel__value">{currentValue}</span>
            <span className="metric-panel__unit">{unitLabel}</span>
          </dd>
        </div>
        <div>
          <dt>
            阈值
            <MetricInfo label={thresholdDescription} />
          </dt>
          <dd>
            {thresholdCopy}
            {thresholdDuration === null ? null : (
              <small>{thresholdDuration}</small>
            )}
          </dd>
        </div>
        <div>
          <dt>最后更新</dt>
          <dd>
            <LocalTimestamp timestamp={timestamp} />
          </dd>
        </div>
      </dl>

      {hasSamples ? (
        <>
          {result.state === "partial" ? (
            <p className="metric-panel__notice" role="status">
              {STATE_COPY.partial}
            </p>
          ) : result.state === "stale" ? (
            <p className="metric-panel__notice" role="status">
              最后样本早于当前查询时刻，不能作为实时状态判断。
            </p>
          ) : null}
          <TimeSeriesChart
            result={result}
            markers={data.markers}
            markersTruncated={data.markersTruncated}
            riskDirection={result.riskDirection}
            referenceValue={referenceValue}
          />
        </>
      ) : (
        <>
          <div
            className={`metric-panel__empty is-${result.state}`}
            role="status"
          >
            <UiIcon name="activity" />
            <p>{emptyStateCopy(result.state)}</p>
          </div>
          <MetricMarkerEvents
            markers={data.markers}
            markersTruncated={data.markersTruncated}
          />
        </>
      )}
    </article>
  );
}
