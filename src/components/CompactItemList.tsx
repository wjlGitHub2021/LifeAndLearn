"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./CompactItemList.module.css";

export type CompactItemEntry = {
  id: string;
  kind: "quick" | "agent";
  title: string;
  lifecycle: "open" | "completed" | "archived";
  status: string;
  nextAction: string;
  plannedDate: string | null;
  dueDate: string | null;
  updatedAt: string;
  needsAttention: boolean;
};

export type CompactItemListProps = {
  entries: CompactItemEntry[];
  onOpen: (kind: CompactItemEntry["kind"], id: string) => void;
  onCreate: () => void;
};

type Group = "attention" | "ongoing" | "history";
type KindFilter = "all" | CompactItemEntry["kind"];
type DateFilter = "all" | "planned" | "unplanned" | "overdue";
const PAGE_SIZE = 10;
const groupLabels: Record<Group, string> = { attention: "待我处理", ongoing: "进行中", history: "历史" };

function actionLabel(entry: CompactItemEntry) {
  if (entry.lifecycle !== "open") return "查看历史";
  return entry.needsAttention ? "前往处理" : "打开事项";
}

function statusLabel(entry: CompactItemEntry) {
  if (entry.lifecycle === "completed") return "已完成";
  if (entry.lifecycle === "archived") return "已归档";
  return entry.needsAttention ? "待你处理" : "进行中";
}

function sortCurrent(a: CompactItemEntry, b: CompactItemEntry) {
  const aDate = [a.plannedDate, a.dueDate].filter((date): date is string => !!date).sort()[0] || "9999-12-31";
  const bDate = [b.plannedDate, b.dueDate].filter((date): date is string => !!date).sort()[0] || "9999-12-31";
  return aDate.localeCompare(bDate) || b.updatedAt.localeCompare(a.updatedAt);
}

function todayKey() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}

