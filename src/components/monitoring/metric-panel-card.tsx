"use client";

import { useEffect, useState } from "react";

import { LocalTimestamp } from "@/components/local-timestamp";
import { UiIcon } from "@/components/ui/ui-icon";
import {
  fetchMonitoringPanelFromBrowser,
  type MonitoringPanelAnchor,
} from "@/lib/agent-runtime/browser-client";
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
  formatMetricValue,
  metricRiskDescription,
  metricThresholdDescription,
  metricUnitLabel,
} from "./metric-presentation";
import { MetricMarkerEvents, TimeSeriesChart } from "./time-series-chart";

const STATE_LABELS: Partial<Record<MetricQueryStateView, string>> = {
  no_data: "暂无数据",
  stale: "数据陈旧",
  partial: "部分数据",
};

const STATE_COPY = {
  no_data: "Prometheus 没有返回可验证样本；这不等于指标值为 0。",
  partial: "Prometheus 报告了部分结果，图表只展示当前可验证样本。",
} as const;

/** The exact Run whose completion ends the data window, or the live window. */
export type MetricPanelAnchor =
  | Extract<MonitoringPanelAnchor, { kind: "current" }>
  | (Extract<MonitoringPanelAnchor, { kind: "run" }> & { attempt: number });

function isUnavailableState(state: MetricQueryStateView): boolean {
  return state === "query_error" || state === "monitoring_unavailable";
}

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
  if (isUnavailableState(state)) {
    return "指标数据暂不可用";
  }
  return "当前查询没有可展示的样本。";
}

export function MetricPanelCard({
  incidentId,
  panel,
  refreshKey,
  anchor = { kind: "current" },
  alertStatus = null,
  desiredReplicas = null,
  onLoadSnapshot,
}: {
  incidentId: string;
  panel: MonitoringPanelReferenceView;
  refreshKey: string;
  anchor?: MetricPanelAnchor;
  alertStatus?: AlertSignalView["status"] | null;
  desiredReplicas?: number | null;
  onLoadSnapshot?: (panelId: string, snapshot: MetricPanelLoadSnapshot) => void;
}) {
  const [window, setWindow] = useState(panel.recommendedWindow);
  const anchorKey =
    anchor.kind === "run" ? `run:${anchor.runId}` : "current";
  const requestKey = [
    incidentId,
    panel.panelId,
    window,
    anchorKey,
    refreshKey,
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
  // Callers pass a fresh anchor object per render; depend on its primitives so
  // the effect does not refetch on every render.
  const anchorRunId = anchor.kind === "run" ? anchor.runId : null;

  useEffect(() => {
    let active = true;
    const requestAnchor: MonitoringPanelAnchor =
      anchorRunId === null
        ? { kind: "current" }
        : { kind: "run", runId: anchorRunId };
    onLoadSnapshot?.(panel.panelId, { state: "loading", result: null });
    void fetchMonitoringPanelFromBrowser(
      incidentId,
      panel.panelId,
      window,
      requestAnchor,
    ).then((result) => {
      if (!active) {
        return;
      }
      if (
        result.ok &&
        result.data.result.riskDirection === panel.riskDirection &&
        result.data.result.seriesBinding === panel.seriesBinding
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
    anchorRunId,
    incidentId,
    onLoadSnapshot,
    panel.panelId,
    panel.riskDirection,
    panel.seriesBinding,
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
      <article
        className="metric-panel metric-panel--error"
        aria-label={
          failure === "invalid_response"
            ? "监控响应无法验证"
            : failure === "not_found"
              ? "指标 panel 不存在"
              : "指标读取失败"
        }
      >
        <div className="metric-panel__empty is-monitoring_unavailable" role="status">
          <UiIcon name="activity" />
          <p>指标数据暂不可用</p>
        </div>
      </article>
    );
  }

  const { result } = data;
  const hasSamples = result.series.length > 0;
  const unavailable = isUnavailableState(result.state);
  const stateLabel = STATE_LABELS[result.state];
  const anchoredRun = anchor.kind === "run" ? anchor : null;
  const timestamp = result.latestSampleAt ?? result.rangeEnd;
  const unitLabel = metricUnitLabel(result.unit);
  const singleSeries = result.seriesBinding === "target";
  const referenceValue =
    result.riskDirection === "lower_is_worse" && result.unit === "replicas"
      ? desiredReplicas
      : null;
  const currentValue = !singleSeries && hasSamples
    ? String(result.series.length)
    : result.currentValue === null
      ? "—"
      : result.riskDirection === "lower_is_worse" && referenceValue !== null
        ? `${result.currentValue} / ${referenceValue}`
        : formatMetricValue(result.currentValue, result.unit);
  const thresholdCopy = unavailable
    ? "—"
    : result.threshold !== null
      ? `${result.riskDirection === "higher_is_worse" ? "≥" : "<"} ${result.threshold}`
      : referenceValue === null
        ? "—"
        : `< ${referenceValue}`;
  const thresholdDuration =
    panel.thresholdDuration === null || unavailable
      ? null
      : `持续 ${formatMetricDuration(panel.thresholdDuration)}`;
  const metricDescription = `${result.purpose} ${metricRiskDescription(
    result.title,
    result.riskDirection,
    result.unit,
  )}`;
  const currentValueDescription = !singleSeries
    ? "数据窗口内按 Pod / 容器归属的序列条数；多序列面板不汇总为单一当前值，请逐序列读取。"
    : result.riskDirection === "lower_is_worse" &&
        result.unit === "replicas" &&
        referenceValue !== null
      ? `前一个数字是 Prometheus 观测到的当前可用副本，后一个数字是同一次诊断 Run 的 workload Evidence 中记录的期望副本。`
      : anchoredRun === null
        ? "Prometheus 返回的最新有效样本值。"
        : "数据窗口终点处的最后有效样本值，不是当前值。";
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
          <span className="eyebrow">
            {panel.signalRole === "trigger" ? "Necessary metric" : "Context metric"}
          </span>
          <div className="metric-panel__title">
            <h3>{result.title}</h3>
            <MetricInfo label={metricDescription} />
          </div>
        </div>
        <div className="metric-panel__header-actions">
          <div className="metric-panel__states">
            {alertStatus === null || unavailable || anchoredRun !== null ? null : (
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
            {stateLabel === undefined ? null : (
              <span className={`metric-state is-${result.state}`}>
                {stateLabel}
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

      {anchoredRun === null ? null : (
        <p className="metric-panel__notice metric-panel__notice--anchor" role="status">
          数据窗口截至第 {anchoredRun.attempt} 次 Run 完成（
          <LocalTimestamp timestamp={result.rangeEnd} />
          ）；展示的是该 Run 当时可见的历史值，不代表当前状态。
        </p>
      )}

      <dl className="metric-panel__summary">
        <div>
          <dt>
            {!singleSeries ? "序列" : anchoredRun === null ? "当前值" : "窗口末值"}
            <MetricInfo label={currentValueDescription} />
          </dt>
          <dd>
            <span className="metric-panel__value">{currentValue}</span>
            {singleSeries && result.currentValue !== null && unitLabel !== "" ? (
              <span className="metric-panel__unit">{unitLabel}</span>
            ) : !singleSeries && hasSamples ? (
              <span className="metric-panel__unit">条</span>
            ) : null}
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
          <dt>{anchoredRun === null ? "最后更新" : "窗口终点"}</dt>
          <dd>
            {unavailable ? "—" : <LocalTimestamp timestamp={timestamp} />}
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
              最后样本早于数据窗口终点，不能作为该时刻的状态判断。
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
