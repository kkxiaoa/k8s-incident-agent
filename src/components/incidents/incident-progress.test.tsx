import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeIncidentDetail, makeRecoveryDetail, makeRepairRunWaitingDetail, makeRollbackRecoveryDetail, makeWaitingApprovalIncidentDetail } from "@/test/agent-runtime-fixtures";
import { IncidentProgress } from "./incident-progress";

describe("selected Run progress", () => {
  it("locates the diagnostic section without claiming an unavailable source succeeded", () => {
    const detail = makeRepairRunWaitingDetail();
    detail.selectedRun.sourceRunId = "22222222-2222-4222-8222-222222222222";
    render(<IncidentProgress detail={detail} />);
    const steps = screen.getAllByRole("listitem");
    expect(within(steps[1]).getByRole("link")).toHaveAttribute("href", "#diagnosis-heading");
    expect(steps[1]).toHaveTextContent("来源记录加载失败");
    expect(steps[1]).toHaveAttribute("data-attention", "true");
    expect(steps[1].querySelector(".incident-progress__mark circle")).toBeNull();
    expect(steps[1].querySelector(".incident-progress__mark")).not.toHaveTextContent("2");
    expect(steps[1]).toHaveAttribute("data-done", "false");
    expect(within(steps[3]).getByRole("link")).toHaveAttribute("aria-current", "step");
    expect(steps[4]).toHaveTextContent("尚未执行");
  });

  it.each(["diagnosed", "insufficient_evidence"] as const)("uses the source outcome %s, not the repair's passed checks", (outcome) => {
    const source = makeWaitingApprovalIncidentDetail();
    source.diagnosis!.outcome = outcome;
    render(<IncidentProgress detail={makeRepairRunWaitingDetail()} diagnosisDetail={source} />);
    const steps = screen.getAllByRole("listitem");
    expect(steps[1]).toHaveAttribute("data-done", String(outcome === "diagnosed"));
    expect(steps[1]).toHaveTextContent("引用第 1 次运行");
    expect(steps[2]).toHaveAttribute("data-done", "true");
    expect(steps[2]).toHaveTextContent("检查记录已保存");
  });

  it("does not animate an expired waiting proposal", () => {
    const detail = makeRepairRunWaitingDetail();
    detail.actions.approve = "proposal_expired";
    render(<IncidentProgress detail={detail} />);
    expect(screen.getByText("提案已过期")).not.toHaveClass("text-shimmer");
  });

  it.each(["observing", "recovered", "monitoring_unavailable"] as const)("keeps rollback write distinct from %s recovery", (outcome) => {
    render(<IncidentProgress detail={makeRollbackRecoveryDetail(outcome)} />);
    const last = screen.getAllByRole("listitem")[4];
    expect(last).toHaveTextContent(outcome === "observing" ? "恢复观察中" : outcome === "recovered" ? "恢复已验证" : "未能证明恢复");
    expect(last).toHaveAttribute("data-attention", String(outcome === "monitoring_unavailable"));
    expect(last).toHaveAttribute("data-done", String(outcome === "recovered"));
    expect(last).toHaveAttribute("data-running", String(outcome === "observing"));
    if (outcome === "observing") expect(screen.getByText("恢复观察中")).toHaveClass("text-shimmer");
    if (outcome === "monitoring_unavailable") expect(screen.queryByText("恢复已验证")).toBeNull();
  });

  it("shows unknown execution without inventing recovery", () => {
    const detail = makeRecoveryDetail("observing");
    detail.approval!.execution!.status = "UNKNOWN";
    detail.verification = null;
    detail.selectedRun.status = "FAILED";
    render(<IncidentProgress detail={detail} />);
    expect(screen.getByText("结果未知")).not.toHaveClass("text-shimmer");
    expect(screen.queryByText("恢复已验证")).toBeNull();
  });

  it("keeps all five stages while a referenced diagnosis is loading, without marking it successful", () => {
    render(<IncidentProgress detail={makeRepairRunWaitingDetail()} diagnosisLoading />);
    const steps = screen.getAllByRole("listitem");
    expect(steps).toHaveLength(5);
    expect(steps[1]).toHaveAttribute("data-running", "true");
    expect(steps[1]).toHaveAttribute("data-attention", "false");
    expect(steps[1]).toHaveAttribute("data-done", "false");
    expect(screen.getByText("读取来源诊断中")).toHaveClass("text-shimmer");
    expect(steps[3]).toHaveAttribute("data-running", "false");
  });

  it.each(["QUEUED", "RUNNING", "FAILED"] as const)("distinguishes diagnostic %s from an unstarted or successful step", (status) => {
    const detail = makeIncidentDetail();
    detail.selectedRun.status = status;
    render(<IncidentProgress detail={detail} />);
    const steps = screen.getAllByRole("listitem");
    expect(steps[1]).toHaveAttribute("data-running", String(status === "RUNNING"));
    expect(steps[1]).toHaveAttribute("data-attention", String(status === "FAILED"));
    expect(steps[2]).toHaveAttribute("data-done", "false");
    expect(steps[2]).toHaveAttribute("data-attention", "false");
  });

  it("does not style a pending execution as processing just because its Run is RUNNING", () => {
    const detail = makeRecoveryDetail("observing");
    detail.approval!.execution!.status = "PENDING";
    detail.verification = null;
    render(<IncidentProgress detail={detail} />);
    expect(screen.getAllByRole("listitem")[4]).toHaveAttribute("data-running", "false");
    expect(screen.getByText("等待执行领取")).not.toHaveClass("text-shimmer");
  });
});
