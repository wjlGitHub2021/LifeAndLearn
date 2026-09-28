import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.AGENT_DB_PATH = join(mkdtempSync(join(tmpdir(), "agent-api-test-")), "agents.sqlite");
const action = await import("../src/app/api/action/route.ts");
const connection = await import("../src/app/api/connection/route.ts");
const run = await import("../src/app/api/run/route.ts");
const stateRoute = await import("../src/app/api/state/route.ts");
const base = "http://127.0.0.1:3000";
function request(path, body) { return new Request(`${base}${path}`, { method: "POST", headers: { host: "127.0.0.1:3000", origin: base, "content-type": "application/json" }, body: JSON.stringify(body) }); }
async function post(handler, path, body) { const response = await handler.POST(request(path, body)); return { status: response.status, body: await response.json() }; }
async function current() { return (await stateRoute.GET(new Request(`${base}/api/state`, { headers: { host: "127.0.0.1:3000" } }))).json(); }
async function until(check) { for (let i = 0; i < 100; i++) { const value = await current(); if (check(value)) return value; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("等待运行结束超时"); }

test("API 模拟闭环：作答、反馈、记忆纠正及下一次引用", async () => {
  assert.equal((await current()).agents.length, 3);
  const goal = await post(action, "/api/action", { type: "goal.create", domain: "english", title: "英语表达", detail: "练习完成时", priority: 3 });
  assert.equal(goal.status, 200);
  const proposal = (await post(action, "/api/action", { type: "plan.preview", budget: 30 })).body.proposal;
  const accepted = await post(action, "/api/action", { type: "plan.accept", budget: 30, token: proposal.token });
  assert.equal(accepted.status, 200);
  const firstTask = accepted.body.state.tasks[0];
  let releaseGeneration;
  let seenMemory = [];
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === "https://api.deepseek.com/models") return new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }] }), { status: 200 });
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    const payload = JSON.parse(options.body);
    const input = JSON.parse(payload.messages[1].content);
    seenMemory = input.relatedMemories;
    const reply = new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ evidence: input.answer.slice(0, 8), feedback: `针对 ${input.answer} 的反馈`, nextSuggestion: "练习现在完成时" }) } }] }), { status: 200 });
    if (!releaseGeneration) return new Promise(resolve => { releaseGeneration = () => resolve(reply); });
    return reply;
  };
  try {
    const connected = await post(connection, "/api/connection", { type: "connect", key: "mock-key-not-real" });
    assert.equal(connected.status, 200);
    const submit = await post(run, "/api/run", { type: "submit", taskId: firstTask.id, answer: "I have went there.", submissionId: "first" });
    assert.equal(submit.status, 202);
    assert.equal(submit.body.state.runs[0].status, "running");
    const storeAgain = await import("../src/lib/store.ts?second-module-copy=1");
    assert.equal(storeAgain.getRun(submit.body.runId).status, "running");
    releaseGeneration();
    const finished = await until(s => s.runs[0].status === "success");
    assert.equal(finished.tasks.find(t => t.id === firstTask.id).status, "feedback");
    assert.match(finished.tasks.find(t => t.id === firstTask.id).feedback, /I have we/);
    const badMemory = await post(action, "/api/action", { type: "memory.accept", taskId: firstTask.id, text: "无关伪造文本" });
    assert.equal(badMemory.status, 409);
    const adopted = await post(action, "/api/action", { type: "memory.accept", taskId: firstTask.id, text: "练习现在完成时" });
    assert.equal(adopted.status, 200);
    const memoryId = adopted.body.id;
    const corrected = await post(action, "/api/action", { type: "memory.correct", id: memoryId, text: "优先练习现在完成时的动词形式" });
    assert.equal(corrected.status, 200);
    const next = (await post(action, "/api/action", { type: "plan.preview", budget: 60 })).body.proposal;
    const nextPlan = await post(action, "/api/action", { type: "plan.accept", budget: 60, token: next.token });
    const secondTask = nextPlan.body.state.tasks.find(t => t.status === "waiting");
    assert.ok(secondTask);
    const second = await post(run, "/api/run", { type: "submit", taskId: secondTask.id, answer: "I have eaten breakfast.", submissionId: "second" });
    assert.equal(second.status, 202);
    await until(s => s.runs.some(r => r.id === second.body.runId && r.status === "success"));
    assert.equal(seenMemory[0].text, "优先练习现在完成时的动词形式");
    const secondRun = (await current()).runs.find(r => r.id === second.body.runId);
    assert.equal(JSON.parse(secondRun.context_refs)[0].text, "优先练习现在完成时的动词形式");
  } finally { globalThis.fetch = nativeFetch; await post(connection, "/api/connection", { type: "disconnect" }); }
});

