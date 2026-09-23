import { expect, test, type Page } from "@playwright/test";
import { login } from "./operator-session";

const runtimeUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_RUNTIME_PORT ?? "18080"}`;

async function seed(page: Page) {
  await fetch(`${runtimeUrl}/__test__/reset`, { method: "POST" });
  const response = await fetch(`${runtimeUrl}/__test__/repair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outcome: "passed" }) });
  const { incidentId } = await response.json() as { incidentId: string };
  await login(page);
  await page.goto(`/incidents/${incidentId}`);
  await expect(page.getByRole("button", { name: "准备修复提案", exact: true })).toBeEnabled();
  return incidentId;
}

async function prepare(page: Page) {
  // The first event connection starts a persisted-detail refresh after hydration.
  await expect(page.getByText("实时追踪中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "准备修复提案", exact: true }).click();
  await expect(page).toHaveURL(/\?runId=/);
  await expect(page.getByRole("button", { name: "审阅并批准", exact: true })).toBeEnabled();
  return page.url();
}

async function approve(page: Page) {
  await page.getByRole("button", { name: "审阅并批准", exact: true }).click();
  const confirmation = page.getByRole("group", { name: "确认审阅并批准" });
  await expect(confirmation).toContainText("一次真实 Kubernetes 写入");
  const capture = test.info().outputPath(`approval-${page.viewportSize()!.width}-${test.info().attachments.length}.png`);
  await confirmation.screenshot({ path: capture });
  await test.info().attach("approval-confirmation", { path: capture, contentType: "image/png" });
  await confirmation.getByRole("button", { name: "批准并执行", exact: true }).click();
  await expect(page.getByRole("region", { name: /修复处置|回滚处置|修复建议/ })).toContainText("已批准，等待执行领取");
}

async function setState(incidentId: string, state: string) {
  const response = await fetch(`${runtimeUrl}/__test__/repair-state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ incidentId, state }) });
  expect(response.ok).toBe(true);
}

async function captureWorkbench(page: Page, name: string) {
  await expect(page.getByRole("navigation", { name: "事件处理阶段" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Incident 指标" })).toBeVisible();
  const spacing = await page.locator(".run-controls").evaluate((element) =>
    document.querySelector(".incident-progress")!.getBoundingClientRect().top - element.getBoundingClientRect().bottom);
  expect(spacing).toBeGreaterThanOrEqual(24);
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await test.info().attach(name, { path, contentType: "image/png" });
}

test("a new Run arriving over SSE is offered without changing the current selection", async ({ page, context }) => {
  const incidentId = await seed(page);
  const history = page.getByRole("region", { name: "运行记录", exact: true });
  await expect(history.getByRole("link", { name: "最新运行", exact: true })).toHaveCount(0);
  const creator = await context.newPage();
  try {
    await creator.goto(`/incidents/${incidentId}`);
    const newerUrl = await prepare(creator);
    await expect(history.getByRole("link", { name: "最新运行", exact: true })).toBeVisible();
    await expect(history).toContainText("正在查看第 1 次 · 诊断");
    await page.getByText("选择运行记录", { exact: true }).click();
    const list = page.getByRole("navigation", { name: "运行选择" });
    await expect(list.getByRole("link")).toHaveCount(2);
    await expect(list.getByRole("link", { name: /第 2 次/ })).toContainText("最新");
    await history.getByRole("heading", { name: "运行记录" }).click();
    await expect(list).not.toBeVisible();
    await page.getByText("选择运行记录", { exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(list).not.toBeVisible();
    await history.getByRole("link", { name: "最新运行", exact: true }).click();
    await expect(page).toHaveURL(newerUrl);
    await expect(history).toContainText("正在查看第 2 次 · 修复");
    await expect(history.getByRole("link", { name: "最新运行", exact: true })).toHaveCount(0);
  } finally {
    await creator.close();
  }
});

for (const [phase, actionName] of [["preparation", "准备修复提案"], ["approval", "审阅并批准"]]) {
  test(`repair ${phase} waits for hydration when page scripts are delayed`, async ({ page, context }) => {
    const incidentId = await seed(page);
    const url = actionName === "准备修复提案" ? `/incidents/${incidentId}` : await prepare(page);
    const loading = await context.newPage();
    let releaseScripts!: () => void;
    const scriptsReady = new Promise<void>((resolve) => { releaseScripts = resolve; });
    await loading.route(/\/_next\/static\/.*\.js(?:\?|$)/, async (route) => {
      await scriptsReady;
      await route.continue();
    });
    try {
      await loading.goto(url, { waitUntil: "commit" });
      const action = loading.getByRole("button", { name: actionName, exact: true });
      await expect(action).toBeVisible();
      await expect(action).toBeDisabled();
      releaseScripts();
      await expect(action).toBeEnabled();
      if (actionName === "准备修复提案") {
        await prepare(loading);
      } else {
        await action.click();
        await expect(loading.getByRole("group", { name: "确认审阅并批准", exact: true })).toBeVisible();
      }
    } finally {
      releaseScripts();
      await loading.unrouteAll({ behavior: "wait" });
      await loading.close();
    }
  });
}

test("approval deadline stays synchronized across stage and action anchors", async ({ page }) => {
  await page.clock.install();
  const incidentId = await seed(page);
  await prepare(page);
  const counters = page.locator(".approval-countdown");
  await expect(counters).toHaveCount(2);
  await expect(counters.first()).toHaveText(/剩余 \d{2}:\d{2}/);
  const expiresAt = await page.locator("#repair-decision time").first().getAttribute("datetime");
  const waitingMark = page.locator(".incident-progress li").nth(3).locator(".incident-progress__mark");
  await expect(waitingMark).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(waitingMark).toHaveCSS("border-color", "rgb(216, 226, 232)");
  await page.clock.pauseAt(new Date(Date.parse(expiresAt!) - 181000));
  await expect(counters).toHaveText(["剩余 03:01", "剩余 03:01"]);
  await page.clock.runFor(1000);
  await expect(counters).toHaveText(["剩余 03:00", "剩余 03:00"]);
  await expect(counters.first()).toHaveCSS("color", "rgb(166, 106, 5)");
  await expect(counters.last()).toHaveCSS("color", "rgb(166, 106, 5)");
  await page.getByRole("link", { name: /人工审批.*剩余/ }).click();
  await expect(page).toHaveURL(/#repair-decision$/);
  await page.clock.runFor(500);
  await expect(page.locator("#repair-decision")).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("approval-countdown-amber.png"), fullPage: true });
  await page.getByRole("button", { name: "审阅并批准", exact: true }).click();
  await page.clock.pauseAt(new Date(Date.parse(expiresAt!) + 1000));
  await expect(counters).toHaveText(["批准期限已到", "批准期限已到"]);
  await expect(page.getByRole("button", { name: "批准并执行", exact: true })).toBeDisabled();
  await setState(incidentId, "expired");
  await page.getByRole("button", { name: "检查最新状态" }).click();
  await expect(page.locator(".incident-progress li").nth(3)).toHaveAttribute("data-attention", "true");
  await expect(waitingMark).toHaveCSS("background-color", "rgb(240, 242, 244)");
  await expect(waitingMark.locator("circle")).toHaveCount(0);
});

test("processing uses the shared shimmer while saved success and waiting remain distinct", async ({ page }) => {
  const incidentId = await seed(page);
  await prepare(page);
  const steps = page.locator(".incident-progress li");
  await expect(steps.first().locator(".incident-progress__mark")).toHaveCSS("background-color", "rgb(11, 129, 118)");
  await expect(steps.nth(3).locator(".text-shimmer")).toHaveCount(0);
  await approve(page);
  const approvedEvent = page.getByRole("region", { name: "运行时间线" }).getByRole("listitem").filter({ hasText: "修复已批准" });
  await expect(approvedEvent.locator(".timeline__dot")).toHaveCSS("background-color", "rgb(36, 123, 97)");
  await expect(approvedEvent).toContainText("尚无写入成功回执");
  await expect(steps.nth(4)).toHaveAttribute("data-running", "false");
  await setState(incidentId, "observing");
  await page.getByRole("button", { name: "检查最新状态" }).click();
  await expect(steps.nth(4)).toHaveAttribute("data-running", "true");
  await expect(steps.nth(4).locator(".incident-progress__mark")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(steps.nth(4).locator(".incident-progress__mark")).toHaveCSS("border-color", "rgb(15, 143, 134)");
  const runningText = steps.nth(4).getByText("恢复观察中", { exact: true });
  await expect(runningText).toHaveCSS("background-size", "80px 100%, 100% 100%");
  await expect(runningText).toHaveCSS("animation-name", "text-shimmer-scan");
  await expect(runningText).toHaveCSS("background-image", /rgb\(8, 166, 166\)/);
  await page.screenshot({ path: test.info().outputPath("processing-shimmer.png"), fullPage: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(runningText).toHaveCSS("animation-name", "none");
  await expect(steps.nth(4).getByText("恢复观察中", { exact: true })).toBeVisible();
  await setState(incidentId, "recovered");
  const recoveredEvent = page.getByRole("region", { name: "运行时间线" }).getByRole("listitem").filter({ hasText: "恢复验证通过" });
  await expect(recoveredEvent.locator(".timeline__dot")).toHaveCSS("background-color", "rgb(36, 123, 97)");
});

test("historical diagnosis prepares a new Run; editing preserves exact source and old proposal", async ({ page }) => {
  const incidentId = await seed(page);
  const requests: unknown[] = [];
  page.on("request", (request) => { if (request.url().endsWith("/repair-runs")) requests.push(request.postDataJSON()); });
  const firstUrl = await prepare(page);
  const currentEvidence = page.getByRole("region", { name: "本次运行证据 · 第 2 次运行", exact: true });
  const sourceEvidenceSection = page.getByRole("region", { name: "来源诊断证据 · 第 1 次运行", exact: true });
  await expect(currentEvidence).toBeVisible();
  await expect(sourceEvidenceSection).toContainText("历史引用");
  const currentBox = await currentEvidence.boundingBox();
  const sourceBox = await sourceEvidenceSection.boundingBox();
  expect(sourceBox!.y - currentBox!.y - currentBox!.height).toBeGreaterThanOrEqual(24);
  await expect(page.getByRole("region", { name: "运行记录", exact: true }).getByRole("link", { name: "最新运行", exact: true })).toHaveCount(0);
  await page.getByText("选择运行记录", { exact: true }).click();
  await expect(page.getByRole("navigation", { name: "运行选择" }).getByRole("link", { name: /第 2 次 · 修复/ })).toContainText("最新");
  await page.getByRole("navigation", { name: "运行选择" }).getByRole("link", { name: /第 2 次 · 修复/ }).click();
  await expect(page).toHaveURL(firstUrl);
  await expect(page.getByRole("navigation", { name: "运行选择" })).not.toBeVisible();
  await captureWorkbench(page, "awaiting-approval");
  await page.getByRole("link", { name: /修复准备/ }).click();
  await expect(page.getByRole("list", { name: "修复验证门禁" })).toBeVisible();
  await page.route((url) => url.pathname === `/api/runtime/incidents/${incidentId}`, async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    const original = detail.actions.historyCandidates[0];
    detail.actions.historyCandidates = [
      ...Array.from({ length: 20 }, (_, index) => ({ revision: String(21 - index), replicaSetUid: `historical-rs-${index}`, image: `registry.example/app:historical-${index}` })),
      original,
    ];
    await route.fulfill({ response, json: detail });
  });
  await page.getByRole("button", { name: "检查最新状态" }).click();
  await expect(page.getByRole("region", { name: "诊断结论", exact: true })).toContainText("引用第 1 次诊断运行");
  await expect(page.getByRole("region", { name: "诊断结论", exact: true })).toContainText("The configured image registry is invalid.");
  await expect(page.locator(".run-event-records")).toHaveAttribute("open", "");
  await expect(page.locator(".repair-verdict__icon")).toHaveCount(0);
  const diagnosisStep = page.getByRole("navigation", { name: "事件处理阶段" }).getByRole("listitem").nth(1);
  await expect(diagnosisStep).toHaveAttribute("data-done", "true");
  expect(await diagnosisStep.evaluate((element) => getComputedStyle(element, "::after").height)).toBe("1px");
  await diagnosisStep.getByRole("link").click();
  expect(new URL(page.url()).searchParams.get("runId")).toBe(new URL(firstUrl).searchParams.get("runId"));
  const sourceEvidence = page.getByRole("region", { name: "诊断结论", exact: true }).getByRole("link", { name: /查看证据/ }).first();
  await sourceEvidence.click();
  await expect(page.locator(new URL(page.url()).hash)).toBeVisible();
  await expect(page.locator(new URL(page.url()).hash)).toContainText("get_workload");
  await page.getByRole("button", { name: "调整提案", exact: true }).click();
  await page.getByRole("radio", { name: /改用其他历史镜像/ }).check();
  await captureWorkbench(page, "adjust-proposal");
  await page.getByRole("combobox", { name: "证据中的历史镜像" }).click();
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(22);
  await page.keyboard.press("End");
  const lastCandidate = page.getByRole("option", { name: /修订 1 ·/ });
  await expect(lastCandidate).toHaveAttribute("data-active", "true");
  await expect.poll(() => lastCandidate.evaluate((element) => {
    const item = element.getBoundingClientRect();
    const list = element.parentElement!.getBoundingClientRect();
    return item.top >= list.top && item.bottom <= list.bottom;
  })).toBe(true);
  await page.keyboard.press("Enter");
  await page.unrouteAll({ behavior: "wait" });
  await page.getByRole("button", { name: "生成新提案", exact: true }).click();
  await expect(page).not.toHaveURL(firstUrl);
  await expect(page.getByRole("button", { name: "审阅并批准", exact: true })).toBeEnabled();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual({ sourceRunId: new URL(firstUrl).searchParams.get("runId"), sourceExecutionId: null,
    replacesRunId: new URL(firstUrl).searchParams.get("runId"), selection: { revision: "1", replicaSetUid: "previous-rs-uid" } });
  await page.goto(firstUrl);
  await expect(page.getByText("本次等待已被新的运行替换。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "审阅并批准", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "查看诊断依据", exact: true })).toHaveAttribute("href", "#diagnosis-heading");
});

test("double click and a second tab converge on the saved decision without optimistic execution", async ({ page, context }) => {
  await seed(page);
  const url = await prepare(page);
  const second = await context.newPage();
  await second.goto(url);
  await second.getByRole("button", { name: "审阅并批准", exact: true }).click();
  const secondConfirmation = second.getByRole("group", { name: "确认审阅并批准", exact: true });
  await expect(secondConfirmation).toBeVisible();
  await expect(secondConfirmation.getByRole("button", { name: "批准并执行", exact: true })).toBeEnabled();
  let decisions = 0;
  page.on("request", (request) => { if (request.url().endsWith("/approvals")) decisions++; });
  await page.getByRole("button", { name: "审阅并批准", exact: true }).click();
  await page.getByRole("button", { name: "批准并执行", exact: true }).dblclick();
  await expect(page.getByRole("region", { name: /修复处置|回滚处置|修复建议/ })).toContainText("已批准，等待执行领取");
  expect(decisions).toBe(1);
  await expect(secondConfirmation.getByRole("button", { name: "批准并执行", exact: true })).toBeDisabled();
  await second.reload();
  await expect(second.getByRole("region", { name: /修复处置|回滚处置|修复建议/ })).toContainText("已批准，等待执行领取");
  await expect(second.getByRole("button", { name: "审阅并批准", exact: true })).toHaveCount(0);
  await second.close();
});

test("focus refresh does not swallow opening review and keeps submission disabled", async ({ page, context }) => {
  const incidentId = await seed(page);
  const url = await prepare(page);
  const runId = new URL(url).searchParams.get("runId");
  const second = await context.newPage();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await second.goto(url);
    await expect(second.getByRole("region", { name: "诊断结论", exact: true })).toContainText("引用第 1 次诊断运行");
    await expect(second.getByText("实时追踪中", { exact: true })).toBeVisible();
    const button = second.getByRole("button", { name: "审阅并批准", exact: true });
    await expect(button).toBeEnabled();
    await second.route((target) => target.pathname === `/api/runtime/incidents/${incidentId}` && target.searchParams.get("runId") === runId, async (route) => {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    });
    await button.scrollIntoViewIfNeeded();
    const before = await button.boundingBox();
    await second.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
    await second.mouse.down();
    await second.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(second.getByText("正在核对持久化状态，提交暂不可用…", { exact: true })).toBeVisible();
    await second.mouse.up();
    const confirmation = second.getByRole("group", { name: "确认审阅并批准", exact: true });
    await expect(confirmation).toBeVisible();
    const submit = confirmation.getByRole("button", { name: "批准并执行", exact: true });
    await expect(submit).toBeDisabled();
    release();
    await expect(submit).toBeEnabled();
  } finally {
    release();
    await second.unrouteAll({ behavior: "wait" });
    await second.close();
  }
});

test("rejection is explicit and replayed from saved detail", async ({ page }) => {
  await seed(page);
  await prepare(page);
  await page.getByRole("button", { name: "拒绝提案", exact: true }).click();
  await page.getByRole("button", { name: "确认拒绝提案", exact: true }).click();
  await expect(page.getByRole("region", { name: /修复处置|回滚处置|修复建议/ })).toContainText("修复已被拒绝，未执行");
  await expect(page.locator(".repair-verdict")).toHaveClass(/repair-verdict--neutral/);
  await expect(page.getByRole("region", { name: "运行时间线" }).getByRole("listitem").filter({ hasText: "修复已拒绝" }).locator(".timeline__dot")).toHaveCSS("background-color", "rgb(135, 153, 165)");
  await captureWorkbench(page, "rejected");
  await page.reload();
  await expect(page.getByText("本次修复申请已被拒绝。", { exact: true })).toBeVisible();
});

test("proposal expiry refreshes after reconnect and prepares a new proposal without logging out", async ({ page }) => {
  const incidentId = await seed(page);
  const oldUrl = await prepare(page);
  await setState(incidentId, "expired");
  await expect(page.getByText(/这不是登录会话过期/)).toBeVisible();
  await expect(page.getByText("提案已过期。请重新生成提案，完成最新检查后再审批。")).toBeVisible();
  await expect(page.getByRole("button", { name: "审阅并批准", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "重新生成提案", exact: true }).click();
  await page.getByRole("button", { name: "生成新提案", exact: true }).click();
  await expect(page).not.toHaveURL(oldUrl);
  await expect(page.getByRole("button", { name: "审阅并批准", exact: true })).toBeEnabled();
});

for (const state of ["UNKNOWN", "STALE_RESOURCE"] as const) {
  test(`${state} shows the persisted execution boundary and never offers retry execution`, async ({ page }) => {
    const incidentId = await seed(page);
    await prepare(page);
    await approve(page);
    await setState(incidentId, state);
    const panel = page.getByRole("region", { name: /修复处置|回滚处置|修复建议/ });
    await expect(panel).toContainText(state === "UNKNOWN" ? "写入结果未知，目标保持占用" : "目标资源已变化，执行已停止");
    if (state === "UNKNOWN") await captureWorkbench(page, "execution-unknown");
    await page.reload();
    await expect(page.getByRole("button", { name: /重试执行|审阅并批准|准备回滚提案/ })).toHaveCount(0);
    if (state === "UNKNOWN") await expect(page.getByRole("button", { name: "重新诊断", exact: true })).toBeDisabled();
  });
}

test("failed preparation can refresh without a proposal", async ({ page }) => {
  const incidentId = await seed(page);
  const oldUrl = await prepare(page);
  await setState(incidentId, "preparation-failed");
  await page.reload();
  await expect(page.getByRole("region", { name: /修复处置|回滚处置|修复建议/ })).toContainText("验证已停止，未形成可用提案");
  await page.getByRole("button", { name: "重新生成提案", exact: true }).click();
  await page.getByRole("button", { name: "生成新提案", exact: true }).click();
  await expect(page).not.toHaveURL(oldUrl);
  await expect(page.getByRole("button", { name: "审阅并批准", exact: true })).toBeEnabled();
});

test("rollback needs a new approval and remains distinct from recovery on mobile and reload", async ({ page }) => {
  const incidentId = await seed(page);
  const sourceUrl = await prepare(page);
  await approve(page);
  await setState(incidentId, "monitoring_unavailable");
  await expect(page.getByRole("button", { name: "准备回滚提案", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "准备回滚提案", exact: true }).click();
  await page.getByRole("button", { name: "生成回滚提案", exact: true }).click();
  await expect(page).not.toHaveURL(sourceUrl);
  await expect(page.getByRole("region", { name: /修复处置|回滚处置|修复建议/ })).toContainText("回滚提案");
  await expect(page.getByRole("region", { name: "诊断结论", exact: true })).toContainText("引用第 1 次诊断运行");
  await captureWorkbench(page, "rollback-approval");
  await expect(page.getByRole("button", { name: "审阅并批准", exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await approve(page);
  await setState(incidentId, "monitoring_unavailable");
  await expect(page.getByRole("region", { name: /修复处置|回滚处置|修复建议/ })).toContainText("批准的逆向写入已完成；恢复结果单独判定。");
  await expect(page.getByRole("region", { name: /修复处置|回滚处置|修复建议/ })).toContainText("ROLLED_BACK");
  await expect(page.getByRole("region", { name: /修复处置|回滚处置|修复建议/ })).toContainText("监控链路不可用，无法证明恢复");
  const overflow = await page.evaluate(() => ({
    width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    elements: [...document.querySelectorAll("section, nav, article, p, li, div")]
      .filter((element) => element.scrollWidth > element.clientWidth && getComputedStyle(element).overflowX === "visible")
      .map((element) => element.className),
  }));
  expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width);
  await page.reload();
  await expect(page.getByRole("button", { name: "准备回滚提案", exact: true })).toHaveCount(0);
});
