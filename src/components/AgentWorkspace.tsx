"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import RichText, { MarkdownPreview } from "./RichText";
import RunLivePreview from "./RunLivePreview";
import { modelReadyForAgent, type ModelConnectionStatus } from "./ModelConnectionsPanel";
import ItemModelPicker, { parseItemModelSelection } from "./ItemModelPicker";
import type { ItemModelSelection } from "./ModelConnectionsPanel";
import type { AgentMetricDetailResponse, AgentMetricEvent, AgentMetricEventIds, AgentMetricEventSummary, AgentMetricName, AgentMetricsResponse, AgentTrendBucket, AgentTrendDays, AgentTrendResponse } from "../lib/agent-metrics";

type Profile = { id: string; name: string; instructions: string; deliverable: string; allow_material: number; allow_upstream: number; enabled: number; revision: number; template: string | null };
type Step = { agentId: string; upstream: number[]; source?: boolean };
type Job = { id: string; request: string; material: string; steps_json: string; revision: number; status: string; lifecycle: string; source_job_id: string | null; source_artifact_id: string | null; source_artifact_version: number | null; target_label: string; planned_date: string | null; due_date: string | null; schedule_revision: number; model_choice_json: string; model_revision: number; created_at: string; updated_at: string };
type Artifact = { id: string; job_id: string; step_index: number; agent_id: string; version: number; content: string; config_json: string; upstream_json: string; accepted_at: string | null; created_at: string };
type Run = { id: string; job_id: string; step_index: number; agent_id: string; status: string; model: string; context_json: string; error: string | null; created_at: string };
type Preference = { id: string; agent_id: string; text: string; active: number };
export type AgentState = { profiles: Profile[]; jobs: Job[]; current: Record<string, (string | null)[]>; artifacts: Artifact[]; runs: Run[]; corrections: { id: string; job_id: string; text: string; revision: number; active: number }[]; preferences: Preference[] };
type ProfileDraft = { name: string; instructions: string; deliverable: string; allowMaterial: boolean; allowUpstream: boolean; id: string; revision: number };
type RunContext = { request?: string; material?: string | null; corrections?: { text: string }[]; preferences?: { text: string }[]; upstream?: { id?: string; stepIndex: number; version: number; content: string }[]; agentName?: string; instructions?: string; deliverable?: string };
type SourceDraft = { jobId: string; artifactId: string; version: number; revision: number };
const emptyProfile = (): ProfileDraft => ({ name: "", instructions: "", deliverable: "", allowMaterial: true, allowUpstream: true, id: "", revision: 0 });
function profileDraft(profile: Profile): ProfileDraft { return { id: profile.id, revision: profile.revision, name: profile.name, instructions: profile.instructions, deliverable: profile.deliverable, allowMaterial: !!profile.allow_material, allowUpstream: !!profile.allow_upstream }; }
function parseSteps(job: Job): Step[] { try { return JSON.parse(job.steps_json) as Step[]; } catch { return []; } }
function parseRunContext(raw: string): RunContext | null { try { return JSON.parse(raw) as RunContext; } catch { return null; } }
function artifactAgentName(artifact: Artifact) { try { const value = JSON.parse(artifact.config_json) as { name?: unknown }; return typeof value.name === "string" ? value.name : "历史 Agent"; } catch { return "历史 Agent"; } }
async function result(response: Response) { const data = await response.json(); if (!response.ok) throw new Error(data.error || "操作失败"); return data; }
const metricLabels: { key: keyof AgentMetricEventIds; label: string }[] = [
  { key: "runs", label: "启动运行" },
  { key: "successfulRuns", label: "成功运行" },
  { key: "failedRuns", label: "失败运行" },
  { key: "acceptedArtifacts", label: "已确认成果" },
];
const eventLabels: Record<AgentMetricEvent["kind"], string> = {
  run_started: "启动运行", run_succeeded: "运行成功", run_failed: "运行失败",
  run_cancelled: "运行取消", run_interrupted: "运行中断",
  artifact_created: "生成成果", artifact_accepted: "确认成果",
};
function localTime(value: string) {
  const date = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(" ", "T")}Z` : value);
  return Number.isNaN(date.getTime()) ? "时间不可用" : date.toLocaleString();
}
function trendTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间不可用" : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    fractionalSecondDigits: 3, timeZoneName: "short", hourCycle: "h23",
  }).format(date);
}
function MetricEventRow({ event, onOpenJob }: { event: AgentMetricEvent; onOpenJob: (id: string) => void }) {
  return <div className="wb2-event" id={`agent-event-${event.id}`}>
    <div className="row spread"><strong>{eventLabels[event.kind]}</strong><time dateTime={event.occurredAt}>{localTime(event.occurredAt)}</time></div>
    <p>{event.agentName} · {event.jobRequest}</p>
    {event.artifactVersion !== null && <p>成果 v{event.artifactVersion} · {event.acceptedAt ? `用户已于 ${localTime(event.acceptedAt)} 确认` : "待确认"}</p>}
    {event.errorSummary && <p role="status">{event.errorSummary}</p>}
    <div className="row"><button onClick={() => onOpenJob(event.jobId)}>打开关联事项</button>
      <details><summary>当时配置与来源</summary><p>Agent：{event.agentSnapshot.name} · 修订 {event.agentSnapshot.revision ?? "未记录"}</p><p>职责：{event.agentSnapshot.instructions || "未记录"}</p><p>交付物：{event.agentSnapshot.deliverable || "未记录"}</p><p>当时可见范围：{event.agentSnapshot.allowMaterial === null || event.agentSnapshot.allowUpstream === null ? "未完整记录" : `事项需求${event.agentSnapshot.allowMaterial ? "、事项资料" : ""}${event.agentSnapshot.allowUpstream ? "、显式上游成果" : ""}`}</p><p>运行：{event.runId?.slice(0, 8) || "无"} · 成果：{event.artifactId?.slice(0, 8) || "无"}</p><p>上游成果：{event.upstream.length ? event.upstream.map(source => `${source.id.slice(0, 8)} v${source.version}`).join("、") : "无"}</p></details>
    </div>
  </div>;
}
function MetricSummaryRow({ event, onOpenJob }: { event: AgentMetricEventSummary; onOpenJob: (id: string) => void }) {
  return <div className="wb2-event"><div className="row spread"><strong>{eventLabels[event.kind]}</strong><time dateTime={event.occurredAt}>{localTime(event.occurredAt)}</time></div><p>{event.agentName} · {event.jobRequest}</p>{event.artifactVersion !== null && <p>成果 v{event.artifactVersion} · {event.acceptedAt ? "已确认" : "待确认"}</p>}{event.errorSummary && <p role="status">{event.errorSummary}</p>}<button onClick={() => onOpenJob(event.jobId)}>打开关联事项</button></div>;
}

function TrendPanel({ visible, stateSignature, onOpenJob }: { visible: boolean; stateSignature: string; onOpenJob: (id: string) => void }) {
  const [days, setDays] = useState<AgentTrendDays>(7);
  const [metric, setMetric] = useState<AgentMetricName>("runs");
  const [trend, setTrend] = useState<AgentTrendResponse | null>(null);
  const [trendError, setTrendError] = useState("");
  const [selectedBucket, setSelectedBucket] = useState<number | null>(null);
  const [hoveredBucket, setHoveredBucket] = useState<number | null>(null);
  const [detail, setDetail] = useState<AgentTrendResponse | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const anchor = useRef<string | null>(null);
  const lastSignature = useRef(stateSignature);
  const detailSeq = useRef(0);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    if (!visible) return;
    if (lastSignature.current !== stateSignature) { anchor.current = null; lastSignature.current = stateSignature; }
    const controller = new AbortController();
    const params = new URLSearchParams({ trendDays: String(days) });
    if (anchor.current) params.set("asOf", anchor.current);
    setTrend(null); setTrendError(""); setSelectedBucket(null); setHoveredBucket(null);
    fetch(`/api/agent-metrics?${params}`, { cache: "no-store", signal: controller.signal }).then(result).then(data => {
      if (controller.signal.aborted) return;
      const next = data as AgentTrendResponse;
      anchor.current = next.asOf;
      setTrend(next);
    }).catch(error => {
      if (!controller.signal.aborted) setTrendError(error instanceof Error ? error.message : "趋势读取失败");
    });
    return () => controller.abort();
  }, [visible, stateSignature, days, refreshKey]);
  const loadDetail = useCallback(async (source: AgentTrendResponse, bucket: number, selectedMetric: AgentMetricName, previous: AgentTrendResponse | null, seq: number) => {
    setDetailLoading(true); setDetailError("");
    const params = new URLSearchParams({ trendDays: String(source.days), bucket: String(bucket), metric: selectedMetric, asOf: previous?.pagination?.asOf || source.asOf, limit: "30" });
    if (previous?.pagination?.nextCursor) params.set("cursor", previous.pagination.nextCursor);
    try {
      const next = await result(await fetch(`/api/agent-metrics?${params}`, { cache: "no-store" })) as AgentTrendResponse;
      if (seq === detailSeq.current) setDetail(previous ? { ...next, events: [...previous.events, ...next.events] } : next);
    } catch (error) {
      if (seq === detailSeq.current) setDetailError(error instanceof Error ? error.message : "区间事件读取失败");
    } finally { if (seq === detailSeq.current) setDetailLoading(false); }
  }, []);
  useEffect(() => {
    const seq = ++detailSeq.current;
    setDetail(null); setDetailError(""); setDetailLoading(false);
    if (visible && trend && selectedBucket !== null) void loadDetail(trend, selectedBucket, metric, null, seq);
    return () => { detailSeq.current += 1; };
  }, [visible, trend, selectedBucket, metric, loadDetail]);
  const buckets = trend?.buckets || [];
  const activeIndex = hoveredBucket ?? selectedBucket ?? buckets.length - 1;
  const activeBucket = buckets[activeIndex];
  const values = buckets.map(bucket => bucket[metric]);
  const maximum = Math.max(1, ...values);
  const point = (bucket: AgentTrendBucket) => ({ x: 32 + bucket.index * (656 / Math.max(1, buckets.length - 1)), y: 176 - bucket[metric] / maximum * 140 });
  const points = buckets.map(bucket => { const position = point(bucket); return `${position.x},${position.y}`; }).join(" ");
  const label = metricLabels.find(entry => entry.key === metric)?.label || "指标";
  const visibleDetail = detail && detail.asOf === trend?.asOf && detail.selection?.bucket === selectedBucket && detail.selection.metric === metric ? detail : null;
  return <section className="wb2-section wb2-trend" aria-label="Agent 事项趋势">
    <div className="row spread"><div><h2>Agent 事项趋势</h2><p className="muted">每个点代表连续 24 小时；仅统计 Agent 事项的原始事件。</p></div><div className="wb2-trend-switch" aria-label="趋势时间范围">{([7, 30] as const).map(value => <button key={value} type="button" aria-pressed={days === value} onClick={() => setDays(value)}>近 {value} 天</button>)}</div></div>
    <div className="wb2-trend-switch" aria-label="趋势指标">{metricLabels.map(entry => <button type="button" key={entry.key} aria-pressed={metric === entry.key} onClick={() => { setMetric(entry.key); setSelectedBucket(null); setHoveredBucket(null); }}>{entry.label}</button>)}</div>
    {trendError && <p role="alert">趋势读取失败：{trendError} <button type="button" onClick={() => { anchor.current = null; setRefreshKey(value => value + 1); }}>重试</button></p>}
    {!trend && !trendError && <p className="empty">正在读取趋势…</p>}
    {trend && <>
      <p className="muted">{trendTime(trend.window.from)} 至 {trendTime(trend.window.to)} · {label}共 {trend.totals[metric]} 次{trend.totals[metric] === 0 ? "；此期间暂无该指标事件" : ""}</p>
      <div className="wb2-trend-scroll" data-days={days}><svg className="wb2-trend-chart" viewBox="0 0 720 210" role="group" aria-label={`近 ${days} 天${label}折线图，合计 ${trend.totals[metric]} 次`}>
        {[0, 1].map(fraction => <g key={fraction}><line x1="32" x2="688" y1={176 - fraction * 140} y2={176 - fraction * 140} className="wb2-trend-gridline" /><text x="25" y={180 - fraction * 140} textAnchor="end" className="wb2-trend-axis">{maximum * fraction}</text></g>)}
        <polyline points={points} className="wb2-trend-line" />
        {buckets.map(bucket => { const position = point(bucket); return <g key={bucket.index}>
          <circle cx={position.x} cy={position.y} r="12" className="wb2-trend-hit" role="button" tabIndex={0} aria-label={`${trendTime(bucket.from)} 至 ${trendTime(bucket.to)}，${label} ${bucket[metric]} 次；查看原始事件`} onMouseEnter={() => setHoveredBucket(bucket.index)} onMouseLeave={() => setHoveredBucket(null)} onFocus={() => setHoveredBucket(bucket.index)} onBlur={() => setHoveredBucket(null)} onClick={() => setSelectedBucket(bucket.index)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedBucket(bucket.index); } }} />
          <circle cx={position.x} cy={position.y} r={selectedBucket === bucket.index ? 5 : 3.5} className="wb2-trend-dot" pointerEvents="none" />
        </g>; })}
        <text x="32" y="204" className="wb2-trend-axis">{localTime(buckets[0]?.from || trend.window.from)}</text><text x="688" y="204" textAnchor="end" className="wb2-trend-axis">{localTime(buckets.at(-1)?.to || trend.window.to)}</text>
      </svg></div>
      <div className="wb2-trend-inspector"><p aria-live="polite">{activeBucket ? `${trendTime(activeBucket.from)} 至 ${trendTime(activeBucket.to)} · ${label} ${activeBucket[metric]} 次` : "暂无区间"}</p><label>键盘选择区间<select value={selectedBucket ?? ""} onChange={event => setSelectedBucket(event.target.value === "" ? null : Number(event.target.value))}><option value="">请选择</option>{buckets.map(bucket => <option key={bucket.index} value={bucket.index}>{trendTime(bucket.from)} 至 {trendTime(bucket.to)} · {bucket[metric]} 次</option>)}</select></label></div>
      {selectedBucket !== null && <div className="wb2-metric-drill"><div className="row spread"><h3>{label} · {trendTime(buckets[selectedBucket]?.from || "")} 至 {trendTime(buckets[selectedBucket]?.to || "")} · 原始事件</h3><button type="button" onClick={() => setSelectedBucket(null)}>收起记录</button></div>
        {detailError && <p role="alert">{detailError} <button type="button" disabled={detailLoading} onClick={() => { if (trend) void loadDetail(trend, selectedBucket, metric, visibleDetail, ++detailSeq.current); }}>重试</button></p>}
        {detailLoading && !visibleDetail && <p className="empty">正在读取区间事件…</p>}
        {visibleDetail && <><p className="muted">已加载 {visibleDetail.events.length} / {visibleDetail.pagination?.total ?? 0} 条</p>{visibleDetail.events.map(event => <MetricSummaryRow key={event.id} event={event} onOpenJob={onOpenJob} />)}{!visibleDetail.events.length && <p className="empty">此区间没有该指标的事件。</p>}{visibleDetail.pagination?.hasMore && <button type="button" disabled={detailLoading} onClick={() => void loadDetail(trend, selectedBucket, metric, visibleDetail, ++detailSeq.current)}>{detailLoading ? "正在加载…" : "查看更多事件"}</button>}</>}
      </div>}
    </>}
  </section>;
}

export type ScheduleEntry = { id: string; planned_date: string | null; due_date: string | null; schedule_revision: number };
type ScheduleEndpoint = "/api/work-items" | "/api/agent-work";
type ScheduleDraft = { planned: string; due: string; baseRevision: number; latest?: { entry: ScheduleEntry; state: unknown } };
const scheduleDrafts = new Map<string, ScheduleDraft>();
const scheduleDraftListeners = new Map<string, Set<() => void>>();
function subscribeScheduleDraft(key: string, listener: () => void) {
  const listeners = scheduleDraftListeners.get(key) || new Set<() => void>();
  listeners.add(listener);
  scheduleDraftListeners.set(key, listeners);
  return () => { listeners.delete(listener); if (!listeners.size) scheduleDraftListeners.delete(key); };
}
function setScheduleDraft(key: string, draft: ScheduleDraft | null) {
  if (draft) scheduleDrafts.set(key, draft);
  else scheduleDrafts.delete(key);
  scheduleDraftListeners.get(key)?.forEach(listener => listener());
}
export function hasUnsavedScheduleDrafts() { return scheduleDrafts.size > 0; }
function scheduleFromState(state: unknown, endpoint: ScheduleEndpoint, id: string): ScheduleEntry | undefined {
  const entries = endpoint === "/api/work-items" ? (state as { items?: ScheduleEntry[] }).items : (state as { jobs?: ScheduleEntry[] }).jobs;
  return entries?.find(entry => entry.id === id);
}
export function ScheduleEditor({ entry, endpoint, onState, compact = false }: { entry: ScheduleEntry; endpoint: ScheduleEndpoint; onState: (next: unknown) => void; compact?: boolean }) {
  const key = `${endpoint}:${entry.id}`;
  const subscribe = useCallback((listener: () => void) => subscribeScheduleDraft(key, listener), [key]);
  const getSnapshot = useCallback(() => scheduleDrafts.get(key), [key]);
  const draft = useSyncExternalStore(subscribe, getSnapshot, () => undefined);
  const [expanded, setExpanded] = useState(!compact || !!draft);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const latest = draft?.latest;
  const current = latest && latest.entry.schedule_revision >= entry.schedule_revision ? latest.entry : entry;
  const planned = draft?.planned ?? entry.planned_date ?? "";
  const due = draft?.due ?? entry.due_date ?? "";
  const baseRevision = draft?.baseRevision ?? entry.schedule_revision;
  const changed = planned !== (current.planned_date || "") || due !== (current.due_date || "");
  const stale = baseRevision !== current.schedule_revision;
  const invalidOrder = !!planned && !!due && planned > due;
  useEffect(() => {
    if (!draft || changed) return;
    setScheduleDraft(key, null);
    if (latest) onState(latest.state);
  }, [draft, changed, key, latest, onState]);
  function changeDraft(nextPlanned: string, nextDue: string) {
    if (nextPlanned === (current.planned_date || "") && nextDue === (current.due_date || "") && !stale) {
      setScheduleDraft(key, null);
      if (latest) onState(latest.state);
    } else setScheduleDraft(key, { planned: nextPlanned, due: nextDue, baseRevision, latest });
  }
  async function loadLatest() {
    setBusy(true); setMessage("");
    try {
      const state = await result(await fetch(endpoint, { cache: "no-store" }));
      setScheduleDraft(key, null);
      onState(state);
    } catch (error) { setMessage(error instanceof Error ? error.message : "最新排期读取失败，草稿已保留"); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!changed || stale || invalidOrder || busy) return;
    setBusy(true); setMessage("");
    try {
      const data = await result(await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "schedule.update", id: entry.id, scheduleRevision: baseRevision, plannedDate: planned || null, dueDate: due || null }) })) as { state: unknown };
      setScheduleDraft(key, null);
      onState(data.state);
      setMessage("排期已保存；成果和运行不受影响");
      if (compact) setExpanded(false);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "排期保存失败";
      setMessage(reason);
      try {
        const state = await result(await fetch(endpoint, { cache: "no-store" }));
        const fresh = scheduleFromState(state, endpoint, entry.id);
        if (fresh) setScheduleDraft(key, { planned, due, baseRevision, latest: { entry: fresh, state } });
      }
      catch (refreshError) { setMessage(`${reason}；刷新失败：${refreshError instanceof Error ? refreshError.message : "未知错误"}`); }
    } finally { setBusy(false); }
  }
  return <div className="schedule-editor">
    <div className="row spread"><span>计划日：{current.planned_date || "未安排"} · 截止日：{current.due_date || "未设置"}</span><button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "收起排期" : "设置排期"}</button></div>
    {expanded && <div className="schedule-fields"><label>计划处理日<input type="date" value={planned} onChange={event => changeDraft(event.target.value, due)} /></label><label>截止日<input type="date" value={due} onChange={event => changeDraft(planned, event.target.value)} /></label><div className="row"><button type="button" disabled={!planned || busy} onClick={() => changeDraft("", due)}>清空计划日</button><button type="button" disabled={!due || busy} onClick={() => changeDraft(planned, "")}>清空截止日</button></div>{invalidOrder && <p role="alert">计划日不能晚于截止日。</p>}{stale && <div role="alert"><p>排期已在其他页面更新；当前输入保留。最新安排：计划日 {current.planned_date || "未安排"}，截止日 {current.due_date || "未设置"}。</p><div className="row"><button type="button" onClick={() => { if (!changed) { setScheduleDraft(key, null); if (latest) onState(latest.state); } else setScheduleDraft(key, { planned, due, baseRevision: current.schedule_revision, latest }); }}>已核对，保留输入并重试</button><button type="button" disabled={busy} onClick={() => void loadLatest()}>载入最新排期</button></div></div>}<div className="row"><button type="button" className="primary" disabled={busy || stale || invalidOrder || !changed} onClick={save}>{busy ? "保存中…" : "保存排期"}</button>{changed && !stale && <button type="button" disabled={busy} onClick={() => void loadLatest()}>舍弃排期草稿</button>}</div></div>}
    {message && <p role="status">{message}</p>}
  </div>;
}

export default function AgentWorkspace({ mode, visible, onOpenJobs, onOpenTeam, onOpenConnections, onStateChange, sharedState, openJobRequest, startDraftRequest, connection, onConnectionChange }: { mode: "team" | "jobs"; visible: boolean; onOpenJobs: () => void; onOpenTeam: () => void; onOpenConnections: () => void; onStateChange?: (state: AgentState) => void; sharedState?: AgentState | null; openJobRequest?: { id: string; nonce: number } | null; startDraftRequest?: { text: string; modelChoice: ItemModelSelection | null; nonce: number } | null; connection?: ModelConnectionStatus | null; onConnectionChange?: (status: ModelConnectionStatus) => void }) {
  const [state, setState] = useState<AgentState | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [profileForm, setProfileForm] = useState<ProfileDraft>(emptyProfile);
  const [teamPanel, setTeamPanel] = useState<"overview" | "history" | "edit" | "create">("overview");
  const [teamAnalyticsOpen, setTeamAnalyticsOpen] = useState(false);
  const [profileDrafts, setProfileDrafts] = useState<Record<string, ProfileDraft>>({});
  const [templateId, setTemplateId] = useState("");
  const [teamPreferenceDrafts, setTeamPreferenceDrafts] = useState<Record<string, string>>({});
  const [preferenceEdits, setPreferenceEdits] = useState<Record<string, { text: string; expectedText: string }>>({});
  const [selectedJob, setSelectedJob] = useState("");
  const [jobEditorOpen, setJobEditorOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const contextButton = useRef<HTMLButtonElement>(null);
  const contextPanel = useRef<HTMLElement>(null);
  const [jobRequest, setJobRequest] = useState("");
  const [jobMaterial, setJobMaterial] = useState("");
  const [jobModelChoice, setJobModelChoice] = useState<ItemModelSelection | null>(null);
  const [newPlanned, setNewPlanned] = useState("");
  const [newDue, setNewDue] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [sourceDraft, setSourceDraft] = useState<SourceDraft | null>(null);
  const [targetLabel, setTargetLabel] = useState("");
  const [continuationEditing, setContinuationEditing] = useState(false);
  const [baseRevision, setBaseRevision] = useState(0);
  const [jobDrafts, setJobDrafts] = useState<Record<string, { request: string; material: string; steps: Step[]; revision: number; source: SourceDraft | null; targetLabel: string; continuationEditing: boolean; planned: string; due: string; modelChoice: ItemModelSelection | null }>>({});
  const [correctionDrafts, setCorrectionDrafts] = useState<Record<string, string>>({});
  const [restoreTarget, setRestoreTarget] = useState("");
  const [metrics, setMetrics] = useState<AgentMetricsResponse | null>(null);
  const [teamDetail, setTeamDetail] = useState<AgentMetricsResponse | null>(null);
  const [teamDetailLoading, setTeamDetailLoading] = useState(false);
  const [teamDetailError, setTeamDetailError] = useState("");
  const [agentDetail, setAgentDetail] = useState<AgentMetricDetailResponse | null>(null);
  const [agentDetailError, setAgentDetailError] = useState("");
  const [agentDetailLoading, setAgentDetailLoading] = useState(false);
  const [metricError, setMetricError] = useState("");
  const [teamFilter, setTeamFilter] = useState<keyof AgentMetricEventIds | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [agentFilter, setAgentFilter] = useState<keyof AgentMetricEventIds | null>(null);
  const [recentJobsOnly, setRecentJobsOnly] = useState(false);
  const refreshSeq = useRef(0);
  const detailSeq = useRef(0);
  const teamDetailSeq = useRef(0);
  const handledOpenNonce = useRef(0);
  const handledDraftNonce = useRef<number | null>(null);
  const stateSignature = JSON.stringify({
    runs: state?.runs.map(run => [run.id, run.status]),
    artifacts: state?.artifacts.map(artifact => [artifact.id, artifact.accepted_at]),
    jobs: state?.jobs.map(job => [job.id, job.revision, job.lifecycle]),
    profiles: state?.profiles.map(profile => [profile.id, profile.revision, profile.enabled]),
  });
  const refresh = useCallback(async () => { const seq = ++refreshSeq.current; const next = await result(await fetch("/api/agent-work", { cache: "no-store" })); if (seq === refreshSeq.current) { setState(next); onStateChange?.(next); } }, [onStateChange]);
  const acceptScheduleState = (next: unknown) => { const updated = next as AgentState; refreshSeq.current += 1; setState(updated); onStateChange?.(updated); };
  useEffect(() => { if (sharedState) { refreshSeq.current += 1; setState(sharedState); } }, [sharedState]);
  useEffect(() => {
    if (mode !== "team" || !visible) return;
    const controller = new AbortController();
    fetch("/api/agent-metrics", { cache: "no-store", signal: controller.signal }).then(result).then(data => { setMetrics(data as AgentMetricsResponse); setMetricError(""); }).catch(error => {
      if (controller.signal.aborted) return;
      setMetrics(null);
      setMetricError(error instanceof Error ? error.message : "团队记录读取失败");
    });
    return () => controller.abort();
  }, [mode, visible, state]);
  const loadTeamDetail = useCallback(async (metric: keyof AgentMetricEventIds, previous: AgentMetricsResponse | null, seq: number) => {
    setTeamDetailLoading(true); setTeamDetailError("");
    const params = new URLSearchParams({ metric, limit: "30" });
    if (previous?.pagination?.nextCursor) { params.set("cursor", previous.pagination.nextCursor); params.set("asOf", previous.pagination.asOf); }
    try {
      const data = await result(await fetch(`/api/agent-metrics?${params}`, { cache: "no-store" })) as AgentMetricsResponse;
      if (seq !== teamDetailSeq.current) return;
      setTeamDetail(previous && previous.pagination?.metric === metric
        ? { ...data, events: [...previous.events, ...data.events] } : data);
    } catch (error) {
      if (seq === teamDetailSeq.current) setTeamDetailError(error instanceof Error ? error.message : "团队记录读取失败");
    } finally { if (seq === teamDetailSeq.current) setTeamDetailLoading(false); }
  }, []);
  useEffect(() => {
    const seq = ++teamDetailSeq.current;
    setTeamDetail(null); setTeamDetailError("");
    if (mode === "team" && visible && teamFilter) void loadTeamDetail(teamFilter, null, seq);
    return () => { teamDetailSeq.current += 1; };
  }, [mode, visible, teamFilter, stateSignature, loadTeamDetail]);
  const loadAgentDetail = useCallback(async (agentId: string, metric: keyof AgentMetricEventIds | null, recentOnly: boolean, previous: AgentMetricDetailResponse | null, append: "events" | "jobs" | null, seq: number) => {
    setAgentDetailLoading(true); setAgentDetailError("");
    const params = new URLSearchParams({ agentId, limit: "30", jobsLimit: "30", jobsRecentOnly: String(recentOnly) });
    if (metric) params.set("metric", metric);
    if (previous && append) {
      params.set("asOf", previous.pagination.asOf);
      if (append === "events" && previous.pagination.nextCursor) params.set("cursor", previous.pagination.nextCursor);
      if (append === "jobs" && previous.jobsPagination.nextCursor) params.set("jobsCursor", previous.jobsPagination.nextCursor);
    }
    try {
      const data = await result(await fetch(`/api/agent-metrics?${params}`, { cache: "no-store" })) as AgentMetricDetailResponse;
      if (seq !== detailSeq.current) return;
      setAgentDetail(current => previous && append && current?.agent.profile.id === agentId && current.pagination.metric === metric
        ? { ...data, agent: { ...data.agent,
          events: append === "events" ? [...current.agent.events, ...data.agent.events] : current.agent.events,
          jobs: append === "jobs" ? [...current.agent.jobs, ...data.agent.jobs] : current.agent.jobs },
          pagination: append === "jobs" ? current.pagination : data.pagination,
          jobsPagination: append === "events" ? current.jobsPagination : data.jobsPagination } : data);
    } catch (error) {
      if (seq === detailSeq.current) setAgentDetailError(error instanceof Error ? error.message : "Agent 历史读取失败");
    } finally { if (seq === detailSeq.current) setAgentDetailLoading(false); }
  }, []);
  useEffect(() => {
    const seq = ++detailSeq.current;
    setAgentDetail(null); setAgentDetailError("");
    if (mode === "team" && visible && selectedAgentId && metrics?.agents.some(entry => entry.profile.id === selectedAgentId)) void loadAgentDetail(selectedAgentId, agentFilter, recentJobsOnly, null, null, seq);
    return () => { detailSeq.current += 1; };
  }, [mode, visible, selectedAgentId, agentFilter, recentJobsOnly, stateSignature, metrics, loadAgentDetail]);
  useEffect(() => { refresh().catch(error => setNotice(error.message)); }, [refresh]);
  useEffect(() => {
    const sync = () => { if (document.visibilityState === "visible") refresh().catch(error => setNotice(error.message)); };
    window.addEventListener("focus", sync); document.addEventListener("visibilitychange", sync);
    return () => { window.removeEventListener("focus", sync); document.removeEventListener("visibilitychange", sync); };
  }, [refresh]);
  useEffect(() => {
    if (!state?.runs.some(run => run.status === "running")) return;
    const timer = setInterval(() => refresh().catch(error => setNotice(error instanceof Error ? error.message : "状态刷新失败")), 1000);
    return () => clearInterval(timer);
  }, [state?.runs, refresh]);
  useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent) => {
      const saved = state?.jobs.find(entry => entry.id === selectedJob);
      const jobDirty = selectedJob ? !!saved && (jobRequest !== saved.request || jobMaterial !== saved.material || JSON.stringify(steps) !== saved.steps_json || (sourceDraft?.artifactId ?? null) !== saved.source_artifact_id || targetLabel !== saved.target_label) : !!(jobRequest.trim() || jobMaterial.trim() || steps.length || sourceDraft || targetLabel || newPlanned || newDue || jobModelChoice);
      const savedProfile = state?.profiles.find(entry => entry.id === profileForm.id);
      const profileDirty = profileForm.id ? !!savedProfile && JSON.stringify(profileDraft(savedProfile)) !== JSON.stringify(profileForm) : !!(profileForm.name || profileForm.instructions || profileForm.deliverable);
      const preferenceDirty = Object.entries(preferenceEdits).some(([id, draft]) => state?.preferences.find(entry => entry.id === id)?.text !== draft.text);
      if (profileDirty || jobDirty || Object.keys(profileDrafts).length || Object.keys(jobDrafts).length || Object.values(correctionDrafts).some(text => text.trim()) || Object.values(teamPreferenceDrafts).some(text => text.trim()) || preferenceDirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [state?.jobs, state?.profiles, state?.preferences, selectedJob, jobRequest, jobMaterial, jobModelChoice, steps, sourceDraft, targetLabel, newPlanned, newDue, profileForm, profileDrafts, jobDrafts, correctionDrafts, teamPreferenceDrafts, preferenceEdits]);
  async function mutate(body: Record<string, unknown>) {
    setBusy(true); setNotice("");
    try { const data = await result(await fetch("/api/agent-work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })); refreshSeq.current += 1; setState(data.state); onStateChange?.(data.state); if (["job.correct", "job.correction.archive", "job.complete", "job.archive", "job.reopen"].includes(String(body.type))) { const updated = data.state.jobs.find((entry: Job) => entry.id === body.id); if (updated) setBaseRevision(updated.revision); } return data; }
    catch (error) { const message = error instanceof Error ? error.message : "操作失败"; setNotice(message); await refresh().catch(refreshError => setNotice(`${message}；刷新失败：${refreshError instanceof Error ? refreshError.message : "未知错误"}`)); return null; }
    finally { setBusy(false); }
  }
  function sourceFor(job: Job): SourceDraft | null {
    if (!job.source_job_id || !job.source_artifact_id || !job.source_artifact_version) return null;
    return { jobId: job.source_job_id, artifactId: job.source_artifact_id, version: job.source_artifact_version, revision: state?.jobs.find(entry => entry.id === job.source_job_id)?.revision || 0 };
  }
  function stashJobDraft() {
    const saved = state?.jobs.find(entry => entry.id === selectedJob);
    const dirty = saved ? jobRequest !== saved.request || jobMaterial !== saved.material || JSON.stringify(steps) !== saved.steps_json || (sourceDraft?.artifactId ?? null) !== saved.source_artifact_id || targetLabel !== saved.target_label : !!(jobRequest.trim() || jobMaterial.trim() || steps.length || sourceDraft || targetLabel || newPlanned || newDue || jobModelChoice);
    if (dirty) setJobDrafts(current => ({ ...current, [selectedJob || "__new"]: { request: jobRequest, material: jobMaterial, steps, revision: baseRevision, source: sourceDraft, targetLabel, continuationEditing, planned: newPlanned, due: newDue, modelChoice: jobModelChoice } }));
  }
  function chooseJob(job: Job) {
    if (selectedJob === job.id) return;
    stashJobDraft();
    const draft = jobDrafts[job.id];
    setSelectedJob(job.id); setJobRequest(draft?.request ?? job.request); setJobMaterial(draft?.material ?? job.material); setJobModelChoice(parseItemModelSelection(job.model_choice_json)); setSteps(draft?.steps ?? parseSteps(job)); setBaseRevision(draft?.revision ?? job.revision); setSourceDraft(draft ? draft.source : sourceFor(job)); setTargetLabel(draft?.targetLabel ?? job.target_label); setContinuationEditing(draft?.continuationEditing ?? false); setNotice("");
    setJobEditorOpen(false); setContextOpen(false);
  }
  useEffect(() => {
    if (!openJobRequest || handledOpenNonce.current === openJobRequest.nonce) return;
    const target = state?.jobs.find(entry => entry.id === openJobRequest.id);
    if (target) { chooseJob(target); setJobEditorOpen(false); setContextOpen(false); handledOpenNonce.current = openJobRequest.nonce; }
  }, [openJobRequest, state?.jobs]);
  function newJob() {
    if (!selectedJob) return;
    stashJobDraft();
    const draft = jobDrafts.__new;
    setSelectedJob(""); setJobRequest(draft?.request ?? ""); setJobMaterial(draft?.material ?? ""); setJobModelChoice(draft?.modelChoice ?? null); setSteps(draft?.steps ?? []); setBaseRevision(0); setSourceDraft(draft?.source ?? null); setTargetLabel(draft?.targetLabel ?? ""); setContinuationEditing(draft?.continuationEditing ?? false); setNewPlanned(draft?.planned ?? ""); setNewDue(draft?.due ?? ""); setNotice("");
    setJobEditorOpen(false); setContextOpen(false);
  }
  function startJobWithAgent(agentId: string) {
    const existing = selectedJob ? jobDrafts.__new : { request: jobRequest, material: jobMaterial, steps, source: sourceDraft, targetLabel, planned: newPlanned, due: newDue, modelChoice: jobModelChoice };
    const hasDraft = !!existing && !!(existing.request.trim() || existing.material.trim() || existing.steps.length || existing.source || existing.targetLabel || existing.planned || existing.due || existing.modelChoice);
    if (hasDraft) {
      if (selectedJob) newJob();
      setNotice("已有未保存的事项草稿，已保留原内容；请先处理草稿，再选择 Agent。");
      onOpenJobs();
      return;
    }
    if (selectedJob) stashJobDraft();
    setSelectedJob(""); setJobRequest(""); setJobMaterial(""); setJobModelChoice(null); setSteps([{ agentId, upstream: [] }]); setBaseRevision(0); setSourceDraft(null); setTargetLabel(""); setContinuationEditing(false); setNewPlanned(""); setNewDue(""); setJobEditorOpen(false); setContextOpen(false); setNotice("");
    onOpenJobs();
  }
  useEffect(() => {
    if (!startDraftRequest || handledDraftNonce.current === startDraftRequest.nonce) return;
    handledDraftNonce.current = startDraftRequest.nonce;
    const existing = selectedJob ? jobDrafts.__new : { request: jobRequest, material: jobMaterial, steps, source: sourceDraft, targetLabel, planned: newPlanned, due: newDue, modelChoice: jobModelChoice };
    const hasDraft = !!existing && !!(existing.request.trim() || existing.material.trim() || existing.steps.length || existing.source || existing.targetLabel || existing.planned || existing.due || existing.modelChoice);
    if (hasDraft) {
      if (selectedJob) newJob();
      setNotice("已有未保存的 Agent 事项草稿，已保留原内容；请处理草稿后再从工作台带入需求。");
      return;
    }
    if (selectedJob) stashJobDraft();
    setSelectedJob(""); setJobRequest(startDraftRequest.text); setJobMaterial(""); setJobModelChoice(startDraftRequest.modelChoice); setSteps([]); setBaseRevision(0); setSourceDraft(null); setTargetLabel(""); setContinuationEditing(false); setNewPlanned(""); setNewDue(""); setJobEditorOpen(false); setContextOpen(false); setNotice("");
    requestAnimationFrame(() => document.getElementById("agent-job-editor")?.scrollIntoView({ block: "start" }));
  }, [startDraftRequest]);
  useEffect(() => {
    if (!visible || mode !== "jobs" || !contextOpen) return;
    const panel = contextPanel.current;
    if (!panel) return;
    panel.querySelector<HTMLElement>(".wb2-context-heading button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setContextOpen(false); contextButton.current?.focus(); }
      if (event.key !== "Tab") return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')).filter(element => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [visible, mode, contextOpen]);
  function startContinuation(artifact: Artifact) {
    const sourceJob = state?.jobs.find(entry => entry.id === artifact.job_id);
    if (!sourceJob || !artifact.accepted_at) return;
    stashJobDraft();
    setSelectedJob(""); setJobRequest(""); setJobMaterial(""); setJobModelChoice(null); setSteps([]); setBaseRevision(0);
    setSourceDraft({ jobId: sourceJob.id, artifactId: artifact.id, version: artifact.version, revision: sourceJob.revision });
    setTargetLabel(""); setContinuationEditing(true); setNewPlanned(""); setNewDue(""); setContextOpen(false); setNotice("");
    requestAnimationFrame(() => document.getElementById("agent-job-editor")?.scrollIntoView({ block: "start" }));
  }
  function stashProfileDraft() {
    const saved = state?.profiles.find(profile => profile.id === profileForm.id);
    const dirty = saved ? JSON.stringify(profileDraft(saved)) !== JSON.stringify(profileForm) : !!(profileForm.name || profileForm.instructions || profileForm.deliverable);
    if (dirty) setProfileDrafts(current => ({ ...current, [profileForm.id || "__new"]: profileForm }));
  }
  function chooseProfile(entry: Profile) {
    if (profileForm.id === entry.id && teamPanel !== "create") { setSelectedAgentId(entry.id); setTeamPanel("edit"); return; }
    if (profileForm.id !== entry.id) stashProfileDraft();
    setProfileForm(profileDrafts[entry.id] ?? profileDraft(entry));
    setSelectedAgentId(entry.id);
    setTeamPanel("edit");
  }
  function createProfile() {
    if (teamPanel === "create") return;
    stashProfileDraft();
    setProfileForm(profileDrafts.__new ?? emptyProfile());
    setTemplateId("");
    setTeamPanel("create");
  }
  function setStep(index: number, patch: Partial<Step>) { setSteps(current => current.map((step, at) => at === index ? { ...step, ...patch } : step)); }
  function moveStep(index: number) {
    setSteps(current => {
      const moved = [...current]; [moved[index - 1], moved[index]] = [moved[index], moved[index - 1]];
      const renumber = (old: number) => old === index ? index - 1 : old === index - 1 ? index : old;
      return moved.map((entry, at) => ({ ...entry, upstream: entry.upstream.map(renumber).filter(dependency => dependency < at).sort() }));
    });
  }
  function removeStep(index: number) {
    setSteps(current => current.filter((_, at) => at !== index).map(entry => ({ ...entry, upstream: entry.upstream.filter(dependency => dependency !== index).map(dependency => dependency > index ? dependency - 1 : dependency) })));
  }
  const currentJob = state?.jobs.find(entry => entry.id === selectedJob);
  const currentJobChoice = currentJob ? parseItemModelSelection(currentJob.model_choice_json) : null;
  const correction = correctionDrafts[selectedJob] || "";
  const currentIds = currentJob ? state?.current[currentJob.id] || [] : [];
  const jobSteps = currentJob ? parseSteps(currentJob) : [];
  const currentArtifacts = currentIds.map(id => state?.artifacts.find(artifact => artifact.id === id));
  const visibleStepIndexes = jobSteps.map((_, index) => index).sort((a, b) => {
    const priority = (index: number) => currentArtifacts[index] ? currentArtifacts[index]?.accepted_at ? 2 : 0 : 1;
    return priority(a) - priority(b) || a - b;
  });
  const pendingConfirmations = currentArtifacts.filter(artifact => artifact && !artifact.accepted_at).length;
  const pending = currentIds.findIndex(id => !id);
  const activeRun = state?.runs.find(run => run.job_id === selectedJob && run.status === "running");
  const latestFailedRun = currentJob?.status === "failed" ? state?.runs.find(run => run.job_id === selectedJob && run.status === "failed" && run.step_index === pending) : undefined;
  const profiles = state?.profiles || [];
  const selectedTeamProfile = profiles.find(entry => entry.id === selectedAgentId);
  useEffect(() => {
    if (mode === "team" && visible && profiles.length && !selectedTeamProfile) setSelectedAgentId(profiles[0].id);
  }, [mode, visible, profiles, selectedTeamProfile]);
  const selectedMetricAgent = metrics?.agents.find(entry => entry.profile.id === selectedAgentId);
  const visibleDetail = agentDetail?.agent.profile.id === selectedAgentId && agentDetail.pagination.metric === agentFilter ? agentDetail : null;
  const teamEvents = teamDetail?.pagination?.metric === teamFilter ? teamDetail.events : [];
  const agentEvents = visibleDetail?.agent.events || [];
  const visibleAgentJobs = visibleDetail?.agent.jobs || [];
  const openMetricJob = (id: string) => {
    const target = state?.jobs.find(entry => entry.id === id);
    if (!target) { setNotice("关联事项已不在当前列表，请刷新后重试"); return; }
    chooseJob(target);
    onOpenJobs();
  };
  const name = (id: string) => { const entry = profiles.find(profile => profile.id === id); return entry ? `${entry.name}${profiles.filter(profile => profile.name === entry.name).length > 1 ? ` · ${entry.id.slice(0, 8)}` : ""}` : "已移除 Agent"; };
  const pendingProfile = pending >= 0 ? profiles.find(profile => profile.id === jobSteps[pending]?.agentId) : undefined;
  const pendingPaused = pendingProfile?.enabled === 0;
  const pendingPermissionConflict = !!(jobSteps[pending]?.upstream.length || jobSteps[pending]?.source) && pendingProfile?.allow_upstream === 0;
  const stepPermissionConflict = (step: Step) => !!(step.upstream.length || step.source) && profiles.find(profile => profile.id === step.agentId)?.allow_upstream === 0;
  const openProfile = (id: string) => { if (teamPanel === "edit" || teamPanel === "create") stashProfileDraft(); setSelectedAgentId(id); setTeamPanel("overview"); setRestoreTarget(id); onOpenTeam(); };
  useEffect(() => {
    if (notice === "运行已启动；页面将更新结果" && !activeRun) setNotice("");
  }, [notice, activeRun]);
  useEffect(() => {
    if (mode !== "team" || !restoreTarget) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(`agent-profile-${restoreTarget}`)?.scrollIntoView({ block: "center" });
      setRestoreTarget("");
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, restoreTarget]);
  const sources = (raw: string) => { try { return (JSON.parse(raw) as { id: string; version: number }[]).map(ref => { const source = state?.artifacts.find(artifact => artifact.id === ref.id); return source ? `第 ${source.step_index + 1} 步成果 v${ref.version}` : `历史成果 v${ref.version}`; }).join("、") || "无"; } catch { return "来源记录无法读取"; } };
  const status = (entry: Job) => { if (entry.lifecycle === "completed") return "已完成"; if (entry.lifecycle === "archived") return "已归档"; if (state?.runs.some(run => run.job_id === entry.id && run.status === "running")) return "运行中"; const ids = state?.current[entry.id] || []; const next = ids.findIndex(id => !id); const nextStep = next >= 0 ? parseSteps(entry)[next] : undefined; const nextProfile = profiles.find(profile => profile.id === nextStep?.agentId); if (nextProfile?.enabled === 0) return `第 ${next + 1} 步受阻：${name(nextProfile.id)}已暂停`; if ((nextStep?.upstream.length || nextStep?.source) && nextProfile?.allow_upstream === 0) return `第 ${next + 1} 步受阻：${name(nextProfile.id)}已关闭上游成果权限`; if (ids.length && ids.every(Boolean)) return "成果已生成"; if (entry.status === "ready") return "资料或配置已变化 · 待更新"; if (entry.status === "failed") return "失败 · 待手动继续"; if (entry.status === "interrupted") return "已中断 · 待手动继续"; if (entry.status === "cancelled") return "已取消 · 待手动继续"; return "待运行"; };
  const profileChanged = !!profileForm.id && profiles.find(entry => entry.id === profileForm.id)?.revision !== profileForm.revision;
  const currentJobDirty = !!currentJob && (jobRequest !== currentJob.request || jobMaterial !== currentJob.material || JSON.stringify(steps) !== currentJob.steps_json || (sourceDraft?.artifactId ?? null) !== currentJob.source_artifact_id || targetLabel !== currentJob.target_label);
  const sourceScopeDirty = !!currentJob && ((sourceDraft?.artifactId ?? null) !== currentJob.source_artifact_id || targetLabel !== currentJob.target_label || JSON.stringify(steps.map(step => !!step.source)) !== JSON.stringify(parseSteps(currentJob).map(step => !!step.source)));
  const sourceArtifact = state?.artifacts.find(artifact => artifact.id === sourceDraft?.artifactId);
  const sourceJob = state?.jobs.find(job => job.id === sourceDraft?.jobId);
  const availableSources = state?.artifacts.filter(artifact => artifact.accepted_at && artifact.job_id !== currentJob?.id && state.jobs.some(job => job.id === artifact.job_id)) || [];
  const sourceReceivers = steps.filter(step => step.source);
  const visiblePreferences = state?.preferences.filter(pref => pref.active && pref.agent_id === selectedAgentId) || [];
  const preferenceInput = teamPreferenceDrafts[selectedAgentId] || "";
  const assignedModel = connection?.assignments[selectedAgentId] ?? null;
  const effectiveModel = assignedModel ?? connection?.defaultChoice ?? null;
  const effectiveChannel = connection?.channels.find(channel => channel.id === effectiveModel?.connectionId);
  const modelSection = selectedTeamProfile && <section className="wb2-section wb2-team-model" aria-label={`${name(selectedTeamProfile.id)}模型选择`}>
    <h2>运行模型</h2>
    <p className="muted">当前：{effectiveChannel ? `${effectiveChannel.name} · ${effectiveModel?.model}` : "尚未选择"}{effectiveChannel && !effectiveChannel.connected ? " · 渠道需重新连接" : ""}。切换只影响后续运行，不改历史成果。</p>
    <label>这位 Agent 使用的模型<select disabled={busy || !connection} value={assignedModel ? JSON.stringify([assignedModel.connectionId, assignedModel.model]) : ""} onChange={async event => {
      const targetId = selectedTeamProfile.id;
      setBusy(true); setNotice("");
      try {
        const [connectionId, model] = event.target.value ? JSON.parse(event.target.value) as [string, string] : [null, null];
        const response = await fetch("/api/connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "agent.select", agentId: targetId, connectionId, model, expectedRevision: connection?.assignmentRevisions[targetId] ?? 0 }) });
        const updated = await result(response) as ModelConnectionStatus;
        onConnectionChange?.(updated);
        setNotice(connectionId ? "此 Agent 的模型选择已保存；后续运行生效" : "此 Agent 现跟随工作区默认模型");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "模型选择失败");
        try { onConnectionChange?.(await result(await fetch("/api/connection", { cache: "no-store" })) as ModelConnectionStatus); }
        catch (refreshError) { setNotice(`${error instanceof Error ? error.message : "模型选择失败"}；连接状态刷新失败：${refreshError instanceof Error ? refreshError.message : "请稍后重试"}`); }
      } finally { setBusy(false); }
    }}>
      <option value="">跟随工作区默认</option>
      {connection?.channels.flatMap(channel => channel.models.map(model => <option key={`${channel.id}:${model}`} value={JSON.stringify([channel.id, model])}>{channel.name} · {channel.modelNames[model] || model} ({model}){channel.connected ? "" : " · 需重连"}</option>))}
      {assignedModel && !connection?.channels.some(channel => channel.id === assignedModel.connectionId && channel.models.includes(assignedModel.model)) && <option value={JSON.stringify([assignedModel.connectionId, assignedModel.model])} disabled>原模型已不可用，请重新选择</option>}
    </select></label>
    <p className="muted">渠道在「设置 → 模型连接」管理。没有连接或所选渠道断开时，运行会明确受阻，不自动转到其他厂商。</p>
  </section>;
  const preferenceSection = <section className="wb2-section wb2-team-preferences"><h2>长期偏好</h2>
    <p className="muted">仅进入所属实例的后续运行，每个实例最多 5 条有效偏好；撤销不改写历史成果或运行快照。</p>
    <div className="wb2-card"><label>偏好<input disabled={busy} maxLength={500} value={preferenceInput} onChange={event => setTeamPreferenceDrafts(current => ({ ...current, [selectedAgentId]: event.target.value }))} /></label>
      <button disabled={busy || !selectedAgentId || !preferenceInput.trim()} onClick={async () => { if (await mutate({ type: "preference.save", agentId: selectedAgentId, text: preferenceInput })) setTeamPreferenceDrafts(current => { if (current[selectedAgentId] !== preferenceInput) return current; const next = { ...current }; delete next[selectedAgentId]; return next; }); }}>保存偏好</button></div>
    {visiblePreferences.map(pref => { const draft = preferenceEdits[pref.id]; const changedElsewhere = !!draft && draft.expectedText !== pref.text; return <div className="simple-row" key={pref.id}><h3>{name(pref.agent_id)}</h3>
      <input aria-label={`编辑${name(pref.agent_id)}偏好`} maxLength={500} value={draft?.text ?? pref.text} onChange={event => setPreferenceEdits(current => ({ ...current, [pref.id]: { text: event.target.value, expectedText: current[pref.id]?.expectedText ?? pref.text } }))} />
      {changedElsewhere && <p role="alert">偏好已在其他入口更新；草稿已保留。请核对后载入最新内容。</p>}
      <div className="row"><button disabled={busy || changedElsewhere || !(draft?.text ?? pref.text).trim() || (draft?.text ?? pref.text) === pref.text} onClick={async () => { const submitted = draft?.text ?? pref.text; if (await mutate({ type: "preference.update", id: pref.id, text: submitted, active: true, expectedText: draft?.expectedText ?? pref.text, expectedActive: true })) setPreferenceEdits(current => { if (current[pref.id]?.text !== submitted) return current; const next = { ...current }; delete next[pref.id]; return next; }); }}>保存编辑</button>
        <button disabled={busy || changedElsewhere} onClick={async () => { if (await mutate({ type: "preference.update", id: pref.id, text: pref.text, active: false, expectedText: pref.text, expectedActive: true })) setPreferenceEdits(current => { const next = { ...current }; delete next[pref.id]; return next; }); }}>撤销</button>
        {changedElsewhere && <button onClick={() => setPreferenceEdits(current => { const next = { ...current }; delete next[pref.id]; return next; })}>载入最新偏好</button>}</div></div>; })}
    {Object.keys(preferenceEdits).filter(id => !state?.preferences.some(pref => pref.id === id && pref.active)).map(id => <p role="alert" key={id}>一条偏好草稿的来源已停用。<button onClick={() => setPreferenceEdits(current => { const next = { ...current }; delete next[id]; return next; })}>舍弃该草稿</button></p>)}
    {!visiblePreferences.length && <p className="empty">此 Agent 暂无长期偏好。</p>}
  </section>;

  const teamMetricsSection = <section className="wb2-section" aria-label="自定义 Agent 事项近七日统计">
    <div className="row spread"><h2>自定义 Agent 事项统计 · 近 7 天</h2>{metrics && <span className="muted">{localTime(metrics.window.from)} 至 {localTime(metrics.window.to)}</span>}</div>
    <p className="muted">仅统计 Agent 事项，不含求职与英语快捷事项；运行成功表示一次模型执行成功，事项完成与成果确认分别记录。</p>
    {metricError ? <p role="alert">团队记录读取失败：{metricError}</p> : !metrics ? <p className="empty">正在读取团队记录…</p> : <>
      <div className="wb2-metrics-grid">{metricLabels.map(({ key, label }) => <button className="wb2-metric" aria-pressed={teamFilter === key} key={key} onClick={() => setTeamFilter(current => current === key ? null : key)}><strong>{metrics.team[key]}</strong><span>{label}</span></button>)}</div>
      {teamFilter && <div className="wb2-metric-drill"><div className="row spread"><h3>{metricLabels.find(entry => entry.key === teamFilter)?.label} · 对应记录</h3><button onClick={() => setTeamFilter(null)}>收起记录</button></div>{teamDetailError && <p role="alert">{teamDetailError} <button disabled={teamDetailLoading} onClick={() => { const seq = ++teamDetailSeq.current; void loadTeamDetail(teamFilter, teamDetail, seq); }}>重试</button></p>}{teamEvents.map(event => <MetricSummaryRow key={event.id} event={event} onOpenJob={openMetricJob} />)}{!teamEvents.length && !teamDetailLoading && !teamDetailError && <p className="empty">近 7 天此类尚无记录。</p>}{teamDetail?.pagination?.hasMore && <button disabled={teamDetailLoading} onClick={() => { const seq = ++teamDetailSeq.current; void loadTeamDetail(teamFilter, teamDetail, seq); }}>{teamDetailLoading ? "正在加载…" : "查看更多记录"}</button>}</div>}
    </>}
  </section>;
  const agentDetailSection = selectedMetricAgent && <section className="wb2-section wb2-agent-detail" id={`agent-detail-${selectedAgentId}`}>
    <div className="row spread"><div><div className="kicker">AGENT DETAIL</div><h2>{selectedMetricAgent.profile.name} · Agent 详情</h2></div><div className="row"><button disabled={agentDetailLoading} onClick={() => { const seq = ++detailSeq.current; void loadAgentDetail(selectedAgentId, agentFilter, recentJobsOnly, null, null, seq); }}>刷新详情</button><button onClick={() => { setSelectedAgentId(""); setAgentFilter(null); setRecentJobsOnly(false); }}>返回团队列表</button></div></div>
    {agentDetailError && <p role="alert">Agent 历史读取失败：{agentDetailError} <button disabled={agentDetailLoading} onClick={() => { const seq = ++detailSeq.current; void loadAgentDetail(selectedAgentId, agentFilter, recentJobsOnly, null, null, seq); }}>重试</button></p>}
    {!visibleDetail ? <p className="empty">正在读取 Agent 详情…</p> : <><div className="wb2-agent-detail-grid"><div><h3>当前职责与权限</h3><p>{visibleDetail.agent.profile.instructions}</p><p>预期交付物：{visibleDetail.agent.profile.deliverable}</p><p>可见资料：事项需求{visibleDetail.agent.profile.allow_material ? "、本事项文本与纠正" : ""}{visibleDetail.agent.profile.allow_upstream ? "、指定上游成果" : ""}</p><p className="muted">当前状态：{visibleDetail.agent.profile.enabled ? "可参与" : "已暂停"} · 最近活动：{visibleDetail.agent.lastActivityAt ? localTime(visibleDetail.agent.lastActivityAt) : "尚未运行"}</p></div>
      <div><h3>近 7 天 · Agent 事项</h3><button className="quiet" aria-pressed={recentJobsOnly} onClick={() => { setRecentJobsOnly(current => !current); document.getElementById("agent-participating-jobs")?.scrollIntoView({ block: "center" }); }}>参与 {selectedMetricAgent.sevenDay.participatingJobs} 个事项 · {recentJobsOnly ? "查看全部" : "查看记录"}</button><div className="wb2-metrics-grid wb2-metrics-compact">{metricLabels.map(({ key, label }) => <button className="wb2-metric" aria-pressed={agentFilter === key} key={key} onClick={() => setAgentFilter(current => current === key ? null : key)}><strong>{selectedMetricAgent.sevenDay[key]}</strong><span>{label}</span></button>)}</div></div></div>
    <section className="wb2-section" id="agent-participating-jobs"><h3>{recentJobsOnly ? "近 7 天参与事项" : "参与事项"}</h3><p className="muted">已加载 {visibleAgentJobs.length} / {visibleDetail.jobsPagination.total} 项</p>{visibleAgentJobs.map(job => <div className="simple-row" key={job.id}><strong>{job.request}</strong><p>{job.lifecycle === "completed" ? "事项已完成" : job.lifecycle === "archived" ? "事项已归档" : `事项进行中 · ${state?.jobs.find(entry => entry.id === job.id) ? status(state.jobs.find(entry => entry.id === job.id)!) : job.status}`} · {job.runCount} 次运行 · {job.artifactCount} 个成果版本 · 更新于 {localTime(job.updatedAt)}</p><button onClick={() => openMetricJob(job.id)}>打开事项</button></div>)}{!visibleAgentJobs.length && <p className="empty">{recentJobsOnly ? "近 7 天尚未参与 Agent 事项。" : "尚未参与 Agent 事项。"}</p>}{visibleDetail.jobsPagination.hasMore && <button disabled={agentDetailLoading} onClick={() => { const seq = ++detailSeq.current; void loadAgentDetail(selectedAgentId, agentFilter, recentJobsOnly, visibleDetail, "jobs", seq); }}>{agentDetailLoading ? "正在加载…" : "查看更多事项"}</button>}</section>
    <section className="wb2-section"><div className="row spread"><h3>{agentFilter ? `${metricLabels.find(entry => entry.key === agentFilter)?.label} · 近 7 天记录` : "全部事件 · 时间倒序"}</h3>{agentFilter && <button onClick={() => setAgentFilter(null)}>查看全部事件</button>}</div><p className="muted">已加载 {agentEvents.length} / {visibleDetail.pagination.total} 条</p>{agentEvents.map(event => <MetricEventRow key={event.id} event={event} onOpenJob={openMetricJob} />)}{!agentEvents.length && <p className="empty">{agentFilter ? "近 7 天此类尚无记录。" : "尚未运行。"}</p>}{visibleDetail.pagination.hasMore && <button disabled={agentDetailLoading} onClick={() => { const seq = ++detailSeq.current; void loadAgentDetail(selectedAgentId, agentFilter, recentJobsOnly, visibleDetail, "events", seq); }}>{agentDetailLoading ? "正在加载…" : "查看更多历史"}</button>}</section></>}
  </section>;

  const jobEditor = (
        <><div className="row spread"><h2>{currentJob ? "修改事项与交接" : sourceDraft ? "新建后续事项" : "新建事项"}</h2>{currentJob && <button onClick={newJob}>返回新建</button>}</div>
          {currentJob && !continuationEditing && <div className="wb2-section"><h3>接续来源</h3>{currentJob.source_artifact_id ? <p>固定引用 {state?.jobs.find(job => job.id === currentJob.source_job_id)?.request || "历史事项"} · 成果 v{currentJob.source_artifact_version}；目标标签：{currentJob.target_label || "未设置"}</p> : <p className="muted">此事项没有跨事项接续来源。</p>}<button disabled={busy || currentJob.lifecycle !== "open" || !!activeRun} onClick={() => setContinuationEditing(true)}>{currentJob.source_artifact_id ? "修改或取消接续" : "设置接续来源"}</button></div>}
          {(continuationEditing || (!currentJob && sourceDraft)) && <div className="wb2-section agent-continuation"><h3>固定来源与接收范围</h3><p className="muted">跨事项来源只发送所选的已确认成果版本；目标标签仅用于整理事项，不分享其他资料。取消关联不会改写既有运行快照。</p><label>已确认成果<select disabled={busy} value={sourceDraft?.artifactId || ""} onChange={event => { const artifact = availableSources.find(entry => entry.id === event.target.value); const source = artifact && state?.jobs.find(job => job.id === artifact.job_id); setSourceDraft(artifact && source ? { jobId: source.id, artifactId: artifact.id, version: artifact.version, revision: source.revision } : null); if (!artifact) setSteps(current => current.map(step => ({ ...step, source: false }))); }}><option value="">不接续来源</option>{availableSources.map(artifact => <option key={artifact.id} value={artifact.id}>{state?.jobs.find(job => job.id === artifact.job_id)?.request.slice(0, 45)} · 第 {artifact.step_index + 1} 步 · v{artifact.version} · {artifactAgentName(artifact)}</option>)}</select></label>
            {currentJob?.source_artifact_id && sourceDraft && <button disabled={busy} onClick={() => { setSourceDraft(null); setSteps(current => current.map(step => ({ ...step, source: false }))); }}>取消接续关联</button>}
            {sourceArtifact && sourceJob && <div className="wb2-paper"><strong>保存后将发送的固定成果</strong><p>来源事项：{sourceJob.request} · {artifactAgentName(sourceArtifact)} · 第 {sourceArtifact.step_index + 1} 步 · v{sourceArtifact.version} · {localTime(sourceArtifact.accepted_at!)}</p><div className="agent-source-preview"><RichText text={sourceArtifact.content.length > 500 ? `${sourceArtifact.content.slice(0, 500)}…` : sourceArtifact.content} /></div>{sourceArtifact.content.length > 500 && <details><summary>查看完整固定成果</summary><RichText text={sourceArtifact.content} /></details>}</div>}
            {sourceDraft && (!sourceArtifact?.accepted_at || !sourceJob) && <p role="alert">所选成果已不可用，请重新选择已确认版本。</p>}
            {sourceDraft && sourceJob && sourceDraft.revision !== sourceJob.revision && <p role="alert">来源事项已更新，草稿保留。请核对上方固定成果后刷新来源修订。<button onClick={() => setSourceDraft({ ...sourceDraft, revision: sourceJob.revision })}>已核对，使用当前来源修订</button></p>}
            <label>目标标签（可留空）<input maxLength={120} value={targetLabel} onChange={event => setTargetLabel(event.target.value)} placeholder="例如：本周继续" /></label>
            {sourceDraft && <><p>以下每一步明确选择是否接收这份 v{sourceDraft.version} 成果，至少一位 Agent 需要接收。</p>{steps.map((step, index) => { const agent = profiles.find(profile => profile.id === step.agentId); return <label className="inline" key={index}><input type="checkbox" disabled={!agent?.allow_upstream && !step.source} checked={!!step.source} onChange={event => setStep(index, { source: event.target.checked })} /> 第 {index + 1} 步 · {name(step.agentId)}{!agent?.allow_upstream ? "（未获上游权限）" : ""}</label>; })}{!sourceReceivers.length && <p role="alert">请勾选至少一个已获上游权限的接收 Agent。</p>}</>}
            {currentJob && <div className="row"><button className="primary" disabled={busy || !!activeRun || currentJob.lifecycle !== "open" || baseRevision !== currentJob.revision || !sourceScopeDirty || jobRequest !== currentJob.request || jobMaterial !== currentJob.material || !steps.length || steps.some(step => !step.agentId || stepPermissionConflict(step)) || !!sourceDraft && (!sourceArtifact?.accepted_at || !sourceJob || sourceDraft.revision !== sourceJob.revision || !sourceReceivers.length)} onClick={async () => { const saved = await mutate({ type: "job.continuation.update", id: currentJob.id, revision: baseRevision, sourceJobId: sourceDraft?.jobId, sourceArtifactId: sourceDraft?.artifactId ?? null, sourceVersion: sourceDraft?.version, sourceRevision: sourceDraft?.revision, targetLabel, steps: steps.map(step => ({ ...step, source: !!step.source })) }); if (saved) { const entry = saved.state.jobs.find((job: Job) => job.id === currentJob.id); if (entry) { setSteps(parseSteps(entry)); setBaseRevision(entry.revision); setSourceDraft(sourceFor(entry)); setTargetLabel(entry.target_label); } setContinuationEditing(false); setJobDrafts(current => { const next = { ...current }; delete next[currentJob.id]; return next; }); setJobEditorOpen(false); setNotice(sourceDraft ? "接续来源与可见范围已保存" : "接续已取消；历史运行保留"); } }}>保存接续修改</button><button disabled={busy} onClick={() => { setSourceDraft(sourceFor(currentJob)); setTargetLabel(currentJob.target_label); setSteps(parseSteps(currentJob)); setContinuationEditing(false); }}>放弃接续修改</button></div>}
          </div>}
          <label>要完成的事<textarea maxLength={4000} value={jobRequest} onChange={event => setJobRequest(event.target.value)} placeholder="例如：整理这篇虚构短文的摘要" /></label><MarkdownPreview text={jobRequest} />
          {!currentJob && <ItemModelPicker connection={connection ?? null} value={jobModelChoice} onChange={setJobModelChoice} agents={steps.map(step => ({ id: step.agentId, name: name(step.agentId) }))} onOpenConnections={onOpenConnections} />}
          <label>本事项文本资料<textarea maxLength={8000} value={jobMaterial} onChange={event => setJobMaterial(event.target.value)} placeholder="仅获准读取的 Agent 会收到这些资料" /></label><MarkdownPreview text={jobMaterial} />
          {!currentJob && <div className="schedule-fields"><label>计划处理日（可留空）<input type="date" value={newPlanned} onChange={event => setNewPlanned(event.target.value)} /></label><label>截止日（可留空）<input type="date" value={newDue} onChange={event => setNewDue(event.target.value)} /></label>{newPlanned && newDue && newPlanned > newDue && <p role="alert">计划日不能晚于截止日。</p>}</div>}
          <h3>执行步骤</h3>{steps.map((step, index) => <div className="agent-step" id={`agent-step-${index}`} key={index}><div className="row spread"><strong>第 {index + 1} 步</strong><div className="row"><button disabled={index === 0} onClick={() => moveStep(index)}>上移</button><button onClick={() => removeStep(index)}>移除</button></div></div><label>由谁执行<select value={step.agentId} onChange={event => setStep(index, { agentId: event.target.value, upstream: profiles.find(p => p.id === event.target.value)?.allow_upstream ? step.upstream : [], source: event.target.value === step.agentId ? step.source : false })}><option value="">请选择 Agent</option>{profiles.filter(profile => profile.enabled || profile.id === step.agentId).map(profile => <option key={profile.id} value={profile.id}>{name(profile.id)}{profile.enabled ? "" : "（已暂停）"}</option>)}</select></label>{index > 0 && <fieldset className="agent-scopes"><legend>本步可读取哪些上游成果</legend>{steps.slice(0, index).map((earlier, at) => <label className="inline" key={at}><input type="checkbox" disabled={!profiles.find(p => p.id === step.agentId)?.allow_upstream && !step.upstream.includes(at)} checked={step.upstream.includes(at)} onChange={event => setStep(index, { upstream: event.target.checked ? [...step.upstream, at].sort() : step.upstream.filter(dep => dep !== at) })} /> 第 {at + 1} 步 · {name(earlier.agentId)}</label>)}</fieldset>}<p className="muted">{profiles.find(profile => profile.id === step.agentId)?.deliverable || "请选择交付者"}；可见：事项需求{profiles.find(profile => profile.id === step.agentId)?.allow_material ? "、本事项文本资料与纠正" : ""}{step.upstream.length && !stepPermissionConflict(step) ? `、指定上游成果 ${step.upstream.map(dep => dep + 1).join("、")}` : ""}{step.source && !stepPermissionConflict(step) ? `、固定接续成果 v${sourceDraft?.version || currentJob?.source_artifact_version || "?"}` : ""}</p>{stepPermissionConflict(step) && <p role="alert">第 {index + 1} 步仍选中上游或接续来源，但 {name(step.agentId)} 当前未获准读取上游。请取消相关勾选并保存，或到团队页恢复该实例权限。<button onClick={() => openProfile(step.agentId)}>前往团队调整权限</button></p>}</div>)}
          <div className="row"><button disabled={steps.length >= 4 || !profiles.some(profile => profile.enabled)} onClick={() => setSteps(current => [...current, { agentId: profiles.find(profile => profile.enabled && (!sourceDraft || profile.allow_upstream))?.id || profiles.find(profile => profile.enabled)?.id || "", upstream: [], source: false }])}>添加步骤</button><span className="muted">预计 {steps.length} 次模型调用；没有自动收费重试。</span></div>
          {currentJob && baseRevision !== currentJob.revision && <p role="alert">事项已在其他页面更新。草稿保留；请核对最新版本再保存。<details><summary>查看最新保存内容</summary><p>需求：{currentJob.request}</p><div>资料：<RichText text={currentJob.material || "无"} /></div><p>步骤：{parseSteps(currentJob).map((step, index) => `${index + 1}. ${name(step.agentId)}${step.source ? "（接收固定来源）" : ""}`).join(" → ")}</p><p>接续：{currentJob.source_artifact_id ? `成果 v${currentJob.source_artifact_version}` : "无"}；标签：{currentJob.target_label || "无"}</p></details><button onClick={() => setBaseRevision(currentJob.revision)}>已核对，保留草稿并使用当前修订</button><button onClick={() => { setJobRequest(currentJob.request); setJobMaterial(currentJob.material); setSteps(parseSteps(currentJob)); setBaseRevision(currentJob.revision); setSourceDraft(sourceFor(currentJob)); setTargetLabel(currentJob.target_label); setContinuationEditing(false); setJobDrafts(current => { const next = { ...current }; delete next[currentJob.id]; return next; }); }}>载入最新内容</button></p>}
          <button className="primary" disabled={busy || (currentJob?.status === "running") || (currentJob && (currentJob.lifecycle !== "open" || baseRevision !== currentJob.revision || !currentJobDirty || sourceScopeDirty || continuationEditing)) || !jobRequest.trim() || !steps.length || (!currentJob && !!newPlanned && !!newDue && newPlanned > newDue) || steps.some(step => !step.agentId || stepPermissionConflict(step)) || (!currentJob && !!sourceDraft && (!sourceArtifact?.accepted_at || !sourceJob || sourceDraft.revision !== sourceJob.revision || !sourceReceivers.length))} onClick={async () => { const saved = await mutate({ type: currentJob ? "job.update" : sourceDraft ? "job.continue" : "job.create", id: currentJob?.id, revision: baseRevision, request: jobRequest, material: jobMaterial, steps: steps.map(step => ({ ...step, source: !!step.source })), sourceJobId: sourceDraft?.jobId, sourceArtifactId: sourceDraft?.artifactId, sourceVersion: sourceDraft?.version, sourceRevision: sourceDraft?.revision, targetLabel, ...(!currentJob ? { plannedDate: newPlanned || null, dueDate: newDue || null, modelChoice: jobModelChoice } : {}) }); if (saved) { const entry = saved.state.jobs.find((job: Job) => job.id === saved.id); if (entry) { setSelectedJob(entry.id); setJobRequest(entry.request); setJobMaterial(entry.material); setJobModelChoice(parseItemModelSelection(entry.model_choice_json)); setSteps(parseSteps(entry)); setBaseRevision(entry.revision); setSourceDraft(sourceFor(entry)); setTargetLabel(entry.target_label); setContinuationEditing(false); setNewPlanned(""); setNewDue(""); } setJobDrafts(current => { const next = { ...current }; delete next[currentJob?.id || "__new"]; return next; }); setJobEditorOpen(false); setNotice("事项已保存；核对步骤后可启动"); } }}>{currentJob ? "保存修改" : "保存事项"}</button>
        </>
  );

  return <div hidden={!visible} className="agent-workspace">
    {notice && <div className="notice" role="status">{notice}</div>}
    {mode === "team" ? <>
      <div className="wb2-team-heading row spread"><div><div className="kicker">AGENT TEAM</div><h1>Agent 团队</h1><p className="wb2-intro">选择一位 Agent，查看职责、资料范围与偏好，再决定下一步。</p></div><button className="primary" type="button" onClick={createProfile}>＋ 创建 Agent</button></div>
      <div className="wb2-team-layout"><nav className="wb2-team-list" aria-label="选择 Agent"><div className="row spread"><h2>我的 Agent</h2><span className="muted">{profiles.length} 位</span></div>
        {profiles.map(profile => <button type="button" className="wb2-team-item" id={`agent-profile-${profile.id}`} key={profile.id} aria-current={teamPanel !== "create" && selectedAgentId === profile.id ? "true" : undefined} onClick={event => { if (teamPanel === "edit" || teamPanel === "create") stashProfileDraft(); setSelectedAgentId(profile.id); setTeamPanel("overview"); setAgentFilter(null); setRecentJobsOnly(false); event.currentTarget.scrollIntoView({ block: "nearest", inline: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }}><span className="wb2-team-item-top"><strong>{name(profile.id)}</strong><span className="tag">{profile.enabled ? "可参与" : "已暂停"}</span></span><span className="wb2-team-item-sub">{profile.deliverable}</span></button>)}
        {!profiles.length && <p className="empty">还没有 Agent。创建一位后即可在事项中安排。</p>}
      </nav><div className="wb2-team-main">
      {(teamPanel === "create" || teamPanel === "edit") ? <section className="wb2-team-panel" id="agent-profile-editor" aria-label={profileForm.id ? `编辑 ${profileForm.name}` : "创建 Agent"}><div className="row spread"><div><div className="kicker">{profileForm.id ? "EDIT AGENT" : "NEW AGENT"}</div><h2>{profileForm.id ? `编辑 ${profileForm.name}` : "创建 Agent"}</h2></div><button type="button" onClick={() => { stashProfileDraft(); setTeamPanel("overview"); }}>保留草稿并返回</button></div><p className="muted">先定义职责和交付物，资料范围只控制该 Agent 在事项运行时能读取什么。</p>
        {!profileForm.id && <label>从配置开始<select value={templateId} onChange={event => { const id = event.target.value; setTemplateId(id); const template = profiles.find(profile => profile.id === id); setProfileForm(template ? { ...profileDraft(template), id: "", revision: 0, name: `${template.name}副本` } : emptyProfile()); }}><option value="">空白配置</option>{profiles.filter(profile => profile.template).map(profile => <option key={profile.id} value={profile.id}>{profile.name}模板</option>)}</select></label>}
        <label>名称<input maxLength={60} value={profileForm.name} onChange={event => setProfileForm({ ...profileForm, name: event.target.value })} placeholder="例如：阅读伙伴" /></label>
        <label>职责与任务指令<textarea maxLength={4000} value={profileForm.instructions} onChange={event => setProfileForm({ ...profileForm, instructions: event.target.value })} placeholder="怎样处理事项、如何判断不确定信息" /></label><MarkdownPreview text={profileForm.instructions} />
        <label>预期交付物<input maxLength={500} value={profileForm.deliverable} onChange={event => setProfileForm({ ...profileForm, deliverable: event.target.value })} placeholder="例如：短文摘要与待核对点" /></label>
        <fieldset className="agent-scopes"><legend>实际可用资料范围 · 能力仅为模型文本处理</legend><label className="inline"><input type="checkbox" checked={profileForm.allowMaterial} onChange={event => setProfileForm({ ...profileForm, allowMaterial: event.target.checked })} /> 当前事项的文本资料与纠正</label><label className="inline"><input type="checkbox" checked={profileForm.allowUpstream} onChange={event => setProfileForm({ ...profileForm, allowUpstream: event.target.checked })} /> 显式选择的上游成果</label></fieldset>
        {profileChanged && <p role="alert">配置已在别处更新，当前草稿已保留。<button onClick={() => { const latest = profiles.find(entry => entry.id === profileForm.id); if (latest) { setProfileForm(profileDraft(latest)); setProfileDrafts(current => { const next = { ...current }; delete next[latest.id]; return next; }); } }}>载入最新配置</button></p>}
        <div className="row wb2-team-actions"><button className="primary" disabled={busy || profileChanged || !profileForm.name.trim() || !profileForm.instructions.trim() || !profileForm.deliverable.trim()} onClick={async () => { const saved = await mutate({ type: profileForm.id ? "profile.update" : "profile.create", ...profileForm }); if (saved) { setProfileDrafts(current => { const next = { ...current }; delete next[profileForm.id || "__new"]; return next; }); setSelectedAgentId(saved.id); setTeamPanel("overview"); setProfileForm(emptyProfile()); setTemplateId(""); setNotice("Agent 已保存，可在新事项中选择"); } }}>{profileForm.id ? "保存配置" : "创建 Agent"}</button><button type="button" onClick={() => { setProfileDrafts(current => { const next = { ...current }; delete next[profileForm.id || "__new"]; return next; }); setProfileForm(emptyProfile()); setTemplateId(""); }}>清空表单</button></div>
      </section> : selectedTeamProfile ? teamPanel === "history" ? <div className="wb2-team-panel"><div className="row spread"><h2>{name(selectedTeamProfile.id)} · 运行记录</h2><button type="button" onClick={() => setTeamPanel("overview")}>返回概览</button></div>{selectedMetricAgent ? agentDetailSection : <p className="empty">暂无自定义 Agent 事项运行记录。快捷事项的成果与练习在“我的事项”中查看。</p>}</div> : <section className="wb2-team-panel" aria-label={`${name(selectedTeamProfile.id)}概览`}><div className="row spread wb2-team-profile-head"><div><div className="kicker">{selectedTeamProfile.template ? "内置预设" : "自定义 Agent"}</div><h2>{name(selectedTeamProfile.id)}</h2></div><span className="tag">{selectedTeamProfile.enabled ? "可参与" : "已暂停"}</span></div><div className="wb2-team-deliverable"><span>交付：</span><RichText text={selectedTeamProfile.deliverable} /></div><div className="row wb2-team-actions"><button type="button" className="primary" disabled={!selectedTeamProfile.enabled} onClick={() => startJobWithAgent(selectedTeamProfile.id)}>用这位 Agent 创建事项 →</button><button type="button" onClick={() => chooseProfile(selectedTeamProfile)}>编辑配置</button><button type="button" disabled={busy} onClick={async () => { const saved = await mutate({ type: "profile.enabled", id: selectedTeamProfile.id, enabled: !selectedTeamProfile.enabled, revision: selectedTeamProfile.revision }); if (saved) setNotice(selectedTeamProfile.enabled ? "已暂停；运行中的结果会丢弃，恢复后需手动继续" : "已恢复；不会自动启动事项"); }}>{selectedTeamProfile.enabled ? "暂停 Agent" : "恢复 Agent"}</button></div><div className="wb2-team-summary"><div><h3>职责</h3><RichText text={selectedTeamProfile.instructions} /></div><div><h3>可读取资料</h3><ul><li>事项需求</li>{selectedTeamProfile.allow_material ? <li>当前事项文本与纠正</li> : null}{selectedTeamProfile.allow_upstream ? <li>显式选择的上游成果</li> : null}</ul><p className="muted">权限只影响后续运行；既有成果保留历史快照。</p></div></div><div className="wb2-team-recent row spread"><div><h3>最近活动</h3><p className="muted">{selectedMetricAgent?.lastActivityAt ? localTime(selectedMetricAgent.lastActivityAt) : "尚无自定义 Agent 事项运行记录"}</p></div><button type="button" onClick={() => setTeamPanel("history")}>查看事项与历史 →</button></div>{modelSection}{preferenceSection}</section> : <section className="wb2-team-panel"><h2>选择一位 Agent</h2><p className="muted">从左侧选择，或创建新的 Agent。</p></section>}
      </div></div>
      <details className="wb2-team-analytics wb2-section" open={teamAnalyticsOpen} onToggle={event => setTeamAnalyticsOpen(event.currentTarget.open)}><summary>团队运行统计与趋势 <span className="muted">仅统计自定义 Agent 事项</span></summary>{teamAnalyticsOpen && <>{teamMetricsSection}<TrendPanel visible={visible && teamAnalyticsOpen} stateSignature={stateSignature} onOpenJob={openMetricJob} /></>}</details>
    </> : <>
      <div className="kicker">AGENT WORK</div><div className="row spread"><div><h1>{currentJob ? currentJob.request : "把事项交给 Agent"}</h1><p className="wb2-intro">{currentJob ? `自定义 Agent 事项 · ${status(currentJob)}` : "选择参与者与顺序，明确交给后一步的成果。每步一次模型调用，失败后由你手动继续。"}</p></div><div className="row">{currentJob && <button type="button" onClick={() => { setJobEditorOpen(true); requestAnimationFrame(() => document.getElementById("agent-job-editor")?.scrollIntoView({ block: "start" })); }}>编辑事项</button>}<button ref={contextButton} type="button" aria-controls="agent-job-context" aria-expanded={contextOpen} onClick={() => setContextOpen(open => !open)}>{contextOpen ? "关闭侧栏" : currentJob ? "事项信息" : "已有事项"}</button></div></div>
      <div className="wb2-workspace"><div>
        {!currentJob && <div className="wb2-card" id="agent-job-editor">{jobEditor}</div>}
        {currentJob && <>
          <div className="wb2-card"><div className="row spread"><h2>运行与成果</h2><span className="tag">{status(currentJob)}</span></div>
            <p>当前共 {jobSteps.length} 步；{currentJob.lifecycle === "archived" ? "已归档，历史版本在下方" : currentJob.lifecycle === "completed" ? "已完成，成果按核对时版本展示" : activeRun ? `第 ${activeRun.step_index + 1} 步执行中` : pending < 0 ? "全部当前成果已生成" : `第 ${pending + 1} 步待运行`}。</p>
            <ItemModelPicker connection={connection ?? null} value={currentJobChoice} onChange={async choice => { if (await mutate({ type: "model.update", id: currentJob.id, modelChoice: choice, modelRevision: currentJob.model_revision })) setNotice("本事项模型选择已保存；仅影响后续运行"); }} agents={jobSteps.map(step => ({ id: step.agentId, name: name(step.agentId) }))} onOpenConnections={onOpenConnections} disabled={busy || !!activeRun || currentJob.lifecycle !== "open"} />
            {currentJob.lifecycle === "open" && !activeRun && pendingPaused && <p role="status">第 {pending + 1} 步由 {name(pendingProfile!.id)} 执行，该 Agent 已暂停。请先到团队页恢复，再回到此事项手动继续；恢复不会自动启动模型。<button onClick={() => { setRestoreTarget(pendingProfile!.id); onOpenTeam(); }}>前往 Agent 团队恢复</button></p>}
            {currentJob.lifecycle === "open" && !activeRun && pendingPermissionConflict && <p role="status">第 {pending + 1} 步由 {name(pendingProfile!.id)} 执行，但该 Agent 已关闭上游成果权限，事项仍保留旧的上游或接续来源。请在事项编辑中取消相应勾选并保存，或到团队页恢复权限；之后再手动继续。<button onClick={() => { setJobEditorOpen(true); requestAnimationFrame(() => document.getElementById(`agent-step-${pending}`)?.scrollIntoView({ block: "center" })); }}>查看步骤依赖</button><button onClick={() => openProfile(pendingProfile!.id)}>前往团队调整权限</button></p>}
            {latestFailedRun?.error && <p role="alert">第 {latestFailedRun.step_index + 1} 步失败：{latestFailedRun.error}</p>}
            {pendingConfirmations > 0 && <p role="status">{pendingConfirmations} 份当前成果待你确认；请先核对下方成果。</p>}
            {(currentJobDirty || baseRevision !== currentJob.revision) && <p role="status">事项编辑草稿尚未保存或已过期。<button type="button" onClick={() => { setJobEditorOpen(true); requestAnimationFrame(() => document.getElementById("agent-job-editor")?.scrollIntoView({ block: "start" })); }}>查看并处理草稿</button></p>}
            <div className="row"><button className="primary" disabled={busy || !!activeRun || currentJob.lifecycle !== "open" || pending < 0 || pendingPermissionConflict || !profiles.find(profile => profile.id === jobSteps[pending]?.agentId)?.enabled || !modelReadyForAgent(connection ?? null, jobSteps[pending]?.agentId, currentJobChoice) || baseRevision !== currentJob.revision || currentJobDirty} onClick={async () => { if (await mutate({ type: "job.start", id: currentJob.id, revision: currentJob.revision, requestId: crypto.randomUUID() })) setNotice("运行已启动；页面将更新结果"); }}>开始或手动继续</button>{activeRun && <button disabled={busy} onClick={() => mutate({ type: "job.cancel", runId: activeRun.id })}>取消运行</button>}</div>
            {activeRun && <RunLivePreview runId={activeRun.id} />}
            {pending >= 0 && !modelReadyForAgent(connection ?? null, jobSteps[pending]?.agentId, currentJobChoice) && <p className="muted">下一步所选模型尚未连接。请在本事项中改选，或到设置中连接对应渠道。</p>}
            <div className="row"><button disabled={busy || !!activeRun || currentJob.lifecycle !== "open" || currentArtifacts.some(artifact => !artifact?.accepted_at)} onClick={() => mutate({ type: "job.complete", id: currentJob.id, revision: currentJob.revision })}>完成事项</button><button disabled={busy || !!activeRun || currentJob.lifecycle === "archived"} onClick={() => mutate({ type: "job.archive", id: currentJob.id, revision: currentJob.revision })}>归档</button>{currentJob.lifecycle !== "open" && <button disabled={busy} onClick={() => mutate({ type: "job.reopen", id: currentJob.id, revision: currentJob.revision })}>重新打开</button>}</div>
            {visibleStepIndexes.map(index => { const step = jobSteps[index]; const current = currentArtifacts[index]; return <div className="wb2-artifact" key={index}><h3>第 {index + 1} 步 · {name(step.agentId)}</h3><p className="muted">交接：{[step.source && currentJob.source_artifact_version ? `固定接续成果 v${currentJob.source_artifact_version}` : "", ...step.upstream.map(dep => `第 ${dep + 1} 步`)].filter(Boolean).join("、") || "无"}</p>{stepPermissionConflict(step) && <p role="status">当前 {name(step.agentId)} 不可读取已选上游成果；请在事项编辑中取消旧依赖并保存，或到团队页恢复权限。<button onClick={() => openProfile(step.agentId)}>前往团队调整权限</button></p>}{current ? <><p>当前成果 v{current.version} · {current.created_at}</p>{!current.accepted_at && <button disabled={busy || !!activeRun} onClick={() => mutate({ type: "job.accept", id: currentJob.id, revision: currentJob.revision, artifactId: current.id })}>确认这份成果</button>}<div className="wb2-paper"><RichText text={current.content} /></div><p className="muted">使用配置：{(JSON.parse(current.config_json) as { name: string }).name}；上游来源：{sources(current.upstream_json)}</p>{current.accepted_at && <div className="row"><span className="tag">已核对</span><button onClick={() => startContinuation(current)}>以这份已确认成果新建后续事项</button></div>}</> : <p className="muted">当前配置或资料下尚无有效成果。</p>}</div>; })}
            <section className="wb2-section"><details id="agent-job-history"><summary>全部成果历史（{state?.artifacts.filter(artifact => artifact.job_id === currentJob.id).length || 0}）</summary><p className="muted">历史按生成时的步骤与 Agent 配置记录；移除或重排步骤后仍可查阅。</p>{state?.artifacts.filter(artifact => artifact.job_id === currentJob.id).map(artifact => <div className="wb2-version" key={artifact.id}><strong>第 {artifact.step_index + 1} 步 · v{artifact.version} · {(JSON.parse(artifact.config_json) as { name: string }).name} · {artifact.created_at}</strong><p>{currentIds.includes(artifact.id) ? "当前成果" : "历史版本"} · 上游来源：{sources(artifact.upstream_json)}</p><div className="wb2-paper"><RichText text={artifact.content} /></div><p>{artifact.accepted_at ? `已于 ${localTime(artifact.accepted_at)} 确认` : "尚未确认"}</p>{artifact.accepted_at && <button onClick={() => startContinuation(artifact)}>以此 v{artifact.version} 新建后续事项</button>}</div>)}{!state?.artifacts.some(artifact => artifact.job_id === currentJob.id) && <p className="empty">暂无成果历史。</p>}</details></section>
          </div>
          <details className="wb2-card agent-job-edit" id="agent-job-editor" open={jobEditorOpen} onToggle={event => setJobEditorOpen(event.currentTarget.open)}><summary>修改需求、交接与步骤{currentJobDirty ? " · 有未保存草稿" : ""}</summary>{jobEditor}</details>
          <div className="wb2-card" id="agent-job-corrections"><h2>纠正与记忆</h2><p className="muted">最多 12 条有效纠正、合计 8000 字。停用旧纠正会保留历史，并使相关成果待更新。</p><label>明确纠正<textarea maxLength={2000} value={correction} onChange={event => setCorrectionDrafts(current => ({ ...current, [currentJob.id]: event.target.value }))} /></label><MarkdownPreview text={correction} /><button disabled={busy || !!activeRun || currentJob.lifecycle !== "open" || !correction.trim() || currentJobDirty} onClick={async () => { const submitted = correction; if (await mutate({ type: "job.correct", id: currentJob.id, revision: currentJob.revision, text: submitted })) setCorrectionDrafts(current => { if (current[currentJob.id] !== submitted) return current; const next = { ...current }; delete next[currentJob.id]; return next; }); }}>保存纠正</button>{state?.corrections.filter(entry => entry.job_id === currentJob.id).map(entry => <div className="simple-row" key={entry.id}><div>修订 {entry.revision} · {entry.active ? "有效" : "已停用"}：<RichText text={entry.text} /></div>{!!entry.active && currentJob.lifecycle === "open" && <button disabled={busy || !!activeRun || currentJobDirty} onClick={() => mutate({ type: "job.correction.archive", id: currentJob.id, correctionId: entry.id, revision: currentJob.revision })}>停用这条纠正</button>}</div>)}</div>
        </>}
      </div>{contextOpen && <button tabIndex={-1} className="wb2-context-backdrop" aria-label="关闭事项信息" onClick={() => { setContextOpen(false); contextButton.current?.focus(); }} />}<aside ref={contextPanel} className="wb2-aside agent-job-aside" id="agent-job-context" data-open={contextOpen} role={contextOpen ? "dialog" : undefined} aria-modal={contextOpen || undefined} aria-label={currentJob ? "当前事项信息" : "已有 Agent 事项"}><div className="wb2-context-heading"><h2>{currentJob ? "事项信息" : "已有事项"}</h2><button type="button" onClick={() => { setContextOpen(false); contextButton.current?.focus(); }}>关闭</button></div>
        {currentJob && <><p className="muted">{status(currentJob)} · {jobSteps.length} 步</p>
          <ol>{jobSteps.map((step, index) => <li key={index}>第 {index + 1} 步 · {name(step.agentId)} · {currentArtifacts[index] ? currentArtifacts[index]?.accepted_at ? "成果已确认" : "成果待确认" : activeRun?.step_index === index ? "运行中" : "待运行"}</li>)}</ol>
          <ScheduleEditor key={currentJob.id} entry={currentJob} endpoint="/api/agent-work" onState={acceptScheduleState} compact />
          <details><summary>资料与接续</summary><div>本事项资料：<RichText text={currentJob.material || "未提供"} /></div>{currentJob.source_job_id ? <p>固定引用 <button onClick={() => { const parent = state?.jobs.find(job => job.id === currentJob.source_job_id); if (parent) chooseJob(parent); }}>{state?.jobs.find(job => job.id === currentJob.source_job_id)?.request || "历史事项"}</button> 的已确认成果 v{currentJob.source_artifact_version}；目标标签：{currentJob.target_label || "未设置"}。来源后续更新不会替换此版本。</p> : <p>没有接续来源。</p>}{state?.jobs.filter(job => job.source_job_id === currentJob.id).map(child => <p key={child.id}>后续事项：<button onClick={() => chooseJob(child)}>{child.request}</button> · 引用 v{child.source_artifact_version} · 标签 {child.target_label || "未设置"}</p>)}</details>
          <button type="button" onClick={() => { const history = document.getElementById("agent-job-history") as HTMLDetailsElement | null; if (history) { history.open = true; history.scrollIntoView({ block: "start" }); } }}>查看成果历史</button>
          <button type="button" onClick={() => document.getElementById("agent-job-corrections")?.scrollIntoView({ block: "start" })}>纠正与记忆</button>
        </>}
        <details open={!currentJob}><summary>已有事项（{state?.jobs.length || 0}）</summary>{state?.jobs.map(entry => <div className="simple-row" key={entry.id}><strong>{entry.request}</strong><p>{status(entry)} · {parseSteps(entry).map(step => name(step.agentId)).join(" → ")}</p><button onClick={() => chooseJob(entry)}>打开事项</button></div>)}{!state?.jobs.length && <p className="empty">尚无 Agent 事项。</p>}</details>{currentJob && <details><summary>运行来源（{state?.runs.filter(run => run.job_id === currentJob.id).length || 0}）</summary>{state?.runs.filter(run => run.job_id === currentJob.id).map(run => <div className="wb2-run" key={run.id}><strong>第 {run.step_index + 1} 步 · {run.status}</strong><p>{run.model} · {run.created_at}</p>{run.error && <p>{run.error}</p>}<details><summary>本次使用的资料</summary>{(() => { const context = parseRunContext(run.context_json); return context ? <><p>执行 Agent：{context.agentName || "未知"}</p><div>当时职责：<RichText text={context.instructions || "无"} /></div><div>预期交付物：<RichText text={context.deliverable || "无"} /></div><p>事项需求：{context.request || "无"}</p><div>事项资料：<RichText text={context.material || "未授权或未提供"} /></div><div>有效纠正：<RichText text={context.corrections?.map(entry => entry.text).join("\n\n") || "无"} /></div><div>实例偏好：<RichText text={context.preferences?.map(entry => entry.text).join("\n\n") || "无"} /></div><div>上游成果：{context.upstream?.length ? context.upstream.map((entry, index) => { const source = state?.artifacts.find(artifact => artifact.id === entry.id); const origin = source && state?.jobs.find(job => job.id === source.job_id); return <div key={`${entry.id || index}-${entry.version}`}><strong>{source && source.job_id !== currentJob.id ? `跨事项来源「${origin?.request || "历史事项"}」` : `本事项第 ${entry.stepIndex + 1} 步`} v{entry.version}</strong><RichText text={entry.content} /></div>; }) : "无"}</div></> : <p>输入快照无法读取</p>; })()}</details></div>)}</details>}</aside></div>
    </>}
  </div>;
}