test("不同来源的写操作被同源检查拒绝", async () => {
  const response = await action.POST(new Request(`${base}/api/action`, { method: "POST", headers: { host: "127.0.0.1:3000", origin: "https://example.com", "content-type": "application/json" }, body: JSON.stringify({ type: "goal.create" }) }));
  assert.equal(response.status, 403);
});

test("API 失败、幂等提交、取消与手动重试保留运行历史", async () => {
  const goal = await post(action, "/api/action", { type: "goal.create", domain: "career", title: "面试叙述", detail: "说明一次负责的项目", priority: 4 });
  assert.equal(goal.status, 200);
  const proposal = (await post(action, "/api/action", { type: "plan.preview", budget: 120 })).body.proposal;
  const accepted = await post(action, "/api/action", { type: "plan.accept", budget: 120, token: proposal.token });
  assert.equal(accepted.status, 200);
  const task = accepted.body.state.tasks.find(t => t.goal_id === goal.body.id && t.status === "waiting");
  assert.ok(task);
  const nativeFetch = globalThis.fetch;
  let generationCount = 0;
  let releaseLate;
  globalThis.fetch = async url => {
    if (url === "https://api.deepseek.com/models") return new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }] }), { status: 200 });
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    generationCount++;
    if (generationCount === 1) return new Response("unavailable", { status: 503 });
    const ok = new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ evidence: "我负责了", feedback: "针对我负责了项目的回答，请补充结果指标。", nextSuggestion: "下次补充量化结果" }) } }] }), { status: 200 });
    if (generationCount === 2) return new Promise(resolve => { releaseLate = () => resolve(ok); });
    return ok;
  };
  try {
    assert.equal((await post(connection, "/api/connection", { type: "connect", key: "mock-key-not-real" })).status, 200);
    for (const answer of ["abc", "你好啊", "😀😀😀"]) {
      const rejected = await post(run, "/api/run", { type: "submit", taskId: task.id, answer, submissionId: `too-short-${answer}` });
      assert.equal(rejected.status, 400);
      assert.match(rejected.body.error, /至少需要 4 个字符/);
    }
    assert.equal(generationCount, 0, "无效回答不能触发供应商调用");
    const answer = "我负责了一个团队项目。";
    const failed = await post(run, "/api/run", { type: "submit", taskId: task.id, answer, submissionId: "career-fail" });
    assert.equal(failed.status, 202);
    await until(s => s.runs.some(r => r.id === failed.body.runId && r.status === "failed"));
    const duplicate = await post(run, "/api/run", { type: "submit", taskId: task.id, answer, submissionId: "career-fail" });
    assert.equal(duplicate.body.runId, failed.body.runId);
    assert.equal(generationCount, 1);
    const pending = await post(run, "/api/run", { type: "submit", taskId: task.id, answer, submissionId: "career-cancel" });
    assert.equal(pending.status, 202);
    assert.equal((await post(run, "/api/run", { type: "cancel", runId: pending.body.runId })).status, 200);
    releaseLate();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await current()).runs.find(r => r.id === pending.body.runId).status, "cancelled");
    const retried = await post(run, "/api/run", { type: "submit", taskId: task.id, answer, submissionId: "career-success" });
    assert.equal(retried.status, 202);
    const finished = await until(s => s.runs.some(r => r.id === retried.body.runId && r.status === "success"));
    assert.equal(finished.tasks.find(t => t.id === task.id).status, "feedback");
    assert.equal(finished.runs.filter(r => r.task_id === task.id).length, 3);
  } finally {
    releaseLate?.();
    globalThis.fetch = nativeFetch;
    await post(connection, "/api/connection", { type: "disconnect" });
  }
});

