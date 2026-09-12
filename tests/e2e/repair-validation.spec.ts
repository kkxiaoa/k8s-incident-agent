import { expect, test, type Page } from "@playwright/test";
import { login } from "./operator-session";

const runtimeUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_RUNTIME_PORT ?? "18080"}`;

async function seed(outcome: string, page: Page) {
  await fetch(`${runtimeUrl}/__test__/reset`, { method: "POST" });
  const response = await fetch(`${runtimeUrl}/__test__/repair`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outcome }),
  });
  expect(response.ok).toBe(true);
  await login(page);
  return (await response.json()) as { incidentId: string };
}

test("repair validation stays read-only across keyboard navigation, mobile and reload", async ({ page, baseURL }) => {
  const { incidentId } = await seed("passed", page);
  await expect(page.getByLabel("Incident 状态统计")).toContainText(/待审批1/);
  const writes: string[] = [];
  const external: string[] = [];
  page.on("request", (request) => {
    const sessionRenewal = request.method() === "POST" && new URL(request.url()).pathname === "/api/runtime/operator/session";
    if (!["GET", "HEAD"].includes(request.method()) && !sessionRenewal) writes.push(request.url());
    if (new URL(request.url()).origin !== new URL(baseURL!).origin) external.push(request.url());
  });
  await page.goto(`/incidents/${incidentId}`);
  const panel = page.getByRole("region", { name: "修复验证" });
  await expect(panel).toContainText("已通过验证，尚未批准或执行");
  const evidenceSection = page.getByRole("region", { name: "Kubernetes 证据", exact: true });
  const panelBox = await panel.boundingBox();
  const evidenceBox = await evidenceSection.boundingBox();
  expect(evidenceBox!.y - (panelBox!.y + panelBox!.height)).toBeGreaterThanOrEqual(12);
  await expect(panel.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /批准|执行|回滚|Apply/ })).toHaveCount(0);
  const summary = panel.locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByLabel("只读 JSON Patch")).toBeVisible();
  const patchJson = await panel.getByLabel("只读 JSON Patch").textContent();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await panel.getByRole("button", { name: "复制 JSON" }).click();
  await expect(panel.getByRole("button", { name: "JSON 已复制" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(patchJson);
  const expandPatch = panel.getByRole("button", { name: "展开 JSON" });
  await expandPatch.focus();
  await page.keyboard.press("Enter");
  const patchDialog = page.getByRole("dialog", { name: "JSON Patch" });
  await expect(patchDialog).toBeVisible();
  expect(await patchDialog.locator("code").textContent()).toBe(patchJson);
  await expect(patchDialog.locator("input, textarea, [contenteditable]")).toHaveCount(0);
  await patchDialog.getByRole("button", { name: "复制 JSON" }).click();
  await expect(patchDialog.getByRole("button", { name: "JSON 已复制" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(patchDialog).not.toBeVisible();
  await expect(expandPatch).toBeFocused();
  const evidenceLink = panel.getByRole("link").last();
  const evidence = page.locator((await evidenceLink.getAttribute("href"))!);
  await evidenceLink.scrollIntoViewIfNeeded();
  await evidenceLink.focus();
  await page.keyboard.press("Enter");
  await expect(evidence).toBeInViewport();
  await evidence.getByRole("button", { name: "展开 JSON" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await panel.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const mobilePanelBox = await panel.boundingBox();
  const mobileEvidenceBox = await evidenceSection.boundingBox();
  expect(mobileEvidenceBox!.y - (mobilePanelBox!.y + mobilePanelBox!.height)).toBeGreaterThanOrEqual(12);
  await expandPatch.click();
  await expect(patchDialog).toBeVisible();
  const mobileDialogBox = await patchDialog.boundingBox();
  expect(mobileDialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(mobileDialogBox!.x + mobileDialogBox!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(panel).toContainText("已通过验证，尚未批准或执行");
  expect(writes).toEqual([]);
  expect(external).toEqual([]);
});

test("stale repair remains a failed historical validation", async ({ page }) => {
  const { incidentId } = await seed("stale", page);
  await page.goto(`/incidents/${incidentId}`);
  const panel = page.getByRole("region", { name: "修复验证" });
  await expect(panel).toContainText("目标版本已变化");
  await expect(panel).toContainText("验证未通过，尚未批准或执行");
  await expect(panel.getByText("已通过", { exact: true })).toHaveCount(3);
  await expect(panel.getByRole("button")).toHaveCount(0);
});

test("invalid persisted repair fails closed at the page boundary", async ({ page }) => {
  const { incidentId } = await seed("invalid", page);
  await page.goto(`/incidents/${incidentId}`);
  await expect(page.getByRole("heading", { name: "详情数据校验失败" })).toBeVisible();
  await expect(page.getByRole("region", { name: "修复验证" })).toHaveCount(0);
});

for (const failure of [
  { code: "repair_schema_invalid", label: "Schema", unrecorded: 0, notRun: 3 },
  { code: "repair_policy_denied", label: "Policy", unrecorded: 1, notRun: 2 },
  { code: "repair_diff_invalid", label: "Diff", unrecorded: 2, notRun: 1 },
]) {
  test(`${failure.label} failure shows stopped gates without a proposal`, async ({ page }) => {
    const { incidentId } = await seed(failure.code, page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/incidents/${incidentId}`);
    const panel = page.getByRole("region", { name: "修复验证" });
    const gates = panel.getByRole("list", { name: "修复验证门禁" });
    await expect(gates.getByRole("listitem").filter({ has: page.getByText(failure.label, { exact: true }) })).toContainText("未通过");
    await expect(gates.getByText("无独立记录", { exact: true })).toHaveCount(failure.unrecorded);
    await expect(gates.getByText("未执行", { exact: true })).toHaveCount(failure.notRun);
    await expect(gates.getByText("已通过", { exact: true })).toHaveCount(0);
    await expect(gates.locator("time")).toHaveCount(0);
    await expect(panel.locator("summary")).toHaveCount(0);
    await expect(panel.getByRole("button")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload();
    await expect(gates.getByText("未通过", { exact: true })).toHaveCount(1);
  });
}
