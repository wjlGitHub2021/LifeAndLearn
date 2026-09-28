import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

const folder = mkdtempSync(join(tmpdir(), "agent-migrate-test-"));
const path = join(folder, "agents.sqlite");
const old = new Database(path);
old.exec(`
CREATE TABLE tasks (id TEXT PRIMARY KEY, goal_id TEXT, agent_id TEXT, title TEXT, prompt TEXT, minutes INTEGER, status TEXT, rationale TEXT, draft TEXT, feedback TEXT, suggestion TEXT, created_at TEXT);
CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT, agent_id TEXT, submission_id TEXT, status TEXT, input TEXT, output TEXT, model TEXT, error TEXT, created_at TEXT, finished_at TEXT);
INSERT INTO tasks VALUES ('old-task','g','english','old','old',10,'waiting','old','saved draft',NULL,NULL,'2026-09-26 01:00:00');
`);
old.close();
const moduleUrl = new URL("../src/lib/store.ts", import.meta.url).href;
function openInChild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const s=await import('${moduleUrl}'); const t=s.state().tasks.find(t=>t.id==='old-task'); if(!t?.plan_date || t.draft!=='saved draft') process.exit(2);`], { env: { ...process.env, AGENT_DB_PATH: path } });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`child ${code}: ${stderr}`)));
  });
}
test("旧库并发迁移只加列一次且先产生备份", async () => {
  await Promise.all([openInChild(), openInChild()]);
  const db = new Database(path);
  try {
    const columns = db.pragma("table_info(tasks)").map(c => c.name);
    const runColumns = db.pragma("table_info(runs)").map(c => c.name);
    const memoryColumns = db.pragma("table_info(memories)").map(c => c.name);
    assert.equal(columns.filter(c => c === "plan_date").length, 1);
    assert.ok(runColumns.includes("context_refs") && runColumns.includes("owner_pid"));
    assert.ok(memoryColumns.includes("effective_order"));
    assert.ok(db.prepare("SELECT plan_date FROM tasks WHERE id='old-task'").get().plan_date);
    assert.ok(readdirSync(folder).some(name => name.startsWith("agents.sqlite.backup-")));
  } finally { db.close(); }
});

test("同进程复用旧连接时迁移记忆排序列并保留历史", () => {
  const cachedPath = join(mkdtempSync(join(tmpdir(), "agent-cached-migrate-")), "agents.sqlite");
  const script = `
    const s = await import('${moduleUrl}');
    const goalId = s.createGoal('english', '英语表达', '', 3);
    s.acceptProposal(s.propose(30));
    const task = s.state().tasks.find(item => item.goal_id === goalId);
    const runId = s.createRun(task.id, 'english', 'cached-migration', 'An answer.', 'mock-model', []);
    s.completeRun(runId, task.id, 'success', '反馈', null, '原建议');
    const memoryId = s.saveMemory(goalId, 'english', runId, '原建议', 'accepted');
    globalThis.__agentDb.exec('ALTER TABLE memories DROP COLUMN effective_order');
    globalThis.__agentDbSchemaVersion = undefined;
    const memories = s.getMemories(goalId, 'english');
    if (memories.length !== 1 || memories[0].id !== memoryId || memories[0].effective_order !== 0) process.exit(2);
    s.correctMemory(memoryId, '已纠正建议');
    if (s.getMemories(goalId, 'english')[0].text !== '已纠正建议') process.exit(3);
  `;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: { ...process.env, AGENT_DB_PATH: cachedPath }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(readdirSync(join(cachedPath, "..")).some(name => name.startsWith("agents.sqlite.backup-")));
});

test("已打开数据库的进程识别另一已退出进程留下的运行", async () => {
  process.env.AGENT_DB_PATH = path;
  const store = await import("../src/lib/store.ts");
  store.state();
  const script = `const s=await import('${moduleUrl}'); s.createGoal('english','跨进程恢复','',3); const p=s.propose(30); s.acceptProposal(p); const task=s.state().tasks.find(t=>t.status==='waiting'); s.createRun(task.id,'english','cross-process','saved input','deepseek-flash',[]);`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: { ...process.env, AGENT_DB_PATH: path }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const snapshot = store.state();
  const run = snapshot.runs.find(item => item.submission_id === "cross-process");
  assert.equal(run.status, "interrupted");
  assert.equal(run.input, "saved input");
  assert.equal(snapshot.tasks.find(item => item.id === run.task_id).status, "interrupted");
});
