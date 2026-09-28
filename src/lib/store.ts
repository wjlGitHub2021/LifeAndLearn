import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

export type Domain = "english" | "career";
export type Agent = { id: string; name: string; role: string; enabled: number; preference: string; permission: string };
export type Goal = { id: string; domain: Domain; title: string; detail: string; priority: number; active: number; created_at: string };
export type Task = { id: string; goal_id: string; agent_id: string; title: string; prompt: string; minutes: number; status: string; rationale: string; draft: string; feedback: string | null; suggestion: string | null; created_at: string; plan_date: string };
export type Run = { id: string; task_id: string; agent_id: string; submission_id: string; status: string; input: string; output: string | null; model: string | null; error: string | null; created_at: string; finished_at: string | null; context_refs: string };
export type Memory = { id: string; goal_id: string; agent_id: string; source_run_id: string; text: string; status: string; created_at: string; effective_order: number };
type Direction = { oral: boolean; writing: boolean };
const directionTerms = /口语|口头|口述|语音|speaking|spoken|oral|写作|作文|书面|写一篇|写[^，,。；;、.!?\n]{0,24}日记|write[^,.!?\n]{0,24}diary|essay|writing/gi;
const oralTerm = /^(?:口语|口头|口述|语音|speaking|spoken|oral)$/i;
const clauseBoundary = /[，,。；;、.!?\n]/g;
function directionOf(text: string): Direction {
  const result = { oral: false, writing: false };
  const matches = [...text.matchAll(directionTerms)];
  let previousEnd = 0;
  for (const [index, match] of matches.entries()) {
    const start = match.index;
    const end = start + match[0].length;
    const before = text.slice(previousEnd, start).split(clauseBoundary).at(-1) || "";
    const after = text.slice(end, matches[index + 1]?.index ?? text.length).split(clauseBoundary)[0];
    if (match[0] === "语音" && (/(?:不接受|拒绝|禁止|不支持|不要|不用|不能)\s*纯$/i.test(before) || (before.endsWith("纯") && /^(?:不接受|拒绝|禁止|不支持)/i.test(after)))) {
      previousEnd = end;
      continue;
    }
    const excludedBefore = /(?:不要|不再|不|勿|别|禁止|拒绝|避免|暂停|停止|暂不)[^\s，,。；;、.!?]{0,5}$/i.test(before);
    const excludedAfter = /^(?:先|暂时|继续)?(?:暂停|停止|暂缓|取消|不练|不做|不进行|不再练)/i.test(after);
    const key = oralTerm.test(match[0]) ? "oral" : "writing";
    result[key] = !(excludedBefore || excludedAfter);
    if (result[key] && /(?:只|仅|专门|专注|专练)[^\s，,。；;、.!?]{0,3}$/i.test(before)) result[key === "oral" ? "writing" : "oral"] = false;
    previousEnd = end;
  }
  return result;
}
function goalDirection(goal: Goal, preference = "") { return directionOf([goal.title, goal.detail, preference].join("，")); }
function textFitsGoal(goal: Goal, text: string) {
  const current = goalDirection(goal);
  const candidate = directionOf(text);
  return !(current.oral && !current.writing && candidate.writing) && !(current.writing && !current.oral && candidate.oral);
}

