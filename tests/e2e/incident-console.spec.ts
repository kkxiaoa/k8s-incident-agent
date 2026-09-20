import { expect, test, type Page } from "@playwright/test";

import { login } from "./operator-session";
import type { components } from "../../src/lib/agent-runtime/generated";

type IncidentMetricPanel = components["schemas"]["IncidentMetricPanel"];

const FAKE_RUNTIME_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_RUNTIME_PORT ?? "18080"}`;

async function control(path: string, body?: unknown): Promise<Response> {
  let cookie: string | undefined;
  let csrfToken: string | undefined;
  const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? "3100"}`;
  if (path.startsWith("/api/v1/")) {
    const session = await fetch(`${FAKE_RUNTIME_URL}/api/v1/operator/login`, {
      method: "POST", headers: { "content-type": "application/json", Origin: origin },
      body: JSON.stringify({ password: process.env.PLAYWRIGHT_OPERATOR_PASSWORD }),
    });
    cookie = session.headers.getSetCookie()[0]?.split(";")[0];
    csrfToken = (await session.json()).csrfToken;
  }
  const response = await fetch(`${FAKE_RUNTIME_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie, Origin: origin, "X-CSRF-Token": csrfToken! } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response;
}

async function createFromHome(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".brand__mark")).toHaveAttribute("src", "/icon.svg");
  await expect(
    page.locator('link[rel="icon"][type="image/svg+xml"]'),
  ).toHaveAttribute("href", /^\/icon\.svg\?/);
  await expect(
    page.locator('link[rel="icon"][type="image/x-icon"]'),
  ).toHaveAttribute("href", /^\/favicon\.ico\?/);
  await expect(page.getByRole("link", { name: "YAML 编写助手" })).toHaveAttribute(
    "href",
    "http://127.0.0.1:3001/",
  );
  await expect(page.getByRole("region", { name: "监控链路" })).toBeVisible();
  await expect(page.getByLabel("Runtime：正常")).toBeVisible();
  await expect(page.getByText(/Local Kind|Stage 1/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "离线评估入口" })).toBeVisible();
  await page.getByRole("button", { name: "创建 Incident" }).click();
  await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]+$/);
}

test.beforeEach(async ({ page }) => {
  await control("/__test__/reset", {});
  await login(page);
});

test("model outage preserves history while refusing new diagnosis", async ({ page }) => {
  await control("/__test__/showcase", {});
  await control("/__test__/mode", { mode: "diagnosis-unavailable" });
  await page.goto("/");
  await expect(page.getByText(/模型诊断暂不可用（模型服务暂不可用）/)).toBeVisible();
  await expect(page.getByLabel("Runtime：正常")).toBeVisible();
  await expect(page.locator(".incident-list__link")).toHaveCount(12);
  await page.getByRole("button", { name: "创建 Incident" }).click();
  await expect(page.getByText(/模型诊断暂不可用，未创建 Incident/)).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".incident-list__link")).toHaveCount(12);

  await page.goto("/incidents/10000000-0000-4000-8000-000000000005");
  await expect(page.locator(".metric-panel")).toHaveCount(8);
  await page.reload();
  await expect(page.locator(".metric-panel")).toHaveCount(8);
  await page.goto("/");
  await control("/__test__/mode", { mode: "diagnosed" });
  await page.getByRole("button", { name: "刷新运行概览" }).click();
  await expect(page.getByText(/模型诊断暂不可用/)).toHaveCount(0);
  await expect(page.locator(".incident-list__link")).toHaveCount(12);
});

test("renders the tests-only chart showcase with drill-down data", async ({
  page,
}) => {
  const seedResponse = await control("/__test__/showcase", {});
  await expect(seedResponse.json()).resolves.toEqual({ incidents: 12, ok: true });

  const metricPath =
    "/api/v1/incidents/10000000-0000-4000-8000-000000000005/monitoring/panels/image-pull-affected-pods";
  const fifteenMinutePanel = (await (
    await control(`${metricPath}?window=15m`)
  ).json()) as IncidentMetricPanel;
  const oneHourPanel = (await (
    await control(`${metricPath}?window=1h`)
  ).json()) as IncidentMetricPanel;
  const firstThresholdSample = (panel: IncidentMetricPanel) => {
    expect(panel.result.threshold).not.toBeNull();
    const threshold = panel.result.threshold as number;
    return panel.result.series[0]?.samples.find((sample) => sample.value >= threshold);
  };
  const firingMarker = fifteenMinutePanel.markers.find(
    (marker) => marker.kind === "alert_firing",
  );
  const runStartedMarker = fifteenMinutePanel.markers.find(
    (marker) => marker.kind === "run_started",
  );

  expect(firstThresholdSample(fifteenMinutePanel)?.timestamp).toBe(
    "2026-08-29T01:59:30.000Z",
  );
  expect(firstThresholdSample(oneHourPanel)?.timestamp).toBe(
    firstThresholdSample(fifteenMinutePanel)?.timestamp,
  );
  expect(
    Date.parse(firingMarker?.occurredAt ?? "") -
      Date.parse(firstThresholdSample(fifteenMinutePanel)?.timestamp ?? ""),
  ).toBe(30_000);
  expect(
    Date.parse(runStartedMarker?.occurredAt ?? "") -
      Date.parse(firingMarker?.occurredAt ?? ""),
  ).toBe(1_000);
  expect(fifteenMinutePanel.result.currentValue).toBe(3);

  await page.goto("/");
  await expect(page.getByLabel("Incident 状态统计")).toContainText(
    /已记录 Incident.*12告警中9诊断中4待审批0/,
  );
  await expect(
    page.getByRole("img", {
      name: "告警中的 Incident 共 9 个，分布于 5 个故障族",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "告警中 Incident 故障族分布" }),
  ).toContainText("Container restart loop3");
  await expect(
    page.getByRole("img", {
      name: "最近 24 小时每小时新增与已结束的 Incident",
    }),
  ).toBeVisible();
  await expect(page.locator(".incident-list__link")).toHaveCount(12);
  const totalInfo = page.getByLabel("说明已记录 Incident 的统计口径");
  await totalInfo.hover();
  await expect(page.getByRole("tooltip")).toBeVisible();

  await page.goto(
    "/incidents/10000000-0000-4000-8000-000000000005",
  );
  await expect(page.locator(".metric-panel")).toHaveCount(8);
  // The alert's trigger panel leads on its own row; context panels stay paired.
  const dualContainer = await page.locator(".monitoring-panels").boundingBox();
  const leadPanel = await page.locator(".metric-panel--lead").boundingBox();
  const context = page.locator(".metric-panel:not(.metric-panel--lead)");
  const firstPanel = await context.nth(0).boundingBox();
  const secondPanel = await context.nth(1).boundingBox();
  expect(dualContainer).not.toBeNull();
  expect(leadPanel).not.toBeNull();
  expect(firstPanel).not.toBeNull();
  expect(secondPanel).not.toBeNull();
  expect(
    Math.abs((leadPanel?.width ?? 0) - (dualContainer?.width ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect(Math.abs((firstPanel?.width ?? 0) - (secondPanel?.width ?? 0))).toBeLessThanOrEqual(1);
  expect(firstPanel?.width ?? 0).toBeLessThan((dualContainer?.width ?? 0) * 0.6);
  await expect(page.locator(".metric-signal-state.is-firing")).toHaveCount(1);
  await expect(page.getByText("告警中", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("definition").filter({ hasText: /^< 3/ })).toBeVisible();
  await expect(page.getByRole("img", { name: /概览趋势/ })).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: /时间序列。当前值/ }),
  ).toHaveCount(2);

  await page.goto(
    "/incidents/10000000-0000-4000-8000-000000000006",
  );
  await expect(page.locator(".monitoring-panels--single .metric-panel")).toHaveCount(1);
  const singleContainer = await page.locator(".monitoring-panels--single").boundingBox();
  const singlePanel = await page.locator(".monitoring-panels--single .metric-panel").boundingBox();
  expect(singleContainer).not.toBeNull();
  expect(singlePanel).not.toBeNull();
  expect(Math.abs((singleContainer?.width ?? 0) - (singlePanel?.width ?? 0))).toBeLessThanOrEqual(1);
  await expect(
    page.getByRole("heading", { name: "Service 就绪 Endpoint" }),
  ).toBeVisible();
  await expect(
    page.getByText("Service · k8s-incident-scenarios/orders-api", {
      exact: true,
    }),
  ).toBeVisible();

  await page.goto(
    "/incidents/10000000-0000-4000-8000-000000000012",
  );
  await expect(page.locator(".metric-panel")).toHaveCount(8);
  await expect(page.locator(".monitoring-data-alert")).toContainText(
    "指标数据暂不可用当前值与趋势未展示。",
  );
  await expect(page.locator(".metric-panel__empty")).toHaveCount(8);
  await expect(page.getByRole("button", { name: "重新读取" })).toHaveCount(0);
});

test("keeps the overview inside a phone screen while it loads", async ({ page }) => {
  // The panel expansion once overflowed narrow screens with no test to catch
  // it, and only during loading. Slow the CPU down so the frames a chart
  // paints before it resizes are actually observed instead of raced past.
  await control("/__test__/showcase", {});
  const devtools = await page.context().newCDPSession(page);
  await devtools.send("Emulation.setCPUThrottlingRate", { rate: 8 });
  await page.addInitScript(() => {
    const offenders: string[] = [];
    const sample = () => {
      const width = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth > width) {
        for (const element of document.querySelectorAll<HTMLElement>("*")) {
          if (element.getBoundingClientRect().right > width + 1) {
            offenders.push(`${element.tagName}.${String(element.className).slice(0, 40)}`);
          }
        }
      }
      (window as unknown as { __overflow: string[] }).__overflow = [
        ...new Set(offenders),
      ].slice(0, 8);
    };
    const timer = setInterval(sample, 16);
    setTimeout(() => clearInterval(timer), 15_000);
  });

  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await expect(page.locator(".overview-trend")).toBeVisible();
    await expect(page.locator(".overview-doughnut__plot canvas")).toBeVisible();
    const report = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
      offenders: (window as unknown as { __overflow?: string[] }).__overflow ?? [],
    }));
    expect(report.offenders, `width ${width}`).toEqual([]);
    expect(report.scroll, `width ${width}`).toBeLessThanOrEqual(report.client);
  }
});

test("shows which incident list edges contain clipped records", async ({ page }) => {
  for (let incident = 0; incident < 6; incident += 1) {
    await control("/api/v1/incidents", { scenarioId: "image-pull-backoff" });
  }

  await page.goto("/");
  const list = page.locator(".incident-list");
  const above = page.getByText("上方还有 Incident");
  const below = page.getByText("下方还有 Incident");

  await expect(list.locator(".incident-list__link")).toHaveCount(6);
  await expect(above).toHaveCSS("opacity", "0");
  await expect(below).toHaveCSS("opacity", "1");

  const endMetrics = await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  });
  expect(endMetrics.scrollTop + endMetrics.clientHeight).toBe(endMetrics.scrollHeight);
  await expect(above).toHaveCSS("opacity", "1");
  await expect(page.locator(".incident-list-frame")).toHaveAttribute(
    "data-hidden-below",
    "false",
  );
  await expect(below).toHaveCSS("opacity", "0");
});

test("create reaches terminal diagnosis, reconnects natively, and refreshes from persistence", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await createFromHome(page);

  await expect(
    page.getByLabel("运行时间线").getByText("诊断已完成", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".metric-panel")).toHaveCount(8);
  await expect(
    page.getByRole("img", { name: /^镜像拉取失败 Pod 时间序列/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /^Deployment 可用副本 时间序列/ }),
  ).toBeVisible();
  const panelValue = (title: string) =>
    page
      .locator(".metric-panel")
      .filter({ has: page.getByRole("heading", { name: title }) })
      .locator(".metric-panel__value");
  await expect(panelValue("镜像拉取失败 Pod")).toHaveText("3");
  await expect(panelValue("Deployment 可用副本")).toHaveText("0 / 3");
  // The event list belongs to the trigger panel, so it appears once per page.
  await expect(
    page.locator(".metric-chart__events").getByText("第 1 次诊断 Run 完成"),
  ).toHaveCount(1);
  await expect(
    page.getByText("Pod 引用的镜像 manifest 不存在，导致 ImagePullBackOff。"),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "workload" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "pods", exact: true })).toBeVisible();
  await expect(page.getByText("实时追踪中")).toBeVisible();
  await expect(page.locator(".timeline__item")).toHaveCount(7);
  await expect(page.locator(".timeline__item--success .timeline__dot").first()).toHaveCSS(
    "box-shadow",
    "rgba(36, 123, 97, 0.22) 0px 0px 0px 1.5px",
  );
  await expect(page.locator(".incident-facts time")).toHaveText(
    "2026/08/28 19:00:00",
  );

  const evidence = page.locator(".evidence-card").filter({
    has: page.getByRole("heading", { name: "pods" }),
  });
  await expect(evidence.getByText("JSON", { exact: true })).toBeVisible();
  await expect(evidence.locator("code.language-json").first()).toContainText(
    "ImagePullBackOff",
  );
  await evidence.getByRole("button", { name: "复制 JSON" }).click();
  await expect(
    evidence.getByRole("button", { name: "JSON 已复制" }).first(),
  ).toBeVisible();
  await evidence.getByRole("button", { name: "展开 JSON" }).click();
  const dialog = page.getByRole("dialog", { name: "pods JSON" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dialog-scroll-locked/);
  await expect(page.locator("html")).toHaveCSS("overflow", "hidden");
  await expect(dialog.locator("code.language-json")).toContainText(
    "ImagePullBackOff",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("html")).not.toHaveClass(/dialog-scroll-locked/);

  const observations = (await (
    await control("/__test__/observations")
  ).json()) as {
    eventConnections: Record<string, Array<string | null>>;
  };
  const firstConnections = Object.values(observations.eventConnections)[0];
  expect(firstConnections?.slice(0, 2)).toEqual(["1", "4"]);

  await page.reload();
  await expect(page.getByText("已诊断").first()).toBeVisible();
  await expect(
    page.getByText("Pod 引用的镜像 manifest 不存在，导致 ImagePullBackOff。"),
  ).toBeVisible();
  await expect(page.locator(".timeline__item")).toHaveCount(7);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "运行概览" })).toBeVisible();
  const dropdown = page.getByRole("combobox", { name: "诊断场景" });
  await dropdown.click();
  await expect(page.getByRole("listbox", { name: "诊断场景" })).toBeVisible();
  await page.getByRole("option", { name: "镜像拉取失败" }).click();
  await expect(page.getByRole("listbox", { name: "诊断场景" })).toHaveCount(0);
  await dropdown.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "诊断场景" })).toHaveCount(0);
  const firstIncident = page.locator(".incident-list__link").first();
  await firstIncident.hover();
  const listGeometry = await page.locator(".incident-list").evaluate((list) => {
    const link = list.querySelector<HTMLElement>(".incident-list__link");
    return {
      containerTop: list.getBoundingClientRect().top,
      linkTop: link?.getBoundingClientRect().top ?? -1,
    };
  });
  expect(listGeometry.linkTop).toBeGreaterThanOrEqual(listGeometry.containerTop);
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
});

test("animates only the currently running tool node", async ({ page }) => {
  await control("/__test__/mode", { mode: "running" });
  await createFromHome(page);

  const runningItem = page.locator(".timeline__item--running");
  await expect(runningItem).toHaveCount(1);
  await expect(runningItem.getByText("运行中")).toBeVisible();
  const animationName = await runningItem.locator(".timeline__dot").evaluate(
    (dot) => getComputedStyle(dot, "::after").animationName,
  );
  expect(animationName).toBe("timeline-dot-pulse");
  const runningStyles = await runningItem.locator(".timeline__dot").evaluate(
    (dot) => ({
      backgroundColor: getComputedStyle(dot).backgroundColor,
      pulseBorderWidth: getComputedStyle(dot, "::after").borderTopWidth,
    }),
  );
  expect(runningStyles).toEqual({
    backgroundColor: "rgb(25, 183, 168)",
    pulseBorderWidth: "2px",
  });
});

test("timeline loading paints one set of glyphs and honors reduced motion", async ({ page }) => {
  await control("/__test__/mode", { mode: "waiting" });
  await page.goto("/");
  await page.getByRole("button", { name: "创建 Incident" }).click();
  await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]+$/);

  const waiting = page.getByText("正在等待持久化运行事件");
  await expect(waiting).toBeVisible();
  const paint = await waiting.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      text: (element as HTMLElement).innerText,
      repeatedPseudoText: [element, ...element.querySelectorAll("*")].some(node =>
        ["::before", "::after"].some(pseudo => getComputedStyle(node, pseudo).content.includes("正在等待持久化运行事件"))),
      clipsText: style.backgroundClip.split(",").every(value => value.trim() === "text"),
      animation: style.animationName,
      fontWeight: style.fontWeight,
      panelBorderColor: getComputedStyle(element.parentElement!).borderTopColor,
    };
  });
  expect(paint).toEqual({
    text: "正在等待持久化运行事件", repeatedPseudoText: false, clipsText: true,
    animation: "text-shimmer-scan", fontWeight: "700", panelBorderColor: "rgba(0, 0, 0, 0)",
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(waiting).toHaveCSS("animation-name", "none");
  const color = await waiting.evaluate(element => getComputedStyle(element).color);
  await expect(waiting).toHaveCSS("-webkit-text-fill-color", color);
});

test("shows Runtime unavailable without static success fallback", async ({ page }) => {
  await control("/__test__/mode", { mode: "unavailable" });

  await page.goto("/");

  await expect(
    page.getByText("暂时无法加载诊断场景，请稍后重试。"),
  ).toBeVisible();
  await expect(
    page.getByText("暂时无法加载最近记录，请稍后重试。"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "创建 Incident" })).toHaveCount(0);
  await expect(page.getByText(/fixture install|cleanup/i)).toHaveCount(0);

  await page.goto("/incidents/10000000-0000-4000-8000-000000000001");
  await expect(
    page.getByRole("heading", { name: "页面暂时不可用" }),
  ).toBeVisible();
  await expect(page.getByText(/Agent Runtime|Render error/)).toHaveCount(0);

  await control("/__test__/mode", { mode: "diagnosed" });
  await page.goto("/incidents/10000000-0000-4000-8000-000000000001");
  await expect(
    page.getByRole("heading", { name: "未找到相关记录" }),
  ).toBeVisible();
  await expect(page.getByText(/Incident 不存在|Unavailable/)).toHaveCount(0);
});

test("renders insufficient evidence with missing information", async ({ page }) => {
  await control("/__test__/mode", { mode: "insufficient" });
  await createFromHome(page);

  await expect(page.getByText("证据不足").first()).toBeVisible();
  await expect(
    page.getByText("现有 Kubernetes 证据不足以确认镜像仓库端失败原因。"),
  ).toBeVisible();
  await expect(page.getByText("镜像仓库端的拉取审计记录")).toBeVisible();
  await expect(page.getByText("诊断文本已脱敏")).toBeVisible();
});

test("recommendations link to the Evidence cards the same Run rendered", async ({
  page,
}) => {
  await control("/__test__/mode", { mode: "diagnosed" });
  await createFromHome(page);

  const advice = page.getByRole("region", { name: "处置建议" });
  await expect(advice).toContainText("目的");
  await expect(advice).toContainText("验证方向");
  await expect(advice.getByRole("button")).toHaveCount(0);
  const anchor = await advice
    .getByRole("link", { name: /查看证据/ })
    .first()
    .getAttribute("href");
  expect(anchor).toMatch(/^#evidence-/);
  await expect(page.locator(anchor!)).toHaveCount(1);
});

test("advice-only delivery keeps two steps and reads out its recommendations", async ({
  page,
}) => {
  await control("/__test__/mode", { mode: "insufficient" });
  await createFromHome(page);

  const progress = page.getByRole("navigation", { name: "事件处理阶段" });
  await expect(progress.getByRole("listitem")).toHaveCount(2);
  await expect(progress).toContainText("无适用的受控修复");
  await expect(progress).not.toContainText("修复准备");
  await expect(progress).not.toContainText("人工审批");

  const advice = page.getByRole("region", { name: "处置建议" });
  await expect(advice).toContainText("建议是诊断的输出，不是执行许可");
  const repair = page.getByRole("region", { name: "受控修复" });
  await expect(repair).toContainText("本次没有可执行的受控修复。");
  await expect(repair).toContainText("Runtime 未在本次证据中确认适用的受控动作");
  await expect(page.getByRole("list", { name: "修复验证门禁" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /准备修复提案|批准/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "下一步" })).toHaveCount(0);
});

test("renders typed tool and terminal failures", async ({ page }) => {
  await control("/__test__/mode", { mode: "failed" });
  await createFromHome(page);

  await expect(page.getByText("get_workload 失败")).toBeVisible();
  await expect(page.getByText("kubernetes_forbidden")).toBeVisible();
  await expect(page.getByRole("heading", { name: "诊断运行失败" })).toBeVisible();
  await expect(
    page
      .getByRole("heading", { name: "诊断运行失败" })
      .locator("..")
      .getByText("workflow_failed"),
  ).toBeVisible();
  await expect(page.locator(".timeline__item--danger .timeline__dot").first()).toHaveCSS(
    "box-shadow",
    "rgba(184, 60, 70, 0.18) 0px 0px 0px 1.5px",
  );
  await expect(page.getByRole("button", { name: /批准|执行|回滚|Apply/i })).toHaveCount(0);
  // This Run ended in a terminal status, so the home trend counts one ending.
  await page.goto("/");
  await expect(page.getByText(/新增 Incident 共 1 个；进入终态 1 次/)).toBeAttached();
  await page.goBack();
  // The Run never reached a repair gate, so it reports no applicable repair
  // instead of an empty proposal or a failed preparation.
  const repair = page.getByRole("region", { name: "受控修复" });
  await expect(repair).toContainText("本次没有可执行的受控修复。");
  await expect(repair).toContainText("没有产生诊断结论");
  await expect(page.getByRole("list", { name: "修复验证门禁" })).toHaveCount(0);
});
