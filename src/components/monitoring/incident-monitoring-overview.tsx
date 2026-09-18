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
  type MetricPanelAnchor,
  type MetricPanelLoadSnapshot,
} from "./metric-panel-card";

/** The Run the operator is viewing; anchors the charts when it is history. */
export interface MonitoringSelectedRun {
  id: string;
  attempt: number;
  completedAt: string | null;
}

export function monitoringPanelAnchor(
  selectedRun: MonitoringSelectedRun | null,
  latestRunId: string | null,
): MetricPanelAnchor {
  return selectedRun !== null &&
    latestRunId !== null &&
    selectedRun.id !== latestRunId &&
    selectedRun.completedAt !== null
    ? { kind: "run", runId: selectedRun.id, attempt: selectedRun.attempt }
    : { kind: "current" };
}

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
  selectedRun = null,
  latestRunId = null,
}: {
  incidentId: string;
  panels: MonitoringPanelListView | null;
  evidence: EvidenceView[];
  refreshKey: string;
  alertStatus?: AlertSignalView["status"] | null;
  selectedRun?: MonitoringSelectedRun | null;
  latestRunId?: string | null;
}) {
  const desiredReplicas = incidentDesiredReplicas(evidence);
  const anchor = monitoringPanelAnchor(selectedRun, latestRunId);
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

  const explainRoles =
    panels !== null &&
    panels.panels.length > 1 &&
    panels.panels.some((panel) => panel.signalRole === "trigger");

  return (
    <section className="incident-monitoring" aria-label="Incident 指标">
      {explainRoles ? (
        <p className="monitoring-panels__roles">
          触发指标是这条告警登记的信号，取值近似它的判定条件；上下文指标描述同一目标的运行状况，用来解释现象，不能证明告警条件成立或已解除。
        </p>
      ) : null}
      {allPanelsUnavailable ? (
        <div className="monitoring-data-alert" role="status">
          <div>
            <strong>指标数据暂不可用</strong>
            <span>当前值与趋势未展示。</span>
          </div>
        </div>
      ) : null}

      {panels === null ? (
        <article className="metric-panel metric-panel--placeholder">
          <header className="metric-panel__header">
            <div className="metric-panel__title">
              <h3>监控指标</h3>
            </div>
          </header>
          <div className="monitoring-panels-state" role="alert">
            <UiIcon name="activity" />
            <div>
              <strong>监控数据暂不可用</strong>
              <span>当前 Incident 的指标图表未展示。</span>
            </div>
          </div>
        </article>
      ) : panels.panels.length === 0 ? (
        <article className="metric-panel metric-panel--placeholder">
          <header className="metric-panel__header">
            <div className="metric-panel__title">
              <h3>监控指标</h3>
            </div>
          </header>
          <div className="monitoring-panels-state" role="status">
            <UiIcon name="activity" />
            <div>
              <strong>暂无指标图表</strong>
              <span>当前 Incident 没有匹配的监控面板。</span>
            </div>
          </div>
        </article>
      ) : (
        <div
          className={`monitoring-panels${
            panels.panels.length === 1 ? " monitoring-panels--single" : ""
          }`}
        >
          {[...panels.panels]
            .sort((left, right) =>
              left.signalRole === right.signalRole
                ? 0
                : left.signalRole === "trigger"
                  ? -1
                  : 1,
            )
            .map((panel) => (
              <MetricPanelCard
                  key={panel.panelId}
                  incidentId={incidentId}
                  panel={panel}
                  refreshKey={refreshKey}
                  anchor={anchor}
                  alertStatus={
                    panel.signalRole === "trigger" && anchor.kind === "current"
                      ? alertStatus
                      : null
                  }
                  desiredReplicas={desiredReplicas}
                  onLoadSnapshot={updatePanelLoad}
                  lead={panel.signalRole === "trigger"}
                />
            ))}
        </div>
      )}
    </section>
  );
}
