import { LocalTimestamp } from "@/components/local-timestamp";
import type { EvidenceResponse } from "@/lib/agent-runtime/view-models";
import { evidenceTargetLabel } from "@/lib/agent-runtime/view-models";

import { JsonViewer } from "./json-viewer";

/** Evidence cards of a referenced source Run carry their own anchor prefix. */
export function evidenceAnchorId(evidenceId: string, referenced: boolean): string {
  return `${referenced ? "source-evidence" : "evidence"}-${evidenceId}`;
}

function EvidenceCard({ evidence, index, referenced }: { evidence: EvidenceResponse; index: number; referenced: boolean }) {
  const anchorId = evidenceAnchorId(evidence.id, referenced);
  return (
    <article
      className="evidence-card"
      id={anchorId}
      data-testid={anchorId}
    >
      <header className="evidence-card__header">
        <div>
          <span className="eyebrow">证据 {index + 1}</span>
          <h3>{evidence.evidenceKind}</h3>
        </div>
        <div className="marker-row">
          {evidence.redacted ? <span className="safety-marker">已脱敏</span> : null}
          {evidence.truncated ? <span className="safety-marker">已截断</span> : null}
        </div>
      </header>

      <dl className="evidence-meta">
        <div>
          <dt>只读工具</dt>
          <dd>{evidence.toolName}</dd>
        </div>
        <div>
          <dt>观察时间</dt>
          <dd>
            <LocalTimestamp timestamp={evidence.observedAt} />
          </dd>
        </div>
        <div>
          <dt>目标</dt>
          <dd>{evidenceTargetLabel(evidence.targetRef)}</dd>
        </div>
      </dl>

      <JsonViewer
        title={`${evidence.evidenceKind} JSON`}
        json={JSON.stringify(evidence.payload, null, 2)}
      />
    </article>
  );
}

export function EvidenceList({ evidence, sourceRunAttempt, currentRunAttempt }: { evidence: EvidenceResponse[]; sourceRunAttempt?: number; currentRunAttempt?: number }) {
  const referenced = sourceRunAttempt !== undefined;
  const idPrefix = referenced ? "source-evidence" : "evidence";
  return (
    <section className="console-section evidence-section" aria-labelledby={`${idPrefix}-heading`}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">{sourceRunAttempt === undefined ? "本次运行 · Evidence" : "历史引用 · Evidence"}</span>
          <h2 id={`${idPrefix}-heading`}>{sourceRunAttempt === undefined ? currentRunAttempt === undefined ? "Kubernetes 证据" : `本次运行证据 · 第 ${currentRunAttempt} 次运行` : `来源诊断证据 · 第 ${sourceRunAttempt} 次运行`}</h2>
        </div>
        <span className="section-count">{evidence.length}</span>
      </div>

      {sourceRunAttempt !== undefined ? <p className="evidence-context">用于支撑上方引用的诊断结论，不代表本次运行重新采集或目标当前状态。</p> : currentRunAttempt !== undefined ? <p className="evidence-context">当前修复或回滚运行保存的证据，不包含引用诊断的历史证据。</p> : null}

      {evidence.length === 0 ? (
        <p className="empty-state empty-state--panel">尚未记录 Kubernetes 证据。</p>
      ) : (
        <div className="evidence-grid">
          {evidence.map((item, index) => (
            <EvidenceCard key={item.id} evidence={item} index={index} referenced={referenced} />
          ))}
        </div>
      )}

    </section>
  );
}
