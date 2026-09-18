"use client";

import type {
  ChartData,
  ChartDataset,
  ChartOptions,
  Point,
  Plugin,
  ScriptableContext,
} from "chart.js";
import { useState } from "react";
import { Chart } from "react-chartjs-2";

import {
  ensureChartJsRegistered,
  TOOLTIP_LINE_MARKER,
  tooltipLineLabelStyle,
  tooltipLinePointStyle,
  useReducedChartMotion,
} from "@/components/charts/chart-js";
import { LocalTimestamp } from "@/components/local-timestamp";
import type {
  MetricMarkerView,
  MetricPanelResultView,
  MetricRiskDirectionView,
} from "@/lib/agent-runtime/response-contracts";

import {
  formatMetricValue,
  isCountUnit,
  metricSeriesLabel,
  metricUnitLabel,
} from "./metric-presentation";

const MARKER_LABELS = {
  alert_firing: "告警触发",
  alert_resolved: "告警条件解除",
  run_started: "诊断 Run 开始",
  run_completed: "诊断 Run 完成",
} as const;

const LANE_WIDTH = 8;

const SERIES_COLORS = [
  "#3b6ee8",
  "#0f8f86",
  "#8e5bd6",
  "#d9822b",
  "#2b8a3e",
  "#c2255c",
  "#5c7cfa",
  "#868e96",
];

const AXIS_TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
});

const AXIS_DATE_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  day: "2-digit",
  month: "2-digit",
});

const TOOLTIP_TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
});

function laneSpanLabel(
  window: MetricPanelResultView["window"],
  points: { x: number }[],
  rangeEnd: number,
): string {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return "";
  }
  const format = (value: number) =>
    window === "7d" || window === "15d"
      ? `${AXIS_DATE_FORMAT.format(new Date(value))} ${AXIS_TIME_FORMAT.format(new Date(value))}`
      : AXIS_TIME_FORMAT.format(new Date(value));
  // The band starts when this reason became the container's latest termination,
  // and ends when a newer termination replaced it.
  return last.x >= rangeEnd
    ? `${format(first.x)} 起至今`
    : `${format(first.x)} 起，${format(last.x)} 被更新`;
}

