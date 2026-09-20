"use client";

import type { ChartData, ChartOptions, ScriptableContext } from "chart.js";
import { Line } from "react-chartjs-2";

import type { MonitoringOverviewView } from "@/lib/agent-runtime/response-contracts";

import {
  ensureChartJsRegistered,
  TOOLTIP_LINE_MARKER,
  tooltipLineLabelStyle,
  tooltipLinePointStyle,
  useReducedChartMotion,
} from "./chart-js";

const HOUR_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  hourCycle: "h23",
});
const CREATED_COLOR = "#0f9d91";
const SETTLED_COLOR = "#4b9ae4";

function area(color: string, alpha: string, downward: boolean) {
  return (context: ScriptableContext<"line">) => {
    const { ctx, chartArea } = context.chart;
    if (chartArea === undefined) {
      return "transparent";
    }

    const gradient = ctx.createLinearGradient(
      0,
      downward ? chartArea.bottom : chartArea.top,
      0,
      downward ? chartArea.top : chartArea.bottom,
    );
    gradient.addColorStop(0, `${color}${alpha}`);
    gradient.addColorStop(1, `${color}00`);
    return gradient;
  };
}

export function OverviewTrendChart({
  samples,
}: {
  samples: MonitoringOverviewView["samples"];
}) {
  ensureChartJsRegistered();
  const reducedMotion = useReducedChartMotion();
  const labels = samples.map((sample) => HOUR_FORMAT.format(new Date(sample.timestamp)));
  const incidentsCreated = samples.reduce(
    (total, sample) => total + sample.incidentsCreated,
    0,
  );
  const incidentsSettled = samples.reduce(
    (total, sample) => total + sample.incidentsSettled,
    0,
  );
  const alertConditionsResolved = samples.reduce(
    (total, sample) => total + sample.alertConditionsResolved,
    0,
  );
  // Arrivals rise and endings fall from one zero line, so the two directions
  // read against each other without ever composing a remaining-work stock.
  const bound = Math.max(
    1,
    ...samples.map((sample) =>
      Math.max(sample.incidentsCreated, sample.incidentsSettled),
    ),
  );
  const data: ChartData<"line", number[], string> = {
    labels,
    datasets: [
      {
        label: "新增 Incident",
        data: samples.map((sample) => sample.incidentsCreated),
        backgroundColor: area(CREATED_COLOR, "3d", false),
        borderColor: CREATED_COLOR,
        borderWidth: 2.2,
        cubicInterpolationMode: "monotone",
        fill: "origin",
        pointBackgroundColor: "#ffffff",
        pointBorderColor: CREATED_COLOR,
        pointBorderWidth: 2,
        pointHoverRadius: 4,
        pointRadius: 0,
      },
      {
        label: "已结束 Incident",
        data: samples.map((sample) => -sample.incidentsSettled),
        backgroundColor: area(SETTLED_COLOR, "33", true),
        borderColor: SETTLED_COLOR,
        borderWidth: 2,
        cubicInterpolationMode: "monotone",
        fill: "origin",
        pointBackgroundColor: "#ffffff",
        pointBorderColor: SETTLED_COLOR,
        pointBorderWidth: 2,
        pointHoverRadius: 4,
        pointRadius: 0,
      },
    ],
  };
  const options: ChartOptions<"line"> = {
    animation: reducedMotion ? false : { duration: 420 },
    interaction: { intersect: false, mode: "index" },
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        ...TOOLTIP_LINE_MARKER,
        // Keep the box clear of the hovered point, which marks the hour it
        // reads out; the default padding lets it sit on top of the marker.
        caretPadding: 14,
        callbacks: {
          label(context) {
            return ` ${context.dataset.label}  ${Math.abs(context.parsed.y ?? 0)}`;
          },
          afterBody(items) {
            const index = items[0]?.dataIndex;
            const resolved =
              index === undefined ? 0 : (samples[index]?.alertConditionsResolved ?? 0);
            return [
              `本小时告警条件解除 ${resolved}`,
              "条件解除不代表 Incident 关闭；已结束含拒绝、证据不足与失败。",
            ];
          },
          labelColor(context) {
            return tooltipLineLabelStyle(
              context.datasetIndex === 0 ? CREATED_COLOR : SETTLED_COLOR,
            );
          },
          labelPointStyle(context) {
            return tooltipLinePointStyle(
              context.datasetIndex === 0 ? CREATED_COLOR : SETTLED_COLOR,
            );
          },
        },
      },
    },
    scales: {
      x: {
        border: { display: false },
        grid: { display: false },
        ticks: { color: "#8294a4", maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
      },
      y: {
        border: { display: false },
        suggestedMin: -bound,
        suggestedMax: bound,
        grid: {
          color: (context) =>
            context.tick.value === 0
              ? "rgba(130, 148, 164, 0.55)"
              : "rgba(186, 203, 213, 0.38)",
        },
        ticks: {
          color: "#8294a4",
          precision: 0,
          callback: (value) => Math.abs(Number(value)),
        },
      },
    },
  };

  return (
    <div className="overview-trend">
      <div className="overview-trend__legend" aria-label="趋势图图例">
        <span><i className="is-created" />新增 Incident</span>
        <span><i className="is-settled" />已结束 Incident</span>
      </div>
      <div className="overview-trend__plot">
        <Line
          data={data}
          options={options}
          role="img"
          aria-label="最近 24 小时每小时新增与已结束的 Incident"
        />
      </div>
      <p className="sr-only">
        {`最近 24 小时新增 Incident 共 ${incidentsCreated} 个；进入终态 ${incidentsSettled} 次，终态含拒绝、证据不足与失败，重新诊断会再次计入，不代表已恢复；告警条件解除共 ${alertConditionsResolved} 次，不代表 Incident 关闭。`}
      </p>
    </div>
  );
}
