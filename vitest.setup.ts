import { afterEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
