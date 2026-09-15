import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { components } from "@/lib/agent-runtime/generated";
import { parseRunEvent } from "@/lib/agent-runtime/sse";
import {
  DIAGNOSIS_ID,
  EVIDENCE_ID,
  INCIDENT_ID,
  RUN_ID,
  makeIncidentDetail,
  makeWaitingApprovalIncidentDetail,
  makeRepairRunWaitingDetail,
  makeRecoveryDetail,
} from "@/test/agent-runtime-fixtures";

import { DiagnosisPanel } from "./diagnosis-panel";
import { EvidenceList } from "./evidence-card";
import { JsonViewer } from "./json-viewer";
import { IncidentList } from "./incident-list";
import { IncidentStatusBadge, RunStatusBadge } from "./incident-status";
import { IncidentStream } from "./incident-stream";
import { RunTimeline } from "./run-timeline";
import { ScenarioLauncher } from "./scenario-launcher";
import IncidentError from "@/app/incidents/[incidentId]/error";

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));

type Scenario = components["schemas"]["ScenarioResponse"];

const SCENARIO: Scenario = {
  scenarioId: "image-pull-backoff",
  scenarioVersion: 1,
  displayName: "镜像拉取失败",
  description: "诊断 ImagePullBackOff。",
  target: {
    apiVersion: "v1",
    kind: "Pod",
    namespace: "incident-demo",
    name: "broken-image",
    cluster: "kind-k8s-incident-agent",
  },
  trigger: {
    type: "manual",
    summary: "Pod 无法拉取镜像。",
  },
};

const SECOND_SCENARIO: Scenario = {
  ...SCENARIO,
  scenarioId: "image-pull-secret",
  displayName: "镜像凭据异常",
  description: "诊断镜像仓库凭据失败。",
  target: {
    ...SCENARIO.target,
    name: "private-image",
  },
};

class FakeEventSource {
  static current: FakeEventSource | null = null;

  readonly close = vi.fn();
  readonly listeners = new Map<string, EventListener>();
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.current = this;
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (this.listeners.get(type) === listener) {
      this.listeners.delete(type);
    }
  }

  emit(type: string, id: string, data: Record<string, unknown>): void {
    this.listeners.get(type)?.(
      new MessageEvent(type, {
        data: JSON.stringify(data),
        lastEventId: id,
      }),
    );
  }
}

function detailResponse(detail = makeIncidentDetail()): Response {
  return new Response(JSON.stringify(detail), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function renderIncidentStream(detail = makeIncidentDetail()) {
  return render(
    <IncidentStream
      initialDetail={detail}
      initialRuns={{
        items: [
          {
            id: detail.selectedRun.id,
            kind: detail.selectedRun.kind,
            operation: detail.selectedRun.operation,
            attempt: detail.selectedRun.attempt,
            status: detail.selectedRun.status,
            createdAt: detail.selectedRun.createdAt,
            startedAt: detail.selectedRun.startedAt,
            completedAt: detail.selectedRun.completedAt,
          },
        ],
        nextCursor: null,
      }}
      latestMode
      manualActions
    />,
  );
}

it.each(["apply", "rollback"] as const)("labels a waiting %s Run and allows operator rediagnosis", async (operation) => {
  vi.stubGlobal("EventSource", FakeEventSource);
  const detail = makeRepairRunWaitingDetail();
  detail.selectedRun.operation = operation;
  renderIncidentStream(detail);
  const label = operation === "apply" ? "修复" : "回滚";
  await userEvent.setup().click(screen.getByText("选择运行记录"));
  expect(screen.getByRole("link", { name: `第 2 次 · ${label} · 等待审批` })).toBeVisible();
  expect(screen.getByRole("button", { name: "重新诊断" })).toBeEnabled();
  expect(screen.getByRole("heading", { name: "诊断结论" })).toBeVisible();
  expect(screen.getByText(/来源诊断暂不可用/)).toBeVisible();
  expect(screen.getByText("事件记录").closest("details")).toHaveAttribute("open");
  expect(screen.getByText(`第 2 次运行 · ${label}提案`)).toBeVisible();
});

afterEach(() => {
  navigation.push.mockReset();
  navigation.replace.mockReset();
  navigation.refresh.mockReset();
  FakeEventSource.current = null;
});

describe("repair detail refresh", () => {
  it.each(["passed", "unavailable", "invalid"])("waits for the persisted repair snapshot: %s", async (outcome) => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveRequest!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveRequest = resolve; }));
    stubSessionFetch("fetch", fetchMock);
    const terminal = makeWaitingApprovalIncidentDetail();
    terminal.eventCursor = "20";
    const initial = structuredClone(terminal);
    initial.repair = null;
    initial.incident.status = "TRIAGING";
    initial.selectedRun.status = "RUNNING";
    initial.selectedRun.completedAt = null;
    initial.eventCursor = "1";
    renderIncidentStream(initial);
    act(() => FakeEventSource.current!.emit("repair.waiting_approval", "20", {
      schemaVersion: 5,
      incidentId: INCIDENT_ID,
      runId: RUN_ID,
      proposalId: terminal.repair!.id,
      proposalDigest: terminal.repair!.digest,
      incidentStatus: "WAITING_APPROVAL",
      runStatus: "COMPLETED",
      runKind: "diagnosis",
      occurredAt: "2026-08-29T01:00:08Z",
    }));
    expect(screen.getByText("正在读取持久化的修复验证结果…")).toBeInTheDocument();
    expect(screen.queryByText("只读建议已保存，需重新准备后才能审批")).not.toBeInTheDocument();
    const response = outcome === "unavailable"
      ? new Response(null, { status: 503 })
      : outcome === "invalid"
        ? detailResponse({ ...terminal, repair: {} } as typeof terminal)
        : detailResponse(terminal);
    await act(async () => resolveRequest(response));
    if (outcome === "passed") {
      expect(screen.getByText("只读建议已保存，需重新准备后才能审批")).toBeInTheDocument();
    } else {
      expect(screen.getByText("修复详情暂不可用")).toBeInTheDocument();
      expect(screen.queryByText("只读建议已保存，需重新准备后才能审批")).not.toBeInTheDocument();
      if (outcome === "invalid") expect(screen.getByText("持久化详情不符合数据契约，未采用该响应。")).toBeInTheDocument();
    }
    expect(fetchMock).toHaveBeenCalledWith(`/api/runtime/incidents/${INCIDENT_ID}`, expect.objectContaining({ method: "GET", cache: "no-store" }));
  });
});

