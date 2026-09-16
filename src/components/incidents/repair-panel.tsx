import Link from "next/link";
import { LocalTimestamp } from "@/components/local-timestamp";
import type { ReactNode } from "react";
import { UiIcon } from "@/components/ui/ui-icon";
import { ShimmerText } from "@/components/ui/shimmer-text";
import { ActionButton } from "@/components/ui/action-button";
import type { IncidentDetailView } from "@/lib/agent-runtime/response-contracts";
import { evidenceSummary, targetLabel } from "@/lib/agent-runtime/view-models";

const FAILURE_LABELS: Readonly<Record<string, string>> = {
  repair_schema_invalid: "Schema 校验未通过",
  repair_policy_denied: "Policy 校验未通过",
  repair_diff_invalid: "Diff 校验未通过",
  repair_no_candidate: "没有匹配的历史镜像候选",
  repair_timeout: "修复准备超时",
  stale_resource: "目标状态已变化",
  patch_validator_authentication_failed: "验证通信认证失败",
  patch_validator_replay_rejected: "验证请求重放被拒绝",
  patch_validator_permission_denied: "验证权限不足",
  patch_validator_admission_denied: "准入检查拒绝",
  patch_validator_timeout: "验证超时",
  patch_validator_upstream_failed: "验证服务暂不可用",
  patch_validator_contract_invalid: "验证响应不符合契约",
};

type GateOutcome = "passed" | "failed" | "not_run" | "unrecorded";
type GateOutcomes = Readonly<Record<"schema" | "policy" | "diff" | "dryRun", GateOutcome>>;

// Preparation failures expose an error code, not the earlier checks' records.
const PREPARATION_OUTCOMES: Readonly<Record<string, GateOutcomes | undefined>> = {
  repair_schema_invalid: { schema: "failed", policy: "not_run", diff: "not_run", dryRun: "not_run" },
  repair_policy_denied: { schema: "unrecorded", policy: "failed", diff: "not_run", dryRun: "not_run" },
  repair_diff_invalid: { schema: "unrecorded", policy: "unrecorded", diff: "failed", dryRun: "not_run" },
};

const GATE_OUTCOME_LABELS: Readonly<Record<GateOutcome, string>> = {
  passed: "已通过",
  failed: "未通过",
  not_run: "未执行",
  unrecorded: "无独立记录",
};

