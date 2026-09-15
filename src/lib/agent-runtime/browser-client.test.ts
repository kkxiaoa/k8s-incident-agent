import { afterEach, expect, it, vi } from "vitest";
import { authenticatedFetch } from "./operator-client";
import { decideRepairFromBrowser, prepareRepairFromBrowser } from "./browser-client";
import { makeRecoveryDetail } from "@/test/agent-runtime-fixtures";

vi.mock("./operator-client", () => ({ authenticatedFetch: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it("uses only the fixed same-origin repair route and preserves exact selection", async () => {
  vi.mocked(authenticatedFetch).mockResolvedValue(new Response(JSON.stringify({ schemaVersion: 5, runId: "22222222-2222-4222-8222-222222222222" }), { headers: { "content-type": "application/json" } }));
  const request = { sourceRunId: "11111111-1111-4111-8111-111111111111", selection: { revision: "9223372036854775806", replicaSetUid: "old-rs" } };
  expect((await prepareRepairFromBrowser("incident/id", request)).ok).toBe(true);
  expect(authenticatedFetch).toHaveBeenCalledWith("/api/runtime/incidents/incident%2Fid/repair-runs", expect.objectContaining({ method: "POST", body: JSON.stringify(request) }));
});

it("rejects an approval receipt for a different proposal and never retries an uncertain request", async () => {
  const detail = makeRecoveryDetail("recovered");
  const approval = detail.approval!;
  const request = { runId: approval.runId, proposalId: approval.proposalId, proposalDigest: approval.proposalDigest, decision: "approve" as const };
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(new Response(JSON.stringify({ ...approval, proposalDigest: `sha256:${"b".repeat(64)}` }), { headers: { "content-type": "application/json" } }));
  expect(await decideRepairFromBrowser(detail.incident.id, request)).toEqual({ ok: false, failure: "invalid_response" });
  vi.mocked(authenticatedFetch).mockRejectedValueOnce(new Error("interrupted"));
  expect(await decideRepairFromBrowser(detail.incident.id, request)).toEqual({ ok: false, failure: "unavailable" });
  expect(authenticatedFetch).toHaveBeenCalledTimes(2);
});

it.each([[409, "conflict"], [403, "forbidden"], [503, "unavailable"]])("keeps %s distinct without exposing the upstream body", async (status, failure) => {
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(new Response("not forwarded", { status: Number(status) }));
  expect(await prepareRepairFromBrowser("incident", { sourceRunId: "source" })).toEqual({ ok: false, failure });
});
