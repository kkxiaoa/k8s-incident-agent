"use client";

import type {
  MonitoringHealthView,
  MonitoringPanelListView,
} from "@/lib/agent-runtime/response-contracts";

import { MetricPanelCard } from "./metric-panel-card";
import { MonitoringHealthOverview } from "./monitoring-health-overview";

export function IncidentMonitoringOverview({
  incidentId,
  targetLabel,
  panels,
  initialHealth,
  refreshKey,
}: {
  incidentId: string;
  targetLabel: string;
  panels: MonitoringPanelListView | null;
  initialHealth: MonitoringHealthView | null;
  refreshKey: string;
}) {
  return (
    <section className="incident-monitoring" aria-labelledby="incident-monitoring-heading">
      <header className="incident-monitoring__header">
        <div>
          <span className="eyebrow">Monitoring</span>
          <h2 id="incident-monitoring-heading">监控概览</h2>
        </div>
        <p>以下指标只属于当前 Incident 目标：{targetLabel}</p>
      </header>

      <MonitoringHealthOverview initialHealth={initialHealth} compact />

      {panels === null ? (
        <div className="monitoring-panels-state" role="alert">
          暂时无法读取当前 Incident 的指标目录。
        </div>
      ) : panels.panels.length === 0 ? (
        <div className="monitoring-panels-state" role="status">
          当前 Incident 的版本化来源没有可用指标 panel。
        </div>
      ) : (
        <div className="monitoring-panels">
          {panels.panels.map((panel) => (
            <MetricPanelCard
              key={panel.panelId}
              incidentId={incidentId}
              panel={panel}
              refreshKey={refreshKey}
            />
          ))}
        </div>
      )}
    </section>
  );
}
