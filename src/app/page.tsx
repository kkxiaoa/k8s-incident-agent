import { Suspense } from "react";

import { IncidentList } from "@/components/incidents/incident-list";
import { ScenarioLauncher } from "@/components/incidents/scenario-launcher";
import {
  getIncidentIntakeMode,
  type IncidentIntakeMode,
} from "@/lib/agent-runtime/server-config";
import { loadIncidentConsoleOverview } from "@/lib/agent-runtime/server-view-data";

export const dynamic = "force-dynamic";

async function RuntimeOverview({
  intakeMode,
}: {
  intakeMode: IncidentIntakeMode;
}) {
  const overview = await loadIncidentConsoleOverview(intakeMode);
  const manualIntake = intakeMode === "manual";

  return (
    <section
      className={`home-console${manualIntake ? "" : " home-console--online"}`}
      aria-label="Incident Console"
    >
      {manualIntake ? (
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
          {overview.scenarios === null ? (
            <p className="page-alert" role="alert">
              暂时无法加载诊断场景，请稍后重试。
            </p>
          ) : (
            <ScenarioLauncher scenarios={overview.scenarios.items} />
          )}
        </article>
      ) : null}

      <article className="home-panel home-panel--incidents">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Persisted records</span>
            <h2>最近的 Incident</h2>
          </div>
          <span className="step-number">{manualIntake ? "02" : "01"}</span>
        </div>
        <p className="panel-intro">
          页面读取 Runtime 的业务状态；刷新后仍从持久化记录恢复。
        </p>
        {overview.incidents === null ? (
          <p className="page-alert" role="alert">
            暂时无法加载最近记录，请稍后重试。
          </p>
        ) : (
          <>
            <IncidentList incidents={overview.incidents.items} />
            {overview.incidents.hasMore ? (
              <p className="scope-note">当前显示最近 50 条 Incident。</p>
            ) : null}
          </>
        )}
      </article>
    </section>
  );
}

function RuntimeOverviewLoading({
  intakeMode,
}: {
  intakeMode: IncidentIntakeMode;
}) {
  const manualIntake = intakeMode === "manual";

  return (
    <section
      className={`home-console${manualIntake ? "" : " home-console--online"}`}
      aria-label="Incident Console 加载中"
    >
      {manualIntake ? (
        <article className="home-panel skeleton-panel">
          <span className="skeleton skeleton--short" />
          <span className="skeleton skeleton--title" />
          <span className="skeleton skeleton--line" />
          <span className="skeleton skeleton--control" />
        </article>
      ) : null}
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
  const intakeMode = getIncidentIntakeMode();

  return (
    <main className="page-shell home-page">
      <section className="hero">
        <div className="hero__copy">
          <span className="eyebrow eyebrow--hero">Kubernetes Incident Response</span>
          <h1>
            让每个结论，
            <span>都能回到证据。</span>
          </h1>
          <p>
            向受支持的真实 Kubernetes 环境，构建从故障发现、证据诊断到受控修复与恢复验证的
            Incident Agent。
          </p>
        </div>
        <aside className="boundary-card" aria-label="安全边界">
          <span className="boundary-card__index">BOUNDARY / 01</span>
          <h2>安全边界</h2>
          <ul>
            <li>浏览器只连接 Next.js BFF</li>
            <li>集群事实必须引用持久化 Evidence</li>
            <li>修复执行必须通过权限、策略、审批与审计门禁</li>
          </ul>
        </aside>
      </section>

      <Suspense fallback={<RuntimeOverviewLoading intakeMode={intakeMode} />}>
        <RuntimeOverview intakeMode={intakeMode} />
      </Suspense>
    </main>
  );
}
