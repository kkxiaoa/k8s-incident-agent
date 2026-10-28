"use client";

import { AlertHistory } from "./alert-history";
import { CurrentAlertBadge, lifecycleLabel } from "./incident-status";

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
  withdrawRunFromBrowser,
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
import { RecommendationPanel } from "./recommendation-panel";
import { EvidenceList } from "./evidence-card";
import { IncidentStatusBadge, RunStatusBadge } from "./incident-status";
import { RunTimeline } from "./run-timeline";
import { IncidentProgress } from "./incident-progress";
import { useSourceDiagnosis } from "./use-source-diagnosis";
import { RepairPanel } from "./repair-panel";
import { RepairActions, type RepairActionCommand } from "./repair-actions";
import { ApprovalWindowProvider } from "./approval-countdown";
import { ShimmerText } from "@/components/ui/shimmer-text";
import { ActionButton } from "@/components/ui/action-button";

function requesterLabel(run: RunSummaryView): string {
  const source =
    run.requestSource === "operator"
      ? "人工发起"
      : run.requestSource === "system"
        ? "系统发起"
        : "历史来源未记录";
  return run.initiatedByYou ? `${source} · 由你发起` : source;
}

function mergeRuns(
  current: RunSummaryView[],
  additions: RunSummaryView[],
): RunSummaryView[] {
  return Array.from(
    new Map([...current, ...additions].map((run) => [run.id, run])).values(),
  ).sort((left, right) => right.attempt - left.attempt);
}

function sourceLabel(detail: IncidentDetailResponse | null): string {
  if (detail === null) return "来源诊断记录暂不可用";
  const source = detail.selectedRun?.diagnosisTrigger?.source ?? detail.incident.source;
  if (source.type === "alertmanager") {
    return `Alertmanager · ${source.ref} · catalog ${source.revision}`;
  }
  return `Scenario · ${source.ref} · v${source.revision}`;
}

const DIAGNOSIS_DEFERRAL_LABELS = {
  busy: "已有运行或执行正在处理，新的诊断变化已保留。",
  cooldown: "自动诊断处于冷却期，届时仍需核对新鲜观察。",
  unavailable: "模型诊断暂不可用，已保留待诊断变化。",
  budget_exhausted: "本次故障的自动诊断次数已用完，可人工复核后重新诊断。",
  awaiting_observation: "等待新鲜、完整的告警与目标观察。",
} as const;

const OBSERVATION_REASON_LABELS = {
  not_observed: "尚未观察",
  stale: "观察已过期",
  clock_invalid: "观察时间不可信",
  identity_unverified: "历史目标身份无法核对",
  facts_changed: "读取期间目标发生变化",
  rule_mismatch: "源端规则与目录不一致",
  input_missing: "原始输入覆盖不足",
  incomplete: "上游结果不完整",
  waiting_evaluation: "等待源端规则计算",
  unavailable: "依赖暂不可用",
  permission_denied: "只读访问被拒绝",
  request_timeout: "读取超时",
  budget_exceeded: "本轮读取预算不足",
} as const;

function CurrentAlertStatus({
  summary,
}: {
  summary: IncidentDetailResponse["alertSummary"];
}) {
  const active = summary.rules.filter(
    (rule) => rule.state === "FIRING" || rule.state === "PENDING",
  );
  return (
    <section className="current-observation" aria-label="当前目标观察">
      <header className="current-observation__header">
        <h2>当前目标观察</h2>
        <div className="current-observation__state">当前源端：<CurrentAlertBadge state={summary.state} />{summary.complete ? null : <span>（观察不完整）</span>}</div>
      </header>
      <dl className="current-observation__facts">
        <div><dt>目标健康</dt><dd>{summary.targetHealthy === null ? "尚未确认" : summary.targetHealthy ? "受支持检查通过" : "未通过"}</dd></div>
        <div><dt>观察时间</dt><dd>{summary.observedAt === null ? "尚无观察" : <LocalTimestamp timestamp={summary.observedAt} />}</dd></div>
        {summary.lastKnownState === null || summary.lastKnownAt === null ? null : <div><dt>最后完整观察</dt><dd>{summary.lastKnownState} · <LocalTimestamp timestamp={summary.lastKnownAt} /></dd></div>}
      </dl>
      {summary.reason === null ? null : <p className="current-observation__reason">{OBSERVATION_REASON_LABELS[summary.reason]}</p>}
      {active.length === 0 ? null : <ul className="current-observation__rules">{active.map(rule => <li key={rule.alertId}>
        <span>{rule.alertId}</span><CurrentAlertBadge state={rule.state} />{rule.complete ? null : <span>（输入不完整）</span>}
      </li>)}</ul>}
      <p className="incident-context-note">这是目标层观察，未证明与具体通知一一对应；不代表 Incident 已关闭，也不替代修复恢复验证。</p>
    </section>
  );
}

