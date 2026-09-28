import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { getAgentEpoch, getDatabase } from "./store.ts";
import { PublicError } from "./http.ts";
import type { ItemModelChoice } from "./model-connections.ts";

export type AgentProfile = { id: string; name: string; instructions: string; deliverable: string; allow_material: number; allow_upstream: number; enabled: number; revision: number; content_revision: number; template: string | null; created_at: string; updated_at: string };
export type AgentStep = { agentId: string; upstream: number[]; source?: boolean };
export type AgentJob = { id: string; request: string; material: string; steps_json: string; revision: number; correction_revision: number; status: string; lifecycle: "open" | "completed" | "archived"; source_job_id: string | null; source_artifact_id: string | null; source_artifact_version: number | null; target_label: string; planned_date: string | null; due_date: string | null; schedule_revision: number; model_choice_json: string; model_revision: number; created_at: string; updated_at: string };
export type AgentArtifact = { id: string; job_id: string; step_index: number; agent_id: string; version: number; input_hash: string; content: string; run_id: string; upstream_json: string; config_json: string; accepted_at: string | null; created_at: string };
export type AgentRun = { id: string; job_id: string; step_index: number; agent_id: string; request_id: string; status: string; model: string; job_revision: number; agent_revision: number; input_hash: string; context_json: string; owner_pid: number; owner_started_at: number; error: string | null; created_at: string; finished_at: string | null };
export type AgentCorrection = { id: string; job_id: string; text: string; revision: number; active: number; created_at: string };
export type AgentPreference = { id: string; agent_id: string; text: string; active: number; created_at: string; updated_at: string };
export type AgentMetricJournalEntry = { seq: number; kind: "profile_created" | "job_created" | "run_started" | "run_finished" | "artifact_created" | "artifact_accepted"; entity_id: string };
const processStartedAt = Math.round(Date.now() - process.uptime() * 1000);
let initialized = false;

export function validateScheduleDates(plannedDate: unknown, dueDate: unknown) {
  function calendarDate(value: unknown, label: string): string | null {
    if (value === null) return null;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new PublicError(`${label}须为 YYYY-MM-DD 日期或 null`);
    const [year, month, day] = value.split("-").map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) throw new PublicError(`${label}不是有效日历日期`);
    return value;
  }
  const planned = calendarDate(plannedDate, "计划日");
  const due = calendarDate(dueDate, "截止日");
  if (planned && due && planned > due) throw new PublicError("计划日不可晚于截止日");
  return { plannedDate: planned, dueDate: due };
}

