import { expect, test } from "@playwright/test";
import { login } from "./operator-session";

test("login and header actions remain usable on narrow screens", async ({ page }) => {
  await page.goto("/login");
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.getByRole("textbox", { name: "登录口令" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.getByRole("textbox", { name: "登录口令" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "进入 Incident Console" })).toBeFocused();
  await login(page);
  const header = page.getByRole("banner");
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const bounds = await header.locator("a, button").evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }));
    for (const [index, box] of bounds.entries()) {
      expect(box.left >= 0 && box.right <= width && box.bottom > box.top).toBe(true);
      for (const other of bounds.slice(index + 1)) {
        expect(box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top).toBe(true);
      }
    }
  }
  await header.getByRole("link", { name: "YAML 编写助手" }).focus();
  await page.keyboard.press("Tab");
  await expect(header.getByRole("button", { name: "登出" })).toBeFocused();
});

test("only user activity renews the session and renewal is throttled", async ({ page, context }) => {
  await login(page);
  const renewals: string[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/runtime/operator/session") renewals.push(request.url());
  });
  await page.clock.install();
  const cookieBefore = (await context.cookies()).find(cookie => cookie.name === "__Host-k8s-incident-session");
  const originalExpiry = await page.evaluate(async () => (await (await fetch("/api/runtime/operator/session")).json()).expiresAt as number);
  await page.evaluate(async () => {
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await fetch("/api/runtime/operator/session");
  });
  await page.clock.runFor(61_000);
  expect(renewals).toHaveLength(0);
  expect(await page.evaluate(async () => (await (await fetch("/api/runtime/operator/session")).json()).expiresAt as number)).toBe(originalExpiry);
  const renewedResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/operator/session"));
  await page.keyboard.press("Shift");
  const renewed = await renewedResponse;
  expect(renewed.status()).toBe(200);
  expect(await renewed.headerValue("set-cookie")).toContain("Max-Age=3600");
  expect(renewals).toHaveLength(1);
  const cookieAfter = (await context.cookies()).find(cookie => cookie.name === "__Host-k8s-incident-session");
  expect(cookieAfter?.value === cookieBefore?.value).toBe(true);
  expect(cookieAfter?.expires).toBeGreaterThan(cookieBefore!.expires);
  await page.keyboard.press("Shift");
  await page.mouse.wheel(0, 1);
  expect(renewals).toHaveLength(1);
  await page.clock.runFor(61_000);
  expect(renewals).toHaveLength(1);
  const secondRenewal = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/operator/session"));
  await page.keyboard.press("Shift");
  expect((await secondRenewal).status()).toBe(200);
  expect(renewals).toHaveLength(2);
});

test("operator cookie protects SSR and API, survives reload, and is cleared on logout", async ({ page, context, browser }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/runtime/incidents")).status()).toBe(401);
  await login(page);
  const cookie = (await context.cookies()).find(value => value.name === "__Host-k8s-incident-session");
  expect(cookie !== undefined).toBe(true);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.secure).toBe(true);
  expect(cookie?.sameSite).toBe("Strict");
  expect(cookie?.path).toBe("/");
  expect(await page.evaluate(async () => (await fetch("/api/runtime/incidents")).status)).toBe(200);
  await page.reload();
  await expect(page.getByRole("region", { name: "监控链路" })).toBeVisible();
  const independent = await browser.newContext();
  try {
    const other = await independent.newPage();
    await other.goto(new URL("/", page.url()).href);
    await expect(other).toHaveURL(/\/login$/);
  } finally { await independent.close(); }
  await page.getByRole("button", { name: "登出" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await context.cookies()).some(value => value.name === "__Host-k8s-incident-session")).toBe(false);
  expect((await page.request.get("/api/runtime/incidents")).status()).toBe(401);
  const runtimeHealth = await fetch(`http://127.0.0.1:${process.env.PLAYWRIGHT_RUNTIME_PORT ?? "18080"}/healthz`);
  expect(runtimeHealth.status).toBe(200);
  expect((await page.request.get("/api/runtime/healthz")).status()).toBe(404);
});