export function RepairPanel({
  detail,
  pending,
  refreshError,
  children,
  onRefresh,
  refreshing = false,
}: {
  detail: IncidentDetailView;
  pending: boolean;
  refreshError: string | null;
  children?: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const { repair, selectedRun, evidence } = detail;
  const verification = detail.verification;
  const verificationFailed = verification && verification.outcome !== "observing" && verification.outcome !== "recovered";
  const execution = detail.approval?.execution;
  const rollback = selectedRun.operation === "rollback";
  const executionFailed = execution && ["REJECTED", "STALE_RESOURCE", "UNKNOWN"].includes(execution.status);
  const executionMessage = execution ? {
    PENDING: "已批准，等待执行领取",
    CLAIMED: "执行已领取，等待可信结果",
    APPLIED: "API 写入已确认，恢复尚未验证",
    EXPIRED: "执行许可已到期，未领取、未写入",
    STALE_RESOURCE: "目标资源已变化，执行已停止",
    REJECTED: "执行被明确拒绝",
    UNKNOWN: "写入结果未知，目标保持占用；禁止重试或自动回滚",
  }[execution.status] : detail.approval?.decision === "reject" ? "修复已被拒绝，未执行" : null;
  const running = selectedRun.status === "QUEUED" || selectedRun.status === "RUNNING";
  const expired = selectedRun.endReason === "expired" || detail.actions.approve === "proposal_expired";
  const ended = detail.approval?.decision === "reject" || selectedRun.endReason != null || expired;
  const tone = executionFailed || verificationFailed || repair?.validation.outcome === "failed" ? "failed"
    : ended ? "neutral" : verification?.outcome === "recovered" ? "success" : "neutral";
  const error = repair?.validation.error ?? selectedRun.error;
  const failure = error === null ? undefined : FAILURE_LABELS[error.code];
  const active = selectedRun.status === "QUEUED" || selectedRun.status === "RUNNING" || selectedRun.status === "WAITING_APPROVAL";
  // A persisted proposal exists only after Schema, Policy and Diff have passed.
  const outcomes: GateOutcomes | undefined = repair !== null
    ? { schema: "passed", policy: "passed", diff: "passed", dryRun: repair.validation.outcome }
    : selectedRun.status === "FAILED" && error !== null
      ? PREPARATION_OUTCOMES[error.code]
      : undefined;
  const gateList = outcomes === undefined ? null : (
    <ol className="repair-gates" aria-label="修复验证门禁">
      {[
        { label: "Schema", caption: "结构校验", outcome: outcomes.schema, timestamp: repair?.schemaCheckedAt },
        { label: "Policy", caption: "策略检查", outcome: outcomes.policy, timestamp: repair?.policyCheckedAt },
        { label: "Diff", caption: "变更范围", outcome: outcomes.diff, timestamp: repair?.diffCheckedAt },
        { label: "Server-side dry-run", caption: "API server 预检", outcome: outcomes.dryRun, timestamp: repair?.validation.checkedAt },
      ].map(({ label, caption, outcome, timestamp }) => (
        <li key={label} className={`repair-gate--${outcome}`}>
          <span className="repair-gate__mark"><UiIcon name={outcome === "passed" ? "check" : outcome === "failed" ? "close" : "info"} /></span>
          <div className="repair-gate__body">
            <div><strong>{label}</strong><span>{GATE_OUTCOME_LABELS[outcome]}</span></div>
            <p>{caption}</p>
            {timestamp !== undefined ? <LocalTimestamp timestamp={timestamp} /> : null}
          </div>
        </li>
      ))}
    </ol>
  );

  return (
    <section className="console-section repair-panel" aria-labelledby="repair-heading">
      <div className="section-heading">
        <div>
          <span className="eyebrow">{selectedRun.kind === "diagnosis" ? "Read-only suggestion" : rollback ? "Rollback" : "Repair workflow"}</span>
          <h2 id="repair-heading">{selectedRun.kind === "diagnosis" ? "修复建议" : rollback ? "回滚处置" : "修复处置"}</h2>
        </div>
        <div className="repair-panel__tools">{onRefresh ? <ActionButton type="button" className="secondary-button" onClick={onRefresh} disabled={refreshing} disabledReason="正在读取最新保存状态，请稍候。">检查最新状态</ActionButton> : null}
        <span className="repair-run-label">第 {selectedRun.attempt} 次运行 · {selectedRun.kind === "diagnosis" ? "只读建议" : selectedRun.operation === "rollback" ? "回滚提案" : "修复提案"}</span></div>
      </div>

      {selectedRun.sourceRunId ? <p className="repair-source">基于已保存的{rollback ? "原修复" : "来源"}记录生成 · {rollback
        ? <Link href={`/incidents/${detail.incident.id}?runId=${selectedRun.sourceRunId}`}>查看原修复运行</Link>
        : <a href="#diagnosis-heading">查看诊断依据</a>}</p> : null}
      {selectedRun.endReason ? <p role="status">{{ expired: "提案已过期，需要重新准备。", superseded: "本次等待已被新的运行替换。", rejected: "本次修复申请已被拒绝。", execution_expired: "执行许可已到期，需要重新准备。", withdrawn: "发起者已撤回申请，未批准或执行。" }[selectedRun.endReason]}</p> : null}
      {selectedRun.status === "WAITING_APPROVAL" && selectedRun.waitingExpiresAt ? <p>等待期限：<LocalTimestamp timestamp={selectedRun.waitingExpiresAt} /></p> : null}

      {refreshError !== null ? (
        <p className="page-alert" role="status">修复详情暂不可用</p>
      ) : pending ? (
        <p role="status"><ShimmerText>正在读取持久化的修复验证结果…</ShimmerText></p>
      ) : repair === null ? (
        <>
          <div id="repair-preparation" className="repair-empty">
            <UiIcon name={failure === undefined ? "info" : "close"} />
            <div>
              <p><ShimmerText active={running}>{failure ?? (active ? "修复验证结果尚未生成。" : "本次运行未生成修复提案。")}</ShimmerText></p>
              {failure === undefined ? (
                <span>只有 Evidence 支持的镜像变更才会进入修复验证。</span>
              ) : (
                <span>验证已停止，未形成可用提案；后续门禁未继续。错误代码：<code>{error?.code}</code></span>
              )}
            </div>
          </div>
          {gateList !== null ? (
            <div className="repair-receipt repair-receipt--preparation">
              <div className="repair-subheading"><h3>验证记录</h3><span>未形成可用提案</span></div>
              {gateList}
              <p className="repair-receipt__note">当前详情仅提供失败代码，没有逐项检查时间；“无独立记录”不表示通过。后续门禁未执行。</p>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div id="repair-execution" className={`repair-verdict repair-verdict--${tone}`} data-running={running}>
            <div>
              {rollback && execution?.status === "APPLIED" ? <p>批准的逆向写入已完成；恢复结果单独判定。</p> : null}
              <strong><ShimmerText active={running}>{verification ? {
                observing: "写入已确认，正在观察恢复",
                recovered: "工作负载与告警恢复已验证",
                workload_failed: "工作负载未恢复，验证已停止",
                monitoring_unavailable: "监控链路不可用，无法证明恢复",
                insufficient_evidence: "有效观测不足，无法证明恢复",
                target_drift: "目标已发生后续变化，验证已停止",
                timeout: "恢复验证已超时",
              }[verification.outcome] : executionMessage ?? (expired ? "提案已过期，未执行"
                : selectedRun.endReason === "superseded" ? "本次提案已被新的运行替换"
                : selectedRun.endReason === "withdrawn" ? "申请已撤回，未执行"
                : repair.validation.outcome === "failed" ? "验证未通过，尚未批准或执行"
                : selectedRun.kind === "diagnosis" ? "只读建议已保存，需重新准备后才能审批"
                : selectedRun.status === "WAITING_APPROVAL" ? "提案已准备，等待人工审批"
                : "检查记录已保存，尚未批准或执行")}</ShimmerText></strong>
              <p>{verification ? "恢复结论仅覆盖已观察的 Kubernetes 工作负载与相关告警，不证明业务请求或数据正确性。" : "本次运行的验证快照，不代表目标当前状态。Dry-run 不证明应用已经恢复。"}</p>
              {verification ? <p>已保存 {verification.sampleCount} 次观测 · 验证截止 <LocalTimestamp timestamp={verification.deadlineAt} />{verification.healthySince ? <> · 本段健康窗口起于 <LocalTimestamp timestamp={verification.healthySince} /></> : null}</p> : null}
              {verification?.reason ? <p>当前判据：{{ rollout_pending: "等待本次 rollout 完成", workload_unhealthy: "工作负载尚未稳定", sample_missing: "缺少有效 Kubernetes 观测", sample_gap: "观测中断，重新累计健康窗口", monitoring_unavailable: "监控链路或规则不可用", metrics_missing_or_stale: "目标原始指标缺失或陈旧", alerts_active: "相关告警仍处于 pending/firing", occurrence_not_resolved: "尚未收到本次告警解除通知", target_drift: "目标 UID、镜像或 generation 已改变", deadline_exceeded: "达到原始验证期限" }[verification.reason]}</p> : null}
              {execution?.lateResult ? <p>迟到成功回执已保留；未知状态与目标占用未自动解除。</p> : null}
              {rollback && executionFailed ? <p>回滚写入失败或结果未知，目标保持占用；停止后续写入，需另行核查。</p> : null}
            </div>
            <span className="repair-verdict__boundary">{rollback && execution?.status === "APPLIED" ? "ROLLED_BACK" : execution?.status ?? "未执行"}</span>
          </div>

          <div className="repair-workbench">
            <div className="repair-change">
              <div className="repair-subheading">
                <h3>{detail.approval?.decision === "reject" ? "本次未执行的提案" : execution ? "本次批准的变更" : "镜像变更提案"}</h3>
                <span>1 个容器 · 1 个字段</span>
              </div>
              <p className="repair-target">{targetLabel(repair.target)}</p>
              <div className="repair-scope">
                <span>容器 <code>{repair.containerName}</code></span>
                <span>资源版本 <code>{repair.targetResourceVersion}</code></span>
              </div>

              <div className="repair-diff" aria-label="镜像修改对比">
                <div className="repair-diff__before">
                  <span className="repair-diff__label">变更前镜像 <span>准备时观察值</span></span>
                  <code tabIndex={0}>{repair.diff.before}</code>
                </div>
                <div className="repair-diff__after">
                  <span className="repair-diff__arrow" aria-hidden="true"><UiIcon name="chevron-right" /></span>
                  <span className="repair-diff__label">目标镜像 <span>{rollback ? "原执行 before image" : "上一 revision"}</span></span>
                  <code tabIndex={0}>{repair.diff.after}</code>
                </div>
              </div>

              <div className="repair-impact">
                <h3>风险与影响</h3>
                <p>{rollback
                  ? "回滚需要单独批准，会触发滚动更新并可能降低可用性。原镜像可能正是故障来源；可变 tag 仅还原引用，不保证相同镜像字节或应用健康。"
                  : "若未来获批执行，镜像变更会触发 Deployment 滚动更新，可能影响可用性。历史镜像不保证当前配置下的应用健康。"}</p>
              </div>

              <div className="repair-evidence">
                <h3>提案依据</h3>
                {repair.sourceExecutionId ? <p>来源 execution：<code>{repair.sourceExecutionId}</code>。原执行前的镜像引用来自可信执行账本，不是历史修订 Evidence。</p> : null}
                <ul>
                  {repair.evidenceIds.map((id) => {
                    const item = evidence.find((entry) => entry.id === id);
                    return <li key={id}>{item === undefined ? "关联证据不可用" : (
                      <a href={`#evidence-${id}`} aria-label={`查看证据：${evidenceSummary(item)}`}>
                        <UiIcon name={item.evidenceKind === "rollout_history" ? "layers" : "activity"} />
                        <span>{item.evidenceKind === "rollout_history" ? "历史修订" : "当前工作负载"}<small>{item.toolName}</small></span>
                        <span className="repair-evidence__action">查看<UiIcon name="arrow-down" /></span>
                      </a>
                    )}</li>;
                  })}
                </ul>
              </div>

            </div>

            <details id="repair-preparation" className="repair-record" open={repair.validation.outcome === "failed"}>
              <summary>准备检查记录<span>{repair.validation.outcome === "passed" ? "4 项已通过 · 查看记录" : "检查未通过 · 查看记录"}</span></summary>
              {gateList}
              {repair.validation.outcome === "failed" ? (
                <div className="repair-failure">
                  <strong>{failure ?? "修复验证失败"}</strong>
                  <p>{error?.code === "stale_resource"
                    ? "该提案绑定的目标已变化，不能继续沿用此版本的验证。"
                    : "本次验证没有通过，未进入等待审批状态。"}</p>
                  <code>{error?.code}</code>
                  <p>可重试：{error?.retryable ? "是" : "否"}</p>
                </div>
              ) : (
                <p className="repair-receipt__note">以上为已保存的门禁结果，并非恢复证明。</p>
              )}
            </details>
          </div>

          {detail.approval ? <details className="repair-record">
            <summary>审批与执行记录<span>查看本次保存的决定和回执</span></summary>
            <dl className="repair-facts">
              <div><dt>审批决定</dt><dd>{detail.approval.decision === "approve" ? "已批准" : "已拒绝"}</dd></div>
              <div><dt>决定时间</dt><dd><LocalTimestamp timestamp={detail.approval.decidedAt} /></dd></div>
              {execution ? <>
                <div><dt>执行状态</dt><dd>{execution.status}</dd></div>
                <div><dt>领取时间</dt><dd>{execution.claimedAt ? <LocalTimestamp timestamp={execution.claimedAt} /> : "尚未领取"}</dd></div>
                <div><dt>结果回报时间</dt><dd>{execution.reportedAt ? <LocalTimestamp timestamp={execution.reportedAt} /> : "尚无回报"}</dd></div>
                {execution.result?.receipt ? <>
                  <div><dt>回执 UID</dt><dd><code>{execution.result.receipt.uid}</code></dd></div>
                  <div><dt>返回资源版本</dt><dd><code>{execution.result.receipt.resourceVersion}</code></dd></div>
                  <div><dt>generation</dt><dd>{execution.result.receipt.generation}</dd></div>
                </> : <div><dt>可信写入回执</dt><dd>未取得，不能据此确认写入</dd></div>}
              </> : <div><dt>执行记录</dt><dd>未创建</dd></div>}
            </dl>
          </details> : null}
          <details className="repair-technical">
            <summary>
              <span><UiIcon name="chevron-right" />目标约束与 JSON Patch</span>

            </summary>
            <div className="repair-technical__body">
              <div>
                <h3>绑定的资源快照</h3>
                <p>执行前仍须核对 UID、资源版本、容器名与原镜像；不能沿用已漂移的目标。</p>
                <dl className="repair-facts">
                  <div><dt>集群</dt><dd>{repair.target.cluster}</dd></div>
                  <div><dt>目标 UID</dt><dd><code>{repair.targetUid}</code></dd></div>
                  <div><dt>资源版本</dt><dd><code>{repair.targetResourceVersion}</code></dd></div>
                  <div><dt>变更路径</dt><dd><code>{repair.diff.path}</code></dd></div>
                  <div><dt>提案 ID</dt><dd><code>{repair.id}</code></dd></div>
                  <div><dt>摘要</dt><dd><code>{repair.digest}</code></dd></div>
                </dl>
              </div>
              <div>
                <pre className="repair-patch" tabIndex={0} aria-label="只读 JSON Patch"><code>{JSON.stringify(repair.patch, null, 2)}</code></pre>
              </div>
            </div>
          </details>
        </>
      )}
      <div id="repair-decision">{children}</div>
    </section>
  );
}