describe("ScenarioLauncher", () => {
  it("renders the empty state without an inert create control", () => {
    render(<ScenarioLauncher scenarios={[]} />);

    expect(screen.getByText("当前没有可启动的诊断场景。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "创建 Incident" })).toBeNull();
  });

  it("creates through the relative BFF and navigates to the persisted id", async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    const request = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn(() => request);
    stubSessionFetch("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ScenarioLauncher scenarios={[SCENARIO]} />);
    await user.click(screen.getByRole("button", { name: "创建 Incident" }));

    expect(screen.getByRole("button", { name: "正在创建…" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/incidents",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ scenarioId: SCENARIO.scenarioId }),
      }),
    );

    resolveRequest?.(
      new Response(
        JSON.stringify({
          schemaVersion: 5,
          incidentId: INCIDENT_ID,
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );

    await waitFor(() => {
      expect(navigation.push).toHaveBeenCalledWith(`/incidents/${INCIDENT_ID}`);
    });
  });

  it("opens a keyboard-operable dropdown and creates the selected scenario", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: 5,
          incidentId: INCIDENT_ID,
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );
    stubSessionFetch("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ScenarioLauncher scenarios={[SCENARIO, SECOND_SCENARIO]} />);

    const dropdown = screen.getByRole("combobox", { name: "诊断场景" });
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.click(dropdown);
    expect(screen.getByRole("listbox", { name: "诊断场景" })).toBeVisible();
    expect(screen.getByRole("option", { name: "镜像拉取失败" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.keyboard("{ArrowDown}{Enter}");
    expect(dropdown).toHaveTextContent("镜像凭据异常");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText("诊断镜像仓库凭据失败。")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "创建 Incident" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/incidents",
      expect.objectContaining({
        body: JSON.stringify({ scenarioId: SECOND_SCENARIO.scenarioId }),
      }),
    );
  });

  it("explains a diagnostic outage without creating or navigating away", async () => {
    stubSessionFetch("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: {
      code: "diagnosis_unavailable", message: "Model diagnosis is unavailable.", retryable: true,
    } }), { status: 503, headers: { "content-type": "application/json" } })));
    const user = userEvent.setup();
    render(<ScenarioLauncher scenarios={[SCENARIO]} />);
    await user.click(screen.getByRole("button", { name: "创建 Incident" }));
    expect(await screen.findByText(/模型诊断暂不可用，未创建 Incident/)).toBeVisible();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("keeps a safe retryable error in the launcher", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "upstream_unavailable",
              message: "Agent Runtime is unavailable.",
              retryable: true,
            },
          }),
          { status: 502, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const user = userEvent.setup();

    render(<ScenarioLauncher scenarios={[SCENARIO]} />);
    await user.click(screen.getByRole("button", { name: "创建 Incident" }));

    expect(
      await screen.findByText("暂时无法创建 Incident，请稍后重试。"),
    ).toBeVisible();
    expect(navigation.push).not.toHaveBeenCalled();
  });
});

