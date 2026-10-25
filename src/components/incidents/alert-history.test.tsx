import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AlertHistory } from "./alert-history";
import { INCIDENT_ID } from "@/test/agent-runtime-fixtures";

const occurrence = {
  source: { type: "alertmanager", ref: "K8sIncidentCrashLoopBackOff", revision: "catalog-v1" },
  displayName: "Container restart loop", fingerprint: "0123456789abcdef", status: "FIRING",
  startsAt: "2026-09-03T00:00:00.000000000Z", endsAt: null, firstReceivedAt: null, lastReceivedAt: null,
};
afterEach(() => vi.unstubAllGlobals());
it("loads notification history lazily without a Run and preserves loaded pages on rerender", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ schemaVersion: 6, items: [occurrence], nextCursor: "older" }))
    .mockResolvedValueOnce(Response.json({ schemaVersion: 6, items: [{ ...occurrence, fingerprint: "1123456789abcdef", status: "RESOLVED", endsAt: "2026-09-03T00:05:00.000000000Z" }], nextCursor: null }));
  vi.stubGlobal("fetch", fetchMock);
  const { rerender } = render(<AlertHistory incidentId={INCIDENT_ID} />);
  expect(fetchMock).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: /告警通知历史/ }));
  await screen.findByRole("heading", { name: "Container restart loop" });
  expect(screen.getByRole("listitem")).toHaveTextContent("末次通知 FIRING");
  expect(screen.getByText("尚未收到")).toBeVisible();
  expect(screen.getAllByText("历史未记录")).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "加载更早通知" }));
  await screen.findByText("末次通知 RESOLVED");
  rerender(<AlertHistory incidentId={INCIDENT_ID} />);
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/不能解释为实际恢复时间/)).toBeVisible();
});
