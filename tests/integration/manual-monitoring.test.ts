import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { seedManualRepairShowcase, startFakeRuntime } from "../e2e/fake-runtime";
import { parseIncidentMetricPanelResponse, parseIncidentDetailResponse, parseMonitoringOverviewResponse } from "@/lib/agent-runtime/response-contracts";
import { incidentDesiredReplicas } from "@/lib/agent-runtime/view-models";

it("serves window-valid monitoring for all manual repair snapshots without masking unavailable cases", async () => {
  const origin = "http://127.0.0.1:18119";
  const password = randomBytes(32).toString("base64url");
  const runtime = await startFakeRuntime(18119, { origin, password });
  try {
    seedManualRepairShowcase();
    const login = await fetch(`${origin}/api/v1/operator/login`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ password }),
    });
    if (!login.ok) throw new Error("Synthetic login failed");
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const read = async (path: string) => {
      const response = await fetch(`${origin}/api/v1/${path}`, { headers: { cookie } });
      expect(response.status).toBe(200);
      return response.json();
    };
    const list = await read("incidents");
    expect(list.items).toHaveLength(19);
    const overview = parseMonitoringOverviewResponse(await read("monitoring/overview"));
    expect(overview).not.toBeNull();
    expect(Date.now() - Date.parse(overview!.generatedAt)).toBeLessThan(60_000);
    let unavailable = 0;
    for (const incident of list.items) {
      const detail = parseIncidentDetailResponse(await read(`incidents/${incident.id}`));
      expect(detail).not.toBeNull();
      expect(incidentDesiredReplicas(detail!.evidence)).toBe(3);
      const panels = await read(`incidents/${incident.id}/monitoring/panels`);
      for (const panel of panels.panels) {
        for (const window of ["15m", "1h", "6h", "7d", "15d"] as const) {
          const result = parseIncidentMetricPanelResponse(await read(`incidents/${incident.id}/monitoring/panels/${panel.panelId}?window=${window}`), panel.panelId, window);
          expect(result, `${incident.displayName}: ${panel.panelId}/${window}`).not.toBeNull();
          const expectedUnavailable = incident.displayName.includes("监控不可用") || incident.displayName.includes("恢复无法证明");
          // kube-state-metrics only reports Pods the scheduler rejected, so this
          // panel has no series on these snapshots.
          const expectedNoData = panel.panelId === "pod-unschedulable";
          expect(result!.result.state).toBe(
            expectedUnavailable ? "monitoring_unavailable" : expectedNoData ? "no_data" : "ok",
          );
          if (window === "15m" && expectedUnavailable) unavailable++;
          if (!expectedUnavailable && !expectedNoData && result!.result.seriesBinding !== "target") {
            expect(result!.result.series.length).toBeGreaterThan(0);
            expect(result!.result.currentValue).toBeNull();
          } else if (!expectedUnavailable && !expectedNoData) {
            expect(result!.result.series[0]?.samples.length ?? 0).toBeGreaterThanOrEqual(3);
            const affectedPods = panel.panelId === "image-pull-affected-pods";
            const outcome = detail!.verification?.outcome;
            expect(result!.result.currentValue).toBe(outcome === "recovered" ? affectedPods ? 0 : 3 : outcome === "observing" ? affectedPods ? 1 : 2 : affectedPods ? 3 : 0);
          }
        }
      }
    }
    expect(unavailable).toBe(16);
  } finally {
    await runtime.close();
  }
}, 20_000);