function db() {
  const database = getDatabase();
  if (initialized) return database;
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_profiles'").get();
  const correctionTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_corrections'").get();
  const needsCorrectionActive = !!correctionTable && !(database.prepare("PRAGMA table_info(agent_corrections)").all() as { name: string }[]).some(column => column.name === "active");
  const needsContentRevision = !!exists && !(database.prepare("PRAGMA table_info(agent_profiles)").all() as { name: string }[]).some(column => column.name === "content_revision");
  const jobsExist = !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_jobs'").get();
  const jobColumns = jobsExist ? (database.prepare("PRAGMA table_info(agent_jobs)").all() as { name: string }[]).map(column => column.name) : [];
  const needsContinuity = jobsExist && ["source_job_id", "source_artifact_id", "source_artifact_version", "target_label"].some(name => !jobColumns.includes(name));
  const needsSchedule = jobsExist && ["planned_date", "due_date", "schedule_revision"].some(name => !jobColumns.includes(name));
  const needsModelChoice = jobsExist && ["model_choice_json", "model_revision"].some(name => !jobColumns.includes(name));
  const metricObjects = database.prepare("SELECT name FROM sqlite_master WHERE name IN ('agent_metric_events','agent_metric_profile_created','agent_metric_job_created','agent_metric_run_started','agent_metric_run_finished','agent_metric_artifact_created','agent_metric_artifact_accepted')").all() as { name: string }[];
  const needsMetricJournal = metricObjects.length !== 7;
  if (!exists || needsCorrectionActive || needsContentRevision || needsContinuity || needsSchedule || needsModelChoice || needsMetricJournal) database.prepare("VACUUM INTO ?").run(`${database.name}.backup-agent-work-${Date.now()}-${randomUUID()}`);
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS agent_profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL, deliverable TEXT NOT NULL,
        allow_material INTEGER NOT NULL CHECK(allow_material IN (0,1)), allow_upstream INTEGER NOT NULL CHECK(allow_upstream IN (0,1)),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), revision INTEGER NOT NULL DEFAULT 1,
        template TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        content_revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS agent_jobs (
        id TEXT PRIMARY KEY, request TEXT NOT NULL, material TEXT NOT NULL DEFAULT '', steps_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, correction_revision INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'planned', lifecycle TEXT NOT NULL DEFAULT 'open' CHECK(lifecycle IN ('open','completed','archived')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        source_job_id TEXT REFERENCES agent_jobs(id), source_artifact_id TEXT REFERENCES agent_artifacts(id),
        source_artifact_version INTEGER, target_label TEXT NOT NULL DEFAULT '',
        planned_date TEXT, due_date TEXT, schedule_revision INTEGER NOT NULL DEFAULT 1,
        model_choice_json TEXT NOT NULL DEFAULT 'null', model_revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS agent_corrections (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES agent_jobs(id), text TEXT NOT NULL,
        revision INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_preferences (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent_profiles(id), text TEXT NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES agent_jobs(id), step_index INTEGER NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agent_profiles(id), request_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL, model TEXT NOT NULL, job_revision INTEGER NOT NULL, agent_revision INTEGER NOT NULL,
        input_hash TEXT NOT NULL, context_json TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_started_at INTEGER NOT NULL,
        error TEXT, created_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS agent_one_active_run ON agent_runs(job_id) WHERE status='running';
      CREATE TABLE IF NOT EXISTS agent_artifacts (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES agent_jobs(id), step_index INTEGER NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agent_profiles(id), version INTEGER NOT NULL, input_hash TEXT NOT NULL,
        content TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id), upstream_json TEXT NOT NULL,
        config_json TEXT NOT NULL, accepted_at TEXT, created_at TEXT NOT NULL,
        UNIQUE(job_id,step_index,version)
      );
    `);
    if (!(database.prepare("PRAGMA table_info(agent_corrections)").all() as { name: string }[]).some(column => column.name === "active")) database.exec("ALTER TABLE agent_corrections ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))");
    if (!(database.prepare("PRAGMA table_info(agent_profiles)").all() as { name: string }[]).some(column => column.name === "content_revision")) {
      database.exec("ALTER TABLE agent_profiles ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 1");
      database.exec("UPDATE agent_profiles SET content_revision=revision");
    }
    const continuityColumns = (database.prepare("PRAGMA table_info(agent_jobs)").all() as { name: string }[]).map(column => column.name);
    if (!continuityColumns.includes("source_job_id")) database.exec("ALTER TABLE agent_jobs ADD COLUMN source_job_id TEXT REFERENCES agent_jobs(id)");
    if (!continuityColumns.includes("source_artifact_id")) database.exec("ALTER TABLE agent_jobs ADD COLUMN source_artifact_id TEXT REFERENCES agent_artifacts(id)");
    if (!continuityColumns.includes("source_artifact_version")) database.exec("ALTER TABLE agent_jobs ADD COLUMN source_artifact_version INTEGER");
    if (!continuityColumns.includes("target_label")) database.exec("ALTER TABLE agent_jobs ADD COLUMN target_label TEXT NOT NULL DEFAULT ''");
    if (!continuityColumns.includes("planned_date")) database.exec("ALTER TABLE agent_jobs ADD COLUMN planned_date TEXT");
    if (!continuityColumns.includes("due_date")) database.exec("ALTER TABLE agent_jobs ADD COLUMN due_date TEXT");
    if (!continuityColumns.includes("schedule_revision")) database.exec("ALTER TABLE agent_jobs ADD COLUMN schedule_revision INTEGER NOT NULL DEFAULT 1");
    if (!continuityColumns.includes("model_choice_json")) database.exec("ALTER TABLE agent_jobs ADD COLUMN model_choice_json TEXT NOT NULL DEFAULT 'null'");
    if (!continuityColumns.includes("model_revision")) database.exec("ALTER TABLE agent_jobs ADD COLUMN model_revision INTEGER NOT NULL DEFAULT 1");
    database.exec(`
      CREATE TABLE IF NOT EXISTS agent_metric_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK(kind IN ('profile_created','job_created','run_started','run_finished','artifact_created','artifact_accepted')),
        entity_id TEXT NOT NULL,
        UNIQUE(kind,entity_id)
      );
    `);
    if (needsMetricJournal) database.exec(`
      INSERT OR IGNORE INTO agent_metric_events(kind,entity_id) SELECT 'profile_created',id FROM agent_profiles;
      INSERT OR IGNORE INTO agent_metric_events(kind,entity_id) SELECT 'job_created',id FROM agent_jobs;
      INSERT OR IGNORE INTO agent_metric_events(kind,entity_id) SELECT 'run_started',id FROM agent_runs;
      INSERT OR IGNORE INTO agent_metric_events(kind,entity_id) SELECT 'run_finished',id FROM agent_runs WHERE status!='running' AND finished_at IS NOT NULL;
      INSERT OR IGNORE INTO agent_metric_events(kind,entity_id) SELECT 'artifact_created',id FROM agent_artifacts;
      INSERT OR IGNORE INTO agent_metric_events(kind,entity_id) SELECT 'artifact_accepted',id FROM agent_artifacts WHERE accepted_at IS NOT NULL;
    `);
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS agent_metric_profile_created AFTER INSERT ON agent_profiles BEGIN
        INSERT INTO agent_metric_events(kind,entity_id) VALUES('profile_created',NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS agent_metric_job_created AFTER INSERT ON agent_jobs BEGIN
        INSERT INTO agent_metric_events(kind,entity_id) VALUES('job_created',NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS agent_metric_run_started AFTER INSERT ON agent_runs BEGIN
        INSERT INTO agent_metric_events(kind,entity_id) VALUES('run_started',NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS agent_metric_run_finished AFTER UPDATE OF status,finished_at ON agent_runs
        WHEN OLD.status='running' AND NEW.status!='running' AND NEW.finished_at IS NOT NULL BEGIN
        INSERT INTO agent_metric_events(kind,entity_id) VALUES('run_finished',NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS agent_metric_artifact_created AFTER INSERT ON agent_artifacts BEGIN
        INSERT INTO agent_metric_events(kind,entity_id) VALUES('artifact_created',NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS agent_metric_artifact_accepted AFTER UPDATE OF accepted_at ON agent_artifacts
        WHEN OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL BEGIN
        INSERT INTO agent_metric_events(kind,entity_id) VALUES('artifact_accepted',NEW.id);
      END;
    `);
    const seed = database.prepare("INSERT OR IGNORE INTO agent_profiles (id,name,instructions,deliverable,allow_material,allow_upstream,enabled,revision,template,created_at,updated_at,content_revision) VALUES (?,?,?,?,1,1,?,1,?,datetime('now'),datetime('now'),1)");
    const oldAgent = database.prepare("SELECT enabled FROM agents WHERE id=?");
    seed.run("career", "求职顾问", "依据用户明确提供的事实，用中文整理求职或面试材料；未知信息标待核对，不编造经历或职责。", "可核对的中文求职材料", (oldAgent.get("career") as { enabled: number } | undefined)?.enabled ?? 1, "career");
    seed.run("english", "英语教练", "依据当前事项与获准的上游成果，用英文整理可直接使用的表达；不得编造个人事实。", "可直接使用的英文表达", (oldAgent.get("english") as { enabled: number } | undefined)?.enabled ?? 1, "english");
  }).immediate();
  initialized = true;
  return database;
}