function IncidentLifecycle({ detail }: { detail: IncidentDetailResponse }) {
  return <div className="incident-lifecycle">
    <div className="incident-lifecycle__summary">
      <span className="status-badge status-badge--neutral">生命周期：{lifecycleLabel(detail.incident.lifecycleStatus)}</span>
      <span>业务更新时间 <LocalTimestamp timestamp={detail.incident.updatedAt} /></span>
    </div>
    <p className="incident-context-note">历史记录的更新时间可能包含通知刷新。</p>
    {detail.closure === null ? null : <div className="incident-lifecycle__closure">
      <strong>{detail.incident.lifecycleStatus === "CLOSED" ? "关闭时间" : "上次关闭时间"} <LocalTimestamp timestamp={detail.closure.closedAt} /></strong>
      <p>{detail.closure.basis === "observed_stable" ? "受支持检查持续稳定，未据此宣称 Agent 修复成功。" : "受控修复已验证恢复，并通过持续稳定检查。"}</p>
    </div>}
    {detail.diagnosisDeferral ? <p className="incident-lifecycle__deferral" role="status">
      {DIAGNOSIS_DEFERRAL_LABELS[detail.diagnosisDeferral.reason]}
      {detail.diagnosisDeferral.reviewAfter === null ? null : <> · 可复核时间 <LocalTimestamp timestamp={detail.diagnosisDeferral.reviewAfter} />；到时仍需重新核对准入条件，不保证启动。</>}
    </p> : null}
  </div>;
}

