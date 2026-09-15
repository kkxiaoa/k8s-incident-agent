"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { IncidentDetailView } from "@/lib/agent-runtime/response-contracts";

type ApprovalWindow = { label: string; urgency: "normal" | "soon" | "elapsed"; reached: boolean };
const ApprovalWindowContext = createContext<ApprovalWindow | null>(null);

export function ApprovalWindowProvider({ detail, children }: { detail: IncidentDetailView; children: ReactNode }) {
  const { selectedRun: run } = detail;
  const expired = run.endReason === "expired" || detail.actions.approve === "proposal_expired";
  const deadline = run.status === "WAITING_APPROVAL" && !detail.approval && !run.endReason
    ? run.waitingExpiresAt ?? null : null;
  const key = `${run.id}:${deadline}`;
  const [clock, setClock] = useState<{ key: string; seconds: number } | null>(null);

  useEffect(() => {
    if (!deadline || expired) return;
    const expiresAt = Date.parse(deadline);
    const update = () => setClock({ key, seconds: Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) });
    const initial = window.setTimeout(update, 0);
    const timer = window.setInterval(update, 1000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [deadline, expired, key]);

  const seconds = clock?.key === key ? clock.seconds : null;
  const value: ApprovalWindow | null = expired
    ? { label: "提案已过期", urgency: "elapsed", reached: true }
    : deadline ? {
      label: seconds === null ? "等待决定" : seconds === 0 ? "批准期限已到"
        : `剩余 ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`,
      urgency: seconds === 0 ? "elapsed" : seconds !== null && seconds <= 180 ? "soon" : "normal",
      reached: seconds === 0,
    } : null;
  return <ApprovalWindowContext value={value}>{children}</ApprovalWindowContext>;
}

export function ApprovalCountdown() {
  const window = useContext(ApprovalWindowContext);
  return <span className="approval-countdown" data-urgency={window?.urgency ?? "normal"} aria-live="off">{window?.label ?? "等待决定"}</span>;
}

export function useApprovalDeadlineReached() {
  return useContext(ApprovalWindowContext)?.reached ?? false;
}
