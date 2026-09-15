"use client";

import { ChoiceDropdown } from "@/components/ui/choice-dropdown";
import type { ScenarioResponse } from "@/lib/agent-runtime/view-models";

export function ScenarioDropdown({ disabled, labelId, onChange, scenarios, value }: {
  disabled: boolean;
  labelId: string;
  onChange: (scenarioId: string) => void;
  scenarios: ScenarioResponse[];
  value: string;
}) {
  return <ChoiceDropdown id="scenario" disabled={disabled} labelId={labelId}
    onChange={onChange} value={value}
    options={scenarios.map((scenario) => ({ value: scenario.scenarioId, label: scenario.displayName }))} />;
}
