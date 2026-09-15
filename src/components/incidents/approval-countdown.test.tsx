import { act, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRepairRunWaitingDetail, makeWaitingApprovalIncidentDetail } from "@/test/agent-runtime-fixtures";
import { ApprovalWindowProvider } from "./approval-countdown";
import { IncidentProgress } from "./incident-progress";
import { RepairActions } from "./repair-actions";

describe("approval countdown consumers", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-15T01:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(seconds: number) {
    const detail = makeRepairRunWaitingDetail();
    detail.selectedRun.waitingExpiresAt = new Date(Date.now() + seconds * 1000).toISOString();
    const onAction = vi.fn().mockResolvedValue(undefined);
    const tree = (next = detail) => <ApprovalWindowProvider detail={next}>
      <IncidentProgress detail={next} diagnosisDetail={makeWaitingApprovalIncidentDetail()} />
      <div id="repair-decision"><RepairActions detail={next} busy={false} refreshing={false} error={null} onAction={onAction} /></div>
    </ApprovalWindowProvider>;
    const view = render(tree());
    act(() => vi.advanceTimersByTime(0));
    return { ...view, detail, onAction, tree };
  }

  it("updates both anchors from one deadline, turns amber at 3 minutes, and disables open confirmation at zero", () => {
    const { onAction } = setup(185);
    expect(screen.getAllByText("剩余 03:05")).toHaveLength(2);
    expect(screen.getByRole("link", { name: /人工审批\s*剩余 03:05/ })).toHaveAttribute("href", "#repair-decision");
    fireEvent.click(screen.getByRole("button", { name: "审阅并批准" }));
    act(() => vi.advanceTimersByTime(5000));
    for (const clock of screen.getAllByText("剩余 03:00")) expect(clock).toHaveAttribute("data-urgency", "soon");
    act(() => vi.advanceTimersByTime(180000));
    expect(screen.getAllByText("批准期限已到")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "批准并执行" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "批准并执行" }));
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getAllByRole("listitem")[3]).toHaveAttribute("data-attention", "false");
    expect(screen.queryByText("流程已停止")).toBeNull();
  });

  it("recomputes after background clock jumps and drops the old deadline on Run changes", () => {
    const { detail, tree, rerender } = setup(900);
    vi.setSystemTime(new Date("2026-09-15T01:13:00Z"));
    fireEvent.focus(window);
    expect(screen.getAllByText("剩余 02:00")).toHaveLength(2);
    const next = structuredClone(detail);
    next.selectedRun.id = "99999999-9999-4999-8999-000000000001";
    next.selectedRun.waitingExpiresAt = "2026-09-15T01:28:00Z";
    rerender(tree(next));
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getAllByText("剩余 15:00")).toHaveLength(2);
    next.actions.approve = next.actions.reject = "proposal_expired";
    rerender(tree({ ...next }));
    expect(screen.getAllByText("提案已过期").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "审阅并批准" })).toBeDisabled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops displaying the approval timer after a decision, rather than expiring the execution", () => {
    const { detail, tree, rerender } = setup(10);
    const next = structuredClone(detail);
    next.selectedRun.status = "RUNNING";
    next.actions.approve = next.actions.reject = "not_applicable";
    rerender(tree(next));
    act(() => vi.advanceTimersByTime(11000));
    expect(screen.queryByText(/剩余 \d/)).toBeNull();
    expect(screen.queryByText("批准期限已到")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not render browser-clock dependent countdown text during SSR", () => {
    const { tree } = setup(900);
    expect(renderToString(tree())).not.toContain("剩余 15:00");
  });
});
