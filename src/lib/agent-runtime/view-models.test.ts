import { describe, expect, it } from "vitest";

import { evidenceSummary, type EvidenceResponse } from "./view-models";

function evidence(
  evidenceKind: string,
  payload: Record<string, unknown>,
): EvidenceResponse {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    toolName: `get_${evidenceKind}`,
    evidenceKind,
    targetRef: {
      kind: "Deployment",
      namespace: "incident-demo",
      name: "broken-image",
    },
    observedAt: "2026-08-29T01:00:02Z",
    payload,
    truncated: false,
    redacted: false,
  };
}

describe("evidenceSummary", () => {
  it("summarizes workload replica facts", () => {
    expect(
      evidenceSummary(
        evidence("workload", {
          workload: {
            replicas: { desired: 3, updated: 3, ready: 0, available: 0 },
          },
        }),
      ),
    ).toBe("工作负载：可用副本 0/3 · 就绪 0 · 已更新 3");
  });

  it("summarizes pod phases, waiting reasons, and restarts", () => {
    expect(
      evidenceSummary(
        evidence("pods", {
          pods: [
            {
              phase: "Pending",
              containers: [
                {
                  restartCount: 0,
                  state: { status: "waiting", reason: "ErrImagePull" },
                },
              ],
            },
            {
              phase: "Pending",
              containers: [
                {
                  restartCount: 1,
                  state: { status: "waiting", reason: "ImagePullBackOff" },
                },
              ],
            },
            {
              phase: "Pending",
              containers: [
                {
                  restartCount: 0,
                  state: { status: "waiting", reason: "ImagePullBackOff" },
                },
              ],
            },
          ],
        }),
      ),
    ).toBe(
      "Pod：共 3 个 · Pending ×3 · ImagePullBackOff ×2 · ErrImagePull ×1 · 重启 1 次",
    );
  });

  it("summarizes Kubernetes event types and reasons", () => {
    expect(
      evidenceSummary(
        evidence("events", {
          events: [
            { type: "Warning", reason: "Failed" },
            { type: "Warning", reason: "Failed" },
            { type: "Normal", reason: "BackOff" },
          ],
        }),
      ),
    ).toBe(
      "Kubernetes 事件：共 3 条 · Warning ×2 · Normal ×1 · Failed ×2 · BackOff ×1",
    );
  });

  it("summarizes log availability without exposing log messages", () => {
    const item = evidence("container_logs", {
      containers: [
        {
          restartCount: 4,
          snapshots: [
            {
              source: "current",
              lines: [{ message: "sensitive current output" }],
            },
            {
              source: "previous",
              lines: [
                { message: "sensitive previous output" },
                { message: "another sensitive line" },
              ],
            },
          ],
        },
      ],
    });

    expect(evidenceSummary(item)).toBe(
      "容器日志：共 1 个容器 · 重启 4 次 · 当前日志 1 行 · 上次日志 2 行",
    );
    expect(evidenceSummary(item)).not.toContain("sensitive");
  });

  it("summarizes metric facts without inventing a risk direction", () => {
    expect(
      evidenceSummary(
        evidence("metrics", {
          result: {
            title: "镜像拉取失败 Pod",
            currentValue: 3,
            threshold: 1,
            riskDirection: "higher_is_worse",
            state: "ok",
          },
        }),
      ),
    ).toBe("指标：镜像拉取失败 Pod · 当前值 3 · 阈值 1");
  });

  it("keeps an abnormal metric query state visible when no value exists", () => {
    expect(
      evidenceSummary(
        evidence("metrics", {
          result: {
            title: "镜像拉取失败 Pod",
            currentValue: null,
            threshold: 1,
            riskDirection: "higher_is_worse",
            state: "no_data",
          },
        }),
      ),
    ).toBe("指标：镜像拉取失败 Pod · 无数据 · 阈值 1");
  });

  it("does not invent a static threshold for lower-is-worse metrics", () => {
    expect(
      evidenceSummary(
        evidence("metrics", {
          result: {
            title: "Deployment 可用副本",
            currentValue: 2,
            threshold: null,
            riskDirection: "lower_is_worse",
            state: "ok",
          },
        }),
      ),
    ).toBe("指标：Deployment 可用副本 · 当前值 2 · 风险方向 数值下降");
  });

  it("keeps a catalog-provided lower bound in a metric summary", () => {
    expect(
      evidenceSummary(
        evidence("metrics", {
          result: {
            title: "Service 就绪 Endpoint",
            currentValue: 0,
            threshold: 1,
            riskDirection: "lower_is_worse",
            state: "ok",
          },
        }),
      ),
    ).toBe("指标：Service 就绪 Endpoint · 当前值 0 · 阈值 1");
  });

  it("falls back to existing metadata for an unknown or malformed payload", () => {
    expect(evidenceSummary(evidence("pods", { notPods: [] }))).toBe(
      "pods · get_pods · Deployment · incident-demo/broken-image",
    );
    expect(evidenceSummary(evidence("custom", {}))).toBe(
      "custom · get_custom · Deployment · incident-demo/broken-image",
    );
  });
});
