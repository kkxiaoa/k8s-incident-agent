import { expect, type Page } from "@playwright/test";

// A freshly mounted incident page requests a persisted-detail refresh when its
// event stream opens, and that refresh disables submissions. A click landing
// as the lock engages hits a disabled button and is dropped. Once the stream
// reads as live the refresh has already started, so the submit control's own
// enabled check then waits it out.
export async function waitForLiveEvents(page: Page): Promise<void> {
  await expect(page.getByText("实时追踪中", { exact: true })).toBeVisible();
}
