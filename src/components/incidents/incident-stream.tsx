"use client";

import { checkOperatorSession } from "@/lib/agent-runtime/operator-client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useReducer, useRef, useState } from "react";

import { LocalTimestamp } from "@/components/local-timestamp";
import { IncidentMonitoringOverview } from "@/components/monitoring/incident-monitoring-overview";
import {
  createRunFromBrowser,
  prepareRepairFromBrowser,
  decideRepairFromBrowser,
  fetchIncidentFromBrowser,
  fetchRunEventsFromBrowser,
  fetchRunHistoryFromBrowser,
} from "@/lib/agent-runtime/browser-client";
import type {
  RunHistoryView,
  RunSummaryView,
  MonitoringPanelListView,
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
  ACTION_UNAVAILABLE_LABELS,
  targetLabel,
} from "@/lib/agent-runtime/view-models";

import { DiagnosisPanel } from "./diagnosis-panel";
import { EvidenceList } from "./evidence-card";
import { IncidentStatusBadge, RunStatusBadge } from "./incident-status";
import { RunTimeline } from "./run-timeline";
import { IncidentProgress } from "./incident-progress";
import { useSourceDiagnosis } from "./use-source-diagnosis";
import { RepairPanel } from "./repair-panel";
import { RepairActions, type RepairActionCommand } from "./repair-actions";
import { ApprovalWindowProvider } from "./approval-countdown";
import { ShimmerText } from "@/components/ui/shimmer-text";

