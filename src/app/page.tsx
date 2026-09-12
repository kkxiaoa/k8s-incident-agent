import { Suspense } from "react";
import { headers } from "next/headers";

import { IncidentList } from "@/components/incidents/incident-list";
import { ScenarioLauncher } from "@/components/incidents/scenario-launcher";
import { HomeMonitoringDashboard } from "@/components/monitoring/home-monitoring-dashboard";
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
  const incoming = new Headers({ cookie: (await headers()).get("cookie") ?? "" });
  const overview = await loadIncidentConsoleOverview(intakeMode, incoming);
  const manualIntake = intakeMode === "manual";

  return (
    <>
      <HomeMonitoringDashboard
        runtimeHealth={overview.runtimeHealth}
        initialHealth={overview.monitoringHealth}
        initialOverview={overview.monitoringOverview}
      />

      <section className="recent-incidents" aria-labelledby="recent-incidents-heading">
        <header className="recent-incidents__header">
          <div>
            <span className="eyebrow">Persisted records</span>
            <h2 id="recent-incidents-heading">最近 Incident</h2>
          </div>
          {overview.incidents !== null && overview.incidents.nextCursor !== null ? (
            <span>显示最近 50 条</span>
          ) : null}
        </header>
        <div className="recent-incidents__body">
          {overview.incidents === null ? (
            <p className="page-alert" role="alert">
              暂时无法加载最近记录，请稍后重试。
            </p>
          ) : (
            <>
              <IncidentList incidents={overview.incidents.items} />
            </>
          )}
        </div>
      </section>

      {manualIntake ? (
        <section className="developer-intake" aria-labelledby="developer-intake-heading">
          <header>
            <div>
              <span className="eyebrow">Development only</span>
              <h2 id="developer-intake-heading">离线评估入口</h2>
            </div>
            <p>仅在 manual intake 模式下使用版本化场景创建只读诊断。</p>
          </header>
          {overview.scenarios === null ? (
            <p className="page-alert" role="alert">
              暂时无法加载诊断场景，请稍后重试。
            </p>
          ) : (
            <ScenarioLauncher scenarios={overview.scenarios.items} />
          )}
        </section>
      ) : null}
    </>
  );
}

function RuntimeOverviewLoading({
  intakeMode,
}: {
  intakeMode: IncidentIntakeMode;
}) {
  const manualIntake = intakeMode === "manual";

  return (
    <>
      <section
        className="home-monitoring home-monitoring--loading"
        aria-busy="true"
        aria-label="运行概览加载中"
      >
        <div className="home-monitoring__toolbar" aria-hidden="true">
          <span className="skeleton skeleton--overview-updated" />
          <span className="skeleton skeleton--overview-refresh" />
        </div>
        <div className="home-monitoring__status-grid">
          <article
            className="monitoring-health monitoring-health--loading"
            aria-hidden="true"
          >
            <ol className="monitoring-health__path">
              {Array.from({ length: 5 }, (_, index) => (
                <li className="monitoring-health__node" key={index}>
                  <span className="skeleton skeleton--health-node" />
                  <span className="skeleton skeleton--health-label" />
                </li>
              ))}
            </ol>
          </article>
          <div className="overview-counts" aria-hidden="true">
            {Array.from({ length: 4 }, (_, index) => (
              <article
                className="overview-count overview-count--loading"
                key={index}
              >
                <span className="skeleton skeleton--count-label" />
                <span className="skeleton skeleton--count-value" />
              </article>
            ))}
          </div>
        </div>
        <div className="home-monitoring__charts" aria-hidden="true">
          {Array.from({ length: 2 }, (_, index) => (
            <article className="chart-card chart-card--loading" key={index}>
              <header className="chart-card__header">
                <div>
                  <span className="skeleton skeleton--chart-title" />
                  <span className="skeleton skeleton--chart-subtitle" />
                </div>
                {index === 1 ? (
                  <span className="skeleton skeleton--chart-window" />
                ) : null}
              </header>
              <span className="skeleton skeleton--overview-chart" />
            </article>
          ))}
        </div>
      </section>
      <section
        className="recent-incidents recent-incidents--loading"
        aria-busy="true"
        aria-label="最近 Incident 加载中"
      >
        <header className="recent-incidents__header" aria-hidden="true">
          <div>
            <span className="skeleton skeleton--section-eyebrow" />
            <span className="skeleton skeleton--section-title" />
          </div>
          <span className="skeleton skeleton--recent-meta" />
        </header>
        <div className="recent-incidents__body">
          <div className="incident-table-skeleton" aria-hidden="true">
            <div className="incident-table-skeleton__header">
              {Array.from({ length: 5 }, (_, index) => (
                <span className="skeleton" key={index} />
              ))}
            </div>
            {Array.from({ length: 4 }, (_, rowIndex) => (
              <div className="incident-table-skeleton__row" key={rowIndex}>
                {Array.from({ length: 5 }, (_, cellIndex) => (
                  <span className="skeleton" key={cellIndex} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>
      {manualIntake ? (
        <section
          className="developer-intake developer-intake--loading"
          aria-busy="true"
          aria-label="离线评估入口加载中"
        >
          <header aria-hidden="true">
            <div>
              <span className="skeleton skeleton--section-eyebrow" />
              <span className="skeleton skeleton--section-title" />
            </div>
            <p>
              <span className="skeleton skeleton--intake-description" />
            </p>
          </header>
          <div
            className="scenario-launcher scenario-launcher--loading"
            aria-hidden="true"
          >
            <span className="skeleton skeleton--field-label" />
            <span className="skeleton skeleton--scenario-select" />
            <span className="skeleton skeleton--scenario-copy" />
            <span className="skeleton skeleton--scenario-action" />
          </div>
        </section>
      ) : null}
    </>
  );
}

export default function Home() {
  const intakeMode = getIncidentIntakeMode();

  return (
    <main className="page-shell home-page">
      <header className="home-heading">
        <span className="eyebrow">Kubernetes Incident Response</span>
        <h1>运行概览</h1>
        <p>
          向受支持的真实 Kubernetes 环境，构建从故障发现、证据诊断到受控修复与恢复验证的
          Incident Agent。
        </p>
      </header>

      <Suspense fallback={<RuntimeOverviewLoading intakeMode={intakeMode} />}>
        <RuntimeOverview intakeMode={intakeMode} />
      </Suspense>
    </main>
  );
}
