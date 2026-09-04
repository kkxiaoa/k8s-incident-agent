import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  EvidenceView,
  IncidentMetricPanelView,
  MetricQueryStateView,
  MetricWindowView,
  MonitoringHealthView,
} from "@/lib/agent-runtime/response-contracts";
import { INCIDENT_ID } from "@/test/agent-runtime-fixtures";

import { IncidentMonitoringOverview } from "./incident-monitoring-overview";
import { MetricPanelCard } from "./metric-panel-card";
import { MonitoringHealthOverview } from "./monitoring-health-overview";

vi.mock("react-chartjs-2", () => ({
  Chart: (props: Record<string, unknown>) => {
    const options = props["options"] as
      | { interaction?: { intersect?: boolean } }
      | undefined;
    return (
      <div
        role="img"
        aria-label={String(props["aria-label"])}
        data-intersect={String(options?.interaction?.intersect)}
      />
    );
  },
  Doughnut: (props: Record<string, unknown>) => (
    <div role="img" aria-label={String(props["aria-label"])} />
  ),
}));

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

const AFFECTED_PODS_PANEL = {
  panelId: "image-pull-affected-pods",
  recommendedWindow: "15m",
  riskDirection: "higher_is_worse",
  signalRole: "trigger",
  thresholdDuration: "30s",
} as const;

const AVAILABLE_REPLICAS_PANEL = {
  panelId: "image-pull-available-replicas",
  recommendedWindow: "1h",
  riskDirection: "lower_is_worse",
  signalRole: "context",
  thresholdDuration: "5m",
} as const;

const SERVICE_ENDPOINT_PANEL = {
  panelId: "service-ready-endpoints",
  recommendedWindow: "15m",
  riskDirection: "lower_is_worse",
  signalRole: "trigger",
  thresholdDuration: "30s",
} as const;

