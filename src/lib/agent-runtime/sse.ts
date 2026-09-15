import {
  RUN_EVENT_NAMES,
  parseRunEvent,
  type RunEventStreamItem,
} from "@/lib/agent-runtime/event-contracts";
import type { IncidentDetailView } from "@/lib/agent-runtime/response-contracts";

export { RUN_EVENT_NAMES, parseRunEvent };
export type { RunEventStreamItem };
export type IncidentDetailResponse = IncidentDetailView;

export type IncidentStreamConnection =
  | "connecting"
  | "live"
  | "reconnecting"
  | "invalid";

export interface IncidentStreamState {
  connection: IncidentStreamConnection;
  detail: IncidentDetailResponse;
  detailRefreshEventId: string | null;
  eventPageCursor: string | null;
  events: RunEventStreamItem[];
  lastEventId: string;
  refreshError: string | null;
  refreshing: boolean;
  streamError: string | null;
}

export type IncidentStreamAction =
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "event"; event: RunEventStreamItem }
  | { type: "refresh_requested"; afterEventId: string }
  | {
      type: "snapshot";
      afterEventId: string;
      detail: IncidentDetailResponse;
    }
  | {
      type: "older_events";
      items: RunEventStreamItem[];
      nextCursor: string | null;
    }
  | { type: "refresh_failed"; afterEventId: string; message: string }
  | { type: "invalid"; message: string };

const TERMINAL_EVENTS = new Set<RunEventStreamItem["event"]>([
  "diagnosis.insufficient",
  "run.failed",
  "repair.wait_ended",
]);

export function isTerminalRunEvent(event: RunEventStreamItem): boolean {
  return (
    TERMINAL_EVENTS.has(event.event) ||
    ((event.event === "repair.approval_decided" || event.event === "repair.execution_updated" || event.event === "repair.verification_updated") && event.data.runStatus !== "RUNNING") ||
    ((event.event === "diagnosis.completed" || event.event === "repair.waiting_approval") &&
      event.data.runStatus === "COMPLETED")
  );
}

export function requiresIncidentDetailRefresh(
  event: RunEventStreamItem,
  selectedRunId: string,
): boolean {
  if (event.event === "alert.resolved") {
    return true;
  }
  if (event.event === "repair.approval_decided" || event.event === "repair.execution_updated" || event.event === "repair.verification_updated") {
    return true;
  }
  if (event.event === "run.queued" || isTerminalRunEvent(event)) {
    return true;
  }
  return (
    event.data.runId === selectedRunId &&
    (event.event === "evidence.recorded" || event.event === "repair.waiting_approval" || isTerminalRunEvent(event))
  );
}

function ascending(items: RunEventStreamItem[]): RunEventStreamItem[] {
  return [...items].sort((left, right) =>
    BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0,
  );
}

function uniqueEvents(items: RunEventStreamItem[]): RunEventStreamItem[] {
  return ascending(
    Array.from(new Map(items.map((event) => [event.id, event])).values()),
  );
}

export function createIncidentStreamState(
  detail: IncidentDetailResponse,
): IncidentStreamState {
  return {
    connection: "connecting",
    detail,
    detailRefreshEventId: null,
    eventPageCursor: detail.eventPage.nextCursor,
    events: ascending(detail.eventPage.items),
    lastEventId: detail.eventCursor,
    refreshError: null,
    refreshing: false,
    streamError: null,
  };
}

function applyIncidentStatus(
  detail: IncidentDetailResponse,
  event: RunEventStreamItem,
): IncidentDetailResponse {
  switch (event.event) {
    case "incident.created":
    case "run.started":
    case "diagnosis.completed":
    case "repair.patch_ready":
    case "repair.dry_run_passed":
    case "repair.waiting_approval":
    case "repair.wait_ended":
    case "repair.approval_decided":
    case "repair.execution_updated":
    case "repair.verification_updated":
    case "diagnosis.insufficient":
    case "run.failed":
      return {
        ...detail,
        incident: { ...detail.incident, status: event.data.incidentStatus },
      };
    case "run.queued":
    case "tool.started":
    case "evidence.recorded":
    case "tool.failed":
    case "alert.resolved":
      return detail;
  }
}

