"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createIncidentFromBrowser } from "@/lib/agent-runtime/browser-client";
import type { ScenarioResponse } from "@/lib/agent-runtime/view-models";
import { targetLabel } from "@/lib/agent-runtime/view-models";

import { ScenarioDropdown } from "./scenario-dropdown";

export function ScenarioLauncher({
  scenarios,
}: {
  scenarios: ScenarioResponse[];
}) {
  const router = useRouter();
  const [scenarioId, setScenarioId] = useState(scenarios[0]?.scenarioId ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (scenarios.length === 0) {
    return <p className="empty-state">当前没有可启动的诊断场景。</p>;
  }

  const selected =
    scenarios.find((scenario) => scenario.scenarioId === scenarioId) ??
    scenarios[0];

  async function createIncident() {
    setSubmitting(true);
    setError(null);
    const result = await createIncidentFromBrowser(selected.scenarioId);

    if (!result.ok) {
      setError(
        result.failure === "not_found"
          ? "所选诊断场景已不存在，请刷新页面。"
          : "暂时无法创建 Incident，请稍后重试。",
      );
      setSubmitting(false);
      return;
    }

    router.push(`/incidents/${result.data.incidentId}`);
  }

  return (
    <div className="scenario-launcher">
      <label id="scenario-label" className="field-label" htmlFor="scenario">
        诊断场景
      </label>
      <ScenarioDropdown
        disabled={submitting}
        labelId="scenario-label"
        scenarios={scenarios}
        value={selected.scenarioId}
        onChange={setScenarioId}
      />

      <div className="scenario-copy" aria-live="polite">
        <p>{selected.description}</p>
        <span>{targetLabel(selected.target)}</span>
      </div>

      <button
        className="primary-button"
        type="button"
        disabled={submitting}
        onClick={createIncident}
      >
        {submitting ? "正在创建…" : "创建 Incident"}
      </button>

      {error === null ? null : (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
