"use client";

import { useId, useState } from "react";
import { LocalTimestamp } from "@/components/local-timestamp";
import { ChoiceDropdown } from "@/components/ui/choice-dropdown";
import { ShimmerText } from "@/components/ui/shimmer-text";
import { ActionButton } from "@/components/ui/action-button";
import { ApprovalCountdown, useApprovalDeadlineReached } from "./approval-countdown";
import type { ApprovalRequest, IncidentDetailView, RepairRunRequest } from "@/lib/agent-runtime/response-contracts";
import { ACTION_UNAVAILABLE_LABELS } from "@/lib/agent-runtime/view-models";

type Action = "prepare" | "refresh" | "edit" | "approve" | "reject" | "rollback" | "withdraw";
export type RepairActionCommand =
  | { action: "prepare" | "refresh" | "edit" | "rollback"; request: RepairRunRequest }
  | { action: "approve" | "reject"; request: ApprovalRequest }
  | { action: "withdraw"; request: { runId: string } };

const LABELS: Record<Action, string> = {
  prepare: "准备修复提案", refresh: "按当前方案重新检查", edit: "改用其他历史镜像",
  approve: "审阅并批准", reject: "拒绝提案", rollback: "准备回滚提案",
  withdraw: "撤回我的申请",
};

export function RepairActions({ detail, busy, busyReason, refreshing, onAction, error }: {
  detail: IncidentDetailView;
  busy: boolean;
  busyReason?: string;
  refreshing: boolean;
  onAction: (command: RepairActionCommand) => Promise<void>;
  error: string | null;
}) {
  const { actions, repair, selectedRun: run } = detail;
  const executionStatus = detail.approval?.execution?.status;
  const deadlineReached = useApprovalDeadlineReached();
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [selectedUid, setSelectedUid] = useState("");
  const selectId = useId();
  const candidate = actions.historyCandidates.find((item) => item.replicaSetUid === selectedUid);
  const visible = (Object.keys(LABELS) as Action[]).filter((action) => actions[action] !== undefined && actions[action] !== "not_applicable");
  const reasons = [...new Set(visible.map((action) => actions[action]).filter((reason) => reason !== undefined && reason !== null))];
  const canAdjust = visible.includes("refresh") || visible.includes("edit");
  const adjustment = confirming === "refresh" || confirming === "edit";
  const pendingReason = busyReason ?? (refreshing ? "正在核对最新状态，请稍候。" : "正在提交操作并读取保存结果，请勿重复提交。");
  function unavailableReason(action: Action): string | undefined {
    const reason = actions[action];
    if (reason === "authentication_required") return `登录后可${LABELS[action]}。`;
    if (reason) return ACTION_UNAVAILABLE_LABELS[reason];
    if (deadlineReached && (action === "approve" || action === "reject")) return ACTION_UNAVAILABLE_LABELS.proposal_expired;
    if (busy || refreshing) return pendingReason;
    return undefined;
  }

  async function submit(action: Action) {
    if (busy || refreshing || actions[action] !== null || (deadlineReached && (action === "approve" || action === "reject"))) return;
    if (action === "approve" || action === "reject") {
      if (repair === null) return;
      await onAction({ action, request: {
        runId: run.id, proposalId: repair.id, proposalDigest: repair.digest, decision: action,
      } });
    } else if (action === "withdraw") {
      await onAction({ action, request: { runId: run.id } });
    } else {
      const source = action === "rollback" && detail.approval?.execution
        ? { sourceRunId: run.id, sourceExecutionId: detail.approval.execution.id }
        : actions.preparationSource;
      if (source === null || (action === "edit" && !candidate)) return;
      await onAction({ action, request: {
        ...source,
        ...(action === "edit" && candidate ? { selection: { revision: candidate.revision, replicaSetUid: candidate.replicaSetUid } }
          : action === "refresh" && run.selection ? { selection: run.selection } : {}),
        ...(run.status === "WAITING_APPROVAL" ? { replacesRunId: run.id } : {}),
      } });
    }
    setConfirming(null);
  }

  return (
    <div className="repair-actions" aria-label="修复操作">
      <div className="repair-actions__heading">
        <div><h3>{confirming ? "确认操作" : executionStatus === "PENDING" ? "等待执行" : executionStatus === "CLAIMED" ? "等待执行结果" : run.status === "WAITING_APPROVAL" ? "人工审批" : "下一步"}</h3><p>{run.kind === "diagnosis"
          ? "诊断建议不会直接执行。准备时重新读取集群并生成新的提案。"
          : executionStatus === "PENDING" ? "已完成批准，等待执行器自动领取，无需再次操作。此时不能修改提案或撤回批准；领取后仍须通过执行前检查。"
          : executionStatus === "CLAIMED" ? "执行器已领取，正在等待执行结果回报，无需再次操作。领取不代表写入成功，恢复情况将在写入确认后单独验证。"
          : executionStatus === "UNKNOWN" ? "结果未知，目标保持占用。停止后续写入，需另行核查。"
          : actions.approve === "proposal_expired" || run.endReason === "expired" ? "提案已过期。请重新生成提案，完成最新检查后再审批。"
          : deadlineReached ? "批准期限已到，审批入口已停用。请检查最新状态。"
          : run.status === "WAITING_APPROVAL" ? "认可这次变更可审阅并批准；需要修改时先调整提案，重新检查后再审批。"
          : "可用操作由当前保存的状态决定；重新生成的提案仍需单独审批。"}</p></div>
        {run.status === "WAITING_APPROVAL" && run.waitingExpiresAt ? <ApprovalCountdown /> : null}
      </div>
      {run.status === "WAITING_APPROVAL" && run.waitingExpiresAt ? <p>批准截止时间：<LocalTimestamp timestamp={run.waitingExpiresAt} /></p> : null}
      {!confirming ? <div className="repair-actions__buttons">
        {visible.filter((action) => action !== "refresh" && action !== "edit").map((action) => <ActionButton key={action} type="button"
          disabledReason={unavailableReason(action)}
          className={action === "approve" || action === "prepare" ? "primary-button" : "secondary-button"}
          disabled={busy || refreshing || actions[action] !== null || (deadlineReached && (action === "approve" || action === "reject"))}
          onClick={() => action === "prepare" ? void submit(action) : setConfirming(action)}>{LABELS[action]}</ActionButton>)}
        {canAdjust ? <ActionButton type="button" className="secondary-button"
          disabledReason={busy || refreshing ? pendingReason : unavailableReason(actions.refresh === "not_applicable" ? "edit" : "refresh")}
          disabled={busy || refreshing || (actions.refresh !== null && actions.edit !== null)}
          onClick={() => setConfirming(actions.refresh === null ? "refresh" : "edit")}>{run.status === "WAITING_APPROVAL" && actions.approve !== "proposal_expired" ? "调整提案" : "重新生成提案"}</ActionButton> : null}
      </div> : null}
      {reasons.map((reason) => <p className="repair-actions__reason" key={reason}>{ACTION_UNAVAILABLE_LABELS[reason]}</p>)}
      {actions.approve === "authentication_required" ? <p><a href="/login">登录</a>后可审批这份提案。</p> : null}
      {refreshing || busy ? <p role="status"><ShimmerText>{refreshing ? "正在核对持久化状态，操作暂不可用…" : "正在提交并读取保存结果…"}</ShimmerText></p> : null}
      {error ? <p className="page-alert" role="alert">{error}</p> : null}
      {confirming ? <div className={`repair-confirmation${confirming === "approve" || confirming === "rollback" ? " repair-confirmation--caution" : ""}`}
        role="group" aria-label={adjustment ? "调整提案" : `确认${LABELS[confirming]}`}>
        <h4>{adjustment ? "调整后生成新提案" : confirming === "approve" ? "确认这一次变更" : LABELS[confirming]}</h4>
        {adjustment ? <fieldset className="repair-adjustment"><legend>选择调整方式</legend>
          {(["refresh", "edit"] as const).filter((action) => actions[action] !== "not_applicable").map((action) => <label key={action}>
            <input type="radio" name={selectId} value={action} checked={confirming === action}
              disabled={busy || refreshing || actions[action] !== null} onChange={() => setConfirming(action)} />
            <span>{LABELS[action]}<small>{action === "refresh" ? "保留选择，重新核对目标与检查结果。" : "从已观测到的历史修订中选择镜像，不支持自由输入。"}</small></span>
          </label>)}
        </fieldset> : null}
        {confirming === "edit" ? <>
          <label id={`${selectId}-label`} htmlFor={selectId}>证据中的历史镜像</label>
          <ChoiceDropdown id={selectId} labelId={`${selectId}-label`} value={selectedUid} onChange={setSelectedUid}
            disabled={busy || refreshing || actions.edit !== null}
            options={[{ value: "", label: "请选择历史修订" }, ...actions.historyCandidates.map((item) => ({ value: item.replicaSetUid, label: `修订 ${item.revision} · ${item.image}` }))]} />
          <p>只提交修订与 ReplicaSet 身份，服务端重新读取候选；不会直接提交镜像或 Patch。</p>
        </> : null}
        {confirming === "approve" && repair ? <>
          <dl className="repair-confirmation__facts">
            <div><dt>目标与容器</dt><dd>{repair.target.cluster} / {repair.target.namespace} / {repair.target.kind} {repair.target.name} · {repair.containerName}</dd></div>
            <div><dt>从</dt><dd><code>{repair.currentImage}</code></dd></div>
            <div><dt>改为</dt><dd><code>{repair.replacementImage}</code></dd></div>
            <div><dt>资源版本</dt><dd><code>{repair.targetResourceVersion}</code></dd></div>
            <div><dt>提案摘要</dt><dd><code>{repair.digest}</code></dd></div>
            {run.waitingExpiresAt ? <div><dt>批准期限</dt><dd><LocalTimestamp timestamp={run.waitingExpiresAt} /></dd></div> : null}
          </dl>
          <p>批准将授权一次真实 Kubernetes 写入。资源漂移会停止执行；写入成功不等于业务恢复。</p>
          {run.operation === "rollback" ? <p>这是逆向变更：原镜像可能正是故障来源，可变 tag 也不保证还原原有字节。</p> : null}
        </> : null}
        {confirming === "reject" ? <p>正式拒绝将结束本次等待，不会执行此提案；已保存的诊断和证据保留。</p> : null}
        {confirming === "withdraw" ? <p>仅撤回你发起、尚未批准的申请。提案和证据保留，不产生审批拒绝或 Kubernetes 写入。</p> : null}
        {confirming === "rollback" ? <p>以这次可信写入的 before image 准备新的逆向提案，仍须 fresh 检查和另行批准。原镜像可能正是故障来源；回滚不保证恢复。</p> : null}
        {confirming === "refresh" || confirming === "edit" ? <p>将创建新的修复 Run{run.status === "WAITING_APPROVAL" ? "，并结束本次等待" : ""}。原提案保留，新提案必须重新批准。</p> : null}
        <div className="repair-actions__buttons">
          <ActionButton className="primary-button" type="button" disabledReason={unavailableReason(confirming) ?? (confirming === "edit" && !candidate ? "请先选择证据中的历史镜像，再生成新提案。" : undefined)} disabled={busy || refreshing || actions[confirming] !== null || (deadlineReached && (confirming === "approve" || confirming === "reject")) || (confirming === "edit" && !candidate)} onClick={() => void submit(confirming)}>{adjustment ? "生成新提案" : confirming === "approve" ? "批准并执行" : confirming === "rollback" ? "生成回滚提案" : confirming === "withdraw" ? "确认撤回申请" : "确认拒绝提案"}</ActionButton>
          <ActionButton className="secondary-button" type="button" disabledReason={pendingReason} disabled={busy} onClick={() => setConfirming(null)}>取消</ActionButton>
        </div>
      </div> : null}
    </div>
  );
}
