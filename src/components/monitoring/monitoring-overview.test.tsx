import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  IncidentMetricPanelView,
  MetricQueryStateView,
  MetricWindowView,
  MonitoringHealthView,
} from "@/lib/agent-runtime/response-contracts";
import { INCIDENT_ID } from "@/test/agent-runtime-fixtures";

import { IncidentMonitoringOverview } from "./incident-monitoring-overview";
import { MetricPanelCard } from "./metric-panel-card";
import { MonitoringHealthOverview } from "./monitoring-health-overview";

const HEALTHY: MonitoringHealthView = {
  state: "healthy",
  checkedAt: "2026-09-03T02:15:00.000Z",
  prometheus: "healthy",
  kubeStateMetrics: "healthy",
  ruleEvaluation: "healthy",
  alertmanager: "healthy",
  notification: "healthy",
  watchdogLastReceivedAt: "2026-09-03T02:14:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function panelResponse(
  panelId: string,
  window: MetricWindowView,
  state: MetricQueryStateView = "ok",
): IncidentMetricPanelView & { schemaVersion: 1 } {
  const empty =
    state === "no_data" ||
    state === "query_error" ||
    state === "monitoring_unavailable";
  const title =
    panelId === "image-pull-waiting-containers"
      ? "Waiting containers"
      : "Affected pods";
  return {
    schemaVersion: 1,
    result: {
      panelId,
      title,
      unit: "pods",
      threshold: 1,
      window,
      state,
      queriedAt: "2026-09-03T02:15:00.000Z",
      latestSampleAt: empty ? null : "2026-09-03T02:15:00.000Z",
      currentValue: empty ? null : 0,
      samples: empty
        ? []
        : [
            { timestamp: "2026-09-03T02:14:45.000Z", value: 1 },
            { timestamp: "2026-09-03T02:15:00.000Z", value: 0 },
          ],
    },
    markers: empty
      ? []
      : [
          {
            kind: "alert_resolved",
            occurredAt: "2026-09-03T02:14:30.000Z",
            runAttempt: null,
          },
          {
            kind: "run_completed",
            occurredAt: "2026-09-03T02:14:40.000Z",
            runAttempt: 2,
          },
        ],
    markersTruncated: false,
  };
}

describe("MonitoringHealthOverview", () => {
  it("uses checks without repeating healthy text and refreshes a degraded chain", async () => {
    const user = userEvent.setup();
    const degraded = {
      ...HEALTHY,
      state: "degraded",
      ruleEvaluation: "degraded",
    } satisfies MonitoringHealthView;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(degraded)));

    render(<MonitoringHealthOverview initialHealth={HEALTHY} />);

    expect(screen.getByLabelText("监控链路正常")).toBeVisible();
    expect(screen.queryByText("正常")).toBeNull();
    expect(screen.getByLabelText("规则计算：正常")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "刷新监控链路状态" }));

    await waitFor(() => expect(screen.getByText("链路需关注")).toBeVisible());
    expect(screen.getByText("需关注")).toBeVisible();
  });

  it("does not keep presenting a healthy snapshot after refresh fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 503)));

    render(<MonitoringHealthOverview initialHealth={HEALTHY} />);

    await user.click(screen.getByRole("button", { name: "刷新监控链路状态" }));

    await waitFor(() =>
      expect(screen.getByText("链路不可用")).toBeVisible(),
    );
    expect(screen.queryByLabelText("监控链路正常")).toBeNull();
    expect(screen.getByLabelText("Prometheus：未知")).toBeVisible();
    expect(
      screen.getByText("暂时无法确认完整链路状态，不能据此判断集群正常。"),
    ).toBeVisible();
  });
});

