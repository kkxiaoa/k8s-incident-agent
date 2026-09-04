"use client";

import type {
  ChartData,
  ChartOptions,
  Point,
  Plugin,
  ScriptableContext,
} from "chart.js";
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
} from "@/lib/agent-runtime/response-contracts";

import { metricUnitLabel } from "./metric-presentation";

const MARKER_LABELS = {
  alert_firing: "告警触发",
  alert_resolved: "告警条件解除",
  run_started: "诊断 Run 开始",
  run_completed: "诊断 Run 完成",
} as const;

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

function windowMilliseconds(window: MetricPanelResultView["window"]): number {
  return window === "15m"
    ? 15 * 60_000
    : window === "1h"
      ? 60 * 60_000
      : window === "6h"
        ? 6 * 60 * 60_000
        : window === "7d"
          ? 7 * 24 * 60 * 60_000
          : 15 * 24 * 60 * 60_000;
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

export function TimeSeriesChart({
  result,
  markers,
  markersTruncated,
  riskDirection,
  referenceValue,
}: {
  result: MetricPanelResultView;
  markers: MetricMarkerView[];
  markersTruncated: boolean;
  riskDirection: "higher_is_worse" | "lower_is_worse";
  referenceValue: number | null;
}) {
  ensureChartJsRegistered();
  const reducedMotion = useReducedChartMotion();
  const queriedAt = Date.parse(result.queriedAt);
  const start = queriedAt - windowMilliseconds(result.window);
  const staticThreshold = result.threshold;
  const values = [
    ...result.samples.map((sample) => sample.value),
    ...(staticThreshold !== null
      ? [staticThreshold]
      : referenceValue === null
        ? []
        : [referenceValue]),
  ];
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(1, ...values);
  const padding = Math.max((maximum - minimum) * 0.12, 0.5);
  const yMin = minimum - (minimum < 0 ? padding : 0);
  const yMax = Math.ceil(maximum + padding);
  const higherIsWorse = riskDirection === "higher_is_worse";
  const seriesLabel =
    result.unit === "replicas" ? "可用副本数" : `${result.title} 数量`;
  const seriesColor = higherIsWorse ? "#e5484d" : "#0f8f86";
  const points = result.samples.map((sample) => ({
    x: Date.parse(sample.timestamp),
    y: sample.value,
  }));
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
  const data: ChartData<"line", Point[]> = {
    datasets: [
      {
        label: result.title,
        data: points,
        backgroundColor: higherIsWorse ? riskSeriesFill : "transparent",
        borderCapStyle: "round",
        borderColor: seriesColor,
        borderJoinStyle: "round",
        borderWidth: 2.5,
        fill: higherIsWorse ? "origin" : false,
        pointBackgroundColor: "#ffffff",
        pointBorderColor: seriesColor,
        pointHoverRadius: 4,
        pointRadius: 0,
        stepped: true,
        tension: 0,
        order: 1,
      },
      ...(staticThreshold !== null
        ? [
            {
              label: `阈值 ${higherIsWorse ? "≥" : "<"} ${staticThreshold}`,
              data: [
                { x: start, y: staticThreshold },
                { x: queriedAt, y: staticThreshold },
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
                  { x: queriedAt, y: referenceValue },
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
    layout: { padding: { top: 42 } },
    maintainAspectRatio: false,
    parsing: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        ...TOOLTIP_LINE_MARKER,
        callbacks: {
          title(items) {
            const timestamp = items[0]?.parsed.x;
            return typeof timestamp === "number"
              ? TOOLTIP_TIME_FORMAT.format(new Date(timestamp))
              : "";
          },
          label(context) {
            return context.datasetIndex === 0
              ? `${result.title} ${context.parsed.y} ${metricUnitLabel(result.unit)}`
              : context.dataset.label ?? "";
          },
          labelColor(context) {
            const color = context.dataset.borderColor;
            return tooltipLineLabelStyle(
              typeof color === "string" ? color : seriesColor,
            );
          },
          labelPointStyle(context) {
            const color = context.dataset.borderColor;
            const borderDash = context.dataset.borderDash;
            return tooltipLinePointStyle(
              typeof color === "string" ? color : seriesColor,
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
        max: queriedAt,
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
        grid: { color: "rgba(186, 203, 213, 0.38)" },
        ticks: { color: "#8294a4", precision: 0 },
      },
    },
  };

  return (
    <div className="metric-chart">
      <div className="metric-chart__legend" aria-label="图表图例">
        <span>
          <i className={higherIsWorse ? "is-risk-series" : "is-series"} />
          {seriesLabel}
        </span>
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

      <div className="metric-chart__plot">
        <Chart
          type="line"
          data={data}
          options={options}
          plugins={[markerLabelPlugin]}
          role="img"
          aria-label={`${result.title} 时间序列。当前值 ${result.currentValue} ${result.unit}，风险条件 ${staticThreshold !== null ? `${higherIsWorse ? "≥" : "<"} ${staticThreshold}` : referenceValue === null ? "等待期望副本 Evidence" : `< ${referenceValue}`}，共 ${result.samples.length} 个样本和 ${markers.length} 个独立事件标记。`}
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

      <MetricMarkerEvents
        markers={markers}
        markersTruncated={markersTruncated}
      />
    </div>
  );
}
