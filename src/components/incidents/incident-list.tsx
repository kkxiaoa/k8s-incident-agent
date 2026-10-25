"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { LocalTimestamp } from "@/components/local-timestamp";
import { ChoiceDropdown } from "@/components/ui/choice-dropdown";
import { UiIcon } from "@/components/ui/ui-icon";
import { fetchIncidentsFromBrowser, type IncidentListQuery } from "@/lib/agent-runtime/browser-client";
import type { IncidentListView } from "@/lib/agent-runtime/response-contracts";
import { INCIDENT_STATUS_LABELS, incidentStatusLabel, runStatusLabel, targetLabel } from "@/lib/agent-runtime/view-models";

import { CurrentAlertBadge, IncidentStatusBadge, lifecycleLabel } from "./incident-status";

export function IncidentList({ incidents, nextCursor, alertTypes }: {
  incidents: IncidentListView["items"];
  nextCursor: string | null;
  alertTypes: IncidentListView["alertTypes"];
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [loaded, setLoaded] = useState(incidents);
  const [cursor, setCursor] = useState(nextCursor);
  const [query, setQuery] = useState<IncidentListQuery>({});
  const queryRef = useRef(query);
  const requestRef = useRef<{ sequence: number; controller: AbortController | null }>({ sequence: 0, controller: null });
  const [loadState, setLoadState] = useState<"idle" | "loading" | "failed">("idle");
  const [sort, setSort] = useState<{ key: "updatedAt" | "status"; direction: "ascending" | "descending" }>({ key: "updatedAt", direction: "descending" });
  const [hiddenEdges, setHiddenEdges] = useState({ above: false, below: false });
  const updateHiddenEdges = useCallback(() => {
    const list = listRef.current;
    if (list === null) return;
    const next = { above: list.scrollTop > 1, below: list.scrollTop + list.clientHeight < list.scrollHeight - 1 };
    setHiddenEdges(current => current.above === next.above && current.below === next.below ? current : next);
  }, []);

  const load = useCallback(async (filters: IncidentListQuery, after: string | null) => {
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    const sequence = ++requestRef.current.sequence;
    requestRef.current.controller = controller;
    setLoadState("loading");
    if (after === null) {
      setLoaded([]);
      setCursor(null);
      if (listRef.current) listRef.current.scrollTop = 0;
    }
    const result = await fetchIncidentsFromBrowser(after, filters, controller.signal);
    if (controller.signal.aborted || sequence !== requestRef.current.sequence) return;
    if (!result.ok) { setLoadState("failed"); return; }
    setLoaded(current => after === null ? result.data.items : [
      ...current, ...result.data.items.filter(item => !current.some(known => known.id === item.id)),
    ]);
    setCursor(result.data.nextCursor);
    setLoadState("idle");
  }, []);

  const initialProps = useRef({ incidents, nextCursor });
  useEffect(() => {
    function refresh() {
      if (initialProps.current.incidents === incidents && initialProps.current.nextCursor === nextCursor) return;
      initialProps.current = { incidents, nextCursor };
      if (Object.values(queryRef.current).some(Boolean)) {
        void load(queryRef.current, null);
      } else {
        requestRef.current.controller?.abort();
        ++requestRef.current.sequence;
        setLoaded(incidents);
        setCursor(nextCursor);
        setLoadState("idle");
        if (listRef.current) listRef.current.scrollTop = 0;
      }
    }
    refresh();
  }, [incidents, nextCursor, load]);

  useEffect(() => () => requestRef.current.controller?.abort(), []);

  const sorted = [...loaded].sort((left, right) => {
    const updated = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
    const primary = sort.key === "updatedAt" ? updated : incidentStatusLabel(left.status).localeCompare(incidentStatusLabel(right.status), "zh-CN");
    return (sort.direction === "ascending" ? primary : -primary) || -updated || left.id.localeCompare(right.id);
  });
  useLayoutEffect(() => {
    const list = listRef.current;
    const table = tableRef.current;
    if (!list || !table) return;
    const measure = () => {
      list.parentElement?.style.setProperty("--incident-table-header-height", `${table.tHead?.getBoundingClientRect().height ?? 0}px`);
      const tenth = table.tBodies[0]?.rows[9];
      list.style.maxHeight = window.innerWidth > 620 && tenth
        ? `${tenth.getBoundingClientRect().bottom - table.getBoundingClientRect().top}px` : "none";
      updateHiddenEdges();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    measure();
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [loaded, sort, updateHiddenEdges]);

  function changeFilter(key: keyof IncidentListQuery, value: string) {
    const next = { ...queryRef.current, [key]: value || undefined };
    queryRef.current = next;
    setQuery(next);
    void load(next, null);
  }

  return <>
    <div className="incident-list-filter" role="group" aria-label="服务端筛选 Incident">
      {([
        { key: "alertId", label: "告警类型", options: [{ value: "", label: "全部类型" }, ...alertTypes.map(option => ({ value: option.alertId, label: option.displayName }))] },
        { key: "lifecycleStatus", label: "生命周期", options: [{ value: "", label: "全部生命周期" }, { value: "OPEN", label: "未关闭" }, { value: "CLOSED", label: "已关闭" }, { value: "UNDETERMINED", label: "历史未判定" }] },
        { key: "alertState", label: "当前告警", options: [{ value: "", label: "全部当前告警" }, ...["FIRING", "PENDING", "CLEAR", "UNKNOWN"].map(value => ({ value, label: value }))] },
        { key: "status", label: "处理状态", options: [{ value: "", label: "全部处理状态" }, ...Object.entries(INCIDENT_STATUS_LABELS).map(([value, label]) => ({ value, label }))] },
      ] satisfies { key: keyof IncidentListQuery; label: string; options: { value: string; label: string }[] }[]).map(filter => <div className="incident-list-filter__field" key={filter.key}>
        <label id={`incident-filter-${filter.key}-label`} htmlFor={`incident-filter-${filter.key}`}>{filter.label}</label>
        <ChoiceDropdown id={`incident-filter-${filter.key}`} labelId={`incident-filter-${filter.key}-label`}
          disabled={false} value={query[filter.key] ?? ""} options={filter.options}
          onChange={value => changeFilter(filter.key, value)} />
      </div>)}
      <p className="incident-list-filter__summary" role="status">已加载 {loaded.length} 条{cursor === null ? "" : "，还有匹配记录可加载"}</p>
    </div>
    <div className="incident-list-sort" role="group" aria-label="Incident 排序">
      <span>已加载列表排序</span>
      {([["updatedAt", "更新时间"], ["status", "处理状态"]] as const).map(([key, label]) => <button key={key} className="incident-list-sort__button" type="button" aria-pressed={sort.key === key}
        aria-label={`按${label}${sort.key === key && sort.direction === "descending" ? "升序" : "降序"}排列`}
        onClick={() => { setSort(current => ({ key, direction: current.key === key && current.direction === "descending" ? "ascending" : "descending" })); if (listRef.current) listRef.current.scrollTop = 0; }}>
        {label}<UiIcon name={sort.key === key && sort.direction === "ascending" ? "arrow-up" : "arrow-down"} />
      </button>)}
    </div>
    <p className="incident-list-note">历史记录的更新时间可能包含通知刷新。</p>
    {loaded.length === 0 ? <p className="empty-state" role="status">{loadState === "loading" ? "正在查询…" : loadState === "failed" ? "查询未完成。" : "没有符合条件的 Incident。可修改筛选条件，未归属通知见运行监控。"}</p> : null}
    <div className="incident-list-frame" data-hidden-above={hiddenEdges.above} data-hidden-below={hiddenEdges.below}>
      <span aria-hidden="true" className="incident-list__overflow-cue incident-list__overflow-cue--top"><UiIcon name="arrow-up" />上方还有 Incident</span>
      <div key={[query.alertId, query.lifecycleStatus, query.alertState, query.status].join(":")} className="incident-list" onScroll={updateHiddenEdges} ref={listRef} tabIndex={0} role="region" aria-label="Incident 记录" aria-busy={loadState === "loading"}>
        <table className="incident-table" ref={tableRef}>
          <thead><tr>
            <th id="incident-column-name" scope="col">Incident / 类型</th><th scope="col">Kubernetes 目标</th>
            <th scope="col">生命周期</th><th scope="col">当前告警</th>
            <th id="incident-column-status" scope="col" aria-sort={sort.key === "status" ? sort.direction : "none"}>处理进度</th>
            <th id="incident-column-updated" scope="col" aria-sort={sort.key === "updatedAt" ? sort.direction : "none"}>更新时间</th>
          </tr></thead>
          <tbody>{sorted.map(incident => <tr key={incident.id}>
            <td data-label="Incident / 类型" headers="incident-column-name"><Link className="incident-list__link" href={`/incidents/${incident.id}`} aria-label={`${incident.displayName}，查看 Incident 详情`}>{incident.displayName}</Link>
              <span className="incident-list__types" title={incident.alertIds.map(id => alertTypes.find(option => option.alertId === id)?.displayName ?? id).join("、")}>
                {incident.alertIds.length === 0 ? "未登记类型" : incident.alertIds.slice(0, 2).map(id => alertTypes.find(option => option.alertId === id)?.displayName ?? id).join(" · ")}
                {incident.alertIds.length > 2 ? ` · 另 ${incident.alertIds.length - 2} 类` : ""}
              </span>
            </td>
            <td data-label="Kubernetes 目标" className="incident-list__target">{targetLabel(incident.target)}</td>
            <td data-label="生命周期">{lifecycleLabel(incident.lifecycleStatus)}</td>
            <td data-label="当前告警"><CurrentAlertBadge state={incident.alertSummary.state} /></td>
            <td data-label="处理进度"><IncidentStatusBadge status={incident.status} /><span className="incident-list__run">{incident.latestRun === null ? "尚无 Run" : `第 ${incident.latestRun.attempt} 次${incident.latestRun.kind === "repair" ? "修复" : "诊断"} · ${runStatusLabel(incident.latestRun.status)}`}</span></td>
            <td data-label="更新时间" className="incident-list__time"><LocalTimestamp timestamp={incident.updatedAt} /></td>
          </tr>)}</tbody>
        </table>
      </div>
      <span aria-hidden="true" className="incident-list__overflow-cue incident-list__overflow-cue--bottom"><UiIcon name="arrow-down" />下方还有 Incident</span>
    </div>
    {loadState === "failed" ? <p className="incident-list-error" role="alert">暂时无法加载记录。<button className="incident-list-more__button" type="button" onClick={() => void load(queryRef.current, cursor)}>重试查询</button></p> : null}
    {cursor === null ? null : <div className="incident-list-more"><button type="button" className="incident-list-more__button" onClick={() => void load(queryRef.current, cursor)} disabled={loadState === "loading"}>{loadState === "loading" ? "正在加载…" : "加载更早记录"}</button></div>}
  </>;
}
