import assert from "node:assert/strict";
import test from "node:test";

import type { MetricPanel, PanelReference } from "../../../src/contracts/runtime-api.ts";
import { assessFiringPanel, isPostResolutionSettled, isRiskyValue, requireTriggerPanel } from "../../../src/lifecycle/gates/panels.ts";
import { coded } from "./support.ts";

function reference(signalRole: PanelReference["signalRole"]): PanelReference {
  return {
    panelId: `panel-${signalRole}`,
    title: "Panel",
    unit: "pods",
    purpose: "Registered purpose.",
    seriesBinding: "target",
    recommendedWindow: "15m",
    riskDirection: signalRole === "trigger" ? "higher_is_worse" : "neutral",
    signalRole,
    thresholdDuration: null,
  };
}

function panel(overrides: Partial<MetricPanel["result"]> = {}): MetricPanel {
  return {
    schemaVersion: 2,
    markers: [],
    markersTruncated: false,
    result: {
      panelId: "panel-trigger",
      title: "Panel",
      unit: "pods",
      purpose: "Registered purpose.",
      window: "15m",
      anchor: "current",
      state: "ok",
      threshold: 1,
      riskDirection: "higher_is_worse",
      seriesBinding: "target",
      currentValue: 1,
      latestSampleAt: "2026-09-05T00:00:00Z",
      queriedAt: "2026-09-05T00:00:00Z",
      rangeStart: "2026-09-04T23:45:00Z",
      rangeEnd: "2026-09-05T00:00:00Z",
      series: [{ labels: {}, samples: [{ timestamp: "2026-09-05T00:00:00Z", value: 1 }] }],
      ...overrides,
    },
  };
}

test("the trigger panel must be observable, single-series and past its risk threshold", () => {
  assert.deepEqual(assessFiringPanel(reference("trigger"), panel()), { panelId: "panel-trigger", signalRole: "trigger", state: "ok", window: "15m" });
  assert.throws(() => assessFiringPanel(reference("trigger"), panel({ state: "stale" })), coded("firing_panel_invalid"));
  assert.throws(() => assessFiringPanel(reference("trigger"), panel({ currentValue: null })), coded("firing_panel_invalid"));
  assert.throws(() => assessFiringPanel(reference("trigger"), panel({ series: [] })), coded("firing_panel_invalid"));
  assert.throws(() => assessFiringPanel(reference("trigger"), panel({ currentValue: 0 })), coded("trigger_panel_not_firing"));
  assert.throws(() => assessFiringPanel(reference("trigger"), panel({ threshold: null })), coded("upstream_contract_invalid"));
  assert.throws(() => assessFiringPanel(reference("trigger"), panel({ series: "none" as unknown as MetricPanel["result"]["series"] })), coded("upstream_contract_invalid"));
});

test("context panels may be empty but never unqueryable", () => {
  assert.equal(assessFiringPanel(reference("context"), panel({ panelId: "panel-context", state: "no_data", currentValue: null, series: [] })).state, "no_data");
  assert.equal(assessFiringPanel(reference("context"), panel({ panelId: "panel-context", state: "stale", currentValue: null, series: [] })).state, "stale");
  assert.throws(() => assessFiringPanel(reference("context"), panel({ state: "query_error", series: [] })), coded("firing_panel_invalid"));
  assert.throws(() => assessFiringPanel(reference("context"), panel({ state: "monitoring_unavailable", series: [] })), coded("firing_panel_invalid"));
  assert.throws(() => assessFiringPanel(reference("trigger"), panel({ state: "query_error", series: [] })), coded("firing_panel_invalid"));
});

test("a panel set without a trigger panel is not the Runtime this evaluator verified", () => {
  assert.doesNotThrow(() => requireTriggerPanel([{ panelId: "a", signalRole: "trigger", state: "ok", window: "15m" }]));
  assert.throws(() => requireTriggerPanel([{ panelId: "a", signalRole: "context", state: "no_data", window: "15m" }]), coded("upstream_contract_invalid"));
  assert.throws(() => requireTriggerPanel([]), coded("upstream_contract_invalid"));
});

test("risk direction decides what a risky value is, and settled panels stopped reporting risk", () => {
  assert.equal(isRiskyValue(panel().result), true);
  assert.equal(isRiskyValue(panel({ currentValue: 0 }).result), false);
  assert.equal(isRiskyValue(panel({ riskDirection: "lower_is_worse", currentValue: 0 }).result), true);
  assert.equal(isRiskyValue(panel({ riskDirection: "lower_is_worse", currentValue: 1 }).result), false);
  assert.equal(isRiskyValue(panel({ riskDirection: "neutral" }).result), false);
  assert.equal(isRiskyValue(panel({ threshold: null }).result), false);

  assert.equal(isPostResolutionSettled(reference("trigger"), panel({ state: "stale" }).result), true);
  assert.equal(isPostResolutionSettled(reference("trigger"), panel({ state: "no_data" }).result), true);
  assert.equal(isPostResolutionSettled(reference("trigger"), panel({ state: "partial" }).result), true);
  assert.equal(isPostResolutionSettled(reference("trigger"), panel().result), false);
  assert.equal(isPostResolutionSettled(reference("trigger"), panel({ currentValue: 0 }).result), true);
  assert.equal(isPostResolutionSettled(reference("context"), panel().result), true);
  assert.equal(isPostResolutionSettled(reference("trigger"), panel({ state: "monitoring_unavailable" }).result), false);
  assert.equal(isPostResolutionSettled(reference("trigger"), panel({ state: "query_error" }).result), false);
});
