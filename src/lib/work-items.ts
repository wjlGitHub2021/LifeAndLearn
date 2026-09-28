import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { getAgentEpoch, getDatabase } from "./store.ts";
import { activePreferences, allAgentPreferences, currentArtifact, job, profile, savePreference, stepsOf, updatePreference, validateScheduleDates } from "./agent-work.ts";
import { PublicError } from "./http.ts";
import type { ItemModelChoice } from "./model-connections.ts";

export type WorkRole = "career" | "english";
export type PracticeOption = { label: string; text: string };
export type WorkItem = { id: string; request: string; material: string; english_requirement: string; roles: string; priority: number; minutes: number; revision: number; career_revision: number; english_revision: number; status: string; lifecycle: "open" | "completed" | "archived"; planned_date: string | null; due_date: string | null; schedule_revision: number; source_context_json: string; model_choice_json: string; model_revision: number; created_at: string; updated_at: string };
export type WorkSource = { kind: "quick" | "agent"; itemId: string; title: string; producer: string; artifactId: string; version: number; content: string; practice: { id: string; question: string; answer: string; feedback: string; suggestion: string } | null };
export function sourcesOf(item: WorkItem): WorkSource[] { return JSON.parse(item.source_context_json) as WorkSource[]; }
export type WorkFact = { id: string; item_id: string; text: string; source: string; revision: number; created_at: string };
export type WorkArtifact = { id: string; item_id: string; role: WorkRole; version: number; revision: number; content: string; run_id: string; upstream_artifact_id: string | null; accepted_at: string | null; created_at: string; current?: boolean };
export type WorkRun = { id: string; item_id: string; role: WorkRole; request_id: string; status: string; model: string; revision: number; context_json: string; upstream_artifact_id: string | null; owner_pid: number; owner_started_at: number | null; error: string | null; created_at: string; finished_at: string | null };
export type WorkPreference = { id: string; role: WorkRole; text: string; active: number; created_at: string; updated_at: string };
export type WorkPractice = { id: string; item_id: string; role: WorkRole; source_artifact_id: string; question: string | null; question_options_json: string; answer: string | null; feedback: string | null; suggestion: string | null; status: string; created_at: string; updated_at: string };
export function practiceQuestionMarkdown(question: string, optionsJson: string) {
  const options = JSON.parse(optionsJson) as PracticeOption[];
  if (!options.length) return question;
  return `${question}\n\n${options.map(option => `- **${option.label}.** ${option.text}`).join("\n")}`;
}
export type WorkPracticeRun = { id: string; practice_id: string; kind: "prepare" | "feedback"; request_id: string; status: string; model: string; context_json: string; owner_pid: number; owner_started_at: number | null; error: string | null; created_at: string; finished_at: string | null };
export const processStartedAt = Math.round(Date.now() - process.uptime() * 1000);
export type WorkContext = { request: string; material: string; englishRequirement?: string; facts: { id: string; text: string; revision: number }[]; preferences: { id: string; role: WorkRole; text: string }[]; upstream: { id: string; version: number; revision: number; content: string } | null; sources?: WorkSource[]; agentEpochs: Partial<Record<WorkRole, number>>; agentConfig?: { revision: number; name: string; instructions: string; deliverable: string; allowMaterial: boolean; allowUpstream: boolean }; revision: number; minutes: number; priority: number };

