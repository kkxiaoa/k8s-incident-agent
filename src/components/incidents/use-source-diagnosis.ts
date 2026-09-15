import { useEffect, useState } from "react";
import { fetchIncidentFromBrowser } from "@/lib/agent-runtime/browser-client";
import type { IncidentDetailView } from "@/lib/agent-runtime/response-contracts";

export function useSourceDiagnosis(detail: IncidentDetailView) {
  const { id: incidentId } = detail.incident;
  const { id: runId, kind, sourceRunId, attempt } = detail.selectedRun;
  const key = `${incidentId}:${runId}:${sourceRunId}`;
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    key: string; retry: number; detail: IncidentDetailView | null;
  } | null>(null);

  useEffect(() => {
    if (kind === "diagnosis") return;
    let cancelled = false;
    async function load() {
      let nextId = sourceRunId;
      let beforeAttempt = attempt;
      let diagnosis: IncidentDetailView | null = null;
      while (nextId && !cancelled) {
        const response = await fetchIncidentFromBrowser(incidentId, nextId);
        if (!response.ok || cancelled) break;
        const source = response.data;
        // Follow only the exact, earlier source; unrelated history is not a fallback.
        if (source.incident.id !== incidentId || source.selectedRun.id !== nextId
          || source.selectedRun.attempt >= beforeAttempt) break;
        if (source.selectedRun.kind === "diagnosis") {
          diagnosis = source;
          break;
        }
        beforeAttempt = source.selectedRun.attempt;
        nextId = source.selectedRun.sourceRunId;
      }
      if (!cancelled) setResult({ key, retry, detail: diagnosis });
    }
    void load();
    return () => { cancelled = true; };
  }, [incidentId, runId, kind, sourceRunId, attempt, key, retry]);

  const settled = result?.key === key && result.retry === retry;
  return {
    detail: kind === "diagnosis" ? detail : settled ? result.detail : null,
    loading: kind !== "diagnosis" && !settled,
    reload: () => setRetry((value) => value + 1),
  };
}