function axisTimeLabel(
  window: MetricPanelResultView["window"],
  value: number,
): string {
  return window === "7d" || window === "15d"
    ? AXIS_DATE_FORMAT.format(new Date(value))
    : AXIS_TIME_FORMAT.format(new Date(value));
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

function fadedColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}2e` : color;
}

function riskSeriesFill(
  context: ScriptableContext<"line">,
): string | CanvasGradient {
  const { chart } = context;
  const area = chart.chartArea;
  if (area === undefined) {
    return "rgba(229, 72, 77, 0.1)";
  }
  const gradient = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
  gradient.addColorStop(0, "rgba(229, 72, 77, 0.2)");
  gradient.addColorStop(1, "rgba(229, 72, 77, 0.025)");
  return gradient;
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

interface SeriesPresentation {
  label: string;
  color: string;
  isLimit: boolean;
  points: { x: number; y: number }[];
}

/** A 0/1 snapshot panel (one series per state) reads better as lanes than as
 * lines stacked on the same value. */
function isStatePanel(result: MetricPanelResultView): boolean {
  return (
    result.seriesBinding === "pod_container" &&
    result.unit === "containers" &&
    result.series.every((item) =>
      item.samples.every((sample) => sample.value === 0 || sample.value === 1),
    )
  );
}

/** Replicas of one container share their limit; draw identical limit lines once. */
function mergeSharedLimits(
  series: SeriesPresentation[],
  labels: Record<string, string>[],
): SeriesPresentation[] {
  const merged: SeriesPresentation[] = [];
  const shared = new Map<string, { entry: SeriesPresentation; pods: number }>();
  series.forEach((item, index) => {
    if (!item.isLimit) {
      merged.push(item);
      return;
    }
    const key = `${labels[index]?.container ?? ""}:${item.points.map((point) => point.y).join(",")}`;
    const existing = shared.get(key);
    if (existing === undefined) {
      const entry = { ...item };
      shared.set(key, { entry, pods: 1 });
      merged.push(entry);
    } else {
      existing.pods += 1;
      existing.entry.label = `${labels[index]?.container ?? "容器"} · limit（${existing.pods} 个 Pod 相同）`;
    }
  });
  return merged;
}

function presentSeries(
  result: MetricPanelResultView,
  riskDirection: MetricRiskDirectionView,
): SeriesPresentation[] {
  const singleTarget = result.seriesBinding === "target";
  const lanes = isStatePanel(result);
  const presented = result.series.map((item, index) => ({
    label: singleTarget
      ? result.unit === "replicas"
        ? "可用副本数"
        : isCountUnit(result.unit)
          ? `${result.title} 数量`
          : result.title
      : metricSeriesLabel(item.labels),
    color: singleTarget
      ? riskDirection === "higher_is_worse"
        ? "#e5484d"
        : "#0f8f86"
      : SERIES_COLORS[index % SERIES_COLORS.length]!,
    isLimit: item.labels.series === "limit",
    points: item.samples
      .filter((sample) => !lanes || sample.value === 1)
      .map((sample) => ({
        x: Date.parse(sample.timestamp),
        y: lanes ? index + 1 : sample.value,
      })),
  }));
  return mergeSharedLimits(
    presented,
    result.series.map((item) => item.labels),
  );
}

export function TimeSeriesChart({
  result,
  markers,
  markersTruncated,
  riskDirection,
  referenceValue,
  showEvents = true,
}: {
  result: MetricPanelResultView;
  markers: MetricMarkerView[];
  markersTruncated: boolean;
  riskDirection: MetricRiskDirectionView;
  referenceValue: number | null;
  showEvents?: boolean;
}) {
  ensureChartJsRegistered();
  const reducedMotion = useReducedChartMotion();
  const [focusedSeries, setFocusedSeries] = useState<number | null>(null);
  const start = Date.parse(result.rangeStart);
  const end = Date.parse(result.rangeEnd);
  const staticThreshold = result.threshold;
  const series = presentSeries(result, riskDirection);
  const lanes = isStatePanel(result);
  const values = [
    ...series.flatMap((item) => item.points.map((point) => point.y)),
    ...(staticThreshold !== null
      ? [staticThreshold]
      : referenceValue === null
        ? []
        : [referenceValue]),
  ];
  const countUnit = isCountUnit(result.unit);
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(countUnit ? 1 : 0, ...values);
  const padding = Math.max((maximum - minimum) * 0.12, countUnit ? 0.5 : 0);
  // Lanes keep headroom above each bar for its inline label.
  const yMin = lanes ? 0.6 : minimum - (minimum < 0 ? padding : 0);
  const yMax = lanes
    ? series.length + 0.75
    : countUnit
      ? Math.ceil(maximum + padding)
      : maximum + padding || 1;
  const higherIsWorse = riskDirection === "higher_is_worse";
  const singleRiskSeries = higherIsWorse && result.seriesBinding === "target";
  const unitLabel = metricUnitLabel(result.unit);
  const labeledMarkers = [
    markers.find((marker) => marker.kind === "alert_firing"),
    markers.find((marker) => marker.kind === "run_started"),
  ].filter((marker): marker is MetricMarkerView => marker !== undefined);
  const markerLabelPlugin: Plugin<"line"> = {
    id: "metric-event-labels",
    afterDraw(chart) {
      const xScale = chart.scales.x;
      if (xScale === undefined) {
        return;
      }
      const positions = labeledMarkers.map((marker) =>
        xScale.getPixelForValue(Date.parse(marker.occurredAt)),
      );
      chart.ctx.save();
      chart.ctx.font = "600 11px system-ui, sans-serif";
      chart.ctx.textBaseline = "bottom";
      labeledMarkers.forEach((marker, index) => {
        const x = positions[index];
        if (
          x === undefined ||
          x < chart.chartArea.left ||
          x > chart.chartArea.right
        ) {
          return;
        }
        const closeToPrevious =
          index > 0 &&
          positions[index - 1] !== undefined &&
          Math.abs(x - positions[index - 1]!) < 90;
        chart.ctx.fillStyle =
          marker.kind === "alert_firing" ? "#e5484d" : "#0f8f86";
        chart.ctx.textAlign =
          x > chart.chartArea.right - 64 ? "right" : "left";
        chart.ctx.fillText(
          marker.kind === "alert_firing" ? "告警触发" : "诊断开始",
          x,
          chart.chartArea.top - (closeToPrevious ? 24 : 8),
        );
      });
      chart.ctx.restore();
    },
  };
  // Each state lane is a full-width track; the coloured span marks when that
  // termination reason was the container's latest one.
  const laneTrackPlugin: Plugin<"line"> = {
    id: "metric-lane-tracks",
    beforeDatasetsDraw(chart) {
      const yScale = chart.scales.y;
      if (!lanes || yScale === undefined) {
        return;
      }
      const { left, right } = chart.chartArea;
      chart.ctx.save();
      const xScale = chart.scales.x;
      series.forEach((item, index) => {
        const y = yScale.getPixelForValue(index + 1) - LANE_WIDTH / 2;
        chart.ctx.beginPath();
        chart.ctx.fillStyle = "rgba(186, 203, 213, 0.32)";
        chart.ctx.roundRect(left, y, right - left, LANE_WIDTH, LANE_WIDTH / 2);
        chart.ctx.fill();
        const first = item.points[0];
        const last = item.points.at(-1);
        if (xScale === undefined || first === undefined || last === undefined) {
          return;
        }
        // Drawn here rather than as a stroked line so the rounded span stays
        // inside its track instead of overflowing the chart edge.
        const from = Math.max(left, xScale.getPixelForValue(first.x));
        const to = Math.min(right, xScale.getPixelForValue(last.x));
        chart.ctx.beginPath();
        chart.ctx.fillStyle = item.color;
        chart.ctx.roundRect(
          from,
          y,
          Math.max(to - from, LANE_WIDTH),
          LANE_WIDTH,
          LANE_WIDTH / 2,
        );
        chart.ctx.fill();
      });
      chart.ctx.restore();
    },
    afterDatasetsDraw(chart) {
      const yScale = chart.scales.y;
      if (!lanes || yScale === undefined) {
        return;
      }
      const { left, right } = chart.chartArea;
      chart.ctx.save();
      chart.ctx.textBaseline = "bottom";
      series.forEach((item, index) => {
        const y = yScale.getPixelForValue(index + 1) - LANE_WIDTH / 2 - 5;
        chart.ctx.textAlign = "left";
        chart.ctx.font = "600 11px system-ui, sans-serif";
        chart.ctx.fillStyle = "#31536d";
        chart.ctx.fillText(item.label, left, y);
        chart.ctx.textAlign = "right";
        chart.ctx.font = "500 11px system-ui, sans-serif";
        const span = laneSpanLabel(result.window, item.points, end);
        // Event markers are drawn at the window end, right under this label;
        // a panel-coloured halo keeps the span readable where they cross.
        const spanWidth = chart.ctx.measureText(span).width;
        chart.ctx.fillStyle = "#ffffff";
        chart.ctx.fillRect(right - spanWidth - 4, y - 12, spanWidth + 8, 14);
        chart.ctx.fillStyle = "#8294a4";
        chart.ctx.fillText(span, right, y);
      });
      chart.ctx.restore();
    },
  };
  const seriesDatasets: ChartDataset<"line", Point[]>[] = series.map(
    (item, index) => ({
      label: item.label,
      data: item.points,
      backgroundColor: singleRiskSeries ? riskSeriesFill : "transparent",
      borderCapStyle: "round",
      borderColor:
        focusedSeries === null || focusedSeries === index
          ? item.color
          : fadedColor(item.color),
      borderDash: item.isLimit ? [6, 4] : undefined,
      borderJoinStyle: "round",
      borderWidth:
        (item.isLimit ? 1.5 : 2.5) + (focusedSeries === index ? 1 : 0),
      fill: singleRiskSeries ? "origin" : false,
      pointBackgroundColor: "#ffffff",
      pointBorderColor: item.color,
      pointHoverRadius: 4,
      pointRadius: 0,
      stepped: countUnit,
      ...(lanes ? { borderWidth: 0, pointHoverRadius: 0 } : {}),
      tension: 0,
      order: focusedSeries === index ? 0 : 1,
    }),
  );
  const data: ChartData<"line", Point[]> = {
    datasets: [
      ...seriesDatasets,
      ...(staticThreshold !== null
        ? [
            {
              label: `阈值 ${higherIsWorse ? "≥" : "<"} ${staticThreshold}`,
              data: [
                { x: start, y: staticThreshold },
                { x: end, y: staticThreshold },
              ],
              borderColor: higherIsWorse
                ? "rgba(229, 72, 77, 0.55)"
                : "rgba(15, 143, 134, 0.66)",
              borderDash: [6, 5],
              borderWidth: 1.5,
              pointRadius: 0,
              tension: 0,
              order: 2,
            },
          ]
        : referenceValue === null
          ? []
          : [
              {
                label: `期望副本数 ${referenceValue}`,
                data: [
                  { x: start, y: referenceValue },
                  { x: end, y: referenceValue },
                ],
                borderColor: "rgba(15, 143, 134, 0.66)",
                borderDash: [6, 5],
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0,
                order: 2,
              },
            ]),
      ...markers.map((marker) => ({
        label: markerTooltip(marker),
        data: [
          { x: Date.parse(marker.occurredAt), y: yMin },
          { x: Date.parse(marker.occurredAt), y: yMax },
        ],
        borderColor: marker.kind.startsWith("alert_")
          ? "rgba(229, 72, 77, 0.62)"
          : "rgba(15, 143, 134, 0.62)",
        borderDash: marker.kind.startsWith("alert_") ? [4, 4] : [2, 4],
        borderWidth: 1.2,
        pointRadius: 0,
        tension: 0,
        order: 3,
      })),
    ],
  };
  const options: ChartOptions<"line"> = {
    animation: reducedMotion ? false : { duration: 420 },
    interaction: { intersect: false, mode: "nearest" },
    // Two event labels stack above the plot; lanes need room for both.
    layout: {
      padding: { top: lanes ? (labeledMarkers.length > 1 ? 46 : 30) : 42 },
    },
    maintainAspectRatio: false,
    parsing: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: !lanes,
        ...TOOLTIP_LINE_MARKER,
        callbacks: {
          title(items) {
            const timestamp = items[0]?.parsed.x;
            return typeof timestamp === "number"
              ? TOOLTIP_TIME_FORMAT.format(new Date(timestamp))
              : "";
          },
          label(context) {
            const presented = series[context.datasetIndex];
            const value = context.parsed.y;
            return presented !== undefined && value !== null
              ? lanes
                ? presented.label
                : `${presented.label} ${formatMetricValue(value, result.unit)} ${unitLabel}`.trim()
              : (context.dataset.label ?? "");
          },
          labelColor(context) {
            const color = context.dataset.borderColor;
            return tooltipLineLabelStyle(
              typeof color === "string" ? color : SERIES_COLORS[0]!,
            );
          },
          labelPointStyle(context) {
            const color = context.dataset.borderColor;
            const borderDash = context.dataset.borderDash;
            return tooltipLinePointStyle(
              typeof color === "string" ? color : SERIES_COLORS[0]!,
              Array.isArray(borderDash) && borderDash.length > 0,
            );
          },
        },
      },
    },
    scales: {
      x: {
        type: "linear",
        min: start,
        max: end,
        border: { display: false },
        grid: { display: false },
        ticks: {
          callback(value) {
            return axisTimeLabel(result.window, Number(value));
          },
          color: "#8294a4",
          maxTicksLimit: 6,
        },
      },
      y: {
        min: yMin,
        max: yMax,
        border: { display: false },
        grid: { display: !lanes, color: "rgba(186, 203, 213, 0.38)" },
        ticks: {
          display: !lanes,
          callback(value) {
            return formatMetricValue(Number(value), result.unit);
          },
          color: "#8294a4",
          ...(countUnit ? { precision: 0 } : {}),
        },
      },
    },
  };
  const currentValue = result.currentValue;
  const riskCondition =
    staticThreshold !== null
      ? `${higherIsWorse ? "≥" : "<"} ${staticThreshold}`
      : riskDirection === "neutral"
        ? "中性上下文，无阈值"
        : referenceValue === null
          ? "等待期望副本 Evidence"
          : `< ${referenceValue}`;

  return (
    <div className="metric-chart">
      {lanes ? null : (
      <div className="metric-chart__legend" aria-label="图表图例">
        {series.map((item, index) => (
          <span
            key={item.label}
            className={
              focusedSeries !== null && focusedSeries !== index
                ? "is-dimmed"
                : undefined
            }
            tabIndex={singleRiskSeries ? undefined : 0}
            onMouseEnter={() => setFocusedSeries(index)}
            onMouseLeave={() => setFocusedSeries(null)}
            onFocus={() => setFocusedSeries(index)}
            onBlur={() => setFocusedSeries(null)}
          >
            <i
              className={
                singleRiskSeries
                  ? "is-risk-series"
                  : item.isLimit
                    ? "is-limit"
                    : "is-series"
              }
              style={
                singleRiskSeries
                  ? undefined
                  : item.isLimit
                    ? { borderTopColor: item.color }
                    : { background: item.color }
              }
            />
            {item.label}
          </span>
        ))}
        {staticThreshold !== null ? (
          <span>
            <i
              className={higherIsWorse ? "is-threshold-zone" : "is-reference"}
            />
            {higherIsWorse ? "阈值区间" : "下限阈值"}（
            {higherIsWorse ? "≥" : "<"} {staticThreshold}）
          </span>
        ) : referenceValue === null ? null : (
          <span><i className="is-reference" />期望副本数（{referenceValue}）</span>
        )}
      </div>
      )}

      <div className="metric-chart__plot">
        <Chart
          type="line"
          data={data}
          options={options}
          plugins={[markerLabelPlugin, laneTrackPlugin]}
          updateMode="none"
          role="img"
          aria-label={`${result.title} 时间序列。${
            currentValue === null
              ? `${series.length} 条归属序列`
              : `当前值 ${formatMetricValue(currentValue, result.unit)} ${unitLabel}`.trim()
          }，风险条件 ${riskCondition}，共 ${series.reduce(
            (count, item) => count + item.points.length,
            0,
          )} 个样本和 ${markers.length} 个独立事件标记。`}
        />
      </div>

      <div className="metric-chart__marker-legend" aria-label="事件标记图例">
        {markers.some((marker) => marker.kind.startsWith("alert_")) ? (
          <span><i className="is-alert" />告警信号</span>
        ) : null}
        {markers.some((marker) => marker.kind.startsWith("run_")) ? (
          <span><i className="is-run" />诊断 Run</span>
        ) : null}
      </div>

      {showEvents ? (
        <MetricMarkerEvents
          markers={markers}
          markersTruncated={markersTruncated}
        />
      ) : null}
    </div>
  );
}
