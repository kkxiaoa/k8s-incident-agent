"use client";

import { useEffect, useReducer } from "react";

import { LocalTimestamp } from "@/components/local-timestamp";
import { fetchIncidentFromBrowser } from "@/lib/agent-runtime/browser-client";
import {
  RUN_EVENT_NAMES,
  createIncidentStreamState,
  isTerminalRunEvent,
  parseRunEvent,
  reduceIncidentStream,
  requiresIncidentDetailRefresh,
  type IncidentDetailResponse,
} from "@/lib/agent-runtime/sse";
import { targetLabel } from "@/lib/agent-runtime/view-models";

import { DiagnosisPanel } from "./diagnosis-panel";
import { EvidenceList } from "./evidence-card";
import { IncidentStatusBadge, RunStatusBadge } from "./incident-status";
import { RunTimeline } from "./run-timeline";

export function IncidentStream({
  initialDetail,
}: {
  initialDetail: IncidentDetailResponse;
}) {
  const [state, dispatch] = useReducer(
    reduceIncidentStream,
    initialDetail,
    createIncidentStreamState,
  );

  useEffect(() => {
    let active = true;
    let pendingRefreshEventId: string | null = null;
    let refreshInFlight = false;
    const source = new EventSource(
      `/api/runtime/incidents/${encodeURIComponent(initialDetail.incident.id)}/events`,
    );

    source.onopen = () => dispatch({ type: "connected" });
    source.onerror = () => dispatch({ type: "disconnected" });

    const refreshLatestDetail = async () => {
      if (refreshInFlight) {
        return;
      }

      refreshInFlight = true;
      try {
        while (active && pendingRefreshEventId !== null) {
          const afterEventId = pendingRefreshEventId;
          pendingRefreshEventId = null;
          const result = await fetchIncidentFromBrowser(
            initialDetail.incident.id,
          );
          if (!active) {
            return;
          }
          if (!result.ok) {
            dispatch({
              type: "refresh_failed",
              afterEventId,
              message: "无法刷新持久化详情；实时事件仍保留在时间线中。",
            });
          } else {
            dispatch({
              type: "snapshot",
              afterEventId,
              detail: result.data,
            });
          }
        }
      } finally {
        refreshInFlight = false;
      }
    };

    const scheduleDetailRefresh = (afterEventId: string) => {
      pendingRefreshEventId = afterEventId;
      void refreshLatestDetail();
    };

    const receiveEvent = (rawEvent: Event) => {
      const message = rawEvent as MessageEvent<string>;
      let event;
      try {
        event = parseRunEvent(message.type, message.lastEventId, message.data);
      } catch {
        source.close();
        dispatch({
          type: "invalid",
          message: "收到无法验证的运行事件，实时更新已停止。",
        });
        return;
      }

      dispatch({ type: "event", event });

      const terminal = isTerminalRunEvent(event);
      if (requiresIncidentDetailRefresh(event)) {
        scheduleDetailRefresh(event.id);
      }

      if (terminal) {
        source.close();
      }
    };

    for (const eventName of RUN_EVENT_NAMES) {
      source.addEventListener(eventName, receiveEvent);
    }

    return () => {
      active = false;
      pendingRefreshEventId = null;
      for (const eventName of RUN_EVENT_NAMES) {
        source.removeEventListener(eventName, receiveEvent);
      }
      source.close();
    };
  }, [initialDetail.incident.id]);

  const { detail } = state;

  return (
    <>
      <section className="incident-overview" aria-labelledby="incident-heading">
        <div className="incident-overview__main">
          <span className="eyebrow">Incident</span>
          <h1 id="incident-heading">{detail.incident.displayName}</h1>
          <p>{detail.incident.triggerSummary}</p>
          <div className="marker-row marker-row--spaced">
            <IncidentStatusBadge status={detail.incident.status} />
            <RunStatusBadge status={detail.run.status} />
          </div>
        </div>
        <dl className="incident-facts">
          <div>
            <dt>目标</dt>
            <dd>{targetLabel(detail.incident.target)}</dd>
          </div>
          <div>
            <dt>Scenario</dt>
            <dd>
              {detail.incident.scenarioId} · v{detail.incident.scenarioVersion}
            </dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>
              <LocalTimestamp timestamp={detail.incident.createdAt} />
            </dd>
          </div>
          <div>
            <dt>Incident ID</dt>
            <dd className="mono-break">{detail.incident.id}</dd>
          </div>
        </dl>
      </section>

      {state.streamError === null ? null : (
        <p className="page-alert page-alert--danger" role="alert">
          {state.streamError}
        </p>
      )}
      {state.refreshError === null ? null : (
        <p className="page-alert" role="status">
          {state.refreshError}
        </p>
      )}

      <div className="console-grid">
        <RunTimeline events={state.events} connection={state.connection} />
        <DiagnosisPanel
          diagnosis={detail.diagnosis}
          incidentStatus={detail.incident.status}
          runError={detail.run.error}
        />
      </div>

      <EvidenceList evidence={detail.evidence} />
    </>
  );
}