function effectiveProfile(entry: AgentProfile) {
  if (!entry.template) return entry;
  const old = db().prepare("SELECT enabled FROM agents WHERE id=?").get(entry.id) as { enabled: number } | undefined;
  return { ...entry, enabled: old?.enabled ?? entry.enabled };
}
export function profiles() { return (db().prepare("SELECT * FROM agent_profiles ORDER BY CASE WHEN template IS NULL THEN 1 ELSE 0 END,created_at,rowid").all() as AgentProfile[]).map(effectiveProfile); }
export function profile(id: string) { const entry = db().prepare("SELECT * FROM agent_profiles WHERE id=?").get(id) as AgentProfile | undefined; return entry ? effectiveProfile(entry) : undefined; }
export function saveProfile(input: Pick<AgentProfile, "name" | "instructions" | "deliverable" | "allow_material" | "allow_upstream">, id?: string, expectedRevision?: number) {
  const database = db();
  return database.transaction(() => {
    if (!id) {
      const created = randomUUID();
      database.prepare("INSERT INTO agent_profiles (id,name,instructions,deliverable,allow_material,allow_upstream,enabled,revision,template,created_at,updated_at,content_revision) VALUES (?,?,?,?,?,?,1,1,NULL,datetime('now'),datetime('now'),1)")
        .run(created, input.name, input.instructions, input.deliverable, input.allow_material, input.allow_upstream);
      return created;
    }
    const old = profile(id);
    if (!old || old.revision !== expectedRevision) throw new PublicError("Agent 配置已变化，请刷新后核对", 409);
    if (old.name === input.name && old.instructions === input.instructions && old.deliverable === input.deliverable && old.allow_material === input.allow_material && old.allow_upstream === input.allow_upstream) return id;
    const changed = database.prepare("UPDATE agent_profiles SET name=?,instructions=?,deliverable=?,allow_material=?,allow_upstream=?,revision=revision+1,content_revision=content_revision+1,updated_at=datetime('now') WHERE id=? AND revision=?")
      .run(input.name, input.instructions, input.deliverable, input.allow_material, input.allow_upstream, id, expectedRevision).changes;
    if (!changed) throw new PublicError("Agent 配置已变化，请刷新后核对", 409);
    if (old.template) database.prepare("INSERT INTO settings(key,value) VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run(`agent.epoch.${id}`);
    return id;
  }).immediate();
}
export function setProfileEnabled(id: string, enabled: boolean, revision: number) {
  const database = db();
  return database.transaction(() => {
    const old = profile(id);
    if (!old || old.revision !== revision) throw new PublicError("Agent 状态已变化，请刷新后核对", 409);
    if (old.enabled === Number(enabled)) return false;
    database.prepare("UPDATE agent_profiles SET enabled=?,revision=revision+1,updated_at=datetime('now') WHERE id=? AND revision=?").run(Number(enabled), id, revision);
    if (old.template) {
      database.prepare("UPDATE agents SET enabled=? WHERE id=?").run(Number(enabled), id);
      database.prepare("INSERT INTO settings(key,value) VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run(`agent.epoch.${id}`);
    }
    return true;
  }).immediate();
}
export function stepsOf(job: AgentJob): AgentStep[] { return JSON.parse(job.steps_json) as AgentStep[]; }
export function job(id: string) { return db().prepare("SELECT * FROM agent_jobs WHERE id=?").get(id) as AgentJob | undefined; }
export function runsFor(jobId: string) { return db().prepare("SELECT * FROM agent_runs WHERE job_id=? ORDER BY rowid DESC").all(jobId) as AgentRun[]; }
export function runByRequest(requestId: string) { return db().prepare("SELECT * FROM agent_runs WHERE request_id=?").get(requestId) as AgentRun | undefined; }
export function artifactsFor(jobId: string) { return db().prepare("SELECT * FROM agent_artifacts WHERE job_id=? ORDER BY rowid DESC").all(jobId) as AgentArtifact[]; }
export function correctionsFor(jobId: string) { return db().prepare("SELECT * FROM agent_corrections WHERE job_id=? AND active=1 ORDER BY revision,rowid").all(jobId) as AgentCorrection[]; }
export function allAgentPreferences() {
  const database = db();
  const current = database.prepare("SELECT * FROM agent_preferences").all() as AgentPreference[];
  const hasLegacy = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_preferences'").get();
  const legacy = hasLegacy ? database.prepare("SELECT id,role AS agent_id,text,active,created_at,updated_at FROM work_preferences").all() as AgentPreference[] : [];
  return [...current, ...legacy].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}
export function activePreferences(agentId: string) {
  const entries = allAgentPreferences().filter(entry => entry.agent_id === agentId && entry.active);
  if (entries.length > 5) throw new PublicError("该 Agent 已有超过 5 条有效偏好，请先撤销多余条目", 409);
  return entries;
}

function selectedSource(sourceJobId: string, artifactId: string, version: number, sourceRevision: number, targetJobId?: string) {
  const sourceJob = job(sourceJobId);
  if (!sourceJob || sourceJob.revision !== sourceRevision) throw new PublicError("来源事项已变化，请刷新后核对", 409);
  const artifact = db().prepare("SELECT * FROM agent_artifacts WHERE id=? AND job_id=? AND version=? AND accepted_at IS NOT NULL")
    .get(artifactId, sourceJobId, version) as AgentArtifact | undefined;
  if (!artifact) throw new PublicError("请选择已确认的成果版本", 409);
  if (targetJobId) {
    const visited = new Set<string>();
    let ancestor: AgentJob | undefined = sourceJob;
    while (ancestor) {
      if (ancestor.id === targetJobId || visited.has(ancestor.id)) throw new PublicError("接续来源不能形成循环", 409);
      visited.add(ancestor.id);
      ancestor = ancestor.source_job_id ? job(ancestor.source_job_id) : undefined;
    }
  }
  return artifact;
}

function fixedSource(jobRow: AgentJob) {
  if (!jobRow.source_job_id || !jobRow.source_artifact_id || !jobRow.source_artifact_version) return null;
  return db().prepare("SELECT * FROM agent_artifacts WHERE id=? AND job_id=? AND version=? AND accepted_at IS NOT NULL")
    .get(jobRow.source_artifact_id, jobRow.source_job_id, jobRow.source_artifact_version) as AgentArtifact | undefined || null;
}

function stepInput(jobRow: AgentJob, index: number, seen = new Set<number>()): { hash: string; upstream: AgentArtifact[] } | null {
  const steps = stepsOf(jobRow);
  const step = steps[index];
  const agent = step && profile(step.agentId);
  if (!step || !agent || seen.has(index)) return null;
  seen.add(index);
  const upstream: AgentArtifact[] = [];
  if (step.source) {
    if (!agent.allow_upstream) return null;
    const source = fixedSource(jobRow);
    if (!source) return null;
    upstream.push(source);
  }
  for (const dependency of step.upstream) {
    if (dependency >= index || !agent.allow_upstream) return null;
    const artifact = currentArtifact(jobRow, dependency, seen);
    if (!artifact) return null;
    upstream.push(artifact);
  }
  seen.delete(index);
  const hash = createHash("sha256").update(JSON.stringify({ index, request: jobRow.request, material: agent.allow_material ? jobRow.material : null, correctionRevision: agent.allow_material ? jobRow.correction_revision : null, agentId: agent.id, agentRevision: agent.template ? agent.revision : agent.content_revision, legacyEpoch: agent.template ? getAgentEpoch(agent.id) : null, upstream: upstream.map(a => [a.id, a.version]) })).digest("hex");
  return { hash, upstream };
}
export function currentArtifact(jobRow: AgentJob, index: number, seen = new Set<number>()): AgentArtifact | null {
  if (jobRow.lifecycle !== "open") {
    const history = artifactsFor(jobRow.id).filter(artifact => artifact.step_index === index);
    return jobRow.lifecycle === "completed" ? history.find(artifact => !!artifact.accepted_at) || null : null;
  }
  const input = stepInput(jobRow, index, seen);
  if (!input) return null;
  return artifactsFor(jobRow.id).find(a => a.step_index === index && a.input_hash === input.hash) || null;
}
export function nextStep(jobRow: AgentJob) {
  return stepsOf(jobRow).findIndex((_, index) => !currentArtifact(jobRow, index));
}
export function agentState() {
  recoverRuns();
  const database = db();
  const jobs = database.prepare("SELECT * FROM agent_jobs ORDER BY updated_at DESC,rowid DESC").all() as AgentJob[];
  return {
    profiles: profiles(), jobs,
    current: Object.fromEntries(jobs.map(entry => [entry.id, stepsOf(entry).map((_, index) => currentArtifact(entry, index)?.id || null)])),
    runs: database.prepare("SELECT * FROM agent_runs ORDER BY rowid DESC").all() as AgentRun[],
    artifacts: database.prepare("SELECT * FROM agent_artifacts ORDER BY rowid DESC").all() as AgentArtifact[],
    corrections: database.prepare("SELECT * FROM agent_corrections ORDER BY rowid DESC").all() as AgentCorrection[],
    preferences: allAgentPreferences(),
  };
}
export function agentMetricsState() {
  recoverRuns();
  const database = db();
  return database.transaction(() => {
    const metricHighWater = (database.prepare("SELECT COALESCE(MAX(seq),0) AS value FROM agent_metric_events").get() as { value: number }).value;
    return {
      profiles: profiles(),
      jobs: database.prepare("SELECT * FROM agent_jobs ORDER BY updated_at DESC,rowid DESC").all() as AgentJob[],
      runs: database.prepare("SELECT * FROM agent_runs ORDER BY rowid DESC").all() as AgentRun[],
      artifacts: database.prepare("SELECT * FROM agent_artifacts ORDER BY rowid DESC").all() as AgentArtifact[],
      metricJournal: database.prepare("SELECT seq,kind,entity_id FROM agent_metric_events WHERE seq<=? ORDER BY seq").all(metricHighWater) as AgentMetricJournalEntry[],
      metricHighWater,
    };
  })();
}
export function validateSteps(value: unknown): AgentStep[] {
  return validateJobSteps(value, false);
}
export function validateJobSteps(value: unknown, withSource: boolean): AgentStep[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new PublicError("请选择 1 至 4 个执行步骤");
  const steps = value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new PublicError("执行步骤无效");
    const entry = raw as { agentId?: unknown; upstream?: unknown; source?: unknown };
    if (typeof entry.agentId !== "string" || entry.agentId.length > 50 || !profile(entry.agentId)?.enabled) throw new PublicError("执行 Agent 无效或已暂停");
    if (!Array.isArray(entry.upstream) || new Set(entry.upstream).size !== entry.upstream.length || entry.upstream.some(dependency => !Number.isInteger(dependency) || dependency < 0 || dependency >= index)) throw new PublicError("上游成果选择无效");
    if (entry.source !== undefined && typeof entry.source !== "boolean") throw new PublicError("来源可见范围无效");
    if (entry.source && !withSource) throw new PublicError("此事项未选择接续来源");
    if ((entry.upstream.length || entry.source) && !profile(entry.agentId)?.allow_upstream) throw new PublicError("此 Agent 未获准读取上游成果");
    return withSource ? { agentId: entry.agentId, upstream: entry.upstream as number[], source: !!entry.source } : { agentId: entry.agentId, upstream: entry.upstream as number[] };
  });
  if (withSource && !steps.some(step => step.source)) throw new PublicError("请选择至少一个接收来源的 Agent");
  return steps;
}
export function createJob(request: string, material: string, steps: AgentStep[], schedule?: { plannedDate?: unknown; dueDate?: unknown }, modelChoice: ItemModelChoice | null = null) {
  const dates = validateScheduleDates(schedule?.plannedDate ?? null, schedule?.dueDate ?? null);
  const id = randomUUID();
  db().prepare("INSERT INTO agent_jobs (id,request,material,steps_json,revision,correction_revision,status,lifecycle,created_at,updated_at,planned_date,due_date,model_choice_json) VALUES (?,?,?,?,1,0,'planned','open',datetime('now'),datetime('now'),?,?,?)")
    .run(id, request, material, JSON.stringify(steps), dates.plannedDate, dates.dueDate, JSON.stringify(modelChoice));
  return id;
}
export function createContinuationJob(request: string, material: string, steps: AgentStep[], targetLabel: string, sourceJobId: string, sourceArtifactId: string, sourceVersion: number, sourceRevision: number, schedule?: { plannedDate?: unknown; dueDate?: unknown }, modelChoice: ItemModelChoice | null = null) {
  const dates = validateScheduleDates(schedule?.plannedDate ?? null, schedule?.dueDate ?? null);
  const database = db();
  return database.transaction(() => {
    const checkedSteps = validateJobSteps(steps, true);
    selectedSource(sourceJobId, sourceArtifactId, sourceVersion, sourceRevision);
    const id = randomUUID();
    database.prepare("INSERT INTO agent_jobs (id,request,material,steps_json,revision,correction_revision,status,lifecycle,created_at,updated_at,source_job_id,source_artifact_id,source_artifact_version,target_label,planned_date,due_date,model_choice_json) VALUES (?,?,?,?,1,0,'planned','open',datetime('now'),datetime('now'),?,?,?,?,?,?,?)")
      .run(id, request, material, JSON.stringify(checkedSteps), sourceJobId, sourceArtifactId, sourceVersion, targetLabel, dates.plannedDate, dates.dueDate, JSON.stringify(modelChoice));
    return id;
  }).immediate();
}
export function setJobModelChoice(id: string, choice: ItemModelChoice | null, expectedRevision: number) {
  const database = db();
  return database.transaction(() => {
    const current = job(id);
    if (!current) throw new PublicError("事项不存在", 404);
    if (current.lifecycle !== "open" || current.model_revision !== expectedRevision || database.prepare("SELECT 1 FROM agent_runs WHERE job_id=? AND status='running'").get(id)) throw new PublicError("事项模型选择已变化或正在运行，请刷新后核对", 409);
    if (current.model_choice_json === JSON.stringify(choice)) return current.model_revision;
    const changed = database.prepare("UPDATE agent_jobs SET model_choice_json=?,model_revision=model_revision+1,updated_at=datetime('now') WHERE id=? AND model_revision=? AND lifecycle='open' AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE job_id=? AND status='running')").run(JSON.stringify(choice), id, expectedRevision, id).changes;
    if (!changed) throw new PublicError("事项模型选择已变化，请刷新后核对", 409);
    return expectedRevision + 1;
  }).immediate();
}
export function setJobSchedule(id: string, plannedDate: unknown, dueDate: unknown, expectedScheduleRevision: number) {
  const dates = validateScheduleDates(plannedDate, dueDate);
  const database = db();
  return database.transaction(() => {
    const current = job(id);
    if (!current) throw new PublicError("事项不存在", 404);
    if (current.schedule_revision !== expectedScheduleRevision) throw new PublicError("排期已变化，请刷新后核对", 409);
    if (current.planned_date === dates.plannedDate && current.due_date === dates.dueDate) return current.schedule_revision;
    const changed = database.prepare("UPDATE agent_jobs SET planned_date=?,due_date=?,schedule_revision=schedule_revision+1 WHERE id=? AND schedule_revision=?")
      .run(dates.plannedDate, dates.dueDate, id, expectedScheduleRevision).changes;
    if (!changed) throw new PublicError("排期已变化，请刷新后核对", 409);
    return expectedScheduleRevision + 1;
  }).immediate();
}
export function updateJob(id: string, request: string, material: string, steps: AgentStep[], expectedRevision: number) {
  const database = db();
  const current = job(id);
  if (!current) throw new PublicError("事项不存在", 404);
  const checkedSteps = validateJobSteps(steps, !!current.source_artifact_id);
  if (current.source_artifact_id && JSON.stringify(checkedSteps.map(step => !!step.source)) !== JSON.stringify(stepsOf(current).map(step => !!step.source))) throw new PublicError("接续可见范围须通过明确操作修改", 409);
  const changed = database.prepare("UPDATE agent_jobs SET request=?,material=?,steps_json=?,revision=revision+1,status='planned',updated_at=datetime('now') WHERE id=? AND revision=? AND lifecycle='open' AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE job_id=? AND status='running')")
    .run(request, material, JSON.stringify(checkedSteps), id, expectedRevision, id).changes;
  if (!changed) throw new PublicError("事项已变化或正在运行，请刷新后核对", 409);
}
export function updateContinuation(jobId: string, expectedRevision: number, targetLabel: string, steps: AgentStep[], source: { jobId: string; artifactId: string; version: number; revision: number } | null) {
  const database = db();
  database.transaction(() => {
    const current = job(jobId);
    if (!current || current.revision !== expectedRevision || current.lifecycle !== "open" || runsFor(jobId).some(run => run.status === "running")) throw new PublicError("事项已变化或正在运行，请刷新后核对", 409);
    const checkedSteps = validateJobSteps(steps, !!source);
    if (source) selectedSource(source.jobId, source.artifactId, source.version, source.revision, jobId);
    database.prepare("UPDATE agent_jobs SET source_job_id=?,source_artifact_id=?,source_artifact_version=?,target_label=?,steps_json=?,revision=revision+1,status='planned',updated_at=datetime('now') WHERE id=? AND revision=?")
      .run(source?.jobId || null, source?.artifactId || null, source?.version || null, targetLabel, JSON.stringify(checkedSteps), jobId, expectedRevision);
  }).immediate();
}
export function correctJob(id: string, text: string, expectedRevision: number) {
  const database = db();
  database.transaction(() => {
    const existing = correctionsFor(id);
    if (existing.length >= 12 || existing.reduce((total, entry) => total + entry.text.length, 0) + text.length > 8000) throw new PublicError("当前有效纠正已达上限，请先停用不再适用的旧纠正", 409);
    const changed = database.prepare("UPDATE agent_jobs SET revision=revision+1,correction_revision=correction_revision+1,status='planned',updated_at=datetime('now') WHERE id=? AND revision=? AND lifecycle='open' AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE job_id=? AND status='running')").run(id, expectedRevision, id).changes;
    if (!changed) throw new PublicError("事项已变化或正在运行，请刷新后核对", 409);
    const current = job(id)!;
    database.prepare("INSERT INTO agent_corrections (id,job_id,text,revision,active,created_at) VALUES (?,?,?,?,1,datetime('now'))").run(randomUUID(), id, text, current.correction_revision);
  }).immediate();
}
export function archiveCorrection(jobId: string, correctionId: string, expectedRevision: number) {
  const database = db();
  database.transaction(() => {
    const current = job(jobId);
    const correction = database.prepare("SELECT * FROM agent_corrections WHERE id=? AND job_id=?").get(correctionId, jobId) as AgentCorrection | undefined;
    if (!current || current.revision !== expectedRevision || current.lifecycle !== "open" || !correction?.active || runsFor(jobId).some(run => run.status === "running")) throw new PublicError("事项或纠正已变化，请刷新后核对", 409);
    database.prepare("UPDATE agent_corrections SET active=0 WHERE id=?").run(correctionId);
    database.prepare("UPDATE agent_jobs SET revision=revision+1,correction_revision=correction_revision+1,status='planned',updated_at=datetime('now') WHERE id=?").run(jobId);
  }).immediate();
}
export function setJobLifecycle(id: string, action: "complete" | "archive" | "reopen", revision: number) {
  const database = db();
  database.transaction(() => {
    const current = job(id);
    if (!current || current.revision !== revision || runsFor(id).some(run => run.status === "running")) throw new PublicError("事项已变化或正在运行", 409);
    if (action === "complete" && (current.lifecycle !== "open" || stepsOf(current).some((_, index) => !currentArtifact(current, index)?.accepted_at))) throw new PublicError("请先核对全部当前成果", 409);
    if (action === "archive" && current.lifecycle === "archived") throw new PublicError("事项已归档", 409);
    if (action === "reopen" && current.lifecycle === "open") throw new PublicError("事项已打开", 409);
    database.prepare("UPDATE agent_jobs SET lifecycle=?,revision=revision+1,updated_at=datetime('now') WHERE id=?").run(action === "complete" ? "completed" : action === "archive" ? "archived" : "open", id);
  }).immediate();
}
export function acceptArtifact(jobId: string, artifactId: string, revision: number) {
  const database = db();
  database.transaction(() => {
    const current = job(jobId);
    const artifact = artifactsFor(jobId).find(a => a.id === artifactId);
    if (!current || current.revision !== revision || current.lifecycle !== "open" || runsFor(jobId).some(run => run.status === "running") || !artifact || currentArtifact(current, artifact.step_index)?.id !== artifactId) throw new PublicError("成果已变化，请刷新后核对", 409);
    database.prepare("UPDATE agent_artifacts SET accepted_at=COALESCE(accepted_at,datetime('now')) WHERE id=?").run(artifactId);
  }).immediate();
}
export function savePreference(agentId: string, text: string) {
  const database = db();
  return database.transaction(() => {
    if (!profile(agentId)) throw new PublicError("Agent 不存在", 404);
    if (allAgentPreferences().filter(entry => entry.agent_id === agentId && entry.active).length >= 5) throw new PublicError("每个 Agent 最多 5 条有效偏好", 409);
    const id = randomUUID();
    database.prepare("INSERT INTO agent_preferences VALUES (?,?,?,1,datetime('now'),datetime('now'))").run(id, agentId, text);
    return id;
  }).immediate();
}
export function updatePreference(id: string, text: string, active: boolean, expectedText: string, expectedActive: boolean) {
  const database = db();
  database.transaction(() => {
    const own = database.prepare("SELECT * FROM agent_preferences WHERE id=?").get(id) as AgentPreference | undefined;
    const hasLegacy = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_preferences'").get();
    const old = own || (hasLegacy ? database.prepare("SELECT id,role AS agent_id,text,active,created_at,updated_at FROM work_preferences WHERE id=?").get(id) as AgentPreference | undefined : undefined);
    if (!old || old.text !== expectedText || old.active !== Number(expectedActive)) throw new PublicError("偏好已变化，请刷新后核对", 409);
    if (active && !old.active && allAgentPreferences().filter(entry => entry.agent_id === old.agent_id && entry.active).length >= 5) throw new PublicError("有效偏好已达 5 条上限", 409);
    database.prepare(`UPDATE ${own ? "agent_preferences" : "work_preferences"} SET text=?,active=?,updated_at=datetime('now') WHERE id=?`).run(text, Number(active), id);
  }).immediate();
}

