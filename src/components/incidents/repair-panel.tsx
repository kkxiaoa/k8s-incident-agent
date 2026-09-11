import { LocalTimestamp } from "@/components/local-timestamp";
import { UiIcon } from "@/components/ui/ui-icon";
import type { IncidentDetailView } from "@/lib/agent-runtime/response-contracts";
import { evidenceSummary, targetLabel } from "@/lib/agent-runtime/view-models";

import { JsonViewer } from "./json-viewer";

const FAILURE_LABELS: Readonly<Record<string, string>> = {
  repair_schema_invalid: "Schema 校验未通过",
  repair_policy_denied: "Policy 校验未通过",
  repair_diff_invalid: "Diff 校验未通过",
  stale_resource: "目标版本已变化",
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
}: {
  detail: IncidentDetailView;
  pending: boolean;
  refreshError: string | null;
}) {
  const { repair, selectedRun, evidence } = detail;
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
          <span className="eyebrow">Repair validation</span>
          <h2 id="repair-heading">修复验证</h2>
        </div>
        <span className="repair-run-label">第 {selectedRun.attempt} 次运行 · {selectedRun.kind === "diagnosis" ? "只读建议" : selectedRun.operation === "rollback" ? "回滚提案" : "修复提案"}</span>
      </div>

      {refreshError !== null ? (
        <p className="page-alert" role="status">修复详情暂不可用</p>
      ) : pending ? (
        <p className="empty-state" role="status">正在读取持久化的修复验证结果…</p>
      ) : repair === null ? (
        <>
          <div className="repair-empty">
            <UiIcon name={failure === undefined ? "info" : "close"} />
            <div>
              <p>{failure ?? (active ? "修复验证结果尚未生成。" : "本次运行未生成修复提案。")}</p>
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
          <div className={`repair-verdict${repair.validation.outcome === "failed" ? " repair-verdict--failed" : ""}`}>
            <span className="repair-verdict__icon"><UiIcon name={repair.validation.outcome === "passed" ? "check" : "close"} /></span>
            <div>
              <strong>{repair.validation.outcome === "passed"
                ? "已通过验证，尚未批准或执行"
                : "验证未通过，尚未批准或执行"}</strong>
              <p>本次运行的验证快照，不代表目标当前状态。Dry-run 不证明应用已经恢复。</p>
            </div>
            <span className="repair-verdict__boundary">未执行</span>
          </div>

          <div className="repair-workbench">
            <div className="repair-change">
              <div className="repair-subheading">
                <h3>镜像变更提案</h3>
                <span>1 个容器 · 1 个字段</span>
              </div>
              <p className="repair-target">{targetLabel(repair.target)}</p>
              <div className="repair-scope">
                <span>容器 <code>{repair.containerName}</code></span>
                <span>资源版本 <code>{repair.targetResourceVersion}</code></span>
              </div>

              <div className="repair-diff" aria-label="镜像修改对比">
                <div className="repair-diff__before">
                  <span className="repair-diff__label">当前镜像 <span>观察值</span></span>
                  <code tabIndex={0}>{repair.diff.before}</code>
                </div>
                <div className="repair-diff__after">
                  <span className="repair-diff__arrow" aria-hidden="true"><UiIcon name="chevron-right" /></span>
                  <span className="repair-diff__label">建议镜像 <span>上一 revision</span></span>
                  <code tabIndex={0}>{repair.diff.after}</code>
                </div>
              </div>

              <div className="repair-evidence">
                <h3>提案依据</h3>
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

              <div className="repair-impact">
                <h3>风险与影响</h3>
                <p>若未来获批执行，镜像变更会触发 Deployment 滚动更新，可能影响可用性。历史镜像不保证当前配置下的应用健康。</p>
              </div>
            </div>

            <div className="repair-receipt">
              <div className="repair-subheading">
                <h3>验证记录</h3>
                <span>只验证，不执行</span>
              </div>
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
            </div>
          </div>

          <details className="repair-technical">
            <summary>
              <span><UiIcon name="chevron-right" />目标约束与 JSON Patch</span>
              <span className="repair-technical__hint">只读技术详情</span>
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
                <JsonViewer title="JSON Patch" json={JSON.stringify(repair.patch, null, 2)} />
              </div>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
