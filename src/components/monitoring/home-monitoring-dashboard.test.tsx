import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  MonitoringHealthView,
  MonitoringOverviewView,
} from "@/lib/agent-runtime/response-contracts";

import { HomeMonitoringDashboard } from "./home-monitoring-dashboard";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));

vi.mock("react-chartjs-2", () => ({
  Doughnut: (props: Record<string, unknown>) => (
    <div role="img" aria-label={String(props["aria-label"])} />
  ),
  Line: (props: Record<string, unknown>) => (
    <div role="img" aria-label={String(props["aria-label"])} />
  ),
}));

const HEALTH: MonitoringHealthView = {
  state: "healthy",
  checkedAt: "2026-09-03T02:15:00.000Z",
  prometheus: "healthy",
  kubeStateMetrics: "healthy",
  ruleEvaluation: "healthy",
  alertmanager: "healthy",
  notification: "healthy",
  watchdogLastReceivedAt: "2026-09-03T02:14:00.000Z",
  healthAlerts: [],
};

function overview(firingAlerts = 2): MonitoringOverviewView {
  const start = Date.parse("2026-09-02T03:00:00.000Z");
  return {
    window: "24h",
    generatedAt: "2026-09-03T02:15:00.000Z",
    currentAlerts: { totalTargets: 2, unknownTargets: 1, firingRules: 1, pendingRules: 0, oldestObservedAt: "2026-09-03T02:14:45.000Z" },
    counts: {
      totalIncidents: 8,
      firingAlerts,
      triagingIncidents: 3,
      waitingApprovalIncidents: 4,
      unassignedSignals: 0,
    },
    unassignedSignals: [],
    families:
      firingAlerts === 0
        ? []
        : [
            {
              sourceRef: "K8sIncidentImagePullBackOff",
              displayName: "Image pull failure",
              count: firingAlerts,
            },
          ],
    samples: Array.from({ length: 24 }, (_, index) => ({
      timestamp: new Date(start + index * 3_600_000).toISOString(),
      incidentsCreated: index === 23 ? 2 : 0,
      alertConditionsResolved: index === 22 ? 1 : 0,
      incidentsSettled: index === 21 ? 1 : 0,
    })),
  };
}

