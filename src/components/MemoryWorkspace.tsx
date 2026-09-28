"use client";

import { useEffect, useState } from "react";
import RichText, { MarkdownPreview } from "./RichText";
import type { AgentState } from "./AgentWorkspace";
import type { WorkState } from "./WorkbenchV2";

type QuickItem = WorkState["items"][number];
type AgentJob = AgentState["jobs"][number];
type Category = "materials" | "corrections" | "artifacts" | "preferences";
type SourceKind = "quick" | "agent";
type LibraryEntry = {
  key: string;
  category: Exclude<Category, "preferences">;
  kind: SourceKind;
  title: string;
  text: string;
  updatedAt: string;
  quick?: QuickItem;
  job?: AgentJob;
  producer?: string;
  version?: number;
  correctionState?: "recorded" | "active" | "archived";
};
type Preference = { id: string; agent_id: string; text: string; active: number };

const presetNames: Record<string, string> = { career: "求职顾问", english: "英语教练" };
const isPreset = (id: string) => id === "career" || id === "english";
const categories: { id: Category; label: string }[] = [
  { id: "materials", label: "事项资料" },
  { id: "corrections", label: "明确纠正" },
  { id: "artifacts", label: "可接续成果" },
  { id: "preferences", label: "长期偏好" },
];
function assignedAgentIds(entry: LibraryEntry) {
  try {
    const parsed: unknown = JSON.parse(entry.quick?.roles || entry.job?.steps_json || "[]");
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((value: unknown) => typeof value === "string" ? value : value && typeof value === "object" && "agentId" in value && typeof value.agentId === "string" ? value.agentId : "").filter(Boolean))];
  } catch { return []; }
}
function excerpt(text: string, query: string) {
  const plain = text.replace(/\s+/g, " ").trim();
  if (!plain) return "";
  const index = query ? plain.toLocaleLowerCase().indexOf(query) : -1;
  const start = index < 0 ? 0 : Math.max(0, index - 38);
  const end = Math.min(plain.length, index < 0 ? 112 : index + query.length + 68);
  const before = plain.slice(start, index < 0 ? end : index);
  const match = index < 0 ? "" : plain.slice(index, index + query.length);
  const after = index < 0 ? "" : plain.slice(index + query.length, end);
  return <>{start > 0 && "…"}{before}{match && <mark>{match}</mark>}{after}{end < plain.length && "…"}</>;
}

