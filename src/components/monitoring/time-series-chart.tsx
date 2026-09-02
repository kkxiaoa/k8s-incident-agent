"use client";

import { useId } from "react";

import { LocalTimestamp } from "@/components/local-timestamp";
import type {
  MetricMarkerView,
  MetricPanelResultView,
} from "@/lib/agent-runtime/response-contracts";

const WIDTH = 760;
const HEIGHT = 220;
const LEFT = 48;
const RIGHT = 18;
const TOP = 20;
const BOTTOM = 34;

const MARKER_LABELS = {
  alert_firing: "告警触发",
  alert_resolved: "告警条件解除",
  run_started: "诊断 Run 开始",
  run_completed: "诊断 Run 完成",
} as const;

function windowMilliseconds(window: MetricPanelResultView["window"]): number {
  return window === "15m"
    ? 15 * 60_000
    : window === "1h"
      ? 60 * 60_000
      : 6 * 60 * 60_000;
}

function markerLabel(marker: MetricMarkerView): string {
  const label = MARKER_LABELS[marker.kind];
  return marker.runAttempt === null || marker.runAttempt === undefined
    ? label
    : `第 ${marker.runAttempt} 次${label}`;
}

function markerTooltip(marker: MetricMarkerView): string {
  const label = markerLabel(marker);
  return marker.kind === "alert_resolved"
    ? `${label}。Alertmanager 已报告 resolved；不代表 Incident 关闭或恢复验证完成。`
    : label;
}

export function MetricMarkerEvents({
  markers,
  markersTruncated,
}: {
  markers: MetricMarkerView[];
  markersTruncated: boolean;
}) {
  const latestMarkers = markers.slice(-4);

  if (latestMarkers.length === 0 && !markersTruncated) {
    return null;
  }

  return (
    <>
      {latestMarkers.length === 0 ? null : (
        <ul className="metric-chart__events" aria-label="最近图表标记">
          {latestMarkers.map((marker, index) => (
            <li
              key={`${marker.kind}:${marker.occurredAt}:${index}`}
              aria-label={markerTooltip(marker)}
              title={markerTooltip(marker)}
            >
              <span>{markerLabel(marker)}</span>
              <LocalTimestamp timestamp={marker.occurredAt} />
            </li>
          ))}
        </ul>
      )}
      {markersTruncated ? (
        <p className="metric-chart__note">仅显示最近 50 次诊断 Run 的标记。</p>
      ) : null}
    </>
  );
}

export function TimeSeriesChart({
  result,
  markers,
  markersTruncated,
}: {
  result: MetricPanelResultView;
  markers: MetricMarkerView[];
  markersTruncated: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const queriedAt = Date.parse(result.queriedAt);
  const start = queriedAt - windowMilliseconds(result.window);
  const values = [...result.samples.map((sample) => sample.value), result.threshold];
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(1, ...values);
  const padding = Math.max((maximum - minimum) * 0.12, 0.25);
  const yMin = minimum - (minimum < 0 ? padding : 0);
  const yMax = maximum + padding;
  const x = (timestamp: string) =>
    LEFT +
    ((Date.parse(timestamp) - start) / (queriedAt - start)) *
      (WIDTH - LEFT - RIGHT);
  const y = (value: number) =>
    TOP +
    ((yMax - value) / (yMax - yMin)) * (HEIGHT - TOP - BOTTOM);
  const path = result.samples
    .map(
      (sample, index) =>
        `${index === 0 ? "M" : "L"} ${x(sample.timestamp).toFixed(2)} ${y(sample.value).toFixed(2)}`,
    )
    .join(" ");
  return (
    <div className="metric-chart">
      <svg
        className="metric-chart__plot"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
      >
        <title id={titleId}>{result.title} 时间序列</title>
        <desc id={descriptionId}>
          当前值 {result.currentValue} {result.unit}，阈值 {result.threshold}，
          共 {result.samples.length} 个样本和 {markers.length} 个独立事件标记。
        </desc>
        {[0, 0.5, 1].map((ratio) => {
          const lineY = TOP + ratio * (HEIGHT - TOP - BOTTOM);
          return (
            <line
              key={ratio}
              className="metric-chart__grid"
              x1={LEFT}
              x2={WIDTH - RIGHT}
              y1={lineY}
              y2={lineY}
            />
          );
        })}
        <line
          className="metric-chart__threshold"
          x1={LEFT}
          x2={WIDTH - RIGHT}
          y1={y(result.threshold)}
          y2={y(result.threshold)}
        >
          <title>阈值 {result.threshold}</title>
        </line>
        {markers.map((marker, index) => (
          <line
            key={`${marker.kind}:${marker.occurredAt}:${marker.runAttempt ?? "alert"}:${index}`}
            className={`metric-chart__marker is-${marker.kind}`}
            x1={x(marker.occurredAt)}
            x2={x(marker.occurredAt)}
            y1={TOP}
            y2={HEIGHT - BOTTOM}
          >
            <title>{markerTooltip(marker)}</title>
          </line>
        ))}
        <path className="metric-chart__line" d={path} />
        {result.samples.map((sample) => (
          <circle
            key={sample.timestamp}
            className="metric-chart__point"
            cx={x(sample.timestamp)}
            cy={y(sample.value)}
            r="2.6"
          >
            <title>{sample.value}</title>
          </circle>
        ))}
        <text className="metric-chart__axis-label" x={LEFT} y={HEIGHT - 8}>
          窗口开始
        </text>
        <text
          className="metric-chart__axis-label"
          x={WIDTH - RIGHT}
          y={HEIGHT - 8}
          textAnchor="end"
        >
          查询时刻
        </text>
      </svg>

      <div className="metric-chart__legend" aria-label="图表图例">
        <span><i className="is-series" />指标值</span>
        <span><i className="is-threshold" />阈值</span>
        {markers.some((marker) => marker.kind.startsWith("alert_")) ? (
          <span><i className="is-alert" />告警信号</span>
        ) : null}
        {markers.some((marker) => marker.kind.startsWith("run_")) ? (
          <span><i className="is-run" />诊断 Run</span>
        ) : null}
      </div>

      <MetricMarkerEvents
        markers={markers}
        markersTruncated={markersTruncated}
      />
    </div>
  );
}
