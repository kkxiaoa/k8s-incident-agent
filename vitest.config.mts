import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "jsdom",
    // The integration suite drives the e2e fake runtime, which .dockerignore
    // keeps out of the image build, so it cannot live under src/.
    include: ["src/**/*.test.{ts,tsx}", "tests/integration/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
