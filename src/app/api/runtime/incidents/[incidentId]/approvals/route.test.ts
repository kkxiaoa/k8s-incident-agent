import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";

const ID = "123e4567-e89b-12d3-a456-426614174000";
beforeEach(() => vi.stubEnv("AGENT_RUNTIME_URL", "http://127.0.0.1:8000"));

it("forwards exact decision bytes and existing operator credentials only to the fixed endpoint", async () => {
  const body = JSON.stringify({ runId: ID, proposalId: ID, proposalDigest: `sha256:${"a".repeat(64)}`, decision: "approve" });
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: ID }, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const response = await POST(new Request("https://console.test/approvals?url=discard", {
    method: "POST", headers: { "content-type": "application/json", Origin: "https://console.test", "X-CSRF-Token": "b".repeat(64), "x-operator-ref": "forged" }, body,
  }), { params: Promise.resolve({ incidentId: ID }) });
  const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
  expect(url.href).toBe(`http://127.0.0.1:8000/api/v1/incidents/${ID}/approvals`);
  expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(body);
  expect(new Headers(init.headers).get("origin")).toBe("https://console.test");
  expect(new Headers(init.headers).get("x-csrf-token")).toBe("b".repeat(64));
  expect(new Headers(init.headers).has("x-operator-ref")).toBe(false);
  expect(response.status).toBe(200);
});

it.each([
  ["operator_authentication_required", 401, "Operator authentication is required."],
  ["approval_conflict", 409, "Exact approval is no longer available."],
  ["execution_disabled", 403, "Sandbox execution is disabled."],
])("preserves %s without retrying the decision", async (code, status, message) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code, message, retryable: false } }, { status })));
  const response = await POST(new Request("https://console.test/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ incidentId: ID }) });
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: { code, message, retryable: false } });
});
