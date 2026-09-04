"use client";

import { useCallback, useState } from "react";

import { UiIcon } from "@/components/ui/ui-icon";
import type {
  AlertSignalView,
  EvidenceView,
  MonitoringPanelListView,
} from "@/lib/agent-runtime/response-contracts";
import { incidentDesiredReplicas } from "@/lib/agent-runtime/view-models";

import {
  MetricPanelCard,
  type MetricPanelLoadSnapshot,
} from "./metric-panel-card";

function isUnavailable(snapshot: MetricPanelLoadSnapshot | undefined): boolean {
  return (
    snapshot?.state === "error" ||
    (snapshot?.state === "ready" &&
      (snapshot.result.state === "query_error" ||
        snapshot.result.state === "monitoring_unavailable"))
  );
}

export function IncidentMonitoringOverview({
  incidentId,
  panels,
  evidence,
  refreshKey,
  alertStatus = null,
}: {
  incidentId: string;
  panels: MonitoringPanelListView | null;
  evidence: EvidenceView[];
  refreshKey: string;
  alertStatus?: AlertSignalView["status"] | null;
}) {
  const desiredReplicas = incidentDesiredReplicas(evidence);
  const [panelLoads, setPanelLoads] = useState<
    Record<string, MetricPanelLoadSnapshot>
  >({});
  const updatePanelLoad = useCallback(
    (panelId: string, snapshot: MetricPanelLoadSnapshot) => {
      setPanelLoads((current) => ({ ...current, [panelId]: snapshot }));
    },
    [],
  );
  const allPanelsUnavailable =
    panels !== null &&
    panels.panels.length > 0 &&
    panels.panels.every((panel) => isUnavailable(panelLoads[panel.panelId]));

  return (
    <section className="incident-monitoring" aria-label="Incident 指标">
      {allPanelsUnavailable ? (
        <div className="monitoring-data-alert" role="status">
          <div>
            <strong>指标数据暂不可用</strong>
            <span>当前值与趋势未展示。</span>
          </div>
        </div>
      ) : null}

      {panels === null ? (
        <div className="monitoring-panels-state" role="alert">
          <UiIcon name="activity" />
          <div>
            <strong>监控数据暂不可用</strong>
            <span>当前 Incident 的指标图表未展示。</span>
          </div>
        </div>
      ) : panels.panels.length === 0 ? (
        <div className="monitoring-panels-state" role="status">
          <UiIcon name="activity" />
          <div>
            <strong>暂无指标图表</strong>
            <span>当前 Incident 没有匹配的监控面板。</span>
          </div>
        </div>
      ) : (
        <div
          className={`monitoring-panels${
            panels.panels.length === 1 ? " monitoring-panels--single" : ""
          }`}
        >
          {panels.panels.map((panel) => (
            <MetricPanelCard
              key={panel.panelId}
              incidentId={incidentId}
              panel={panel}
              refreshKey={refreshKey}
              alertStatus={
                panel.signalRole === "trigger" ? alertStatus : null
              }
              desiredReplicas={desiredReplicas}
              onLoadSnapshot={updatePanelLoad}
            />
          ))}
        </div>
      )}
    </section>
  );
}
