import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.AGENT_DB_PATH = join(mkdtempSync(join(tmpdir(), "agent-store-test-")), "agents.sqlite");
const store = await import("../src/lib/store.ts");

test("持久层建立角色、安排、运行、反馈和可纠正记忆", () => {
  assert.equal(store.state().agents.length, 3);
  const goalId = store.createGoal("english", "English practice", "", 3);
  const proposal = store.propose(30);
  assert.equal(proposal.items.length, 1);
  assert.equal(proposal.items[0].minutes, 30);
  store.acceptProposal(proposal);
  const task = store.state().tasks.find(t => t.goal_id === goalId);
  assert.ok(task);
  const runId = store.createRun(task.id, "english", "submission-1", "I have went there.", "deepseek-flash", []);
  assert.equal(store.getRun(runId).status, "running");
  assert.equal(store.completeRun(runId, task.id, "success", "have went 应为 have gone", null, "练习完成时"), true);
  assert.equal(store.getTask(task.id).status, "feedback");
  const memoryId = store.saveMemory(goalId, "english", runId, "练习完成时", "accepted");
  assert.equal(store.saveMemory(goalId, "english", runId, "重复", "accepted"), memoryId);
  assert.equal(store.correctMemory(memoryId, "重点练习现在完成时"), 1);
  assert.deepEqual(store.getMemories(goalId, "english").map(m => m.text), ["重点练习现在完成时"]);
  assert.deepEqual(store.getMemories(goalId, "career"), []);
  store.finishTask(task.id);
  store.acceptProposal(store.propose(60));
  const nextTask = store.state().tasks.find(t => t.goal_id === goalId && t.status === "waiting");
  const second = store.createRun(nextTask.id, "english", "submission-2", "I have eaten.", "deepseek-flash", [{ id: memoryId, text: "练习完成时", source: runId }]);
  assert.equal(JSON.parse(store.getRun(second).context_refs)[0].text, "练习完成时");
});

test("极端优先级也不会生成负时长", () => {
  for (const [domain, priority] of [["english", 5], ["career", 1], ["english", 1]]) store.createGoal(domain, `Goal ${priority} ${domain}`, "", priority);
  const proposal = store.propose(40);
  assert.ok(proposal.items.every(item => item.minutes >= 10));
  assert.ok(proposal.items.reduce((n, item) => n + item.minutes, 0) <= 40);
});