function pidAlive(pid: number, startedAt: number) {
  if (pid === process.pid) return Math.abs(startedAt - processStartedAt) < 3000;
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  try {
    const actual = Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1500 }).trim());
    return Number.isFinite(actual) && Math.abs(actual - startedAt) < 3000;
  } catch { return true; }
}
export function recoverRuns() {
  const database = db();
  const running = database.prepare("SELECT id,job_id,owner_pid,owner_started_at FROM agent_runs WHERE status='running'").all() as Pick<AgentRun, "id" | "job_id" | "owner_pid" | "owner_started_at">[];
  const orphaned = running.filter(run => !pidAlive(run.owner_pid, run.owner_started_at));
  if (!orphaned.length) return;
  database.transaction(() => {
    for (const run of orphaned) {
      if (database.prepare("UPDATE agent_runs SET status='interrupted',error='应用重启，运行已中断',finished_at=datetime('now') WHERE id=? AND status='running'").run(run.id).changes) database.prepare("UPDATE agent_jobs SET status='interrupted',updated_at=datetime('now') WHERE id=? AND status='running'").run(run.job_id);
    }
  }).immediate();
}

export function claimRun(jobId: string, index: number, requestId: string, model: string, context: Record<string, unknown>, inputHash: string, expectedModelRevision?: number) {
  const database = db();
  return database.transaction(() => {
    const duplicate = database.prepare("SELECT * FROM agent_runs WHERE request_id=?").get(requestId) as AgentRun | undefined;
    if (duplicate) {
      if (duplicate.job_id !== jobId || duplicate.step_index !== index || duplicate.job_revision !== job(jobId)?.revision || duplicate.input_hash !== inputHash || duplicate.context_json !== JSON.stringify(context)) throw new PublicError("请求标识已用于其他步骤或旧输入", 409);
      return { run: duplicate, newClaim: false };
    }
    const current = job(jobId);
    if (!current || current.lifecycle !== "open" || current.status === "running" || nextStep(current) !== index || (expectedModelRevision !== undefined && current.model_revision !== expectedModelRevision)) throw new PublicError("事项状态或模型选择已变化，请刷新后重试", 409);
    const step = stepsOf(current)[index];
    const agent = profile(step.agentId);
    if (!agent?.enabled || (agent.template && !(database.prepare("SELECT enabled FROM agents WHERE id=?").get(agent.id) as { enabled: number } | undefined)?.enabled)) throw new PublicError("Agent 已暂停", 409);
    const actualInput = inputFor(current, index);
    if (actualInput.inputHash !== inputHash || JSON.stringify(actualInput.context) !== JSON.stringify(context)) throw new PublicError("运行资料已变化，请刷新后重试", 409);
    const id = randomUUID();
    database.prepare("INSERT INTO agent_runs VALUES (?,?,?,?,?,'running',?,?,?,?,?,?,?,NULL,datetime('now'),NULL)")
      .run(id, jobId, index, agent.id, requestId, model, current.revision, agent.revision, inputHash, JSON.stringify(context), process.pid, processStartedAt);
    database.prepare("UPDATE agent_jobs SET status='running',updated_at=datetime('now') WHERE id=?").run(jobId);
    return { run: database.prepare("SELECT * FROM agent_runs WHERE id=?").get(id) as AgentRun, newClaim: true };
  }).immediate();
}
export function finishRun(id: string, status: "success" | "failed" | "cancelled", content: string | null, error: string | null) {
  const database = db();
  return database.transaction(() => {
    const run = database.prepare("SELECT * FROM agent_runs WHERE id=?").get(id) as AgentRun | undefined;
    if (!run || run.status !== "running") return false;
    const current = job(run.job_id);
    const agent = profile(run.agent_id);
    if (status === "success" && (!current || !agent || !agent.enabled || current.revision !== run.job_revision || agent.revision !== run.agent_revision || stepInput(current, run.step_index)?.hash !== run.input_hash)) {
      status = "cancelled"; content = null; error = "配置或事项已变化，迟到结果已丢弃";
    }
    if (status === "success" && !content?.trim()) { status = "failed"; error = "模型没有生成可用成果"; }
    if (!database.prepare("UPDATE agent_runs SET status=?,error=?,finished_at=datetime('now') WHERE id=? AND status='running'").run(status, error, id).changes) return false;
    if (status === "success" && content && current && agent) {
      const version = (database.prepare("SELECT COALESCE(MAX(version),0)+1 AS value FROM agent_artifacts WHERE job_id=? AND step_index=?").get(run.job_id, run.step_index) as { value: number }).value;
      const context = JSON.parse(run.context_json) as { upstream: { id: string; version: number }[] };
      database.prepare("INSERT INTO agent_artifacts VALUES (?,?,?,?,?,?,?,?,?,?,NULL,datetime('now'))")
        .run(randomUUID(), run.job_id, run.step_index, run.agent_id, version, run.input_hash, content, id, JSON.stringify(context.upstream.map(a => ({ id: a.id, version: a.version }))), JSON.stringify({ name: agent.name, instructions: agent.instructions, deliverable: agent.deliverable, allowMaterial: !!agent.allow_material, allowUpstream: !!agent.allow_upstream, revision: agent.revision }));
      database.prepare("UPDATE agent_jobs SET status=?,updated_at=datetime('now') WHERE id=?").run(nextStep(current) < 0 ? "ready" : "waiting", run.job_id);
    } else database.prepare("UPDATE agent_jobs SET status=?,updated_at=datetime('now') WHERE id=?").run(status, run.job_id);
    return status === "success";
  }).immediate();
}
export function cancelActiveRun(runId: string, reason: "user" | "profile" = "user") {
  const run = db().prepare("SELECT * FROM agent_runs WHERE id=?").get(runId) as AgentRun | undefined;
  if (!run || run.status !== "running") throw new PublicError("运行已结束", 409);
  finishRun(runId, "cancelled", null, reason === "user" ? "用户取消；已发出的请求可能仍被计费" : "Agent 配置已变化，运行已取消；请手动继续");
  return run.job_id;
}
export function inputFor(jobRow: AgentJob, index: number) {
  const step = stepsOf(jobRow)[index];
  if (!step) throw new PublicError("执行步骤不存在", 404);
  const agent = profile(step.agentId)!;
  if (step.source && !agent.allow_upstream) throw new PublicError("此 Agent 已无权读取接续来源，请重新选择或调整权限", 409);
  if (step.source && !fixedSource(jobRow)) throw new PublicError("接续来源已失效，请重新选择", 409);
  const computed = stepInput(jobRow, index);
  if (!computed) throw new PublicError("上游成果尚未准备", 409);
  return {
    inputHash: computed.hash,
    context: {
      jobId: jobRow.id, jobRevision: jobRow.revision, request: jobRow.request,
      material: agent.allow_material ? jobRow.material : null,
      corrections: agent.allow_material ? correctionsFor(jobRow.id).map(c => ({ id: c.id, text: c.text, revision: c.revision })) : [],
      preferences: activePreferences(agent.id).map(p => ({ id: p.id, text: p.text })),
      upstream: computed.upstream.map(a => ({ id: a.id, version: a.version, content: a.content, stepIndex: a.step_index })),
      agentId: agent.id, agentRevision: agent.revision,
      agentName: agent.name, instructions: agent.instructions, deliverable: agent.deliverable,
      allowMaterial: !!agent.allow_material, allowUpstream: !!agent.allow_upstream,
    },
  };
}
