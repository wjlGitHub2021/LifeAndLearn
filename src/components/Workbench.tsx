"use client";
import RichText, { MarkdownPreview } from "./RichText";
import ModelConnectionsPanel, { modelReadyForAgent, type ModelConnectionStatus } from "./ModelConnectionsPanel";
import { useCallback, useEffect, useRef, useState } from "react";

type Agent = { id: string; name: string; role: string; enabled: number; preference: string; permission: string };
type Goal = { id: string; domain: "english" | "career"; title: string; detail: string; priority: number; active: number };
type Task = { id: string; goal_id: string; agent_id: string; title: string; prompt: string; minutes: number; status: string; rationale: string; draft: string; feedback: string | null; suggestion: string | null; plan_date: string };
type Run = { id: string; task_id: string; agent_id: string; status: string; input: string; output: string | null; model: string | null; error: string | null; created_at: string; context_refs: string };
type Memory = { id: string; goal_id: string; agent_id: string; source_run_id: string; text: string; status: string };
type AppState = { agents: Agent[]; goals: Goal[]; tasks: Task[]; runs: Run[]; memories: Memory[]; budget: number; today: string };
type Proposal = { budget: number; lockedMinutes: number; token: string; items: { goalId: string; agentId: string; title: string; prompt: string; minutes: number; rationale: string }[]; issues: string[]; reason: string };
type ThemeMode = "neutral" | "color";
type View = "today" | "goals" | "team" | "history" | "detail" | "connection";
type Connection = ModelConnectionStatus;
const nav: { id: View; label: string; icon: string }[] = [{ id: "today", label: "今天", icon: "◌" }, { id: "goals", label: "目标", icon: "◎" }, { id: "team", label: "Agent 团队", icon: "◇" }, { id: "history", label: "执行记录", icon: "▤" }];
const statusName: Record<string, string> = { waiting: "等待作答", running: "处理中", feedback: "反馈待查看", done: "已结束", failed: "失败，可重试", cancelled: "已取消，可重试", superseded: "已调整", interrupted: "运行中断" };
const processingNotice = "作答已保存，模型正在处理；本页会更新运行结果";
type GoalForm = { id: string; domain: Goal["domain"]; title: string; detail: string; priority: number };
const emptyGoal: GoalForm = { id: "", domain: "english", title: "", detail: "", priority: 3 };

async function readJson(response: Response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "请求失败");
  return value;
}
function modelLabel(id: string | null, connection: Connection | null) {
  if (!id) return "未选择模型";
  const name = connection?.modelNames?.[id];
  return name && name !== id ? `${name} (${id})` : id;
}

