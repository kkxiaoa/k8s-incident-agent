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
} from "@/test/agent-runtime-fixtures";

import { DiagnosisPanel } from "./diagnosis-panel";
import { EvidenceList } from "./evidence-card";
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

afterEach(() => {
  navigation.push.mockReset();
  navigation.replace.mockReset();
  navigation.refresh.mockReset();
  FakeEventSource.current = null;
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
    vi.stubGlobal("fetch", fetchMock);
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
          schemaVersion: 2,
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
          schemaVersion: 2,
          incidentId: INCIDENT_ID,
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
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
  it("renders bounded initial events, subscribes from the snapshot cursor, and keeps terminal streams open", async () => {
    const detail = makeIncidentDetail();
    detail.eventPage.items = [
      parseRunEvent(
        "incident.created",
        "1",
        JSON.stringify({
          schemaVersion: 2,
          incidentId: INCIDENT_ID,
          runId: RUN_ID,
          attempt: 1,
          incidentStatus: "RECEIVED",
          runStatus: "QUEUED",
          occurredAt: "2026-08-29T01:00:00Z",
        }),
        INCIDENT_ID,
      ),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(detailResponse(detail)));
    vi.stubGlobal("EventSource", FakeEventSource);

    renderIncidentStream(detail);
    const source = FakeEventSource.current;
    expect(source?.url).toBe(
      `/api/runtime/incidents/${INCIDENT_ID}/events?cursor=1`,
    );
    expect(screen.getByText("Incident 已创建")).toBeVisible();

    act(() => {
      source?.emit("diagnosis.completed", "2", {
        schemaVersion: 2,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        diagnosisId: DIAGNOSIS_ID,
        incidentStatus: "DIAGNOSED",
        outcome: "diagnosed",
        runStatus: "COMPLETED",
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
        schemaVersion: 2,
        incidentId: "66666666-6666-4666-8666-666666666666",
        runId: RUN_ID,
        attempt: 1,
        incidentStatus: "TRIAGING",
        runStatus: "RUNNING",
        occurredAt: "2026-08-29T01:00:02Z",
      });
    });

    expect(
      await screen.findByText("收到无法验证的运行事件，实时更新已停止。"),
    ).toBeVisible();
    expect(source?.close).toHaveBeenCalledOnce();
  });

  it("creates a later Run only through the manual latest-mode action", async () => {
    const detail = makeIncidentDetail();
    detail.selectedRun.status = "COMPLETED";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            schemaVersion: 2,
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

    expect(fetch).toHaveBeenCalledWith(
      `/api/runtime/incidents/${INCIDENT_ID}/runs`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(navigation.replace).toHaveBeenCalledWith(
      `/incidents/${INCIDENT_ID}?runId=55555555-5555-4555-8555-555555555555`,
    );
    expect(navigation.refresh).toHaveBeenCalledOnce();
  });

  it("does not render a rerun action for the online profile", () => {
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
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);

    renderIncidentStream();
    const source = FakeEventSource.current;
    expect(source).not.toBeNull();

    act(() => {
      source?.emit("incident.created", "1", {
        schemaVersion: 2,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        attempt: 1,
        incidentStatus: "RECEIVED",
        runStatus: "QUEUED",
        occurredAt: "2026-08-29T01:00:00Z",
      });
      source?.emit("run.started", "2", {
        schemaVersion: 2,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        attempt: 1,
        incidentStatus: "TRIAGING",
        runStatus: "RUNNING",
        occurredAt: "2026-08-29T01:00:01Z",
      });
      source?.emit("tool.started", "3", {
        schemaVersion: 2,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        toolCallId: "tool-call-1",
        toolName: "get_pod",
        occurredAt: "2026-08-29T01:00:02Z",
      });
    });
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => {
      for (const id of ["4", "5", "6"]) {
        source?.emit("evidence.recorded", id, {
          schemaVersion: 2,
          incidentId: INCIDENT_ID,
          runId: RUN_ID,
          evidenceId: EVIDENCE_ID,
          evidenceKind: "kubernetes.pod",
          observedAt: "2026-08-29T01:00:03Z",
          redacted: false,
          toolCallId: `tool-call-${id}`,
          toolName: "get_pod",
          truncated: false,
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
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);
    const initialDetail = makeIncidentDetail();
    initialDetail.evidence = [];

    renderIncidentStream(initialDetail);
    const source = FakeEventSource.current;

    act(() => {
      source?.emit("evidence.recorded", "4", {
        schemaVersion: 2,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        evidenceId: EVIDENCE_ID,
        evidenceKind: "kubernetes.pod",
        observedAt: "2026-08-29T01:00:03Z",
        redacted: false,
        toolCallId: "tool-call-1",
        toolName: "get_pod",
        truncated: false,
        occurredAt: "2026-08-29T01:00:03Z",
      });
      source?.emit("tool.started", "5", {
        schemaVersion: 2,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        toolCallId: "tool-call-2",
        toolName: "get_events",
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

    await user.click(within(evidence).getByRole("button", { name: "复制 JSON" }));
    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify(detail.evidence[0].payload, null, 2),
    );
    expect(
      within(evidence).getByRole("button", { name: "JSON 已复制" }),
    ).toBeVisible();

    await user.click(within(evidence).getByRole("button", { name: "展开 JSON" }));
    const dialog = screen.getByRole("dialog", { name: "kubernetes.pod JSON" });
    expect(dialog).toHaveAttribute("open");
    expect(document.documentElement).toHaveClass("dialog-scroll-locked");
    expect(within(dialog).getByText(/<img src=x/)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(dialog).not.toHaveAttribute("open");
    expect(document.documentElement).not.toHaveClass("dialog-scroll-locked");
    expect(screen.getByText("当前切片不包含指标证据。")).toBeVisible();
  });

  it("marks only unresolved tool calls as running", () => {
    const firstStarted = parseRunEvent(
      "tool.started",
      "1",
      JSON.stringify({
        schemaVersion: 2,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        toolCallId: "tool-call-1",
        toolName: "get_pods",
        occurredAt: "2026-08-29T01:00:01Z",
      }),
      INCIDENT_ID,
    );
    const firstEvidence = parseRunEvent(
      "evidence.recorded",
      "2",
      JSON.stringify({
        schemaVersion: 2,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        evidenceId: EVIDENCE_ID,
        evidenceKind: "kubernetes.pods",
        observedAt: "2026-08-29T01:00:02Z",
        redacted: false,
        toolCallId: "tool-call-1",
        toolName: "get_pods",
        truncated: false,
        occurredAt: "2026-08-29T01:00:02Z",
      }),
      INCIDENT_ID,
    );
    const secondStarted = parseRunEvent(
      "tool.started",
      "3",
      JSON.stringify({
        schemaVersion: 2,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        toolCallId: "tool-call-2",
        toolName: "get_events",
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
      "timeline-waiting__text",
    );

    rerender(<RunTimeline events={[]} connection="invalid" />);
    expect(screen.getByText("事件流已停止，未收到有效运行事件。")).not.toHaveClass(
      "timeline-waiting__text",
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

    render(
      <DiagnosisPanel
        diagnosis={detail.diagnosis}
        runStatus="COMPLETED"
        runError={null}
      />,
    );

    expect(screen.getByText("证据不足")).toBeVisible();
    expect(screen.getByText("低置信度")).toBeVisible();
    expect(screen.getByRole("link", { name: "证据 1" })).toHaveAttribute(
      "href",
      `#evidence-${EVIDENCE_ID}`,
    );
    expect(screen.getByText("镜像仓库端的拉取审计记录")).toBeVisible();
    expect(screen.getByText("诊断文本已脱敏")).toBeVisible();
  });

  it("renders tool failure and terminal failure without write controls", () => {
    const toolStarted = parseRunEvent(
      "tool.started",
      "7",
      JSON.stringify({
        schemaVersion: 2,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        toolCallId: "tool-call-1",
        toolName: "get_events",
        occurredAt: "2026-08-29T01:00:02Z",
      }),
      INCIDENT_ID,
    );
    const toolFailure = parseRunEvent(
      "tool.failed",
      "8",
      JSON.stringify({
        schemaVersion: 2,
        incidentId: INCIDENT_ID,
        runId: RUN_ID,
        toolCallId: "tool-call-1",
        toolName: "get_events",
        errorCode: "kubernetes_forbidden",
        retryable: false,
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
});
