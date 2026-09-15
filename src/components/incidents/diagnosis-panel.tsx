import type {
  DiagnosisResponse,
  EvidenceResponse,
  RunErrorResponse,
  RunStatus,
} from "@/lib/agent-runtime/view-models";
import { evidenceSummary } from "@/lib/agent-runtime/view-models";
import { UiIcon } from "@/components/ui/ui-icon";
import { LocalTimestamp } from "@/components/local-timestamp";
import { ShimmerText } from "@/components/ui/shimmer-text";

const CONFIDENCE_LABELS = {
  low: "低置信度",
  medium: "中置信度",
  high: "高置信度",
} as const;

export function DiagnosisPanel({
  diagnosis,
  evidence = [],
  runStatus,
  runError,
  referenceRunAttempt,
  runCompletedAt,
}: {
  diagnosis: DiagnosisResponse | null;
  evidence?: EvidenceResponse[];
  runStatus: RunStatus;
  runError: RunErrorResponse | null;
  referenceRunAttempt?: number;
  runCompletedAt?: string | null;
}) {
  const provenance = <p className="diagnosis-provenance">
    {referenceRunAttempt === undefined ? "本次运行产生" : `引用第 ${referenceRunAttempt} 次诊断运行`}
    {runCompletedAt ? <> · 运行结束于 <LocalTimestamp timestamp={runCompletedAt} /></> : null}
    {referenceRunAttempt === undefined ? null : <span>历史诊断结论，不代表重新诊断或目标当前状态。</span>}
  </p>;
  if (diagnosis === null) {
    if (runStatus === "FAILED") {
      return (
        <section className="console-section diagnosis-panel" aria-labelledby="diagnosis-heading">
          <span className="eyebrow eyebrow--danger">Terminal</span>
          <h2 id="diagnosis-heading">诊断运行失败</h2>
          {provenance}
          <p>Runtime 保留了失败终态，没有生成诊断结论。</p>
          {runError === null ? null : (
            <dl className="failure-detail">
              <div>
                <dt>错误代码</dt>
                <dd>{runError.code}</dd>
              </div>
              <div>
                <dt>可重试</dt>
                <dd>{runError.retryable ? "是" : "否"}</dd>
              </div>
            </dl>
          )}
        </section>
      );
    }

    return (
      <section className="console-section diagnosis-panel" aria-labelledby="diagnosis-heading">
        <span className="eyebrow">Model inference</span>
        <h2 id="diagnosis-heading">诊断结论</h2>
        {provenance}
        <p className={runStatus === "QUEUED" || runStatus === "RUNNING" ? undefined : "empty-state empty-state--panel"}><ShimmerText active={runStatus === "QUEUED" || runStatus === "RUNNING"}>{runStatus === "COMPLETED" ? "未保存诊断结论。" : "诊断尚未生成。"}</ShimmerText></p>
      </section>
    );
  }

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

  return (
    <section className="console-section diagnosis-panel" aria-labelledby="diagnosis-heading">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Model inference</span>
          <h2 id="diagnosis-heading">诊断结论</h2>
        </div>
        <span
          className={
            diagnosis.outcome === "diagnosed"
              ? "status-badge status-badge--success"
              : "status-badge status-badge--warning"
          }
        >
          {diagnosis.outcome === "diagnosed" ? "已诊断" : "证据不足"}
        </span>
      </div>

      {provenance}

      {diagnosis.redacted ? (
        <p className="safety-callout">诊断文本已脱敏</p>
      ) : null}

      <p className="diagnosis-summary">{diagnosis.summary}</p>

      {diagnosis.rootCauses.length === 0 ? null : (
        <ol className="root-cause-list">
          {diagnosis.rootCauses.map((cause) => (
            <li key={cause.code}>
              <div className="root-cause-list__heading">
                <strong>
                  <span>根因（{CONFIDENCE_LABELS[cause.confidence]}）</span>
                  {cause.statement}
                </strong>
                <code>{cause.code}</code>
              </div>
              {cause.evidenceIds.length === 0 ? null : (
                <div className="diagnosis-evidence">
                  <h3>关键证据</h3>
                  <ul>
                    {cause.evidenceIds.map((evidenceId) => {
                      const item = evidenceById.get(evidenceId);
                      const label =
                        item === undefined
                          ? "关联 Evidence"
                          : evidenceSummary(item);
                      return (
                        <li key={evidenceId}>
                          <span>
                            {item === undefined ? (
                              label
                            ) : (
                              <>
                                {label}
                                {item.redacted ? " · 已脱敏" : null}
                                {item.truncated ? " · 已截断" : null}
                              </>
                            )}
                          </span>
                          <a
                            href={`#${referenceRunAttempt === undefined ? "evidence" : "source-evidence"}-${evidenceId}`}
                            aria-label={`查看证据：${label}`}
                          >
                            查看证据
                            <UiIcon name="external-link" />
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {diagnosis.missingInformation.length === 0 ? null : (
        <div className="missing-information">
          <h3>仍缺少的信息</h3>
          <ul>
            {diagnosis.missingInformation.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