export function IncidentStream({
  initialDetail,
  initialRuns,
  manualActions,
  authenticated = false,
  monitoringPanels = null,
}: {
  initialDetail: IncidentDetailResponse;
  initialRuns: RunHistoryView;
  manualActions: boolean;
  authenticated?: boolean;
  monitoringPanels?: MonitoringPanelListView | null;
}) {
  const router = useRouter();
  const [state, dispatch] = useReducer(
    reduceIncidentStream,
    initialDetail,
    createIncidentStreamState,
  );
  const [runs, setRuns] = useState(() =>
    mergeRuns(
      initialRuns.items,
      initialDetail.selectedRun ? [initialDetail.selectedRun] : [],
    ),
  );
  const [latestRun, setLatestRun] = useState(() => {
    const run = runs[0];
    return run ? { id: run.id, attempt: run.attempt } : null;
  });
  const [runCursor, setRunCursor] = useState(initialRuns.nextCursor);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [mine, setMine] = useState(false);
  const mineRef = useRef(false);
  const historyRevision = useRef(0);
  const historyMenu = useRef<HTMLDetailsElement>(null);
  const [rerunPending, setRerunPending] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [confirmRerun, setConfirmRerun] = useState(false);
  const mutationLock = useRef(false);
  const refreshDetail = useRef<(() => Promise<void>) | null>(null);
  const reconnectStream = useRef<((cursor: string) => void) | null>(null);
  const selectedRunId = useRef<string | null>(
    state.detail.selectedRun?.id ?? null,
  );

  useEffect(() => {
    selectedRunId.current = state.detail.selectedRun?.id ?? null;
  }, [state.detail.selectedRun?.id]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (
        historyMenu.current &&
        !historyMenu.current.contains(event.target as Node)
      ) {
        historyMenu.current.open = false;
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  useEffect(() => {
    let active = true;
    let pendingRefreshEventId: string | null = null;
    let pendingHistoryRefresh = false;
    let refreshInFlight: Promise<void> | null = null;
    let lastKnownEventId = initialDetail.eventCursor;
    let source: EventSource | null = null;
    let disconnectSource: (() => void) | null = null;

    const refreshPersistedDetail = async (): Promise<void> => {
      try {
        while (active && pendingRefreshEventId !== null) {
          const afterEventId = pendingRefreshEventId;
          pendingRefreshEventId = null;
          const historyRead = pendingHistoryRefresh
            ? {
                latest: fetchRunHistoryFromBrowser(initialDetail.incident.id),
                filtered: mineRef.current
                  ? fetchRunHistoryFromBrowser(
                      initialDetail.incident.id,
                      undefined,
                      true,
                    )
                  : null,
                revision: historyRevision.current,
              }
            : null;
          pendingHistoryRefresh = false;
          const result = await fetchIncidentFromBrowser(
            initialDetail.incident.id,
            initialDetail.selectedRun?.id,
          );
          if (!active) {
            return;
          }
          if (!result.ok) {
            dispatch({
              type: "refresh_failed",
              afterEventId,
              message:
                result.failure === "invalid_response"
                  ? "持久化详情不符合数据契约，未采用该响应。"
                  : "无法刷新持久化详情；实时事件仍保留在时间线中。",
            });
          } else {
            if (BigInt(result.data.eventCursor) > BigInt(lastKnownEventId))
              lastKnownEventId = result.data.eventCursor;
            dispatch({ type: "snapshot", afterEventId, detail: result.data });
          }
          if (historyRead) {
            const latest = await historyRead.latest;
            const history = historyRead.filtered
              ? await historyRead.filtered
              : latest;
            if (!active) return;
            if (latest.ok) {
              const newest = latest.data.items[0];
              if (newest)
                setLatestRun((current) =>
                  current === null || newest.attempt > current.attempt
                    ? { id: newest.id, attempt: newest.attempt }
                    : current,
                );
            }
            if (historyRead.revision === historyRevision.current) {
              if (history.ok) {
                setRuns((current) => mergeRuns(current, history.data.items));
                setRunCursor(history.data.nextCursor);
              }
              setHistoryError(
                history.ok && latest.ok
                  ? null
                  : "暂时无法更新运行列表，请重新打开列表重试。",
              );
            }
          }
        }
      } finally {
        refreshInFlight = null;
      }
    };

    const scheduleDetailRefresh = (
      afterEventId: string,
      refreshHistory = false,
    ) => {
      pendingRefreshEventId = afterEventId;
      pendingHistoryRefresh ||= refreshHistory;
      dispatch({ type: "refresh_requested", afterEventId });
      refreshInFlight ??= refreshPersistedDetail();
      return refreshInFlight;
    };

    const manualRefresh = () => scheduleDetailRefresh(lastKnownEventId, true);
    refreshDetail.current = manualRefresh;
    const currentObservationTimer = window.setInterval(() => {
      void scheduleDetailRefresh(lastKnownEventId);
    }, 30_000);
    const onFocus = () => {
      void manualRefresh();
    };
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
        disconnectSource?.();
        reconnectStream.current = null;
        dispatch({
          type: "invalid",
          message: "收到无法验证的运行事件，实时更新已停止。",
        });
        return;
      }

      dispatch({ type: "event", event });
      if (BigInt(event.id) > BigInt(lastKnownEventId))
        lastKnownEventId = event.id;
      if (requiresIncidentDetailRefresh(event, selectedRunId.current)) {
        void scheduleDetailRefresh(
          lastKnownEventId,
          event.event === "run.queued" ||
            event.data.runId !== selectedRunId.current,
        );
      }
    };

    const connect = (cursor: string) => {
      disconnectSource?.();
      lastKnownEventId = cursor;
      const query = new URLSearchParams({ cursor });
      const current = new EventSource(
        `/api/runtime/incidents/${encodeURIComponent(initialDetail.incident.id)}/events?${query}`,
      );
      source = current;
      const isCurrent = () => active && source === current;
      const onEvent = (event: Event) => {
        if (isCurrent()) receiveEvent(event);
      };
      current.onopen = () => {
        if (!isCurrent()) return;
        dispatch({ type: "connected" });
        void scheduleDetailRefresh(lastKnownEventId, true);
      };
      current.onerror = () => {
        if (!isCurrent()) return;
        dispatch({
          type: current.readyState === EventSource.CLOSED ? "stopped" : "disconnected",
        });
        void checkOperatorSession();
      };
      for (const eventName of RUN_EVENT_NAMES) {
        current.addEventListener(eventName, onEvent);
      }
      disconnectSource = () => {
        current.onopen = null;
        current.onerror = null;
        for (const eventName of RUN_EVENT_NAMES) {
          current.removeEventListener(eventName, onEvent);
        }
        current.close();
        if (source === current) source = null;
      };
    };

    reconnectStream.current = (cursor) => {
      if (!active || source?.readyState !== EventSource.CLOSED) return;
      dispatch({ type: "connecting" });
      connect(cursor);
    };
    connect(initialDetail.eventCursor);

    return () => {
      active = false;
      refreshDetail.current = null;
      window.clearInterval(currentObservationTimer);
      reconnectStream.current = null;
      window.removeEventListener("focus", onFocus);
      pendingRefreshEventId = null;
      disconnectSource?.();
    };
  }, [
    initialDetail.eventCursor,
    initialDetail.incident.id,
    initialDetail.selectedRun?.id,
  ]);

  const waitingExpiresAt = state.detail.selectedRun?.waitingExpiresAt;
  const waitingStatus = state.detail.selectedRun?.status;
  useEffect(() => {
    if (waitingStatus !== "WAITING_APPROVAL" || !waitingExpiresAt) return;
    const delay = Date.parse(waitingExpiresAt) - Date.now();
    const timer = window.setTimeout(
      () => {
        void refreshDetail.current?.();
      },
      Math.max(0, delay) + 50,
    );
    return () => window.clearTimeout(timer);
  }, [state.detail.selectedRun?.id, waitingStatus, waitingExpiresAt]);

  const loadOlderRuns = async () => {
    if (runCursor === null || historyLoading) {
      return;
    }
    historyRevision.current += 1;
    setHistoryLoading(true);
    setHistoryError(null);
    const result = await fetchRunHistoryFromBrowser(
      initialDetail.incident.id,
      runCursor,
      mine,
    );
    if (result.ok) {
      setRuns((current) => mergeRuns(current, result.data.items));
      setRunCursor(result.data.nextCursor);
    } else {
      setHistoryError("暂时无法读取更早的运行记录。");
    }
    setHistoryLoading(false);
  };

  const filterRuns = async (onlyMine: boolean) => {
    if (historyLoading) return;
    historyRevision.current += 1;
    mineRef.current = onlyMine;
    setMine(onlyMine);
    setHistoryLoading(true);
    setHistoryError(null);
    setRuns([]);
    setRunCursor(null);
    const result = await fetchRunHistoryFromBrowser(
      initialDetail.incident.id,
      undefined,
      onlyMine,
    );
    if (result.ok) {
      setRuns(result.data.items);
      setRunCursor(result.data.nextCursor);
    } else setHistoryError("暂时无法筛选运行记录，请稍后重试。");
    setHistoryLoading(false);
  };

  const loadOlderEvents = async () => {
    const cursor = state.eventPageCursor;
    if (
      cursor === null ||
      historyLoading ||
      state.detail.selectedRun === null
    ) {
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
    if (
      mutationLock.current ||
      state.detail.selectedRun === null ||
      state.detail.actions.rerun !== null ||
      state.refreshing ||
      state.refreshError !== null
    ) {
      return;
    }
    setRerunPending(true);
    mutationLock.current = true;
    setRerunError(null);
    const selected = state.detail.selectedRun;
    const result = await createRunFromBrowser(
      initialDetail.incident.id,
      selected.kind === "repair" && selected.status === "WAITING_APPROVAL"
        ? selected.id
        : undefined,
    );
    if (result.ok) {
      router.replace(
        `/incidents/${encodeURIComponent(initialDetail.incident.id)}?runId=${encodeURIComponent(result.data.runId)}`,
      );
      router.refresh();
      return;
    } else {
      setRerunError(
        result.failure === "diagnosis_unavailable"
          ? "模型诊断暂不可用，未创建新 Run。已保存的诊断与历史记录不受影响。"
          : result.failure === "public_demo_limited"
            ? "公开读取暂时达到容量上限，请稍后重试。"
            : "未能确认创建结果，正在重新读取记录；请先查看最新运行，勿重复提交。",
      );
    }
    await refreshDetail.current?.();
    mutationLock.current = false;
    setRerunPending(false);
  };

  const repairAction = async (command: RepairActionCommand) => {
    if (
      mutationLock.current ||
      state.refreshing ||
      state.refreshError !== null ||
      state.detail.actions[command.action] !== null
    )
      return;
    mutationLock.current = true;
    setRerunPending(true);
    setRepairError(null);
    const result =
      command.action === "withdraw"
        ? await withdrawRunFromBrowser(
            initialDetail.incident.id,
            command.request,
          )
        : "decision" in command.request
          ? await decideRepairFromBrowser(
              initialDetail.incident.id,
              command.request,
            )
          : await prepareRepairFromBrowser(
              initialDetail.incident.id,
              command.request,
            );
    if (
      result.ok &&
      result.data !== undefined &&
      "runId" in result.data &&
      !("proposalId" in result.data)
    ) {
      router.replace(
        `/incidents/${encodeURIComponent(initialDetail.incident.id)}?runId=${encodeURIComponent(result.data.runId)}`,
      );
      router.refresh();
      return;
    }
    if (!result.ok)
      setRepairError(
        result.failure === "conflict"
          ? "此操作已与当前状态冲突，可能已被另一页面处理或提案已失效。已请求最新记录，请核对后再操作。"
          : result.failure === "forbidden"
            ? "当前会话无权完成此操作，请核对登录与环境权限。"
            : result.failure === "public_demo_limited"
              ? "公开读取暂时达到容量上限，请稍后重试。"
              : "请求结果尚未确认，不能据此判断未执行。请刷新并核对最新运行与执行账本，不要重复提交。",
      );
    await refreshDetail.current?.();
    mutationLock.current = false;
    setRerunPending(false);
  };

  const { detail } = state;
  const sourceDiagnosis = useSourceDiagnosis(detail);
  const selectedRun = detail.selectedRun;
  if (selectedRun === null) {
    return (
      <>
      <div className="detail-toolbar"><nav className="breadcrumb" aria-label="面包屑"><Link href="/">Incident 列表</Link><span aria-hidden="true">/</span><span>Incident 详情</span></nav></div>
      <section className="incident-overview" aria-labelledby="incident-heading">
        <div className="incident-overview__main">
          <h1 id="incident-heading">{detail.incident.displayName}</h1>
          <p>{detail.incident.triggerSummary}</p>
          <p>{targetLabel(detail.incident.target)}</p>
          <IncidentLifecycle detail={detail} />
        </div>
        <p className="incident-context-note" role="status">尚无诊断运行。没有诊断证据、结论或可执行操作。</p>
        {state.connection === "stopped" ? (
          <div className="timeline-connection-actions">
            <span className="connection-state connection-state--stopped" role="status">实时连接已停止</span>
            <button className="secondary-button" onClick={() => reconnectStream.current?.(state.lastEventId)}>
              重新连接
            </button>
          </div>
        ) : null}
        <CurrentAlertStatus summary={detail.alertSummary} />
        {detail.alertSignal === null ? null : (
          <p className="incident-context-note">
            末次通知：{detail.alertSignal.status}
            ；通知不代表源端当前状态、Incident 关闭或恢复验证完成。
          </p>
        )}
        {state.refreshError || state.streamError ? (
          <p role="alert">{state.refreshError ?? state.streamError}</p>
        ) : null}
        <AlertHistory key={detail.incident.id} incidentId={detail.incident.id} />
        <button
          className="secondary-button incident-overview__refresh"
          type="button"
          onClick={() => void refreshDetail.current?.()}
          disabled={state.refreshing}
        >
          刷新记录
        </button>
      </section>
      </>
    );
  }
  const diagnosisDetail = sourceDiagnosis.detail;
  const referenceRunAttempt =
    selectedRun.kind === "repair"
      ? diagnosisDetail?.selectedRun?.attempt
      : undefined;
  const visibleRuns = mergeRuns(
    runs,
    !mine || selectedRun.initiatedByYou ? [selectedRun] : [],
  );
  const actionBusy =
    rerunPending ||
    state.refreshing ||
    state.refreshError !== null ||
    state.streamError !== null ||
    (state.detailRefreshEventId !== null &&
      BigInt(detail.eventCursor) < BigInt(state.detailRefreshEventId));
  const actionBusyReason =
    state.streamError !== null
      ? "实时事件无法验证，请刷新页面后再操作。"
      : state.refreshError !== null
        ? "无法核对最新保存状态，请检查最新状态后再操作。"
        : rerunPending
          ? "正在提交操作并核对结果，请勿重复提交。"
          : actionBusy
            ? "正在核对最新保存状态，请稍候。"
            : undefined;
  const rerunDisabledReason =
    detail.actions.rerun !== null
      ? detail.actions.rerun === "authentication_required"
        ? "登录后可重新诊断。"
        : ACTION_UNAVAILABLE_LABELS[detail.actions.rerun]
      : actionBusyReason;
  const monitoringRefreshKey = [
    selectedRun.status,
    selectedRun?.startedAt,
    selectedRun?.completedAt,
    detail.alertSignal?.endsAt ?? "firing",
  ].join(":");
  const updatedAt = detail.incident.updatedAt;

  return (
    <ApprovalWindowProvider detail={detail}>
      <div className="detail-toolbar">
        <nav className="breadcrumb" aria-label="面包屑">
          <Link href="/">Incident 列表</Link>
          <span aria-hidden="true">/</span>
          <span>Incident 详情</span>
        </nav>
        <span className="detail-toolbar__updated">
          业务更新时间 <LocalTimestamp timestamp={updatedAt} />
        </span>
      </div>

      <section className="incident-overview" aria-labelledby="incident-heading">
        <div className="incident-overview__main">
          <div className="incident-overview__title-row">
            <h1 id="incident-heading">{detail.incident.displayName}</h1>
            <div className="marker-row">
              <IncidentStatusBadge status={detail.incident.status} />
              <RunStatusBadge status={selectedRun.status} />
            </div>
          </div>
          <p>{diagnosisDetail?.selectedRun?.diagnosisTrigger?.summary ?? diagnosisDetail?.incident.triggerSummary ?? "来源诊断记录暂不可用"}</p>
          <IncidentLifecycle detail={detail} />
        </div>
        <div className="incident-facts">
          <dl className="incident-facts__column incident-facts__column--primary">
            <div>
              <dt>目标</dt>
              <dd>{targetLabel(detail.incident.target)}</dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd>{sourceLabel(diagnosisDetail)}</dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>
                <LocalTimestamp timestamp={detail.incident.createdAt} />
              </dd>
            </div>
          </dl>
          <dl className="incident-facts__column incident-facts__column--secondary">
            {detail.alertSignal === null ? null : (
              <div>
                <dt>告警信号</dt>
                <dd title="Alertmanager 通知不代表源端当前状态、Incident 关闭或恢复验证完成。">
                  {detail.alertSignal.status === "FIRING"
                    ? "末次通知 FIRING"
                    : "末次通知 RESOLVED"}
                  {detail.alertSignal.endsAt === null ? null : (
                    <>
                      {" "}
                      · 历史通知中的结束时间{" "}
                      <LocalTimestamp timestamp={detail.alertSignal.endsAt} />
                    </>
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
        <CurrentAlertStatus summary={detail.alertSummary} />
        <AlertHistory key={detail.incident.id} incidentId={detail.incident.id} />
      </section>

      <section className="run-controls" aria-labelledby="run-controls-heading">
        <div>
          <span className="eyebrow">Run history</span>
          <h2 id="run-controls-heading">运行记录</h2>
          <p className="run-context">{requesterLabel(selectedRun)}</p>
          <p className="run-context">
            正在查看第 {selectedRun.attempt} 次 ·{" "}
            {selectedRun.kind === "diagnosis"
              ? "诊断"
              : selectedRun.operation === "rollback"
                ? "回滚"
                : "修复"}
            {latestRun !== null && latestRun.attempt > selectedRun.attempt ? (
              <>
                {" "}
                ·{" "}
                <Link
                  href={`/incidents/${detail.incident.id}?runId=${encodeURIComponent(latestRun.id)}`}
                >
                  最新运行
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <details
          ref={historyMenu}
          className="run-history-menu"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary
            onClick={() => {
              if (!historyMenu.current?.open && historyError)
                void refreshDetail.current?.();
            }}
          >
            选择运行记录
          </summary>
          <nav className="run-selector" aria-label="运行选择">
            {authenticated ? (
              <label className="run-history-filter">
                <input
                  type="checkbox"
                  checked={mine}
                  disabled={historyLoading}
                  onChange={(event) => void filterRuns(event.target.checked)}
                />{" "}
                仅看我发起的
              </label>
            ) : null}
            {visibleRuns.map((run) => (
              <Link
                key={run.id}
                href={`/incidents/${detail.incident.id}?runId=${encodeURIComponent(run.id)}`}
                onClick={() => {
                  if (historyMenu.current) historyMenu.current.open = false;
                }}
                aria-current={run.id === selectedRun.id ? "page" : undefined}
                className={
                  run.id === selectedRun.id
                    ? "run-selector__item is-selected"
                    : "run-selector__item"
                }
              >
                <span>
                  第 {run.attempt} 次 ·{" "}
                  {run.kind === "diagnosis"
                    ? "诊断"
                    : run.operation === "rollback"
                      ? "回滚"
                      : "修复"}{" "}
                  · {runStatusLabel(run.status)}
                  <span> · {requesterLabel(run)}</span>
                </span>
                {run.id === latestRun?.id ? (
                  <span className="run-selector__latest">最新</span>
                ) : null}
              </Link>
            ))}
            {mine &&
            visibleRuns.length === 0 &&
            !historyLoading &&
            !historyError ? (
              <p className="run-context">
                没有你发起的运行；可切换到全部运行查看。
              </p>
            ) : null}
          </nav>
        </details>
        <div className="run-controls__actions">
          {runCursor === null ? null : (
            <ActionButton
              className="secondary-button"
              type="button"
              onClick={loadOlderRuns}
              disabled={historyLoading}
              disabledReason="正在读取历史记录，请稍候。"
            >
              加载更早记录
            </ActionButton>
          )}
          {manualActions ? (
            <ActionButton
              className="primary-button"
              type="button"
              disabledReason={rerunDisabledReason}
              onClick={() =>
                selectedRun.status === "WAITING_APPROVAL"
                  ? setConfirmRerun(true)
                  : void createRun()
              }
              disabled={actionBusy || detail.actions.rerun !== null}
            >
              {rerunPending ? "正在创建…" : "重新诊断"}
            </ActionButton>
          ) : null}
        </div>
        {manualActions && detail.actions.rerun !== null ? (
          <p className="repair-actions__reason">
            {ACTION_UNAVAILABLE_LABELS[detail.actions.rerun]}
          </p>
        ) : null}
        {confirmRerun ? (
          <div
            className="repair-confirmation"
            role="group"
            aria-label="确认重新诊断"
          >
            <p>
              重新诊断会结束当前等待，保留旧提案与证据；不会批准或执行旧提案。
            </p>
            <div className="repair-actions__buttons">
              <ActionButton
                type="button"
                className="primary-button"
                disabledReason={rerunDisabledReason}
                disabled={actionBusy || detail.actions.rerun !== null}
                onClick={() => {
                  setConfirmRerun(false);
                  void createRun();
                }}
              >
                确认重新诊断
              </ActionButton>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setConfirmRerun(false)}
              >
                取消
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <IncidentProgress
        detail={detail}
        diagnosisDetail={diagnosisDetail}
        diagnosisLoading={sourceDiagnosis.loading}
      />
      <IncidentMonitoringOverview
        incidentId={detail.incident.id}
        panels={monitoringPanels}
        evidence={detail.evidence}
        refreshKey={monitoringRefreshKey}
        alertStatus={detail.alertSignal?.status ?? null}
        selectedRun={{
          id: selectedRun.id,
          attempt: selectedRun.attempt,
          completedAt: selectedRun?.completedAt,
        }}
        latestRunId={latestRun?.id ?? null}
      />

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
      {historyError === null ? null : (
        <p className="page-alert" role="status">
          {historyError}
        </p>
      )}
      {rerunError === null ? null : (
        <p className="page-alert page-alert--danger" role="alert">
          {rerunError}
        </p>
      )}

      {diagnosisDetail?.selectedRun ? (
        <DiagnosisPanel
          diagnosis={diagnosisDetail.diagnosis}
          evidence={diagnosisDetail.evidence}
          runStatus={diagnosisDetail.selectedRun.status}
          runError={diagnosisDetail.selectedRun.error}
          referenceRunAttempt={referenceRunAttempt}
          runCompletedAt={diagnosisDetail.selectedRun.completedAt}
        />
      ) : (
        <section
          className="console-section diagnosis-panel"
          aria-labelledby="diagnosis-heading"
        >
          <span className="eyebrow">Model inference</span>
          <h2 id="diagnosis-heading">诊断结论</h2>
          {sourceDiagnosis.loading ? (
            <p>
              <ShimmerText>正在读取来源诊断…</ShimmerText>
            </p>
          ) : (
            <>
              <p>
                {sourceDiagnosis.failure === "public_demo_limited"
                  ? "来源诊断读取暂时受限，请稍后重试。"
                  : sourceDiagnosis.failure === "not_found"
                    ? "来源诊断记录不存在，无法确认诊断结论。"
                    : sourceDiagnosis.failure === "invalid_response"
                      ? "来源诊断响应无法验证，未采用该结果。"
                      : "来源诊断暂不可用，无法确认诊断结论。不会使用其他运行的结果替代。"}
              </p>
              <button
                className="secondary-button"
                onClick={sourceDiagnosis.reload}
              >
                重新读取来源诊断
              </button>
            </>
          )}
        </section>
      )}

      <RecommendationPanel
        diagnosis={diagnosisDetail?.diagnosis ?? null}
        evidence={diagnosisDetail?.evidence}
        referenceRunAttempt={referenceRunAttempt}
        runCompletedAt={diagnosisDetail?.selectedRun?.completedAt}
      />

      <RepairPanel
        detail={detail}
        pending={
          state.detailRefreshEventId !== null &&
          BigInt(detail.eventCursor) < BigInt(state.detailRefreshEventId)
        }
        refreshError={state.refreshError}
        onRefresh={() => {
          void refreshDetail.current?.();
        }}
        refreshing={rerunPending || state.refreshing}
      >
        {manualActions ? (
          <RepairActions
            key={`${selectedRun.id}:${detail.repair?.digest ?? "none"}`}
            detail={detail}
            busy={actionBusy}
            refreshing={rerunPending || state.refreshing}
            onAction={repairAction}
            busyReason={actionBusyReason}
            error={repairError}
          />
        ) : null}
      </RepairPanel>
      <details key={selectedRun.id} className="run-event-records" open>
        <summary>
          事件记录<span>第 {selectedRun.attempt} 次运行的关键事件</span>
        </summary>
        {state.eventPageCursor === null ? null : (
          <ActionButton
            className="timeline-history-button"
            type="button"
            onClick={loadOlderEvents}
            disabled={historyLoading}
            disabledReason="正在读取历史记录，请稍候。"
          >
            加载更早事件
          </ActionButton>
        )}
        <RunTimeline
          events={state.events}
          connection={state.connection}
          onReconnect={() => reconnectStream.current?.(state.lastEventId)}
        />
      </details>
      <EvidenceList
        evidence={detail.evidence}
        currentRunAttempt={
          selectedRun.kind === "repair" ? selectedRun.attempt : undefined
        }
      />
      {referenceRunAttempt !== undefined && diagnosisDetail ? (
        <EvidenceList
          evidence={diagnosisDetail.evidence}
          sourceRunAttempt={referenceRunAttempt}
        />
      ) : null}
    </ApprovalWindowProvider>
  );
}
