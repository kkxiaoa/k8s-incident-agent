import { useEffect, useState } from "react";
import { fetchIncidentFromBrowser } from "@/lib/agent-runtime/browser-client";
import type { IncidentDetailView } from "@/lib/agent-runtime/response-contracts";

type SourceFailure = Extract<
  Awaited<ReturnType<typeof fetchIncidentFromBrowser>>,
  { ok: false }
>["failure"];

export function useSourceDiagnosis(detail: IncidentDetailView) {
  const { id: incidentId } = detail.incident;
  const runId = detail.selectedRun?.id;
  const kind = detail.selectedRun?.kind;
  const sourceRunId = detail.selectedRun?.sourceRunId;
  const attempt = detail.selectedRun?.attempt;
  const key = `${incidentId}:${runId}:${sourceRunId}`;
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    key: string; retry: number; detail: IncidentDetailView | null; failure: SourceFailure | null;
  } | null>(null);

  useEffect(() => {
    if (kind !== "repair" || attempt === undefined) return;
    let cancelled = false;
    const currentAttempt = attempt;
    async function load() {
      let nextId = sourceRunId;
      let beforeAttempt = currentAttempt;
      let diagnosis: IncidentDetailView | null = null;
      let failure: SourceFailure = "unavailable";
      while (nextId && !cancelled) {
        const response = await fetchIncidentFromBrowser(incidentId, nextId);
        if (cancelled) break;
        if (!response.ok) {
          failure = response.failure;
          break;
        }
        const source = response.data;
        // Follow only the exact, earlier source; unrelated history is not a fallback.
        if (source.incident.id !== incidentId || source.selectedRun === null || source.selectedRun.id !== nextId
          || source.selectedRun.attempt >= beforeAttempt) {
          failure = "invalid_response";
          break;
        }
        if (source.selectedRun.kind === "diagnosis") {
          diagnosis = source;
          break;
        }
        beforeAttempt = source.selectedRun.attempt;
        nextId = source.selectedRun.sourceRunId;
      }
      if (!cancelled) setResult({
        key, retry, detail: diagnosis, failure: diagnosis === null ? failure : null,
      });
    }
    void load();
    return () => { cancelled = true; };
  }, [incidentId, runId, kind, sourceRunId, attempt, key, retry]);

  const settled = result?.key === key && result.retry === retry;
  return {
    detail: kind === "diagnosis" ? detail : settled ? result.detail : null,
    loading: kind === "repair" && !settled,
    failure: kind !== "repair" || !settled ? null : result.failure,
    reload: () => setRetry((value) => value + 1),
  };
}
