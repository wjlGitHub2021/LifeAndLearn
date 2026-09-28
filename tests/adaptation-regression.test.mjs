import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.AGENT_DB_PATH = join(mkdtempSync(join(tmpdir(), "agent-adaptation-regression-")), "agents.sqlite");
const store = await import("../src/lib/store.ts");
const connection = await import("../src/app/api/connection/route.ts");
const runRoute = await import("../src/app/api/run/route.ts");
const base = "http://127.0.0.1:3000";
async function post(handler, path, body) {
  const request = new Request(base + path, { method: "POST", headers: { host: "127.0.0.1:3000", origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await handler.POST(request);
  return { status: response.status, body: await response.json() };
}
function nextBudget(extra = 30) {
  const locked = store.state().tasks.filter(task => task.plan_date === store.localDate() && ["running", "feedback", "done"].includes(task.status)).reduce((total, task) => total + task.minutes, 0);
  return locked + extra;
}
function completeExercise(goalId, submissionId, suggestion) {
  store.acceptProposal(store.propose(nextBudget()));
  const task = store.state().tasks.find(item => item.goal_id === goalId && item.status === "waiting");
  assert.ok(task);
  const runId = store.createRun(task.id, "english", submissionId, "A sample answer.", "mock-model", []);
  assert.ok(runId);
  store.completeRun(runId, task.id, "success", "模拟反馈", null, suggestion);
  store.finishTask(task.id);
  return store.saveMemory(goalId, "english", runId, suggestion, "accepted");
}

test("写作目标中的口语否定不触发口语题型或纯语音限制", () => {
  const goalId = store.createGoal("english", "英语写作", "不要练口语，只练作文；不接受文字转写", 3);
  const proposal = store.propose(30);
  const item = proposal.items.find(item => item.goalId === goalId);
  assert.ok(item);
  assert.match(item.title, /英语写作练习/);
  assert.match(item.prompt, /写一篇结构完整的英语作文/);
  assert.doesNotMatch(item.prompt, /口头回答约|把刚才的回答转写/);
  assert.equal(proposal.issues.length, 0);
  store.setGoalActive(goalId, false);
});

test("拒绝纯语音输入仍保留口语转写任务", () => {
  const goalId = store.createGoal("english", "英语口语", "只练口语，允许文字转写，不接受纯语音", 3);
  const proposal = store.propose(30);
  const item = proposal.items.find(item => item.goalId === goalId);
  assert.ok(item);
  assert.match(item.prompt, /口头回答约/);
  assert.match(item.prompt, /把刚才的回答转写/);
  assert.equal(proposal.issues.length, 0);
  store.setGoalActive(goalId, false);
});

test("后置暂停写作约束同时过滤旧作文记忆与题型", () => {
  const goalId = store.createGoal("english", "英语写作", "练习作文", 3);
  completeExercise(goalId, "regression-old-writing", "继续练习作文");
  store.updateAgent("english", true, "多写一篇作文");
  store.updateGoal(goalId, "英语口语", "只练口语，写作暂停，允许文字转写", 3);
  const proposal = store.propose(nextBudget());
  const item = proposal.items.find(item => item.goalId === goalId);
  assert.ok(item);
  assert.match(item.prompt, /口头回答约/);
  assert.doesNotMatch(item.prompt, /继续练习作文|多写一篇作文/);
  assert.deepEqual(store.getMemories(goalId, "english"), []);
  assert.equal(store.getPreferenceForGoal(goalId, "english"), "");
  store.setGoalActive(goalId, false);
  store.updateAgent("english", true, "");
});

test("已采用并纠正的日记建议不会作为尚未采用的建议回流口语任务", () => {
  const goalId = store.createGoal("english", "英语写作", "练习作文", 3);
  const original = "下次可以写5句昨天做了什么的英语日记";
  const memoryId = completeExercise(goalId, "diary-accepted", original);
  const sourceRunId = store.state().memories.find(memory => memory.id === memoryId).source_run_id;
  store.correctMemory(memoryId, "继续练习作文，重点检查过去式");
  store.updateGoal(goalId, "英语口语", "只练口语，写作暂停，允许文字转写", 3);
  const item = store.propose(nextBudget()).items.find(item => item.goalId === goalId);
  assert.ok(item);
  assert.match(item.prompt, /口头回答约/);
  assert.doesNotMatch(item.prompt, /英语日记|尚未被你采用|继续练习作文/);
  assert.equal(store.getMemories(goalId, "english").length, 0);
  assert.equal(store.getRun(sourceRunId).status, "success");
  store.setGoalActive(goalId, false);
});

test("真正未采用的兼容建议仍参与安排，写日记建议在口语方向被过滤", () => {
  const goalId = store.createGoal("english", "英语表达", "", 3);
  store.acceptProposal(store.propose(nextBudget()));
  const task = store.state().tasks.find(item => item.goal_id === goalId && item.status === "waiting");
  const runId = store.createRun(task.id, "english", "unaccepted-diary", "A sample answer.", "mock-model", []);
  store.completeRun(runId, task.id, "success", "模拟反馈", null, "下次可以写5句昨天做了什么的英语日记");
  store.finishTask(task.id);
  assert.match(store.propose(nextBudget()).items.find(item => item.goalId === goalId).prompt, /尚未被你采用/);
  store.updateGoal(goalId, "英语口语", "只练口语，写作暂停，允许文字转写", 3);
  const oral = store.propose(nextBudget()).items.find(item => item.goalId === goalId);
  assert.ok(oral);
  assert.doesNotMatch(oral.prompt, /英语日记|尚未被你采用/);
  store.setGoalActive(goalId, false);
});

test("纠正前六条之外的记忆进入预览及模型上下文，后续采用仍能更新重点", async () => {
  const goalId = store.createGoal("english", "英语表达", "", 3);
  const ids = [];
  for (let index = 1; index <= 6; index++) ids.push(completeExercise(goalId, `regression-${index}`, `练习重点${index}`));
  assert.deepEqual(store.getMemories(goalId, "english").map(memory => memory.text), [6, 5, 4, 3, 2].map(index => `练习重点${index}`));
  const before = store.propose(nextBudget());
  assert.equal(store.correctMemory(ids[0], "以后只练习新的重点，不再练习旧重点"), 1);
  const after = store.propose(nextBudget());
  assert.notEqual(after.token, before.token);
  assert.match(after.items[0].prompt, /以后只练习新的重点/);
  assert.equal(store.getMemories(goalId, "english")[0].id, ids[0]);

  store.acceptProposal(after);
  const task = store.state().tasks.find(item => item.goal_id === goalId && item.status === "waiting");
  const originalFetch = globalThis.fetch;
  let sentContext;
  globalThis.fetch = async (url, options) => {
    if (url === "https://api.deepseek.com/models") return new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }] }), { status: 200 });
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    sentContext = JSON.parse(JSON.parse(options.body).messages[1].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ evidence: "A sample", feedback: "模拟反馈", nextSuggestion: "继续练习新的重点" }) } }] }), { status: 200 });
  };
  try {
    assert.equal((await post(connection, "/api/connection", { type: "connect", key: "mock-key-not-real" })).status, 200);
    const submitted = await post(runRoute, "/api/run", { type: "submit", taskId: task.id, answer: "A sample answer.", submissionId: "regression-context" });
    assert.equal(submitted.status, 202);
    for (let i = 0; i < 100 && store.getRun(submitted.body.runId).status === "running"; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(store.getRun(submitted.body.runId).status, "success");
    assert.equal(sentContext.relatedMemories[0].text, "以后只练习新的重点，不再练习旧重点");
    assert.equal(sentContext.relatedMemories.length, 5);
    assert.equal(JSON.parse(store.getRun(submitted.body.runId).context_refs)[0].id, ids[0]);
  } finally {
    globalThis.fetch = originalFetch;
    await post(connection, "/api/connection", { type: "disconnect" });
  }

  const token = store.propose(nextBudget(40)).token;
  assert.equal(store.correctMemory(ids[0], "再次纠正为最新重点"), 1);
  assert.notEqual(store.propose(nextBudget(40)).token, token);
  assert.equal(store.correctMemory(ids[1], "稍后纠正的重点"), 1);
  assert.equal(store.getMemories(goalId, "english")[0].id, ids[1]);
  assert.equal(store.correctMemory(ids[0], "最后纠正的重点"), 1);
  assert.equal(store.getMemories(goalId, "english")[0].id, ids[0]);
  const repeatedToken = store.propose(nextBudget(40)).token;
  assert.equal(store.correctMemory(ids[0], "最后纠正的重点"), 1);
  assert.notEqual(store.propose(nextBudget(40)).token, repeatedToken);
  store.setGoalActive(goalId, false);
});

test("两条记忆中纠正旧条成为下一题核心", () => {
  const goalId = store.createGoal("english", "英语表达", "", 3);
  const oldId = completeExercise(goalId, "two-old", "旧训练重点");
  completeExercise(goalId, "two-new", "新训练重点");
  assert.match(store.propose(nextBudget()).items[0].prompt, /新训练重点/);
  store.correctMemory(oldId, "纠正后的训练重点");
  assert.match(store.propose(nextBudget()).items[0].prompt, /纠正后的训练重点/);
  const laterId = completeExercise(goalId, "two-later", "后来采用的训练重点");
  assert.equal(store.getMemories(goalId, "english")[0].id, laterId);
  assert.equal(store.getMemories(goalId, "english")[0].status, "accepted");
  assert.match(store.propose(nextBudget()).items[0].prompt, /后来采用的训练重点/);
});
