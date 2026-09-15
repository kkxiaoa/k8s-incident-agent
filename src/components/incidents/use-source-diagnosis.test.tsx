import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchIncidentFromBrowser } from "@/lib/agent-runtime/browser-client";
import { makeRepairRunWaitingDetail, makeWaitingApprovalIncidentDetail } from "@/test/agent-runtime-fixtures";
import { useSourceDiagnosis } from "./use-source-diagnosis";

vi.mock("@/lib/agent-runtime/browser-client", () => ({ fetchIncidentFromBrowser: vi.fn() }));
const fetchDetail = vi.mocked(fetchIncidentFromBrowser);
afterEach(() => vi.resetAllMocks());

describe("source diagnosis for the selected repair", () => {
  it("follows a repair/rollback source chain to its diagnosis without merging Evidence", async () => {
    const diagnosis = makeWaitingApprovalIncidentDetail();
    const repair = makeRepairRunWaitingDetail();
    repair.selectedRun.sourceRunId = diagnosis.selectedRun.id;
    const rollback = makeRepairRunWaitingDetail();
    rollback.selectedRun.id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    rollback.selectedRun.attempt = 3;
    rollback.selectedRun.operation = "rollback";
    rollback.selectedRun.sourceRunId = repair.selectedRun.id;
    const before = structuredClone(rollback);
    fetchDetail.mockImplementation(async (_, runId) => ({ ok: true,
      data: runId === repair.selectedRun.id ? repair : diagnosis }));
    const { result } = renderHook(() => useSourceDiagnosis(rollback));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.detail).toEqual(diagnosis);
    expect(rollback).toEqual(before);
  });

  it.each(["missing", "wrong_incident", "wrong_run", "cycle"])("does not invent a diagnosis for %s sources", async (failure) => {
    const source = makeWaitingApprovalIncidentDetail();
    const repair = makeRepairRunWaitingDetail();
    repair.selectedRun.sourceRunId = source.selectedRun.id;
    if (failure === "wrong_incident") source.incident.id = "another-incident";
    if (failure === "wrong_run") source.selectedRun.id = "another-run";
    if (failure === "cycle") {
      source.selectedRun.kind = "repair";
      source.selectedRun.sourceRunId = repair.selectedRun.id;
      source.diagnosis = null;
    }
    fetchDetail.mockImplementation(async (_, id) => failure === "missing"
      ? { ok: false, failure: "not_found" }
      : { ok: true, data: id === repair.selectedRun.id ? repair : source });
    const { result } = renderHook(() => useSourceDiagnosis(repair));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.detail).toBeNull();
  });

  it("retains a failed source diagnosis as failed, not repair success", async () => {
    const source = makeWaitingApprovalIncidentDetail();
    source.selectedRun.status = "FAILED";
    source.diagnosis = null;
    const repair = makeRepairRunWaitingDetail();
    repair.selectedRun.sourceRunId = source.selectedRun.id;
    fetchDetail.mockResolvedValue({ ok: true, data: source });
    const { result } = renderHook(() => useSourceDiagnosis(repair));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.detail?.selectedRun.status).toBe("FAILED");
    expect(result.current.detail?.diagnosis).toBeNull();
  });

  it("ignores an old source response after switching Runs and can retry an unavailable source", async () => {
    const source = makeWaitingApprovalIncidentDetail();
    const repair = makeRepairRunWaitingDetail();
    repair.selectedRun.sourceRunId = source.selectedRun.id;
    let finish!: (value: Awaited<ReturnType<typeof fetchIncidentFromBrowser>>) => void;
    fetchDetail.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(({ detail }) => useSourceDiagnosis(detail), { initialProps: { detail: repair } });
    const other = makeWaitingApprovalIncidentDetail();
    other.selectedRun.id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    rerender({ detail: other });
    await act(async () => finish({ ok: true, data: source }));
    expect(result.current.detail?.selectedRun.id).toBe(other.selectedRun.id);
    fetchDetail.mockResolvedValueOnce({ ok: false, failure: "unavailable" });
    rerender({ detail: repair });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.detail).toBeNull();
    fetchDetail.mockResolvedValueOnce({ ok: true, data: source });
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.detail).toEqual(source));
  });
});
