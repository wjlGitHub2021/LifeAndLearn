import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.AGENT_DB_PATH = join(mkdtempSync(join(tmpdir(), "agent-feedback-run-")), "agents.sqlite");
const store = await import("../src/lib/store.ts");
const connection = await import("../src/app/api/connection/route.ts");
const runRoute = await import("../src/app/api/run/route.ts");
const base = "http://127.0.0.1:3000";
async function post(handler, path, body) {
  const request = new Request(base + path, { method: "POST", headers: { host: "127.0.0.1:3000", origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await handler.POST(request);
  return { status: response.status, body: await response.json() };
}
async function settled(runId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = store.getRun(runId);
    if (run.status !== "running") return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("等待模拟运行结束超时");
}

test("无效引用留安全诊断并允许用户手动重试，成功引用仍来自本次作答", async () => {
  const goalId = store.createGoal("english", "英语表达", "练习清晰表达", 3);
  store.acceptProposal(store.propose(30));
  const task = store.state().tasks.find(item => item.goal_id === goalId);
  const answer = "I went home yesterday.";
  let generations = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === "https://api.deepseek.com/models") return new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }] }), { status: 200 });
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    generations++;
    const context = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.equal(context.answer, answer);
    const content = generations === 1
      ? { evidenceId: "private-invalid-id", feedback: "PRIVATE MODEL RESPONSE", nextSuggestion: "再练" }
      : { evidenceId: context.evidenceCandidates[0].id, feedback: "过去式表达清楚。", nextSuggestion: "继续练习过去式" };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
  };
  try {
    assert.equal((await post(connection, "/api/connection", { type: "connect", key: "mock-key-not-real" })).status, 200);
    const first = await post(runRoute, "/api/run", { type: "submit", taskId: task.id, answer, submissionId: "feedback-fail" });
    assert.equal(first.status, 202);
    const failed = await settled(first.body.runId);
    assert.equal(failed.status, "failed");
    assert.equal(store.getTask(task.id).status, "failed");
    assert.equal(failed.input, answer);
    assert.match(failed.error, /feedback\.unknown_evidence_id/);
    assert.doesNotMatch(failed.error, /PRIVATE|private-invalid-id|I went/);
    assert.equal(generations, 1);
    const second = await post(runRoute, "/api/run", { type: "submit", taskId: task.id, answer, submissionId: "feedback-retry" });
    assert.equal(second.status, 202);
    const success = await settled(second.body.runId);
    assert.equal(success.status, "success");
    assert.equal(generations, 2);
    assert.match(store.getTask(task.id).feedback, /I went home yesterday\./);
  } finally {
    globalThis.fetch = originalFetch;
    await post(connection, "/api/connection", { type: "disconnect" });
  }
});
