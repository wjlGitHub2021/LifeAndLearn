import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

process.env.AGENT_DB_PATH = join(mkdtempSync(join(tmpdir(), "agent-run-race-")), "agents.sqlite");
const store = await import("../src/lib/store.ts");
const moduleUrl = new URL("../src/lib/store.ts", import.meta.url).href;

function contender(taskId, submissionId) {
  const script = `
    const s = await import(${JSON.stringify(moduleUrl)});
    if (s.getTask(${JSON.stringify(taskId)})?.status !== 'waiting') process.exit(2);
    process.stdout.write('READY\\n');
    await new Promise(resolve => process.stdin.once('data', resolve));
    const runId = s.createRun(${JSON.stringify(taskId)}, 'english', ${JSON.stringify(submissionId)}, 'valid answer', 'mock-model', []);
    process.stdout.write(JSON.stringify({runId}) + '\\n');
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: { ...process.env, AGENT_DB_PATH: process.env.AGENT_DB_PATH } });
  let output = "";
  let stderr = "";
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const done = new Promise((resolve, reject) => {
    child.stdout.on("data", chunk => { output += chunk.toString(); if (output.includes("READY\n")) readyResolve(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => { readyReject(error); reject(error); });
    child.on("exit", code => {
      if (!output.includes("READY\n")) readyReject(new Error(`child exited before barrier: ${stderr}`));
      if (code !== 0) reject(new Error(`child ${code}: ${stderr}`));
      else resolve(JSON.parse(output.trim().split("\n").at(-1)));
    });
  });
  return { ready, done, start: () => child.stdin.end("go\n") };
}

test("两个进程先读到等待作答时，只有一个能原子占用任务", async () => {
  const goalId = store.createGoal("english", "并发提交检查", "", 3);
  store.acceptProposal(store.propose(30));
  const task = store.state().tasks.find(item => item.goal_id === goalId);
  const processes = [contender(task.id, "concurrent-a"), contender(task.id, "concurrent-b")];
  await Promise.all(processes.map(process => process.ready));
  processes.forEach(process => process.start());
  const results = await Promise.all(processes.map(process => process.done));
  assert.equal(results.filter(result => result.runId).length, 1);
  assert.equal(store.state().runs.filter(run => run.task_id === task.id).length, 1);
  assert.equal(store.getTask(task.id).status, "interrupted", "退出进程的唯一运行应被回收");
  assert.equal(store.getTask(task.id).draft, "valid answer");
});
