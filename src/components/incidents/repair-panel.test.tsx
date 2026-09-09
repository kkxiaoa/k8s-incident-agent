import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { parseIncidentDetailResponse } from "@/lib/agent-runtime/response-contracts";
import { makeWaitingApprovalIncidentDetail } from "@/test/agent-runtime-fixtures";

import { RepairPanel } from "./repair-panel";

function detail() {
  return parseIncidentDetailResponse(makeWaitingApprovalIncidentDetail())!;
}

describe("read-only repair validation", () => {
  it("shows the recorded change, gates, impact and owner-bound Evidence without execution controls", async () => {
    const value = detail();
    render(<RepairPanel detail={value} pending={false} refreshError={null} />);
    const panel = screen.getByRole("region", { name: "修复验证" });
    expect(panel).toHaveTextContent("已通过验证，尚未批准或执行");
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

  it("copies the exact saved Patch from the inline and expanded read-only views", async () => {
    const value = detail();
    const json = JSON.stringify(value.repair!.patch, null, 2);
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<RepairPanel detail={value} pending={false} refreshError={null} />);
    const panel = screen.getByRole("region", { name: "修复验证" });
    await user.click(within(panel).getByText("目标约束与 JSON Patch"));
    expect(within(panel).getByLabelText("只读 JSON Patch").textContent).toBe(json);
    await user.click(within(panel).getByRole("button", { name: "复制 JSON" }));
    expect(writeText).toHaveBeenLastCalledWith(json);
    expect(within(panel).getByRole("button", { name: "JSON 已复制" })).toBeVisible();

    await user.click(within(panel).getByRole("button", { name: "展开 JSON" }));
    const dialog = screen.getByRole("dialog", { name: "JSON Patch" });
    expect(dialog.querySelector("code")?.textContent).toBe(json);
    expect(dialog.querySelector("input, textarea, [contenteditable]")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "复制 JSON" }));
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith(json);
    expect(within(dialog).getByRole("status")).toHaveTextContent("JSON 已复制");
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(dialog).not.toHaveAttribute("open");
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
    ["stale_resource", "目标版本已变化"],
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
    expect(screen.getByText("已通过验证，尚未批准或执行")).toBeInTheDocument();
  });

  it("distinguishes no proposal, pending snapshot and unavailable detail", () => {
    const value = detail();
    value.repair = null;
    const view = render(<RepairPanel detail={value} pending={false} refreshError={null} />);
    expect(screen.getByText("本次运行未生成修复提案。")).toBeInTheDocument();
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
