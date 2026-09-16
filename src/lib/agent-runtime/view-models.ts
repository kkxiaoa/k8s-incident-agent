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

export const ACTION_UNAVAILABLE_LABELS: Record<Exclude<components["schemas"]["IncidentActions"]["approve"], null>, string> = {
  authentication_required: "登录后可执行此操作。",
  not_owner: "仅申请的发起人可撤回；历史与进展仍可查看。",
  not_applicable: "当前运行不适用此操作。",
  active_run: "此 Incident 仍有活跃运行，请等待或查看最新运行。",
  execution_held: "目标仍被本次执行占用；请核对执行与恢复记录，不要重复执行。",
  target_occupied: "另一次执行仍占用此目标，暂时不能批准。",
  execution_disabled: "当前环境未启用审批执行，正式批准与拒绝均不可用。",
  outside_scope: "目标不在获准的固定执行沙箱内。",
  proposal_expired: "提案等待期限已失效，请重新准备；这不是登录会话过期。",
  no_history_candidates: "当前保存的证据中没有可选择的历史镜像，请重新准备或诊断。",
  diagnosis_unavailable: "模型诊断暂不可用，已保存的诊断与修复操作不受影响。",
};

const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  RECEIVED: "已接收",
  TRIAGING: "诊断中",
  DIAGNOSED: "已诊断",
  PATCH_READY: "修复建议已生成",
  DRY_RUN_PASSED: "Dry-run 已通过",
  WAITING_APPROVAL: "等待批准",
  APPLYING: "已批准，执行中",
  VERIFYING: "恢复验证中",
  RESOLVED: "恢复已验证",
  ROLLED_BACK: "逆向写入已完成",
  REJECTED: "已拒绝",
  INSUFFICIENT_EVIDENCE: "证据不足",
  STALE_RESOURCE: "目标资源已变化",
  FAILED: "失败",
};

const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  QUEUED: "等待运行",
  RUNNING: "运行中",
  WAITING_APPROVAL: "等待审批",
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

