"use client";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import AgentWorkspace, { ScheduleEditor, hasUnsavedScheduleDrafts, type AgentState } from "./AgentWorkspace";
import CompactItemList from "./CompactItemList";
import IntegratedSchedule from "./IntegratedSchedule";
import MemoryWorkspace from "./MemoryWorkspace";
import RichText, { MarkdownPreview } from "./RichText";
import WorkspaceSettings, { type SettingsConnection, type SettingsSection } from "./WorkspaceSettings";
import { modelReadyForAgent } from "./ModelConnectionsPanel";
import ItemModelPicker, { parseItemModelSelection } from "./ItemModelPicker";
import RunLivePreview from "./RunLivePreview";
import type { ItemModelSelection } from "./ModelConnectionsPanel";

type Role = "career" | "english";
type Item = { id: string; request: string; material: string; english_requirement: string; roles: string; priority: number; minutes: number; revision: number; career_revision: number; english_revision: number; status: string; lifecycle: "open" | "completed" | "archived"; planned_date: string | null; due_date: string | null; schedule_revision: number; source_context_json: string; model_choice_json: string; model_revision: number; created_at: string; updated_at: string };
type LinkedSource = { kind: "quick" | "agent"; itemId: string; title: string; producer?: string; artifactId: string; version: number; content: string; practice: { id: string; question: string; answer: string; feedback: string; suggestion: string } | null };
type Artifact = { id: string; item_id: string; role: Role; version: number; revision: number; content: string; run_id: string; upstream_artifact_id: string | null; accepted_at: string | null; created_at: string; current?: boolean };
type Run = { id: string; item_id: string; role: Role; status: string; model: string; revision: number; context_json: string; upstream_artifact_id: string | null; error: string | null; created_at: string };
type Fact = { id: string; item_id: string; text: string; source: string; revision: number };
type Preference = { id: string; role: Role; text: string; active: number };
type Practice = { id: string; item_id: string; role: Role; source_artifact_id: string; question: string | null; question_options_json?: string | null; answer: string | null; feedback: string | null; suggestion: string | null; status: string; created_at: string };
type PracticeRun = { id: string; practice_id: string; kind: "prepare" | "feedback"; status: string; model: string; context_json: string; error: string | null; created_at: string };
export type WorkState = { items: Item[]; artifacts: Artifact[]; runs: Run[]; facts: Fact[]; preferences: Preference[]; practices: Practice[]; practiceRuns: PracticeRun[] };
type Agent = { id: string; name: string; role: string; enabled: number; preference: string; permission: string };
type OldState = { agents: Agent[]; goals: unknown[]; tasks: unknown[]; runs: unknown[]; memories: unknown[] };
type Connection = SettingsConnection;
type AgentJob = AgentState["jobs"][number];
type View = "home" | "items" | "week" | "item" | "team" | "agentJobs" | "memory" | "connection";
const roleName: Record<Role, string> = { career: "求职顾问", english: "英语教练" };
const statusName: Record<string, string> = { planned: "待开始协作", limited: "当前能力范围外", running: "执行中", waiting: "待继续", ready: "待你核对", failed: "失败，可重试", cancelled: "已取消", interrupted: "运行中断" };
const lifecycleName = { open: "进行中", completed: "已完成", archived: "已归档" };
const runStatusName: Record<string, string> = { running: "执行中", success: "已成功", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
function quickAutoCancelled(item: Item, work: WorkState | null) {
  if (item.status !== "cancelled") return false;
  const latest = work?.runs.find(run => run.item_id === item.id);
  return latest?.status === "cancelled" && !latest.error?.startsWith("用户取消");
}
function nextAction(item: Item, work: WorkState | null) {
  if (item.lifecycle === "completed") return "事项已完成；成果、作答和反馈可在下方查看";
  if (item.lifecycle === "archived") return "事项已归档；成果、作答和反馈仍保留在历史中";
  const current = asRoles(item).map(role => recentArtifact(work?.artifacts || [], item, role)).filter((artifact): artifact is Artifact => !!artifact);
  if (item.status === "ready" && current.length < asRoles(item).length) return "Agent 配置或资料权限已变化，请更新成果；原版本仍在历史中";
  const rounds = currentPracticeRounds(item, work);
  const actions = rounds.filter(({ round }) => ["failed", "interrupted", "question"].includes(round.status))
    .sort((a, b) => (a.round.status === "question" ? 1 : 0) - (b.round.status === "question" ? 1 : 0))
    .map(({ role, round }) => `${roleName[role]}：${round.status === "question" ? "题目待回答" : round.status === "interrupted" ? "反馈或题目中断，需手动恢复" : "反馈或题目失败，需手动恢复"}`);
  if (actions.length) {
    const missing = asRoles(item).filter(role => !recentArtifact(work?.artifacts || [], item, role));
    return `${actions.join("；")}${missing.length ? `；${missing.map(role => `${roleName[role]}成果待生成`).join("、")}` : ""}${current.some(artifact => !artifact.accepted_at) ? "；成果仍待核对" : ""}`;
  }
  if (item.status === "ready") {
    if (rounds.some(({ round }) => round.status === "feedback")) return current.some(artifact => !artifact.accepted_at) ? "反馈已保存，可开始下一轮练习；成果仍待核对" : "反馈已保存，可开始下一轮练习或完成事项";
    if (current.some(artifact => !artifact.accepted_at)) return "核对成果，确认后可完成事项";
    return "成果已核对，可开始练习或完成事项";
  }
  if (item.status === "waiting") return "查看受阻原因，确认角色可用后手动继续";
  if (item.status === "failed") return "查看失败原因并手动重试";
  if (item.status === "interrupted") return "重新连接模型后手动继续";
  if (item.status === "limited") return "尚未选择参与 Agent；打开事项补充分工，或新建自选 Agent 事项";
  if (quickAutoCancelled(item, work)) return "Agent 配置或权限已变化，请检查后手动继续";
  return statusName[item.status] || item.status;
}
function timePlan(minutes: number) {
  const verify = Math.min(10, Math.max(3, Math.floor(minutes / 4)));
  const practice = Math.min(15, Math.max(4, Math.floor(minutes / 2)));
  return `建议先用 ${verify} 分钟核对关键事实，再用 ${practice} 分钟做一轮练习或试用，剩余 ${minutes - verify - practice} 分钟记录修改。时间不足时先完成一轮，把其他练习留到下次；这是本地规则建议。`;
}
function runMinutes(run: Run | undefined) {
  if (!run) return null;
  try { const value = JSON.parse(run.context_json).minutes; return typeof value === "number" ? value : null; }
  catch { return null; }
}
const nav: { id: View; name: string; mark: string }[] = [{ id: "home", name: "工作台", mark: "⌂" }, { id: "items", name: "我的事项", mark: "▤" }, { id: "week", name: "日程与数据", mark: "◫" }, { id: "team", name: "Agent 团队", mark: "◇" }, { id: "memory", name: "资料与记忆", mark: "▦" }];
function localDateKey(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function earliestDate(planned: string | null, due: string | null) { return [planned, due].filter((value): value is string => !!value).sort()[0] || "9999-12-31"; }
function normalizedLifecycle(value: string): "open" | "completed" | "archived" { return value === "completed" ? "completed" : value === "archived" ? "archived" : "open"; }
async function readJson(response: Response) { const data = await response.json(); if (!response.ok) throw new Error(data.error || "请求失败"); return data; }
function suggestRoles(text: string): Role[] {
  const career = /求职|面试|岗位|简历|招聘|职业|工作机会|job|career|interview|resume|cv\b/i.test(text);
  const english = /英语|英文|口语|写作|雅思|托福|翻译|english|speaking|writing|translate|introduction/i.test(text);
  return [career && "career", english && "english"].filter(Boolean) as Role[];
}
function asRoles(item: Item): Role[] { try { const saved = JSON.parse(item.roles) as Role[]; return (["career", "english"] as Role[]).filter(role => saved.includes(role)); } catch { return []; } }
function recentArtifact(artifacts: Artifact[], item: Item, role: Role) {
  const revision = role === "career" ? item.career_revision : item.english_revision;
  const artifact = artifacts.find(a => a.item_id === item.id && a.role === role && a.revision === revision && a.current !== false);
  if (role !== "english" || !artifact) return artifact;
  if (artifact.current === true) return artifact;
  if (asRoles(item).includes("career")) return artifact.upstream_artifact_id === artifacts.find(a => a.item_id === item.id && a.role === "career" && a.revision === item.career_revision && a.current !== false)?.id ? artifact : undefined;
  return artifact.upstream_artifact_id ? undefined : artifact;
}
function currentPracticeRounds(item: Item, work: WorkState | null) {
  return asRoles(item).flatMap(role => {
    const artifact = recentArtifact(work?.artifacts || [], item, role);
    const round = work?.practices.find(entry => entry.item_id === item.id && entry.role === role);
    return artifact && round?.source_artifact_id === artifact.id ? [{ role, round }] : [];
  });
}
function questionOptions(round: Practice): { label: string; text: string }[] {
  if (!round.question_options_json) return [];
  try {
    const parsed: unknown = JSON.parse(round.question_options_json);
    if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 8) return [];
    const options = parsed.filter((value): value is { label: string; text: string } => typeof value === "object" && value !== null && typeof value.label === "string" && typeof value.text === "string" && !!value.label.trim() && !!value.text.trim());
    return options.length === parsed.length && new Set(options.map(option => option.label)).size === options.length ? options : [];
  } catch { return []; }
}
function displayPracticeQuestion(round: Practice) {
  const question = round.question || "";
  if (!question || question.includes("\n") || questionOptions(round).length) return question;
  const labels = [...question.matchAll(/[？?；;]\s*([A-D])[.．、]\s*/g)].map(match => match[1]);
  if (labels.length < 3 || labels.some((label, index) => label !== String.fromCharCode(65 + index))) return question;
  return question.replace(/([？?；;])\s*([A-D])[.．、]\s*/g, (_match, delimiter: string, label: string) => `${label === "A" ? `${delimiter}\n\n` : "\n"}- **${label}.** `);
}
function unfinishedPracticeRounds(item: Item, work: WorkState | null) {
  return currentPracticeRounds(item, work).filter(({ round }) => ["question", "failed", "interrupted"].includes(round.status) || (round.status === "cancelled" && !!(round.question || round.answer)));
}
function itemStatusLabel(item: Item, work: WorkState | null) {
  if (item.lifecycle !== "open") return lifecycleName[item.lifecycle];
  if (item.status === "ready" && asRoles(item).some(role => !recentArtifact(work?.artifacts || [], item, role))) return "Agent 配置已变化，成果待更新";
  if (currentPracticeRounds(item, work).some(({ round }) => ["question", "failed", "interrupted"].includes(round.status))) return "有待处理练习";
  if (item.status === "ready" && asRoles(item).length > 0 && asRoles(item).every(role => recentArtifact(work?.artifacts || [], item, role)?.accepted_at)) return "成果已核对，可完成";
  if (quickAutoCancelled(item, work)) return "配置变化，需手动继续";
  return item.status === "limited" ? "未选参与 Agent" : statusName[item.status] || item.status;
}
function agentJobStatus(job: AgentJob, state: AgentState) {
  if (job.lifecycle === "completed") return "已完成";
  if (job.lifecycle === "archived") return "已归档";
  if (state.runs.some(run => run.job_id === job.id && run.status === "running")) return "执行中";
  const ids = state.current[job.id] || [];
  const pending = ids.findIndex(id => !id);
  const step = pending >= 0 ? parseAgentSteps(job)[pending] : undefined;
  const blocked = step && state.profiles.find(profile => profile.id === step.agentId)?.enabled === 0;
  if (blocked) return `第 ${pending + 1} 步受阻：${state.profiles.find(profile => profile.id === step.agentId)?.name}已暂停；到 Agent 团队恢复后手动继续`;
  const permissionConflict = step && (step.upstream.length > 0 || step.source) && state.profiles.find(profile => profile.id === step.agentId)?.allow_upstream === 0;
  if (permissionConflict) return `第 ${pending + 1} 步受阻：${state.profiles.find(profile => profile.id === step.agentId)?.name}已关闭上游成果权限；请在事项中取消旧依赖并保存，或到 Agent 团队恢复权限`;
  const current = ids.map(id => state.artifacts.find(artifact => artifact.id === id));
  if (ids.length && ids.every(Boolean)) return current.every(artifact => !!artifact?.accepted_at) ? "成果已核对，可完成" : "成果待核对";
  if (job.status === "failed") return "失败，需手动继续";
  if (job.status === "interrupted") return "中断，需手动继续";
  if (job.status === "cancelled") return state.runs.find(run => run.job_id === job.id && run.status === "cancelled")?.error?.startsWith("用户取消") ? "已取消，需手动继续" : "运行已取消，需手动继续";
  if (job.status === "waiting") return "有步骤待继续";
  if (state.artifacts.some(artifact => artifact.job_id === job.id)) return "成果待更新";
  return "待开始";
}
function parseAgentSteps(job: AgentJob): { agentId: string; upstream: number[]; source?: boolean }[] {
  try { return JSON.parse(job.steps_json) as { agentId: string; upstream: number[]; source?: boolean }[]; } catch { return []; }
}
function agentNeedsAttention(job: AgentJob, state: AgentState) {
  if (job.lifecycle !== "open") return false;
  const status = agentJobStatus(job, state);
  return status !== "待开始" && status !== "执行中" && status !== "已取消，需手动继续";
}
function localTime(value: string) {
  const date = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(" ", "T")}Z` : value);
  return Number.isNaN(date.getTime()) ? "时间不可用" : date.toLocaleString();
}
export default function WorkbenchV2() {
  const [view, setView] = useState<View>("home");
  const [detailPane, setDetailPane] = useState<"work" | "results" | "history">("work");
  const [expandedTitleId, setExpandedTitleId] = useState("");
  const [itemId, setItemId] = useState("");
  const [sourceChoice, setSourceChoice] = useState("");
  const [work, setWork] = useState<WorkState | null>(null);
  const [agentWork, setAgentWork] = useState<AgentState | null>(null);
  const [openAgentRequest, setOpenAgentRequest] = useState<{ id: string; nonce: number } | null>(null);
  const openAgentNonce = useRef(0);
  const [old, setOld] = useState<OldState | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [request, setRequest] = useState("");
  const [createVisible, setCreateVisible] = useState(false);
  const [createExpanded, setCreateExpanded] = useState(false);
  const [createMode, setCreateMode] = useState<"quick" | "custom">("quick");
  const [createModeTouched, setCreateModeTouched] = useState(false);
  const [agentStartDraft, setAgentStartDraft] = useState<{ text: string; modelChoice: ItemModelSelection | null; nonce: number } | null>(null);
  const agentDraftNonce = useRef(0);
  const [contextOpen, setContextOpen] = useState(false);
  const [quickEditorOpen, setQuickEditorOpen] = useState(false);
  const [material, setMaterial] = useState("");
  const [createModelChoice, setCreateModelChoice] = useState<ItemModelSelection | null>(null);
  const [newPlanned, setNewPlanned] = useState("");
  const [newDue, setNewDue] = useState("");
  const [calendarToday, setCalendarToday] = useState<Date | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [rolesTouched, setRolesTouched] = useState(false);
  const [priority, setPriority] = useState(3);
  const [minutes, setMinutes] = useState(45);
  const [itemMaterial, setItemMaterial] = useState("");
  const [itemRequest, setItemRequest] = useState("");
  const [itemEnglishRequirement, setItemEnglishRequirement] = useState("");
  const [itemEditRoles, setItemEditRoles] = useState<Role[]>([]);
  const [itemMinutes, setItemMinutes] = useState(45);
  const [itemPriority, setItemPriority] = useState(3);
  const [itemDrafts, setItemDrafts] = useState<Record<string, { request: string; material: string; englishRequirement: string; roles: Role[]; minutes: number; priority: number; baseRevision: number }>>({});
  const [itemEditRevision, setItemEditRevision] = useState<number | null>(null);
  const [correctionDrafts, setCorrectionDrafts] = useState<Record<string, string>>({});
  const [correctionScopes, setCorrectionScopes] = useState<Record<string, "shared" | "english">>({});
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [answerChoices, setAnswerChoices] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [completeConfirm, setCompleteConfirm] = useState<{ itemId: string; revision: number; unfinishedIds: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [themeMode, setThemeMode] = useState<"neutral" | "color">("neutral");
  const [neutral, setNeutral] = useState<"light" | "dark">("light");
  const [color, setColor] = useState<"blue" | "green" | "sand">("blue");
  const [themeLoaded, setThemeLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("usage");
  const [defaultView, setDefaultView] = useState<"home" | "items" | "week">("home");
  const [defaultCalendarMode, setDefaultCalendarMode] = useState<"week" | "month">("week");
  const [workspacePreferencesLoaded, setWorkspacePreferencesLoaded] = useState(false);
  const connectionSeq = useRef(0);
  const refreshSeq = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const quickContextButton = useRef<HTMLButtonElement>(null);
  const quickContextPanel = useRef<HTMLElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsReturnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!contextOpen) return;
    const panel = quickContextPanel.current;
    if (!panel) return;
    panel.querySelector<HTMLElement>(".wb2-context-heading button")?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextOpen(false);
        quickContextButton.current?.focus();
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')).filter(element => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contextOpen]);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, left: 0 });
    window.scrollTo({ top: 0, left: 0 });
  }, [view, itemId]);
  useEffect(() => {
    let midnightTimer: number;
    const updateLocalDay = () => {
      const now = new Date();
      setCalendarToday(now);
    };
    const scheduleMidnight = () => {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      midnightTimer = window.setTimeout(() => { updateLocalDay(); scheduleMidnight(); }, Math.max(1, next.getTime() - now.getTime() + 50));
    };
    const sync = () => { updateLocalDay(); window.clearTimeout(midnightTimer); scheduleMidnight(); };
    const onVisibility = () => { if (document.visibilityState === "visible") sync(); };
    sync();
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearTimeout(midnightTimer); window.removeEventListener("focus", sync); document.removeEventListener("visibilitychange", onVisibility); };
  }, []);
  const correction = correctionDrafts[itemId] || "";
  const handleAgentState = useCallback((next: AgentState) => {
    setAgentWork(next);
    setWork(current => current ? { ...current, preferences: next.preferences.filter(pref => pref.agent_id === "career" || pref.agent_id === "english").map(pref => ({ id: pref.id, role: pref.agent_id as Role, text: pref.text, active: pref.active })) } : current);
  }, []);
  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    const [nextWork, nextOld, nextConnection] = await Promise.all([
      fetch("/api/work-items", { cache: "no-store" }).then(readJson),
      fetch("/api/state", { cache: "no-store" }).then(readJson),
      fetch("/api/connection", { cache: "no-store" }).then(readJson),
    ]);
    if (seq !== refreshSeq.current) return;
    setWork(nextWork); setOld(nextOld);
    setConnection(current => current && current.serverEpoch === nextConnection.serverEpoch && current.version > nextConnection.version ? current : nextConnection);
  }, []);
  useEffect(() => { refresh().catch(error => setNotice(error.message)); }, [refresh]);
  useEffect(() => {
    const syncVisible = () => {
      if (document.visibilityState !== "visible") return;
      refresh().catch(error => setNotice(error.message));
    };
    window.addEventListener("focus", syncVisible);
    document.addEventListener("visibilitychange", syncVisible);
    return () => { window.removeEventListener("focus", syncVisible); document.removeEventListener("visibilitychange", syncVisible); };
  }, [refresh]);
  useEffect(() => {
    if (!work?.runs.some(run => run.status === "running") && !work?.practiceRuns?.some(run => run.status === "running")) return;
    const timer = setInterval(() => refresh().catch(() => {}), 1000);
    return () => clearInterval(timer);
  }, [work?.runs, work?.practiceRuns, refresh]);
  useEffect(() => {
    if (!work) return;
    if (notice === "本次运行已开始；页面会更新真实进展" && !work.runs.some(run => run.status === "running")) setNotice("");
    if (notice === "练习请求已开始，结果会显示在本事项中" && !work.practiceRuns.some(run => run.status === "running")) setNotice("");
  }, [work, notice]);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("workbench.theme") || "{}");
      if (["neutral", "color"].includes(saved.mode)) setThemeMode(saved.mode);
      if (["light", "dark"].includes(saved.neutral)) setNeutral(saved.neutral);
      if (["blue", "green", "sand"].includes(saved.color)) setColor(saved.color);
    } catch { /* Invalid appearance preference uses the documented default. */ }
    setThemeLoaded(true);
  }, []);
  useEffect(() => { if (themeLoaded) localStorage.setItem("workbench.theme", JSON.stringify({ mode: themeMode, neutral, color })); }, [themeLoaded, themeMode, neutral, color]);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("workbench.workspace-preferences") || "{}");
      if (saved.defaultView === "home" || saved.defaultView === "items" || saved.defaultView === "week") {
        setDefaultView(saved.defaultView);
        setView(saved.defaultView);
      }
      if (saved.defaultCalendarMode === "week" || saved.defaultCalendarMode === "month") setDefaultCalendarMode(saved.defaultCalendarMode);
    } catch { /* An invalid local preference uses the default workspace and week view. */ }
    setWorkspacePreferencesLoaded(true);
  }, []);
  useEffect(() => {
    if (!workspacePreferencesLoaded) return;
    try { localStorage.setItem("workbench.workspace-preferences", JSON.stringify({ defaultView, defaultCalendarMode })); }
    catch { setNotice("浏览器未能保存使用偏好；本次页面中的选择仍可用。"); }
  }, [workspacePreferencesLoaded, defaultView, defaultCalendarMode]);
  useEffect(() => {
    if (!settingsOpen) return;
    settingsRef.current?.focus();
    const previousBodyOverflow = document.body.style.overflow;
    const previousContentOverflow = contentRef.current?.style.overflow;
    document.body.style.overflow = "hidden";
    if (contentRef.current) contentRef.current.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      if (contentRef.current) contentRef.current.style.overflow = previousContentOverflow || "";
    };
  }, [settingsOpen]);
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      const current = work?.items.find(item => item.id === itemId);
      const currentDirty = current && (itemRequest !== current.request || itemMaterial !== current.material || itemEnglishRequirement !== current.english_requirement || JSON.stringify(itemEditRoles) !== JSON.stringify(asRoles(current)) || itemMinutes !== current.minutes || itemPriority !== current.priority);
      const cachedDirty = Object.entries(itemDrafts).some(([id, draft]) => { const saved = work?.items.find(item => item.id === id); return saved && (draft.request !== saved.request || draft.material !== saved.material || draft.englishRequirement !== saved.english_requirement || JSON.stringify(draft.roles) !== JSON.stringify(asRoles(saved)) || draft.minutes !== saved.minutes || draft.priority !== saved.priority); });
      if (!request.trim() && !material.trim() && !Object.values(correctionDrafts).some(text => text.trim()) && !Object.values(answerDrafts).some(text => text.trim()) && !Object.entries(answerChoices).some(([id, choice]) => !!choice && work?.practices.some(round => round.id === id && round.status === "question")) && !currentDirty && !cachedDirty && !hasUnsavedScheduleDrafts()) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [request, material, correctionDrafts, answerDrafts, answerChoices, itemId, itemRequest, itemMaterial, itemEnglishRequirement, itemEditRoles, itemMinutes, itemPriority, itemDrafts, work?.items]);

  async function mutate(url: string, body: Record<string, unknown>) {
    setBusy(true); setNotice("");
    let response: Response | undefined;
    try {
      response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await readJson(response);
      refreshSeq.current += 1;
      if (result.state?.items) {
        setWork(result.state);
        if (String(body.type).startsWith("preference.")) setAgentWork(current => current ? { ...current, preferences: [...current.preferences.filter(pref => pref.agent_id !== "career" && pref.agent_id !== "english"), ...result.state.preferences.map((pref: Preference) => ({ ...pref, agent_id: pref.role }))] } : current);
      }
      else if (result.state?.agents) setOld(result.state);
      if (result.connection) setConnection(result.connection);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "操作失败";
      if (response?.status === 409) {
        try { await refresh(); }
        catch (refreshError) { setNotice(`${message}；状态刷新失败：${refreshError instanceof Error ? refreshError.message : "请稍后重试"}`); return null; }
      }
      setNotice(message); return null;
    }
    finally { setBusy(false); }
  }
  async function mutateMemoryPreference(agentId: string, body: Record<string, unknown>) {
    if (agentId === "career" || agentId === "english") {
      const rest = { ...body };
      delete rest.agentId;
      return !!await mutate("/api/work-items", body.type === "preference.save" ? { ...rest, role: agentId } : rest);
    }
    setBusy(true); setNotice("");
    let response: Response | undefined;
    try {
      response = await fetch("/api/agent-work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await readJson(response);
      if (result.state?.profiles) handleAgentState(result.state);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "偏好操作失败";
      if (response?.status === 409) {
        try { const latest = await fetch("/api/agent-work", { cache: "no-store" }).then(readJson); handleAgentState(latest); }
        catch (refreshError) { setNotice(`${message}；刷新失败：${refreshError instanceof Error ? refreshError.message : "请稍后重试"}`); return false; }
      }
      setNotice(message);
      return false;
    } finally { setBusy(false); }
  }
  async function connectionAction(body: Record<string, unknown>): Promise<boolean> {
    const seq = ++connectionSeq.current;
    setBusy(true); setNotice("");
    try {
      const data = await readJson(await fetch("/api/connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      if (seq === connectionSeq.current) { setConnection(data); setNotice(body.type === "connect" || body.type === "channel.connect" ? "模型列表已读取；生成仍需实际运行验证" : body.type === "disconnect" || body.type === "channel.disconnect" ? "已断开连接，配置和历史保留" : "模型选择已保存，只影响后续运行"); }
      return true;
    } catch (error) { if (seq === connectionSeq.current) setNotice(error instanceof Error ? error.message : "连接失败"); return false; }
    finally { if (seq === connectionSeq.current) setBusy(false); }
  }
  function openSettings(section: SettingsSection) {
    settingsReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSettingsSection(section);
    setSettingsOpen(true);
  }
  function closeSettings() {
    setSettingsOpen(false);
    requestAnimationFrame(() => {
      if (settingsReturnFocus.current?.isConnected) settingsReturnFocus.current.focus();
    });
  }
  function settingsKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); closeSettings(); return; }
    if (event.key !== "Tab") return;
    const focusable = Array.from(settingsRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]') || []).filter(element => element.getClientRects().length > 0);
    if (!focusable.length) { event.preventDefault(); settingsRef.current?.focus(); return; }
    if (event.shiftKey && (document.activeElement === focusable[0] || document.activeElement === settingsRef.current)) { event.preventDefault(); focusable[focusable.length - 1].focus(); }
    else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) { event.preventDefault(); focusable[0].focus(); }
  }
  function openItem(item: Item) { const draft = itemDrafts[item.id]; setItemId(item.id); setSourceChoice(""); setItemRequest(draft?.request ?? item.request); setItemMaterial(draft?.material ?? item.material); setItemEnglishRequirement(draft?.englishRequirement ?? item.english_requirement); setItemEditRoles(draft?.roles ?? asRoles(item)); setItemMinutes(draft?.minutes ?? item.minutes); setItemPriority(draft?.priority ?? item.priority); setItemEditRevision(draft?.baseRevision ?? item.revision); setContextOpen(false); setQuickEditorOpen(false); setDetailPane("work"); setView("item"); setNotice(""); setCompleteConfirm(null); }
  function cacheItemDraft(item: Item, patch: Partial<{ request: string; material: string; englishRequirement: string; roles: Role[]; minutes: number; priority: number }>) {
    setItemDrafts(current => ({ ...current, [item.id]: { request: itemRequest, material: itemMaterial, englishRequirement: itemEnglishRequirement, roles: itemEditRoles, minutes: itemMinutes, priority: itemPriority, baseRevision: itemEditRevision ?? item.revision, ...patch } }));
  }
  async function create() {
    if (!request.trim()) { setNotice("请先描述你想推进的事情"); return; }
    if (newPlanned && newDue && newPlanned > newDue) { setNotice("计划日不能晚于截止日"); return; }
    const result = await mutate("/api/work-items", { type: "create", request, material, roles, priority, minutes, modelChoice: createModelChoice, plannedDate: newPlanned || null, dueDate: newDue || null });
    if (result) { const item = result.state.items.find((entry: Item) => entry.id === result.id); setRequest(""); setMaterial(""); setCreateModelChoice(null); setNewPlanned(""); setNewDue(""); setRoles([]); setRolesTouched(false); setCreateVisible(false); setCreateExpanded(false); setCreateModeTouched(false); if (item) openItem(item); }
  }
  async function update(item: Item) {
    if (itemEditRevision !== item.revision) { setNotice("事项已在别处更新，请先核对最新内容与当前草稿"); return; }
    const result = await mutate("/api/work-items", { type: "update", id: item.id, revision: item.revision, request: itemRequest, material: itemMaterial, englishRequirement: itemEnglishRequirement, roles: itemEditRoles, minutes: itemMinutes, priority: itemPriority });
    if (result) {
      const saved = result.state.items.find((entry: Item) => entry.id === item.id) as Item | undefined;
      if (saved) { setItemRequest(saved.request); setItemMaterial(saved.material); setItemEnglishRequirement(saved.english_requirement); setItemEditRoles(asRoles(saved)); setItemMinutes(saved.minutes); setItemPriority(saved.priority); setItemEditRevision(saved.revision); }
      setItemDrafts(current => { const next = { ...current }; delete next[item.id]; return next; });
      setNotice("事项修改已保存；仅受影响的成果需要更新，历史版本保持可查");
    }
  }
  async function saveCorrection(item: Item) {
    if (!correction.trim()) { setNotice("请写明需要纠正的事实或修改指令"); return; }
    const englishOnly = correctionScopes[item.id] === "english";
    if (englishOnly && !asRoles(item).includes("english")) { setNotice("请先在修改分工中加入英语教练"); return; }
    const nextEnglishRequirement = [item.english_requirement, correction.trim()].filter(Boolean).join("\n");
    if (englishOnly && nextEnglishRequirement.length > 2000) { setNotice("英文补充要求已达长度上限，请先整理旧要求"); return; }
    const result = await mutate("/api/work-items", englishOnly
      ? { type: "update", id: item.id, revision: item.revision, request: item.request, material: item.material, englishRequirement: nextEnglishRequirement, roles: asRoles(item), minutes: item.minutes, priority: item.priority }
      : { type: "correct", id: item.id, revision: item.revision, text: correction });
    if (result) {
      setCorrectionDrafts(current => ({ ...current, [item.id]: "" }));
      if (englishOnly) setItemEnglishRequirement(nextEnglishRequirement);
      setNotice(englishOnly ? "英文修改要求已保存；中文成果保持有效，英语成果待更新" : "事实纠正已保存；相关成果待更新，原版本仍可查看");
    }
  }
  async function lifecycle(item: Item, type: "complete" | "archive" | "reopen", unfinishedIds: string[] = [], confirmUnfinished = false) {
    const result = await mutate("/api/work-items", { type, id: item.id, revision: item.revision, unfinishedPracticeIds: unfinishedIds, confirmUnfinished });
    if (result) { setCompleteConfirm(null); setNotice(type === "complete" ? "事项已完成；未完练习和成果仍在历史中" : type === "archive" ? "事项已归档，可从历史重新打开" : "事项已重新打开"); }
  }
  async function practiceAction(type: "practice.start" | "practice.submit" | "practice.retry" | "practice.cancel", item: Item, role: Role, roundId?: string, answer?: string, runId?: string) {
    const result = await mutate("/api/work-items", { type, id: item.id, revision: item.revision, role, roundId, answer, runId, requestId: crypto.randomUUID() });
    if (result) {
      if (type === "practice.submit" && roundId) {
        setAnswerDrafts(current => { const next = { ...current }; delete next[roundId]; return next; });
        setAnswerChoices(current => { const next = { ...current }; delete next[roundId]; return next; });
      }
      setNotice(type === "practice.cancel" ? "练习运行已取消，可手动恢复" : "练习请求已开始，结果会显示在本事项中");
    }
  }
  const item = work?.items.find(entry => entry.id === itemId);
  const sourceChain = item ? JSON.parse(item.source_context_json || "[]") as LinkedSource[] : [];
  const sourceOptions = [
    ...(work?.items || []).flatMap(entry => {
      if (entry.id === itemId) return [];
      return asRoles(entry).flatMap(role => {
        const artifact = recentArtifact(work?.artifacts || [], entry, role);
        return artifact?.accepted_at ? [{ kind: "quick" as const, id: entry.id, artifactId: artifact.id, title: entry.request, producer: roleName[role], version: artifact.version, content: artifact.content }] : [];
      });
    }),
    ...(agentWork?.jobs || []).flatMap(entry => {
      const ids = agentWork?.current[entry.id] || [];
      return ids.flatMap(id => {
        const artifact = agentWork?.artifacts.find(value => value.id === id);
        return artifact?.accepted_at ? [{ kind: "agent" as const, id: entry.id, artifactId: artifact.id, title: entry.request, producer: agentWork?.profiles.find(profile => profile.id === artifact.agent_id)?.name || artifact.agent_id, version: artifact.version, content: artifact.content }] : [];
      });
    }),
  ];
  const chosenSource = sourceOptions.find(entry => `${entry.kind}:${entry.id}:${entry.artifactId}` === sourceChoice);
  const directSource = sourceChain[sourceChain.length - 1];
  const directSourceCurrent = !!directSource && sourceOptions.some(entry => entry.kind === directSource.kind && entry.id === directSource.itemId && entry.artifactId === directSource.artifactId);
  useEffect(() => {
    if (view !== "item" || !item || itemEditRevision === item.revision || itemDrafts[item.id]) return;
    setItemRequest(item.request); setItemMaterial(item.material); setItemEnglishRequirement(item.english_requirement);
    setItemEditRoles(asRoles(item)); setItemMinutes(item.minutes); setItemPriority(item.priority); setItemEditRevision(item.revision);
  }, [view, item, itemEditRevision, itemDrafts]);
  const itemRoles = item ? asRoles(item) : [];
  const itemArtifacts = item ? work?.artifacts.filter(artifact => artifact.item_id === item.id) || [] : [];
  const itemRuns = item ? work?.runs.filter(run => run.item_id === item.id) || [] : [];
  const itemPractices = item ? work?.practices?.filter(round => round.item_id === item.id) || [] : [];
  const itemPracticeRuns = work?.practiceRuns?.filter(run => itemPractices.some(round => round.id === run.practice_id)) || [];
  const unfinishedRounds = item ? unfinishedPracticeRounds(item, work) : [];
  const unfinishedRoundIds = unfinishedRounds.map(({ round }) => round.id).sort().join("|");
  useEffect(() => {
    if (!completeConfirm || completeConfirm.itemId !== item?.id) return;
    if (item.lifecycle !== "open" || item.revision !== completeConfirm.revision || unfinishedRoundIds !== [...completeConfirm.unfinishedIds].sort().join("|")) {
      setCompleteConfirm(null);
      setNotice("事项或未完练习已变化，请重新核对后完成");
    }
  }, [completeConfirm, item?.id, item?.lifecycle, item?.revision, unfinishedRoundIds]);
  const practiceRunning = itemPracticeRuns.some(run => run.status === "running");
  const hasDirtyItem = !!item && (itemRequest !== item.request || itemMaterial !== item.material || itemEnglishRequirement !== item.english_requirement || JSON.stringify(itemEditRoles) !== JSON.stringify(asRoles(item)) || itemMinutes !== item.minutes || itemPriority !== item.priority);
  const sourcePanel = item && <section className="wb2-context-block" aria-label="跨事项接续">
    <h2>接续上一件事</h2>
    <p className="muted">只有你明确关联的已确认成果，才会进入本事项后续生成与练习；已完成练习的作答和反馈也会一并带入。当前内容固定为保存时的快照。</p>
    {sourceChain.length > 0 && <details><summary>当前关联：{sourceChain[sourceChain.length - 1].title} · 共 {sourceChain.length} 段</summary>
      {sourceChain.map(entry => <div className="step" key={entry.artifactId}><strong>{entry.title} · {entry.producer || "已确认成果"} v{entry.version}</strong><p>成果来源：{entry.kind === "agent" ? "自定义 Agent" : "快捷事项"}{entry.practice ? " · 含已完成练习反馈" : " · 无已完成练习反馈"}</p><details><summary>查看发送内容</summary><div className="wb2-paper"><RichText text={entry.content} /></div>{entry.practice && <div>作答：<RichText text={entry.practice.answer} />反馈：<RichText text={entry.practice.feedback} />建议：<RichText text={entry.practice.suggestion} /></div>}</details></div>)}
    </details>}
    {directSource && !directSourceCurrent && <p role="status">来源成果已有新版或不再是当前已确认版本。本事项继续使用保存时的快照；如需新版，请重新选择并保存来源。</p>}
    {!sourceChain.length && <p className="muted">尚未关联来源；其他事项不会自动进入本次输入。</p>}
    <label>选择已确认成果<select value={sourceChoice} onChange={event => setSourceChoice(event.target.value)}>
      <option value="">选择来源事项</option>
      {sourceOptions.map(entry => <option key={entry.artifactId} value={`${entry.kind}:${entry.id}:${entry.artifactId}`}>{entry.kind === "agent" ? "自定义" : "快捷"} · {entry.title.slice(0, 65)} · {entry.producer} v{entry.version}</option>)}
    </select></label>
    {chosenSource && <details><summary>保存前预览来源成果</summary><div className="wb2-paper"><RichText text={chosenSource.content} /></div></details>}
    <div className="row"><button disabled={busy || !chosenSource || item.lifecycle !== "open" || item.status === "running" || practiceRunning || hasDirtyItem} onClick={async () => {
      if (!chosenSource) return;
      const result = await mutate("/api/work-items", { type: "source.update", id: item.id, revision: item.revision, source: { kind: chosenSource.kind, id: chosenSource.id, artifactId: chosenSource.artifactId } });
      if (result) { setSourceChoice(""); setNotice("来源已保存；旧成果保留为历史，请重新开始协作"); }
    }}>关联并更新成果</button>{sourceChain.length > 0 && <button disabled={busy || item.lifecycle !== "open" || item.status === "running" || practiceRunning || hasDirtyItem} onClick={async () => {
      const result = await mutate("/api/work-items", { type: "source.update", id: item.id, revision: item.revision, source: null });
      if (result) { setSourceChoice(""); setNotice("来源已移除；旧成果保留为历史"); }
    }}>移除关联</button>}</div>
    <p className="muted">更换或移除来源会让本事项旧成果转入历史；新成果需要手动启动。关联链最多 7 段。</p>
  </section>;
  const mergedItems = [...(work?.items || []).map(entry => ({ kind: "quick" as const, entry })), ...(agentWork?.jobs || []).map(entry => ({ kind: "agent" as const, entry }))].sort((a, b) => b.entry.updated_at.localeCompare(a.entry.updated_at) || b.entry.created_at.localeCompare(a.entry.created_at));
  const running = itemRuns.find(run => run.status === "running");
  const currentCareer = item ? recentArtifact(itemArtifacts, item, "career") : undefined;
  const currentEnglish = item ? recentArtifact(itemArtifacts, item, "english") : undefined;
  const nextPendingRole: Role | null = itemRoles.includes("career") && !currentCareer ? "career" : itemRoles.includes("english") && !currentEnglish ? "english" : null;
  const remaining = !!nextPendingRole;
  const itemModelChoice = item ? parseItemModelSelection(item.model_choice_json) : null;
  const nextModelReady = modelReadyForAgent(connection, nextPendingRole, itemModelChoice);
  const paused = !!nextPendingRole && !old?.agents.find(agent => agent.id === nextPendingRole)?.enabled;
  const roleScope = (role: Role, joined: boolean) => { const config = agentWork?.profiles.find(entry => entry.id === role); return config ? `事项需求${config.allow_material ? "、本事项文本资料与纠正" : ""}、该实例有效偏好${role === "english" && joined && config.allow_upstream ? "、求职顾问当前成果" : ""}` : "按团队中该 Agent 的实际权限发送"; };
  const openAgentJob = (id: string) => { setOpenAgentRequest({ id, nonce: ++openAgentNonce.current }); setView("agentJobs"); };
  const openMergedEntry = (kind: "quick" | "agent", id: string) => {
    if (kind === "quick") {
      const target = work?.items.find(entry => entry.id === id);
      if (target) openItem(target);
    } else if (agentWork?.jobs.some(entry => entry.id === id)) openAgentJob(id);
  };
  const needsAttention = work?.items.filter(entry => entry.lifecycle === "open" && (["limited", "ready", "waiting", "failed", "interrupted"].includes(entry.status) || quickAutoCancelled(entry, work) || currentPracticeRounds(entry, work).some(({ round }) => ["question", "failed", "interrupted"].includes(round.status)))) || [];
  const agentAttention = agentWork?.jobs.filter(entry => agentNeedsAttention(entry, agentWork)) || [];
  const attentionItems = mergedItems.filter(({ kind, entry }) => kind === "quick" ? needsAttention.some(item => item.id === entry.id) : agentAttention.some(job => job.id === entry.id)).sort((a, b) => {
    const aDate = earliestDate(a.entry.planned_date, a.entry.due_date);
    const bDate = earliestDate(b.entry.planned_date, b.entry.due_date);
    return aDate.localeCompare(bDate) || b.entry.updated_at.localeCompare(a.entry.updated_at);
  });
  const mergedOpen = mergedItems.filter(({ entry }) => entry.lifecycle === "open");
  const nextPlanned = [...mergedOpen].sort((a, b) => {
    const aDate = earliestDate(a.entry.planned_date, a.entry.due_date);
    const bDate = earliestDate(b.entry.planned_date, b.entry.due_date);
    return aDate.localeCompare(bDate) || b.entry.updated_at.localeCompare(a.entry.updated_at);
  });
  const focusEntry = attentionItems[0] || nextPlanned[0];
  const sameDayPlans = !attentionItems.length && focusEntry?.entry.planned_date
    ? nextPlanned.filter(({ kind, entry }) => (kind !== focusEntry.kind || entry.id !== focusEntry.entry.id) && entry.planned_date === focusEntry.entry.planned_date).slice(0, 3)
    : [];
  const todayKey = calendarToday ? localDateKey(calendarToday) : "";
  const plannedOpenCount = mergedOpen.filter(({ entry }) => !!entry.planned_date).length;
  const runningPracticeItemIds = new Set((work?.practiceRuns || []).filter(run => run.status === "running").map(run => work?.practices.find(round => round.id === run.practice_id)?.item_id).filter(Boolean));
  const runningItemCount = mergedOpen.filter(({ kind, entry }) => kind === "quick"
    ? (work?.runs.some(run => run.item_id === entry.id && run.status === "running") || runningPracticeItemIds.has(entry.id))
    : agentWork?.runs.some(run => run.job_id === entry.id && run.status === "running")).length;
  const upcomingPlans = nextPlanned.filter(({ kind, entry }) => !!entry.planned_date && (!todayKey || entry.planned_date >= todayKey) && (kind !== focusEntry?.kind || entry.id !== focusEntry.entry.id) && !attentionItems.some(attention => attention.kind === kind && attention.entry.id === entry.id)).slice(0, 3);
  const scheduleEntries = mergedItems.map(({ kind, entry }) => ({ id: entry.id, kind, title: entry.request, plannedDate: entry.planned_date, dueDate: entry.due_date, lifecycle: normalizedLifecycle(entry.lifecycle), status: kind === "quick" ? itemStatusLabel(entry, work) : agentJobStatus(entry, agentWork!) }));
  const listEntries = mergedItems.map(({ kind, entry }) => ({ id: entry.id, kind, title: entry.request, lifecycle: normalizedLifecycle(entry.lifecycle), status: kind === "quick" ? itemStatusLabel(entry, work) : agentJobStatus(entry, agentWork!), nextAction: kind === "quick" ? nextAction(entry, work) : agentJobStatus(entry, agentWork!), plannedDate: entry.planned_date, dueDate: entry.due_date, updatedAt: entry.updated_at, needsAttention: kind === "quick" ? needsAttention.some(item => item.id === entry.id) : agentAttention.some(job => job.id === entry.id) }));
  const allAccepted = !!itemRoles.length && itemRoles.every(role => { const current = recentArtifact(itemArtifacts, item!, role); return !!current?.accepted_at; });
  const focusActionLabel = (kind: "quick" | "agent", entry: Item | AgentJob) => {
    const status = kind === "quick" ? nextAction(entry as Item, work) : agentJobStatus(entry as AgentJob, agentWork!);
    if (status.includes("题目待回答")) return "回答题目";
    if (status.includes("核对")) return "核对成果";
    if (status.includes("尚未选择参与 Agent")) return "选择参与 Agent";
    if (status.includes("失败") || status.includes("中断") || status.includes("受阻")) return "处理当前问题";
    return "继续事项";
  };
  function startNewItem() { setView("home"); setCreateVisible(true); setCreateExpanded(false); requestAnimationFrame(() => document.getElementById("quick-create")?.scrollIntoView({ block: "start" })); }
  function continueWithCustomAgent() { if (!request.trim()) return; setAgentStartDraft({ text: request, modelChoice: createModelChoice, nonce: ++agentDraftNonce.current }); setView("agentJobs"); }

  const activeQuestionRounds = item?.lifecycle === "open" ? unfinishedRounds.filter(({ role, round }) => round.status === "question" && round.source_artifact_id === recentArtifact(itemArtifacts, item, role)?.id) : [];
  const hasActiveQuestion = activeQuestionRounds.length > 0;
  const practiceDisplayRoles = [...itemRoles].sort((a, b) => Number(unfinishedRounds.some(({ role, round }) => role === b && round.status === "question")) - Number(unfinishedRounds.some(({ role, round }) => role === a && round.status === "question")));
  const practiceStartChoices = item?.lifecycle === "open" && !hasActiveQuestion ? practiceDisplayRoles.flatMap(role => {
    const current = recentArtifact(itemArtifacts, item, role);
    const latestRound = itemPractices.find(round => round.role === role);
    return current && (!latestRound || latestRound.status === "feedback" || latestRound.source_artifact_id !== current.id) ? [{ role, nextRound: !!latestRound }] : [];
  }) : [];
  const practiceSection = item && itemRoles.length > 0 && <section id="work-practice" className="wb2-section wb2-card wb2-practice-history"><h2>练习记录</h2><p className="muted">已保存的题目、实际回答、反馈与模型输入依据。当前题目请在“现在做”中回答。</p>{practiceDisplayRoles.map(role => { const current = recentArtifact(itemArtifacts, item, role); const rounds = itemPractices.filter(round => round.role === role); const latestRound = rounds[0]; const activeRun = itemPracticeRuns.find(run => run.practice_id === latestRound?.id && run.status === "running"); const roleAgent = old?.agents.find(agent => agent.id === role); const roleEnabled = !!roleAgent?.enabled; return <article className="wb2-artifact" key={role}><h3>{roleName[role]}练习</h3>{roleAgent?.enabled === 0 && item.lifecycle === "open" && <p className="muted">该角色已暂停，恢复参与后可开始、提交或重试练习。<button onClick={() => setView("team")}>前往团队恢复参与</button></p>}{latestRound && latestRound.source_artifact_id !== current?.id && <p className="muted">{current ? `此轮基于旧成果，已保留为历史；下一轮将使用当前成果 v${current.version}。` : "此轮依据的成果已过期，先更新成果，再开始新一轮练习。"}</p>}{latestRound && ["failed", "interrupted", "cancelled"].includes(latestRound.status) && latestRound.source_artifact_id === current?.id && <button disabled={busy || practiceRunning || !!running || item.lifecycle !== "open" || !roleEnabled || !modelReadyForAgent(connection, role, itemModelChoice)} onClick={() => practiceAction("practice.retry", item, role, latestRound.id)}>手动恢复本轮</button>}{activeRun && <button disabled={busy} onClick={() => practiceAction("practice.cancel", item, role, latestRound.id, undefined, activeRun.id)}>取消练习运行</button>}{rounds.map((round, index) => <details key={round.id}><summary>第 {rounds.length - index} 轮 · {round.status === "feedback" ? "反馈已保存" : round.status === "question" ? "等你作答" : round.status === "running" ? "模型执行中" : round.status === "failed" ? "失败" : round.status === "interrupted" ? "中断" : "已取消"}</summary><p>题目来源：本事项 {roleName[role]}成果 v{itemArtifacts.find(artifact => artifact.id === round.source_artifact_id)?.version || "?"}</p>{round.question && (round.status !== "question" || round.source_artifact_id !== current?.id || item.lifecycle !== "open") && <div><strong>题目：</strong><RichText text={displayPracticeQuestion(round)} />{questionOptions(round).length > 0 && <ol className="wb2-history-options">{questionOptions(round).map(option => <li key={option.label}><strong>{option.label}.</strong> <RichText text={option.text} /></li>)}</ol>}</div>}{round.status === "question" && round.source_artifact_id === current?.id && item.lifecycle === "open" && <p className="muted">当前题目和作答入口在“现在做”。</p>}{round.answer && <div><strong>你的回答：</strong><RichText text={round.answer} /></div>}{round.feedback && <div className="wb2-paper"><strong>模型反馈</strong><RichText text={round.feedback} /><strong>下轮建议</strong><RichText text={round.suggestion} /></div>}{itemPracticeRuns.filter(run => run.practice_id === round.id).map(run => <div className="wb2-run" key={run.id}><p>{run.kind === "prepare" ? "准备题目" : "反馈作答"} · {runStatusName[run.status] || run.status} · {run.model}</p>{run.error && <p>{run.error}</p>}<details><summary>本轮输入依据</summary><pre>{run.context_json}</pre></details></div>)}</details>)}</article>; })}</section>;

  return <div className="workbench wb2" data-theme={themeMode === "neutral" ? neutral : color}>
    <aside className="sidebar" inert={settingsOpen}><div className="brand"><span className="monogram">✦</span><div><strong>学习与生活</strong><small>个人 Agent 工作台</small></div></div>
      <button className="wb2-new-item" onClick={startNewItem}>＋ 新建事项</button>
      <div><div className="sidebar-label">行动</div><nav className="nav" aria-label="主导航">{nav.slice(0, 3).map(entry => <button key={entry.id} type="button" aria-pressed={view === entry.id || (entry.id === "items" && view === "item")} onClick={() => { setView(entry.id); setNotice(""); }}><span>{entry.mark}</span>{entry.name}</button>)}</nav></div>
      <div><div className="sidebar-label">管理</div><nav className="nav" aria-label="管理导航">{nav.slice(3).map(entry => <button key={entry.id} type="button" aria-pressed={view === entry.id || (entry.id === "team" && view === "agentJobs")} onClick={() => { setView(entry.id); setNotice(""); }}><span>{entry.mark}</span>{entry.name}</button>)}</nav></div>
      <div className="sidebar-bottom"><small>本地保存 · 模型运行由你启动</small><a href="/legacy">旧版记录 ↗</a></div>
    </aside>
    <div className="content" ref={contentRef} inert={settingsOpen}><header className="top"><div className="breadcrumb">工作区 <span>/</span> {view === "item" ? "事项详情" : view === "connection" ? "模型连接" : view === "agentJobs" ? "自选 Agent 事项" : nav.find(entry => entry.id === view)?.name}</div><div className="top-actions">
      <button aria-haspopup="dialog" onClick={() => openSettings("connection")}>模型 · {connection?.channels.filter(channel => channel.connected).length || 0} 个已连接</button>
       <button aria-haspopup="dialog" onClick={() => openSettings("usage")}>设置</button>
    </div></header><main className="main">
      {notice && <div className="notice" role="status">{notice}</div>}
      {!work && <p className="muted">正在读取本地事项…</p>}
      {view === "home" && <>
        <div className="kicker">YOUR PERSONAL WORKSPACE</div>
        <h1>{mergedOpen.length ? "现在先做哪一步" : "从一件事开始"}</h1>
        <p className="wb2-intro">{mergedOpen.length ? "先处理需要你核对或回答的事项，再看 Agent 进展和接下来的安排。" : "写下想完成的学习或生活事项，再选择参与的 Agent；保存后由你决定何时启动。"}</p>
        {mergedOpen.length > 0 && <div className="wb2-home-summary" aria-label="工作区当前状态">
          <button onClick={() => setView("items")}><strong>{attentionItems.length}</strong><span>件待你处理</span></button>
          <span><strong>{runningItemCount}</strong><span>件正在运行</span></span>
          <button onClick={() => setView("week")}><strong>{plannedOpenCount}</strong><span>件已有计划日</span></button>
        </div>}
        <div className="wb2-home-grid">
          <div className="wb2-home-main">
            {mergedOpen.length > 0 && <section className="wb2-focus wb2-card" aria-label={attentionItems.length ? "现在需要你处理" : "可以接着推进"}>
              <div className="row spread"><h2>{attentionItems.length ? "现在需要你处理" : "可以接着推进"}</h2><span className="muted">{attentionItems.length ? `${attentionItems.length} 件待处理` : `${mergedOpen.length} 件进行中`}</span></div>
              {focusEntry && <div className="wb2-focus-body">
                <span className="tag">{attentionItems.length ? "待我处理" : "进行中"}</span>
                <h3>{focusEntry.entry.request}</h3>
                {(focusEntry.entry.planned_date || focusEntry.entry.due_date) && <p className="muted">计划：{focusEntry.entry.planned_date || "未安排"} · 截止：{focusEntry.entry.due_date || "未设置"}</p>}
                <p>{focusEntry.kind === "quick" ? nextAction(focusEntry.entry, work) : agentJobStatus(focusEntry.entry, agentWork!)}</p>
                <button className="primary" onClick={() => focusEntry.kind === "quick" ? openItem(focusEntry.entry) : openAgentJob(focusEntry.entry.id)}>{focusActionLabel(focusEntry.kind, focusEntry.entry)} →</button>
              </div>}
            </section>}
            {(attentionItems.length > 1 || sameDayPlans.length > 0) && <section className="wb2-section wb2-queue">
              <div className="row spread"><h2>{attentionItems.length ? "接着处理" : "同日还安排了"}</h2><button onClick={() => setView(attentionItems.length ? "items" : "week")}>{attentionItems.length ? "查看全部事项" : "查看日程"} →</button></div>
              {(attentionItems.length ? attentionItems.slice(1, 4) : sameDayPlans).map(({ kind, entry }) => <div className="wb2-queue-row" key={kind + entry.id}>
                <div><strong>{entry.request}</strong><p>{kind === "quick" ? nextAction(entry, work) : agentJobStatus(entry, agentWork!)}</p></div>
                <button onClick={() => kind === "quick" ? openItem(entry) : openAgentJob(entry.id)}>{focusActionLabel(kind, entry)}</button>
              </div>)}
              {attentionItems.length > 4 && <p className="muted">还有 {attentionItems.length - 4} 件事项在“我的事项”。</p>}
            </section>}
            {(!mergedOpen.length || createVisible || !!request.trim()) ? <section className="wb2-composer" id="quick-create">
              <div className="row spread"><div><h2>新建事项</h2><p className="muted">先说想完成什么，后续再安排参与者和资料。</p></div>{createExpanded && <button onClick={() => setCreateExpanded(false)}>收起配置</button>}</div>
              <label>要完成的事<textarea maxLength={4000} value={request} onChange={event => { const value = event.target.value; setRequest(value); if (!rolesTouched) setRoles(suggestRoles(value)); if (!createModeTouched) setCreateMode(suggestRoles(value).length ? "quick" : "custom"); }} placeholder="例如：整理一份面试准备提纲，或让阅读伙伴总结文章" /></label><MarkdownPreview text={request} />
              <ItemModelPicker connection={connection} value={createModelChoice} onChange={setCreateModelChoice} agents={(createMode === "quick" ? roles : []).map(role => ({ id: role, name: roleName[role] }))} onOpenConnections={() => openSettings("connection")} />
              {!createExpanded ? <button className="primary" disabled={!request.trim()} onClick={() => setCreateExpanded(true)}>继续设置 →</button> : <>
                <div className="wb2-create-choices" role="group" aria-label="选择协作方式">
                  <button aria-pressed={createMode === "quick"} onClick={() => { setCreateMode("quick"); setCreateModeTouched(true); }}>求职或英语预设</button>
                  <button aria-pressed={createMode === "custom"} onClick={() => { setCreateMode("custom"); setCreateModeTouched(true); }}>自选 Agent 与步骤</button>
                </div>
                {createMode === "quick" ? <>
                  <label>补充资料（可留空）<textarea maxLength={8000} value={material} onChange={event => setMaterial(event.target.value)} placeholder="如岗位描述、个人经历或词表；没有也能先开始" /></label><MarkdownPreview text={material} />
                  <p className="muted">资料留空时可先做通用准备；个人事实、学习效果和需要精确来源的内容仍须核对。</p>
                  <div className="wb2-options"><fieldset><legend>参与角色（可调整）</legend>{(["career", "english"] as Role[]).map(role => <label className="inline" key={role}><input type="checkbox" checked={roles.includes(role)} onChange={event => { setRolesTouched(true); setRoles(current => event.target.checked ? [...current, role] : current.filter(value => value !== role)); }} /> {roleName[role]}</label>)}</fieldset>
                    <label className="wb2-time-field">你的参与时间<span className="wb2-time-control"><input type="number" min="10" max="480" value={minutes} onChange={event => setMinutes(Number(event.target.value))} />分钟</span></label>
                    <label>优先级<select value={priority} onChange={event => setPriority(Number(event.target.value))}>{[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value}</option>)}</select></label></div>
                  <div className="schedule-fields"><label>计划处理日（可留空）<input type="date" value={newPlanned} onChange={event => setNewPlanned(event.target.value)} /></label><label>截止日（可留空）<input type="date" value={newDue} onChange={event => setNewDue(event.target.value)} /></label>{newPlanned && newDue && newPlanned > newDue && <p role="alert">计划日不能晚于截止日。</p>}</div>
                  <p className="muted">{roles.length ? "预计 " + roles.length + " 次模型调用；保存后会先显示分工与资料范围，运行由你启动。" : "尚无匹配预设。你可以保存为待定事项，或改用自选 Agent。"}</p>
                  <button className="primary" disabled={busy || !request.trim() || (!!newPlanned && !!newDue && newPlanned > newDue)} onClick={create}>{roles.length ? "保存事项并查看分工" : "保存待定事项"}</button>
                </> : <div className="wb2-create-custom">
                  <p>下一步安排一至四位 Agent，逐步确认交接成果与资料权限。已写的需求会带过去；保存后仍需你手动启动运行。</p>
                  <button className="primary" disabled={!request.trim()} onClick={continueWithCustomAgent}>继续安排 Agent →</button>
                  <button onClick={() => setView("team")}>先查看或创建 Agent</button>
                </div>}
              </>}
            </section> : <button className="wb2-compose-teaser" onClick={startNewItem}>＋ 有新想法？新建一件事</button>}
          </div>
          <aside className="wb2-home-context" aria-label="工作区上下文">
            {mergedOpen.length ? <>
              <section className="wb2-card"><div className="row spread"><h2>其他已安排</h2><button onClick={() => setView("week")}>查看日程 →</button></div>{upcomingPlans.length ? <ul className="wb2-home-plans">{upcomingPlans.map(({ kind, entry }) => <li key={`${kind}:${entry.id}`}><span>{entry.planned_date}</span><button onClick={() => openMergedEntry(kind, entry.id)}>{entry.request}</button></li>)}</ul> : <p className="muted">待处理事项已在左侧；其他事项暂无接下来的计划日。</p>}</section>
              <section className="wb2-card"><h2>协作提醒</h2><p className="muted">{runningItemCount ? `${runningItemCount} 件事项正在运行；结果仍需你核对。` : "当前没有正在运行的 Agent。模型只会在你主动启动时执行。"}</p><button onClick={() => setView("team")}>查看 Agent 团队 →</button></section>
            </> : <section className="wb2-card"><h2>接下来会发生什么</h2><ol className="wb2-start-steps"><li><strong>描述要完成的事</strong><span>可以从学习、生活或其他个人目标开始。</span></li><li><strong>核对协作方式</strong><span>选择 Agent、资料范围和计划日后保存。</span></li><li><strong>启动并检查成果</strong><span>运行由你启动；成果和纠正会留在事项中。</span></li></ol></section>}
          </aside>
        </div>
      </>}
       <div hidden={view !== "items"}>
         <div className="kicker">ALL YOUR WORK</div>
         <div className="row spread wb2-list-heading"><div><h1>我的事项</h1><p className="wb2-intro">先看需要你处理的事；其余进行中与历史可按组查找。</p></div><button onClick={startNewItem}>＋ 新建事项</button></div>
         <CompactItemList entries={listEntries} onOpen={openMergedEntry} onCreate={startNewItem} />
       </div>
       {view === "week" && <IntegratedSchedule entries={scheduleEntries} onOpen={openMergedEntry} todayKey={todayKey} defaultMode={defaultCalendarMode} renderScheduleEditor={({ kind, id }) => {
        const source = kind === "quick" ? work?.items.find(entry => entry.id === id) : agentWork?.jobs.find(entry => entry.id === id);
        if (!source) return null;
        return <ScheduleEditor key={`${kind}-${id}`} compact entry={source} endpoint={kind === "quick" ? "/api/work-items" : "/api/agent-work"} onState={next => { if (kind === "quick") { refreshSeq.current += 1; setWork(next as WorkState); } else handleAgentState(next as AgentState); }} />;
      }} />}
      {view === "item" && item && <><button className="quiet" onClick={() => setView("items")}>← 返回我的事项</button><div className="wb2-casehead"><span className="tag">{itemStatusLabel(item, work)}</span><div className="row spread"><h1 className={expandedTitleId === item.id ? "" : "wb2-case-title-collapsed"}>{item.request}</h1><div className="row"><button aria-controls="quick-item-editor" onClick={() => { setQuickEditorOpen(true); requestAnimationFrame(() => document.getElementById("quick-item-editor")?.scrollIntoView({ block: "start" })); }}>编辑事项{hasDirtyItem ? " · 有草稿" : ""}</button><button ref={quickContextButton} className="wb2-context-toggle" aria-controls="quick-item-context" aria-expanded={contextOpen} onClick={() => setContextOpen(value => !value)}>事项信息</button></div></div>{item.request.length > 55 && <button className="quiet wb2-title-toggle" aria-expanded={expandedTitleId === item.id} onClick={() => setExpandedTitleId(value => value === item.id ? "" : item.id)}>{expandedTitleId === item.id ? "收起完整需求" : "展开完整需求"}</button>}{!hasActiveQuestion && <p className="muted">你的参与时间 {item.minutes} 分钟 · 优先级 {item.priority}/5 · 事项修订 {item.revision}</p>}
        {!hasActiveQuestion && unfinishedRounds.length > 0 && <p className="muted">{item.lifecycle === "open" ? "当前还有未完练习：" : "历史中保留未完练习："}{unfinishedRounds.map(({ role, round }) => `${roleName[role]}${round.status === "question" ? "待回答" : round.status === "cancelled" ? "已取消" : round.status === "interrupted" ? "中断待恢复" : "失败待恢复"}`).join("；")}{item.lifecycle !== "open" ? "。重新打开后可继续处理。" : "。可继续处理，也可明确结束事项并保留历史。"}</p>}
        {completeConfirm?.itemId === item.id && item.lifecycle === "open" && completeConfirm.revision === item.revision && unfinishedRoundIds === [...completeConfirm.unfinishedIds].sort().join("|") && <div className="wb2-card" role="alert"><strong>仍有 {completeConfirm.unfinishedIds.length} 轮未完练习</strong><p>结束事项会将这些题目或回答留在历史中；重新打开后仍可继续。请明确选择。</p><div className="row"><button onClick={() => { setCompleteConfirm(null); setDetailPane("work"); document.getElementById("quick-current-action")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>返回继续练习</button><button disabled={busy || !!running || practiceRunning} onClick={() => lifecycle(item, "complete", completeConfirm.unfinishedIds, true)}>仍要完成并保留历史</button></div></div>}</div><div className="wb2-workspace"><div>
        <section className="wb2-current-action wb2-card" id="quick-current-action" aria-label="当前要做的事"><div className="row spread"><h2>当前要做的事</h2><span className="tag">{itemStatusLabel(item, work)}</span></div>{nextAction(item, work) !== itemStatusLabel(item, work) && <p>{nextAction(item, work)}</p>}
        <details className="wb2-item-model-settings"><summary>本事项模型与运行设置</summary><ItemModelPicker connection={connection} value={itemModelChoice} onChange={async choice => { if (await mutate("/api/work-items", { type: "model.update", id: item.id, modelChoice: choice, modelRevision: item.model_revision })) setNotice("本事项模型选择已保存；仅影响后续运行"); }} agents={itemRoles.map(role => ({ id: role, name: roleName[role] }))} onOpenConnections={() => openSettings("connection")} disabled={busy || !!running || practiceRunning || item.lifecycle !== "open"} /></details>
        {activeQuestionRounds.map(({ role, round }) => {
          const options = questionOptions(round);
          const displayedQuestion = displayPracticeQuestion(round);
          const selected = answerChoices[round.id] ?? "";
          const explanation = answerDrafts[round.id] ?? "";
          const answer = options.length ? `${selected}\n理由：${explanation.trim()}` : explanation;
          const canSubmit = explanation.trim().length >= 4 && (!options.length || !!selected);
          return <div className="wb2-active-question" key={round.id}>
            <h3>{roleName[role]} · 当前题目</h3>
            <div className="wb2-question"><RichText text={displayedQuestion} /></div>
            {options.length === 0 && displayedQuestion !== round.question && <p className="muted">这道历史题仍用自由输入：请在下方写选项和理由。</p>}
            {options.length > 0 && <fieldset className="wb2-answer-options"><legend>选择一个答案</legend>{options.map(option => <label className="wb2-answer-option" key={option.label}><input type="radio" name={`quick-answer-choice-${round.id}`} value={option.label} checked={selected === option.label} onChange={() => setAnswerChoices(current => ({ ...current, [round.id]: option.label }))} /><strong>{option.label}</strong><RichText text={option.text} /></label>)}</fieldset>}
            <label>{options.length ? "说明你的理由" : "在这里输入你的回答"}<textarea maxLength={8000} placeholder={options.length ? "写下选择这个答案的理由" : "直接写下你的回答"} value={explanation} onChange={event => setAnswerDrafts(current => ({ ...current, [round.id]: event.target.value }))} /></label>
            <MarkdownPreview text={explanation} />
            <div className="row"><button className="primary" disabled={busy || practiceRunning || !!running || item.lifecycle !== "open" || !old?.agents.find(agent => agent.id === role)?.enabled || !modelReadyForAgent(connection, role, itemModelChoice) || !canSubmit} onClick={() => practiceAction("practice.submit", item, role, round.id, answer)}>提交回答并获取反馈</button>{!modelReadyForAgent(connection, role, itemModelChoice) && <span className="muted">请先连接本事项所选的模型渠道。</span>}</div>
          </div>;
        })}
        {running && <RunLivePreview runId={running.id} />}
        {itemPracticeRuns.filter(run => run.status === "running").map(run => {
          const round = itemPractices.find(entry => entry.id === run.practice_id);
          return <div key={run.id}><RunLivePreview runId={run.id} field={run.kind === "prepare" ? "question" : "feedback"} />{round && <button disabled={busy} onClick={() => practiceAction("practice.cancel", item, round.role, round.id, undefined, run.id)}>取消练习运行</button>}</div>;
        })}
        {!unfinishedRounds.length && !practiceRunning && currentPracticeRounds(item, work).filter(({ round }) => round.status === "feedback").slice(0, 1).map(({ role, round }) => <section className="wb2-latest-feedback" key={round.id}><div className="row spread"><h3>{roleName[role]} · 最新练习反馈</h3><button type="button" onClick={() => { setDetailPane("history"); requestAnimationFrame(() => document.getElementById("work-practice")?.scrollIntoView({ block: "start", behavior: "smooth" })); }}>查看完整记录</button></div><div className="wb2-latest-feedback-body"><RichText text={round.feedback} /></div></section>)}
        {unfinishedRounds.filter(({ round }) => ["failed", "interrupted", "cancelled"].includes(round.status)).map(({ role, round }) => <div className="wb2-run-actions" key={round.id}><p className="muted">{roleName[role]}练习{round.status === "interrupted" ? "中断" : round.status === "failed" ? "失败" : "已取消"}</p>{itemPracticeRuns.find(run => run.practice_id === round.id && run.status === "failed")?.error && <p role="alert">{itemPracticeRuns.find(run => run.practice_id === round.id && run.status === "failed")?.error}</p>}<button disabled={busy || practiceRunning || !!running || item.lifecycle !== "open" || !old?.agents.find(agent => agent.id === role)?.enabled || !modelReadyForAgent(connection, role, itemModelChoice)} onClick={() => practiceAction("practice.retry", item, role, round.id)}>手动恢复本轮</button></div>)}
        {(practiceStartChoices.length > 0 || item.lifecycle === "open" && item.status === "ready" && allAccepted && !hasActiveQuestion) && <div className="row wb2-run-actions">
        {practiceStartChoices.map(({ role, nextRound }) => <button className="primary" key={role} disabled={busy || practiceRunning || !!running || !old?.agents.find(agent => agent.id === role)?.enabled || !modelReadyForAgent(connection, role, itemModelChoice)} onClick={() => practiceAction("practice.start", item, role)}>{nextRound ? `开始${roleName[role]}下一轮练习` : `开始${roleName[role]}练习`}</button>)}
        {item.lifecycle === "open" && item.status === "ready" && allAccepted && !hasActiveQuestion && <button className={practiceStartChoices.length ? undefined : "primary"} disabled={busy || !!running || practiceRunning} onClick={() => { const unfinishedIds = unfinishedRounds.map(({ round }) => round.id); if (unfinishedIds.length) setCompleteConfirm({ itemId: item.id, revision: item.revision, unfinishedIds }); else lifecycle(item, "complete"); }}>完成事项</button>}
        </div>}
        {itemRoles.length > 0 && (remaining || !!running) && <div className="row wb2-run-actions"><button className="primary" disabled={busy || item.lifecycle !== "open" || !!running || practiceRunning || !remaining || !nextModelReady || paused || hasDirtyItem} onClick={async () => { const result = await mutate("/api/work-items", { type: "start", id: item.id, revision: item.revision, requestId: crypto.randomUUID() }); if (result) setNotice("本次运行已开始；页面会更新真实进展"); }}>{itemRuns.length ? "继续协作 / 手动重试" : "开始协作"}</button>{running && <button disabled={busy} onClick={async () => { const result = await mutate("/api/work-items", { type: "cancel", runId: running.id }); if (result) setNotice("已取消；已发出的云端请求可能仍被计费"); }}>取消本次运行</button>}</div>}
        {itemRoles.length > 0 && (remaining || !!running) && <p className="muted">{hasDirtyItem ? "先保存资料或时间修改。" : paused ? "参与角色已暂停，请到团队页恢复。" : !nextModelReady ? "下一步所选模型尚未连接；请在本事项中改选，或到设置中连接对应渠道。" : !remaining ? "当前修订成果已就绪；如需调整，请提供纠正或修改资料。" : "每步独立记录模型和输入来源；失败后手动继续，只重做缺失成果。"}</p>}
        {item.lifecycle === "open" && item.status === "ready" && !allAccepted && !hasActiveQuestion && <button onClick={() => { setDetailPane("results"); requestAnimationFrame(() => document.getElementById(`work-result-${itemRoles.find(role => !recentArtifact(itemArtifacts, item, role)?.accepted_at) || itemRoles[0]}`)?.scrollIntoView({ block: "start", behavior: "smooth" })); }}>查看待核对成果 →</button>}
        </section>
        <nav className="wb2-detail-nav" aria-label="事项内容"><button type="button" aria-pressed={detailPane === "work"} onClick={() => setDetailPane("work")}>现在做</button><button type="button" aria-pressed={detailPane === "results"} onClick={() => setDetailPane("results")}>成果{itemRoles.some(role => !!recentArtifact(itemArtifacts, item, role) && !recentArtifact(itemArtifacts, item, role)?.accepted_at) ? " · 待核对" : ""}</button><button type="button" aria-pressed={detailPane === "history"} onClick={() => setDetailPane("history")}>练习记录{itemPractices.length ? ` · ${itemPractices.length}` : ""}</button></nav>
        {detailPane === "results" && <section className="wb2-section" id="work-results"><h2>成果</h2>{itemRoles.map(role => { const current = recentArtifact(itemArtifacts, item, role); const history = itemArtifacts.filter(a => a.role === role); return <article className="wb2-artifact" id={`work-result-${role}`} key={role}><div className="row spread"><h3>{role === "career" ? "中文求职内容" : "英文表达成果"}</h3><span className="tag">{current ? `v${current.version} · 当前` : history.length ? "待更新" : "待生成"}</span></div>{current ? <><p className="muted">{roleName[role]} · 来源修订 {current.revision}{runMinutes(itemRuns.find(run => run.id === current.run_id)) !== null && runMinutes(itemRuns.find(run => run.id === current.run_id)) !== item.minutes ? ` · 生成时参与时间 ${runMinutes(itemRuns.find(run => run.id === current.run_id))} 分钟；当前安排已调整，请核对涉及时间的内容` : ""}{current.upstream_artifact_id ? ` · 上游成果 ${itemArtifacts.find(a => a.id === current.upstream_artifact_id)?.version || "?"} 版` : ""}</p><div className="wb2-paper"><RichText text={current.content} /></div><button onClick={() => navigator.clipboard.writeText(current.content).then(() => setNotice("成果已复制"), () => setNotice("复制失败，请手动选择文本"))}>复制成果</button>{current.accepted_at ? <span className="tag">已核对</span> : <button disabled={busy || item.lifecycle !== "open"} onClick={async () => { const result = await mutate("/api/work-items", { type: "artifact.accept", id: item.id, artifactId: current.id, revision: item.revision }); if (result) setNotice("已确认这份成果；可以继续核对或完成事项"); }}>确认这份成果</button>}</> : <p className="muted">{history.length ? "原版本仍可查看；当前修订尚未生成这一成果。" : "开始协作后显示真实模型成果。"}</p>}{history.length > 0 && <details><summary>版本历史（{history.length}）</summary>{history.map(a => <div className="wb2-version" key={a.id}><strong>v{a.version} · 修订 {a.revision} · {a.created_at}</strong><p>运行 {a.run_id.slice(0, 8)}{a.upstream_artifact_id ? ` · 上游 ${a.upstream_artifact_id.slice(0, 8)}` : ""}</p><div className="wb2-paper"><RichText text={a.content} /></div></div>)}</details>}</article>; })}{!itemRoles.length && <p className="empty">当前没有参与角色；已保存的历史成果仍可在下方查看。</p>}{(["career", "english"] as Role[]).filter(role => !itemRoles.includes(role) && itemArtifacts.some(artifact => artifact.role === role)).map(role => <article className="wb2-artifact" key={role}><h3>{roleName[role]} · 历史成果（当前未参与）</h3>{itemArtifacts.filter(artifact => artifact.role === role).map(artifact => <div className="wb2-version" key={artifact.id}><strong>v{artifact.version} · 修订 {artifact.revision} · {artifact.created_at}</strong><p>运行 {artifact.run_id.slice(0, 8)}{artifact.upstream_artifact_id ? ` · 上游 ${artifact.upstream_artifact_id.slice(0, 8)}` : ""}</p><div className="wb2-paper"><RichText text={artifact.content} /></div></div>)}</article>)}</section>}
        {detailPane === "history" && practiceSection}
        {detailPane === "history" && itemPractices.some(round => !itemRoles.includes(round.role)) && <section className="wb2-section"><h2>已移除角色的练习历史</h2>{itemPractices.filter(round => !itemRoles.includes(round.role)).map(round => <div className="wb2-artifact" key={round.id}><h3>{roleName[round.role]} · {round.status === "feedback" ? "反馈已保存" : runStatusName[round.status] || round.status}</h3><p>来源成果 {round.source_artifact_id.slice(0, 8)}</p>{round.question && <div>题目：<RichText text={displayPracticeQuestion(round)} />{questionOptions(round).length > 0 && <ol className="wb2-history-options">{questionOptions(round).map(option => <li key={option.label}><strong>{option.label}.</strong> <RichText text={option.text} /></li>)}</ol>}</div>}{round.answer && <div>你的回答：<RichText text={round.answer} /></div>}{round.feedback && <div className="wb2-paper">模型反馈：<RichText text={round.feedback} /><strong>下轮建议</strong><RichText text={round.suggestion} /></div>}</div>)}</section>}
        {detailPane === "results" && itemRoles.length > 0 && <section className="wb2-section wb2-card"><h2>纠正事实或要求修改</h2><p className="muted">写下你实际要改的内容；系统不会用草图中的固定纠正代替你的输入。</p><label>影响范围<select value={correctionScopes[item.id] || "shared"} onChange={event => setCorrectionScopes(current => ({ ...current, [item.id]: event.target.value as "shared" | "english" }))}><option value="shared">事实或通用要求：更新相关中文与英文成果</option><option value="english">仅英文表达：保留中文成果</option></select></label><label>你的纠正<textarea maxLength={2000} value={correction} onChange={event => setCorrectionDrafts(current => ({ ...current, [item.id]: event.target.value }))} placeholder="说明哪项事实或表达需要改，以及准确内容" /></label><MarkdownPreview text={correction} /><button disabled={busy || item.lifecycle !== "open" || practiceRunning || item.status === "running" || hasDirtyItem || !correction.trim()} onClick={() => saveCorrection(item)}>保存纠正</button>{work?.facts.filter(fact => fact.item_id === item.id).map(fact => <div className="wb2-fact" key={fact.id}><strong>修订 {fact.revision} · 用户明确纠正</strong><RichText text={fact.text} /></div>)}<p className="muted">事实纠正会更新相关上游与下游；仅英文表达修改只更新英语成果。运行中请先取消。</p></section>}
        <details className="wb2-section wb2-card wb2-editor" id="quick-item-editor" open={quickEditorOpen} onToggle={event => setQuickEditorOpen(event.currentTarget.open)}><summary>修改需求、分工与参与安排{hasDirtyItem ? " · 有未保存草稿" : ""}</summary><label>事项需求<textarea maxLength={4000} value={itemRequest} onChange={event => { setItemRequest(event.target.value); cacheItemDraft(item, { request: event.target.value }); }} /></label><MarkdownPreview text={itemRequest} /><label>只针对英文表达的补充要求<textarea maxLength={2000} value={itemEnglishRequirement} onChange={event => { setItemEnglishRequirement(event.target.value); cacheItemDraft(item, { englishRequirement: event.target.value }); }} placeholder="例如：英文介绍控制在一分钟。此栏不会要求重新生成中文成果。" /></label><MarkdownPreview text={itemEnglishRequirement} /><fieldset><legend>参与角色（显式调整）</legend>{(["career", "english"] as Role[]).map(role => <label className="inline" key={role}><input type="checkbox" checked={itemEditRoles.includes(role)} onChange={event => { const next = (["career", "english"] as Role[]).filter(value => value === role ? event.target.checked : itemEditRoles.includes(value)); setItemEditRoles(next); cacheItemDraft(item, { roles: next }); }} /> {roleName[role]}</label>)}</fieldset>{itemEditRoles.filter(role => !itemRoles.includes(role)).map(role => <p className="muted" key={role}>新增 {roleName[role]} 后，该角色的新运行可见：{roleScope(role, itemEditRoles.includes("career"))}；不会读取其他事项的私有资料。</p>)}<label>本事项资料<textarea maxLength={8000} value={itemMaterial} onChange={event => { setItemMaterial(event.target.value); cacheItemDraft(item, { material: event.target.value }); }} /></label><MarkdownPreview text={itemMaterial} /><div className="row"><label>你的参与时间<input type="number" min="10" max="480" value={itemMinutes} onChange={event => { const value = Number(event.target.value); setItemMinutes(value); cacheItemDraft(item, { minutes: value }); }} /></label><label>优先级<select value={itemPriority} onChange={event => { const value = Number(event.target.value); setItemPriority(value); cacheItemDraft(item, { priority: value }); }}>{[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value}</option>)}</select></label></div><p className="muted">参与时间与优先级只调整安排，保留有效成果；英文补充要求只更新英语成果。需求或资料改动会更新相关成果，历史与来源仍可查看。</p>{itemEditRevision !== item.revision && <div className="wb2-card" role="alert"><p>事项已在另一页面更新到修订 {item.revision}。当前草稿已保留；请核对最新内容后选择。</p><details><summary>查看最新已保存内容</summary><p>需求：{item.request}</p><div>英文补充要求：<RichText text={item.english_requirement || "无"} /></div><p>参与角色：{asRoles(item).map(role => roleName[role]).join("、") || "无"}</p><div>资料：<RichText text={item.material || "无"} /></div><p>参与时间：{item.minutes} 分钟 · 优先级：{item.priority}/5</p></details><div className="row"><button onClick={() => { setItemEditRevision(item.revision); setItemDrafts(current => current[item.id] ? { ...current, [item.id]: { ...current[item.id], baseRevision: item.revision } } : current); }}>已核对，以当前输入保存</button><button onClick={() => { setItemRequest(item.request); setItemMaterial(item.material); setItemEnglishRequirement(item.english_requirement); setItemEditRoles(asRoles(item)); setItemMinutes(item.minutes); setItemPriority(item.priority); setItemEditRevision(item.revision); setItemDrafts(current => { const next = { ...current }; delete next[item.id]; return next; }); }}>舍弃本地草稿并载入最新内容</button></div></div>}<button disabled={busy || item.lifecycle !== "open" || practiceRunning || item.status === "running" || itemEditRevision !== item.revision || !hasDirtyItem || !itemRequest.trim()} onClick={() => update(item)}>保存修改</button><p className="muted">运行中请先取消。增减角色需要在这里明确保存；仅在资料里提及新角色不会自动授权。</p></details>
      </div>{contextOpen && <button tabIndex={-1} className="wb2-context-backdrop" aria-label="关闭事项信息" onClick={() => { setContextOpen(false); quickContextButton.current?.focus(); }} />}<aside ref={quickContextPanel} className="wb2-aside wb2-item-context" id="quick-item-context" data-open={contextOpen} role={contextOpen ? "dialog" : undefined} aria-modal={contextOpen || undefined} aria-labelledby="quick-item-context-title"><div className="wb2-context-heading"><h2 id="quick-item-context-title">事项工作区</h2><button onClick={() => { setContextOpen(false); quickContextButton.current?.focus(); }}>关闭</button></div><p className="muted">{nextAction(item, work)}</p><p className="muted">你的参与时间 {item.minutes} 分钟 · 优先级 {item.priority}/5 · 事项修订 {item.revision}</p><h2>协作进展</h2><details open><summary>分工、交接与来源</summary>{itemRoles.map(role => { const current = recentArtifact(itemArtifacts, item, role); const running = itemRuns.find(run => run.role === role && run.status === "running"); return <div className="step" key={role}><strong>{roleName[role]}</strong><p>{running ? "执行中" : current ? `已生成 v${current.version}` : "待执行"}</p></div>; })}</details><details><summary>本次资料范围</summary><p>{itemRoles.map(role => `${roleName[role]}：${roleScope(role, itemRoles.includes("career"))}`).join("；")}。其他事项资料仅在你明确关联来源后进入本次上下文。</p></details><section className="wb2-context-block"><h2>排期</h2><p className="muted">计划日：{item.planned_date || "未安排"} · 截止日：{item.due_date || "未设置"}</p><details><summary>修改排期</summary><p className="muted">改期不影响已有成果或模型运行。</p><ScheduleEditor key={item.id} compact entry={item} endpoint="/api/work-items" onState={next => { refreshSeq.current += 1; setWork(next as WorkState); }} /></details></section>{sourcePanel}<details className="wb2-context-block"><summary>协作分工与资料范围</summary><section className="wb2-card"><h2>这次怎么配合</h2>{itemRoles.length ? <><p>系统规则按所选角色和时间生成透明分工；计划本身不调用模型。</p>{itemRoles.map((role, index) => <div className="step" key={role}><strong>{index + 1}. {roleName[role]} → {role === "career" ? "中文求职内容" : "英文表达成果"}</strong><p>可见：{roleScope(role, itemRoles.includes("career"))}。</p></div>)}<div className="step"><strong>你 → 核对事实和决定下一步</strong><p>准备工作不会冒充你的练习时间；此处的 {item.minutes} 分钟用于核对、练习或复盘。</p><p>{timePlan(item.minutes)}</p></div><p className="muted">启动后预计最多 {itemRoles.length} 次模型调用，每步最多一次；失败需你手动重试。</p></> : <p>此快捷事项尚无参与角色；可使用自定义 Agent 事项安排其他方向。</p>}</section></details><details className="wb2-context-block"><summary>运行记录（{itemRuns.length}）</summary>{itemRuns.map(run => <div className="wb2-run" key={run.id}><strong>{roleName[run.role]} · {runStatusName[run.status] || run.status}</strong><p>{run.model} · 修订 {run.revision}</p>{run.error && <p>{run.error}</p>}<details><summary>输入来源</summary><p>快照已保存；本次引用的资料与偏好可追溯。</p><pre>{run.context_json}</pre></details></div>)}{!itemRuns.length && <p className="muted">尚无模型运行。</p>}</details><div className="wb2-context-block"><h2>事项管理</h2><div className="row">{item.lifecycle === "open" ? <><button disabled={busy || !!running || practiceRunning || !allAccepted || item.status !== "ready"} onClick={() => { const unfinishedIds = unfinishedRounds.map(({ round }) => round.id); if (unfinishedIds.length) setCompleteConfirm({ itemId: item.id, revision: item.revision, unfinishedIds }); else lifecycle(item, "complete"); }}>完成事项</button><button disabled={busy || !!running || practiceRunning} onClick={() => lifecycle(item, "archive")}>归档</button></> : <button disabled={busy} onClick={() => lifecycle(item, "reopen")}>重新打开</button>}</div>{item.lifecycle === "open" && item.status === "ready" && !allAccepted && <p className="muted">请先逐一确认当前成果，再完成事项。</p>}</div></aside></div></>}
      <MemoryWorkspace visible={view === "memory"} work={work} agents={agentWork} legacyCount={old?.memories.length || 0} busy={busy} onOpenQuick={openItem} onOpenAgent={openAgentJob} onOpenItems={() => setView("items")} onCreateItem={startNewItem} onPreferenceAction={mutateMemoryPreference} />
      <AgentWorkspace mode={view === "team" ? "team" : "jobs"} visible={view === "team" || view === "agentJobs"} onOpenJobs={() => setView("agentJobs")} onOpenTeam={() => setView("team")} onOpenConnections={() => openSettings("connection")} onStateChange={handleAgentState} sharedState={agentWork} openJobRequest={openAgentRequest} startDraftRequest={agentStartDraft} connection={connection} onConnectionChange={setConnection} />
    </main><footer className="footer">本地单用户工作台 · 只有启动模型运行时才向所选渠道发送本事项输入及你明确关联的来源快照</footer></div>
    {settingsOpen && <div className="settings-overlay"><div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} ref={settingsRef} onKeyDown={settingsKeyDown}>
      <WorkspaceSettings section={settingsSection} onSectionChange={setSettingsSection} defaultView={defaultView} onDefaultViewChange={setDefaultView} defaultCalendarMode={defaultCalendarMode} onDefaultCalendarModeChange={setDefaultCalendarMode} themeMode={themeMode} onThemeModeChange={setThemeMode} neutral={neutral} onNeutralChange={setNeutral} color={color} onColorChange={setColor} connection={connection} keyInput={keyInput} onKeyInputChange={setKeyInput} onConnectionAction={connectionAction} busy={busy} notice={notice} counts={{ items: mergedItems.length, agents: agentWork?.profiles.length || 0, preferences: agentWork?.preferences.filter(preference => preference.active).length || 0 }} onNavigate={destination => { closeSettings(); setView(destination); setNotice(""); }} onClose={closeSettings} />
    </div></div>}
  </div>;
}
