"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { LocalTimestamp } from "@/components/local-timestamp";
import { UiIcon } from "@/components/ui/ui-icon";
import type { IncidentListItem } from "@/lib/agent-runtime/view-models";
import { incidentStatusLabel, targetLabel } from "@/lib/agent-runtime/view-models";

import { IncidentStatusBadge } from "./incident-status";

export function IncidentList({ incidents }: { incidents: IncidentListItem[] }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<{ key: "updatedAt" | "status"; direction: "ascending" | "descending" }>({ key: "updatedAt", direction: "descending" });
  const sortedIncidents = [...incidents].sort((left, right) => {
    const updated = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
    const primary = sort.key === "updatedAt" ? updated
      : incidentStatusLabel(left.status).localeCompare(incidentStatusLabel(right.status), "zh-CN");
    return (sort.direction === "ascending" ? primary : -primary)
      || -updated || left.id.localeCompare(right.id);
  });
  function changeSort(key: "updatedAt" | "status") {
    setSort(current => ({ key, direction: current.key === key && current.direction === "descending" ? "ascending" : "descending" }));
    if (listRef.current) listRef.current.scrollTop = 0;
    updateHiddenEdges();
  }
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
    <>
      <div className="incident-list-sort" role="group" aria-label="Incident 排序">
        <span>当前列表排序</span>
        {([ ["updatedAt", "更新时间"], ["status", "状态"] ] as const).map(([key, label]) => (
          <button
            key={key}
            className="incident-list-sort__button"
            type="button"
            aria-pressed={sort.key === key}
            aria-label={`按${label}${sort.key === key && sort.direction === "descending" ? "升序" : "降序"}排列`}
            title={key === "status" ? "按状态名称排列；同状态按更新时间从新到旧" : "按本地更新时间排列"}
            onClick={() => changeSort(key)}
          >
            {label}
            <UiIcon name={sort.key === key && sort.direction === "ascending" ? "arrow-up" : "arrow-down"} />
          </button>
        ))}
      </div>
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
              <th id="incident-column-updated" scope="col" aria-sort={sort.key === "updatedAt" ? sort.direction : "none"}>本地更新时间</th>
              <th id="incident-column-status" scope="col" aria-sort={sort.key === "status" ? sort.direction : "none"}>状态</th>
              <th id="incident-column-action" scope="col"><span className="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            {sortedIncidents.map((incident) => (
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
    </>
  );
}
