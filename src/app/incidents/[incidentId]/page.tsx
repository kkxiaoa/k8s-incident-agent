import type { Metadata } from "next";
import Link from "next/link";

import { IncidentStream } from "@/components/incidents/incident-stream";
import { loadIncidentPage } from "@/lib/agent-runtime/server-view-data";

interface IncidentPageProps {
  params: Promise<{ incidentId: string }>;
}

export const metadata: Metadata = {
  title: "Incident Console",
};

export default async function IncidentPage({ params }: IncidentPageProps) {
  const { incidentId } = await params;
  const pageData = await loadIncidentPage(incidentId);
  const missing = pageData.state === "missing";

  return (
    <main className="page-shell detail-page">
      <nav className="breadcrumb" aria-label="面包屑">
        <Link href="/">Incident Console</Link>
        <span aria-hidden="true">/</span>
        <span>Detail</span>
      </nav>

      {pageData.state !== "ready" ? (
        <section className="unavailable-panel">
          <h1>{missing ? "未找到相关记录" : "页面暂时不可用"}</h1>
          <p>
            {missing
              ? "记录可能不存在，或已被清理。"
              : "暂时无法显示所需内容，请稍后重试。"}
          </p>
          <Link className="secondary-button" href="/">
            返回 Incident Console
          </Link>
        </section>
      ) : (
        <IncidentStream initialDetail={pageData.detail} />
      )}
    </main>
  );
}
