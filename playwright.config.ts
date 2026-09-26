import { defineConfig, devices } from "@playwright/test";

const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? "3100");
const runtimePort = Number(process.env.PLAYWRIGHT_RUNTIME_PORT ?? "18080");

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
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command: `npm run start -- --hostname 127.0.0.1 --port ${webPort}`,
    url: `http://127.0.0.1:${webPort}`,
    env: {
      AGENT_RUNTIME_URL: `http://127.0.0.1:${runtimePort}`,
      YAML_ASSISTANT_URL: "http://127.0.0.1:3001",
      // Synthetic record: only the rendering contract is under test.
      PUBLIC_ICP_RECORD: "京ICP备00000000号-1",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
