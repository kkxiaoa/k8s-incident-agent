import { LocalTimestamp } from "@/components/local-timestamp";
import { ShimmerText } from "@/components/ui/shimmer-text";
import type {
  IncidentStreamConnection,
  RunEventStreamItem,
} from "@/lib/agent-runtime/sse";

const CONNECTION_LABELS: Record<IncidentStreamConnection, string> = {
  connecting: "正在连接事件流",
  live: "实时追踪中",
  reconnecting: "连接中断，正在恢复",
  invalid: "事件流数据无效",
};

function eventCopy(event: RunEventStreamItem): {
  title: string;
  detail: string;
  tone: string;
} {
  switch (event.event) {
    case "incident.created":
      return {
        title: "Incident 已创建",
        detail: `第 ${event.data.attempt} 次诊断已排队`,
        tone: "success",
      };
    case "run.queued":
      return {
        title: event.data.runKind === "diagnosis" ? "诊断运行已排队" : "修复运行已排队",
        detail: `第 ${event.data.attempt} 次运行`,
        tone: "neutral",
      };
    case "run.started":
      return {
        title: event.data.runKind === "diagnosis" ? "诊断运行已启动" : "修复运行已启动",
        detail: "只读调查开始",
        tone: "active",
      };
    case "tool.started":
      return {
        title: `${event.data.toolName} 开始`,
        detail: event.data.toolCallId,
        tone: "active",
      };
    case "evidence.recorded":
      return {
        title: "已记录 Kubernetes 证据",
        detail: `${event.data.toolName} · ${event.data.evidenceKind}`,
        tone: "success",
      };
    case "tool.failed":
      return {
        title: `${event.data.toolName} 失败`,
        detail: event.data.errorCode,
        tone: "danger",
      };
    case "diagnosis.completed":
      return {
        title: "诊断已完成",
        detail: "证据支持当前结论",
        tone: "success",
      };
    case "repair.patch_ready":
      return {
        title: "修复 Patch 已生成",
        detail: "Patch 已绑定当前资源与 Evidence",
        tone: "success",
      };
    case "repair.dry_run_passed":
      return {
        title: "Server-side dry-run 已通过",
        detail: "尚未批准或执行修复",
        tone: "success",
      };
    case "repair.waiting_approval":
      return {
        title: "等待批准",
        detail: "验证已完成，集群尚未发生持久修改",
        tone: "warning",
      };
    case "repair.wait_ended":
      return {
        title: "等待审批已结束",
        detail: event.data.reason === "expired" ? "提案已过期，未执行修复" : "后继运行已取代此提案，未执行修复",
        tone: "neutral",
      };
    case "repair.approval_decided":
      return {
        title: event.data.decision === "approve" ? "修复已批准" : "修复已拒绝",
        detail: event.data.decision === "approve" ? "已提交唯一执行项，尚无写入成功回执" : "本次申请结束，未执行修复",
        tone: event.data.decision === "approve" ? "success" : "neutral",
      };
    case "repair.execution_updated":
      return {
        title: event.data.lateResult ? "收到迟到成功回执，目标继续占用" : `执行状态：${event.data.executionStatus}`,
        detail: event.data.executionStatus === "APPLIED" ? "API 写入已确认，恢复尚未验证" : event.data.executionStatus === "UNKNOWN" ? "无法确定写入归属，禁止重试或自动回滚" : "执行账本已更新",
        tone: {
          PENDING: "neutral",
          CLAIMED: "active",
          APPLIED: "success",
          EXPIRED: "warning",
          STALE_RESOURCE: "warning",
          REJECTED: "danger",
          UNKNOWN: "danger",
        }[event.data.executionStatus],
      };
    case "repair.verification_updated":
      return {
        title: event.data.outcome === "recovered" ? "恢复验证通过" : event.data.outcome === "observing" ? "恢复观测已保存" : "恢复验证已停止",
        detail: `${event.data.incidentStatus === "ROLLED_BACK" ? "逆向写入已完成；恢复结果单列 · " : ""}${event.data.sampleCount} 次观测 · ${event.data.reason ?? "工作负载与告警判据"}`,
        tone: event.data.outcome === "recovered" ? "success" : event.data.outcome === "observing" ? "active" : "warning",
      };
    case "diagnosis.insufficient":
      return { title: "诊断已结束", detail: "现有证据不足", tone: "warning" };
    case "run.failed":
      return {
        title: event.data.runKind === "diagnosis" ? "诊断运行失败" : "修复运行失败",
        detail: event.data.errorCode,
        tone: "danger",
      };
    case "alert.resolved":
      return {
        title: "告警条件已解除",
        detail: "Alertmanager 已报告 resolved；不代表 Incident 关闭或恢复验证完成。",
        tone: "success",
      };
  }
}

function runningToolCalls(events: RunEventStreamItem[]): ReadonlySet<string> {
  const running = new Set<string>();
  for (const event of events) {
    if (event.event === "tool.started") {
      running.add(event.data.toolCallId);
    } else if (
      event.event === "evidence.recorded" ||
      event.event === "tool.failed"
    ) {
      running.delete(event.data.toolCallId);
    }
  }
  return running;
}

export function RunTimeline({
  events,
  connection,
}: {
  events: RunEventStreamItem[];
  connection: IncidentStreamConnection;
}) {
  const running = runningToolCalls(events);
  const streamCanBeRunning =
    connection === "connecting" ||
    connection === "live" ||
    connection === "reconnecting";
  const latestEventId = events.at(-1)?.id;

  return (
    <section className="console-section" aria-labelledby="timeline-heading">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Persisted event stream</span>
          <h2 id="timeline-heading">运行时间线</h2>
        </div>
        <span
          className={`connection-state connection-state--${connection}`}
          role="status"
        >
          {CONNECTION_LABELS[connection]}
        </span>
      </div>

      {events.length === 0 ? (
        <p
          className={`empty-state empty-state--panel${streamCanBeRunning ? " timeline-waiting" : ""}`}
        >
          <ShimmerText active={streamCanBeRunning}>
            {connection === "invalid"
                ? "事件流已停止，未收到有效运行事件。"
                : "正在等待持久化运行事件"}
          </ShimmerText>
        </p>
      ) : (
        <ol className="timeline">
          {events.map((event) => {
            const copy = eventCopy(event);
            const isRunning =
              streamCanBeRunning &&
              ((event.event === "tool.started" &&
                running.has(event.data.toolCallId)) ||
                ((event.event === "run.started" || event.event === "run.queued") &&
                  event.id === latestEventId));
            return (
              <li
                key={event.id}
                className={`timeline__item timeline__item--${copy.tone}${isRunning ? " timeline__item--running" : ""}`}
              >
                <span className="timeline__dot" aria-hidden="true" />
                <div className="timeline__body">
                  <div className="timeline__topline">
                    <strong>{copy.title}</strong>
                    <div className="timeline__event-meta">
                      {isRunning ? (
                        <span className="timeline__activity"><ShimmerText>运行中</ShimmerText></span>
                      ) : null}
                      <code>#{event.id}</code>
                    </div>
                  </div>
                  <p>{copy.detail}</p>
                  <LocalTimestamp timestamp={event.data.occurredAt} />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
