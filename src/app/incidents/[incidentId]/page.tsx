import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";

import { IncidentStream } from "@/components/incidents/incident-stream";
import { getIncidentIntakeMode } from "@/lib/agent-runtime/server-config";
import { loadIncidentPage } from "@/lib/agent-runtime/server-view-data";

interface IncidentPageProps {
  params: Promise<{ incidentId: string }>;
  searchParams: Promise<{ runId?: string | string[] }>;
}

export const metadata: Metadata = {
  title: "Incident Console",
};

export default async function IncidentPage({ params, searchParams }: IncidentPageProps) {
  const { incidentId } = await params;
  const requestedRunId = (await searchParams).runId;
  const runId =
    typeof requestedRunId === "string"
      ? requestedRunId
      : requestedRunId === undefined
        ? undefined
        : "invalid";
  const incoming = new Headers({ cookie: (await headers()).get("cookie") ?? "" });
  const pageData = await loadIncidentPage(incidentId, runId, incoming);
  const missing = pageData.state === "missing";

  return (
    <main className="page-shell detail-page">
      {pageData.state !== "ready" ? (
        <>
          <nav className="breadcrumb" aria-label="面包屑">
            <Link href="/">Incident 列表</Link>
            <span aria-hidden="true">/</span>
            <span>Incident 详情</span>
          </nav>
          <section className="unavailable-panel">
            <h1>{missing ? "未找到相关记录" : pageData.state === "invalid" ? "详情数据校验失败" : "页面暂时不可用"}</h1>
            <p>
              {missing
                ? "记录可能不存在，或已被清理。"
                : pageData.state === "invalid"
                  ? "返回的详情不符合数据契约，无法展示可信的诊断与修复验证结果。"
                  : "暂时无法显示所需内容，请稍后重试。"}
            </p>
            <Link className="secondary-button" href="/">
              返回 Incident Console
            </Link>
          </section>
        </>
      ) : (
        <IncidentStream
          key={`${pageData.detail.selectedRun.id}:${runId === undefined ? "latest" : "history"}`}
          initialDetail={pageData.detail}
          initialRuns={pageData.runs}
          monitoringPanels={pageData.monitoringPanels}
          latestMode={runId === undefined}
          manualActions={getIncidentIntakeMode() === "manual"}
        />
      )}
    </main>
  );
}