describe("HomeMonitoringDashboard", () => {
  it("keeps current partial activity separate from last notification totals", () => {
    render(<HomeMonitoringDashboard initialOverview={overview(12)} initialHealth={HEALTH} runtimeHealth={null} />);
    expect(screen.getByRole("region", { name: "当前源端告警" })).toHaveTextContent("已知 FIRING 1 · 已知 PENDING 0 · UNKNOWN 目标 1 / 2");
    expect(screen.getByRole("region", { name: "当前源端告警" })).toHaveTextContent("不能解释为没有活动");
    expect(screen.getByText("末次通知 FIRING").closest("article")).toHaveTextContent("12");
  });
  it("shows durable unassigned notifications without presenting them as Incidents or current source truth", () => {
    const value = overview();
    value.counts.unassignedSignals = 1;
    value.unassignedSignals = [{ fingerprint: "0123456789abcdef", displayName: "Image pull failure",
      target: { kind: "Deployment", namespace: "incident-demo", name: "broken-image" },
      status: "FIRING", startsAt: "2026-09-03T01:00:00Z", endsAt: "2026-09-03T01:05:00Z",
      lastReceivedAt: "2026-09-03T01:10:00Z", reason: "awaiting_association" }];
    render(<HomeMonitoringDashboard initialOverview={value} initialHealth={HEALTH}
      runtimeHealth={{ status: "ok", diagnosis: { status: "unavailable", reason: "authentication_failed" } }} />);
    expect(screen.getByRole("heading", { name: "待归属告警信号（1）" })).toBeVisible();
    expect(screen.getByText(/最多展示最近 20 条；通知状态不代表源端当前状态/)).toBeVisible();
    expect(screen.getByText(/历史通知中的结束时间/)).toBeVisible();
    expect(screen.getByText(/合法告警仍会持久化/)).toBeVisible();
    expect(screen.queryByRole("link", { name: /broken-image/ })).toBeNull();
  });
  it("separates model availability from healthy monitoring and refreshes the displayed state", () => {
    const { rerender } = render(<HomeMonitoringDashboard initialHealth={HEALTH}
      initialOverview={overview()} runtimeHealth={{ status: "ok", diagnosis: {
        status: "unavailable", reason: "authentication_failed",
      } }} />);
    expect(screen.getByText(/模型认证失败/)).toBeVisible();
    expect(screen.getByRole("region", { name: "监控链路" })).toBeVisible();
    rerender(<HomeMonitoringDashboard initialHealth={HEALTH} initialOverview={overview()}
      runtimeHealth={{ status: "ok", diagnosis: { status: "ready", reason: null } }} />);
    expect(screen.queryByText(/模型诊断暂不可用/)).toBeNull();
  });
  it("renders real counts, family distribution, trend, and non-canvas summaries", () => {
    render(
      <HomeMonitoringDashboard
        runtimeHealth={{ status: "ok", diagnosis: { status: "ready", reason: null } }}
        initialHealth={HEALTH}
        initialOverview={overview()}
      />,
    );

    expect(screen.getByRole("region", { name: "监控链路" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "监控链路" })).toBeVisible();
    expect(screen.getByLabelText("Incident 状态统计")).toHaveTextContent(
      /已记录 Incident.*8末次通知 FIRING2诊断中3待审批4/,
    );
    expect(
      screen.getByLabelText("说明已记录 Incident 的统计口径"),
    ).toBeVisible();
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Runtime 已持久化的 Incident 累计数，含已结束的记录；不是当前未恢复的数量。",
    );
    expect(
      screen.getByRole("img", {
        name: "末次通知 FIRING 信号共 2 个，分布于 1 个故障族",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("list", { name: "末次通知 FIRING 信号故障族分布" }),
    ).toHaveTextContent("Image pull failure2");
    expect(
      screen.getByRole("img", {
        name: "最近 24 小时每小时新增与已结束的 Incident",
      }),
    ).toBeVisible();
    expect(
      screen.getByText(/新增 Incident 共 2 个；进入终态 1 次.*不代表已恢复/),
    ).toBeInTheDocument();
  });

  it("renders zero as an explicit empty distribution", () => {
    render(
      <HomeMonitoringDashboard
        runtimeHealth={{ status: "ok", diagnosis: { status: "ready", reason: null } }}
        initialHealth={HEALTH}
        initialOverview={overview(0)}
      />,
    );

    expect(
      screen.getByRole("img", { name: "没有末次通知为 FIRING 的信号" }),
    ).toBeVisible();
    expect(screen.getByText("没有末次通知为 FIRING 的信号。")).toBeVisible();
  });

  it("keeps the latest health check time visible when overview data is unavailable", () => {
    render(
      <HomeMonitoringDashboard
        runtimeHealth={{ status: "ok", diagnosis: { status: "ready", reason: null } }}
        initialHealth={HEALTH}
        initialOverview={null}
      />,
    );

    expect(screen.getByText(/最近更新/)).toHaveTextContent("2026");
    expect(screen.getByText(/暂时无法读取完整统计/)).toBeVisible();
  });

  it("refreshes the current route so all server-owned overview data is reloaded", async () => {
    const user = userEvent.setup();
    navigation.refresh.mockClear();

    render(
      <HomeMonitoringDashboard
        runtimeHealth={{ status: "ok", diagnosis: { status: "ready", reason: null } }}
        initialHealth={HEALTH}
        initialOverview={overview()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "刷新运行概览" }));

    expect(navigation.refresh).toHaveBeenCalledOnce();
  });
});
