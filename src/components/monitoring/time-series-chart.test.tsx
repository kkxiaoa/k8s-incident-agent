import { render, screen } from "@testing-library/react";
import type { ChartData, Point } from "chart.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MetricPanelResultView } from "@/lib/agent-runtime/response-contracts";

import { TimeSeriesChart } from "./time-series-chart";

const chartProps = vi.hoisted(() => vi.fn());
vi.mock("react-chartjs-2", () => ({
  Chart: (props: Record<string, unknown>) => {
    chartProps(props);
    return <div role="img" aria-label={String(props["aria-label"])} />;
  },
}));

const endpointResult: MetricPanelResultView = {
  panelId: "service-ready-endpoints", title: "Service 就绪 Endpoint", unit: "endpoints",
  purpose: "Ready Endpoint count; zero means no ready backends.",
  seriesBinding: "target", riskDirection: "lower_is_worse", threshold: 1,
  window: "15m", anchor: "current", state: "ok",
  queriedAt: "2026-09-28T13:28:15Z", rangeStart: "2026-09-28T13:13:15Z",
  rangeEnd: "2026-09-28T13:28:15Z", latestSampleAt: "2026-09-28T13:28:15Z",
  currentValue: 0,
  series: [{ labels: {}, samples: [
    { timestamp: "2026-09-28T13:13:15Z", value: 0 },
    { timestamp: "2026-09-28T13:28:15Z", value: 0 },
  ] }],
};

function renderChart(overrides: Partial<MetricPanelResultView> = {}, referenceValue: number | null = null) {
  const result = { ...endpointResult, ...overrides };
  const view = render(<TimeSeriesChart result={result} riskDirection={result.riskDirection}
    referenceValue={referenceValue} markers={[]} markersTruncated={false} />);
  const props = chartProps.mock.lastCall![0] as {
    data: ChartData<"line", Point[]>;
  };
  return { ...props, updateReference(value: number | null) {
    view.rerender(<TimeSeriesChart result={result} riskDirection={result.riskDirection}
      referenceValue={value} markers={[]} markersTruncated={false} />);
    return (chartProps.mock.lastCall![0] as { data: ChartData<"line", Point[]> }).data;
  } };
}

beforeEach(() => chartProps.mockClear());

describe("metric risk boundaries", () => {
  it("shows a red lower threshold and risk band even without a firing marker in the window", () => {
    const { data } = renderChart();
    expect(data.datasets).toHaveLength(2);
    expect(data.datasets[1]).toMatchObject({ label: "阈值 < 1", borderColor: "rgba(229, 72, 77, 0.7)",
      fill: "start", backgroundColor: "rgba(229, 72, 77, 0.08)" });
    expect(data.datasets[1].data.map((point) => point.y)).toEqual([1, 1]);
    expect(screen.getByText("风险区间（< 1）")).toBeVisible();
    expect(screen.getByRole("img")).toHaveAccessibleName(/0 个独立事件标记/);
    expect(screen.queryByText("告警触发")).not.toBeInTheDocument();
  });

  it("shades above a higher-is-worse threshold rather than below the data line", () => {
    const { data } = renderChart({ riskDirection: "higher_is_worse" });
    expect(data.datasets[0].fill).toBe(false);
    expect(data.datasets[1]).toMatchObject({ label: "阈值 ≥ 1", borderColor: "rgba(229, 72, 77, 0.7)", fill: "end" });
  });

  it("uses the supplied desired replica count as the lower risk boundary", () => {
    const { data } = renderChart({ unit: "replicas", threshold: null }, 1);
    expect(data.datasets[1]).toMatchObject({ label: "期望副本数 1", borderColor: "rgba(229, 72, 77, 0.7)", fill: "start" });
  });

  it("updates both the boundary and its native fill as desired replica Evidence arrives or changes", () => {
    const { data, updateReference } = renderChart({ unit: "replicas", threshold: null });
    expect(data.datasets).toHaveLength(1);
    for (const value of [3, 2, 0]) {
      const updated = updateReference(value);
      expect(updated.datasets).toHaveLength(2);
      expect(updated.datasets[1]).toMatchObject({ fill: "start", backgroundColor: "rgba(229, 72, 77, 0.08)" });
      expect(updated.datasets[1].data.map((point) => point.y)).toEqual([value, value]);
    }
    expect(updateReference(null).datasets).toHaveLength(1);
  });

  it.each([
    { riskDirection: "neutral" as const, threshold: null },
    { riskDirection: "lower_is_worse" as const, threshold: null },
  ])("does not invent a boundary for $riskDirection without threshold evidence", (overrides) => {
    const { data } = renderChart(overrides);
    expect(data.datasets).toHaveLength(1);
    expect(screen.queryByText(/风险区间|低于期望副本/)).not.toBeInTheDocument();
  });

  it("keeps a zero threshold instead of treating it as missing", () => {
    const { data } = renderChart({ threshold: 0, riskDirection: "higher_is_worse" });
    expect(data.datasets[1].data.map((point) => point.y)).toEqual([0, 0]);
    expect(data.datasets[1].fill).toBe("end");
  });

  it("does not apply numeric risk shading to categorical termination lanes", () => {
    const { data } = renderChart({ unit: "containers", seriesBinding: "pod_container" });
    expect(data.datasets).toHaveLength(1);
  });
});
