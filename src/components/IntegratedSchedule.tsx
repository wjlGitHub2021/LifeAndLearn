"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import styles from "./IntegratedSchedule.module.css";

export type IntegratedScheduleEntry = {
  id: string;
  kind: "quick" | "agent";
  title: string;
  plannedDate: string | null;
  dueDate: string | null;
  lifecycle: "open" | "completed" | "archived";
  status: string;
};

export type IntegratedScheduleProps = {
  entries: IntegratedScheduleEntry[];
  onOpen: (kind: IntegratedScheduleEntry["kind"], id: string) => void;
  todayKey: string;
  renderScheduleEditor?: (entry: IntegratedScheduleEntry) => ReactNode;
  defaultMode?: "week" | "month";
};

type CalendarMode = "week" | "month";
type AgendaMode = "day" | "unplanned" | "overdue";
const weekdays = ["一", "二", "三", "四", "五", "六", "日"];

function localDate(year: number, monthIndex: number, day: number): Date {
  const date = new Date(2000, 0, 1, 12);
  date.setFullYear(year, monthIndex, day);
  return date;
}

function dateFromKey(key: string | null): Date | null {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const [year, month, day] = key.split("-").map(Number);
  const date = localDate(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function dateKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(key: string, days: number): string {
  const date = dateFromKey(key)!;
  return dateKey(localDate(date.getFullYear(), date.getMonth(), date.getDate() + days));
}

function shiftMonth(key: string, months: number): string {
  const current = dateFromKey(key)!;
  const target = localDate(current.getFullYear(), current.getMonth() + months, 1);
  const lastDay = localDate(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return dateKey(localDate(target.getFullYear(), target.getMonth(), Math.min(current.getDate(), lastDay)));
}

function weekStart(key: string): string {
  const date = dateFromKey(key)!;
  return addDays(key, -((date.getDay() + 6) % 7));
}

function dayKeys(start: string, length: number): string[] {
  return Array.from({ length }, (_, index) => addDays(start, index));
}

function monthKeys(key: string): { period: string[]; grid: string[] } {
  const current = dateFromKey(key)!;
  const first = dateKey(localDate(current.getFullYear(), current.getMonth(), 1));
  const count = localDate(current.getFullYear(), current.getMonth() + 1, 0).getDate();
  const period = dayKeys(first, count);
  const gridStart = weekStart(first);
  const offset = (dateFromKey(first)!.getDay() + 6) % 7;
  const gridLength = Math.ceil((offset + count) / 7) * 7;
  return { period, grid: dayKeys(gridStart, gridLength) };
}

function dateLabel(key: string): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(dateFromKey(key)!);
}

function ItemRow({ entry, todayKey, onOpen, renderScheduleEditor }: { entry: IntegratedScheduleEntry; todayKey: string; onOpen: IntegratedScheduleProps["onOpen"]; renderScheduleEditor?: IntegratedScheduleProps["renderScheduleEditor"] }) {
  const overdue = entry.lifecycle === "open" && !!entry.dueDate && entry.dueDate < todayKey;
  return <li className={styles.item}>
    <div className={styles.itemText}>
      <strong>{entry.title}</strong>
      <span>{entry.kind === "quick" ? "快捷事项" : "Agent 事项"} · {entry.lifecycle === "completed" ? "已完成" : entry.status}{overdue ? " · 截止已逾期" : ""}</span>
      {!renderScheduleEditor && <span>计划日：{entry.plannedDate || "未安排"} · 截止日：{entry.dueDate || "未设置"}</span>}
    </div>
    <button type="button" aria-label={`打开事项：${entry.title}`} onClick={() => onOpen(entry.kind, entry.id)}>打开</button>
    {renderScheduleEditor && <div className={styles.itemEditor}>{renderScheduleEditor(entry)}</div>}
  </li>;
}

export default function IntegratedSchedule({ entries, onOpen, todayKey, renderScheduleEditor, defaultMode = "week" }: IntegratedScheduleProps) {
  const [mode, setMode] = useState<CalendarMode>(defaultMode);
  const [agendaMode, setAgendaMode] = useState<AgendaMode>("day");
  const [anchorKey, setAnchorKey] = useState(todayKey);
  const [selectedKey, setSelectedKey] = useState(todayKey);
  const [donutFilter, setDonutFilter] = useState<"scheduled" | "unscheduled" | null>(null);
  const previousToday = useRef(todayKey);
  const selectedHeadingRef = useRef<HTMLHeadingElement>(null);
  const selectedHeadingId = useId();
  const drilldownId = useId();

  useEffect(() => { setMode(defaultMode); }, [defaultMode]);

  useEffect(() => {
    if (!dateFromKey(todayKey)) return;
    const previous = previousToday.current;
    previousToday.current = todayKey;
    setAnchorKey(current => current === previous ? todayKey : current);
    setSelectedKey(current => current === previous ? todayKey : current);
  }, [todayKey]);

  const usableAnchor = dateFromKey(anchorKey) ? anchorKey : dateFromKey(todayKey) ? todayKey : null;
  if (!usableAnchor) return <section className={styles.root} role={todayKey ? "alert" : "status"}>{todayKey ? "当前日期不可用，请刷新页面。" : "正在读取本机日期…"}</section>;
  const currentAnchor: string = usableAnchor;

  const week = dayKeys(weekStart(usableAnchor), 7);
  const month = monthKeys(usableAnchor);
  const periodKeys = mode === "week" ? week : month.period;
  const calendarKeys = mode === "week" ? week : month.grid;
  const activeMonth = usableAnchor.slice(0, 7);
  const planned = entries.filter(entry => entry.lifecycle !== "archived" && !!dateFromKey(entry.plannedDate));
  const plannedByDay = new Map<string, IntegratedScheduleEntry[]>();
  for (const entry of planned) {
    const key = entry.plannedDate!;
    const existing = plannedByDay.get(key) || [];
    existing.push(entry);
    plannedByDay.set(key, existing);
  }
  const activeKey = dateFromKey(selectedKey) && calendarKeys.includes(selectedKey) ? selectedKey : usableAnchor;
  const selectedEntries = [...(plannedByDay.get(activeKey) || [])].sort((a, b) => Number(a.lifecycle === "completed") - Number(b.lifecycle === "completed"));
  const openEntries = entries.filter(entry => entry.lifecycle === "open");
  const scheduledOpen = openEntries.filter(entry => !!dateFromKey(entry.plannedDate)).length;
  const unscheduledOpen = openEntries.length - scheduledOpen;
  const scheduledPercent = openEntries.length ? Math.round(scheduledOpen / openEntries.length * 100) : 0;
  const unscheduledPercent = openEntries.length ? 100 - scheduledPercent : 0;
  const unplanned = openEntries.filter(entry => !dateFromKey(entry.plannedDate));
  const overdue = openEntries.filter(entry => !!entry.dueDate && entry.dueDate < todayKey)
    .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));
  const drilledEntries = donutFilter === "scheduled" ? openEntries.filter(entry => !!dateFromKey(entry.plannedDate)) : donutFilter === "unscheduled" ? unplanned : [];
  const periodCounts = periodKeys.map(key => ({ key, count: plannedByDay.get(key)?.length || 0 }));
  const maxCount = Math.max(1, ...periodCounts.map(entry => entry.count));
  const periodTotal = periodCounts.reduce((sum, entry) => sum + entry.count, 0);
  const periodTitle = mode === "week" ? `${week[0]} 至 ${week[6]}` : `${dateFromKey(usableAnchor)!.getFullYear()} 年 ${dateFromKey(usableAnchor)!.getMonth() + 1} 月`;
  const agendaEntries = agendaMode === "day" ? selectedEntries : agendaMode === "unplanned" ? unplanned : overdue;
  const agendaTitle = agendaMode === "day" ? dateLabel(activeKey) : agendaMode === "unplanned" ? "未安排处理日" : "截止日已逾期";

  function movePeriod(direction: -1 | 1) {
    const next = mode === "week" ? addDays(currentAnchor, direction * 7) : shiftMonth(currentAnchor, direction);
    setAnchorKey(next);
    setSelectedKey(next);
  }

  function selectDay(key: string, reveal = false) {
    setSelectedKey(key);
    setAgendaMode("day");
    if ((mode === "month" && key.slice(0, 7) !== activeMonth) || (mode === "week" && !week.includes(key))) setAnchorKey(key);
    if (reveal) requestAnimationFrame(() => {
      selectedHeadingRef.current?.focus({ preventScroll: true });
      selectedHeadingRef.current?.scrollIntoView({ block: "start" });
    });
  }

  function moveCalendarFocus(key: string, step: number) {
    const next = addDays(key, step);
    selectDay(next);
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLButtonElement>(`[data-calendar-day="${next}"]`);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  function moveBarFocus(index: number, step: number) {
    const next = periodCounts[Math.max(0, Math.min(periodCounts.length - 1, index + step))]?.key;
    if (!next) return;
    setSelectedKey(next);
    setAgendaMode("day");
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-bar-day="${next}"]`)?.focus());
  }

  function showAgenda(next: AgendaMode) {
    setAgendaMode(next);
    requestAnimationFrame(() => {
      selectedHeadingRef.current?.focus({ preventScroll: true });
      selectedHeadingRef.current?.scrollIntoView({ block: "start" });
    });
  }

  return <section className={styles.root} aria-label="日程与事项数据">
    <div className={styles.header}>
      <h1>日程与数据</h1>
      <div className={styles.modeSwitch} role="group" aria-label="日历范围">
        <button type="button" aria-pressed={mode === "week"} onClick={() => setMode("week")}>周</button>
        <button type="button" aria-pressed={mode === "month"} onClick={() => setMode("month")}>月</button>
      </div>
      <p>按计划日查看站内事项；截止日只提示，不自动排期。</p>
    </div>
    <div className={styles.summary} aria-label="日程摘要">
      <div className={styles.summaryCard}><span>所选{mode === "week" ? "周" : "月"}安排</span><strong>{periodTotal}</strong><small>件未归档，含已完成</small></div>
      <button type="button" className={styles.summaryCard} onClick={() => showAgenda("unplanned")}><span>尚未安排</span><strong>{unplanned.length}</strong><small>件进行中 · 点此安排</small></button>
      <button type="button" className={styles.summaryCard} onClick={() => showAgenda("overdue")}><span>截止已逾期</span><strong>{overdue.length}</strong><small>件进行中 · 点此查看</small></button>
    </div>
    <div className={styles.periodControls}>
      <button type="button" onClick={() => movePeriod(-1)} aria-label={`上一${mode === "week" ? "周" : "月"}`}>← 上一{mode === "week" ? "周" : "月"}</button>
      <strong aria-live="polite">{periodTitle}</strong>
      <button type="button" onClick={() => { setAnchorKey(todayKey); setSelectedKey(todayKey); setAgendaMode("day"); }} disabled={!dateFromKey(todayKey)}>回到今天</button>
      <button type="button" onClick={() => movePeriod(1)} aria-label={`下一${mode === "week" ? "周" : "月"}`}>下一{mode === "week" ? "周" : "月"} →</button>
    </div>
    <div className={styles.body}>
      <div className={styles.calendarPanel}>
        <div className={styles.calendarIntro}><strong>{mode === "week" ? "周计划" : "月概览"}</strong><span>点选日期查看事项与排期</span></div>
        <div className={`${styles.calendar} ${mode === "week" ? styles.weekCalendar : styles.monthCalendar}`} role="group" aria-label={`${periodTitle}日历，Tab 进入日期后可用方向键切换`}>
          {weekdays.map(day => <span className={styles.weekday} key={day} aria-hidden="true">{day}</span>)}
          {calendarKeys.map((key, index) => {
            const date = dateFromKey(key)!;
            const dayEntries = plannedByDay.get(key) || [];
            return <button key={key} type="button" data-calendar-day={key} tabIndex={key === activeKey ? 0 : -1} className={`${styles.day} ${mode === "month" && key.slice(0, 7) !== activeMonth ? styles.outside : ""}`} aria-label={`${dateLabel(key)}，计划 ${dayEntries.length} 件事项`} aria-pressed={key === activeKey} aria-current={key === todayKey ? "date" : undefined} onClick={() => selectDay(key)} onKeyDown={event => { const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "ArrowDown" ? mode === "month" ? 7 : null : event.key === "ArrowUp" ? mode === "month" ? -7 : null : null; if (step !== null) { event.preventDefault(); moveCalendarFocus(key, step); } }}>
              <span className={styles.dayWeekday}>{weekdays[index % 7]}</span><span className={styles.dayNumber}>{date.getDate()}</span><span className={styles.dayCount}>{dayEntries.length ? `${dayEntries.length} 件` : "—"}</span>
            </button>;
          })}
        </div>
        <p className={styles.calendarFootnote}>计划日是你打算处理的日期，不代表已占用具体时段；改期不会启动 Agent。</p>
      </div>
      <aside className={styles.agendaPanel} aria-label="所选日期与待安排事项">
        <div className={styles.agendaTabs} role="group" aria-label="事项范围">
          <button type="button" aria-pressed={agendaMode === "day"} onClick={() => setAgendaMode("day")}>所选日</button>
          <button type="button" aria-pressed={agendaMode === "unplanned"} onClick={() => setAgendaMode("unplanned")}>未安排 {unplanned.length}</button>
          <button type="button" aria-pressed={agendaMode === "overdue"} onClick={() => setAgendaMode("overdue")}>逾期 {overdue.length}</button>
        </div>
        <section className={styles.selected} aria-labelledby={selectedHeadingId}>
          <div className={styles.sectionHeading}><h2 id={selectedHeadingId} ref={selectedHeadingRef} tabIndex={-1}>{agendaTitle}</h2><span>{agendaEntries.length} 件</span></div>
          {agendaMode === "unplanned" && <p className={styles.agendaNote}>只填截止日的事项也在这里；请选择计划处理日。</p>}
          {agendaMode === "overdue" && <p className={styles.agendaNote}>仅按截止日提示，不会自动重排或启动 Agent。</p>}
          {agendaEntries.length ? <ul className={styles.items}>{agendaEntries.map(entry => <ItemRow key={`${entry.kind}:${entry.id}`} entry={entry} todayKey={todayKey} onOpen={onOpen} renderScheduleEditor={renderScheduleEditor} />)}</ul> : <p className={styles.empty}>{agendaMode === "day" ? "这一天没有计划事项。可从未安排列表选一件事来安排。" : agendaMode === "unplanned" ? "没有未安排的进行中事项。" : "没有截止日已逾期的进行中事项。"}</p>}
        </section>
      </aside>
    </div>
    <details className={styles.dataDetails}>
      <summary><span>查看数据与分布</span><small>计划覆盖与所选周期件数，均可查看对应事项</small></summary>
      <div className={styles.insights}>
        <section className={styles.chartCard} aria-label="全部进行中事项排期占比">
          <h2>进行中事项排期</h2>
          <p>全部进行中事项 · 不含已完成和已归档</p>
          {openEntries.length ? <>
            <div className={styles.donutRow}>
              <div className={styles.donut} role="img" aria-label={`已安排 ${scheduledOpen} 件，占 ${scheduledPercent}%；未安排 ${unscheduledOpen} 件，占 ${unscheduledPercent}%`} style={{ background: `conic-gradient(var(--strong) 0 ${scheduledPercent}%, var(--muted) ${scheduledPercent}% 100%)` }}><span>{openEntries.length}<small>件进行中</small></span></div>
              <ul className={styles.legend}>
                <li><button type="button" aria-controls={donutFilter ? drilldownId : undefined} aria-pressed={donutFilter === "scheduled"} disabled={!scheduledOpen} onClick={() => setDonutFilter(current => current === "scheduled" ? null : "scheduled")}><span className={styles.scheduledSwatch} />已安排 {scheduledOpen} 件 · {scheduledPercent}%</button></li>
                <li><button type="button" aria-controls={donutFilter ? drilldownId : undefined} aria-pressed={donutFilter === "unscheduled"} disabled={!unscheduledOpen} onClick={() => setDonutFilter(current => current === "unscheduled" ? null : "unscheduled")}><span className={styles.unplannedSwatch} />未安排 {unscheduledOpen} 件 · {unscheduledPercent}%</button></li>
              </ul>
            </div>
            {donutFilter && <div className={styles.drilldown} id={drilldownId}>
              <div className={styles.sectionHeading}><h3>{donutFilter === "scheduled" ? "已安排" : "未安排"} · {drilledEntries.length} 件进行中事项</h3><button type="button" onClick={() => setDonutFilter(null)}>清除筛选</button></div>
              <ul className={styles.items}>{drilledEntries.map(entry => <ItemRow key={`${entry.kind}:${entry.id}`} entry={entry} todayKey={todayKey} onOpen={onOpen} />)}</ul>
            </div>}
          </> : <p className={styles.empty}>暂无进行中事项；有事项后才显示占比。</p>}
        </section>
        <section className={styles.chartCard} aria-label={`${periodTitle}每日计划件数`}>
          <h2>所选{mode === "week" ? "周" : "月"}每日计划件数</h2>
          <p>{periodTitle} · 共 {periodTotal} 件未归档事项，按计划日计数</p>
          {!periodTotal && <p className={styles.empty}>所选周期没有计划事项。</p>}
          {mode === "month" && <p className={styles.scrollHint}>左右滑动查看整月；也可展开下方文字数据。</p>}
          <div className={styles.barScroll}>
            <div className={styles.bars} style={{ gridTemplateColumns: `repeat(${periodCounts.length}, minmax(${mode === "month" ? 20 : 32}px, 1fr))`, minWidth: mode === "month" ? `${periodCounts.length * 22}px` : undefined }}>
              {periodCounts.map(({ key, count }, index) => <button key={key} type="button" data-bar-day={key} tabIndex={key === activeKey ? 0 : -1} className={styles.barDay} aria-label={`${dateLabel(key)}计划 ${count} 件事项；方向键切换日期，按回车查看事项`} aria-pressed={key === activeKey} onClick={() => selectDay(key, true)} onKeyDown={event => { const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : null; if (step !== null) { event.preventDefault(); moveBarFocus(index, step); } }}><span className={styles.barValue}>{count}</span><span className={styles.barTrack}><span className={styles.bar} style={{ height: `${count ? Math.max(8, Math.round(count / maxCount * 72)) : 0}px` }} /></span><span className={styles.barLabel}>{dateFromKey(key)!.getDate()}</span></button>)}
            </div>
          </div>
          <details className={styles.dataTable}><summary>查看每日文字数据</summary><ol>{periodCounts.map(({ key, count }) => <li key={key}>{key}：{count} 件</li>)}</ol></details>
        </section>
      </div>
    </details>
  </section>;
}
