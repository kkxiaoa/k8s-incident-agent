import { Suspense } from "react";

import { IncidentList } from "@/components/incidents/incident-list";
import { ScenarioLauncher } from "@/components/incidents/scenario-launcher";
import { loadIncidentConsoleOverview } from "@/lib/agent-runtime/server-view-data";

export const dynamic = "force-dynamic";

async function RuntimeOverview() {
  const { scenarios, incidents } = await loadIncidentConsoleOverview();

  return (
    <section className="home-console" aria-label="Incident Console">
      <article className="home-panel home-panel--launcher">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Manual trigger</span>
            <h2>启动只读诊断</h2>
          </div>
          <span className="step-number">01</span>
        </div>
        <p className="panel-intro">
          选择版本化场景。Runtime 会创建持久化 Incident 与受预算约束的诊断 Run。
        </p>
        {scenarios === null ? (
          <p className="page-alert" role="alert">
            暂时无法加载诊断场景，请稍后重试。
          </p>
        ) : (
          <ScenarioLauncher scenarios={scenarios.items} />
        )}
      </article>

      <article className="home-panel home-panel--incidents">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Persisted records</span>
            <h2>最近的 Incident</h2>
          </div>
          <span className="step-number">02</span>
        </div>
        <p className="panel-intro">
          页面读取 Runtime 的业务状态；刷新后仍从持久化记录恢复。
        </p>
        {incidents === null ? (
          <p className="page-alert" role="alert">
            暂时无法加载最近记录，请稍后重试。
          </p>
        ) : (
          <>
            <IncidentList incidents={incidents.items} />
            {incidents.hasMore ? (
              <p className="scope-note">当前显示最近 50 条 Incident。</p>
            ) : null}
          </>
        )}
      </article>
    </section>
  );
}

function RuntimeOverviewLoading() {
  return (
    <section className="home-console" aria-label="Incident Console 加载中">
      <article className="home-panel skeleton-panel">
        <span className="skeleton skeleton--short" />
        <span className="skeleton skeleton--title" />
        <span className="skeleton skeleton--line" />
        <span className="skeleton skeleton--control" />
      </article>
      <article className="home-panel skeleton-panel">
        <span className="skeleton skeleton--short" />
        <span className="skeleton skeleton--title" />
        <span className="skeleton skeleton--line" />
        <span className="skeleton skeleton--card" />
      </article>
    </section>
  );
}

export default function Home() {
  return (
    <main className="page-shell home-page">
      <section className="hero">
        <div className="hero__copy">
          <span className="eyebrow eyebrow--hero">Stage 1 · Image Pull Diagnosis</span>
          <h1>
            让每个结论，
            <span>都能回到证据。</span>
          </h1>
          <p>
            面向本地 Kind 沙箱的 Kubernetes 运行期故障响应。确定性状态机管理 Incident，
            诊断 Agent 只选择类型化只读工具。
          </p>
        </div>
        <aside className="boundary-card" aria-label="当前安全边界">
          <span className="boundary-card__index">BOUNDARY / 01</span>
          <h2>当前安全边界</h2>
          <ul>
            <li>浏览器只连接 Next.js BFF</li>
            <li>集群事实必须引用持久化 Evidence</li>
            <li>当前切片不提供集群写操作</li>
          </ul>
        </aside>
      </section>

      <Suspense fallback={<RuntimeOverviewLoading />}>
        <RuntimeOverview />
      </Suspense>
    </main>
  );
}
