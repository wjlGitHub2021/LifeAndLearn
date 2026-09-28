import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.AGENT_DB_PATH = join(mkdtempSync(join(tmpdir(), "agent-memory-limit-")), "agents.sqlite");
const store = await import("../src/lib/store.ts");

test("预览和运行读取同一批兼容记忆，先过滤再限制数量", () => {
  const goalId = store.createGoal("english", "英语表达", "", 3);
  for (let index = 0; index < 6; index++) {
    store.acceptProposal(store.propose((index + 1) * 10));
    const task = store.state().tasks.find(item => item.goal_id === goalId && item.status === "waiting");
    const runId = store.createRun(task.id, "english", "limit-" + index, "A sample answer.", "mock-model", []);
    const suggestion = index === 0 ? "练习口头回答结构" : "写一篇100字作文";
    store.completeRun(runId, task.id, "success", "反馈", null, suggestion);
    store.finishTask(task.id);
    store.saveMemory(goalId, "english", runId, suggestion, "accepted");
  }
  store.updateGoal(goalId, "英语口语", "只练口语，不进行写作，允许提交文字转写", 3);
  const proposal = store.propose(70);
  assert.match(proposal.items[0].prompt, /练习口头回答结构/);
  assert.deepEqual(store.getMemories(goalId, "english").map(memory => memory.text), ["练习口头回答结构"]);
});
