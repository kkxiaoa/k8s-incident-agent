import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeRecoveryDetail, makeRepairRunWaitingDetail, makeWaitingApprovalIncidentDetail } from "@/test/agent-runtime-fixtures";
import { RepairActions } from "./repair-actions";

function setup(detail = makeRepairRunWaitingDetail()) {
  const onAction = vi.fn().mockResolvedValue(undefined);
  const props = { detail, busy: false, refreshing: false, error: null, onAction };
  const view = render(<RepairActions {...props} />);
  return { ...view, props, onAction, user: userEvent.setup() };
}

describe("repair lifecycle actions", () => {
  it.each([
    ["PENDING", "等待执行", "等待执行器自动领取", "领取后仍须通过执行前检查"],
    ["CLAIMED", "等待执行结果", "正在等待执行结果回报", "领取不代表写入成功"],
  ] as const)("explains automatic progression for %s without another execution action", (status, heading, message, boundary) => {
    const detail = makeRecoveryDetail("observing");
    detail.incident.status = "APPLYING";
    detail.verification = null;
    const execution = detail.approval!.execution!;
    execution.status = status;
    execution.claimedAt = status === "PENDING" ? null : execution.claimedAt;
    execution.reportedAt = null;
    execution.result = null;
    setup(detail);
    expect(screen.getByRole("heading", { name: heading })).toBeVisible();
    expect(screen.getByText(new RegExp(message))).toHaveTextContent("无需再次操作");
    expect(screen.getByText(new RegExp(message))).toHaveTextContent(boundary);
    expect(screen.queryByRole("heading", { name: "下一步" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each([
    ["authentication_required", "登录后可审阅并批准"],
    ["proposal_expired", "提案等待期限已失效"],
    ["target_occupied", "另一次执行仍占用此目标"],
  ] as const)("explains disabled approval on hover and keyboard focus: %s", async (reason, message) => {
    const detail = makeRepairRunWaitingDetail();
    detail.actions.approve = reason;
    const { user, onAction } = setup(detail);
    const button = screen.getByRole("button", { name: "审阅并批准" });
    expect(button).toBeDisabled();
    await user.hover(button);
    expect(screen.getByRole("tooltip")).toHaveTextContent(message);
    await user.unhover(button);
    await user.tab();
    expect(screen.getByRole("group", { name: "审阅并批准" })).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent(message);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.click(button);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("explains a failed state read without presenting it as a submission in progress", async () => {
    const { props, rerender, user, onAction } = setup();
    rerender(<RepairActions {...props} busy busyReason="无法核对最新保存状态，请检查最新状态后再操作。" />);
    await user.click(screen.getByRole("button", { name: "审阅并批准" }));
    const submit = screen.getByRole("button", { name: "批准并执行" });
    expect(submit).toBeDisabled();
    await user.hover(submit);
    expect(screen.getByRole("tooltip")).toHaveTextContent("无法核对最新保存状态");
    expect(onAction).not.toHaveBeenCalled();
  });

  it.each([
    ["审阅并批准", "批准并执行"],
    ["拒绝提案", "确认拒绝提案"],
    ["调整提案", "生成新提案"],
  ])("allows local %s during refresh but never submits before the saved state is checked", async (openLabel, submitLabel) => {
    const { props, rerender, user, onAction } = setup();
    rerender(<RepairActions {...props} busy refreshing />);
    await user.click(screen.getByRole("button", { name: openLabel }));
    const submit = screen.getByRole("button", { name: submitLabel });
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(onAction).not.toHaveBeenCalled();
    rerender(<RepairActions {...props} />);
    expect(submit).toBeEnabled();
  });

  it("can only prepare a historical diagnostic proposal, never approve it", async () => {
    const detail = makeWaitingApprovalIncidentDetail();
    const { user, onAction } = setup(detail);
    expect(screen.queryByRole("button", { name: "审阅并批准" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "准备修复提案" }));
    expect(onAction).toHaveBeenCalledWith({ action: "prepare", request: detail.actions.preparationSource });
  });

  it("requires confirmation of the exact immutable proposal", async () => {
    const { props, user, onAction } = setup();
    await user.click(screen.getByRole("button", { name: "审阅并批准" }));
    const confirmation = screen.getByRole("group", { name: "确认审阅并批准" });
    expect(confirmation).toHaveTextContent(props.detail.repair!.currentImage);
    expect(confirmation).toHaveTextContent(props.detail.repair!.replacementImage);
    expect(confirmation).toHaveTextContent(props.detail.repair!.digest);
    expect(onAction).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole("button", { name: "批准并执行" }));
    expect(onAction).toHaveBeenCalledWith({ action: "approve", request: {
      runId: props.detail.selectedRun.id, proposalId: props.detail.repair!.id,
      proposalDigest: props.detail.repair!.digest, decision: "approve",
    } });
  });

  it("keeps int64 history revisions exact and sends no arbitrary image or patch", async () => {
    const detail = makeRepairRunWaitingDetail();
    detail.actions.historyCandidates[0].revision = "9223372036854775806";
    const { user, onAction } = setup(detail);
    await user.click(screen.getByRole("button", { name: "调整提案" }));
    await user.click(screen.getByRole("radio", { name: /改用其他历史镜像/ }));
    screen.getByRole("combobox", { name: "证据中的历史镜像" }).focus();
    await user.keyboard("{End}{Enter}");
    await user.click(screen.getByRole("button", { name: "生成新提案" }));
    expect(onAction).toHaveBeenCalledWith({ action: "edit", request: {
      ...detail.actions.preparationSource, replacesRunId: detail.selectedRun.id,
      selection: { revision: "9223372036854775806", replicaSetUid: "previous-rs-uid" },
    } });
  });

  it("prepares rollback with the applied source and requires another approval", async () => {
    const detail = makeRecoveryDetail("monitoring_unavailable");
    const { user, onAction } = setup(detail);
    await user.click(screen.getByRole("button", { name: "准备回滚提案" }));
    expect(screen.getByText(/原镜像可能正是故障来源/)).toBeVisible();
    expect(onAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "生成回滚提案" }));
    expect(onAction).toHaveBeenCalledWith({ action: "rollback", request: {
      sourceRunId: detail.selectedRun.id, sourceExecutionId: detail.approval!.execution!.id,
    } });
  });

  it("refreshes failed rollback preparation using the original apply source", async () => {
    const detail = makeRepairRunWaitingDetail();
    detail.selectedRun.operation = "rollback";
    detail.selectedRun.status = "FAILED";
    detail.repair = null;
    detail.actions.edit = "not_applicable";
    detail.actions.approve = detail.actions.reject = "not_applicable";
    detail.actions.preparationSource = { sourceRunId: "22222222-2222-4222-8222-222222222222", sourceExecutionId: "88888888-8888-4888-8888-888888888888" };
    const { user, onAction } = setup(detail);
    await user.click(screen.getByRole("button", { name: "重新生成提案" }));
    await user.click(screen.getByRole("button", { name: "生成新提案" }));
    expect(onAction).toHaveBeenCalledWith({ action: "refresh", request: detail.actions.preparationSource });
  });

  it("disables stale confirmation after another tab acts on a failed read", async () => {
    const { props, rerender, user, onAction } = setup();
    await user.click(screen.getByRole("button", { name: "审阅并批准" }));
    const detail = structuredClone(props.detail);
    detail.actions.approve = detail.actions.reject = "proposal_expired";
    rerender(<RepairActions {...props} detail={detail} busy error="持久化详情暂不可用" />);
    expect(screen.getByRole("button", { name: "批准并执行" })).toBeDisabled();
    expect(screen.getByText(/这不是登录会话过期/)).toBeVisible();
    expect(screen.getByText("提案已过期。请重新生成提案，完成最新检查后再审批。")).toBeVisible();
    expect(screen.queryByText(/认可这次变更可审阅并批准/)).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("持久化详情暂不可用");
    expect(onAction).not.toHaveBeenCalled();
  });
});
