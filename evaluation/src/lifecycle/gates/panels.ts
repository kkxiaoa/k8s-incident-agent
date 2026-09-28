import type { PanelCheck } from "../../contracts/records.ts";
import type { MetricPanel, PanelReference } from "../../contracts/runtime-api.ts";
import { contractError, upstreamContractError } from "../../shared/errors.ts";

type PanelResult = MetricPanel["result"];

export function isRiskyValue(result: PanelResult): boolean {
  if (typeof result.threshold !== "number") return false;
  return result.riskDirection === "higher_is_worse"
    ? (result.currentValue as number) >= result.threshold
    : result.riskDirection === "lower_is_worse"
      ? (result.currentValue as number) < result.threshold
      : false;
}

function requireRiskyTriggerValue(result: PanelResult): void {
  if (typeof result.threshold !== "number") throw upstreamContractError();
  if (!isRiskyValue(result)) {
    throw contractError("trigger_panel_not_firing", "The trigger panel value does not satisfy its risk threshold");
  }
}

// Only the alert's own trigger panel must be observable and firing; context panels (including
// kubelet-backed ones that a profile may not collect) may be empty, but a failing query or
// unavailable Prometheus is never acceptable.
export function assessFiringPanel(reference: PanelReference, panel: MetricPanel): PanelCheck {
  const result = panel.result;
  if (!Array.isArray(result.series)) throw upstreamContractError();
  const unobservable = result.state === "query_error" || result.state === "monitoring_unavailable";
  if (
    unobservable ||
    (reference.signalRole === "trigger" &&
      (result.state !== "ok" || result.currentValue === null || result.series.length !== 1))
  ) {
    throw contractError("firing_panel_invalid", "A required firing metric panel is not observable");
  }
  if (reference.signalRole === "trigger") requireRiskyTriggerValue(result);
  return {
    panelId: reference.panelId,
    signalRole: reference.signalRole,
    state: result.state,
    window: result.window,
  };
}

export function requireTriggerPanel(checks: readonly PanelCheck[]): void {
  if (!checks.some((panel) => panel.signalRole === "trigger")) throw upstreamContractError();
}

// After the alert clears, a panel has settled when it stopped reporting the risky value.
export function isPostResolutionSettled(reference: Pick<PanelReference, "signalRole">, result: PanelResult): boolean {
  if (result.state === "no_data" || result.state === "stale" || result.state === "partial") return true;
  return result.state === "ok" && (reference.signalRole !== "trigger" || !isRiskyValue(result));
}
