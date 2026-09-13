import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";

const INCIDENT_ID = "123e4567-e89b-12d3-a456-426614174000";

beforeEach(() => {
  vi.stubEnv("AGENT_RUNTIME_URL", "http://127.0.0.1:8000");
});

it("forwards the exact source/selection payload through the fixed Runtime endpoint", async () => {
  const body = JSON.stringify({ sourceRunId: INCIDENT_ID,
    selection: { revision: "9223372036854775807", replicaSetUid: "rs-old" },
    replacesRunId: INCIDENT_ID,
  });
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ schemaVersion: 5, runId: INCIDENT_ID }, { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
  const response = await POST(new Request("https://console.test/repair-runs?url=discard", {
    method: "POST", headers: { "content-type": "application/json", "x-operator-ref": "forged" }, body,
  }), { params: Promise.resolve({ incidentId: INCIDENT_ID }) });
  const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
  expect(url.href).toBe(`http://127.0.0.1:8000/api/v1/incidents/${INCIDENT_ID}/repair-runs`);
  expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(body);
  expect(new Headers(init.headers).has("x-operator-ref")).toBe(false);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ schemaVersion: 5, runId: INCIDENT_ID });
});

it.each([
  ["operator_authentication_required", 401, "Operator authentication is required."],
  ["repair_source_invalid", 409, "Repair source is not applicable."],
])("preserves the bounded %s rejection", async (code, status, message) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code, message, retryable: false } }, { status })));
  const response = await POST(new Request("https://console.test/repair-runs", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }), { params: Promise.resolve({ incidentId: INCIDENT_ID }) });
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: { code, message, retryable: false } });
});
