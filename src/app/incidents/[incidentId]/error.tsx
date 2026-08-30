"use client";

export default function IncidentError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="page-shell detail-page">
      <section className="unavailable-panel">
        <h1>页面暂时不可用</h1>
        <p>暂时无法显示所需内容，请稍后重试。</p>
        <button className="secondary-button" type="button" onClick={retry}>
          重新读取
        </button>
      </section>
    </main>
  );
}
