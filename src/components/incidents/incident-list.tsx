"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { LocalTimestamp } from "@/components/local-timestamp";
import type { IncidentListItem } from "@/lib/agent-runtime/view-models";
import { targetLabel } from "@/lib/agent-runtime/view-models";

import { IncidentStatusBadge } from "./incident-status";

export function IncidentList({ incidents }: { incidents: IncidentListItem[] }) {
  const listRef = useRef<HTMLOListElement>(null);
  const [hiddenEdges, setHiddenEdges] = useState({
    above: false,
    below: false,
  });
  const updateHiddenEdges = useCallback(() => {
    const list = listRef.current;
    if (list === null) {
      return;
    }

    const next = {
      above: list.scrollTop > 1,
      below: list.scrollTop + list.clientHeight < list.scrollHeight - 1,
    };
    setHiddenEdges((current) =>
      current.above === next.above && current.below === next.below
        ? current
        : next,
    );
  }, []);

  useEffect(() => {
    updateHiddenEdges();
    window.addEventListener("resize", updateHiddenEdges);
    return () => window.removeEventListener("resize", updateHiddenEdges);
  }, [incidents.length, updateHiddenEdges]);

  if (incidents.length === 0) {
    return (
      <div className="empty-state empty-state--panel">
        <p>还没有持久化的 Incident。</p>
        <span>从诊断场景创建后，记录会出现在这里。</span>
      </div>
    );
  }

  return (
    <div
      className="incident-list-frame"
      data-hidden-above={hiddenEdges.above}
      data-hidden-below={hiddenEdges.below}
    >
      <span
        aria-hidden="true"
        className="incident-list__overflow-cue incident-list__overflow-cue--top"
      >
        ↑ 上方还有 Incident
      </span>
      <ol className="incident-list" onScroll={updateHiddenEdges} ref={listRef}>
        {incidents.map((incident) => (
          <li key={incident.id}>
            <Link
              className="incident-list__link"
              href={`/incidents/${incident.id}`}
            >
              <div className="incident-list__topline">
                <strong>{incident.displayName}</strong>
                <IncidentStatusBadge status={incident.status} />
              </div>
              <span className="incident-list__target">
                {targetLabel(incident.target)}
              </span>
              <span className="incident-list__time">
                更新于 <LocalTimestamp timestamp={incident.updatedAt} />
              </span>
            </Link>
          </li>
        ))}
      </ol>
      <span
        aria-hidden="true"
        className="incident-list__overflow-cue incident-list__overflow-cue--bottom"
      >
        ↓ 下方还有 Incident
      </span>
    </div>
  );
}
