"use client";

import type { ChartData, ChartOptions } from "chart.js";
import { useMemo, useState } from "react";
import { Doughnut } from "react-chartjs-2";

import type { MonitoringOverviewView } from "@/lib/agent-runtime/response-contracts";

import { ensureChartJsRegistered, useReducedChartMotion } from "./chart-js";

const LEGEND_LIMIT = 6;
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
  } | null>(null);

  // The legend would grow with the catalog, so it lists the largest families
  // and folds the tail into one row; the ring still shows every family.
  const ordered = useMemo(
    () =>
      [...families].sort(
        (left, right) =>
          right.count - left.count ||
          left.displayName.localeCompare(right.displayName, "zh-CN"),
      ),
    [families],
  );
  const data = useMemo<ChartData<"doughnut", number[], string>>(
    () => ({
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
          // Chart.js lifts an arc by a quarter of this value.
          hoverOffset: 18,
          spacing: 1,
        },
      ],
    }),
    [ordered],
  );
  // react-chartjs-2 updates the chart whenever these objects change identity,
  // and an update clears the hovered slice, so they must survive the re-render
  // that the hover state triggers on every pointer move.
  const options = useMemo<ChartOptions<"doughnut">>(
    () => ({
      animation: reducedMotion ? false : { duration: 420 },
      transitions: reducedMotion ? {} : { active: { animation: { duration: 200 } } },
      interaction: { intersect: true, mode: "nearest" },
      cutout: "86%",
      maintainAspectRatio: false,
      // Chart.js sizes the ring from the resting options only, so the ring
      // keeps back the room the lifted slice needs instead of being clipped by
      // the plot box.
      radius: "94%",
      plugins: {
        legend: { display: false },
        tooltip: {
          // A floating box would be wider than this plot and would cover the
          // ring, so the hovered family is read out in the ring's hole.
          enabled: false,
          external({ tooltip }) {
            const point = tooltip.dataPoints?.[0];
            setHovered(
              tooltip.opacity === 0 || point === undefined
                ? null
                : {
                    displayName: ordered[point.dataIndex]?.displayName ?? "",
                    count: ordered[point.dataIndex]?.count ?? 0,
                  },
            );
          },
        },
      },
    }),
    [ordered, reducedMotion],
  );

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

  const listed = ordered.slice(0, LEGEND_LIMIT);
  const rest = ordered.slice(LEGEND_LIMIT);
  const restCount = rest.reduce((sum, family) => sum + family.count, 0);

  return (
    <div className="overview-doughnut">
      <div className="overview-doughnut__plot" data-tip={hovered !== null}>
        <Doughnut
          data={data}
          options={options}
          role="img"
          aria-label={`告警中的 Incident 共 ${total} 个，分布于 ${families.length} 个故障族`}
        />
        <div
          className="overview-doughnut__center"
          aria-hidden="true"
          data-visible={hovered === null}
        >
          <strong>{total}</strong>
          <span>告警中</span>
        </div>
        <p
          className="overview-doughnut__focus"
          aria-hidden="true"
          data-visible={hovered !== null}
        >
          <span>{hovered?.displayName ?? ""}</span>
          <strong>
            {hovered === null
              ? ""
              : `${hovered.count} · ${
                  total === 0 ? 0 : Math.round((hovered.count / total) * 100)
                }%`}
          </strong>
        </p>
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