export default function Workbench() {
  const [data, setData] = useState<AppState | null>(null);
  const [view, setView] = useState<View>("today");
  const [taskId, setTaskId] = useState("");
  const [budget, setBudget] = useState(60);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [goalForm, setGoalForm] = useState<GoalForm>(emptyGoal);
  const [draft, setDraft] = useState("");
  const [draftCache, setDraftCache] = useState<Record<string, string>>({});
  const [memoryEdit, setMemoryEdit] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>("neutral");
  const [neutralTheme, setNeutralTheme] = useState<"dark" | "light">("dark");
  const [colorTheme, setColorTheme] = useState<"blue" | "green" | "sand">("blue");
  const [themeLoaded, setThemeLoaded] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const connectionRequest = useRef(0);

  const refresh = useCallback(async () => {
    const value = await readJson(await fetch("/api/state", { cache: "no-store" }));
    setData(value); setBudget(value.budget);
  }, []);
  useEffect(() => { refresh().catch(e => setNotice(e.message)); }, [refresh]);
  useEffect(() => {
    if (!data?.runs.some(r => r.status === "running")) return;
    const timer = setInterval(() => {
      fetch("/api/state", { cache: "no-store" }).then(readJson).then(setData).catch(() => {});
      fetch("/api/connection", { cache: "no-store" }).then(readJson).then((value: Connection) => setConnection(current => current && current.serverEpoch === value.serverEpoch && current.version > value.version ? current : value)).catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [data?.runs]);
  useEffect(() => { fetch("/api/connection", { cache: "no-store" }).then(readJson).then((value: Connection) => setConnection(current => current && current.serverEpoch === value.serverEpoch && current.version > value.version ? current : value)).catch(() => {}); }, []);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("workbench.theme") || "{}");
      if (["neutral", "color"].includes(saved.mode)) setThemeMode(saved.mode);
      if (["dark", "light"].includes(saved.neutral)) setNeutralTheme(saved.neutral);
      if (["blue", "green", "sand"].includes(saved.color)) setColorTheme(saved.color);
    } catch { /* invalid local appearance preference uses defaults */ }
    setThemeLoaded(true);
  }, []);
  useEffect(() => { if (themeLoaded) localStorage.setItem("workbench.theme", JSON.stringify({ mode: themeMode, neutral: neutralTheme, color: colorTheme })); }, [themeLoaded, themeMode, neutralTheme, colorTheme]);

  async function action(body: Record<string, unknown>) {
    setBusy(true); setNotice("");
    try {
      const value = await readJson(await fetch("/api/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      setData(value.state);
      if (value.proposal) setProposal(value.proposal);
      return value;
    } catch (error) { setNotice(error instanceof Error ? error.message : "操作失败"); return null; }
    finally { setBusy(false); }
  }
  async function connectionAction(body: Record<string, unknown>) {
    const requestId = ++connectionRequest.current;
    setConnecting(true); setNotice("");
    try {
      const value = await readJson(await fetch("/api/connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      if (requestId !== connectionRequest.current) return false;
      setConnection(value);
      if (body.type === "connect") setKeyInput("");
      setNotice(body.type === "connect" ? "模型列表验证成功；生成可用性仍需通过实际任务验证" : body.type === "disconnect" ? "已断开连接" : "模型连接或选择已更新");
      return true;
    } catch (error) { if (requestId === connectionRequest.current) setNotice(error instanceof Error ? error.message : "连接失败"); return false; }
    finally { if (requestId === connectionRequest.current) setConnecting(false); }
  }
  async function runAction(body: Record<string, unknown>) {
    setSubmitting(true); setNotice("");
    try {
      const value = await readJson(await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      setData(value.state);
      if (value.connection) setConnection(current => current && current.version > value.connection.version ? current : value.connection);
      fetch("/api/connection", { cache: "no-store" }).then(readJson).then((latest: Connection) => setConnection(current => current && current.version > latest.version ? current : latest)).catch(() => {});
      if (body.type === "submit") setNotice(processingNotice);
      else setNotice("已取消本次运行；已发出的云端请求可能仍被计费");
    } catch (error) { setNotice(error instanceof Error ? error.message : "运行失败"); }
    finally { setSubmitting(false); }
  }
  const task = data?.tasks.find(t => t.id === taskId);
  const taskGoal = data?.goals.find(g => g.id === task?.goal_id);
  const taskAgent = data?.agents.find(a => a.id === task?.agent_id);
  const runningRun = data?.runs.find(r => r.task_id === taskId && r.status === "running");
  const latestSuccess = data?.runs.find(r => r.task_id === taskId && r.status === "success");
  const latestFailed = data?.runs.find(r => r.task_id === taskId && r.status === "failed");
  useEffect(() => {
    if (task?.status && task.status !== "running") setNotice(current => current === processingNotice ? "" : current);
  }, [task?.status]);
  const suggestionAccepted = !!latestSuccess && !!data?.memories.some(m => m.source_run_id === latestSuccess.id);
  const todayTasks = data?.tasks.filter(t => t.plan_date === data.today && t.status !== "superseded") || [];
  const pendingTasks = todayTasks.filter(t => t.status !== "done");
  const completedTasks = todayTasks.filter(t => t.status === "done");
  const allocatedMinutes = todayTasks.reduce((n, t) => n + t.minutes, 0);
  const archivedTasks = data?.tasks.filter(t => t.status === "superseded" || t.plan_date !== data.today) || [];
  const pageTitle = view === "detail" ? "任务详情" : view === "connection" ? "模型连接" : nav.find(n => n.id === view)?.label;
  function openTask(item: Task) { setTaskId(item.id); setDraft(draftCache[item.id] ?? item.draft); setView("detail"); setNotice(""); }
  function taskRow(item: Task) {
    return <div className="task-row" key={item.id}><div><h3>{item.title}</h3><p>{data?.goals.find(g => g.id === item.goal_id)?.title} · {item.rationale}</p><span className="tag">{data?.agents.find(a => a.id === item.agent_id)?.name}</span> <span className="tag">{statusName[item.status] || item.status}</span></div><div className="task-action"><span>{item.minutes} 分钟</span><button onClick={() => openTask(item)}>查看任务</button></div></div>;
  }
  async function saveGoal() {
    if (!goalForm.title.trim()) { setNotice("请填写目标"); return; }
    const result = await action({ type: goalForm.id ? "goal.update" : "goal.create", ...goalForm });
    if (result) { setGoalForm(emptyGoal); setProposal(null); setNotice("目标已保存；到“今天”预览并采用安排后，才会生成任务"); }
  }
  async function saveDraft() {
    if (!task) return;
    const result = await action({ type: "task.draft", id: task.id, draft });
    if (result) { setDraftCache({ ...draftCache, [task.id]: draft }); setNotice("草稿已保存到本地数据库"); }
  }

  return <div className="workbench" data-theme={themeMode === "neutral" ? neutralTheme : colorTheme}>
    <aside className="sidebar">
      <div className="brand"><span className="monogram">P</span><div><strong>个人工作台</strong><small>Personal workspace</small></div></div>
      <div><div className="sidebar-label">工作区</div><nav aria-label="主导航" className="nav">
        {nav.map(n => <button key={n.id} type="button" aria-pressed={view === n.id || (n.id === "today" && view === "detail")} onClick={() => { setView(n.id); setNotice(""); }}><span>{n.icon}</span>{n.label}</button>)}
      </nav></div>
      <div className="sidebar-goals"><div className="sidebar-label">参与安排的目标</div>{data?.goals.filter(g => g.active).slice(0, 4).map(g => <div className="sidebar-goal" key={g.id}><span className="dot" />{g.title}</div>)}</div>
      <div className="sidebar-bottom">个人空间<small>本地数据 · 模型在云端运行</small><a href="/">返回新版事项工作台 ↗</a></div>
    </aside>
    <div className="content">
      <header className="top"><div className="breadcrumb">工作区 <span>/</span> {pageTitle}</div><div className="top-actions">
        <button onClick={() => setView("connection")}>模型连接 · {connection?.connected ? "已连接" : connection?.needsReconnect ? "需重新连接" : "未连接"}</button>
        <div className="theme-group" role="group" aria-label="主题模式"><button aria-pressed={themeMode === "neutral"} onClick={() => setThemeMode("neutral")}>明暗主题</button><button aria-pressed={themeMode === "color"} onClick={() => setThemeMode("color")}>主题色</button></div>
        {themeMode === "neutral" ? <div className="theme-group" role="group" aria-label="固定明暗主题"><button aria-pressed={neutralTheme === "light"} onClick={() => setNeutralTheme("light")}>浅色</button><button aria-pressed={neutralTheme === "dark"} onClick={() => setNeutralTheme("dark")}>深色</button></div> : <div className="theme-group" role="group" aria-label="独立配色方案">{([ ["blue", "雾蓝"], ["green", "松绿"], ["sand", "暖棕"] ] as const).map(([id, label]) => <button key={id} aria-pressed={colorTheme === id} onClick={() => setColorTheme(id)}>{label}</button>)}</div>}
      </div></header>
      <main className="main">
        {notice && <div className="notice" role="status">{notice}</div>}
        {!data && <p className="muted">正在加载本地数据…</p>}
        {data && view === "today" && <>
          <div className="heading"><div><div className="kicker">YOUR DAILY FOCUS</div><h1>今天</h1><p>先选参与安排的目标和可用时间，再预览并采用任务。</p><button onClick={() => { setGoalForm(emptyGoal); setView("goals"); setNotice(""); }}>新增目标</button></div><div><label htmlFor="budget">今天可用的总时间</label><div className="row"><input id="budget" type="number" min="10" max="480" value={budget} onChange={e => { setBudget(Number(e.target.value)); setProposal(null); }} /><span>分钟</span><button disabled={busy} onClick={() => action({ type: "plan.preview", budget })}>预览今日安排</button></div></div></div>
          {proposal && <ProposalCard proposal={proposal} data={data} busy={busy} onAccept={async () => { const r = await action({ type: "plan.accept", budget: proposal.budget, token: proposal.token }); if (r) setProposal(null); }} onCancel={() => { setProposal(null); setBudget(data.budget); }} />}
          <div className="columns"><div>
            <section className="budget-strip"><div className="row spread"><h2>今日时间分配</h2><span className="muted">已保存预算 {data.budget} 分钟</span></div><div className="timebar"><span style={{ width: `${Math.min(100, allocatedMinutes / data.budget * 100)}%` }} /></div><p className="muted">已安排 {allocatedMinutes} / {data.budget} 分钟，其中已完成 {completedTasks.reduce((n, t) => n + t.minutes, 0)} 分钟。已开始或完成的任务仍占用今天的计划时间。</p>{allocatedMinutes >= data.budget && <p className="muted">想继续安排任务，请增加今天的总时间，再预览并采用；每个新任务至少需要 10 分钟。</p>}</section>
            <section><div className="row spread"><h2>今天待处理</h2><span className="muted">{pendingTasks.length} 项</span></div>{pendingTasks.length ? pendingTasks.map(taskRow) : <p className="empty">目前没有待处理任务。你可以新增目标，或调整目标是否参与安排，然后预览并采用今日安排。</p>}</section>
            {completedTasks.length > 0 && <section><div className="row spread"><h2>今天已完成</h2><span className="muted">{completedTasks.length} 项</span></div>{completedTasks.map(taskRow)}</section>}
          </div><aside className="context"><h2>如何控制今天？</h2><p>在“目标”中新增目标、调整优先级或暂停其参与后续安排；这里设置总时间，点击“预览今日安排”，核对后再“采用安排”。</p><p>完成的任务保留记录和计划时长；新增目标不会自动改动今天的任务。当前具体练习题由规则生成，不能直接编辑题目。</p><h2>协作中的 Agent</h2>{data.agents.map(a => <div className="agent-mini" key={a.id}><h3>{a.name} <span className="tag">{a.enabled ? "已启用" : "已暂停"}</span></h3><p>{a.role}</p></div>)}<details><summary>共享了什么信息？</summary><p>协调员只使用目标优先级、任务摘要和时间。原始回答仅发给所属领域角色。</p></details></aside></div>
        </>}
        {data && view === "goals" && <><div className="heading"><div><div className="kicker">YOUR GOALS</div><h1>目标</h1><p>可继续新增目标；已完成的任务不影响创建新目标。</p></div><button onClick={() => setView("today")}>返回今天安排</button></div><div className="columns"><section><h2>{goalForm.id ? "编辑目标" : "新增目标"}</h2><div className="form-grid"><label>领域<select value={goalForm.domain} disabled={!!goalForm.id} onChange={e => setGoalForm({ ...goalForm, domain: e.target.value as Goal["domain"] })}><option value="english">英语学习</option><option value="career">求职准备</option></select></label><label>优先级<select value={goalForm.priority} onChange={e => setGoalForm({ ...goalForm, priority: Number(e.target.value) })}>{[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}</select></label></div><label>目标名称<input maxLength={120} value={goalForm.title} onChange={e => setGoalForm({ ...goalForm, title: e.target.value })} /></label><label>必要资料<textarea maxLength={2000} value={goalForm.detail} onChange={e => setGoalForm({ ...goalForm, detail: e.target.value })} placeholder="仅填写本任务需要发送给所选模型渠道的资料" /></label><MarkdownPreview text={goalForm.detail} /><div className="row"><button className="primary" disabled={busy} onClick={saveGoal}>保存目标</button>{goalForm.id && <button onClick={() => setGoalForm(emptyGoal)}>取消编辑</button>}</div><h2 className="section-gap">已有目标</h2>{data.goals.map(g => <div className="simple-row" key={g.id}><div className="row spread"><h3>{g.title}</h3><button onClick={() => setGoalForm({ id: g.id, domain: g.domain, title: g.title, detail: g.detail, priority: g.priority })}>编辑</button></div><p>{g.domain === "english" ? "英语教练" : "求职顾问"} · 优先级 {g.priority}/5 · {g.active ? "参与后续安排" : "已暂停后续安排"}</p><p>{g.detail || "未添加资料"}</p><button disabled={busy} onClick={async () => { const result = await action({ type: "goal.schedule", id: g.id, active: !g.active }); if (result) { setProposal(null); setNotice(g.active ? "已暂停目标参与后续安排；现有待办要在采用新安排后才调整" : "目标已重新参与后续安排；请预览并采用新安排"); } }}>{g.active ? "暂停后续安排" : "重新参与安排"}</button></div>)}{!data.goals.length && <p className="empty">尚无目标。</p>}</section><aside className="context"><h2>目标怎样进入安排？</h2><p>启用且参与安排的目标由领域角色生成规则练习建议；协调员按优先级和剩余时间分配。保存目标后，到“今天”预览并采用安排。暂停目标不会删除目标、任务或反馈，也不会立即改动今天的待办。</p></aside></div></>}
        {data && view === "team" && <><div className="heading"><div><div className="kicker">YOUR AGENTS</div><h1>Agent 团队</h1><p>角色身份持续存在，运行记录单独保存。</p></div></div>{data.agents.map(a => <AgentPanel key={a.id} agent={a} busy={busy} onSave={async (enabled, preference) => { const r = await action({ type: "agent.update", id: a.id, enabled, preference }); if (r) setNotice("角色配置已保存"); }} />)}</>}
        {view === "connection" && <ModelConnectionsPanel connection={connection} keyInput={keyInput} onKeyInputChange={setKeyInput} onAction={connectionAction} busy={connecting} notice={notice} headingLevel={1} />}
        {data && view === "history" && <><div className="heading"><div><div className="kicker">EXECUTION LOG</div><h1>执行记录</h1><p>记录真实输入、模型、结果和失败状态。</p></div></div>{archivedTasks.map(t => <div className="simple-row" key={t.id}><div className="row spread"><h3>{t.title}</h3><span className="tag">{t.status === "superseded" ? "已调整" : "过往任务"} · {t.plan_date} · {statusName[t.status] || t.status}{t.draft ? " · 草稿已保存" : ""}</span></div><p>{t.draft ? "原任务的草稿仍可查看，不会自动用于新题目。" : t.status === "superseded" ? "原任务已保留为记录。" : "过往任务仍可打开，按当前状态继续处理。"}</p><button onClick={() => openTask(t)}>{t.draft ? "查看原草稿" : "查看原任务"}</button></div>)}{data.runs.length ? data.runs.map(r => <div className="simple-row" key={r.id}><div className="row spread"><h3>{data.tasks.find(t => t.id === r.task_id)?.title || "历史任务"}</h3><span className="tag">{r.status}</span></div><p>{data.agents.find(a => a.id === r.agent_id)?.name} · {modelLabel(r.model, connection)} · {r.created_at}</p><p>输入：{r.input}</p>{r.output && <p>反馈：{r.output}</p>}{r.error && <p>失败：{r.error}</p>}{JSON.parse(r.context_refs || "[]").length > 0 && <p>本次引用记忆：{JSON.parse(r.context_refs).map((ref: { id: string; text: string; source: string } | string) => typeof ref === "string" ? (data.memories.find(m => m.id === ref)?.text || ref) + "（旧记录，引用内容未留快照）" : `${ref.text}（来源运行 ${ref.source.slice(0, 8)}）`).join("；")}</p>}<button onClick={() => { const t = data.tasks.find(t => t.id === r.task_id); if (t) openTask(t); }}>查看任务</button></div>) : !archivedTasks.length && <p className="empty">尚无模型执行记录。</p>}</>}
        {data && view === "detail" && task && <><button className="quiet" onClick={() => setView("today")}>← 返回今天</button><div className="heading"><div><div className="kicker">TASK WORKSPACE</div><h1>{task.title}</h1><p>{taskGoal?.title} · {taskAgent?.name} · {task.minutes} 分钟 · {statusName[task.status] || task.status}</p></div></div><div className="columns"><section><h2>练习工作区</h2><RichText text={task.prompt} className="instruction" />{task.status === "failed" && latestFailed?.error && <div className="notice" role="alert">{latestFailed.error}。如需再次提交，请确认作答后手动点击下方提交按钮；重新提交会产生新的模型请求。</div>}<label>你的回答<textarea value={draft} disabled={!(["waiting", "failed", "interrupted", "cancelled"].includes(task.status))} onChange={e => { setDraft(e.target.value); setDraftCache({ ...draftCache, [task.id]: e.target.value }); }} placeholder="在这里写下你的真实作答" /></label><MarkdownPreview text={draft} /><div className="row"><button disabled={busy || !["waiting", "failed", "interrupted", "cancelled"].includes(task.status)} onClick={saveDraft}>保存草稿</button><button className="primary" disabled={submitting || !modelReadyForAgent(connection, taskAgent?.id) || !taskAgent?.enabled || !["waiting", "failed", "interrupted", "cancelled"].includes(task.status) || Array.from(draft.trim()).length < 4} onClick={() => runAction({ type: "submit", taskId: task.id, answer: draft, submissionId: crypto.randomUUID() })}>提交给 {taskAgent?.name || "模型"}</button>{runningRun && <button disabled={submitting} onClick={() => runAction({ type: "cancel", runId: runningRun.id })}>取消本次运行</button>}</div><p className="muted">草稿需点击保存才能在刷新或重启后恢复；提交时自动保存本次作答。模型反馈不会使用预设内容。{!modelReadyForAgent(connection, taskAgent?.id) && "请先连接这位 Agent 所选的模型渠道。"}</p>{task.feedback && <div className="feedback"><h2>模型反馈 · {task.status === "feedback" ? "待你查看" : "已保存"}</h2><RichText text={task.feedback} />{task.suggestion && <div className="memory-box"><h3>下次练习建议</h3><RichText text={task.suggestion} /><button disabled={busy || suggestionAccepted} onClick={() => action({ type: "memory.accept", taskId: task.id, text: task.suggestion })}>{suggestionAccepted ? "已采用" : "采用为记忆"}</button></div>}{task.status === "feedback" && <button className="primary" disabled={busy} onClick={() => action({ type: "task.finish", id: task.id })}>结束练习</button>}</div>}{data.memories.filter(m => m.goal_id === task.goal_id && m.agent_id === task.agent_id).map(m => <div className="memory-box" key={m.id}><div>已采用记忆：<RichText text={m.text} />来源运行 {m.source_run_id.slice(0, 8)}</div><textarea value={memoryEdit[m.id] ?? m.text} onChange={e => setMemoryEdit({ ...memoryEdit, [m.id]: e.target.value })} /><MarkdownPreview text={memoryEdit[m.id] ?? m.text} /><button disabled={busy} onClick={() => action({ type: "memory.correct", id: m.id, text: memoryEdit[m.id] ?? m.text })}>纠正记忆</button></div>)}</section><aside className="context"><h2>任务来源</h2><div className="step"><strong>目标</strong><p>{taskGoal?.title}</p></div><div className="step"><strong>{taskAgent?.name}</strong><RichText text={task.prompt} /></div><div className="step"><strong>日程协调员</strong><RichText text={task.rationale} /></div><details><summary>记忆引用</summary><p>{latestSuccess && JSON.parse(latestSuccess.context_refs || "[]").length ? JSON.parse(latestSuccess.context_refs).map((ref: { id: string; text: string; source: string } | string) => typeof ref === "string" ? `${ref}（旧记录，引用内容未留快照）` : `${ref.text}（来源运行 ${ref.source.slice(0, 8)}）`).join("；") : "本次运行尚无可引用记忆。"}</p></details></aside></div></>}
      </main><footer className="footer">本地单用户工作台 · 任务内容仅在提交模型调用时发送至所选渠道</footer>
    </div>
  </div>;
}

function AgentPanel({ agent, busy, onSave }: { agent: Agent; busy: boolean; onSave: (enabled: boolean, preference: string) => void }) {
  const [enabled, setEnabled] = useState(!!agent.enabled);
  const [preference, setPreference] = useState(agent.preference);
  useEffect(() => { setEnabled(!!agent.enabled); setPreference(agent.preference); }, [agent.enabled, agent.preference]);
  return <section className="profile"><div className="avatar">{agent.name[0]}</div><div><div className="row spread"><h2>{agent.name}</h2><span className="tag">{agent.enabled ? "已启用" : "已暂停"}</span></div><p>{agent.role}</p><p className="muted">权限：{agent.id === "coordinator" ? "目标摘要、优先级与时间" : "所属领域目标、作答与记忆"}</p>{agent.id === "coordinator" ? <label>协调方式<select value={preference || "priority"} onChange={e => setPreference(e.target.value)}><option value="priority">按目标优先级分配</option><option value="balanced">尽量均衡分配</option></select></label> : <label>训练偏好<input maxLength={500} value={preference} onChange={e => setPreference(e.target.value)} /></label>}<div className="row"><label className="inline"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> 启用角色</label><button disabled={busy} onClick={() => onSave(enabled, preference || (agent.id === "coordinator" ? "priority" : ""))}>保存配置</button></div><p className="muted">暂停阻止新任务或运行；已发出的请求不能保证撤销或停止计费。</p></div></section>;
}

function ProposalCard({ proposal, data, busy, onAccept, onCancel }: { proposal: Proposal; data: AppState; busy: boolean; onAccept: () => void; onCancel: () => void }) {
  const adjustable = data.tasks.filter(t => t.plan_date === data.today && ["waiting", "failed", "interrupted", "cancelled"].includes(t.status));
  const omitted = adjustable.filter(t => !proposal.items.some(item => item.goalId === t.goal_id));
  return <section className="proposal"><div className="row spread"><h2>协调员提出的新安排</h2><span className="tag">待你决定 · 规则建议</span></div><p>{proposal.reason}</p>
    {proposal.issues.map(issue => <p className="notice" key={issue}>{issue}</p>)}
    {proposal.items.length ? <div>{proposal.items.map(item => {
      const old = adjustable.find(t => t.goal_id === item.goalId);
      return <div className="proposal-item" key={item.goalId}><strong>{data.goals.find(g => g.id === item.goalId)?.title}</strong><p>原安排：{old ? `${old.title} · ${old.minutes} 分钟 · ${old.prompt}` : "尚无任务"}</p><div>新安排：{item.title} · {item.minutes} 分钟<RichText text={item.prompt} /></div><div>原因：<RichText text={item.rationale} /></div></div>;
    })}</div> : <p>{proposal.issues.length ? "当前没有可采用的新任务；请调整上方目标的输入要求后重新预览。" : "当前预算不足，或没有启用且已配置目标的领域角色。"}</p>}
    {omitted.map(old => <div className="proposal-item" key={old.id}><strong>{data.goals.find(g => g.id === old.goal_id)?.title || "原目标"}</strong><p>原安排：{old.title} · {old.minutes} 分钟 · {old.prompt}</p><p>新安排：此次不安排；原任务和已保存草稿会留在执行记录中。</p><p>原因：当前预算不足，或负责的领域角色已暂停。</p></div>)}
    <div className="row"><button className="primary" disabled={busy || proposal.budget < proposal.lockedMinutes} onClick={onAccept}>采用安排</button><button onClick={onCancel}>保留原安排</button></div>
  </section>;
}
