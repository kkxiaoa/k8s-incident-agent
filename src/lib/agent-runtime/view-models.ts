import type { components } from "./generated";
import type {
  DiagnosisView,
  EvidenceView,
  IncidentListItemView,
  RunErrorView,
  ScenarioView,
} from "./response-contracts";

export type ScenarioResponse = ScenarioView;
export type IncidentListItem = IncidentListItemView;
export type IncidentStatus = components["schemas"]["IncidentStatus"];
export type RunStatus = components["schemas"]["RunStatus"];
export type EvidenceResponse = EvidenceView;
export type DiagnosisResponse = DiagnosisView;
export type RunErrorResponse = RunErrorView;

const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  RECEIVED: "已接收",
  TRIAGING: "诊断中",
  DIAGNOSED: "已诊断",
  INSUFFICIENT_EVIDENCE: "证据不足",
  FAILED: "失败",
};

const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  QUEUED: "等待运行",
  RUNNING: "运行中",
  COMPLETED: "已完成",
  FAILED: "运行失败",
};

export function incidentStatusLabel(status: IncidentStatus): string {
  return INCIDENT_STATUS_LABELS[status];
}

export function runStatusLabel(status: RunStatus): string {
  return RUN_STATUS_LABELS[status];
}

export function targetLabel(target: {
  kind: string;
  namespace: string | null;
  name: string;
}): string {
  return target.namespace === null
    ? `${target.kind} · ${target.name}`
    : `${target.kind} · ${target.namespace}/${target.name}`;
}