const EVIDENCE: EvidenceView[] = [
  {
    id: "33333333-3333-4333-8333-333333333331",
    toolName: "get_workload",
    evidenceKind: "workload",
    observedAt: "2026-09-03T02:14:58.000Z",
    targetRef: {},
    payload: {
      workload: {
        replicas: { desired: 3, available: 0 },
      },
    },
    redacted: false,
    truncated: false,
  },
  {
    id: "33333333-3333-4333-8333-333333333332",
    toolName: "get_pods",
    evidenceKind: "pods",
    observedAt: "2026-09-03T02:15:00.000Z",
    targetRef: {},
    payload: {
      pods: [
        {
          containers: [
            { state: { status: "waiting", reason: "ImagePullBackOff" } },
          ],
        },
        {
          containers: [
            { state: { status: "waiting", reason: "ErrImagePull" } },
          ],
        },
      ],
    },
    redacted: false,
    truncated: false,
  },
];

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
  const availableReplicas = panelId === "image-pull-available-replicas";
  const serviceEndpoints = panelId === "service-ready-endpoints";
  const title = availableReplicas
    ? "Deployment 可用副本"
    : serviceEndpoints
      ? "Service 就绪 Endpoint"
      : "镜像拉取失败 Pod";
  return {
    schemaVersion: 1,
    result: {
      panelId,
      title,
      unit: availableReplicas
        ? "replicas"
        : serviceEndpoints
          ? "endpoints"
          : "pods",
      threshold: availableReplicas ? null : 1,
      riskDirection:
        availableReplicas || serviceEndpoints
          ? "lower_is_worse"
          : "higher_is_worse",
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
  it("renders a lightweight status path without title, overall state, or refresh", () => {
    render(<MonitoringHealthOverview initialHealth={HEALTHY} />);

    expect(screen.getByRole("region", { name: "监控链路" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "监控链路" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("正常")).toBeNull();
    expect(screen.getByLabelText("规则计算：正常")).toBeVisible();
  });

  it("puts abnormal detail on the focusable node instead of visible status text", () => {
    const degraded = {
      ...HEALTHY,
      state: "degraded",
      ruleEvaluation: "degraded",
    } satisfies MonitoringHealthView;

    render(<MonitoringHealthOverview initialHealth={degraded} />);

    const ruleNode = screen.getByLabelText("规则计算：需关注");
    expect(ruleNode).toHaveAttribute("tabindex", "0");
    expect(ruleNode).toHaveAttribute("data-tooltip", "规则计算：需关注");
    expect(screen.getByLabelText("Prometheus：正常")).not.toHaveAttribute(
      "data-tooltip",
    );
    expect(screen.queryByText("需关注")).toBeNull();
  });
});

describe("IncidentMonitoringOverview", () => {
  it("renders a compact unavailable state when the panel catalog cannot be read", () => {
    render(
      <IncidentMonitoringOverview
        incidentId={INCIDENT_ID}
        panels={null}
        evidence={[]}
        refreshKey="catalog-unavailable"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "监控数据暂不可用当前 Incident 的指标图表未展示。",
    );
    expect(
      document.querySelector(".monitoring-panels-state .ui-icon"),
    ).not.toBeNull();
  });

  it("renders two catalog panels without duplicating their data in summary cards", async () => {
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
        panels={{
          panels: [AFFECTED_PODS_PANEL, AVAILABLE_REPLICAS_PANEL],
        }}
        evidence={EVIDENCE}
        refreshKey="completed"
        alertStatus="RESOLVED"
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "镜像拉取失败 Pod" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Deployment 可用副本" }),
    ).toBeVisible();
    expect(
      screen.getAllByLabelText("镜像拉取失败 Pod，数值越高表示影响范围越大。"),
    ).toHaveLength(1);
    expect(
      screen.getAllByLabelText(
        "Deployment 可用副本，按“当前可用副本 / 期望副本”展示；低于期望值表示容量未达标。",
      ),
    ).toHaveLength(1);
    expect(
      screen.getAllByLabelText("Prometheus 返回的最新有效样本值。"),
    ).toHaveLength(1);
    expect(
      screen.getByLabelText(
        "前一个数字是 Prometheus 观测到的当前可用副本，后一个数字是同一次诊断 Run 的 workload Evidence 中记录的期望副本。",
      ),
    ).toBeVisible();
    expect(
      screen.getByLabelText("达到或超过此值时进入风险区间。"),
    ).toBeVisible();
    expect(
      screen.getByLabelText("可用副本少于期望的 3 个时进入风险区间。"),
    ).toBeVisible();
    expect(screen.getByText("< 3")).toBeVisible();
    expect(document.querySelector(".monitoring-panels--single")).toBeNull();
    expect(screen.queryByRole("region", { name: "监控链路" })).toBeNull();
    expect(screen.queryByText("等待原因")).toBeNull();
    expect(screen.queryByRole("img", { name: /概览趋势/ })).toBeNull();
    expect(
      screen.getByRole("img", { name: /^镜像拉取失败 Pod 时间序列/ }),
    ).toBeVisible();
    expect(screen.getByText("镜像拉取失败 Pod 数量")).toBeVisible();
    expect(screen.getByText("阈值区间（≥ 1）")).toBeVisible();
    expect(screen.getByText("可用副本数")).toBeVisible();
    expect(screen.getByText("期望副本数（3）")).toBeVisible();
    expect(screen.getByText("持续 30 秒")).toBeVisible();
    expect(screen.getByText("持续 5 分钟")).toBeVisible();
    expect(screen.getAllByText("条件已解除")).toHaveLength(1);
    expect(screen.getAllByText("告警条件解除")).toHaveLength(2);
    expect(
      screen.getAllByRole("listitem", {
        name: /Alertmanager 已报告 resolved；不代表 Incident 关闭或恢复验证完成/,
      }),
    ).toHaveLength(2);
    for (const eventList of screen.getAllByRole("list", {
      name: "最近图表标记",
    })) {
      expect(within(eventList).getByText("第 2 次诊断 Run 完成")).toBeVisible();
    }
  });

  it("lets one catalog panel fill the available row", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(panelResponse("service-ready-endpoints", "15m")),
        ),
    );

    render(
      <IncidentMonitoringOverview
        incidentId={INCIDENT_ID}
        panels={{ panels: [SERVICE_ENDPOINT_PANEL] }}
        evidence={[]}
        refreshKey="service"
        alertStatus="FIRING"
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Service 就绪 Endpoint" }),
    ).toBeVisible();
    expect(document.querySelector(".monitoring-panels--single")).not.toBeNull();
    expect(document.querySelectorAll(".metric-panel")).toHaveLength(1);
  });

  it("shows one compact warning when every catalog panel is unavailable", async () => {
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
        return Promise.resolve(
          jsonResponse(
            panelResponse(
              url.pathname.split("/").at(-1) ?? "",
              "15m",
              "monitoring_unavailable",
            ),
          ),
        );
      }),
    );

    render(
      <IncidentMonitoringOverview
        incidentId={INCIDENT_ID}
        panels={{
          panels: [AFFECTED_PODS_PANEL, AVAILABLE_REPLICAS_PANEL],
        }}
        evidence={EVIDENCE}
        refreshKey="unavailable"
      />,
    );

    expect(
      await screen.findByText("当前值与趋势未展示。"),
    ).toBeVisible();
    expect(screen.getAllByText("指标数据暂不可用")).toHaveLength(3);
    expect(document.querySelectorAll(".metric-panel__empty")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "重新读取" })).toBeNull();
    expect(document.querySelector(".metric-state")).toBeNull();
  });

  it("switches only to an allowlisted window and preserves a valid zero", async () => {
    const user = userEvent.setup();
    const onLoadSnapshot = vi.fn();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://console.test",
      );
      const window = (url.searchParams.get("window") ??
        "15m") as MetricWindowView;
      return Promise.resolve(
        jsonResponse(panelResponse("image-pull-affected-pods", window)),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MetricPanelCard
        incidentId={INCIDENT_ID}
        panel={AFFECTED_PODS_PANEL}
        refreshKey="running"
        alertStatus="FIRING"
        onLoadSnapshot={onLoadSnapshot}
      />,
    );

    const heading = await screen.findByRole("heading", {
      name: "镜像拉取失败 Pod",
    });
    const card = heading.closest("article");
    expect(card).not.toBeNull();
    expect(
      within(card as HTMLElement).getByText("0", {
        selector: ".metric-panel__value",
      }),
    ).toBeVisible();
    expect(within(card as HTMLElement).getByText("告警中")).toBeVisible();
    expect(within(card as HTMLElement).queryByText("数据有效")).toBeNull();

    await user.selectOptions(
      within(card as HTMLElement).getByRole("combobox", {
        name: "镜像拉取失败 Pod 时间窗口",
      }),
      "15d",
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("window=15d");
    await waitFor(() =>
      expect(onLoadSnapshot).toHaveBeenLastCalledWith(
        "image-pull-affected-pods",
        expect.objectContaining({
          state: "ready",
          result: expect.objectContaining({ window: "15d" }),
        }),
      ),
    );
  });

  it("renders a static lower-bound Service panel through the browser boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(panelResponse("service-ready-endpoints", "15m")),
        ),
    );

    render(
      <MetricPanelCard
        incidentId={INCIDENT_ID}
        panel={SERVICE_ENDPOINT_PANEL}
        refreshKey="service-running"
        alertStatus="FIRING"
      />,
    );

    const heading = await screen.findByRole("heading", {
      name: "Service 就绪 Endpoint",
    });
    const card = heading.closest("article");
    expect(card).not.toBeNull();
    expect(
      within(card as HTMLElement).getByText("Service 就绪 Endpoint 数量"),
    ).toBeVisible();
    expect(
      within(card as HTMLElement).getByText("下限阈值（< 1）"),
    ).toBeVisible();
    expect(within(card as HTMLElement).getByText("告警中")).toBeVisible();
    expect(
      within(card as HTMLElement).queryByText(
        "监控响应无法验证，未展示可能失真的数据。",
      ),
    ).toBeNull();
  });
});

