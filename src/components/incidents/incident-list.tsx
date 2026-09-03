"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { LocalTimestamp } from "@/components/local-timestamp";
import { UiIcon } from "@/components/ui/ui-icon";
import type { IncidentListItem } from "@/lib/agent-runtime/view-models";
import { targetLabel } from "@/lib/agent-runtime/view-models";

import { IncidentStatusBadge } from "./incident-status";

export function IncidentList({ incidents }: { incidents: IncidentListItem[] }) {
  const listRef = useRef<HTMLDivElement>(null);
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
        <span>告警进入 Runtime 后，记录会出现在这里。</span>
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
        <UiIcon name="arrow-up" />
        上方还有 Incident
      </span>
      <div className="incident-list" onScroll={updateHiddenEdges} ref={listRef}>
        <table className="incident-table">
          <thead>
            <tr>
              <th id="incident-column-name" scope="col">Incident</th>
              <th id="incident-column-target" scope="col">Kubernetes 目标</th>
              <th id="incident-column-updated" scope="col">本地更新时间</th>
              <th id="incident-column-status" scope="col">状态</th>
              <th id="incident-column-action" scope="col"><span className="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            {incidents.map((incident) => (
              <tr key={incident.id}>
                <td data-label="Incident" headers="incident-column-name">
                  <Link
                    className="incident-list__link"
                    href={`/incidents/${incident.id}`}
                    aria-label={`${incident.displayName}，查看 Incident 详情`}
                  >
                    {incident.displayName}
                  </Link>
                </td>
                <td data-label="Kubernetes 目标" headers="incident-column-target" className="incident-list__target">
                  {targetLabel(incident.target)}
                </td>
                <td data-label="本地更新时间" headers="incident-column-updated" className="incident-list__time">
                  <LocalTimestamp timestamp={incident.updatedAt} />
                </td>
                <td data-label="状态" headers="incident-column-status">
                  <IncidentStatusBadge status={incident.status} />
                </td>
                <td className="incident-table__action" headers="incident-column-action">
                  <UiIcon name="chevron-right" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span
        aria-hidden="true"
        className="incident-list__overflow-cue incident-list__overflow-cue--bottom"
      >
        <UiIcon name="arrow-down" />
        下方还有 Incident
      </span>
    </div>
  );
}
