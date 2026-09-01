import type {
  DiagnosisResponse,
  RunErrorResponse,
  RunStatus,
} from "@/lib/agent-runtime/view-models";

const CONFIDENCE_LABELS = {
  low: "低置信度",
  medium: "中置信度",
  high: "高置信度",
} as const;

export function DiagnosisPanel({
  diagnosis,
  runStatus,
  runError,
}: {
  diagnosis: DiagnosisResponse | null;
  runStatus: RunStatus;
  runError: RunErrorResponse | null;
}) {
  if (diagnosis === null) {
    if (runStatus === "FAILED") {
      return (
        <section className="console-section diagnosis-panel" aria-labelledby="diagnosis-heading">
          <span className="eyebrow eyebrow--danger">Terminal</span>
          <h2 id="diagnosis-heading">诊断运行失败</h2>
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
        <p className="empty-state empty-state--panel">诊断尚未生成。</p>
      </section>
    );
  }

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

      {diagnosis.redacted ? (
        <p className="safety-callout">诊断文本已脱敏</p>
      ) : null}

      <p className="diagnosis-summary">{diagnosis.summary}</p>

      {diagnosis.rootCauses.length === 0 ? null : (
        <ol className="root-cause-list">
          {diagnosis.rootCauses.map((cause) => (
            <li key={cause.code}>
              <div className="root-cause-list__heading">
                <strong>{cause.statement}</strong>
                <span className={`confidence confidence--${cause.confidence}`}>
                  {CONFIDENCE_LABELS[cause.confidence]}
                </span>
              </div>
              <code>{cause.code}</code>
              <div className="evidence-links">
                {cause.evidenceIds.map((evidenceId, index) => (
                  <a key={evidenceId} href={`#evidence-${evidenceId}`}>
                    证据 {index + 1}
                  </a>
                ))}
              </div>
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