test("模型生成返回 401 后凭据失效且要求重新连接", async () => {
  const goal = await post(action, "/api/action", { type: "goal.create", domain: "english", title: "鉴权失败检查", detail: "隔离测试", priority: 5 });
  assert.equal(goal.status, 200);
  const proposal = (await post(action, "/api/action", { type: "plan.preview", budget: 240 })).body.proposal;
  const accepted = await post(action, "/api/action", { type: "plan.accept", budget: 240, token: proposal.token });
  assert.equal(accepted.status, 200);
  const task = accepted.body.state.tasks.find(t => t.goal_id === goal.body.id && t.status === "waiting");
  assert.ok(task);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async url => url === "https://api.deepseek.com/models"
    ? new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }] }), { status: 200 })
    : new Response("unauthorized", { status: 401 });
  try {
    assert.equal((await post(connection, "/api/connection", { type: "connect", key: "mock-key-not-real" })).status, 200);
    const submitted = await post(run, "/api/run", { type: "submit", taskId: task.id, answer: "This is a test answer.", submissionId: "auth-failure" });
    assert.equal(submitted.status, 202);
    const failed = await until(s => s.runs.some(r => r.id === submitted.body.runId && r.status === "failed"));
    assert.match(failed.runs.find(r => r.id === submitted.body.runId).error, /重新连接/);
    const status = await (await connection.GET(new Request(`${base}/api/connection`, { headers: { host: "127.0.0.1:3000" } }))).json();
    assert.equal(status.connected, false);
    assert.equal(status.needsReconnect, true);
    assert.equal((await post(run, "/api/run", { type: "submit", taskId: task.id, answer: "This is a test answer.", submissionId: "auth-retry" })).status, 409);
  } finally {
    globalThis.fetch = nativeFetch;
    await post(connection, "/api/connection", { type: "disconnect" });
  }
});

test("断开连接后忽略 abort 的供应商不会让运行一直处理中", async () => {
  const goal = await post(action, "/api/action", { type: "goal.create", domain: "english", title: "取消等待检查", detail: "隔离测试", priority: 5 });
  const proposal = (await post(action, "/api/action", { type: "plan.preview", budget: 480 })).body.proposal;
  const accepted = await post(action, "/api/action", { type: "plan.accept", budget: 480, token: proposal.token });
  const task = accepted.body.state.tasks.find(t => t.goal_id === goal.body.id && t.status === "waiting");
  assert.ok(task);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async url => url === "https://api.deepseek.com/models"
    ? new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }] }), { status: 200 })
    : new Promise(() => {});
  try {
    assert.equal((await post(connection, "/api/connection", { type: "connect", key: "mock-key-not-real" })).status, 200);
    const submitted = await post(run, "/api/run", { type: "submit", taskId: task.id, answer: "This is a test answer.", submissionId: "disconnect-never" });
    assert.equal(submitted.status, 202);
    assert.equal((await post(connection, "/api/connection", { type: "disconnect" })).status, 200);
    const ended = await until(s => s.runs.some(r => r.id === submitted.body.runId && r.status === "failed"));
    assert.match(ended.runs.find(r => r.id === submitted.body.runId).error, /连接已变化/);
    assert.equal(ended.tasks.find(t => t.id === task.id).status, "failed");
  } finally { globalThis.fetch = nativeFetch; await post(connection, "/api/connection", { type: "disconnect" }); }
});