export default function MemoryWorkspace({ visible, work, agents, legacyCount, busy, onOpenQuick, onOpenAgent, onOpenItems, onCreateItem, onPreferenceAction }: {
  visible: boolean;
  work: WorkState | null;
  agents: AgentState | null;
  legacyCount: number;
  busy: boolean;
  onOpenQuick: (item: QuickItem) => void;
  onOpenAgent: (id: string) => void;
  onOpenItems: () => void;
  onCreateItem: () => void;
  onPreferenceAction: (agentId: string, body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [tab, setTab] = useState<Category>("materials");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "quick" | "agent">("all");
  const [selectedKey, setSelectedKey] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [newDrafts, setNewDrafts] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, { text: string; expectedText: string }>>({});
  const [message, setMessage] = useState<{ agentId: string; text: string } | null>(null);

  const allPreferences: Preference[] = agents?.preferences || work?.preferences.map(pref => ({ id: pref.id, agent_id: pref.role, text: pref.text, active: pref.active })) || [];
  const activePreferences = allPreferences.filter(pref => pref.active);
  const profileNames = new Map((agents?.profiles || []).map(profile => [profile.id, profile.name]));
  const profileIds = [...new Set(["career", "english", ...(agents?.profiles || []).map(profile => profile.id), ...allPreferences.map(pref => pref.agent_id)])];
  const agentName = (id: string) => {
    const name = profileNames.get(id) || presetNames[id] || "历史 Agent";
    return `${name}${(agents?.profiles || []).filter(profile => profile.name === name).length > 1 ? ` · ${id.slice(0, 8)}` : ""}`;
  };
  const entries: LibraryEntry[] = [
    ...(work?.items || []).filter(item => item.material.trim()).map(item => ({ key: `material:quick:${item.id}`, category: "materials" as const, kind: "quick" as const, title: item.request, text: item.material, updatedAt: item.updated_at, quick: item })),
    ...(agents?.jobs || []).filter(job => job.material.trim()).map(job => ({ key: `material:agent:${job.id}`, category: "materials" as const, kind: "agent" as const, title: job.request, text: job.material, updatedAt: job.updated_at, job })),
    ...(work?.facts || []).flatMap(fact => { const item = work?.items.find(value => value.id === fact.item_id); return item ? [{ key: `correction:quick:${fact.id}`, category: "corrections" as const, kind: "quick" as const, title: item.request, text: fact.text, updatedAt: item.updated_at, quick: item, version: fact.revision, correctionState: "recorded" as const }] : []; }),
    ...(agents?.corrections || []).flatMap(correction => { const job = agents?.jobs.find(value => value.id === correction.job_id); return job ? [{ key: `correction:agent:${correction.id}`, category: "corrections" as const, kind: "agent" as const, title: job.request, text: correction.text, updatedAt: job.updated_at, job, version: correction.revision, correctionState: correction.active ? "active" as const : "archived" as const }] : []; }),
    ...(work?.artifacts || []).flatMap(artifact => { const item = work?.items.find(value => value.id === artifact.item_id); return item && artifact.current === true && artifact.accepted_at ? [{ key: `artifact:quick:${artifact.id}`, category: "artifacts" as const, kind: "quick" as const, title: item.request, text: artifact.content, updatedAt: artifact.accepted_at, quick: item, producer: agentName(artifact.role), version: artifact.version }] : []; }),
    ...(agents?.jobs || []).flatMap(job => (agents?.current[job.id] || []).flatMap(id => { const artifact = agents?.artifacts.find(value => value.id === id); return artifact?.accepted_at ? [{ key: `artifact:agent:${artifact.id}`, category: "artifacts" as const, kind: "agent" as const, title: job.request, text: artifact.content, updatedAt: artifact.accepted_at, job, producer: agentName(artifact.agent_id), version: artifact.version }] : []; })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredEntries = entries.filter(entry => entry.category === tab && (kind === "all" || entry.kind === kind) && (!normalizedQuery || `${entry.title} ${entry.text} ${entry.producer || ""}`.toLocaleLowerCase().includes(normalizedQuery)));
  const filteredAgents = profileIds.filter(id => !normalizedQuery || `${agentName(id)} ${allPreferences.filter(pref => pref.agent_id === id).map(pref => pref.text).join(" ")}`.toLocaleLowerCase().includes(normalizedQuery));
  const selectedEntry = filteredEntries.find(entry => entry.key === selectedKey) || filteredEntries[0];
  const selectedEntryAgentIds = selectedEntry ? assignedAgentIds(selectedEntry) : [];
  const selectedEntryAgents = selectedEntryAgentIds.map(agentName);
  const currentAgent = filteredAgents.includes(selectedAgent) ? selectedAgent : filteredAgents[0] || (profileIds.includes(selectedAgent) ? selectedAgent : profileIds[0]);
  const selectedPreferences = activePreferences.filter(pref => pref.agent_id === currentAgent);
  const revokedPreferences = allPreferences.filter(pref => pref.agent_id === currentAgent && !pref.active);
  const counts: Record<Category, number> = { materials: entries.filter(entry => entry.category === "materials").length, corrections: entries.filter(entry => entry.category === "corrections").length, artifacts: entries.filter(entry => entry.category === "artifacts").length, preferences: allPreferences.length };

  useEffect(() => {
    const dirty = Object.values(newDrafts).some(value => value.trim()) || Object.entries(edits).some(([id, draft]) => activePreferences.find(pref => pref.id === id)?.text !== draft.text);
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [newDrafts, edits, agents?.preferences]);

  async function savePreference() {
    const submittedDraft = newDrafts[currentAgent] || "";
    const text = submittedDraft.trim();
    if (!text) return;
    if (await onPreferenceAction(currentAgent, { type: "preference.save", agentId: currentAgent, text })) {
      setNewDrafts(current => current[currentAgent] === submittedDraft ? { ...current, [currentAgent]: "" } : current);
      setMessage({ agentId: currentAgent, text: "偏好已保存；后续属于这位 Agent 的运行会引用。" });
    }
  }
  async function updatePreference(pref: Preference, active: boolean) {
    const draft = edits[pref.id];
    const submitted = active ? (draft?.text ?? pref.text).trim() : pref.text;
    if (await onPreferenceAction(pref.agent_id, { type: "preference.update", id: pref.id, text: submitted, active, expectedText: draft?.expectedText ?? pref.text, expectedActive: true })) {
      setEdits(current => { if (current[pref.id]?.text !== draft?.text) return current; const next = { ...current }; delete next[pref.id]; return next; });
      setMessage({ agentId: pref.agent_id, text: active ? "偏好已更新；历史运行快照保持原样。" : "偏好已撤销；后续运行不再引用。" });
    }
  }

  const showEmpty = tab === "preferences" ? !profileIds.length : !selectedEntry;
  const tabLabel = categories.find(category => category.id === tab)?.label || "内容";

  return <div className="wb2-memory" hidden={!visible}>
    <div className="kicker">CONTEXT YOU CONTROL</div>
    <h1>资料与记忆</h1>
    <p className="wb2-intro">按来源找到内容，再决定如何使用。事项资料和纠正留在原事项；只有当前已确认的成果能由你显式接续。</p>
    <div className="wb2-memory-tabs" aria-label="资料与记忆类型">
      {categories.map(category => <button type="button" key={category.id} aria-pressed={tab === category.id} onClick={() => { setTab(category.id); setQuery(""); setKind("all"); setMessage(null); }}>{category.label}<span>{counts[category.id]}</span></button>)}
    </div>
    <div className="wb2-memory-toolbar">
      <label className="wb2-memory-search">{tab === "preferences" ? "搜索 Agent 与偏好" : `搜索${tabLabel}全文`}<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={tab === "preferences" ? "输入 Agent 或偏好关键词" : "输入事项或正文关键词"} /></label>
      {tab !== "preferences" && <div className="wb2-memory-filters" aria-label="事项类型">{([ ["all", "全部"], ["quick", "预设事项"], ["agent", "自定义事项"] ] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={kind === id} onClick={() => setKind(id)}>{label}</button>)}</div>}
    </div>
    {showEmpty ? <section className="wb2-memory-empty-panel" aria-label={`${tabLabel}空状态`}>
      <h2>{query || kind !== "all" ? `没有匹配的${tabLabel}` : tab === "preferences" ? "没有可管理的 Agent" : tab === "materials" ? "从事项开始积累资料" : `还没有${tabLabel}`}</h2>
      <p>{query || kind !== "all" ? "试试其他关键词或事项类型。" : tab === "artifacts" ? "在所属事项核对并确认成果后，当前版本会出现在这里，供后续事项显式接续。" : tab === "corrections" ? "在所属事项提出明确纠正后，可以在这里追溯。" : tab === "preferences" ? "创建 Agent 后，可以为它保存明确的长期偏好。" : "新建事项并粘贴文字资料后，就能从这里查找。"}</p>
      <div className="row">{query || kind !== "all" ? <button type="button" onClick={() => { setQuery(""); setKind("all"); }}>清除筛选</button> : <><button type="button" onClick={onOpenItems}>查看我的事项</button><button type="button" className="primary" onClick={onCreateItem}>新建事项</button></>}</div>
    </section> : <div className="wb2-memory-layout">
      <section className="wb2-memory-list" aria-label={tab === "preferences" ? "选择 Agent 偏好" : `选择${tabLabel}`}>
        <div className="wb2-memory-list-items">{tab === "preferences" ? filteredAgents.map(id => { const matching = normalizedQuery ? allPreferences.find(pref => pref.agent_id === id && pref.text.toLocaleLowerCase().includes(normalizedQuery)) : null; return <button type="button" key={id} className="wb2-memory-list-item" aria-current={currentAgent === id ? "true" : undefined} onClick={() => { setSelectedAgent(id); setMessage(null); }}><span className="wb2-memory-list-top"><strong>{agentName(id)}</strong><span>{isPreset(id) ? "预设" : "自定义"}</span></span><small>{activePreferences.filter(pref => pref.agent_id === id).length} 条有效 · {allPreferences.filter(pref => pref.agent_id === id && !pref.active).length} 条已撤销</small>{matching && <p className="wb2-memory-snippet">{excerpt(matching.text, normalizedQuery)}</p>}</button>; }) : filteredEntries.map(entry => <button type="button" key={entry.key} className="wb2-memory-list-item" aria-current={selectedEntry?.key === entry.key ? "true" : undefined} onClick={() => setSelectedKey(entry.key)}><span className="wb2-memory-list-top"><strong>{entry.title}</strong><span>{entry.kind === "quick" ? "预设" : "自定义"}</span></span><small>{entry.category === "artifacts" ? `${entry.producer} v${entry.version} · 当前已确认` : entry.category === "corrections" ? `修订 ${entry.version} · ${entry.correctionState === "archived" ? "已停用" : entry.correctionState === "active" ? "有效" : "已记录"}` : "事项原始资料"} · {entry.updatedAt.slice(0, 10)}</small><p className="wb2-memory-snippet">{excerpt(entry.text, normalizedQuery)}</p></button>)}</div>
        {tab === "preferences" && !filteredAgents.length && <div className="empty">没有匹配的 Agent 或偏好。<button type="button" onClick={() => setQuery("")}>清除搜索</button></div>}
      </section>
      <section className="wb2-memory-detail">{tab !== "preferences" && selectedEntry ? <>
        <div className="wb2-memory-detail-head"><span className="tag">{tabLabel} · {selectedEntry.kind === "quick" ? "预设事项" : "自定义 Agent 事项"}</span><h2>{selectedEntry.title}</h2><p className="muted">来源：{selectedEntry.category === "artifacts" ? `${selectedEntry.producer}已确认成果 v${selectedEntry.version}` : selectedEntry.category === "corrections" ? `你在所属事项中的明确纠正 · 修订 ${selectedEntry.version}` : "你在所属事项中提供的文本资料"} · {selectedEntry.updatedAt.slice(0, 10)}</p><p className="muted">事项参与 Agent：{selectedEntryAgents.join(" → ") || "尚未安排"}</p></div>
        <div className="wb2-memory-detail-scroll"><div className="wb2-memory-scope"><strong>使用范围</strong><p>{selectedEntry.category === "artifacts" ? "这是当前已确认版本。你可以在新事项的「接续上一件事」中明确选择它；其他事项不会自动获得这份成果。" : selectedEntry.category === "materials" ? "资料属于此事项，是否进入某位 Agent 的运行取决于该事项和 Agent 的资料权限；不会自动用于其他事项。" : selectedEntry.correctionState === "archived" ? "这条自定义事项纠正已停用，不再用于后续运行；历史成果与运行快照保持原样。" : selectedEntry.correctionState === "active" ? "这条纠正仅用于所属事项的后续运行。若其影响后的成果经你确认并关联到新事项，接续的是成果快照，并非纠正文本本身。" : "这是预设事项中的已记录纠正；该流程不提供逐条停用，不能据此推断其他事项可直接读取。"}</p></div>{selectedEntryAgentIds.length > 0 && <div className="wb2-memory-permissions"><strong>所属事项参与 Agent 的当前权限</strong><ul>{selectedEntryAgentIds.map(id => { const profile = agents?.profiles.find(value => value.id === id); return <li key={id}>{agentName(id)}：{profile ? `事项资料${profile.allow_material ? "可读取" : "不可读取"}；上游成果${profile.allow_upstream ? "可读取" : "不可读取"}` : "配置未载入，权限未知"}</li>; })}</ul><p>新事项会按其参与 Agent 的权限重新检查。</p></div>}<RichText text={selectedEntry.text} /></div>
        <div className="wb2-memory-detail-footer"><p>{selectedEntry.category === "artifacts" ? "要复用此版本，先新建事项，再在新事项中选择来源并预览；旧版本不会自动替换。" : "修改资料或纠正请返回所属事项。相关成果如需更新，要由你手动启动；历史快照保留。"}</p><div className="row">{selectedEntry.category === "artifacts" && <button type="button" onClick={onCreateItem}>新建事项</button>}<button type="button" className="primary" onClick={() => selectedEntry.quick ? onOpenQuick(selectedEntry.quick) : selectedEntry.job && onOpenAgent(selectedEntry.job.id)}>打开所属事项 →</button></div></div>
      </> : currentAgent ? <>
        <div className="wb2-memory-detail-head"><span className="tag">{isPreset(currentAgent) ? "预设 Agent" : "自定义 Agent"}</span><h2>{agentName(currentAgent)}</h2><p className="muted">{selectedPreferences.length} / 5 条有效偏好 · 只用于这位 Agent 的后续运行；与 Agent 指令分开管理</p></div>
        <div className="wb2-memory-detail-scroll"><div className="wb2-memory-create"><label>新增长期偏好<textarea maxLength={500} value={newDrafts[currentAgent] || ""} onChange={event => setNewDrafts(current => ({ ...current, [currentAgent]: event.target.value }))} placeholder="例如：回答先给结论，再给依据" /></label><MarkdownPreview text={newDrafts[currentAgent] || ""} /><button type="button" className="primary" disabled={busy || !newDrafts[currentAgent]?.trim() || selectedPreferences.length >= 5} onClick={savePreference}>保存偏好</button></div>
          <h3>有效偏好</h3>{selectedPreferences.map(pref => { const draft = edits[pref.id]; const stale = !!draft && draft.expectedText !== pref.text; return <article className="wb2-memory-pref" key={pref.id}><label>偏好内容<textarea maxLength={500} value={draft?.text ?? pref.text} onChange={event => setEdits(current => ({ ...current, [pref.id]: { text: event.target.value, expectedText: current[pref.id]?.expectedText ?? pref.text } }))} /></label><MarkdownPreview text={draft?.text ?? pref.text} />{stale && <p role="alert">这条偏好已在其他入口更新。请核对后载入最新内容。</p>}<div className="row"><button type="button" disabled={busy || stale || !draft?.text.trim() || draft.text === pref.text} onClick={() => updatePreference(pref, true)}>保存编辑</button><button type="button" disabled={busy || stale} onClick={() => updatePreference(pref, false)}>撤销偏好</button>{stale && <button type="button" onClick={() => setEdits(current => { const next = { ...current }; delete next[pref.id]; return next; })}>载入最新</button>}</div></article>; })}{!selectedPreferences.length && <p className="muted">这位 Agent 尚无有效偏好。事项中的事实纠正不会自动成为偏好。</p>}
          {Object.keys(edits).filter(id => !activePreferences.some(pref => pref.id === id)).map(id => <p role="alert" key={id}>一条偏好草稿的来源已停用。<button type="button" onClick={() => setEdits(current => { const next = { ...current }; delete next[id]; return next; })}>舍弃草稿</button></p>)}
          <details className="wb2-memory-history"><summary>已撤销偏好 · {revokedPreferences.length}</summary>{revokedPreferences.length ? revokedPreferences.map(pref => <article key={pref.id} className="wb2-memory-pref"><span className="tag">已撤销 · 不再用于后续运行</span><RichText text={pref.text} /></article>) : <p className="muted">没有已撤销偏好。</p>}</details>
        </div><div className="wb2-memory-detail-footer"><p>撤销只影响后续运行，历史成果与运行快照不会被改写。</p>{message?.agentId === currentAgent && <p role="status">{message.text}</p>}</div>
      </> : null}</section>
    </div>}
    {legacyCount > 0 && <p className="wb2-memory-legacy">另有 {legacyCount} 条旧版记忆保留在原任务中。<a href="/legacy">查看旧版记录 ↗</a></p>}
  </div>;
}
