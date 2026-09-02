"use client";

import { useEffect, useState } from "react";

import { LocalTimestamp } from "@/components/local-timestamp";
import { fetchMonitoringPanelFromBrowser } from "@/lib/agent-runtime/browser-client";
import type {
  IncidentMetricPanelView,
  MetricQueryStateView,
  MetricWindowView,
  MonitoringPanelReferenceView,
} from "@/lib/agent-runtime/response-contracts";

import { MetricMarkerEvents, TimeSeriesChart } from "./time-series-chart";

const WINDOW_LABELS: Record<MetricWindowView, string> = {
  "15m": "15 分钟",
  "1h": "1 小时",
  "6h": "6 小时",
};

const STATE_LABELS: Record<MetricQueryStateView, string> = {
  ok: "数据有效",
  no_data: "暂无数据",
  stale: "数据陈旧",
  partial: "部分数据",
  query_error: "查询失败",
  monitoring_unavailable: "监控不可用",
};

const STATE_COPY: Record<Exclude<MetricQueryStateView, "ok" | "stale">, string> = {
  no_data: "Prometheus 没有返回可验证样本；这不等于指标值为 0。",
  partial: "Prometheus 报告了部分结果，图表只展示当前可验证样本。",
  query_error: "固定 catalog 查询未能完成，请稍后重试。",
  monitoring_unavailable: "当前无法连接监控数据源，请先检查监控链路。",
};

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

function failureCopy(failure: "invalid_response" | "not_found" | "unavailable") {
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
}: {
  incidentId: string;
  panel: MonitoringPanelReferenceView;
  refreshKey: string;
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
    void fetchMonitoringPanelFromBrowser(incidentId, panel.panelId, window).then(
      (result) => {
        if (!active) {
          return;
        }
        if (result.ok) {
          setLoad({ requestKey, data: result.data, failure: null });
        } else {
          setLoad({ requestKey, data: null, failure: result.failure });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [incidentId, panel.panelId, requestKey, window]);

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
        <p role="alert">{failure === null ? "暂时无法读取指标。" : failureCopy(failure)}</p>
        <button className="secondary-button" type="button" onClick={() => setReload((value) => value + 1)}>
          重新读取
        </button>
      </article>
    );
  }

  const { result } = data;
  const hasSamples = result.samples.length > 0;
  const timestamp = result.latestSampleAt ?? result.queriedAt;

  return (
    <article className={`metric-panel is-${result.state}`} aria-busy={pending}>
      <header className="metric-panel__header">
        <div>
          <span className="eyebrow">Necessary metric</span>
          <h3>{result.title}</h3>
        </div>
        <span className={`metric-state is-${result.state}`}>
          {STATE_LABELS[result.state]}
        </span>
      </header>

      <div className="metric-panel__summary">
        <div>
          <span className="metric-panel__value">
            {result.currentValue === null ? "—" : result.currentValue}
          </span>
          <span className="metric-panel__unit">{result.unit}</span>
        </div>
        <dl>
          <div><dt>阈值</dt><dd>{result.threshold} {result.unit}</dd></div>
          <div><dt>更新时间</dt><dd><LocalTimestamp timestamp={timestamp} /></dd></div>
        </dl>
      </div>

      <div className="metric-panel__toolbar">
        <div className="window-switcher" aria-label={`${result.title} 时间窗口`}>
          {(Object.keys(WINDOW_LABELS) as MetricWindowView[]).map((value) => (
            <button
              key={value}
              type="button"
              className={window === value ? "is-selected" : ""}
              aria-pressed={window === value}
              onClick={() => setWindow(value)}
            >
              {WINDOW_LABELS[value]}
            </button>
          ))}
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => setReload((value) => value + 1)}
          disabled={pending}
          aria-label={`刷新 ${result.title}`}
          title={`刷新 ${result.title}`}
        >
          <span aria-hidden="true" className={pending ? "is-spinning" : ""}>↻</span>
        </button>
      </div>

      {hasSamples ? (
        <>
          {result.state === "partial" ? (
            <p className="metric-panel__notice" role="status">{STATE_COPY.partial}</p>
          ) : result.state === "stale" ? (
            <p className="metric-panel__notice" role="status">
              最后样本早于当前查询时刻，不能作为实时状态判断。
            </p>
          ) : null}
          <TimeSeriesChart
            result={result}
            markers={data.markers}
            markersTruncated={data.markersTruncated}
          />
        </>
      ) : (
        <>
          <div className={`metric-panel__empty is-${result.state}`} role="status">
            <span aria-hidden="true">∿</span>
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