function applySelectedRunStatus(
  detail: IncidentDetailResponse,
  event: RunEventStreamItem,
): IncidentDetailResponse {
  if (event.data.runId !== detail.selectedRun.id) {
    return detail;
  }

  switch (event.event) {
    case "incident.created":
    case "run.queued":
    case "run.started":
    case "diagnosis.completed":
    case "repair.patch_ready":
    case "repair.dry_run_passed":
    case "repair.waiting_approval":
    case "repair.wait_ended":
    case "repair.approval_decided":
    case "repair.execution_updated":
    case "repair.verification_updated":
    case "diagnosis.insufficient":
    case "run.failed":
      return {
        ...detail,
        selectedRun: {
          ...detail.selectedRun,
          status: event.data.runStatus,
        },
      };
    case "tool.started":
    case "evidence.recorded":
    case "tool.failed":
    case "alert.resolved":
      return detail;
  }
}

export function reduceIncidentStream(
  state: IncidentStreamState,
  action: IncidentStreamAction,
): IncidentStreamState {
  switch (action.type) {
    case "refresh_requested":
      return { ...state, detailRefreshEventId: action.afterEventId, refreshing: true };
    case "connected":
      return { ...state, connection: "live", streamError: null };
    case "disconnected":
      return { ...state, connection: "reconnecting" };
    case "invalid":
      return {
        ...state,
        connection: "invalid",
        streamError: action.message,
      };
    case "snapshot": {
      if (action.afterEventId !== state.detailRefreshEventId) {
        return state;
      }
      if (BigInt(action.detail.eventCursor) < BigInt(state.detail.eventCursor)) {
        return { ...state, refreshing: false, refreshError: "详情版本落后于已保存的页面状态，请刷新后再操作。" };
      }

      const sameRun = action.detail.selectedRun.id === state.detail.selectedRun.id;
      const snapshotBehind = BigInt(action.detail.eventCursor) < BigInt(state.lastEventId);
      const detail = snapshotBehind
        ? {
            ...action.detail,
            incident: { ...action.detail.incident, status: state.detail.incident.status },
            selectedRun: sameRun
              ? { ...action.detail.selectedRun, status: state.detail.selectedRun.status }
              : action.detail.selectedRun,
          }
        : action.detail;
      return {
        ...state,
        detail,
        lastEventId: snapshotBehind ? state.lastEventId : action.detail.eventCursor,
        eventPageCursor: action.detail.eventPage.nextCursor,
        events: uniqueEvents([
          ...action.detail.eventPage.items,
          ...(sameRun ? state.events : []),
        ]),
        refreshError: null,
        refreshing: false,
      };
    }
    case "older_events":
      return {
        ...state,
        eventPageCursor: action.nextCursor,
        events: uniqueEvents([...action.items, ...state.events]),
      };
    case "refresh_failed":
      return action.afterEventId === state.detailRefreshEventId
        ? { ...state, refreshError: action.message, refreshing: false }
        : state;
    case "event": {
      if (BigInt(action.event.id) <= BigInt(state.lastEventId)) {
        return state;
      }

      const selected = action.event.data.runId === state.detail.selectedRun.id;
      const refresh = requiresIncidentDetailRefresh(
        action.event,
        state.detail.selectedRun.id,
      );
      const incidentDetail = applyIncidentStatus(state.detail, action.event);
      return {
        ...state,
        detail: applySelectedRunStatus(incidentDetail, action.event),
        detailRefreshEventId: refresh
          ? action.event.id
          : state.detailRefreshEventId,
        events: selected
          ? uniqueEvents([...state.events, action.event])
          : state.events,
        lastEventId: action.event.id,
      };
    }
  }
}
