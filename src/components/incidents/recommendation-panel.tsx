import { LocalTimestamp } from "@/components/local-timestamp";
import { UiIcon } from "@/components/ui/ui-icon";
import type { DiagnosisResponse, EvidenceResponse } from "@/lib/agent-runtime/view-models";
import { evidenceSummary } from "@/lib/agent-runtime/view-models";

import { evidenceAnchorId } from "./evidence-card";

const FIELDS = [
  { key: "purpose", label: "目的" },
  { key: "preconditions", label: "前置条件" },
  { key: "risk", label: "风险" },
  { key: "verification", label: "验证方向" },
] as const;

export function RecommendationPanel({
  diagnosis,
  evidence = [],
  referenceRunAttempt,
  runCompletedAt,
}: {
  diagnosis: DiagnosisResponse | null;
  evidence?: EvidenceResponse[];
  referenceRunAttempt?: number;
  runCompletedAt?: string | null;
}) {
  // The diagnosis panel already explains a missing or failed Run; an empty
  // advice block next to it would only repeat that.
  if (diagnosis === null) {
    return null;
  }

  const recommendations = diagnosis.recommendations;
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const referenced = referenceRunAttempt !== undefined;

  return (
    <section className="console-section recommendation-panel" aria-labelledby="recommendation-heading">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Model inference</span>
          <h2 id="recommendation-heading">处置建议</h2>
        </div>
        {recommendations === null || recommendations.length === 0 ? null : (
          <span className="status-badge">{recommendations.length} 条</span>
        )}
      </div>

      <p className={referenced ? "diagnosis-provenance diagnosis-provenance--referenced" : "diagnosis-provenance"}>
        <strong>{referenced ? `引用第 ${referenceRunAttempt} 次诊断运行` : "本次运行产生"}</strong>
        {runCompletedAt ? <> · 运行结束于 <LocalTimestamp timestamp={runCompletedAt} /></> : null}
        <span>
          {referenced ? "历史建议，不代表重新诊断或目标当前状态。" : null}
          建议是诊断的输出，不是执行许可；受控修复是否适用由 Runtime 单独判定。
        </span>
      </p>

      {recommendations === null ? (
        <p className="empty-state empty-state--panel">
          本次运行记录于处置建议之前，没有保存建议。不会用其他运行的建议补齐。
        </p>
      ) : recommendations.length === 0 ? (
        <p className="empty-state empty-state--panel">
          本次诊断没有提出处置建议。
        </p>
      ) : (
        <ol className="recommendation-list">
          {recommendations.map((recommendation, index) => (
            // The model writes each action, so its text cannot key the list.
            <li key={index}>
              <h3>{recommendation.action}</h3>
              <dl>
                {FIELDS.map(({ key, label }) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>{recommendation[key]}</dd>
                  </div>
                ))}
              </dl>
              <div className="diagnosis-evidence">
                <h4>依据的证据</h4>
                <ul>
                  {recommendation.evidenceIds.map((evidenceId) => {
                    const item = evidenceById.get(evidenceId);
                    const label = item === undefined ? "关联 Evidence" : evidenceSummary(item);
                    return (
                      <li key={evidenceId}>
                        <span>
                          {label}
                          {item?.redacted ? " · 已脱敏" : null}
                          {item?.truncated ? " · 已截断" : null}
                        </span>
                        <a
                          href={`#${evidenceAnchorId(evidenceId, referenced)}`}
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
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
