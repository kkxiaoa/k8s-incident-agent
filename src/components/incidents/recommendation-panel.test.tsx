import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeWaitingApprovalIncidentDetail } from "@/test/agent-runtime-fixtures";

import { EvidenceList } from "./evidence-card";
import { RecommendationPanel } from "./recommendation-panel";

function diagnosis() {
  return makeWaitingApprovalIncidentDetail().diagnosis!;
}

describe("recommendation delivery", () => {
  it("reads out every field with its Evidence and never offers an action", () => {
    const detail = makeWaitingApprovalIncidentDetail();
    render(
      <RecommendationPanel
        diagnosis={detail.diagnosis}
        evidence={detail.evidence}
      />,
    );

    const panel = screen.getByRole("region", { name: "处置建议" });
    const [item] = within(panel).getAllByRole("listitem");
    expect(
      within(panel).getByRole("heading", {
        name: "对照 rollout 历史确认当前镜像是否为误发布",
      }),
    ).toBeVisible();
    for (const label of ["目的", "前置条件", "风险", "验证方向"]) {
      expect(within(item).getByText(label)).toBeVisible();
    }
    expect(item).toHaveTextContent("若上一版本同样有问题，回退不能恢复");
    expect(
      within(item).getByRole("link", { name: /查看证据/ }),
    ).toHaveAttribute("href", `#evidence-${detail.evidence[0]!.id}`);
    expect(panel).toHaveTextContent("建议是诊断的输出，不是执行许可");
    expect(within(panel).queryByRole("button")).toBeNull();
  });

  it("marks a Run recorded before recommendations apart from one that proposed none", () => {
    const before = { ...diagnosis(), recommendations: null };
    const view = render(<RecommendationPanel diagnosis={before} />);
    expect(screen.getByText(/记录于处置建议之前/)).toBeVisible();
    expect(screen.getByText(/不会用其他运行的建议补齐/)).toBeVisible();

    view.rerender(
      <RecommendationPanel diagnosis={{ ...diagnosis(), recommendations: [] }} />,
    );
    expect(screen.getByText("本次诊断没有提出处置建议。")).toBeVisible();
    expect(screen.queryByText(/记录于处置建议之前/)).toBeNull();
  });

  it("attributes a referenced Run's advice to that Run and anchors it to that Run's Evidence", () => {
    const detail = makeWaitingApprovalIncidentDetail();
    render(
      <>
        <RecommendationPanel
          diagnosis={detail.diagnosis}
          evidence={detail.evidence}
          referenceRunAttempt={2}
          runCompletedAt={detail.selectedRun.completedAt}
        />
        <EvidenceList evidence={detail.evidence} sourceRunAttempt={2} />
      </>,
    );

    expect(screen.getByText("引用第 2 次诊断运行")).toBeVisible();
    expect(screen.getByText(/运行结束于/)).toBeVisible();
    expect(
      screen.getByText(/历史建议，不代表重新诊断或目标当前状态/),
    ).toBeVisible();
    const anchor = screen
      .getByRole("link", { name: /查看证据/ })
      .getAttribute("href")!;
    expect(anchor).toBe(`#source-evidence-${detail.evidence[0]!.id}`);
    // The anchor must land on a card this page actually rendered.
    expect(document.querySelector(anchor)).not.toBeNull();
  });

  it("renders nothing when the Run kept no diagnosis to attach advice to", () => {
    const { container } = render(<RecommendationPanel diagnosis={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