describe("MetricPanelCard states", () => {
  it.each([
    ["no_data", "Prometheus 没有返回可验证样本；这不等于指标值为 0。"],
    ["query_error", "指标数据暂不可用"],
    ["monitoring_unavailable", "指标数据暂不可用"],
  ] as const)("renders %s without inventing a value", async (state, copy) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(panelResponse("image-pull-affected-pods", "15m", state)),
        ),
    );

    render(
      <MetricPanelCard
        incidentId={INCIDENT_ID}
        panel={AFFECTED_PODS_PANEL}
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
        panel={AFFECTED_PODS_PANEL}
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
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(panelResponse("image-pull-affected-pods", "15m", state)),
        ),
    );

    render(
      <MetricPanelCard
        incidentId={INCIDENT_ID}
        panel={AFFECTED_PODS_PANEL}
        refreshKey={state}
      />,
    );

    expect(await screen.findByText(copy)).toBeVisible();
    expect(
      screen.getByRole("img", { name: /^镜像拉取失败 Pod 时间序列/ }),
    ).toBeVisible();
  });

  it("shows a plain unavailable placeholder for an invalid upstream response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ schemaVersion: 1 })),
    );

    render(
      <MetricPanelCard
        incidentId={INCIDENT_ID}
        panel={AFFECTED_PODS_PANEL}
        refreshKey="invalid"
      />,
    );

    expect(await screen.findByText("指标数据暂不可用")).toBeVisible();
    expect(screen.queryByRole("button", { name: "重新读取" })).toBeNull();
  });
});
