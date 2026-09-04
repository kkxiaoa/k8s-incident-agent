const FACT_ROWS = ["target", "source", "created"] as const;
const SECONDARY_FACT_ROWS = ["signal", "incident-id"] as const;
const METRIC_PANELS = ["affected-pods", "available-replicas"] as const;
const METRIC_SUMMARY_ITEMS = ["current", "threshold", "updated"] as const;
const CONSOLE_PANELS = ["timeline", "diagnosis"] as const;
const EVIDENCE_CARDS = ["evidence-1", "evidence-2"] as const;

export default function IncidentLoading() {
  return (
    <main
      className="page-shell detail-page detail-loading"
      aria-busy="true"
      aria-label="Incident 加载中"
    >
      <div className="detail-toolbar detail-loading__toolbar" aria-hidden="true">
        <div className="detail-loading__breadcrumb">
          <span className="skeleton detail-loading__breadcrumb-item" />
          <span className="skeleton detail-loading__breadcrumb-separator" />
          <span className="skeleton detail-loading__breadcrumb-item" />
        </div>
        <span className="skeleton detail-loading__updated" />
      </div>

      <section
        className="incident-overview detail-loading__overview"
        aria-hidden="true"
      >
        <div className="incident-overview__main">
          <div className="incident-overview__title-row">
            <span className="skeleton detail-loading__title" />
            <div className="marker-row">
              <span className="skeleton detail-loading__badge" />
              <span className="skeleton detail-loading__badge" />
            </div>
          </div>
          <span className="skeleton detail-loading__summary" />
        </div>
        <div className="incident-facts detail-loading__facts">
          <div className="incident-facts__column incident-facts__column--primary">
            {FACT_ROWS.map((fact) => (
              <div key={fact}>
                <span className="skeleton detail-loading__fact-label" />
                <span className="skeleton detail-loading__fact-value" />
              </div>
            ))}
          </div>
          <div className="incident-facts__column incident-facts__column--secondary">
            {SECONDARY_FACT_ROWS.map((fact) => (
              <div key={fact}>
                <span className="skeleton detail-loading__fact-label" />
                <span className="skeleton detail-loading__fact-value" />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        className="incident-monitoring detail-loading__monitoring"
        aria-hidden="true"
      >
        <div className="monitoring-panels">
          {METRIC_PANELS.map((panel) => (
            <article
              className="metric-panel metric-panel--loading detail-loading__metric-panel"
              key={panel}
            >
              <header className="metric-panel__header">
                <span className="skeleton detail-loading__metric-title" />
                <span className="skeleton detail-loading__metric-window" />
              </header>
              <div className="metric-panel__summary detail-loading__metric-summary">
                {METRIC_SUMMARY_ITEMS.map((item) => (
                  <div key={item}>
                    <span className="skeleton detail-loading__metric-label" />
                    <span className="skeleton detail-loading__metric-value" />
                  </div>
                ))}
              </div>
              <span className="skeleton skeleton--chart" />
            </article>
          ))}
        </div>
      </section>

      <section
        className="run-controls detail-loading__run-controls"
        aria-hidden="true"
      >
        <div className="detail-loading__run-heading">
          <span className="skeleton detail-loading__eyebrow" />
          <span className="skeleton detail-loading__section-title" />
        </div>
        <div className="run-selector detail-loading__run-selector">
          <span className="skeleton detail-loading__run-option" />
          <span className="skeleton detail-loading__run-option" />
          <span className="skeleton detail-loading__run-option" />
        </div>
        <span className="skeleton detail-loading__action" />
      </section>

      <div className="console-grid detail-loading__console" aria-hidden="true">
        {CONSOLE_PANELS.map((panel) => (
          <section
            className="console-section detail-loading__console-panel"
            key={panel}
          >
            <div className="section-heading">
              <div className="detail-loading__console-heading">
                <span className="skeleton detail-loading__eyebrow" />
                <span className="skeleton detail-loading__section-title" />
              </div>
              <span className="skeleton detail-loading__badge" />
            </div>
            <div className="detail-loading__console-body">
              <span className="skeleton detail-loading__console-line" />
              <span className="skeleton detail-loading__console-line" />
              <span className="skeleton detail-loading__console-line detail-loading__console-line--short" />
            </div>
          </section>
        ))}
      </div>

      <section
        className="console-section detail-loading__evidence"
        aria-hidden="true"
      >
        <div className="section-heading">
          <div className="detail-loading__console-heading">
            <span className="skeleton detail-loading__eyebrow" />
            <span className="skeleton detail-loading__section-title" />
          </div>
          <span className="skeleton detail-loading__count" />
        </div>
        <div className="evidence-grid">
          {EVIDENCE_CARDS.map((card) => (
            <article
              className="evidence-card detail-loading__evidence-card"
              key={card}
            >
              <span className="skeleton detail-loading__evidence-title" />
              <span className="skeleton detail-loading__console-line" />
              <span className="skeleton detail-loading__evidence-code" />
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
