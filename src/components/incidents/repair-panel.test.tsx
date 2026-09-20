import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { parseIncidentDetailResponse } from "@/lib/agent-runtime/response-contracts";
import { makeWaitingApprovalIncidentDetail, makeRepairRunWaitingDetail, makeRecoveryDetail, makeRollbackRecoveryDetail } from "@/test/agent-runtime-fixtures";

import { RepairPanel } from "./repair-panel";

function detail() {
  return parseIncidentDetailResponse(makeWaitingApprovalIncidentDetail())!;
}

describe("read-only repair validation", () => {
  it.each(["recovered", "monitoring_unavailable"] as const)("separates the completed inverse from %s and displays before-image risks", (outcome) => {
    const value = parseIncidentDetailResponse(makeRollbackRecoveryDetail(outcome))!;
    render(<RepairPanel detail={value} pending={false} refreshError={null} />);
    expect(screen.getByText("ROLLED_BACK")).toBeVisible();
    expect(screen.getByText("批准的逆向写入已完成；恢复结果单独判定。")).toBeVisible();
    expect(screen.getByText(/原镜像可能正是故障来源/)).toHaveTextContent("不保证相同镜像字节或应用健康");
    expect(screen.getByText("原执行 before image")).toBeVisible();
    expect(screen.queryByText("上一 revision")).toBeNull();
    expect(screen.getByText(outcome === "recovered" ? "工作负载与告警恢复已验证" : "监控链路不可用，无法证明恢复")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看原修复运行" })).toHaveAttribute("href", `/incidents/${value.incident.id}?runId=${value.selectedRun.sourceRunId}`);
    expect(document.querySelector(".repair-verdict__icon")).toBeNull();
  });
  it.each([
    ["observing", "写入已确认，正在观察恢复"],
    ["recovered", "工作负载与告警恢复已验证"],
    ["monitoring_unavailable", "监控链路不可用，无法证明恢复"],
  ] as const)("shows %s independently from the passed dry-run", (outcome, label) => {
    const value = parseIncidentDetailResponse(makeRecoveryDetail(outcome))!;
    render(<RepairPanel detail={value} pending={false} refreshError={null} />);
    const verdict = screen.getByText(label).closest(".repair-verdict")!;
    expect(verdict).toHaveTextContent("不证明业务请求或数据正确性");
    expect(verdict.classList.contains("repair-verdict--failed")).toBe(outcome === "monitoring_unavailable");
    expect(screen.getAllByText("已通过")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /批准|执行|回滚/ })).toBeNull();
  });
  it.each([
    ["CLAIMED", "执行已领取，等待可信结果"],
    ["APPLIED", "API 写入已确认，恢复尚未验证"],
    ["UNKNOWN", "写入结果未知，目标保持占用"],
  ] as const)("displays %s from the ledger without a false not-executed label", (status, label) => {
    const value = parseIncidentDetailResponse(makeRepairRunWaitingDetail())!;
    value.selectedRun.status = status === "UNKNOWN" ? "FAILED" : "RUNNING";
    value.approval = {
      id: value.repair!.id, runId: value.selectedRun.id, proposalId: value.repair!.id,
      proposalDigest: value.repair!.digest, validationDigest: `sha256:${"a".repeat(64)}`,
      decision: "approve", actor: "sandbox-operator", decidedAt: "2026-09-13T01:00:00Z", expiresAt: "2026-09-13T01:15:00Z",
      execution: { id: value.repair!.id, status, startBefore: "2026-09-13T01:00:30Z", claimedAt: "2026-09-13T01:00:01Z", reportedAt: status === "APPLIED" ? "2026-09-13T01:00:02Z" : null, result: status === "APPLIED" ? { outcome: "APPLIED", error: null, receipt: { uid: value.repair!.targetUid, resourceVersion: "patched-rv", generation: 4, beforeGeneration: 3 } } : null, lateResult: null },
    };
    render(<RepairPanel detail={value} pending={false} refreshError={null} />);
    const panel = screen.getByRole("region", { name: "修复处置" });
    expect(panel).toHaveTextContent(label);
    expect(panel).not.toHaveTextContent("尚未批准或执行");
  });
  it("shows the recorded change, gates, impact and owner-bound Evidence without execution controls", async () => {
    const value = detail();
    render(<RepairPanel detail={value} pending={false} refreshError={null} />);
    const panel = screen.getByRole("region", { name: "修复建议" });
    expect(panel).toHaveTextContent("只读建议已保存，需重新准备后才能审批");
    expect(panel).toHaveTextContent("不证明应用已经恢复");
    expect(panel).toHaveTextContent(value.repair!.targetResourceVersion);
    expect(panel).toHaveTextContent(value.repair!.diff.before);
    expect(panel).toHaveTextContent(value.repair!.diff.after);
    expect(within(panel).getAllByText("已通过")).toHaveLength(4);
    const links = within(panel).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      value.repair!.evidenceIds.map((id) => `#evidence-${id}`),
    );
    expect(within(panel).queryAllByRole("button", { name: /批准|执行|拒绝|回滚|重试|Apply|Rollback/ })).toHaveLength(0);
    await userEvent.click(within(panel).getByText("目标约束与 JSON Patch"));
    expect(panel).toHaveTextContent(value.repair!.digest);
    expect(within(panel).getByLabelText("只读 JSON Patch")).toHaveTextContent('"op": "replace"');
  });

  it("shows the exact saved Patch read-only without redundant copy or expand controls", async () => {
    const value = detail();
    const json = JSON.stringify(value.repair!.patch, null, 2);
    const user = userEvent.setup();
    render(<RepairPanel detail={value} pending={false} refreshError={null} />);
    const panel = screen.getByRole("region", { name: "修复建议" });
    await user.click(within(panel).getByText("目标约束与 JSON Patch"));
    expect(within(panel).getByLabelText("只读 JSON Patch").textContent).toBe(json);
    expect(panel.querySelector("input, textarea, [contenteditable]")).toBeNull();
    expect(within(panel).queryByRole("button", { name: /复制 JSON|展开 JSON/ })).toBeNull();
  });

  it.each([
    ["repair_schema_invalid", "Schema 校验未通过", ["未通过", "未执行", "未执行", "未执行"]],
    ["repair_policy_denied", "Policy 校验未通过", ["无独立记录", "未通过", "未执行", "未执行"]],
    ["repair_diff_invalid", "Diff 校验未通过", ["无独立记录", "无独立记录", "未通过", "未执行"]],
  ] as const)("shows %s without inventing passed gates", (code, label, outcomes) => {
    const value = detail();
    value.repair = null;
    value.selectedRun.status = "FAILED";
    value.selectedRun.error = { code, retryable: false };
    render(<RepairPanel detail={value} pending={false} refreshError={null} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    // No proposal means no suggestion to read; the section reports the repair.
    expect(screen.getByRole("heading", { name: "受控修复" })).toBeVisible();
    expect(screen.getByText(/第 1 次运行 · 准备未通过/)).toBeVisible();
    expect(screen.queryByText("已通过")).not.toBeInTheDocument();
    const gates = screen.getByRole("list", { name: "修复验证门禁" });
    for (const [index, name] of ["Schema", "Policy", "Diff", "Server-side dry-run"].entries()) {
      const row = within(gates).getByText(name).closest("li")!;
      expect(row).toHaveTextContent(outcomes[index]);
    }
    expect(gates.querySelector("time")).toBeNull();
    expect(screen.queryByText("目标约束与 JSON Patch")).not.toBeInTheDocument();
  });

  it.each([
    ["stale_resource", "目标状态已变化"],
    ["patch_validator_admission_denied", "准入检查拒绝"],
    ["patch_validator_timeout", "验证超时"],
    ["patch_validator_permission_denied", "验证权限不足"],
    ["patch_validator_upstream_failed", "验证服务暂不可用"],
    ["patch_validator_contract_invalid", "验证响应不符合契约"],
    ["patch_validator_authentication_failed", "验证通信认证失败"],
    ["patch_validator_replay_rejected", "验证请求重放被拒绝"],
  ] as const)("preserves %s as a failed dry-run", (code, label) => {
    const raw = makeWaitingApprovalIncidentDetail();
    raw.selectedRun.status = "FAILED";
    raw.selectedRun.error = { code, retryable: false };
    raw.repair!.validation = {
      outcome: "failed",
      checkedAt: raw.repair!.validation.checkedAt,
      error: { code, retryable: false },
    };
    const value = parseIncidentDetailResponse(raw)!;
    render(<RepairPanel detail={value} pending={false} refreshError={null} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getAllByText("已通过")).toHaveLength(3);
    const gates = screen.getByRole("list", { name: "修复验证门禁" });
    expect(within(gates).getByText("Server-side dry-run").closest("li")).toHaveTextContent("未通过");
    for (const name of ["Schema", "Policy", "Diff"]) {
      expect(within(gates).getByText(name).closest("li")).toHaveTextContent("已通过");
    }
    expect(screen.queryByText("已通过验证，尚未批准或执行")).not.toBeInTheDocument();
  });

  it("does not borrow the latest Incident status for a historical Run", () => {
    const value = detail();
    value.incident.status = "FAILED";
    render(<RepairPanel detail={value} pending={false} refreshError={null} />);
    expect(screen.getByText("只读建议已保存，需重新准备后才能审批")).toBeInTheDocument();
  });

  it("distinguishes no proposal, pending snapshot and unavailable detail", () => {
    const value = detail();
    value.repair = null;
    const view = render(<RepairPanel detail={value} pending={false} refreshError={null} />);
    expect(screen.getByText("本次没有可执行的受控修复。")).toBeInTheDocument();
    expect(screen.getByText(/Runtime 未在本次证据中确认适用的受控动作/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "修复验证门禁" })).not.toBeInTheDocument();
    view.rerender(<RepairPanel detail={value} pending refreshError={null} />);
    expect(screen.getByText("正在读取持久化的修复验证结果…")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "修复验证门禁" })).not.toBeInTheDocument();
    view.rerender(<RepairPanel detail={detail()} pending refreshError="详情暂不可用" />);
    expect(screen.getByText("修复详情暂不可用")).toBeInTheDocument();
    expect(screen.queryByText("已通过验证，尚未批准或执行")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "修复验证门禁" })).not.toBeInTheDocument();
  });
});