export function evidenceTargetLabel(
  targetRef: EvidenceResponse["targetRef"],
): string {
  return typeof targetRef.kind === "string" &&
    typeof targetRef.namespace === "string" &&
    typeof targetRef.name === "string"
    ? targetLabel({
        kind: targetRef.kind,
        namespace: targetRef.namespace,
        name: targetRef.name,
      })
    : "由工具契约记录";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordArray(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items = value.map(record);
  return items.some((item) => item === null)
    ? null
    : (items as Record<string, unknown>[]);
}

function countedLabels(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const entries = [...counts].sort(
    ([leftLabel, leftCount], [rightLabel, rightCount]) =>
      rightCount - leftCount ||
      (leftLabel < rightLabel ? -1 : leftLabel > rightLabel ? 1 : 0),
  );
  const labels = entries
    .slice(0, 2)
    .map(([label, count]) => `${label} ×${count}`);
  if (entries.length > 2) {
    labels.push(`另 ${entries.length - 2} 种`);
  }
  return labels;
}

function workloadEvidenceSummary(payload: Record<string, unknown>): string | null {
  const workload = record(payload.workload);
  const replicas = record(workload?.replicas);
  if (replicas === null) {
    return null;
  }
  const desired = nonNegativeInteger(replicas.desired);
  const available = nonNegativeInteger(replicas.available);
  const ready = nonNegativeInteger(replicas.ready);
  const updated = nonNegativeInteger(replicas.updated);
  const facts: string[] = [];
  if (available !== null && desired !== null) {
    facts.push(`可用副本 ${available}/${desired}`);
  } else if (available !== null) {
    facts.push(`可用副本 ${available}`);
  } else if (desired !== null) {
    facts.push(`期望副本 ${desired}`);
  }
  if (ready !== null) {
    facts.push(`就绪 ${ready}`);
  }
  if (updated !== null) {
    facts.push(`已更新 ${updated}`);
  }
  return facts.length === 0 ? null : `工作负载：${facts.join(" · ")}`;
}

function podsEvidenceSummary(payload: Record<string, unknown>): string | null {
  const pods = recordArray(payload.pods);
  if (pods === null) {
    return null;
  }
  if (pods.length === 0) {
    return "Pod：未发现关联 Pod";
  }

  const phases: string[] = [];
  const waitingReasons: string[] = [];
  let restartCount = 0;
  for (const pod of pods) {
    const phase = nonEmptyString(pod.phase);
    if (phase !== null) {
      phases.push(phase);
    }
    const containers = recordArray(pod.containers);
    if (containers === null) {
      continue;
    }
    for (const container of containers) {
      restartCount += nonNegativeInteger(container.restartCount) ?? 0;
      const state = record(container.state);
      if (state?.status !== "waiting") {
        continue;
      }
      const reason = nonEmptyString(state.reason);
      if (reason !== null) {
        waitingReasons.push(reason);
      }
    }
  }

  const facts = [
    `共 ${pods.length} 个`,
    ...countedLabels(phases),
    ...countedLabels(waitingReasons),
  ];
  if (restartCount > 0) {
    facts.push(`重启 ${restartCount} 次`);
  }
  return `Pod：${facts.join(" · ")}`;
}

function eventsEvidenceSummary(payload: Record<string, unknown>): string | null {
  const events = recordArray(payload.events);
  if (events === null) {
    return null;
  }
  if (events.length === 0) {
    return "Kubernetes 事件：未发现关联事件";
  }

  const types: string[] = [];
  const reasons: string[] = [];
  for (const event of events) {
    const type = nonEmptyString(event.type);
    const reason = nonEmptyString(event.reason);
    if (type !== null) {
      types.push(type);
    }
    if (reason !== null) {
      reasons.push(reason);
    }
  }
  return `Kubernetes 事件：${[
    `共 ${events.length} 条`,
    ...countedLabels(types),
    ...countedLabels(reasons),
  ].join(" · ")}`;
}

function containerLogsEvidenceSummary(
  payload: Record<string, unknown>,
): string | null {
  const containers = recordArray(payload.containers);
  if (containers === null) {
    return null;
  }
  if (containers.length === 0) {
    return "容器日志：未发现可读取的容器日志";
  }

  let restartCount = 0;
  let currentLines = 0;
  let previousLines = 0;
  for (const container of containers) {
    restartCount += nonNegativeInteger(container.restartCount) ?? 0;
    const snapshots = recordArray(container.snapshots);
    if (snapshots === null) {
      continue;
    }
    for (const snapshot of snapshots) {
      const source = nonEmptyString(snapshot.source);
      const lines = Array.isArray(snapshot.lines) ? snapshot.lines.length : 0;
      if (source === "current") {
        currentLines += lines;
      } else if (source === "previous") {
        previousLines += lines;
      }
    }
  }

  const facts = [`共 ${containers.length} 个容器`];
  if (restartCount > 0) {
    facts.push(`重启 ${restartCount} 次`);
  }
  facts.push(`当前日志 ${currentLines} 行`, `上次日志 ${previousLines} 行`);
  return `容器日志：${facts.join(" · ")}`;
}

function metricsEvidenceSummary(payload: Record<string, unknown>): string | null {
  const result = record(payload.result);
  const title = nonEmptyString(result?.title);
  if (result === null || title === null) {
    return null;
  }
  const facts = [title];
  const currentValue = finiteNumber(result.currentValue);
  const threshold = finiteNumber(result.threshold);
  const riskDirection = nonEmptyString(result.riskDirection);
  if (
    (riskDirection !== "higher_is_worse" &&
      riskDirection !== "lower_is_worse") ||
    (riskDirection === "higher_is_worse" && threshold === null)
  ) {
    return null;
  }
  if (currentValue !== null) {
    facts.push(`当前值 ${currentValue}`);
  }
  const state = nonEmptyString(result.state);
  const stateLabel =
    state === "no_data"
      ? "无数据"
      : state === "stale"
        ? "数据已过期"
        : state === "partial"
          ? "数据不完整"
          : state === "query_error"
            ? "查询失败"
            : state === "monitoring_unavailable"
              ? "监控不可用"
              : null;
  if (stateLabel !== null) {
    facts.push(stateLabel);
  }
  if (threshold !== null) {
    facts.push(`阈值 ${threshold}`);
  } else {
    facts.push("风险方向 数值下降");
  }
  return facts.length === 1 ? null : `指标：${facts.join(" · ")}`;
}

export function evidenceSummary(evidence: EvidenceResponse): string {
  const summary =
    evidence.evidenceKind === "workload"
      ? workloadEvidenceSummary(evidence.payload)
      : evidence.evidenceKind === "pods"
        ? podsEvidenceSummary(evidence.payload)
        : evidence.evidenceKind === "events"
          ? eventsEvidenceSummary(evidence.payload)
          : evidence.evidenceKind === "container_logs"
            ? containerLogsEvidenceSummary(evidence.payload)
            : evidence.evidenceKind === "metrics"
              ? metricsEvidenceSummary(evidence.payload)
              : null;
  return (
    summary ??
    `${evidence.evidenceKind} · ${evidence.toolName} · ${evidenceTargetLabel(evidence.targetRef)}`
  );
}

function newestEvidence(
  evidence: EvidenceResponse[],
  kind: EvidenceResponse["evidenceKind"],
): EvidenceResponse | null {
  let newest: EvidenceResponse | null = null;
  for (const item of evidence) {
    if (
      item.evidenceKind === kind &&
      (newest === null ||
        Date.parse(item.observedAt) > Date.parse(newest.observedAt))
    ) {
      newest = item;
    }
  }
  return newest;
}

export function incidentDesiredReplicas(evidence: EvidenceResponse[]): number | null {
  const workloadEvidence = newestEvidence(evidence, "workload");
  const workload = record(workloadEvidence?.payload.workload);
  const replicas = record(workload?.replicas);
  return nonNegativeInteger(replicas?.desired);
}
