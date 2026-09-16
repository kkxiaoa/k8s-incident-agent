"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createIncidentFromBrowser } from "@/lib/agent-runtime/browser-client";
import type { ScenarioResponse } from "@/lib/agent-runtime/view-models";
import { targetLabel } from "@/lib/agent-runtime/view-models";

import { ActionButton } from "@/components/ui/action-button";

import { ScenarioDropdown } from "./scenario-dropdown";

export function ScenarioLauncher({
  scenarios,
  canOperate,
}: {
  scenarios: ScenarioResponse[];
  canOperate: boolean | null;
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
    if (!canOperate || submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await createIncidentFromBrowser(selected.scenarioId);

    if (!result.ok) {
      setError(
        result.failure === "not_found"
          ? "所选诊断场景已不存在，请刷新页面。"
          : result.failure === "diagnosis_unavailable"
          ? "模型诊断暂不可用，未创建 Incident。请在模型服务恢复后重试。"
          : result.failure === "public_demo_limited"
          ? "公开读取暂时达到容量上限，请稍后重试。"
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

      <ActionButton
        className="primary-button"
        type="button"
        disabled={!canOperate || submitting}
        disabledReason={canOperate === null ? "暂时无法核对登录状态，请稍后重试。" : !canOperate ? "登录后可创建 Incident 并发起诊断。" : "正在创建 Incident，请稍候。"}
        onClick={createIncident}
      >
        {submitting ? "正在创建…" : "创建 Incident"}
      </ActionButton>

      {error === null ? null : (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
