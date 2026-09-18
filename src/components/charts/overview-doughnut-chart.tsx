"use client";

import type { ChartData, ChartOptions } from "chart.js";
import { useState } from "react";
import { Doughnut } from "react-chartjs-2";

import type { MonitoringOverviewView } from "@/lib/agent-runtime/response-contracts";

import {
  ensureChartJsRegistered,
  TOOLTIP_LINE_MARKER,
  tooltipLineLabelStyle,
  tooltipLinePointStyle,
  useReducedChartMotion,
} from "./chart-js";

const LEGEND_LIMIT = 6;
const TIP_HALF_WIDTH = 92;
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
  const [hovered, setHovered] = useState<{
    displayName: string;
    count: number;
    x: number;
    y: number;
  } | null>(null);

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

  // The legend would grow with the catalog, so it lists the largest families
  // and folds the tail into one row; the ring still shows every family.
  const ordered = [...families].sort(
    (left, right) =>
      right.count - left.count ||
      left.displayName.localeCompare(right.displayName, "zh-CN"),
  );
  const listed = ordered.slice(0, LEGEND_LIMIT);
  const rest = ordered.slice(LEGEND_LIMIT);
  const restCount = rest.reduce((sum, family) => sum + family.count, 0);

  const data: ChartData<"doughnut", number[], string> = {
    labels: ordered.map((family) => family.displayName),
    datasets: [
      {
        data: ordered.map((family) => family.count),
        backgroundColor: ordered.map(
          (_, index) => FAMILY_COLORS[index % FAMILY_COLORS.length],
        ),
        borderColor: "#ffffff",
        borderRadius: 7,
        borderWidth: 2,
        hoverBorderWidth: 2,
        hoverOffset: 9,
        spacing: 1,
      },
    ],
  };
  const options: ChartOptions<"doughnut"> = {
    animation: reducedMotion ? false : { duration: 420 },
    cutout: "86%",
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        // Drawn as HTML instead of inside the canvas, which would clip a long
        // family name against this small plot box.
        enabled: false,
        external({ chart, tooltip }) {
          const point = tooltip.dataPoints?.[0];
          setHovered(
            tooltip.opacity === 0 || point === undefined
              ? null
              : {
                  displayName: ordered[point.dataIndex]?.displayName ?? "",
                  count: ordered[point.dataIndex]?.count ?? 0,
                  x: Math.min(
                    Math.max(tooltip.caretX, TIP_HALF_WIDTH),
                    Math.max(chart.width - TIP_HALF_WIDTH, TIP_HALF_WIDTH),
                  ),
                  y: tooltip.caretY,
                },
          );
        },
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
        {hovered === null ? null : (
          <p
            className="overview-doughnut__tip"
            style={{ left: `${hovered.x}px`, top: `${hovered.y}px` }}
            aria-hidden="true"
          >
            {hovered.displayName}
            <strong>
              {`${hovered.count} · ${
                total === 0 ? 0 : Math.round((hovered.count / total) * 100)
              }%`}
            </strong>
          </p>
        )}
      </div>
      <ul className="overview-doughnut__legend" aria-label="告警中 Incident 故障族分布">
        {listed.map((family, index) => (
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
        {rest.length === 0 ? null : (
          <li
            className="overview-doughnut__rest"
            title={rest
              .map((family) => `${family.displayName} ${family.count}`)
              .join("\n")}
          >
            <span className="overview-doughnut__swatch is-rest" aria-hidden="true" />
            <span>{`其余 ${rest.length} 个故障族`}</span>
            <strong>{restCount}</strong>
          </li>
        )}
      </ul>
    </div>
  );
}