describe("IncidentMonitoringOverview", () => {
  it("renders two catalog panels through the same component with independent markers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
          "http://console.test",
        );
        const panelId = url.pathname.split("/").at(-1) ?? "";
        return Promise.resolve(
          jsonResponse(
            panelResponse(
              panelId,
              (url.searchParams.get("window") ?? "15m") as MetricWindowView,
            ),
          ),
        );
      }),
    );

    render(
      <IncidentMonitoringOverview
        incidentId={INCIDENT_ID}
        targetLabel="Deployment · default/image-pull-backoff"
        panels={{
          panels: [
            {
              panelId: "image-pull-affected-pods",
              recommendedWindow: "15m",
            },
            {
              panelId: "image-pull-waiting-containers",
              recommendedWindow: "1h",
            },
          ],
        }}
        initialHealth={HEALTHY}
        refreshKey="completed"
      />,
    );

    expect(await screen.findByRole("heading", { name: "Affected pods" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Waiting containers" })).toBeVisible();
    expect(
      screen.getByRole("img", { name: /^Affected pods 时间序列/ }),
    ).toBeVisible();
    expect(screen.getAllByText("告警条件解除")).toHaveLength(2);
    expect(
      screen.getAllByText(
        /Alertmanager 已报告 resolved；不代表 Incident 关闭或恢复验证完成/,
      ),
    ).toHaveLength(2);
    for (const eventList of screen.getAllByRole("list", {
      name: "最近图表标记",
    })) {
      expect(within(eventList).getByText("第 2 次诊断 Run 完成")).toBeVisible();
    }
  });

  it("switches only to an allowlisted window and preserves a valid zero", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://console.test",
      );
      const window = (url.searchParams.get("window") ?? "15m") as MetricWindowView;
      return Promise.resolve(jsonResponse(panelResponse("image-pull-affected-pods", window)));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MetricPanelCard
        incidentId={INCIDENT_ID}
        panel={{ panelId: "image-pull-affected-pods", recommendedWindow: "15m" }}
        refreshKey="running"
      />,
    );

    const heading = await screen.findByRole("heading", { name: "Affected pods" });
    const card = heading.closest("article");
    expect(card).not.toBeNull();
    expect(
      within(card as HTMLElement).getByText("0", {
        selector: ".metric-panel__value",
      }),
    ).toBeVisible();

    await user.click(within(card as HTMLElement).getByRole("button", { name: "1 小时" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("window=1h");
  });
});

describe("MetricPanelCard states", () => {
  it.each([
    ["no_data", "Prometheus 没有返回可验证样本；这不等于指标值为 0。"],
    ["query_error", "固定 catalog 查询未能完成，请稍后重试。"],
    ["monitoring_unavailable", "当前无法连接监控数据源，请先检查监控链路。"],
  ] as const)("renders %s without inventing a value", async (state, copy) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(panelResponse("image-pull-affected-pods", "15m", state)),
      ),
    );

    render(
      <MetricPanelCard
        incidentId={INCIDENT_ID}
        panel={{ panelId: "image-pull-affected-pods", recommendedWindow: "15m" }}
        refreshKey={state}
      />,
    );

    expect(await screen.findByText(copy)).toBeVisible();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("keeps independent alert and Run markers visible without metric samples", async () => {
    const response = panelResponse(
      "image-pull-affected-pods",
      "15m",
      "no_data",
    );
    response.markers = [
      {
        kind: "alert_resolved",
        occurredAt: "2026-09-03T02:14:30.000Z",
        runAttempt: null,
      },
      {
        kind: "run_completed",
        occurredAt: "2026-09-03T02:14:40.000Z",
        runAttempt: 2,
      },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(response)));

    render(
      <MetricPanelCard
        incidentId={INCIDENT_ID}
        panel={{ panelId: "image-pull-affected-pods", recommendedWindow: "15m" }}
        refreshKey="no-data-with-markers"
      />,
    );

    expect(await screen.findByText("告警条件解除")).toBeVisible();
    expect(screen.getByText("第 2 次诊断 Run 完成")).toBeVisible();
    expect(screen.getByRole("list", { name: "最近图表标记" })).toBeVisible();
    expect(
      screen.getByRole("listitem", {
        name: /Alertmanager 已报告 resolved；不代表 Incident 关闭或恢复验证完成/,
      }),
    ).toBeVisible();
  });

  it.each([
    ["stale", "最后样本早于当前查询时刻，不能作为实时状态判断。"],
    ["partial", "Prometheus 报告了部分结果，图表只展示当前可验证样本。"],
  ] as const)("keeps verified samples visible for %s", async (state, copy) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(panelResponse("image-pull-affected-pods", "15m", state)),
      ),
    );

    render(
      <MetricPanelCard
        incidentId={INCIDENT_ID}
        panel={{ panelId: "image-pull-affected-pods", recommendedWindow: "15m" }}
        refreshKey={state}
      />,
    );

    expect(await screen.findByText(copy)).toBeVisible();
    expect(
      screen.getByRole("img", { name: /^Affected pods 时间序列/ }),
    ).toBeVisible();
  });

  it("shows a safe retry state for an invalid upstream response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ schemaVersion: 1 })));

    render(
      <MetricPanelCard
        incidentId={INCIDENT_ID}
        panel={{ panelId: "image-pull-affected-pods", recommendedWindow: "15m" }}
        refreshKey="invalid"
      />,
    );

    expect(
      await screen.findByText("监控响应无法验证，未展示可能失真的数据。"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "重新读取" })).toBeVisible();
  });
});
