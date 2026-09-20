import type { ChartData, ChartOptions } from "chart.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OverviewTrendChart } from "./overview-trend-chart";

let captured: {
  data: ChartData<"line", number[], string>;
  options: ChartOptions<"line">;
} | null = null;

vi.mock("react-chartjs-2", () => ({
  Line: (props: Record<string, unknown>) => {
    captured = {
      data: props["data"] as ChartData<"line", number[], string>,
      options: props["options"] as ChartOptions<"line">,
    };
    return <div role="img" aria-label={String(props["aria-label"])} />;
  },
}));

const SAMPLES = Array.from({ length: 24 }, (_, index) => ({
  timestamp: new Date(Date.UTC(2026, 8, 19, index)).toISOString(),
  incidentsCreated: index === 3 ? 2 : index === 7 ? 1 : 0,
  alertConditionsResolved: index === 5 ? 1 : 0,
  incidentsSettled: index === 9 ? 3 : 0,
}));

function chart() {
  render(<OverviewTrendChart samples={SAMPLES} />);
  expect(captured).not.toBeNull();
  return captured!;
}

describe("incident flow trend", () => {
  it("draws endings against arrivals instead of composing a remaining stock", () => {
    const { data, options } = chart();

    const [created, settled] = data.datasets;
    expect(created!.data).toEqual(SAMPLES.map((sample) => sample.incidentsCreated));
    // Endings are plotted downward; the two directions never add up to a stock.
    expect(settled!.data).toEqual(SAMPLES.map((sample) => -sample.incidentsSettled));
    expect(settled!.data.every((value) => value <= 0)).toBe(true);
    expect(data.datasets.some((dataset) => "stack" in dataset)).toBe(false);

    const scale = options.scales?.y as
      | { suggestedMin?: number; suggestedMax?: number; ticks?: { callback?: unknown } }
      | undefined;
    // Equal pixels per Incident above and below the zero line.
    expect(scale?.suggestedMin).toBe(-3);
    expect(scale?.suggestedMax).toBe(3);
    const callback = scale?.ticks?.callback as (value: number) => number;
    expect(callback(-2)).toBe(2);
    expect(callback(2)).toBe(2);
  });

  it("reads out the measure's boundary for a screen reader", () => {
    render(<OverviewTrendChart samples={SAMPLES} />);

    const summary = screen.getByText(/新增 Incident 共 3 个/);
    expect(summary).toHaveTextContent("进入终态 3 次");
    expect(summary).toHaveTextContent("重新诊断会再次计入");
    expect(summary).toHaveTextContent("不代表已恢复");
    expect(summary).toHaveTextContent("告警条件解除共 1 次");
  });
});
