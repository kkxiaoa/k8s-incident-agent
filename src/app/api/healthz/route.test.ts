import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /api/healthz", () => {
  it("returns an empty non-cacheable success response", async () => {
    const response = GET();

    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });
});
