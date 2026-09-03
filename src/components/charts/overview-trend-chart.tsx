"use client";

import type { ChartData, ChartOptions } from "chart.js";
import { Chart } from "react-chartjs-2";

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
  const alertConditionsResolved = samples.reduce(
    (total, sample) => total + sample.alertConditionsResolved,
    0,
  );
  const data: ChartData<"bar" | "line", number[], string> = {
    labels,
    datasets: [
      {
        type: "bar",
        label: "新增 Incident",
        data: samples.map((sample) => sample.incidentsCreated),
        backgroundColor: "rgba(15, 157, 145, 0.82)",
        borderColor: "#0f8f86",
        borderRadius: 6,
        borderSkipped: false,
        barPercentage: 0.55,
        categoryPercentage: 0.72,
        order: 2,
      },
      {
        type: "line",
        label: "告警条件解除",
        data: samples.map((sample) => sample.alertConditionsResolved),
        borderColor: "#2f8de4",
        borderDash: [5, 5],
        borderWidth: 2,
        pointBackgroundColor: "#ffffff",
        pointBorderColor: "#2f8de4",
        pointHoverRadius: 4,
        pointRadius: 0,
        tension: 0.22,
        order: 1,
      },
    ],
  };
  const options: ChartOptions<"bar" | "line"> = {
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
          afterBody(items) {
            return items.some((item) => item.dataset.label === "告警条件解除")
              ? "仅表示 Alertmanager 条件解除，不代表 Incident 关闭。"
              : "";
          },
          labelColor(context) {
            return tooltipLineLabelStyle(
              context.datasetIndex === 0 ? "#0f8f86" : "#2f8de4",
            );
          },
          labelPointStyle(context) {
            return tooltipLinePointStyle(
              context.datasetIndex === 0 ? "#0f8f86" : "#2f8de4",
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
        <span><i className="is-created" />新增 Incident</span>
        <span><i className="is-resolved" />告警条件解除</span>
      </div>
      <div className="overview-trend__plot">
        <Chart
          type="bar"
          data={data}
          options={options}
          role="img"
          aria-label="最近 24 小时新增 Incident 与告警条件解除趋势"
        />
      </div>
      <p className="sr-only">
        {`最近 24 小时新增 Incident 共 ${incidentsCreated} 个；告警条件解除共 ${alertConditionsResolved} 个。告警条件解除不代表 Incident 关闭或恢复验证完成。`}
      </p>
    </div>
  );
}
