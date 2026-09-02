import { expect, test, type Page } from "@playwright/test";

const FAKE_RUNTIME_URL = "http://127.0.0.1:18080";

async function control(path: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${FAKE_RUNTIME_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
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
  await expect(page.getByRole("heading", { name: "监控链路" })).toBeVisible();
  await expect(page.getByLabel("监控链路正常")).toBeVisible();
  await expect(page.getByText(/Local Kind|Stage 1/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "启动只读诊断" })).toBeVisible();
  await page.getByRole("button", { name: "创建 Incident" }).click();
  await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]+$/);
}

test.beforeEach(async () => {
  await control("/__test__/reset", {});
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

  await expect(page.getByText("诊断已完成", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "监控概览" })).toBeVisible();
  await expect(page.locator(".metric-panel")).toHaveCount(2);
  await expect(
    page.getByRole("img", { name: /^Affected pods 时间序列/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /^Waiting containers 时间序列/ }),
  ).toBeVisible();
  await expect(page.locator(".metric-panel__value")).toHaveText(["0", "0"]);
  await expect(
    page.locator(".metric-chart__events").getByText("第 1 次诊断 Run 完成"),
  ).toHaveCount(2);
  await expect(
    page.getByText("Pod 引用的镜像 manifest 不存在，导致 ImagePullBackOff。"),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "kubernetes.pod" })).toBeVisible();
  await expect(page.getByText("实时追踪中")).toBeVisible();
  await expect(page.locator(".timeline__item")).toHaveCount(5);
  await expect(page.locator(".timeline__item--success .timeline__dot").first()).toHaveCSS(
    "box-shadow",
    "rgba(36, 123, 97, 0.22) 0px 0px 0px 1.5px",
  );
  await expect(page.locator(".incident-facts time")).toHaveText(
    "2026/08/28 GMT-7 19:00:00.000",
  );

  const evidence = page.locator(".evidence-card").first();
  await expect(evidence.getByText("JSON", { exact: true })).toBeVisible();
  await expect(evidence.locator("code.language-json").first()).toContainText(
    "ImagePullBackOff",
  );
  await evidence.getByRole("button", { name: "复制 JSON" }).click();
  await expect(
    evidence.getByRole("button", { name: "JSON 已复制" }).first(),
  ).toBeVisible();
  await evidence.getByRole("button", { name: "展开 JSON" }).click();
  const dialog = page.getByRole("dialog", { name: "kubernetes.pod JSON" });
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
  await expect(page.locator(".timeline__item")).toHaveCount(5);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /让每个结论/ })).toBeVisible();
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

test("makes the active waiting state visually prominent", async ({ page }) => {
  await control("/__test__/mode", { mode: "waiting" });
  await createFromHome(page);

  const waiting = page.getByText("正在等待持久化运行事件");
  await expect(waiting).toBeVisible();
  const styles = await waiting.evaluate((element) => ({
    fontWeight: getComputedStyle(element).fontWeight,
    panelBorderColor: getComputedStyle(element.parentElement!).borderTopColor,
  }));
  expect(styles).toEqual({
    fontWeight: "700",
    panelBorderColor: "rgba(25, 183, 168, 0.7)",
  });
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
  await expect(page.getByText("当前切片不包含指标证据。")).toBeVisible();
});

test("renders typed tool and terminal failures", async ({ page }) => {
  await control("/__test__/mode", { mode: "failed" });
  await createFromHome(page);

  await expect(page.getByText("get_pod 失败")).toBeVisible();
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
});
