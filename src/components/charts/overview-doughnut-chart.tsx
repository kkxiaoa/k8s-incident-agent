"use client";

import type { ChartData, ChartOptions } from "chart.js";
import { Doughnut } from "react-chartjs-2";

import type { MonitoringOverviewView } from "@/lib/agent-runtime/response-contracts";

import {
  ensureChartJsRegistered,
  TOOLTIP_LINE_MARKER,
  tooltipLineLabelStyle,
  tooltipLinePointStyle,
  useReducedChartMotion,
} from "./chart-js";

const FAMILY_COLORS = ["#0f9d91", "#2f8de4", "#f39419", "#7d90a3", "#ef5b62", "#7158d8"];

export function OverviewDoughnutChart({
  families,
  total,
}: {
  families: MonitoringOverviewView["families"];
  total: number;
}) {
  ensureChartJsRegistered();
  const reducedMotion = useReducedChartMotion();

  if (families.length === 0) {
    return (
      <div className="overview-doughnut overview-doughnut--empty">
        <div
          className="overview-doughnut__empty-ring"
          role="img"
          aria-label="当前没有告警中的 Incident"
        >
          <strong>0</strong>
          <span>告警中</span>
        </div>
        <p>当前没有告警中的 Incident。</p>
      </div>
    );
  }

  const data: ChartData<"doughnut", number[], string> = {
    labels: families.map((family) => family.displayName),
    datasets: [
      {
        data: families.map((family) => family.count),
        backgroundColor: families.map(
          (_, index) => FAMILY_COLORS[index % FAMILY_COLORS.length],
        ),
        borderColor: "#ffffff",
        borderRadius: 7,
        borderWidth: 3,
        hoverBorderWidth: 2,
        hoverOffset: 9,
        spacing: 1,
      },
    ],
  };
  const options: ChartOptions<"doughnut"> = {
    animation: reducedMotion ? false : { duration: 420 },
    cutout: "76%",
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        ...TOOLTIP_LINE_MARKER,
        callbacks: {
          label(context) {
            const count = context.parsed;
            const ratio = total === 0 ? 0 : Math.round((count / total) * 100);
            return ` ${context.label}  ${count} · ${ratio}%`;
          },
          labelColor(context) {
            return tooltipLineLabelStyle(
              FAMILY_COLORS[context.dataIndex % FAMILY_COLORS.length] ??
                FAMILY_COLORS[0]!,
            );
          },
          labelPointStyle(context) {
            return tooltipLinePointStyle(
              FAMILY_COLORS[context.dataIndex % FAMILY_COLORS.length] ??
                FAMILY_COLORS[0]!,
            );
          },
        },
      },
    },
  };

  return (
    <div className="overview-doughnut">
      <div className="overview-doughnut__plot">
        <Doughnut
          data={data}
          options={options}
          role="img"
          aria-label={`告警中的 Incident 共 ${total} 个，分布于 ${families.length} 个故障族`}
        />
        <div className="overview-doughnut__center" aria-hidden="true">
          <strong>{total}</strong>
          <span>告警中</span>
        </div>
      </div>
      <ul className="overview-doughnut__legend" aria-label="告警中 Incident 故障族分布">
        {families.map((family, index) => (
          <li key={family.sourceRef}>
            <span
              className="overview-doughnut__swatch"
              style={{ backgroundColor: FAMILY_COLORS[index % FAMILY_COLORS.length] }}
              aria-hidden="true"
            />
            <span title={family.sourceRef}>{family.displayName}</span>
            <strong>{family.count}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}