export function localDate(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
const path = process.env.AGENT_DB_PATH || join(process.cwd(), "data", "agents.sqlite");
const globalStore = globalThis as typeof globalThis & { __agentDb?: InstanceType<typeof Database>; __agentDbPath?: string; __agentDbSchemaVersion?: number };
function pidAlive(pid: number) {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function recoverOrphanedRuns(database: InstanceType<typeof Database>) {
  const running = database.prepare("SELECT id,task_id,owner_pid FROM runs WHERE status='running'").all() as { id: string; task_id: string; owner_pid: number | null }[];
  const orphaned = running.filter(run => !run.owner_pid || !pidAlive(run.owner_pid));
  if (!orphaned.length) return;
  database.transaction(() => {
    for (const run of orphaned) {
      const changed = database.prepare("UPDATE runs SET status='interrupted',error='应用重启，运行已中断',finished_at=datetime('now') WHERE id=? AND status='running'").run(run.id).changes;
      if (changed) database.prepare("UPDATE tasks SET status='interrupted' WHERE id=? AND status='running' AND NOT EXISTS (SELECT 1 FROM runs WHERE task_id=? AND status='running')").run(run.task_id, run.task_id);
    }
  }).immediate();
}
function migrateSchema(database: InstanceType<typeof Database>) {
  const taskColumns = database.pragma("table_info(tasks)") as { name: string }[];
  const runColumns = database.pragma("table_info(runs)") as { name: string }[];
  const memoryColumns = database.pragma("table_info(memories)") as { name: string }[];
  const taskMissing = !taskColumns.some(c => c.name === "plan_date");
  const refsMissing = !runColumns.some(c => c.name === "context_refs");
  const ownerMissing = !runColumns.some(c => c.name === "owner_pid");
  const orderMissing = !memoryColumns.some(c => c.name === "effective_order");
  const nullDates = taskMissing ? 0 : (database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE plan_date IS NULL").get() as { count: number }).count;
  if (taskMissing || refsMissing || ownerMissing || orderMissing || nullDates) {
    database.prepare("VACUUM INTO ?").run(`${path}.backup-${Date.now()}-${randomUUID()}`);
    database.transaction(() => {
      const currentTasks = database.pragma("table_info(tasks)") as { name: string }[];
      const currentRuns = database.pragma("table_info(runs)") as { name: string }[];
      const currentMemories = database.pragma("table_info(memories)") as { name: string }[];
      if (!currentTasks.some(c => c.name === "plan_date")) database.exec("ALTER TABLE tasks ADD COLUMN plan_date TEXT");
      database.exec("UPDATE tasks SET plan_date=substr(datetime(created_at,'localtime'),1,10) WHERE plan_date IS NULL");
      if (!currentRuns.some(c => c.name === "context_refs")) database.exec("ALTER TABLE runs ADD COLUMN context_refs TEXT NOT NULL DEFAULT '[]'");
      if (!currentRuns.some(c => c.name === "owner_pid")) database.exec("ALTER TABLE runs ADD COLUMN owner_pid INTEGER");
      if (!currentMemories.some(c => c.name === "effective_order")) database.exec("ALTER TABLE memories ADD COLUMN effective_order INTEGER NOT NULL DEFAULT 0");
    }).immediate();
  }
  globalStore.__agentDbSchemaVersion = 1;
}
function openDb() {
  if (globalStore.__agentDb) {
    if (globalStore.__agentDbPath !== path) throw new Error("数据库路径在当前进程中发生变化");
    if (globalStore.__agentDbSchemaVersion !== 1) migrateSchema(globalStore.__agentDb);
    return globalStore.__agentDb;
  }
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { timeout: 10000 });
  database.pragma("busy_timeout = 10000");
  for (let attempt = 0; ; attempt++) {
    try { database.pragma("journal_mode = WAL"); break; }
    catch (error) {
      if ((error as { code?: string }).code !== "SQLITE_BUSY" || attempt === 39) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  database.pragma("foreign_keys = ON");
  database.exec(`
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, preference TEXT NOT NULL DEFAULT '', permission TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, domain TEXT NOT NULL CHECK(domain IN ('english','career')), title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 5), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), agent_id TEXT NOT NULL REFERENCES agents(id), title TEXT NOT NULL, prompt TEXT NOT NULL, minutes INTEGER NOT NULL, status TEXT NOT NULL, rationale TEXT NOT NULL, draft TEXT NOT NULL DEFAULT '', feedback TEXT, suggestion TEXT, created_at TEXT NOT NULL, plan_date TEXT);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), agent_id TEXT NOT NULL REFERENCES agents(id), submission_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, input TEXT NOT NULL, output TEXT, model TEXT, error TEXT, created_at TEXT NOT NULL, finished_at TEXT, context_refs TEXT NOT NULL DEFAULT '[]', owner_pid INTEGER);
CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), agent_id TEXT NOT NULL REFERENCES agents(id), source_run_id TEXT NOT NULL REFERENCES runs(id), text TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('accepted','corrected')), created_at TEXT NOT NULL, effective_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
  migrateSchema(database);
  const seeds: Agent[] = [
  { id: "career", name: "求职顾问", role: "围绕用户求职目标设计练习，并反馈回答。", enabled: 1, preference: "", permission: "career-goals-and-own-memory" },
  { id: "english", name: "英语教练", role: "围绕用户英语目标设计练习，并反馈作答。", enabled: 1, preference: "", permission: "english-goals-and-own-memory" },
  { id: "coordinator", name: "日程协调员", role: "依据目标优先级、任务摘要和时间预算提出安排。", enabled: 1, preference: "", permission: "goal-summaries-and-time-only" },
  ];
  const seed = database.prepare("INSERT OR IGNORE INTO agents (id,name,role,enabled,preference,permission) VALUES (@id,@name,@role,@enabled,@preference,@permission)");
  for (const agent of seeds) seed.run(agent);
  recoverOrphanedRuns(database);
  globalStore.__agentDb = database;
  globalStore.__agentDbPath = path;
  return database;
}
export function getDatabase() { return openDb(); }
const db = new Proxy({} as InstanceType<typeof Database>, {
  get(_target, property) {
    const database = openDb();
    const value = Reflect.get(database, property);
    return typeof value === "function" ? value.bind(database) : value;
  },
});

export function state() {
  recoverOrphanedRuns(db);
  return {
    agents: db.prepare("SELECT * FROM agents ORDER BY CASE id WHEN 'career' THEN 1 WHEN 'english' THEN 2 ELSE 3 END").all() as Agent[],
    goals: db.prepare("SELECT g.*, CASE WHEN s.value='0' THEN 0 ELSE 1 END AS active FROM goals g LEFT JOIN settings s ON s.key='goal.active.' || g.id ORDER BY g.priority DESC, g.created_at DESC").all() as Goal[],
    tasks: db.prepare("SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC").all() as Task[],
    runs: db.prepare("SELECT * FROM runs ORDER BY created_at DESC, rowid DESC").all() as Run[],
    memories: db.prepare("SELECT * FROM memories ORDER BY (effective_order > 0) DESC, effective_order DESC, created_at DESC, rowid DESC").all() as Memory[],
    budget: Number((db.prepare("SELECT value FROM settings WHERE key='budget'").get() as { value: string } | undefined)?.value || 60),
    today: localDate(),
  };
}
export function getAgent(id: string) { return db.prepare("SELECT * FROM agents WHERE id=?").get(id) as Agent | undefined; }
export function getTask(id: string) { return db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Task | undefined; }
export function getGoal(id: string) { return db.prepare("SELECT g.*, CASE WHEN s.value='0' THEN 0 ELSE 1 END AS active FROM goals g LEFT JOIN settings s ON s.key='goal.active.' || g.id WHERE g.id=?").get(id) as Goal | undefined; }
export function getPreferenceForGoal(goalId: string, agentId: string) {
  const goal = getGoal(goalId);
  const agent = getAgent(agentId);
  return goal && agent && goal.domain === agentId && textFitsGoal(goal, agent.preference) ? agent.preference : "";
}
export function getRun(id: string) { return db.prepare("SELECT * FROM runs WHERE id=?").get(id) as Run | undefined; }
export function getRunBySubmission(id: string) { return db.prepare("SELECT * FROM runs WHERE submission_id=?").get(id) as Run | undefined; }
export function getMemories(goalId: string, agentId: string) {
  const goal = getGoal(goalId);
  if (!goal || goal.domain !== agentId) return [];
  const memories = db.prepare("SELECT * FROM memories WHERE goal_id=? AND agent_id=? ORDER BY (effective_order > 0) DESC, effective_order DESC, created_at DESC, rowid DESC").all(goalId, agentId) as Memory[];
  return memories.filter(memory => textFitsGoal(goal, memory.text)).slice(0, 5);
}
export function createGoal(domain: Domain, title: string, detail: string, priority: number) {
  const id = randomUUID();
  db.prepare("INSERT INTO goals VALUES (?,?,?,?,?,datetime('now'))").run(id, domain, title, detail, priority);
  return id;
}
export function updateGoal(id: string, title: string, detail: string, priority: number) {
  return db.prepare("UPDATE goals SET title=?,detail=?,priority=? WHERE id=?").run(title, detail, priority, id).changes;
}
export function setGoalActive(id: string, active: boolean) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`goal.active.${id}`, active ? "1" : "0");
}
export function updateAgent(id: string, enabled: boolean, preference: string) {
  return db.transaction(() => {
    const previous = db.prepare("SELECT enabled FROM agents WHERE id=?").get(id) as { enabled: number } | undefined;
    if (!previous) return 0;
    const changed = db.prepare("UPDATE agents SET enabled=?, preference=? WHERE id=?").run(enabled ? 1 : 0, preference, id).changes;
    if (changed && previous.enabled !== (enabled ? 1 : 0)) db.prepare("INSERT INTO settings(key,value) VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run(`agent.epoch.${id}`);
    return changed;
  }).immediate();
}
export function getAgentEpoch(id: string) { return Number((db.prepare("SELECT value FROM settings WHERE key=?").get(`agent.epoch.${id}`) as { value: string } | undefined)?.value || 0); }
export function saveDraft(id: string, draft: string) { return db.prepare("UPDATE tasks SET draft=? WHERE id=? AND status IN ('waiting','failed','interrupted','cancelled')").run(draft, id).changes; }
export function createRun(taskId: string, agentId: string, submissionId: string, input: string, model: string, refs: { id: string; text: string; source: string }[], expectedProfileRevision?: number, expectedEpoch?: number) {
  const id = randomUUID();
  return db.transaction(() => {
    if (expectedProfileRevision !== undefined && (db.prepare("SELECT revision FROM agent_profiles WHERE id=?").get(agentId) as { revision: number } | undefined)?.revision !== expectedProfileRevision) return null;
    if (expectedEpoch !== undefined && getAgentEpoch(agentId) !== expectedEpoch) return null;
    const claimed = db.prepare("UPDATE tasks SET status='running',draft=? WHERE id=? AND agent_id=? AND status IN ('waiting','failed','interrupted','cancelled') AND EXISTS (SELECT 1 FROM agents WHERE id=? AND enabled=1)").run(input, taskId, agentId, agentId).changes;
    if (!claimed) return null;
    db.prepare("INSERT INTO runs (id,task_id,agent_id,submission_id,status,input,model,created_at,context_refs,owner_pid) VALUES (?,?,?,?,'running',?,?,datetime('now'),?,?)").run(id, taskId, agentId, submissionId, input, model, JSON.stringify(refs), process.pid);
    return id;
  })();
}
export function finishRun(id: string, status: string, output: string | null, error: string | null) {
  db.prepare("UPDATE runs SET status=?,output=?,error=?,finished_at=datetime('now') WHERE id=? AND status='running'").run(status, output, error, id);
}
export function completeRun(id: string, taskId: string, status: "success" | "failed" | "cancelled", output: string | null, error: string | null, suggestion?: string) {
  return db.transaction(() => {
    const changed = db.prepare("UPDATE runs SET status=?,output=?,error=?,finished_at=datetime('now') WHERE id=? AND task_id=? AND status='running'").run(status, output, error, id, taskId).changes;
    if (!changed) return false;
    if (status === "success" && output && suggestion) db.prepare("UPDATE tasks SET status='feedback',feedback=?,suggestion=? WHERE id=? AND status='running'").run(output, suggestion, taskId);
    else db.prepare("UPDATE tasks SET status=? WHERE id=? AND status='running' AND NOT EXISTS (SELECT 1 FROM runs WHERE task_id=? AND status='running')").run(status === "cancelled" ? "cancelled" : "failed", taskId, taskId);
    return true;
  })();
}
export function finishTask(id: string) { return db.prepare("UPDATE tasks SET status='done' WHERE id=? AND status='feedback'").run(id).changes; }
export function saveMemory(goalId: string, agentId: string, runId: string, text: string, status: "accepted" | "corrected") {
  return db.transaction(() => {
    const existing = db.prepare("SELECT id FROM memories WHERE source_run_id=?").get(runId) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    const order = (db.prepare("SELECT COALESCE(MAX(effective_order),0)+1 AS value FROM memories").get() as { value: number }).value;
    db.prepare("INSERT INTO memories (id,goal_id,agent_id,source_run_id,text,status,created_at,effective_order) VALUES (?,?,?,?,?,?,datetime('now'),?)").run(id, goalId, agentId, runId, text, status, order);
    return id;
  }).immediate();
}
export function correctMemory(id: string, text: string) {
  return db.transaction(() => {
    const order = (db.prepare("SELECT COALESCE(MAX(effective_order),0)+1 AS value FROM memories").get() as { value: number }).value;
    return db.prepare("UPDATE memories SET text=?,status='corrected',effective_order=? WHERE id=?").run(text, order, id).changes;
  }).immediate();
}

export type Proposal = { budget: number; lockedMinutes: number; token: string; items: { goalId: string; agentId: Domain; title: string; prompt: string; minutes: number; rationale: string }[]; issues: string[]; reason: string };

function voiceOnly(goal: Goal, preference: string) {
  const request = [goal.title, goal.detail, preference].join(" ").replace(/(?:不接受|拒绝|禁止|不支持|不要|不用|不能)\s*纯语音|纯语音\s*(?:不接受|被拒绝|不支持)/gi, "");
  const speaking = goalDirection(goal, preference).oral;
  const textExcluded = /纯语音|(?:只|仅|只能).{0,4}(?:用|通过|接受)语音|(?:不要|不接受|不能|拒绝|禁止|不用).{0,5}(?:文字|文本|打字|转写|输入)|\b(?:voice.only|no typing|no transcript|without text)\b/i.test(request);
  return speaking && textExcluded;
}

function taskSuggestion(goal: Goal, minutes: number, preference: string, memory?: Memory, prior?: Task, priorSuggestionUsed = false) {
  const brief = minutes <= 20;
  const direction = goalDirection(goal, preference);
  const speaking = goal.domain === "english" && direction.oral;
  const writing = goal.domain === "english" && direction.writing && !direction.oral;
  const base = speaking
    ? `先围绕“${goal.title}”口头回答约 ${brief ? 60 : 120} 秒，再把刚才的回答转写到作答框。反馈只评价转写后的表达与结构，不评价发音。`
    : writing
      ? `围绕“${goal.title}”写一篇${brief ? "简短" : "结构完整"}的英语作文。`
    : goal.domain === "english"
      ? `围绕“${goal.title}”用英语完成${brief ? "简短" : "结构完整"}的回答。`
      : `围绕“${goal.title}”准备${brief ? "简短" : "结构完整"}的面试回答，结合自己的真实经历。`;
  const material = goal.detail ? `可参考你填写的目标资料：${goal.detail}` : "请自行选一个与目标相关的具体情境。";
  const different = prior ? "选一个不同于上次完成任务的具体例子，" : "";
  if (memory) {
    return {
      title: `${goal.domain === "english" ? "英语" : "面试"}反馈专项复练`,
      prompt: `本次练习以你${memory.status === "corrected" ? "纠正" : "采用"}的要求“${memory.text}”为核心。${different}${base}${material}完成后用一句话指出作答中怎样落实了这条要求。${preference ? `其他训练偏好仅在不与这条要求冲突时适用：${preference}` : ""}`,
      source: `所属目标的${memory.status === "corrected" ? "已纠正" : "已采用"}记忆`,
    };
  }
  if (preference) {
    return {
      title: `${goal.domain === "english" ? "英语" : "面试"}偏好专项练习`,
      prompt: `本次练习按你设置的训练偏好“${preference}”进行。${different}${base}${material}完成后用一句话自查是否落实了该偏好。`,
      source: "领域角色训练偏好",
    };
  }
  if (prior?.suggestion && !priorSuggestionUsed && textFitsGoal(goal, prior.suggestion)) {
    return {
      title: (goal.domain === "english" ? "英语" : "面试") + "反馈迁移练习",
      prompt: "上次反馈建议尝试“" + prior.suggestion + "”。这次把该建议用在新的情境中；" + different + base + material + "完成后用一句话说明这次如何应用了上次建议。该建议尚未被你采用为长期记忆。",
      source: "所属目标的上次反馈建议（尚未采用）",
    };
  }
  if (prior) {
    return {
      title: `${goal.domain === "english" ? "英语" : "面试"}迁移练习`,
      prompt: `${different}${base}${material}完成后用一句话说明这次与上次作答相比改变了什么。`,
      source: "所属目标的上次完成任务",
    };
  }
  return { title: goal.domain === "english" ? (speaking ? "英语口语转写练习" : writing ? "英语写作练习" : brief ? "英语短练习" : "英语深入练习") : (brief ? "面试回答短练习" : "面试回答深入练习"), prompt: `${base}${material}`, source: "目标内容" };
}

export function propose(budget: number): Proposal {
  const all = state();
  const active = all.goals.filter(g => g.active && all.agents.some(a => a.id === g.domain && a.enabled));
  const preferenceFor = (goal: Goal) => {
    const preference = all.agents.find(a => a.id === goal.domain)?.preference || "";
    return textFitsGoal(goal, preference) ? preference : "";
  };
  const coordinator = all.agents.find(a => a.id === "coordinator");
  if (!coordinator?.enabled) throw new Error("日程协调员已暂停");
  const balanced = coordinator.preference === "balanced";
  const todayTasks = all.tasks.filter(t => t.plan_date === all.today);
  const used = todayTasks.filter(t => ["running", "feedback", "done"].includes(t.status)).reduce((n, t) => n + t.minutes, 0);
  const available = Math.max(0, budget - used);
  const issues = active.filter(g => voiceOnly(g, preferenceFor(g))).map(g => `“${g.title}”要求纯语音练习；当前只能提交文字转写，未为此目标生成任务。`);
  const eligible = active.filter(g => !voiceOnly(g, preferenceFor(g)));
  const selected = eligible.slice(0, Math.floor(available / 10));
  const totalWeight = selected.reduce((n, g) => n + (balanced ? 1 : g.priority), 0);
  const extra = available - selected.length * 10;
  let remaining = available;
  const items = selected.map((g, index) => {
    const minutes = index === selected.length - 1 ? remaining : 10 + Math.floor(extra * (balanced ? 1 : g.priority) / totalWeight / 5) * 5;
    remaining -= minutes;
    const memory = getMemories(g.id, g.domain)[0];
    const prior = all.tasks.find(t => t.goal_id === g.id && t.agent_id === g.domain && ["feedback", "done"].includes(t.status));
    const priorRunIds = new Set(all.runs.filter(run => run.task_id === prior?.id && run.agent_id === g.domain).map(run => run.id));
    const priorSuggestionUsed = all.memories.some(item => item.goal_id === g.id && item.agent_id === g.domain && priorRunIds.has(item.source_run_id));
    const { title, prompt, source } = taskSuggestion(g, minutes, preferenceFor(g), memory, prior, priorSuggestionUsed);
    return { goalId: g.id, agentId: g.domain, title, prompt, minutes, rationale: `领域建议依据：${source}；目标优先级 ${g.priority}/5；协调方式${balanced ? "均衡" : "按优先级"}；按剩余 ${available} 分钟分配。` };
  });
  const activeIds = new Set(active.map(g => g.id));
  const relevantMemories = all.memories.filter(m => activeIds.has(m.goal_id)).map(m => [m.id, m.goal_id, m.agent_id, m.text, m.status, m.effective_order]);
  const relevantHistory = all.tasks.filter(t => activeIds.has(t.goal_id) && ["feedback", "done"].includes(t.status)).map(t => [t.id, t.goal_id, t.status, t.suggestion]);
  const token = createHash("sha256").update(JSON.stringify({ budget, date: all.today, goals: all.goals, agents: all.agents.map(a => [a.id, a.enabled, a.preference]), tasks: todayTasks.map(t => [t.id, t.status, t.minutes]), relevantMemories, relevantHistory })).digest("hex");
  return { budget, lockedMinutes: used, token, items, issues, reason: `日程协调员按${balanced ? "均衡分配" : "目标优先级"}与剩余时间生成规则建议。已开始或完成任务锁定 ${used} 分钟计划时长；本建议只调整未开始任务。${budget < used ? `新预算低于已锁定的 ${used} 分钟，不能采用；请增加预算。` : ""}${eligible.length > selected.length ? `有 ${eligible.length - selected.length} 个较低优先级目标因时间不足未安排。` : ""}` };
}
export function acceptProposal(proposal: Proposal) {
  db.transaction(() => {
    db.prepare("INSERT INTO settings(key,value) VALUES('budget',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(proposal.budget));
    db.prepare("UPDATE tasks SET status='superseded' WHERE status IN ('waiting','failed','interrupted','cancelled') AND plan_date=?").run(localDate());
    const add = db.prepare("INSERT INTO tasks (id,goal_id,agent_id,title,prompt,minutes,status,rationale,draft,created_at,plan_date) VALUES (?,?,?,?,?,?,'waiting',?,'',datetime('now'),?)");
    for (const item of proposal.items) add.run(randomUUID(), item.goalId, item.agentId, item.title, item.prompt, item.minutes, item.rationale, localDate());
  })();
}
