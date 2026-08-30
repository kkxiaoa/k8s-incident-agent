import { LocalTimestamp } from "@/components/local-timestamp";
import type { EvidenceResponse } from "@/lib/agent-runtime/view-models";
import { targetLabel } from "@/lib/agent-runtime/view-models";

import { EvidenceJsonViewer } from "./evidence-json-viewer";

function EvidenceCard({ evidence, index }: { evidence: EvidenceResponse; index: number }) {
  return (
    <article
      className="evidence-card"
      id={`evidence-${evidence.id}`}
      data-testid={`evidence-${evidence.id}`}
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
          <dd>
            {typeof evidence.targetRef.kind === "string" &&
            typeof evidence.targetRef.namespace === "string" &&
            typeof evidence.targetRef.name === "string"
              ? targetLabel({
                  kind: evidence.targetRef.kind,
                  namespace: evidence.targetRef.namespace,
                  name: evidence.targetRef.name,
                })
              : "由工具契约记录"}
          </dd>
        </div>
      </dl>

      <EvidenceJsonViewer
        evidenceKind={evidence.evidenceKind}
        payload={evidence.payload}
      />
    </article>
  );
}

export function EvidenceList({ evidence }: { evidence: EvidenceResponse[] }) {
  return (
    <section className="console-section" aria-labelledby="evidence-heading">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Evidence-first</span>
          <h2 id="evidence-heading">Kubernetes 证据</h2>
        </div>
        <span className="section-count">{evidence.length}</span>
      </div>

      {evidence.length === 0 ? (
        <p className="empty-state empty-state--panel">尚未记录 Kubernetes 证据。</p>
      ) : (
        <div className="evidence-grid">
          {evidence.map((item, index) => (
            <EvidenceCard key={item.id} evidence={item} index={index} />
          ))}
        </div>
      )}

      <p className="scope-note">当前切片不包含指标证据。</p>
    </section>
  );
}
