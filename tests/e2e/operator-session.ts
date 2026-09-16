import { expect, type Page } from "@playwright/test";

export async function login(page: Page): Promise<void> {
  const password = process.env.PLAYWRIGHT_OPERATOR_PASSWORD;
  if (!password) throw new Error("Tests-only operator credential is missing");
  await page.goto("/login");
  await page.getByLabel("登录口令").fill(password);
  await page.getByRole("button", { name: "进入 Incident Console" }).click();
  await expect(page).toHaveURL(/\/$/);
}
