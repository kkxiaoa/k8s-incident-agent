import { beforeEach, expect, it, vi } from "vitest";
import { GET } from "./route";

beforeEach(() => vi.stubEnv("AGENT_RUNTIME_URL", "http://127.0.0.1:8000"));
it("keeps alert history on the fixed readonly route and forwards only pagination", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ schemaVersion: 6, items: [], nextCursor: null }));
  vi.stubGlobal("fetch", fetchMock);
  const incidentId = "11111111-1111-4111-8111-111111111111";
  const result = await GET(new Request(`http://console.test/api/runtime/incidents/${incidentId}/alerts?limit=20&cursor=next&url=http://untrusted.test`, {
    headers: { authorization: "Bearer discarded" },
  }), { params: Promise.resolve({ incidentId }) });
  expect(result.status).toBe(200);
  const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
  expect(url.href).toBe(`http://127.0.0.1:8000/api/v1/incidents/${incidentId}/alerts?limit=20&cursor=next`);
  expect(init.method).toBe("GET");
  expect(new Headers(init.headers).has("authorization")).toBe(false);
  const rejected = await GET(new Request("http://console.test"), { params: Promise.resolve({ incidentId: "../elsewhere" }) });
  expect(rejected.status).toBe(422);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
