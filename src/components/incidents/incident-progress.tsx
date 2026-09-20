"use client";

import { UiIcon } from "@/components/ui/ui-icon";
import { ShimmerText } from "@/components/ui/shimmer-text";
import { ApprovalCountdown } from "./approval-countdown";
import { isPreparationFailure } from "./repair-preparation";
import type { IncidentDetailView } from "@/lib/agent-runtime/response-contracts";

export function IncidentProgress({ detail, diagnosisDetail = detail.selectedRun.kind === "diagnosis" ? detail : null, diagnosisLoading = false }: {
  detail: IncidentDetailView;
  diagnosisDetail?: IncidentDetailView | null;
  diagnosisLoading?: boolean;
}) {
  const { selectedRun: run, repair, approval, verification } = detail;
  const diagnostic = run.kind === "diagnosis";
  const execution = approval?.execution;
  const stage = diagnostic ? 1 : execution || verification ? 4
    : approval || run.status === "WAITING_APPROVAL" || run.endReason ? 3 : 2;
  const expired = run.endReason === "expired" || detail.actions.approve === "proposal_expired";
  const stopped = run.status === "FAILED" || run.endReason != null || expired || approval?.decision === "reject";
  const running = run.status === "RUNNING";
  const diagnosis = diagnosisDetail?.diagnosis;
  const diagnosisCaption = diagnosisLoading ? "读取来源诊断中"
    : diagnosis ? diagnosis.outcome === "diagnosed" ? "诊断已完成" : "证据不足"
      : diagnosisDetail?.selectedRun.status === "FAILED" ? "诊断失败"
        : diagnostic && running ? "诊断处理中"
          : diagnostic && run.status === "QUEUED" ? "等待诊断"
          : diagnosisDetail ? "未保存诊断结论" : "来源记录加载失败";
  // Runtime facts decide the path: a repair Run, a proposal that passed the
  // gates on this diagnosis Run, or a preparation that ran and failed. A Run
  // that entered the repair path keeps it, and the preparation step reports
  // that failure, so the bar never contradicts the gate record below it.
  const preparationFailed = isPreparationFailure(
    (repair?.validation.error ?? run.error)?.code,
  );
  const repairPath = !diagnostic || repair !== null || preparationFailed;
  const path = [
    { title: "故障发现", caption: detail.incident.source.type === "alertmanager" ? "告警已记录" : "场景已记录", href: "#incident-heading", done: true },
    { title: "诊断分析", caption: diagnosisCaption, href: "#diagnosis-heading", done: diagnosis?.outcome === "diagnosed" },
    { title: run.operation === "rollback" ? "回滚准备" : "修复准备", caption: preparationFailed ? "准备未通过"
      : diagnostic ? "尚未准备执行"
      : repair?.validation.outcome === "passed" ? "检查记录已保存"
        : run.status === "FAILED" ? "准备未通过" : running ? "准备处理中" : "未形成可用提案", href: diagnostic && !preparationFailed ? null : "#repair-preparation", done: !diagnostic && repair?.validation.outcome === "passed" },
    { title: "人工审批", caption: approval ? approval.decision === "approve" ? "已批准" : "已拒绝"
      : run.endReason === "expired" || detail.actions.approve === "proposal_expired" ? "提案已过期" : run.endReason === "superseded" ? "已被替换"
        : run.endReason === "withdrawn" ? "已撤回" : run.status === "WAITING_APPROVAL" ? "等待决定" : "尚未审批", href: stage >= 3 ? "#repair-decision" : null, done: approval?.decision === "approve" },
    { title: "执行与恢复", caption: execution?.status === "UNKNOWN" ? "结果未知"
      : verification?.outcome === "recovered" ? "恢复已验证"
        : verification?.outcome === "observing" ? "恢复观察中"
          : verification ? "未能证明恢复" : execution ? {
            PENDING: "等待执行领取", CLAIMED: "等待执行结果", APPLIED: "写入已确认",
            EXPIRED: "许可已到期", REJECTED: "执行被拒绝", STALE_RESOURCE: "目标已变化", UNKNOWN: "结果未知",
          }[execution.status] : "尚未执行", href: stage === 4 ? "#repair-execution" : null, done: verification?.outcome === "recovered" },
  ];
  const steps = repairPath ? path : path.slice(0, 2);
  const branchNote = repairPath ? null
    : diagnostic && (run.status === "QUEUED" || run.status === "RUNNING")
      ? "受控修复适用性待判定"
      : diagnosis
        ? "本次无适用的受控修复，需人工处置"
        : "未生成诊断结论，无适用的受控修复";

  return <nav className="incident-progress" aria-label="事件处理阶段">
    <p className="incident-progress__current">{stopped ? "流程已停止" : run.status === "COMPLETED" ? "运行已结束" : "当前阶段"}
      <strong>{steps[stage].title} · {steps[stage].caption}</strong>
      {branchNote === null ? null : <span className="incident-progress__branch">{branchNote}</span>}
    </p>
    <ol data-steps={steps.length}>
      {steps.map((step, index) => {
        const interrupted = index === stage && stopped && !step.done;
        const loadingSource = index === 1 && diagnosisLoading;
        const recoveryUnproven = index === 4 && verification != null
          && verification.outcome !== "observing" && verification.outcome !== "recovered";
        const attention = interrupted || recoveryUnproven || (index === 1 && !step.done && !loadingSource && (
          diagnosis?.outcome === "insufficient_evidence" || diagnosisDetail?.selectedRun.status === "FAILED"
          || diagnosisDetail?.selectedRun.status === "COMPLETED" || (!diagnostic && !diagnosisDetail)));
        const processing = loadingSource || (running && index === stage && !step.done && !attention
          && (index !== 4 || (execution?.status !== "PENDING" && execution?.status !== "EXPIRED")));
        const content = <><span className="incident-progress__mark" aria-hidden="true">{step.done ? <UiIcon name="check" /> : attention ? <UiIcon name="exclamation" /> : loadingSource ? "…" : index + 1}</span>
          <span><strong>{step.title}</strong><small>{index === 3 && run.status === "WAITING_APPROVAL" && !approval && !expired
            ? <ApprovalCountdown /> : <ShimmerText active={processing}>{step.caption}</ShimmerText>}</small>
            {index === 1 && !diagnostic && diagnosisDetail ? <small>引用第 {diagnosisDetail.selectedRun.attempt} 次运行</small> : null}
          </span></>;
        return <li key={step.title} data-current={index === stage} data-done={step.done}
          data-attention={attention} data-running={processing}
          data-connected={step.done && steps[index + 1]?.done === true}>
          {step.href ? <a href={step.href} aria-current={index === stage ? "step" : undefined}
            onClick={() => {
              const section = document.getElementById(step.href!.slice(1));
              if (section instanceof HTMLDetailsElement) section.open = true;
            }}>{content}</a>
            : <span aria-current={index === stage ? "step" : undefined}>{content}</span>}
        </li>;
      })}
    </ol>
  </nav>;
}
