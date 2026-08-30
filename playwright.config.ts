import { defineConfig, devices } from "@playwright/test";

const webPort = 3100;
const runtimePort = 18080;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: "line",
  outputDir: ".next/playwright-results",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${webPort}`,
    channel: "chrome",
    headless: true,
    timezoneId: "America/Los_Angeles",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command: `npm run start -- --hostname 127.0.0.1 --port ${webPort}`,
    url: `http://127.0.0.1:${webPort}`,
    env: {
      AGENT_RUNTIME_URL: `http://127.0.0.1:${runtimePort}`,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
