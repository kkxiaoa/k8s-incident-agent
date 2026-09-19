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
const RESOLVED_COLOR = "#4b9ae4";

function createdArea(context: ScriptableContext<"line">) {
  const { ctx, chartArea } = context.chart;
  if (chartArea === undefined) {
    return "transparent";
  }

  const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  gradient.addColorStop(0, "rgba(15, 157, 145, 0.24)");
  gradient.addColorStop(1, "rgba(15, 157, 145, 0)");
  return gradient;
}

export function OverviewTrendChart({
  samples,
}: {
  samples: MonitoringOverviewView["samples"];
}) {
  ensureChartJsRegistered();
  const reducedMotion = useReducedChartMotion();
  const labels = samples.map((sample) => HOUR_FORMAT.format(new Date(sample.timestamp)));
  // Hourly counts of one or two read as a row of spikes, so the curve carries
  // the running total across the window and the hourly count stays in the
  // tooltip.
  const createdRunning: number[] = [];
  const resolvedRunning: number[] = [];
  for (const sample of samples) {
    createdRunning.push((createdRunning.at(-1) ?? 0) + sample.incidentsCreated);
    resolvedRunning.push(
      (resolvedRunning.at(-1) ?? 0) + sample.alertConditionsResolved,
    );
  }
  const incidentsCreated = createdRunning.at(-1) ?? 0;
  const alertConditionsResolved = resolvedRunning.at(-1) ?? 0;
  const data: ChartData<"line", number[], string> = {
    labels,
    datasets: [
      {
        label: "累计新增 Incident",
        data: createdRunning,
        backgroundColor: createdArea,
        borderColor: CREATED_COLOR,
        borderWidth: 2.2,
        fill: true,
        pointBackgroundColor: "#ffffff",
        pointBorderColor: CREATED_COLOR,
        pointBorderWidth: 2,
        pointHoverRadius: 4,
        pointRadius: 0,
        cubicInterpolationMode: "monotone",
      },
      {
        label: "累计告警条件解除",
        data: resolvedRunning,
        borderColor: RESOLVED_COLOR,
        borderDash: [6, 4],
        borderWidth: 2,
        fill: false,
        pointBackgroundColor: "#ffffff",
        pointBorderColor: RESOLVED_COLOR,
        pointBorderWidth: 2,
        pointHoverRadius: 4,
        pointRadius: 0,
        cubicInterpolationMode: "monotone",
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
        callbacks: {
          label(context) {
            const hourly =
              context.datasetIndex === 0
                ? samples[context.dataIndex]?.incidentsCreated
                : samples[context.dataIndex]?.alertConditionsResolved;
            const thisHour = hourly === undefined || hourly === 0 ? "" : `（本小时 +${hourly}）`;
            return ` ${context.dataset.label}  ${context.parsed.y}${thisHour}`;
          },
          afterBody(items) {
            return items.some((item) => item.dataset.label === "累计告警条件解除")
              ? "仅表示 Alertmanager 条件解除，不代表 Incident 关闭。"
              : "";
          },
          labelColor(context) {
            return tooltipLineLabelStyle(
              context.datasetIndex === 0 ? CREATED_COLOR : RESOLVED_COLOR,
            );
          },
          labelPointStyle(context) {
            return tooltipLinePointStyle(
              context.datasetIndex === 0 ? CREATED_COLOR : RESOLVED_COLOR,
              context.datasetIndex !== 0,
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
        beginAtZero: true,
        border: { display: false },
        grid: { color: "rgba(186, 203, 213, 0.38)" },
        ticks: { color: "#8294a4", precision: 0 },
      },
    },
  };

  return (
    <div className="overview-trend">
      <div className="overview-trend__legend" aria-label="趋势图图例">
        <span><i className="is-created" />累计新增 Incident</span>
        <span><i className="is-resolved" />累计告警条件解除</span>
      </div>
      <div className="overview-trend__plot">
        <Line
          data={data}
          options={options}
          role="img"
          aria-label="最近 24 小时新增 Incident 与告警条件解除的累计趋势"
        />
      </div>
      <p className="sr-only">
        {`最近 24 小时新增 Incident 共 ${incidentsCreated} 个；告警条件解除共 ${alertConditionsResolved} 个。告警条件解除不代表 Incident 关闭或恢复验证完成。`}
      </p>
    </div>
  );
}