function runSummary(detail: IncidentDetailResponse): RunSummaryView {
  const run = detail.selectedRun;
  return {
    id: run.id,
    kind: run.kind,
    operation: run.operation,
    attempt: run.attempt,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    requestSource: run.requestSource,
    sourceRunId: run.sourceRunId,
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

function latestActivityAt(
  detail: IncidentDetailResponse,
  events: ReadonlyArray<{ data: { occurredAt: string } }>,
): string {
  const timestamps = [
    detail.incident.createdAt,
    detail.selectedRun.createdAt,
    detail.selectedRun.startedAt,
    detail.selectedRun.completedAt,
    detail.alertSignal?.startsAt,
    detail.alertSignal?.endsAt,
    ...detail.evidence.map((item) => item.observedAt),
    ...events.map((event) => event.data.occurredAt),
  ];
  return timestamps.reduce<string>((latest, value) => {
    if (value === null || value === undefined) {
      return latest;
    }
    return Date.parse(value) > Date.parse(latest) ? value : latest;
  }, detail.incident.createdAt);
}

export function IncidentStream({
  initialDetail,
  initialRuns,
  latestMode,
  manualActions,
  monitoringPanels = null,
}: {
  initialDetail: IncidentDetailResponse;
  initialRuns: RunHistoryView;
  latestMode: boolean;
  manualActions: boolean;
  monitoringPanels?: MonitoringPanelListView | null;
}) {
  const router = useRouter();
  const [state, dispatch] = useReducer(
    reduceIncidentStream,
    initialDetail,
    createIncidentStreamState,
  );
  const [runs, setRuns] = useState(() =>
    mergeRuns(initialRuns.items, [runSummary(initialDetail)]),
  );
  const [runCursor, setRunCursor] = useState(initialRuns.nextCursor);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [rerunPending, setRerunPending] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [confirmRerun, setConfirmRerun] = useState(false);
  const mutationLock = useRef(false);
  const refreshDetail = useRef<(() => Promise<void>) | null>(null);
  const selectedRunId = useRef(state.detail.selectedRun.id);

  useEffect(() => {
    selectedRunId.current = state.detail.selectedRun.id;
  }, [state.detail.selectedRun.id]);

  useEffect(() => {
    let active = true;
    let pendingRefreshEventId: string | null = null;
    let refreshInFlight: Promise<void> | null = null;
    let lastKnownEventId = initialDetail.eventCursor;
    const query = new URLSearchParams({ cursor: initialDetail.eventCursor });
    const source = new EventSource(
      `/api/runtime/incidents/${encodeURIComponent(initialDetail.incident.id)}/events?${query}`,
    );

    source.onopen = () => {
      dispatch({ type: "connected" });
      void scheduleDetailRefresh(lastKnownEventId);
    };
    source.onerror = () => {
      dispatch({ type: "disconnected" });
      if (active) void checkOperatorSession();
    };

    const refreshLatestDetail = async (): Promise<void> => {
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
              message: result.failure === "invalid_response"
                ? "持久化详情不符合数据契约，未采用该响应。"
                : "无法刷新持久化详情；实时事件仍保留在时间线中。",
            });
          } else {
            if (BigInt(result.data.eventCursor) > BigInt(lastKnownEventId)) lastKnownEventId = result.data.eventCursor;
            dispatch({ type: "snapshot", afterEventId, detail: result.data });
          }
        }
      } finally {
        refreshInFlight = null;
      }
    };

    const scheduleDetailRefresh = (afterEventId: string) => {
      pendingRefreshEventId = afterEventId;
      dispatch({ type: "refresh_requested", afterEventId });
      refreshInFlight ??= refreshLatestDetail();
      return refreshInFlight;
    };
    const manualRefresh = () => scheduleDetailRefresh(lastKnownEventId);
    refreshDetail.current = manualRefresh;
    const onFocus = () => { void manualRefresh(); };
    window.addEventListener("focus", onFocus);

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
      if (BigInt(event.id) > BigInt(lastKnownEventId)) lastKnownEventId = event.id;
      if (
        requiresIncidentDetailRefresh(
          event,
          selectedRunId.current,
        )
      ) {
        void scheduleDetailRefresh(lastKnownEventId);
      }
    };

    for (const eventName of RUN_EVENT_NAMES) {
      source.addEventListener(eventName, receiveEvent);
    }

    return () => {
      active = false;
      refreshDetail.current = null;
      window.removeEventListener("focus", onFocus);
      pendingRefreshEventId = null;
      for (const eventName of RUN_EVENT_NAMES) {
        source.removeEventListener(eventName, receiveEvent);
      }
      source.close();
    };
  }, [initialDetail.eventCursor, initialDetail.incident.id, initialDetail.selectedRun.id, latestMode]);

  const waitingExpiresAt = state.detail.selectedRun.waitingExpiresAt;
  const waitingStatus = state.detail.selectedRun.status;
  useEffect(() => {
    if (waitingStatus !== "WAITING_APPROVAL" || !waitingExpiresAt) return;
    const delay = Date.parse(waitingExpiresAt) - Date.now();
    const timer = window.setTimeout(() => { void refreshDetail.current?.(); }, Math.max(0, delay) + 50);
    return () => window.clearTimeout(timer);
  }, [state.detail.selectedRun.id, waitingStatus, waitingExpiresAt]);

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
      setHistoryError("暂时无法读取更早的运行记录。");
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
    if (mutationLock.current || state.detail.actions.rerun !== null || state.refreshing || state.refreshError !== null) {
      return;
    }
    setRerunPending(true);
    mutationLock.current = true;
    setRerunError(null);
    const selected = state.detail.selectedRun;
    const result = await createRunFromBrowser(initialDetail.incident.id,
      selected.kind === "repair" && selected.status === "WAITING_APPROVAL" ? selected.id : undefined);
    if (result.ok) {
      router.replace(
        `/incidents/${encodeURIComponent(initialDetail.incident.id)}?runId=${encodeURIComponent(result.data.runId)}`,
      );
      router.refresh();
      return;
    } else {
      setRerunError(result.failure === "diagnosis_unavailable"
        ? "模型诊断暂不可用，未创建新 Run。已保存的诊断与历史记录不受影响。"
        : "未能确认创建结果，正在重新读取记录；请先查看最新运行，勿重复提交。");
    }
    await refreshDetail.current?.();
    mutationLock.current = false;
    setRerunPending(false);
  };

  const repairAction = async (command: RepairActionCommand) => {
    if (mutationLock.current || state.refreshing || state.refreshError !== null || state.detail.actions[command.action] !== null) return;
    mutationLock.current = true;
    setRerunPending(true);
    setRepairError(null);
    const result = "decision" in command.request
      ? await decideRepairFromBrowser(initialDetail.incident.id, command.request)
      : await prepareRepairFromBrowser(initialDetail.incident.id, command.request);
    if (result.ok && "runId" in result.data && !("proposalId" in result.data)) {
      router.replace(`/incidents/${encodeURIComponent(initialDetail.incident.id)}?runId=${encodeURIComponent(result.data.runId)}`);
      router.refresh();
      return;
    }
    if (!result.ok) setRepairError(result.failure === "conflict"
      ? "此操作已与当前状态冲突，可能已被另一页面处理或提案已失效。已请求最新记录，请核对后再操作。"
      : result.failure === "forbidden" ? "当前会话无权完成此操作，请核对登录与环境权限。"
      : "请求结果尚未确认，不能据此判断未执行。请刷新并核对最新运行与执行账本，不要重复提交。");
    await refreshDetail.current?.();
    mutationLock.current = false;
    setRerunPending(false);
  };

  const { detail } = state;
  const sourceDiagnosis = useSourceDiagnosis(detail);
  const diagnosisDetail = sourceDiagnosis.detail;
  const referenceRunAttempt = detail.selectedRun.kind === "repair" ? diagnosisDetail?.selectedRun.attempt : undefined;
  const visibleRuns = mergeRuns(runs, [runSummary(detail)]);
  const actionBusy = rerunPending || state.refreshing || state.refreshError !== null || state.streamError !== null ||
    (state.detailRefreshEventId !== null && BigInt(detail.eventCursor) < BigInt(state.detailRefreshEventId));
  const monitoringRefreshKey = [
    detail.selectedRun.status,
    detail.selectedRun.startedAt,
    detail.selectedRun.completedAt,
    detail.alertSignal?.endsAt ?? "firing",
  ].join(":");
  const updatedAt = latestActivityAt(detail, state.events);

  return (
    <ApprovalWindowProvider detail={detail}>
      <div className="detail-toolbar">
        <nav className="breadcrumb" aria-label="面包屑">
          <Link href="/">Incident 列表</Link>
          <span aria-hidden="true">/</span>
          <span>Incident 详情</span>
        </nav>
        <span className="detail-toolbar__updated">
          最近更新 <LocalTimestamp timestamp={updatedAt} />
        </span>
      </div>

      <section className="incident-overview" aria-labelledby="incident-heading">
        <div className="incident-overview__main">
          <div className="incident-overview__title-row">
            <h1 id="incident-heading">{detail.incident.displayName}</h1>
            <div className="marker-row">
              <IncidentStatusBadge status={detail.incident.status} />
              <RunStatusBadge status={detail.selectedRun.status} />
            </div>
          </div>
          <p>{detail.incident.triggerSummary}</p>
        </div>
        <div className="incident-facts">
          <dl className="incident-facts__column incident-facts__column--primary">
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
          </dl>
          <dl className="incident-facts__column incident-facts__column--secondary">
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
                    ? "告警中"
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
        </div>
      </section>



      <section className="run-controls" aria-labelledby="run-controls-heading">
        <div>
          <span className="eyebrow">Run history</span>
          <h2 id="run-controls-heading">运行记录</h2>
          <p className="run-context">正在查看第 {detail.selectedRun.attempt} 次 · {detail.selectedRun.kind === "diagnosis" ? "诊断" : detail.selectedRun.operation === "rollback" ? "回滚" : "修复"}{latestMode ? " · 最新运行" : " · 指定运行"}{!latestMode ? <> · <Link href={`/incidents/${detail.incident.id}`}>返回最新运行</Link></> : null}</p>
        </div>
        <details className="run-history-menu"><summary>选择运行记录</summary>
        <nav className="run-selector" aria-label="运行选择">
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
              第 {run.attempt} 次 · {run.kind === "diagnosis" ? "诊断" : run.operation === "rollback" ? "回滚" : "修复"} · {runStatusLabel(run.status)}
            </Link>
          ))}
        </nav>
        </details>
        <div className="run-controls__actions">
          {runCursor === null ? null : (
            <button className="secondary-button" type="button" onClick={loadOlderRuns} disabled={historyLoading}>
              加载更早记录
            </button>
          )}
          {manualActions ? (
            <button className="primary-button" type="button" onClick={() => detail.selectedRun.status === "WAITING_APPROVAL" ? setConfirmRerun(true) : void createRun()} disabled={actionBusy || detail.actions.rerun !== null}>
              {rerunPending ? "正在创建…" : "重新诊断"}
            </button>
          ) : null}
        </div>
      {manualActions && detail.actions.rerun !== null ? <p className="repair-actions__reason">{ACTION_UNAVAILABLE_LABELS[detail.actions.rerun]}</p> : null}
      {confirmRerun ? <div className="repair-confirmation" role="group" aria-label="确认重新诊断">
        <p>重新诊断会结束当前等待，保留旧提案与证据；不会批准或执行旧提案。</p>
        <div className="repair-actions__buttons">
          <button type="button" className="primary-button" disabled={actionBusy || detail.actions.rerun !== null} onClick={() => { setConfirmRerun(false); void createRun(); }}>确认重新诊断</button>
          <button type="button" className="secondary-button" onClick={() => setConfirmRerun(false)}>取消</button>
        </div>
      </div> : null}

      </section>

      <IncidentProgress detail={detail} diagnosisDetail={diagnosisDetail} diagnosisLoading={sourceDiagnosis.loading} />
      <IncidentMonitoringOverview
        incidentId={detail.incident.id}
        panels={monitoringPanels}
        evidence={detail.evidence}
        refreshKey={monitoringRefreshKey}
        alertStatus={detail.alertSignal?.status ?? null}
      />

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

      {diagnosisDetail ? <DiagnosisPanel
        diagnosis={diagnosisDetail.diagnosis}
        evidence={diagnosisDetail.evidence}
        runStatus={diagnosisDetail.selectedRun.status}
        runError={diagnosisDetail.selectedRun.error}
        referenceRunAttempt={referenceRunAttempt}
        runCompletedAt={diagnosisDetail.selectedRun.completedAt}
      /> : <section className="console-section diagnosis-panel" aria-labelledby="diagnosis-heading">
        <span className="eyebrow">Model inference</span>
        <h2 id="diagnosis-heading">诊断结论</h2>
        {sourceDiagnosis.loading ? <p><ShimmerText>正在读取来源诊断…</ShimmerText></p> : <>
          <p>来源诊断暂不可用，无法确认诊断结论。不会使用其他运行的结果替代。</p>
          <button className="secondary-button" onClick={sourceDiagnosis.reload}>重新读取来源诊断</button>
        </>}
      </section>}

      <RepairPanel
        detail={detail}
        pending={state.detailRefreshEventId !== null &&
          BigInt(detail.eventCursor) < BigInt(state.detailRefreshEventId)}
        refreshError={state.refreshError}
        onRefresh={() => { void refreshDetail.current?.(); }}
        refreshing={rerunPending || state.refreshing}
      >
        {manualActions ? <RepairActions key={`${detail.selectedRun.id}:${detail.repair?.digest ?? "none"}`}
          detail={detail} busy={actionBusy} refreshing={rerunPending || state.refreshing} onAction={repairAction}
          error={repairError} /> : null}
      </RepairPanel>
      <details key={detail.selectedRun.id} className="run-event-records" open>
        <summary>事件记录<span>第 {detail.selectedRun.attempt} 次运行的关键事件</span></summary>
        {state.eventPageCursor === null ? null : (
          <button className="timeline-history-button" type="button" onClick={loadOlderEvents} disabled={historyLoading}>
            加载更早事件
          </button>
        )}
        <RunTimeline events={state.events} connection={state.connection} />
      </details>
      <EvidenceList evidence={detail.evidence} />
      {referenceRunAttempt !== undefined && diagnosisDetail ? <EvidenceList
        evidence={diagnosisDetail.evidence} sourceRunAttempt={referenceRunAttempt}
      /> : null}
    </ApprovalWindowProvider>
  );
}
