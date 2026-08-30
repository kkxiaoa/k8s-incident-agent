export default function IncidentLoading() {
  return (
    <main className="page-shell detail-page" aria-busy="true" aria-label="Incident 加载中">
      <div className="skeleton skeleton--short" />
      <section className="incident-overview skeleton-panel">
        <div>
          <span className="skeleton skeleton--short" />
          <span className="skeleton skeleton--hero-title" />
          <span className="skeleton skeleton--line" />
        </div>
        <div>
          <span className="skeleton skeleton--line" />
          <span className="skeleton skeleton--line" />
          <span className="skeleton skeleton--line" />
        </div>
      </section>
    </main>
  );
}
