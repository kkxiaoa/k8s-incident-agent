"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { UiIcon } from "@/components/ui/ui-icon";
import { LocalTimestamp } from "@/components/local-timestamp";
import { fetchIncidentAlertsFromBrowser } from "@/lib/agent-runtime/browser-client";
import type { IncidentAlertHistoryView } from "@/lib/agent-runtime/response-contracts";

export function AlertHistory({ incidentId }: { incidentId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<IncidentAlertHistoryView | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async (cursor: string | null) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState("loading");
    if (cursor === null) setPage(null);
    const result = await fetchIncidentAlertsFromBrowser(incidentId, cursor, controller.signal);
    if (controller.signal.aborted) return;
    if (!result.ok) { setState("failed"); return; }
    setPage(current => cursor === null || current === null ? result.data : {
      items: [...current.items, ...result.data.items.filter(item => !current.items.some(known => known.fingerprint === item.fingerprint && known.startsAt === item.startsAt))],
      nextCursor: result.data.nextCursor,
    });
    setState("idle");
  }, [incidentId]);
  useEffect(() => () => request.current?.abort(), []);
  return <section className="alert-history" aria-label="告警通知历史">
    <header className="alert-history__header">
      <h2><button className="alert-history__toggle" type="button" aria-expanded={expanded} onClick={() => { if (expanded) request.current?.abort(); else void load(null); setExpanded(value => !value); }}>
        <UiIcon name="chevron-down" />告警通知历史<span>{expanded ? " · 收起" : " · 展开"}</span>
      </button></h2>
      {expanded ? <button className="icon-button" type="button" aria-label="刷新通知历史" title="刷新通知历史" disabled={state === "loading"} onClick={() => void load(null)}><UiIcon name="refresh" className={state === "loading" ? "is-spinning" : undefined} /></button> : null}
    </header>
    {expanded ? <div>
      <p className="incident-context-note">已归属此 Incident 的真实通知；末次通知与源端当前状态分别记录。结束时间来自收到的通知，不能解释为实际恢复时间。</p>
      {state === "loading" ? <p className="incident-context-note" role="status">正在加载通知…</p> : null}
      {state === "failed" ? <p className="alert-history__error" role="alert">无法加载通知历史。<button className="secondary-button" type="button" onClick={() => void load(page?.nextCursor ?? null)}>重试</button></p> : null}
      {page?.items.length === 0 ? <p className="incident-context-note">没有已归属的通知。</p> : null}
      <ol className="alert-history__list" tabIndex={0} aria-label="已归属通知">{page?.items.map(item => <li key={`${item.fingerprint}:${item.startsAt}`}>
        <div className="alert-history__item-heading"><h3>{item.displayName}</h3><span className="status-badge status-badge--neutral">末次通知 {item.status}</span></div>
        <p className="alert-history__source">{item.source.ref}</p>
        <dl>
          <div><dt>出现时间</dt><dd><LocalTimestamp timestamp={item.startsAt} /></dd></div>
          <div><dt>通知中的结束时间</dt><dd>{item.endsAt === null ? "尚未收到" : <LocalTimestamp timestamp={item.endsAt} />}</dd></div>
          <div><dt>首次接收</dt><dd>{item.firstReceivedAt === null ? "历史未记录" : <LocalTimestamp timestamp={item.firstReceivedAt} />}</dd></div>
          <div><dt>最后接收</dt><dd>{item.lastReceivedAt === null ? "历史未记录" : <LocalTimestamp timestamp={item.lastReceivedAt} />}</dd></div>
        </dl>
      </li>)}</ol>
      {page?.nextCursor ? <button className="secondary-button" type="button" disabled={state === "loading"} onClick={() => void load(page.nextCursor)}>加载更早通知</button> : null}
    </div> : null}
  </section>;
}