export default function CompactItemList({ entries, onOpen, onCreate }: CompactItemListProps) {
  const [group, setGroup] = useState<Group>("attention");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [date, setDate] = useState<DateFilter>("all");
  const [page, setPage] = useState(1);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const pageStatusRef = useRef<HTMLSpanElement>(null);
  const focusPageStatus = useRef(false);
  const search = query.trim().toLocaleLowerCase();
  const today = todayKey();
  const filtered = entries.filter(entry => {
    if (kind !== "all" && entry.kind !== kind) return false;
    if (date === "planned" && !entry.plannedDate) return false;
    if (date === "unplanned" && entry.plannedDate) return false;
    if (date === "overdue" && !(entry.lifecycle === "open" && entry.dueDate && entry.dueDate < today)) return false;
    return !search || [entry.title, entry.status, entry.nextAction].some(value => value.toLocaleLowerCase().includes(search));
  });
  const groups = {
    attention: filtered.filter(entry => entry.lifecycle === "open" && entry.needsAttention).sort(sortCurrent),
    ongoing: filtered.filter(entry => entry.lifecycle === "open" && !entry.needsAttention).sort(sortCurrent),
    history: filtered.filter(entry => entry.lifecycle !== "open").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
  const groupEntries = groups[group];
  const pageCount = Math.max(1, Math.ceil(groupEntries.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleEntries = groupEntries.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const selected = visibleEntries.find(entry => `${entry.kind}:${entry.id}` === selectedKey) || visibleEntries[0];
  const hasFilters = !!search || kind !== "all" || date !== "all";

  useEffect(() => setPage(current => Math.min(current, pageCount)), [pageCount]);
  useEffect(() => {
    if (!focusPageStatus.current) return;
    pageStatusRef.current?.focus();
    focusPageStatus.current = false;
  }, [currentPage, group]);

  function changeFilter() {
    focusPageStatus.current = false;
    setPage(1);
    setSelectedKey(null);
  }

  function selectGroup(next: Group) {
    changeFilter();
    setGroup(next);
  }

  function changePage(next: number) {
    focusPageStatus.current = true;
    setSelectedKey(null);
    setPage(next);
  }

  function clearFilters() {
    setQuery("");
    setKind("all");
    setDate("all");
    changeFilter();
  }

  return (
    <section className={styles.root} aria-label="我的事项列表">
      <div className={styles.toolbar}>
        <label className={styles.searchLabel}>搜索事项
          <input type="search" value={query} onChange={event => { setQuery(event.target.value); changeFilter(); }} placeholder="搜索事项或下一步" />
        </label>
        <label className={styles.filterLabel}>参与方式
          <select value={kind} onChange={event => { setKind(event.target.value as KindFilter); changeFilter(); }}>
            <option value="all">全部方式</option>
            <option value="quick">预设 Agent</option>
            <option value="agent">自选 Agent</option>
          </select>
        </label>
        <label className={styles.filterLabel}>日期状态
          <select value={date} onChange={event => { setDate(event.target.value as DateFilter); changeFilter(); }}>
            <option value="all">全部日期</option>
            <option value="planned">已安排计划日</option>
            <option value="unplanned">未安排计划日</option>
            <option value="overdue">已过截止日</option>
          </select>
        </label>
        {hasFilters && <button className={styles.clearButton} type="button" onClick={clearFilters}>清除筛选</button>}
      </div>

      <div className={styles.groups} role="group" aria-label="事项分组">
        {(["attention", "ongoing", "history"] as const).map(key => (
          <button key={key} type="button" className={`${styles.groupButton} ${group === key ? styles.selected : ""}`} aria-pressed={group === key} onClick={() => selectGroup(key)}>
            {groupLabels[key]} <span className={styles.count}>{groups[key].length}</span>
          </button>
        ))}
      </div>

      {entries.length === 0 ? (
        <div className={styles.empty} role="status"><p>还没有事项。写下一件想推进的事，之后可以在这里找回。</p><button type="button" onClick={onCreate}>新建一件事 →</button></div>
      ) : filtered.length === 0 ? (
        <div className={styles.empty} role="status"><p>没有符合当前搜索和筛选条件的事项。</p><button type="button" onClick={clearFilters}>清除筛选，查看全部事项</button></div>
      ) : groupEntries.length === 0 ? (
        <div className={styles.empty} role="status"><p>{group === "attention" ? "当前没有需要你处理的事项。" : group === "ongoing" ? "当前没有其他进行中的事项。" : "当前没有已完成或归档事项。"}</p>{group === "attention" && groups.ongoing.length > 0 && <button type="button" onClick={() => selectGroup("ongoing")}>查看 {groups.ongoing.length} 件进行中事项 →</button>}</div>
      ) : (
        <div className={styles.workspace}>
          <div className={styles.listColumn}>
            <p className={styles.resultCount} role="status">{groupLabels[group]} · {groupEntries.length} 件{groupEntries.length > PAGE_SIZE ? ` · 第 ${currentPage} / ${pageCount} 页` : ""}</p>
            <ul className={styles.list} aria-label={`${groupLabels[group]}事项`}>
              {visibleEntries.map(entry => (
                <li className={styles.item} key={`${entry.kind}:${entry.id}`}>
                  <button className={styles.previewButton} type="button" aria-pressed={selected?.id === entry.id && selected.kind === entry.kind} aria-controls="item-preview" onClick={() => {
                    if (window.matchMedia("(max-width: 900px)").matches) onOpen(entry.kind, entry.id);
                    else setSelectedKey(`${entry.kind}:${entry.id}`);
                  }}>
                    <span className={styles.badges}><span className={styles.kind}>{entry.kind === "quick" ? "预设 Agent" : "自选 Agent"}</span><span className={styles.status}>{statusLabel(entry)}</span></span>
                    <span className={styles.title} title={entry.title}>{entry.title}</span>
                    <span className={styles.next}>{entry.lifecycle === "open" ? entry.nextAction || "打开事项查看进展" : "查看已保存的事项记录"}</span>
                    <span className={styles.dates}>计划 {entry.plannedDate || "未安排"} · 截止 {entry.dueDate || "未设置"}</span>
                    <span className={styles.rowAction}>{actionLabel(entry)} →</span>
                  </button>
                </li>
              ))}
            </ul>
            {groupEntries.length > PAGE_SIZE && (
              <nav className={styles.pagination} aria-label={`${groupLabels[group]}分页`}>
                <button type="button" disabled={currentPage === 1} onClick={() => changePage(currentPage - 1)}>上一页</button>
                <span ref={pageStatusRef} tabIndex={-1} role="status">第 {currentPage} / {pageCount} 页</span>
                <button type="button" disabled={currentPage === pageCount} onClick={() => changePage(currentPage + 1)}>下一页</button>
              </nav>
            )}
          </div>
          <aside id="item-preview" className={styles.preview} aria-label="事项预览">
            <div className={styles.previewHead}><span className={styles.kind}>{selected.kind === "quick" ? "预设 Agent" : "自选 Agent"}</span><span className={styles.status}>{statusLabel(selected)}</span></div>
            <h2 title={selected.title}>{selected.title}</h2>
            <div className={styles.previewSection}><strong>{selected.lifecycle === "open" ? "下一步" : "事项记录"}</strong><p>{selected.lifecycle === "open" ? selected.nextAction || "打开事项查看进展" : "此事项已结束，可打开查看成果与历史。"}</p></div>
            <dl className={styles.meta}><div><dt>计划处理日</dt><dd>{selected.plannedDate || "未安排"}</dd></div><div><dt>截止日</dt><dd>{selected.dueDate || "未设置"}</dd></div><div><dt>当前状态</dt><dd>{statusLabel(selected)}</dd></div></dl>
            <button className={styles.openButton} type="button" onClick={() => onOpen(selected.kind, selected.id)}>{actionLabel(selected)} →</button>
          </aside>
        </div>
      )}
    </section>
  );
}
