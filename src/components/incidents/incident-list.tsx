"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { LocalTimestamp } from "@/components/local-timestamp";
import { UiIcon } from "@/components/ui/ui-icon";
import { fetchIncidentsFromBrowser } from "@/lib/agent-runtime/browser-client";
import type { IncidentListItem } from "@/lib/agent-runtime/view-models";
import { incidentStatusLabel, targetLabel } from "@/lib/agent-runtime/view-models";

import { IncidentStatusBadge } from "./incident-status";

export function IncidentList({
  incidents,
  nextCursor = null,
}: {
  incidents: IncidentListItem[];
  /** Older records stay on the Runtime until the reader asks for them. */
  nextCursor?: string | null;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(incidents);
  const [cursor, setCursor] = useState(nextCursor);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "failed">(
    "idle",
  );
  const [families, setFamilies] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const familyOptions = [...new Set(loaded.map((item) => item.displayName))].sort(
    (left, right) => left.localeCompare(right, "zh-CN"),
  );
  const statusOptions = [...new Set(loaded.map((item) => item.status))];
  const filtered = loaded.filter(
    (item) =>
      (families.length === 0 || families.includes(item.displayName)) &&
      (statuses.length === 0 || statuses.includes(item.status)),
  );
  const toggle = (
    values: string[],
    setValues: (next: string[]) => void,
    value: string,
  ) =>
    setValues(
      values.includes(value)
        ? values.filter((item) => item !== value)
        : [...values, value],
    );

  async function loadOlder() {
    if (cursor === null || loadState === "loading") {
      return;
    }
    setLoadState("loading");
    const result = await fetchIncidentsFromBrowser(cursor);
    if (!result.ok) {
      setLoadState("failed");
      return;
    }
    setLoaded((current) => {
      const known = new Set(current.map((item) => item.id));
      return [...current, ...result.data.items.filter((item) => !known.has(item.id))];
    });
    setCursor(result.data.nextCursor);
    setLoadState("idle");
  }
  const [sort, setSort] = useState<{ key: "updatedAt" | "status"; direction: "ascending" | "descending" }>({ key: "updatedAt", direction: "descending" });
  const sortedIncidents = [...filtered].sort((left, right) => {
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
  }, [sortedIncidents.length, updateHiddenEdges]);

  if (loaded.length === 0) {
    return (
      <div className="empty-state empty-state--panel">
        <p>还没有持久化的 Incident。</p>
        <span>告警进入 Runtime 后，记录会出现在这里。</span>
      </div>
    );
  }

  return (
    <>
      <div className="incident-list-filter">
        <div role="group" aria-label="按故障族过滤">
          <span>故障族</span>
          {familyOptions.map((family) => (
            <button
              key={family}
              type="button"
              className="incident-list-filter__chip"
              aria-pressed={families.includes(family)}
              onClick={() => toggle(families, setFamilies, family)}
            >
              {family}
            </button>
          ))}
        </div>
        <div role="group" aria-label="按状态过滤">
          <span>状态</span>
          {statusOptions.map((status) => (
            <button
              key={status}
              type="button"
              className="incident-list-filter__chip"
              aria-pressed={statuses.includes(status)}
              onClick={() => toggle(statuses, setStatuses, status)}
            >
              {incidentStatusLabel(status)}
            </button>
          ))}
        </div>
        <p className="incident-list-filter__summary" role="status">
          {`已筛选 ${filtered.length} / 已加载 ${loaded.length}`}
          {cursor === null ? "，已加载全部记录" : "，仍有更早记录未加载"}
        </p>
      </div>
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
    {cursor === null ? null : (
      <div className="incident-list-more">
        <button
          type="button"
          className="incident-list-more__button"
          onClick={() => void loadOlder()}
          disabled={loadState === "loading"}
        >
          {loadState === "loading" ? "正在加载…" : "加载更早记录"}
        </button>
        {loadState === "failed" ? (
          <span role="alert">暂时无法加载更早记录，请稍后重试。</span>
        ) : null}
      </div>
    )}
    </>
  );
}