describe("read-only incident presentation", () => {
  it("keeps Alertmanager signal state distinct from the Incident status", () => {
    const detail = makeIncidentDetail();
    detail.incident.status = "DIAGNOSED";
    detail.incident.source = {
      type: "alertmanager",
      ref: "K8sIncidentImagePullBackOff",
      revision: "2026-09-02.1",
    };
    detail.alertSignal = {
      status: "RESOLVED",
      startsAt: "2026-09-02T08:00:00.000000000Z",
      endsAt: "2026-09-02T08:05:00.000000000Z",
    };
    vi.stubGlobal("EventSource", FakeEventSource);

    renderIncidentStream(detail);

    expect(
      screen.getByText(
        "Alertmanager · K8sIncidentImagePullBackOff · catalog 2026-09-02.1",
      ),
    ).toBeVisible();
    expect(screen.getByText(/告警条件解除/, { selector: "dd" })).toHaveAttribute(
      "title",
      "Alertmanager 已报告 resolved；不代表 Incident 关闭或恢复验证完成。",
    );
    expect(screen.getByText("已诊断")).toBeVisible();
  });

  it("renders bounded initial events, subscribes from the snapshot cursor, and keeps terminal streams open", async () => {
    const detail = makeIncidentDetail();
    detail.eventPage.items = [
      parseRunEvent(
        "incident.created",
        "1",
        JSON.stringify({
          schemaVersion: 5,
          incidentId: INCIDENT_ID,
          runId: RUN_ID,
          attempt: 1,
          incidentStatus: "RECEIVED",
          runStatus: "QUEUED",
          runKind: "diagnosis",
          occurredAt: "2026-08-29T01:00:00Z",
        }),
        INCIDENT_ID,
      ),
    ];
    stubSessionFetch("fetch", vi.fn().mockResolvedValue(detailResponse(detail)));
    vi.stubGlobal("EventSource", FakeEventSource);

    renderIncidentStream(detail);
    const source = FakeEventSource.current;
    expect(source?.url).toBe(
      `/api/runtime/incidents/${INCIDENT_ID}/events?cursor=1`,
    );
    expect(screen.getByText("Incident 已创建")).toBeVisible();

    act(() => {
      source?.emit("diagnosis.completed", "2", {
        schemaVersion: 5,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        diagnosisId: DIAGNOSIS_ID,
        incidentStatus: "DIAGNOSED",
        outcome: "diagnosed",
        runStatus: "COMPLETED",
        runKind: "diagnosis",
        occurredAt: "2026-08-29T01:00:04Z",
      });
    });

    expect(await screen.findByText("诊断已完成")).toBeVisible();
    expect(source?.close).not.toHaveBeenCalled();
  });

  it("stops a live stream when an event belongs to another Incident", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);

    renderIncidentStream();
    const source = FakeEventSource.current;
    act(() => {
      source?.emit("run.started", "2", {
        schemaVersion: 5,
        incidentId: "66666666-6666-4666-8666-666666666666",
        runId: RUN_ID,
        attempt: 1,
        incidentStatus: "TRIAGING",
        runStatus: "RUNNING",
        runKind: "diagnosis",
        occurredAt: "2026-08-29T01:00:02Z",
      });
    });

    expect(
      await screen.findByText("收到无法验证的运行事件，实时更新已停止。"),
    ).toBeVisible();
    expect(source?.close).toHaveBeenCalledOnce();
  });

  it("keeps saved history visible when a new diagnostic Run is unavailable", async () => {
    const detail = makeIncidentDetail();
    detail.selectedRun.status = "COMPLETED";
    detail.actions.rerun = null;
    const latest = structuredClone(detail);
    latest.actions.rerun = "diagnosis_unavailable";
    stubSessionFetch("fetch", vi.fn(async (_url, init) => init?.method === "POST" ? new Response(JSON.stringify({ error: {
      code: "diagnosis_unavailable", message: "Model diagnosis is unavailable.", retryable: true,
    } }), { status: 503, headers: { "content-type": "application/json" } }) : new Response(JSON.stringify(latest), { headers: { "content-type": "application/json" } })));
    vi.stubGlobal("EventSource", FakeEventSource);
    const user = userEvent.setup();
    renderIncidentStream(detail);
    await user.click(screen.getByRole("button", { name: "重新诊断" }));
    expect(await screen.findByText(/模型诊断暂不可用，未创建新 Run/)).toBeVisible();
    expect(navigation.replace).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "重新诊断" })).toBeDisabled());
  });

  it("rediagnoses a waiting repair by referencing that exact Run", async () => {
    const detail = makeRepairRunWaitingDetail();
    stubSessionFetch(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            schemaVersion: 5,
            runId: "55555555-5555-4555-8555-555555555555",
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("EventSource", FakeEventSource);
    const user = userEvent.setup();

    renderIncidentStream(detail);
    await user.click(screen.getByRole("button", { name: "重新诊断" }));
    await user.click(screen.getByRole("button", { name: "确认重新诊断" }));

    expect(fetch).toHaveBeenCalledWith(
      `/api/runtime/incidents/${INCIDENT_ID}/runs`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ replacesRunId: detail.selectedRun.id }) }),
    );
    expect(navigation.replace).toHaveBeenCalledWith(
      `/incidents/${INCIDENT_ID}?runId=55555555-5555-4555-8555-555555555555`,
    );
    expect(navigation.refresh).toHaveBeenCalledOnce();
  });

  it("reads persisted availability on the first SSE connection, reconnect and window focus", async () => {
    const detail = makeRepairRunWaitingDetail();
    const expired = structuredClone(detail);
    expired.actions.approve = expired.actions.reject = "proposal_expired";
    const reads = vi.fn(async () => Response.json(expired));
    stubSessionFetch("fetch", reads);
    vi.stubGlobal("EventSource", FakeEventSource);
    renderIncidentStream(detail);
    act(() => FakeEventSource.current!.onopen?.(new Event("open")));
    expect(await screen.findByText(/这不是登录会话过期/)).toBeVisible();
    expect(screen.getByRole("button", { name: "审阅并批准" })).toBeDisabled();
    act(() => {
      FakeEventSource.current!.onerror?.(new Event("error"));
      FakeEventSource.current!.onopen?.(new Event("open"));
    });
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(3));
  });

  it("does not treat an approval response as execution or recovery before detail is read", async () => {
    const detail = makeRepairRunWaitingDetail();
    const persisted = makeRecoveryDetail("recovered");
    persisted.eventCursor = "9";
    let releaseRead!: (response: Response) => void;
    const writes = vi.fn();
    stubSessionFetch("fetch", vi.fn(async (_url, init) => {
      if (init?.method === "POST") {
        writes();
        return Response.json(persisted.approval);
      }
      return new Promise<Response>((resolve) => { releaseRead = resolve; });
    }));
    vi.stubGlobal("EventSource", FakeEventSource);
    const user = userEvent.setup();
    renderIncidentStream(detail);
    await user.click(screen.getByRole("button", { name: "审阅并批准" }));
    await user.dblClick(screen.getByRole("button", { name: "批准并执行" }));
    expect(writes).toHaveBeenCalledOnce();
    const panel = screen.getByRole("region", { name: /修复处置|回滚处置|修复建议/ });
    expect(within(panel).queryByText("APPLIED")).toBeNull();
    expect(within(panel).queryByText("工作负载与告警恢复已验证")).toBeNull();
    expect(screen.getByRole("button", { name: "批准并执行" })).toBeDisabled();
    await act(async () => releaseRead(Response.json(persisted)));
    expect(within(panel).getAllByText("APPLIED")[0]).toBeVisible();
    expect(within(panel).getByText("工作负载与告警恢复已验证")).toBeVisible();
    expect(screen.queryByRole("button", { name: "审阅并批准" })).toBeNull();
  });

  it("does not render a rerun action when actions are disabled by its caller", () => {
    const detail = makeIncidentDetail();
    detail.selectedRun.status = "COMPLETED";
    vi.stubGlobal("EventSource", FakeEventSource);

    render(
      <IncidentStream
        initialDetail={detail}
        initialRuns={{ items: [], nextCursor: null }}
        latestMode
        manualActions={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "重新诊断" })).toBeNull();
  });

  it("blocks historical rediagnosis while an UNKNOWN ledger refresh is pending and after it is persisted", async () => {
    const detail = makeIncidentDetail();
    detail.selectedRun.status = "COMPLETED";
    detail.actions.rerun = null;
    let resolveRequest!: (response: Response) => void;
    stubSessionFetch("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    })));
    vi.stubGlobal("EventSource", FakeEventSource);
    renderIncidentStream(detail);
    expect(screen.getByRole("button", { name: "重新诊断" })).toBeEnabled();

    act(() => FakeEventSource.current!.emit("repair.execution_updated", "999", {
      schemaVersion: 5,
      incidentId: INCIDENT_ID,
      runId: "55555555-5555-4555-8555-555555555555",
      runKind: "repair",
      occurredAt: "2026-09-13T01:00:00Z",
      approvalId: "66666666-6666-4666-8666-666666666666",
      executionId: "77777777-7777-4777-8777-777777777777",
      executionStatus: "UNKNOWN",
      runStatus: "FAILED",
      incidentStatus: "FAILED",
      lateResult: false,
    }));
    expect(screen.getByRole("button", { name: "重新诊断" })).toBeDisabled();
    const persisted = structuredClone(detail);
    persisted.actions.rerun = "execution_held";
    persisted.incident.status = "FAILED";
    persisted.eventCursor = "999";
    await act(async () => resolveRequest(detailResponse(persisted)));
    expect(screen.getByRole("button", { name: "重新诊断" })).toBeDisabled();
  });

  it("renders a historical failed Run after the Incident has recovered", () => {
    const detail = makeIncidentDetail();
    detail.incident.status = "DIAGNOSED";
    detail.selectedRun.status = "FAILED";
    detail.selectedRun.error = {
      code: "workflow_failed",
      retryable: false,
    };
    vi.stubGlobal("EventSource", FakeEventSource);

    renderIncidentStream(detail);

    expect(screen.getByText("诊断运行失败")).toBeVisible();
    expect(screen.getByText("workflow_failed")).toBeVisible();
  });

  it("coalesces persisted detail refreshes during replay", async () => {
    let resolveFirstRequest: (response: Response) => void = () => {
      throw new Error("First detail request was not started");
    };
    const firstRequest = new Promise<Response>((resolve) => {
      resolveFirstRequest = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstRequest)
      .mockImplementation(() => Promise.resolve(detailResponse()));
    stubSessionFetch("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);

    renderIncidentStream();
    const source = FakeEventSource.current;
    expect(source).not.toBeNull();

    act(() => {
      source?.emit("incident.created", "1", {
        schemaVersion: 5,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        attempt: 1,
        incidentStatus: "RECEIVED",
        runStatus: "QUEUED",
        runKind: "diagnosis",
        occurredAt: "2026-08-29T01:00:00Z",
      });
      source?.emit("run.started", "2", {
        schemaVersion: 5,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        attempt: 1,
        incidentStatus: "TRIAGING",
        runStatus: "RUNNING",
        runKind: "diagnosis",
        occurredAt: "2026-08-29T01:00:01Z",
      });
      source?.emit("tool.started", "3", {
        schemaVersion: 5,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        toolCallId: "tool-call-1",
        toolName: "get_pod",
        runKind: "diagnosis",
        occurredAt: "2026-08-29T01:00:02Z",
      });
    });
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => {
      for (const id of ["4", "5", "6"]) {
        source?.emit("evidence.recorded", id, {
          schemaVersion: 5,
          incidentId: INCIDENT_ID,
          runId: RUN_ID,
          evidenceId: EVIDENCE_ID,
          evidenceKind: "kubernetes.pod",
          observedAt: "2026-08-29T01:00:03Z",
          redacted: false,
          toolCallId: `tool-call-${id}`,
          toolName: "get_pod",
          truncated: false,
          runKind: "diagnosis",
          occurredAt: "2026-08-29T01:00:03Z",
        });
      }
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveFirstRequest(detailResponse());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("keeps an evidence refresh current across later timeline-only events", async () => {
    let resolveRequest: (response: Response) => void = () => {
      throw new Error("Detail request was not started");
    };
    const request = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn(() => request);
    stubSessionFetch("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);
    const initialDetail = makeIncidentDetail();
    initialDetail.evidence = [];

    renderIncidentStream(initialDetail);
    const source = FakeEventSource.current;

    act(() => {
      source?.emit("evidence.recorded", "4", {
        schemaVersion: 5,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        evidenceId: EVIDENCE_ID,
        evidenceKind: "kubernetes.pod",
        observedAt: "2026-08-29T01:00:03Z",
        redacted: false,
        toolCallId: "tool-call-1",
        toolName: "get_pod",
        truncated: false,
        runKind: "diagnosis",
        occurredAt: "2026-08-29T01:00:03Z",
      });
      source?.emit("tool.started", "5", {
        schemaVersion: 5,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        toolCallId: "tool-call-2",
        toolName: "get_events",
        runKind: "diagnosis",
        occurredAt: "2026-08-29T01:00:04Z",
      });
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const refreshedDetail = makeIncidentDetail();
    refreshedDetail.evidence = [
      {
        id: EVIDENCE_ID,
        toolCallId: "tool-call-1",
        toolName: "get_pod",
        evidenceKind: "kubernetes.pod",
        targetRef: { namespace: "incident-demo", name: "broken-image" },
        observedAt: "2026-08-29T01:00:03Z",
        payload: { phase: "Pending" },
        truncated: false,
        redacted: false,
      },
    ];
    resolveRequest(detailResponse(refreshedDetail));

    expect(await screen.findByTestId(`evidence-${EVIDENCE_ID}`)).toBeVisible();
  });

  it("retries the Server Component fetch from the detail error boundary", async () => {
    const retry = vi.fn();
    const user = userEvent.setup();

    render(<IncidentError error={new Error("hidden")} retry={retry} />);
    await user.click(screen.getByRole("button", { name: "重新读取" }));

    expect(retry).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("heading", { name: "页面暂时不可用" }),
    ).toBeVisible();
    expect(screen.queryByText(/Render error|Incident 页面/)).toBeNull();
    expect(screen.queryByText("hidden")).toBeNull();
  });

  it.each([
    ["RECEIVED", "已接收"],
    ["TRIAGING", "诊断中"],
    ["DIAGNOSED", "已诊断"],
    ["INSUFFICIENT_EVIDENCE", "证据不足"],
    ["FAILED", "失败"],
  ] as const)("renders Incident status %s", (status, label) => {
    render(<IncidentStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeVisible();
  });

  it.each([
    ["QUEUED", "等待运行"],
    ["RUNNING", "运行中"],
    ["COMPLETED", "已完成"],
    ["FAILED", "运行失败"],
  ] as const)("renders Run status %s", (status, label) => {
    render(<RunStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeVisible();
  });

  it("links persisted incidents and renders their statuses", () => {
    const detail = makeIncidentDetail();
    render(
      <IncidentList
        incidents={[
          {
            id: detail.incident.id,
            displayName: detail.incident.displayName,
            target: detail.incident.target,
            status: "TRIAGING",
            updatedAt: detail.incident.createdAt,
          },
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: /Image pull failure/ })).toHaveAttribute(
      "href",
      `/incidents/${INCIDENT_ID}`,
    );
    expect(screen.getByText("诊断中")).toBeVisible();
    expect(document.querySelector("time")).toHaveAttribute(
      "datetime",
      detail.incident.createdAt,
    );
    expect(screen.queryByText(/ UTC$/)).toBeNull();
    expect(document.querySelector('td[data-label="Incident"]')).toHaveAttribute(
      "headers",
      "incident-column-name",
    );
    expect(document.querySelector("#incident-column-name")).toHaveAttribute(
      "scope",
      "col",
    );
  });

  it("shows normalized evidence with safe JSON copy and expansion actions", async () => {
    const detail = makeIncidentDetail();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    detail.evidence = [
      {
        id: EVIDENCE_ID,
        toolCallId: "tool-call-1",
        toolName: "get_pod",
        evidenceKind: "kubernetes.pod",
        targetRef: { namespace: "incident-demo", name: "broken-image" },
        observedAt: "2026-08-29T01:00:02Z",
        payload: { message: '<img src=x onerror="alert(1)">' },
        truncated: true,
        redacted: true,
      },
    ];

    render(<EvidenceList evidence={detail.evidence} />);

    const evidence = screen.getByTestId(`evidence-${EVIDENCE_ID}`);
    expect(within(evidence).getByText("get_pod")).toBeVisible();
    expect(within(evidence).getByText("已脱敏")).toBeVisible();
    expect(within(evidence).getByText("已截断")).toBeVisible();
    expect(within(evidence).getAllByText(/<img src=x/)[0]).toBeVisible();
    expect(within(evidence).queryByRole("img")).toBeNull();
    expect(within(evidence).getByText("JSON")).toBeVisible();
    expect(
      within(evidence).getAllByText(/<img src=x/)[0].closest("code"),
    ).toHaveClass("language-json");

    const copyButton = within(evidence).getByRole("button", { name: "复制 JSON" });
    const expandButton = within(evidence).getByRole("button", { name: "展开 JSON" });
    expect(copyButton).toHaveTextContent("");
    expect(copyButton.querySelector(".ui-icon")).not.toBeNull();
    expect(expandButton).toHaveTextContent("");
    expect(expandButton.querySelector(".ui-icon")).not.toBeNull();

    await user.click(copyButton);
    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify(detail.evidence[0].payload, null, 2),
    );
    expect(
      within(evidence).getByRole("button", { name: "JSON 已复制" }),
    ).toBeVisible();

    await user.click(expandButton);
    const dialog = screen.getByRole("dialog", { name: "kubernetes.pod JSON" });
    expect(dialog).toHaveAttribute("open");
    expect(document.documentElement).toHaveClass("dialog-scroll-locked");
    expect(within(dialog).getByText(/<img src=x/)).toBeVisible();
    const closeButton = within(dialog).getByRole("button", { name: "关闭" });
    expect(closeButton.querySelector(".ui-icon")).not.toBeNull();
    expect(closeButton).not.toHaveTextContent("关闭");
    await user.click(closeButton);
    expect(dialog).not.toHaveAttribute("open");
    expect(document.documentElement).not.toHaveClass("dialog-scroll-locked");
  });

  it("makes a rejected clipboard write visibly discoverable", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    render(
      <JsonViewer
        title="kubernetes.pod JSON"
        json={JSON.stringify({ phase: "Pending" }, null, 2)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "复制 JSON" }));

    const failedButton = screen.getByRole("button", { name: "JSON 复制失败" });
    expect(failedButton).toHaveClass("is-copy-failed");
    expect(failedButton).toHaveAttribute("data-feedback", "复制失败");
    expect(screen.getByRole("status")).toHaveTextContent("JSON 复制失败");
  });

  it("reports a rejected clipboard write inside the open dialog", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    render(
      <JsonViewer
        title="kubernetes.pod JSON"
        json={JSON.stringify({ phase: "Pending" }, null, 2)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "展开 JSON" }));
    const dialog = screen.getByRole("dialog", { name: "kubernetes.pod JSON" });
    await user.click(within(dialog).getByRole("button", { name: "复制 JSON" }));

    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "JSON 复制失败",
    );
    expect(
      within(dialog).getByRole("button", { name: "JSON 复制失败" }),
    ).toHaveAttribute("data-feedback", "复制失败");
  });

  it("marks only unresolved tool calls as running", () => {
    const firstStarted = parseRunEvent(
      "tool.started",
      "1",
      JSON.stringify({
        schemaVersion: 5,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        toolCallId: "tool-call-1",
        toolName: "get_pods",
        runKind: "diagnosis",
        occurredAt: "2026-08-29T01:00:01Z",
      }),
      INCIDENT_ID,
    );
    const firstEvidence = parseRunEvent(
      "evidence.recorded",
      "2",
      JSON.stringify({
        schemaVersion: 5,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        evidenceId: EVIDENCE_ID,
        evidenceKind: "kubernetes.pods",
        observedAt: "2026-08-29T01:00:02Z",
        redacted: false,
        toolCallId: "tool-call-1",
        toolName: "get_pods",
        truncated: false,
        runKind: "diagnosis",
        occurredAt: "2026-08-29T01:00:02Z",
      }),
      INCIDENT_ID,
    );
    const secondStarted = parseRunEvent(
      "tool.started",
      "3",
      JSON.stringify({
        schemaVersion: 5,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        toolCallId: "tool-call-2",
        toolName: "get_events",
        runKind: "diagnosis",
        occurredAt: "2026-08-29T01:00:03Z",
      }),
      INCIDENT_ID,
    );

    const { rerender } = render(
      <RunTimeline
        events={[firstStarted, firstEvidence, secondStarted]}
        connection="live"
      />,
    );

    expect(screen.getByText("get_pods 开始").closest("li")).not.toHaveClass(
      "timeline__item--running",
    );
    const running = screen.getByText("get_events 开始").closest("li");
    expect(running).toHaveClass("timeline__item--running");
    expect(within(running as HTMLElement).getByText("运行中")).toBeVisible();

    rerender(
      <RunTimeline
        events={[firstStarted, firstEvidence, secondStarted]}
        connection="invalid"
      />,
    );
    expect(screen.getByText("get_events 开始").closest("li")).not.toHaveClass(
      "timeline__item--running",
    );
  });

  it("uses an animated waiting presentation only while the stream is active", () => {
    const { rerender } = render(<RunTimeline events={[]} connection="live" />);

    expect(screen.getByText("正在等待持久化运行事件")).toHaveClass(
      "text-shimmer",
    );

    rerender(<RunTimeline events={[]} connection="invalid" />);
    expect(screen.getByText("事件流已停止，未收到有效运行事件。")).not.toHaveClass(
      "text-shimmer",
    );
  });

  it("connects diagnosis claims to evidence and exposes uncertainty", () => {
    const detail = makeIncidentDetail();
    detail.incident.status = "INSUFFICIENT_EVIDENCE";
    detail.diagnosis = {
      id: DIAGNOSIS_ID,
      outcome: "insufficient_evidence",
      summary: "现有 Kubernetes 证据不足以确认根因。",
      rootCauses: [
        {
          code: "image_reference_invalid",
          statement: "镜像引用可能无效。",
          confidence: "low",
          evidenceIds: [EVIDENCE_ID],
        },
      ],
      missingInformation: ["镜像仓库端的拉取审计记录"],
      redacted: true,
      createdAt: "2026-08-29T01:00:04Z",
    };
    detail.evidence = [
      {
        id: EVIDENCE_ID,
        toolCallId: "tool-call-1",
        toolName: "get_pods",
        evidenceKind: "pods",
        targetRef: {
          kind: "Deployment",
          namespace: "incident-demo",
          name: "broken-image",
        },
        observedAt: "2026-08-29T01:00:02Z",
        payload: { pods: [] },
        truncated: true,
        redacted: true,
      },
    ];

    render(
      <DiagnosisPanel
        diagnosis={detail.diagnosis}
        evidence={detail.evidence}
        runStatus="COMPLETED"
        runError={null}
      />,
    );

    expect(screen.getByText("证据不足")).toBeVisible();
    expect(screen.getByText(/根因（低置信度）/)).toBeVisible();
    expect(
      screen.getByRole("link", {
        name: "查看证据：Pod：未发现关联 Pod",
      }),
    ).toHaveAttribute(
      "href",
      `#evidence-${EVIDENCE_ID}`,
    );
    const evidenceRow = screen
      .getByRole("link", {
        name: "查看证据：Pod：未发现关联 Pod",
      })
      .closest("li");
    expect(evidenceRow).toHaveTextContent("Pod：未发现关联 Pod");
    expect(evidenceRow).toHaveTextContent("已脱敏 · 已截断");
    expect(evidenceRow).not.toHaveTextContent("2026");
    expect(screen.getByText("镜像仓库端的拉取审计记录")).toBeVisible();
    expect(screen.getByText("诊断文本已脱敏")).toBeVisible();
  });

  it("renders tool failure and terminal failure without write controls", () => {
    const toolStarted = parseRunEvent(
      "tool.started",
      "7",
      JSON.stringify({
        schemaVersion: 5,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        toolCallId: "tool-call-1",
        toolName: "get_events",
        runKind: "diagnosis",
        occurredAt: "2026-08-29T01:00:02Z",
      }),
      INCIDENT_ID,
    );
    const toolFailure = parseRunEvent(
      "tool.failed",
      "8",
      JSON.stringify({
        schemaVersion: 5,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        toolCallId: "tool-call-1",
        toolName: "get_events",
        errorCode: "kubernetes_forbidden",
        retryable: false,
        runKind: "diagnosis",
        occurredAt: "2026-08-29T01:00:03Z",
      }),
      INCIDENT_ID,
    );

    render(
      <>
        <RunTimeline events={[toolStarted, toolFailure]} connection="invalid" />
        <DiagnosisPanel
          diagnosis={null}
          runStatus="FAILED"
          runError={{ code: "workflow_failed", retryable: false }}
        />
      </>,
    );

    expect(screen.getByText("get_events 开始")).toBeVisible();
    expect(screen.getByText("get_events 失败")).toBeVisible();
    expect(screen.getByText("kubernetes_forbidden")).toBeVisible();
    expect(screen.getByText("诊断运行失败")).toBeVisible();
    expect(screen.queryByRole("button", { name: /批准|执行|回滚|Apply/i })).toBeNull();
    expect(
      screen.queryByText(
        /fixture install|cleanup|Prometheus|kubeconfig|Secret|Prompt expectation/i,
      ),
    ).toBeNull();
  });

  it("renders resolved as a signal event rather than a recovery result", () => {
    const resolved = parseRunEvent(
      "alert.resolved",
      "9",
      JSON.stringify({
        schemaVersion: 5,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        alertStatus: "RESOLVED",
        endsAt: "2026-09-02T08:05:00.000000000Z",
        runKind: "diagnosis",
        occurredAt: "2026-09-02T08:05:01Z",
      }),
      INCIDENT_ID,
    );

    render(<RunTimeline events={[resolved]} connection="live" />);

    expect(screen.getByText("告警条件已解除")).toBeVisible();
    expect(
      screen.getByText(
        "Alertmanager 已报告 resolved；不代表 Incident 关闭或恢复验证完成。",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Incident 已恢复")).toBeNull();
  });

  it.each([
    ["expired", "提案已过期，未执行修复"],
    ["superseded", "后继运行已取代此提案，未执行修复"],
  ])("renders %s as an ended wait, not recovery", (reason, message) => {
    const ended = parseRunEvent("repair.wait_ended", "9", JSON.stringify({
      schemaVersion: 5, incidentId: INCIDENT_ID, runId: RUN_ID, runKind: "repair",
      runStatus: "COMPLETED", incidentStatus: "DIAGNOSED", reason,
      occurredAt: "2026-09-02T08:05:00Z",
    }), INCIDENT_ID);
    render(<RunTimeline events={[ended]} connection="live" />);
    expect(screen.getByText("等待审批已结束")).toBeVisible();
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.queryByText("Incident 已恢复")).toBeNull();
  });
});

function stubSessionFetch(name: string, handler: typeof fetch) {
  vi.stubGlobal(name, vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    input === "/api/runtime/operator/session"
      ? Promise.resolve(Response.json({ operatorRef: "sandbox-operator", expiresAt: 2000000000, csrfToken: "a".repeat(64) }))
      : handler(input, init)));
}