let migrated = false;
function database() {
  const db = getDatabase();
  if (migrated) return db;
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_items'").get();
  const needsLifecycle = !!exists && !(db.prepare("PRAGMA table_info(work_items)").all() as { name: string }[]).some(column => column.name === "lifecycle");
  const needsPractice = !!exists && (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_practices'").get() || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_practice_runs'").get());
  const needsOwner = !!exists && !(db.prepare("PRAGMA table_info(work_runs)").all() as { name: string }[]).some(column => column.name === "owner_started_at");
  const needsDependencies = !!exists && ["english_requirement", "career_revision", "english_revision"].some(name => !(db.prepare("PRAGMA table_info(work_items)").all() as { name: string }[]).some(column => column.name === name));
  const needsPracticeOwner = !!exists && !needsPractice && !(db.prepare("PRAGMA table_info(work_practice_runs)").all() as { name: string }[]).some(column => column.name === "owner_started_at");
  const needsPracticeOptions = !!exists && !needsPractice && !(db.prepare("PRAGMA table_info(work_practices)").all() as { name: string }[]).some(column => column.name === "question_options_json");
  const needsAcceptance = !!exists && !(db.prepare("PRAGMA table_info(work_artifacts)").all() as { name: string }[]).some(column => column.name === "accepted_at");
  const itemColumnsBefore = exists ? (db.prepare("PRAGMA table_info(work_items)").all() as { name: string }[]).map(column => column.name) : [];
  const needsSchedule = !!exists && ["planned_date", "due_date", "schedule_revision"].some(name => !itemColumnsBefore.includes(name));
  const needsSource = !!exists && !itemColumnsBefore.includes("source_context_json");
  const needsModelChoice = !!exists && ["model_choice_json", "model_revision"].some(name => !itemColumnsBefore.includes(name));
  if (!exists || needsLifecycle || needsPractice || needsOwner || needsDependencies || needsPracticeOwner || needsPracticeOptions || needsAcceptance || needsSchedule || needsSource || needsModelChoice) db.prepare("VACUUM INTO ?").run(`${db.name}.backup-work-items-${Date.now()}-${randomUUID()}`);
  db.transaction(() => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY, request TEXT NOT NULL, material TEXT NOT NULL DEFAULT '', english_requirement TEXT NOT NULL DEFAULT '', roles TEXT NOT NULL,
      priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 5), minutes INTEGER NOT NULL CHECK(minutes BETWEEN 10 AND 480),
      revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      lifecycle TEXT NOT NULL DEFAULT 'open' CHECK(lifecycle IN ('open','completed','archived')),
      career_revision INTEGER NOT NULL DEFAULT 1, english_revision INTEGER NOT NULL DEFAULT 1,
      planned_date TEXT, due_date TEXT, schedule_revision INTEGER NOT NULL DEFAULT 1,
      source_context_json TEXT NOT NULL DEFAULT '[]',
      model_choice_json TEXT NOT NULL DEFAULT 'null', model_revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS work_facts (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES work_items(id), text TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('user_correction')), revision INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_runs (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES work_items(id), role TEXT NOT NULL CHECK(role IN ('career','english')),
      request_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, model TEXT NOT NULL, revision INTEGER NOT NULL,
      context_json TEXT NOT NULL, upstream_artifact_id TEXT REFERENCES work_artifacts(id), owner_pid INTEGER NOT NULL, owner_started_at INTEGER,
      error TEXT, created_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS work_one_active_run ON work_runs(item_id) WHERE status='running';
    CREATE TABLE IF NOT EXISTS work_artifacts (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES work_items(id), role TEXT NOT NULL CHECK(role IN ('career','english')),
      version INTEGER NOT NULL, revision INTEGER NOT NULL, content TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE REFERENCES work_runs(id),
      upstream_artifact_id TEXT REFERENCES work_artifacts(id), created_at TEXT NOT NULL,
      accepted_at TEXT,
      UNIQUE(item_id,role,version)
    );
    CREATE TABLE IF NOT EXISTS work_preferences (
      id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('career','english')),
      text TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_practices (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES work_items(id), role TEXT NOT NULL CHECK(role IN ('career','english')),
      source_artifact_id TEXT NOT NULL REFERENCES work_artifacts(id), question TEXT, question_options_json TEXT NOT NULL DEFAULT '[]', answer TEXT, feedback TEXT, suggestion TEXT,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_practice_runs (
      id TEXT PRIMARY KEY, practice_id TEXT NOT NULL REFERENCES work_practices(id), kind TEXT NOT NULL CHECK(kind IN ('prepare','feedback')),
      request_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, model TEXT NOT NULL, context_json TEXT NOT NULL,
      owner_pid INTEGER NOT NULL, owner_started_at INTEGER, error TEXT, created_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS work_one_active_practice ON work_practice_runs(practice_id) WHERE status='running';
  `);
    const itemColumns = new Set((db.prepare("PRAGMA table_info(work_items)").all() as { name: string }[]).map(column => column.name));
    if (!itemColumns.has("lifecycle")) db.exec("ALTER TABLE work_items ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'open' CHECK(lifecycle IN ('open','completed','archived'))");
    if (!itemColumns.has("english_requirement")) db.exec("ALTER TABLE work_items ADD COLUMN english_requirement TEXT NOT NULL DEFAULT ''");
    const addCareerRevision = !itemColumns.has("career_revision");
    const addEnglishRevision = !itemColumns.has("english_revision");
    if (addCareerRevision) db.exec("ALTER TABLE work_items ADD COLUMN career_revision INTEGER NOT NULL DEFAULT 1");
    if (addEnglishRevision) db.exec("ALTER TABLE work_items ADD COLUMN english_revision INTEGER NOT NULL DEFAULT 1");
    if (addCareerRevision) db.exec("UPDATE work_items SET career_revision=revision");
    if (addEnglishRevision) db.exec("UPDATE work_items SET english_revision=revision");
    if (!itemColumns.has("planned_date")) db.exec("ALTER TABLE work_items ADD COLUMN planned_date TEXT");
    if (!itemColumns.has("due_date")) db.exec("ALTER TABLE work_items ADD COLUMN due_date TEXT");
    if (!itemColumns.has("schedule_revision")) db.exec("ALTER TABLE work_items ADD COLUMN schedule_revision INTEGER NOT NULL DEFAULT 1");
    if (!itemColumns.has("source_context_json")) db.exec("ALTER TABLE work_items ADD COLUMN source_context_json TEXT NOT NULL DEFAULT '[]'");
    if (!itemColumns.has("model_choice_json")) db.exec("ALTER TABLE work_items ADD COLUMN model_choice_json TEXT NOT NULL DEFAULT 'null'");
    if (!itemColumns.has("model_revision")) db.exec("ALTER TABLE work_items ADD COLUMN model_revision INTEGER NOT NULL DEFAULT 1");
    if (!(db.prepare("PRAGMA table_info(work_runs)").all() as { name: string }[]).some(column => column.name === "owner_started_at")) db.exec("ALTER TABLE work_runs ADD COLUMN owner_started_at INTEGER");
    if (!(db.prepare("PRAGMA table_info(work_practice_runs)").all() as { name: string }[]).some(column => column.name === "owner_started_at")) db.exec("ALTER TABLE work_practice_runs ADD COLUMN owner_started_at INTEGER");
    if (!(db.prepare("PRAGMA table_info(work_practices)").all() as { name: string }[]).some(column => column.name === "question_options_json")) db.exec("ALTER TABLE work_practices ADD COLUMN question_options_json TEXT NOT NULL DEFAULT '[]'");
    if (!(db.prepare("PRAGMA table_info(work_artifacts)").all() as { name: string }[]).some(column => column.name === "accepted_at")) db.exec("ALTER TABLE work_artifacts ADD COLUMN accepted_at TEXT");
  }).immediate();
  profile("career");
  migrated = true;
  return db;
}

function pidAlive(pid: number, startedAt: number | null) {
  if (pid === process.pid) return startedAt === null || Math.abs(startedAt - processStartedAt) < 3000;
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") return false; }
  if (startedAt === null) return false;
  try {
    const actual = Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1500 }).trim());
    return Number.isFinite(actual) && Math.abs(actual - startedAt) < 3000;
  } catch { return true; }
}
export function recoverWorkRuns() {
  const db = database();
  const running = db.prepare("SELECT id,item_id,owner_pid,owner_started_at FROM work_runs WHERE status='running'").all() as { id: string; item_id: string; owner_pid: number; owner_started_at: number | null }[];
  const orphaned = running.filter(run => !pidAlive(run.owner_pid, run.owner_started_at));
  const practiceRuns = db.prepare("SELECT id,practice_id,owner_pid,owner_started_at FROM work_practice_runs WHERE status='running'").all() as { id: string; practice_id: string; owner_pid: number; owner_started_at: number | null }[];
  const orphanedPractice = practiceRuns.filter(run => !pidAlive(run.owner_pid, run.owner_started_at));
  if (!orphaned.length && !orphanedPractice.length) return;
  db.transaction(() => {
    for (const run of orphaned) {
      const changed = db.prepare("UPDATE work_runs SET status='interrupted',error='应用重启，运行已中断',finished_at=datetime('now') WHERE id=? AND status='running'").run(run.id).changes;
      if (changed) db.prepare("UPDATE work_items SET status='interrupted',updated_at=datetime('now') WHERE id=? AND status='running'").run(run.item_id);
    }
    for (const run of orphanedPractice) {
      db.prepare("UPDATE work_practice_runs SET status='interrupted',error='应用重启，练习运行已中断',finished_at=datetime('now') WHERE id=? AND status='running'").run(run.id);
      db.prepare("UPDATE work_practices SET status='interrupted',updated_at=datetime('now') WHERE id=?").run(run.practice_id);
    }
  }).immediate();
}
export function workState() {
  recoverWorkRuns();
  const db = database();
  const items = db.prepare("SELECT * FROM work_items ORDER BY updated_at DESC,rowid DESC").all() as WorkItem[];
  const currentIds = new Set(items.flatMap(item => rolesOf(item).map(role => currentWorkArtifact(item, role)?.id).filter((id): id is string => !!id)));
  const artifacts = (db.prepare("SELECT * FROM work_artifacts ORDER BY created_at DESC,rowid DESC").all() as WorkArtifact[]).map(artifact => ({ ...artifact, current: currentIds.has(artifact.id) }));
  return {
    items,
    facts: db.prepare("SELECT * FROM work_facts ORDER BY created_at DESC,rowid DESC").all() as WorkFact[],
    runs: db.prepare("SELECT * FROM work_runs ORDER BY created_at DESC,rowid DESC").all() as WorkRun[],
    artifacts,
    preferences: allAgentPreferences().filter(entry => entry.agent_id === "career" || entry.agent_id === "english").map(entry => ({ id: entry.id, role: entry.agent_id as WorkRole, text: entry.text, active: entry.active, created_at: entry.created_at, updated_at: entry.updated_at })),
    practices: db.prepare("SELECT * FROM work_practices ORDER BY created_at DESC,rowid DESC").all() as WorkPractice[],
    practiceRuns: db.prepare("SELECT * FROM work_practice_runs ORDER BY created_at DESC,rowid DESC").all() as WorkPracticeRun[],
  };
}
export function getWorkItem(id: string) { return database().prepare("SELECT * FROM work_items WHERE id=?").get(id) as WorkItem | undefined; }
export function getWorkRun(id: string) { return database().prepare("SELECT * FROM work_runs WHERE id=?").get(id) as WorkRun | undefined; }
export function getWorkRunByRequest(id: string) { return database().prepare("SELECT * FROM work_runs WHERE request_id=?").get(id) as WorkRun | undefined; }
export function getWorkArtifacts(id: string) { return database().prepare("SELECT * FROM work_artifacts WHERE item_id=? ORDER BY version DESC,rowid DESC").all(id) as WorkArtifact[]; }
export function getWorkFacts(id: string) { return database().prepare("SELECT * FROM work_facts WHERE item_id=? ORDER BY revision,rowid").all(id) as WorkFact[]; }
export function getActivePreferences(role: WorkRole) {
  return activePreferences(role).map(entry => ({ id: entry.id, role, text: entry.text, active: entry.active, created_at: entry.created_at, updated_at: entry.updated_at }));
}
export function rolesOf(item: WorkItem): WorkRole[] { return JSON.parse(item.roles) as WorkRole[]; }
export function requiredRevision(item: WorkItem, role: WorkRole) { return role === "career" ? item.career_revision : item.english_revision; }
export function currentWorkArtifact(item: WorkItem, role: WorkRole) {
  const artifacts = getWorkArtifacts(item.id);
  const artifact = artifacts.find(entry => entry.role === role && entry.revision === requiredRevision(item, role));
  if (!artifact) return null;
  const run = getWorkRun(artifact.run_id);
  const previous = run ? JSON.parse(run.context_json) as WorkContext : null;
  if (item.lifecycle === "open") {
    const currentProfile = profile(role);
    if (!currentProfile || (previous?.agentConfig ? previous.agentConfig.revision !== currentProfile.revision : currentProfile.revision !== 1 || !currentProfile.allow_material || !currentProfile.allow_upstream)) return null;
  }
  if (role === "english" && rolesOf(item).includes("career")) {
    const required = item.lifecycle === "open" ? !!profile("english")?.allow_upstream : previous?.agentConfig?.allowUpstream ?? true;
    const career = required ? currentWorkArtifact(item, "career") : null;
    if (artifact.upstream_artifact_id !== (career?.id || null)) return null;
  } else if (role === "english" && artifact.upstream_artifact_id) return null;
  return artifact;
}

export function createWorkItem(request: string, material: string, roles: WorkRole[], priority: number, minutes: number, schedule?: { plannedDate?: unknown; dueDate?: unknown }, modelChoice: ItemModelChoice | null = null) {
  const dates = validateScheduleDates(schedule?.plannedDate ?? null, schedule?.dueDate ?? null);
  const id = randomUUID();
  const executionOrder = (["career", "english"] as const).filter(role => roles.includes(role));
  database().prepare("INSERT INTO work_items (id,request,material,roles,priority,minutes,revision,status,created_at,updated_at,planned_date,due_date,model_choice_json) VALUES (?,?,?,?,?, ?,1,?,datetime('now'),datetime('now'),?,?,?)")
    .run(id, request, material, JSON.stringify(executionOrder), priority, minutes, executionOrder.length ? "planned" : "limited", dates.plannedDate, dates.dueDate, JSON.stringify(modelChoice));
  return id;
}
export function setWorkItemModelChoice(id: string, choice: ItemModelChoice | null, expectedRevision: number) {
  const db = database();
  return db.transaction(() => {
    const item = getWorkItem(id);
    if (!item) throw new PublicError("事项不存在", 404);
    if (item.lifecycle !== "open" || item.model_revision !== expectedRevision || item.status === "running" || db.prepare("SELECT 1 FROM work_practice_runs r JOIN work_practices p ON p.id=r.practice_id WHERE p.item_id=? AND r.status='running'").get(id)) throw new PublicError("事项模型选择已变化或正在运行，请刷新后核对", 409);
    if (item.model_choice_json === JSON.stringify(choice)) return item.model_revision;
    const changed = db.prepare("UPDATE work_items SET model_choice_json=?,model_revision=model_revision+1,updated_at=datetime('now') WHERE id=? AND model_revision=? AND lifecycle='open' AND status!='running'").run(JSON.stringify(choice), id, expectedRevision).changes;
    if (!changed) throw new PublicError("事项模型选择已变化，请刷新后核对", 409);
    return expectedRevision + 1;
  }).immediate();
}
export function setWorkSchedule(id: string, plannedDate: unknown, dueDate: unknown, expectedScheduleRevision: number) {
  const dates = validateScheduleDates(plannedDate, dueDate);
  const db = database();
  return db.transaction(() => {
    const current = getWorkItem(id);
    if (!current) throw new PublicError("事项不存在", 404);
    if (current.schedule_revision !== expectedScheduleRevision) throw new PublicError("排期已变化，请刷新后核对", 409);
    if (current.planned_date === dates.plannedDate && current.due_date === dates.dueDate) return current.schedule_revision;
    const changed = db.prepare("UPDATE work_items SET planned_date=?,due_date=?,schedule_revision=schedule_revision+1 WHERE id=? AND schedule_revision=?")
      .run(dates.plannedDate, dates.dueDate, id, expectedScheduleRevision).changes;
    if (!changed) throw new PublicError("排期已变化，请刷新后核对", 409);
    return expectedScheduleRevision + 1;
  }).immediate();
}
export function setWorkSource(id: string, expectedRevision: number, source: { kind: "quick" | "agent"; id: string; artifactId: string } | null) {
  const db = database();
  return db.transaction(() => {
    const target = getWorkItem(id);
    if (!target || target.lifecycle !== "open" || target.status === "running" || hasActivePractice(db, id) || target.revision !== expectedRevision) throw new PublicError("事项已变化或正在运行，请刷新后核对", 409);
    let chain: WorkSource[] = [];
    if (source) {
      if (source.kind === "quick") {
        const previous = getWorkItem(source.id);
        if (!previous || previous.id === id) throw new PublicError("来源事项无效", 409);
        const artifact = rolesOf(previous).map(role => currentWorkArtifact(previous, role)).find(entry => entry?.id === source.artifactId);
        if (!artifact?.accepted_at || artifact.id !== source.artifactId) throw new PublicError("来源成果已变化，请选择当前已确认版本", 409);
        const round = db.prepare("SELECT id,question,question_options_json,answer,feedback,suggestion FROM work_practices WHERE item_id=? AND source_artifact_id=? AND status='feedback' ORDER BY rowid DESC LIMIT 1").get(previous.id, artifact.id) as Pick<WorkPractice, "id" | "question" | "question_options_json" | "answer" | "feedback" | "suggestion"> | undefined;
        chain = [...sourcesOf(previous), { kind: "quick", itemId: previous.id, title: previous.request, producer: artifact.role === "career" ? "求职顾问" : "英语教练", artifactId: artifact.id, version: artifact.version, content: artifact.content,
          practice: round?.question && round.answer && round.feedback && round.suggestion ? { id: round.id, question: practiceQuestionMarkdown(round.question, round.question_options_json), answer: round.answer, feedback: round.feedback, suggestion: round.suggestion } : null }];
      } else {
        const previous = job(source.id);
        const steps = previous ? stepsOf(previous) : [];
        const artifact = previous && steps.length ? steps.map((_, index) => currentArtifact(previous, index)).find(entry => entry?.id === source.artifactId) : null;
        if (!artifact?.accepted_at || artifact.id !== source.artifactId) throw new PublicError("来源成果已变化，请选择当前已确认版本", 409);
        chain = [{ kind: "agent", itemId: previous!.id, title: previous!.request, producer: profile(artifact.agent_id)?.name || artifact.agent_id, artifactId: artifact.id, version: artifact.version, content: artifact.content, practice: null }];
      }
      if (chain.some(entry => entry.kind === "quick" && entry.itemId === id)) throw new PublicError("来源链不能循环引用本事项", 409);
      if (chain.length > 7 || JSON.stringify(chain).length > 36000) throw new PublicError("来源链过长，请选择更近的成果或缩短内容", 409);
    }
    const json = JSON.stringify(chain);
    if (json === target.source_context_json) return target.revision;
    const nextRevision = target.revision + 1;
    const status = rolesOf(target).length ? "planned" : "limited";
    const changed = db.prepare("UPDATE work_items SET source_context_json=?,revision=?,career_revision=?,english_revision=?,status=?,updated_at=datetime('now') WHERE id=? AND revision=?")
      .run(json, nextRevision, nextRevision, nextRevision, status, id, expectedRevision).changes;
    if (!changed) throw new PublicError("事项已变化，请刷新后核对", 409);
    return nextRevision;
  }).immediate();
}
export function updateWorkItem(id: string, material: string, minutes: number, priority: number, expectedRevision: number) {
  const item = getWorkItem(id);
  if (!item) return false;
  return reviseWorkItem(id, item.request, material, item.english_requirement, rolesOf(item), minutes, priority, expectedRevision);
}
export function reviseWorkItem(id: string, request: string, material: string, englishRequirement: string, roles: WorkRole[], minutes: number, priority: number, expectedRevision: number) {
  const db = database();
  return db.transaction(() => {
    const item = getWorkItem(id);
    if (!item || item.lifecycle !== "open" || item.status === "running" || hasActivePractice(db, id) || item.revision !== expectedRevision) return false;
    const ordered = (["career", "english"] as const).filter(role => roles.includes(role));
    const oldRoles = rolesOf(item);
    if (item.request === request && item.material === material && item.english_requirement === englishRequirement && item.minutes === minutes && item.priority === priority && JSON.stringify(oldRoles) === JSON.stringify(ordered)) return true;
    const nextRevision = item.revision + 1;
    const generalChanged = item.request !== request || item.material !== material;
    const roleChanged = JSON.stringify(oldRoles) !== JSON.stringify(ordered);
    const careerChanged = generalChanged || (!oldRoles.includes("career") && ordered.includes("career"));
    const englishChanged = generalChanged || item.english_requirement !== englishRequirement || (!oldRoles.includes("english") && ordered.includes("english")) || oldRoles.includes("career") !== ordered.includes("career");
    const careerRevision = careerChanged ? nextRevision : item.career_revision;
    const englishRevision = englishChanged ? nextRevision : item.english_revision;
    const career = ordered.includes("career") && !!getWorkArtifacts(id).find(artifact => artifact.role === "career" && artifact.revision === careerRevision);
    const english = ordered.includes("english") && !!getWorkArtifacts(id).find(artifact => artifact.role === "english" && artifact.revision === englishRevision && (!ordered.includes("career") || artifact.upstream_artifact_id === getWorkArtifacts(id).find(entry => entry.role === "career" && entry.revision === careerRevision)?.id));
    const ready = ordered.length > 0 && (!ordered.includes("career") || career) && (!ordered.includes("english") || english);
    const status = !generalChanged && !englishChanged && !careerChanged && !roleChanged ? item.status : ordered.length ? ready ? "ready" : "planned" : "limited";
    return !!db.prepare("UPDATE work_items SET request=?,material=?,english_requirement=?,roles=?,minutes=?,priority=?,revision=?,career_revision=?,english_revision=?,status=?,updated_at=datetime('now') WHERE id=? AND revision=?")
      .run(request, material, englishRequirement, JSON.stringify(ordered), minutes, priority, nextRevision, careerRevision, englishRevision, status, id, expectedRevision).changes;
  }).immediate();
}
export function addWorkCorrection(id: string, text: string, expectedRevision: number) {
  const db = database();
  return db.transaction(() => {
    const item = getWorkItem(id);
    if (!item || item.lifecycle !== "open" || item.status === "running" || hasActivePractice(db, id) || item.revision !== expectedRevision || !rolesOf(item).length) return false;
    const revision = item.revision + 1;
    if (!db.prepare("UPDATE work_items SET revision=?,career_revision=CASE WHEN instr(roles,'career')>0 THEN ? ELSE career_revision END,english_revision=CASE WHEN instr(roles,'english')>0 THEN ? ELSE english_revision END,status='planned',updated_at=datetime('now') WHERE id=? AND revision=?").run(revision, revision, revision, id, expectedRevision).changes) return false;
    db.prepare("INSERT INTO work_facts VALUES (?,?,?,'user_correction',?,datetime('now'))").run(randomUUID(), id, text, revision);
    return true;
  }).immediate();
}
export function saveWorkPreference(role: WorkRole, text: string) {
  database();
  try { return savePreference(role, text); }
  catch (error) { if (error instanceof PublicError && error.status === 409) return null; throw error; }
}
export function updateWorkPreference(id: string, text: string, active: boolean, expectedText: string, expectedActive: boolean) {
  database();
  try { updatePreference(id, text, active, expectedText, expectedActive); return 1; }
  catch (error) { if (error instanceof PublicError && error.status === 409) return 0; throw error; }
}
export function claimWorkRun(itemId: string, role: WorkRole, requestId: string, model: string, context: WorkContext, upstreamId: string | null, expectedRevision?: number, expectedEpochs?: Partial<Record<WorkRole, number>>, expectedModelRevision?: number) {
  const db = database();
  return db.transaction(() => {
    const existing = getWorkRunByRequest(requestId);
    if (existing) return existing.item_id === itemId && existing.role === role && existing.revision === getWorkItem(itemId)?.revision && existing.upstream_artifact_id === upstreamId ? { ...existing, newlyClaimed: false } : null;
    const item = getWorkItem(itemId);
    if (!item || item.lifecycle !== "open" || item.status === "running" || hasActivePractice(db, itemId) || !rolesOf(item).includes(role) || (expectedRevision !== undefined && item.revision !== expectedRevision) || (expectedModelRevision !== undefined && item.model_revision !== expectedModelRevision)) return null;
    const agent = profile(role);
    if (!agent?.enabled) return null;
    const config = { revision: agent.revision, name: agent.name, instructions: agent.instructions, deliverable: agent.deliverable, allowMaterial: !!agent.allow_material, allowUpstream: !!agent.allow_upstream };
    if (context.agentConfig && JSON.stringify(context.agentConfig) !== JSON.stringify(config)) return null;
    for (const participatingRole of rolesOf(item)) {
      const epoch = getAgentEpoch(participatingRole);
      if (context.agentEpochs?.[participatingRole] !== epoch || (expectedEpochs && expectedEpochs[participatingRole] !== epoch)) return null;
    }
    if (context.revision !== item.revision || context.request !== item.request || context.material !== (agent.allow_material ? item.material : "") || (context.englishRequirement || "") !== (role === "english" && agent.allow_material ? item.english_requirement : "") || context.minutes !== item.minutes || context.priority !== item.priority) return null;
    const facts = agent.allow_material ? getWorkFacts(itemId).filter(fact => fact.revision <= item.revision).map(fact => ({ id: fact.id, text: fact.text, revision: fact.revision })) : [];
    const preferences = getActivePreferences(role).map(pref => ({ id: pref.id, role: pref.role, text: pref.text }));
    if (JSON.stringify(context.facts) !== JSON.stringify(facts) || JSON.stringify(context.preferences) !== JSON.stringify(preferences)) return null;
    if (JSON.stringify(context.sources || []) !== JSON.stringify(agent.allow_upstream ? sourcesOf(item) : [])) return null;
    const needsUpstream = role === "english" && rolesOf(item).includes("career") && !!agent.allow_upstream;
    if (needsUpstream) {
      const upstream = db.prepare("SELECT item_id,role,revision FROM work_artifacts WHERE id=?").get(upstreamId) as { item_id: string; role: WorkRole; revision: number } | undefined;
      if (!upstream || upstream.item_id !== itemId || upstream.role !== "career" || upstream.revision !== item.career_revision) return null;
      const latest = db.prepare("SELECT id FROM work_artifacts WHERE item_id=? AND role='career' AND revision=? ORDER BY version DESC LIMIT 1").get(itemId, item.career_revision) as { id: string } | undefined;
      if (latest?.id !== upstreamId) return null;
      const actual = db.prepare("SELECT version,revision,content FROM work_artifacts WHERE id=?").get(upstreamId) as { version: number; revision: number; content: string };
      if (!context.upstream || context.upstream.id !== upstreamId || context.upstream.version !== actual.version || context.upstream.revision !== actual.revision || context.upstream.content !== actual.content) return null;
    } else if (upstreamId || context.upstream) return null;
    const id = randomUUID();
    db.prepare("INSERT INTO work_runs (id,item_id,role,request_id,status,model,revision,context_json,upstream_artifact_id,owner_pid,owner_started_at,error,created_at,finished_at) VALUES (?,?,?,?,'running',?,?,?,?,?,?,NULL,datetime('now'),NULL)")
      .run(id, itemId, role, requestId, model, item.revision, JSON.stringify(context), upstreamId, process.pid, processStartedAt);
    db.prepare("UPDATE work_items SET status='running',updated_at=datetime('now') WHERE id=? AND revision=?").run(itemId, item.revision);
    return { ...getWorkRun(id)!, newlyClaimed: true };
  }).immediate();
}
export function completeWorkRun(id: string, status: "success" | "failed" | "cancelled", content: string | null, error: string | null) {
  const db = database();
  return db.transaction(() => {
    const run = getWorkRun(id);
    if (!run || run.status !== "running") return false;
    const item = getWorkItem(run.item_id);
    if (!item || item.revision !== run.revision) return false;
    const context = JSON.parse(run.context_json) as WorkContext;
    const agent = profile(run.role);
    if (status === "success" && (!agent?.enabled || (context.agentConfig && context.agentConfig.revision !== agent.revision) || context.agentEpochs?.[run.role] !== getAgentEpoch(run.role))) {
      status = "cancelled"; content = null; error = "Agent 配置或权限已变化，迟到结果已丢弃";
    }
    if (status === "success" && !content?.trim()) { status = "failed"; error = "模型没有生成可用成果"; }
    const changed = db.prepare("UPDATE work_runs SET status=?,error=?,finished_at=datetime('now') WHERE id=? AND status='running'").run(status, error, id).changes;
    if (!changed) return false;
    if (status === "success" && content) {
      const version = (db.prepare("SELECT COALESCE(MAX(version),0)+1 AS value FROM work_artifacts WHERE item_id=? AND role=?").get(run.item_id, run.role) as { value: number }).value;
      const artifactRevision = run.role === "career" ? item.career_revision : item.english_revision;
      db.prepare("INSERT INTO work_artifacts (id,item_id,role,version,revision,content,run_id,upstream_artifact_id,created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))")
        .run(randomUUID(), run.item_id, run.role, version, artifactRevision, content, run.id, run.upstream_artifact_id);
      const roles = rolesOf(item);
      const ready = roles.every(role => !!currentWorkArtifact(item, role));
      db.prepare("UPDATE work_items SET status=?,updated_at=datetime('now') WHERE id=?").run(ready ? "ready" : "waiting", run.item_id);
    } else db.prepare("UPDATE work_items SET status=?,updated_at=datetime('now') WHERE id=?").run(status, run.item_id);
    return true;
  }).immediate();
}
export function setWorkStatus(id: string, status: string, expectedRevision?: number) {
  database().prepare("UPDATE work_items SET status=?,updated_at=datetime('now') WHERE id=? AND lifecycle='open' AND status!='running' AND (? IS NULL OR revision=?)").run(status, id, expectedRevision ?? null, expectedRevision ?? null);
}

function unfinishedPracticeIds(item: WorkItem) {
  const db = database();
  return rolesOf(item).flatMap(role => {
    const artifact = currentWorkArtifact(item, role);
    if (!artifact) return [];
    const latest = db.prepare("SELECT id,status,source_artifact_id,question,answer FROM work_practices WHERE item_id=? AND role=? ORDER BY rowid DESC LIMIT 1").get(item.id, role) as Pick<WorkPractice, "id" | "status" | "source_artifact_id" | "question" | "answer"> | undefined;
    if (!latest || latest.source_artifact_id !== artifact.id) return [];
    return ["question", "failed", "interrupted"].includes(latest.status) || (latest.status === "cancelled" && !!(latest.question || latest.answer)) ? [latest.id] : [];
  });
}

export function setWorkLifecycle(id: string, action: "complete" | "archive" | "reopen", expectedRevision: number, expectedUnfinishedIds: string[] = [], confirmUnfinished = false) {
  const db = database();
  return db.transaction(() => {
    const item = getWorkItem(id);
    if (!item || item.revision !== expectedRevision || item.status === "running" || hasActivePractice(db, id) || db.prepare("SELECT 1 FROM work_runs WHERE item_id=? AND status='running'").get(id)) return false;
    if (action === "complete") {
      if (item.lifecycle !== "open" || item.status !== "ready" || !rolesOf(item).length) return false;
      if (rolesOf(item).some(role => !currentWorkArtifact(item, role)?.accepted_at)) return false;
      const unfinished = unfinishedPracticeIds(item);
      if (JSON.stringify([...unfinished].sort()) !== JSON.stringify([...expectedUnfinishedIds].sort()) || (unfinished.length > 0 && !confirmUnfinished)) return false;
    }
    if (action === "archive" && item.lifecycle !== "open" && item.lifecycle !== "completed") return false;
    if (action === "reopen" && item.lifecycle === "open") return false;
    const lifecycle = action === "complete" ? "completed" : action === "archive" ? "archived" : "open";
    return !!db.prepare("UPDATE work_items SET lifecycle=?,updated_at=datetime('now') WHERE id=? AND revision=? AND lifecycle=?").run(lifecycle, id, expectedRevision, item.lifecycle).changes;
  }).immediate();
}

export function acceptWorkArtifact(itemId: string, artifactId: string, expectedRevision: number) {
  const db = database();
  return db.transaction(() => {
    const item = getWorkItem(itemId);
    if (!item || item.lifecycle !== "open" || item.status === "running" || hasActivePractice(db, itemId) || item.revision !== expectedRevision) return false;
    const artifact = db.prepare("SELECT * FROM work_artifacts WHERE id=? AND item_id=?").get(artifactId, itemId) as WorkArtifact | undefined;
    if (!artifact || !rolesOf(item).includes(artifact.role) || currentWorkArtifact(item, artifact.role)?.id !== artifactId) return false;
    return !!db.prepare("UPDATE work_artifacts SET accepted_at=COALESCE(accepted_at,datetime('now')) WHERE id=?").run(artifactId).changes;
  }).immediate();
}

function hasActivePractice(db: ReturnType<typeof database>, itemId: string) {
  return !!db.prepare("SELECT 1 FROM work_practice_runs r JOIN work_practices p ON p.id=r.practice_id WHERE p.item_id=? AND r.status='running'").get(itemId);
}
