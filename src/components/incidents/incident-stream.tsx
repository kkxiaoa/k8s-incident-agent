"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useReducer, useRef, useState } from "react";

import { LocalTimestamp } from "@/components/local-timestamp";
import {
  createRunFromBrowser,
  fetchIncidentFromBrowser,
  fetchRunEventsFromBrowser,
  fetchRunHistoryFromBrowser,
} from "@/lib/agent-runtime/browser-client";
import type {
  RunHistoryView,
  RunSummaryView,
} from "@/lib/agent-runtime/response-contracts";
import {
  RUN_EVENT_NAMES,
  createIncidentStreamState,
  parseRunEvent,
  reduceIncidentStream,
  requiresIncidentDetailRefresh,
  type IncidentDetailResponse,
} from "@/lib/agent-runtime/sse";
import {
  runStatusLabel,
  targetLabel,
} from "@/lib/agent-runtime/view-models";

import { DiagnosisPanel } from "./diagnosis-panel";
import { EvidenceList } from "./evidence-card";
import { IncidentStatusBadge, RunStatusBadge } from "./incident-status";
import { RunTimeline } from "./run-timeline";

function runSummary(detail: IncidentDetailResponse): RunSummaryView {
  const run = detail.selectedRun;
  return {
    id: run.id,
    attempt: run.attempt,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

function mergeRuns(
  current: RunSummaryView[],
  additions: RunSummaryView[],
): RunSummaryView[] {
  return Array.from(
    new Map([...current, ...additions].map((run) => [run.id, run])).values(),
  ).sort((left, right) => right.attempt - left.attempt);
}

function sourceLabel(detail: IncidentDetailResponse): string {
  const source = detail.incident.source;
  if (source.type === "alertmanager") {
    return `Alertmanager · ${source.ref} · catalog ${source.revision}`;
  }
  return `Scenario · ${source.ref} · v${source.revision}`;
}

export function IncidentStream({
  initialDetail,
  initialRuns,
  latestMode,
  manualActions,
}: {
  initialDetail: IncidentDetailResponse;
  initialRuns: RunHistoryView;
  latestMode: boolean;
  manualActions: boolean;
}) {
  const router = useRouter();
  const [state, dispatch] = useReducer(
    reduceIncidentStream,
    { detail: initialDetail, latestMode },
    ({ detail, latestMode: initialLatestMode }) =>
      createIncidentStreamState(detail, initialLatestMode),
  );
  const [runs, setRuns] = useState(() =>
    mergeRuns(initialRuns.items, [runSummary(initialDetail)]),
  );
  const [runCursor, setRunCursor] = useState(initialRuns.nextCursor);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [rerunPending, setRerunPending] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const selectedRunId = useRef(state.detail.selectedRun.id);

  useEffect(() => {
    selectedRunId.current = state.detail.selectedRun.id;
  }, [state.detail.selectedRun.id]);

  useEffect(() => {
    let active = true;
    let pendingRefreshEventId: string | null = null;
    let refreshInFlight = false;
    const query = new URLSearchParams({ cursor: initialDetail.eventCursor });
    const source = new EventSource(
      `/api/runtime/incidents/${encodeURIComponent(initialDetail.incident.id)}/events?${query}`,
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
            latestMode ? undefined : initialDetail.selectedRun.id,
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
            dispatch({ type: "snapshot", afterEventId, detail: result.data });
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
        event = parseRunEvent(
          message.type,
          message.lastEventId,
          message.data,
          initialDetail.incident.id,
        );
      } catch {
        source.close();
        dispatch({
          type: "invalid",
          message: "收到无法验证的运行事件，实时更新已停止。",
        });
        return;
      }

      dispatch({ type: "event", event });
      if (
        requiresIncidentDetailRefresh(
          event,
          selectedRunId.current,
          latestMode,
        )
      ) {
        scheduleDetailRefresh(event.id);
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
  }, [initialDetail.eventCursor, initialDetail.incident.id, initialDetail.selectedRun.id, latestMode]);

  const loadOlderRuns = async () => {
    if (runCursor === null || historyLoading) {
      return;
    }
    setHistoryLoading(true);
    setHistoryError(null);
    const result = await fetchRunHistoryFromBrowser(
      initialDetail.incident.id,
      runCursor,
    );
    if (result.ok) {
      setRuns((current) => mergeRuns(current, result.data.items));
      setRunCursor(result.data.nextCursor);
    } else {
      setHistoryError("暂时无法读取更早的诊断记录。");
    }
    setHistoryLoading(false);
  };

  const loadOlderEvents = async () => {
    const cursor = state.eventPageCursor;
    if (cursor === null || historyLoading) {
      return;
    }
    setHistoryLoading(true);
    setHistoryError(null);
    const result = await fetchRunEventsFromBrowser(
      initialDetail.incident.id,
      state.detail.selectedRun.id,
      cursor,
    );
    if (result.ok) {
      dispatch({
        type: "older_events",
        items: result.data.items,
        nextCursor: result.data.nextCursor,
      });
    } else {
      setHistoryError("暂时无法读取更早的运行事件。");
    }
    setHistoryLoading(false);
  };

  const createRun = async () => {
    if (rerunPending) {
      return;
    }
    setRerunPending(true);
    setRerunError(null);
    const result = await createRunFromBrowser(initialDetail.incident.id);
    if (result.ok) {
      router.replace(
        `/incidents/${encodeURIComponent(initialDetail.incident.id)}?runId=${encodeURIComponent(result.data.runId)}`,
      );
      router.refresh();
    } else {
      setRerunError("暂时无法开始新的诊断运行，请稍后重试。");
    }
    setRerunPending(false);
  };

  const { detail } = state;
  const visibleRuns = mergeRuns(runs, [runSummary(detail)]);
  const activeRun =
    detail.selectedRun.status === "QUEUED" ||
    detail.selectedRun.status === "RUNNING";

  return (
    <>
      <section className="incident-overview" aria-labelledby="incident-heading">
        <div className="incident-overview__main">
          <span className="eyebrow">Incident</span>
          <h1 id="incident-heading">{detail.incident.displayName}</h1>
          <p>{detail.incident.triggerSummary}</p>
          <div className="marker-row marker-row--spaced">
            <IncidentStatusBadge status={detail.incident.status} />
            <RunStatusBadge status={detail.selectedRun.status} />
          </div>
        </div>
        <dl className="incident-facts">
          <div>
            <dt>目标</dt>
            <dd>{targetLabel(detail.incident.target)}</dd>
          </div>
          <div>
            <dt>来源</dt>
            <dd>{sourceLabel(detail)}</dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd><LocalTimestamp timestamp={detail.incident.createdAt} /></dd>
          </div>
          {detail.alertSignal === null ? null : (
            <div>
              <dt>告警信号</dt>
              <dd
                title={
                  detail.alertSignal.status === "RESOLVED"
                    ? "Alertmanager 已报告 resolved；不代表 Incident 关闭或恢复验证完成。"
                    : undefined
                }
              >
                {detail.alertSignal.status === "FIRING"
                  ? "告警触发中"
                  : "告警条件解除"}
                {detail.alertSignal.endsAt === null ? null : (
                  <> · <LocalTimestamp timestamp={detail.alertSignal.endsAt} /></>
                )}
              </dd>
            </div>
          )}
          <div>
            <dt>Incident ID</dt>
            <dd className="mono-break">{detail.incident.id}</dd>
          </div>
        </dl>
      </section>

      <section className="run-controls" aria-labelledby="run-controls-heading">
        <div>
          <span className="eyebrow">Diagnosis history</span>
          <h2 id="run-controls-heading">诊断运行</h2>
        </div>
        <nav className="run-selector" aria-label="诊断运行选择">
          <Link
            href={`/incidents/${detail.incident.id}`}
            className={latestMode ? "run-selector__item is-selected" : "run-selector__item"}
          >
            最新
          </Link>
          {visibleRuns.map((run) => (
            <Link
              key={run.id}
              href={`/incidents/${detail.incident.id}?runId=${encodeURIComponent(run.id)}`}
              className={
                !latestMode && run.id === detail.selectedRun.id
                  ? "run-selector__item is-selected"
                  : "run-selector__item"
              }
            >
              第 {run.attempt} 次 · {runStatusLabel(run.status)}
            </Link>
          ))}
        </nav>
        <div className="run-controls__actions">
          {runCursor === null ? null : (
            <button className="secondary-button" type="button" onClick={loadOlderRuns} disabled={historyLoading}>
              加载更早记录
            </button>
          )}
          {manualActions && latestMode ? (
            <button className="primary-button" type="button" onClick={createRun} disabled={rerunPending || activeRun}>
              {rerunPending ? "正在创建…" : "重新诊断"}
            </button>
          ) : null}
        </div>
      </section>

      {state.streamError === null ? null : (
        <p className="page-alert page-alert--danger" role="alert">{state.streamError}</p>
      )}
      {state.refreshError === null ? null : (
        <p className="page-alert" role="status">{state.refreshError}</p>
      )}
      {historyError === null ? null : (
        <p className="page-alert" role="status">{historyError}</p>
      )}
      {rerunError === null ? null : (
        <p className="page-alert page-alert--danger" role="alert">{rerunError}</p>
      )}

      <div className="console-grid">
        <div>
          {state.eventPageCursor === null ? null : (
            <button className="timeline-history-button" type="button" onClick={loadOlderEvents} disabled={historyLoading}>
              加载更早事件
            </button>
          )}
          <RunTimeline events={state.events} connection={state.connection} />
        </div>
        <DiagnosisPanel
          diagnosis={detail.diagnosis}
          runStatus={detail.selectedRun.status}
          runError={detail.selectedRun.error}
        />
      </div>

      <EvidenceList evidence={detail.evidence} />
    </>
  );
}
