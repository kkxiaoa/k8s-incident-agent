import { expect, test, type Page } from "@playwright/test";
import { login } from "./operator-session";

const runtimeUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_RUNTIME_PORT ?? "18080"}`;

async function control(path: string, body: object = {}) {
  const response = await fetch(`${runtimeUrl}/__test__/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(response.ok).toBe(true);
  return response.json();
}

async function seed(page: Page) {
  await control("reset");
  await control("access", { mode: "public_demo" });
  const { incidentId } = await control("repair", { outcome: "passed" }) as { incidentId: string };
  await page.goto(`/incidents/${incidentId}`);
  await expect(page.getByRole("banner").getByRole("link", { name: "登录", exact: true })).toBeVisible();
  return incidentId;
}

test.afterEach(async () => { await control("reset"); });

test("anonymous reads create no identity and manual actions explain login requirements", async ({ page, context }) => {
  const incidentId = await seed(page);
  const prepare = page.getByRole("button", { name: "准备修复提案", exact: true });
  await expect(prepare).toBeDisabled();
  await prepare.hover();
  await expect(page.getByRole("tooltip", { name: /^登录后可/ })).toHaveText("登录后可准备修复提案。");
  await expect(page.getByRole("button", { name: "重新诊断", exact: true })).toBeDisabled();
  await page.getByText("选择运行记录", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "仅看我发起的" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Incident 指标" })).toBeVisible();
  const detail = await (await page.request.get(`/api/runtime/incidents/${incidentId}`)).json();
  const denied = await page.request.post(`/api/runtime/incidents/${incidentId}/repair-runs`, { data: { sourceRunId: detail.selectedRun.id } });
  expect(denied.status()).toBe(401);
  expect((await context.cookies()).filter(cookie => cookie.name.startsWith("__Host-k8s-incident-"))).toEqual([]);
  await page.goto("/");
  const create = page.getByRole("button", { name: "创建 Incident", exact: true });
  await expect(create).toBeDisabled();
  await create.hover();
  await expect(page.getByRole("tooltip", { name: /^登录后可/ })).toHaveText("登录后可创建 Incident 并发起诊断。");
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "返回公开演示" })).toBeVisible();
});

test("operator preparation and withdrawal work; logout leaves read-only history with accessible tooltips", async ({ page, context }) => {
  const incidentId = await seed(page);
  await login(page);
  await page.goto(`/incidents/${incidentId}`);
  await page.getByRole("button", { name: "准备修复提案", exact: true }).click();
  await expect(page).toHaveURL(/\?runId=/);
  const preparedUrl = page.url();
  await expect(page.locator(".run-controls .run-context").first()).toHaveText("人工发起 · 由你发起");
  await expect(page.getByRole("button", { name: "撤回我的申请", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "登出", exact: true }).click();
  await expect(page.getByRole("banner").getByRole("link", { name: "登录", exact: true })).toBeVisible();
  await expect(page).toHaveURL(preparedUrl);
  for (const name of ["审阅并批准", "拒绝提案", "撤回我的申请", "调整提案"]) {
    const button = page.getByRole("button", { name, exact: true });
    await expect(button).toBeDisabled();
    await button.hover();
    await expect(page.getByRole("tooltip", { name: /^登录后可/ })).toContainText("登录后可");
    await expect(button).toHaveCSS("cursor", "not-allowed");
    await expect(button).toHaveCSS("transform", "none");
    await expect(button).toHaveCSS("min-height", "40px");
  }
  await page.mouse.move(0, 0);
  await page.getByRole("group", { name: "拒绝提案", exact: true }).focus();
  await expect(page.getByRole("tooltip", { name: /^登录后可/ })).toHaveText("登录后可拒绝提案。");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip", { name: /^登录后可/ })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "审阅并批准", exact: true }).hover();
  const hint = page.getByRole("tooltip", { name: /^登录后可/ });
  await expect(hint).toBeVisible();
  const box = await hint.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath("readonly-disabled-mobile.png") });
  expect((await context.cookies()).filter(cookie => cookie.name.startsWith("__Host-k8s-incident-"))).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 720 });
  await login(page);
  await page.goto(preparedUrl);
  await page.getByRole("button", { name: "撤回我的申请", exact: true }).click();
  await page.getByRole("button", { name: "确认撤回申请", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "事件处理阶段" })).toContainText("已撤回");
});

test("expired login clears an open confirmation without replaying it after login", async ({ page }) => {
  const incidentId = await seed(page);
  await login(page);
  await page.goto(`/incidents/${incidentId}`);
  await page.getByRole("button", { name: "准备修复提案", exact: true }).click();
  await expect(page).toHaveURL(/\?runId=/);
  const preparedUrl = page.url();
  await page.getByRole("button", { name: "审阅并批准", exact: true }).click();
  await expect(page.getByRole("button", { name: "批准并执行", exact: true })).toBeVisible();
  await control("access", { expireOperator: true });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("banner").getByRole("link", { name: "登录", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "批准并执行", exact: true })).toHaveCount(0);
  await login(page);
  await page.goto(preparedUrl);
  await expect(page.getByRole("button", { name: "审阅并批准", exact: true })).toBeEnabled();
  const detail = await (await page.request.get(`/api/runtime/incidents/${incidentId}`)).json();
  expect(detail.approval).toBeNull();
  expect(detail.selectedRun.status).toBe("WAITING_APPROVAL");
});
