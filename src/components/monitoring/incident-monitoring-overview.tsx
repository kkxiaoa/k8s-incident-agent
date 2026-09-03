"use client";

import { useCallback, useState } from "react";

import type {
  AlertSignalView,
  EvidenceView,
  MetricPanelResultView,
  MonitoringHealthView,
  MonitoringPanelListView,
} from "@/lib/agent-runtime/response-contracts";
import { incidentMonitoringFacts } from "@/lib/agent-runtime/view-models";

import {
  MetricPanelCard,
  type MetricPanelLoadSnapshot,
} from "./metric-panel-card";
import { MetricInfo } from "./metric-info";
import { metricRiskDescription } from "./metric-presentation";
import { MonitoringHealthOverview } from "./monitoring-health-overview";
import { MetricSparkline } from "./time-series-chart";

function summaryValue(
  result: MetricPanelResultView,
  riskDirection: "higher_is_worse" | "lower_is_worse",
  desiredReplicas: number | null,
): string {
  if (result.currentValue === null) {
    return "—";
  }
  if (
    riskDirection === "lower_is_worse" &&
    result.unit === "replicas" &&
    desiredReplicas !== null
  ) {
    return `${result.currentValue}/${desiredReplicas}`;
  }
  return String(result.currentValue);
}

export function IncidentMonitoringOverview({
  incidentId,
  targetLabel,
  panels,
  evidence,
  initialHealth,
  refreshKey,
  alertStatus = null,
}: {
  incidentId: string;
  targetLabel: string;
  panels: MonitoringPanelListView | null;
  evidence: EvidenceView[];
  initialHealth: MonitoringHealthView | null;
  refreshKey: string;
  alertStatus?: AlertSignalView["status"] | null;
}) {
  const facts = incidentMonitoringFacts(evidence);
  const [panelLoads, setPanelLoads] = useState<
    Record<string, MetricPanelLoadSnapshot>
  >({});
  const updatePanelLoad = useCallback(
    (panelId: string, snapshot: MetricPanelLoadSnapshot) => {
      setPanelLoads((current) => ({ ...current, [panelId]: snapshot }));
    },
    [],
  );
  const waitingReason =
    facts.waitingReasons === null
      ? "等待证据"
      : facts.waitingReasons.length === 0
        ? "未观察到等待状态"
        : facts.waitingReasons.join("、");

  return (
    <section className="incident-monitoring" aria-labelledby="incident-monitoring-heading">
      <header className="incident-monitoring__header">
        <div>
          <span className="eyebrow">Monitoring</span>
          <h2 id="incident-monitoring-heading">监控概览</h2>
        </div>
        <p>以下指标只属于当前 Incident 目标：{targetLabel}</p>
      </header>

      <div className="incident-monitoring__summary-grid">
        <MonitoringHealthOverview initialHealth={initialHealth} compact />
        <div className="incident-metric-facts">
          {(panels?.panels.slice(0, 2) ?? []).map((panel) => {
            const load = panelLoads[panel.panelId];
            const result = load?.state === "ready" ? load.result : null;
            return (
              <article key={panel.panelId}>
                {load?.state === "loading" || load === undefined ? (
                  <>
                    <span className="skeleton skeleton--mini-label" />
                    <strong className="skeleton skeleton--mini-value" />
                  </>
                ) : result === null ? (
                  <>
                    <span>指标暂不可用</span>
                    <strong>—</strong>
                  </>
                ) : (
                  <>
                    <span className="incident-metric-facts__label">
                      {result.title}
                      <MetricInfo
                        label={metricRiskDescription(
                          result.title,
                          panel.riskDirection,
                          result.unit,
                        )}
                      />
                    </span>
                    <strong>
                      {summaryValue(
                        result,
                        panel.riskDirection,
                        facts.desiredReplicas,
                      )}
                    </strong>
                    <MetricSparkline
                      result={result}
                      riskDirection={panel.riskDirection}
                    />
                  </>
                )}
              </article>
            );
          })}
          <article>
            <span className="incident-metric-facts__label">
              等待原因
              <MetricInfo label="来自诊断 Evidence 中 Pod 容器的 waiting.reason，不是 Prometheus 指标或模型推断。" />
            </span>
            <strong>{waitingReason}</strong>
          </article>
        </div>
      </div>

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
              alertStatus={alertStatus}
              desiredReplicas={facts.desiredReplicas}
              onLoadSnapshot={updatePanelLoad}
            />
          ))}
        </div>
      )}
    </section>
  );
}
