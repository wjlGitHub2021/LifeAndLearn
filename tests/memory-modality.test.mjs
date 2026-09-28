import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.AGENT_DB_PATH = join(mkdtempSync(join(tmpdir(), "agent-memory-mode-")), "agents.sqlite");
const store = await import("../src/lib/store.ts");
const connection = await import("../src/app/api/connection/route.ts");
const runRoute = await import("../src/app/api/run/route.ts");
const base = "http://127.0.0.1:3000";
async function post(handler, path, body) {
  const request = new Request(base + path, { method: "POST", headers: { host: "127.0.0.1:3000", origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await handler.POST(request);
  return { status: response.status, body: await response.json() };
}

test("目标改为口语后，旧作文记忆和偏好不再驱动任务或反馈", async () => {
  const goalId = store.createGoal("english", "英语写作", "", 3);
  store.acceptProposal(store.propose(30));
  const task = store.state().tasks.find(item => item.goal_id === goalId);
  const runId = store.createRun(task.id, "english", "memory-mode-1", "A short essay.", "mock-model", []);
  store.completeRun(runId, task.id, "success", "针对上次作文的反馈", null, "写一篇100字作文");
  store.finishTask(task.id);

  const history = store.propose(60);
  assert.match(history.items[0].prompt, /写一篇100字作文/);
  const memoryId = store.saveMemory(goalId, "english", runId, "写一篇100字作文", "accepted");
  store.updateAgent("english", true, "重点练习100字作文");
  store.updateGoal(goalId, "英语口语", "只练口语，不进行写作，允许提交文字转写", 3);

  const spoken = store.propose(60);
  assert.equal(spoken.issues.length, 0);
  assert.match(spoken.items[0].prompt, /口头回答/);
  assert.match(spoken.items[0].prompt, /转写/);
  assert.doesNotMatch(spoken.items[0].prompt, /作文/);
  assert.deepEqual(store.getMemories(goalId, "english"), []);
  assert.equal(store.getPreferenceForGoal(goalId, "english"), "");

  store.acceptProposal(spoken);
  const spokenTask = store.state().tasks.find(item => item.goal_id === goalId && item.status === "waiting");
  const nativeFetch = globalThis.fetch;
  let sentContext;
  globalThis.fetch = async (url, options) => {
    if (url === "https://api.deepseek.com/models") return new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }] }), { status: 200 });
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    sentContext = JSON.parse(JSON.parse(options.body).messages[1].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ evidence: sentContext.answer.slice(0, 8), feedback: "按口语转写给出反馈", nextSuggestion: "练习口头表达结构" }) } }] }), { status: 200 });
  };
  try {
    assert.equal((await post(connection, "/api/connection", { type: "connect", key: "mock-key-not-real" })).status, 200);
    const submitted = await post(runRoute, "/api/run", { type: "submit", taskId: spokenTask.id, answer: "I spoke about a project.", submissionId: "spoken-mode" });
    assert.equal(submitted.status, 202);
    for (let i = 0; i < 100 && store.getRun(submitted.body.runId).status === "running"; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(store.getRun(submitted.body.runId).status, "success");
    assert.equal(sentContext.preference, "");
    assert.deepEqual(sentContext.relatedMemories, []);
  } finally {
    globalThis.fetch = nativeFetch;
    await post(connection, "/api/connection", { type: "disconnect" });
  }

  store.correctMemory(memoryId, "练习口头回答结构");
  const corrected = store.propose(90);
  assert.match(corrected.items[0].prompt, /练习口头回答结构/);
  assert.doesNotMatch(corrected.items[0].prompt, /作文/);
  assert.equal(store.getMemories(goalId, "english").length, 1);
});
