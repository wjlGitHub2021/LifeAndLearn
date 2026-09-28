import test from "node:test";
import assert from "node:assert/strict";
import { beginGeneration, connect, DeepSeekError, disconnect, generate } from "../src/lib/deepseek.ts";
import { beginRunStream, finishRunStream, publishRunEvent, subscribeRunStream } from "../src/lib/run-stream.ts";
import { GET } from "../src/app/api/run-stream/route.ts";

const models = new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }] }));
const frame = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const done = "data: [DONE]\r\n\r\n";
const streamed = (chunks) => new Response(new ReadableStream({
  start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
}), { headers: { "Content-Type": "text/event-stream" } });

test("模型 SSE 增量区分实际 reasoning 和 JSON 正文，兼容 UTF-8 与跨包分帧", async () => {
  disconnect();
  await connect("synthetic-only", async () => models.clone());
  try {
    const bytes = new TextEncoder().encode(
      frame({ choices: [{ index: 0, delta: { reasoning_content: "思考中" } }] }) +
      frame({ choices: [{ index: 0, delta: { content: '{"text":"你好"}' } }] }) +
      frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + done,
    );
    const updates = [];
    const result = await generate(beginGeneration(), [{ role: "user", content: "模拟" }], async (_url, options) => {
      assert.equal(JSON.parse(options.body).stream, true);
      assert.deepEqual(JSON.parse(options.body).thinking, { type: "enabled" });
      assert.equal(JSON.parse(options.body).reasoning_effort, "low");
      assert.equal(JSON.parse(options.body).max_tokens, 4096);
      return streamed([bytes.slice(0, 9), bytes.slice(9, 32), bytes.slice(32, 73), bytes.slice(73)]);
    }, 700, delta => updates.push(delta));
    assert.equal(result, '{"text":"你好"}');
    assert.deepEqual(updates, [{ kind: "reasoning", text: "思考中" }, { kind: "content", text: '{"text":"你好"}' }]);
  } finally { disconnect(); }
});

test("流缺少结束标记、截断及供应商错误均不返回部分成果", async () => {
  disconnect();
  await connect("synthetic-only", async () => models.clone());
  try {
    const cases = [
      frame({ choices: [{ index: 0, delta: { content: "partial" } }] }),
      frame({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "length" }] }) + done,
      frame({ error: { message: "secret upstream detail" } }) + done,
    ];
    for (const body of cases) {
      await assert.rejects(generate(beginGeneration(), [{ role: "user", content: "模拟" }], async () => streamed([new TextEncoder().encode(body)]), 700, () => {}), error => error instanceof DeepSeekError && ["format", "service"].includes(error.code) && !error.message.includes("secret"));
    }
  } finally { disconnect(); }
});

test("流式请求断连后结束，不保存迟到内容", async () => {
  disconnect();
  await connect("synthetic-only", async () => models.clone());
  const slot = beginGeneration();
  const pending = generate(slot, [{ role: "user", content: "模拟" }], async () => new Promise(() => {}), 700, () => {});
  disconnect();
  await assert.rejects(pending, error => error instanceof DeepSeekError && error.code === "stale");
});

test("流式思考预览有上限，长思考仍可得到完整 JSON 结果", async () => {
  disconnect();
  await connect("synthetic-only", async () => models.clone());
  try {
    const body = frame({ choices: [{ index: 0, delta: { reasoning_content: "想".repeat(14000) } }] }) +
      frame({ choices: [{ index: 0, delta: { content: '{"ok":true}' }, finish_reason: "stop" }] }) + done;
    const updates = [];
    const result = await generate(beginGeneration(), [{ role: "user", content: "模拟" }], async () => streamed([new TextEncoder().encode(body)]), 700, update => updates.push(update));
    assert.equal(result, '{"ok":true}');
    assert.equal(updates.filter(update => update.kind === "reasoning").reduce((sum, update) => sum + update.text.length, 0), 12000);
  } finally { disconnect(); }
});

test("DeepSeek 流式思考有独立硬超时", async () => {
  disconnect();
  await connect("synthetic-only", async () => models.clone());
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => original(callback, delay === 120000 ? 1 : delay, ...args);
  try {
    await assert.rejects(generate(beginGeneration(), [{ role: "user", content: "模拟" }], async () => new Promise(() => {}), 700, () => {}), error => error instanceof DeepSeekError && error.code === "timeout");
  } finally { globalThis.setTimeout = original; disconnect(); }
});

test("读取模型流期间断连会取消读流并拒绝部分结果", async () => {
  disconnect();
  await connect("synthetic-only", async () => models.clone());
  let offered;
  const ready = new Promise(resolve => { offered = resolve; });
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ choices: [{ index: 0, delta: { content: "partial" } }] })));
      offered();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
  const pending = generate(beginGeneration(), [{ role: "user", content: "模拟" }], async () => response, 700, () => {});
  await ready;
  disconnect();
  await assert.rejects(pending, error => error instanceof DeepSeekError && error.code === "stale");
});

test("超大模型帧被拒绝，避免无限缓冲", async () => {
  disconnect();
  await connect("synthetic-only", async () => models.clone());
  try {
    const enormous = new TextEncoder().encode(`data: ${"x".repeat(70000)}\n\n`);
    await assert.rejects(generate(beginGeneration(), [{ role: "user", content: "模拟" }], async () => streamed([enormous]), 700, () => {}), error => error instanceof DeepSeekError && error.code === "format");
  } finally { disconnect(); }
});

test("本机运行事件提供快照、增量、完成与重放，终止后不再接收增量", async () => {
  const runId = "synthetic-run-1";
  beginRunStream(runId);
  assert.equal(publishRunEvent(runId, "content", "第一段"), true);
  const first = subscribeRunStream(runId).getReader();
  const snapshot = await first.read();
  assert.deepEqual([snapshot.value.kind, snapshot.value.content, snapshot.value.seq], ["snapshot", "第一段", 1]);
  assert.equal(publishRunEvent(runId, "reasoning", "供应商真实返回"), true);
  const next = await first.read();
  assert.deepEqual([next.value.kind, next.value.text, next.value.seq], ["reasoning", "供应商真实返回", 2]);
  assert.equal(finishRunStream(runId, "done"), true);
  assert.equal((await first.read()).value.kind, "done");
  assert.equal((await first.read()).done, true);
  assert.equal(publishRunEvent(runId, "content", "迟到"), false);
  const replay = subscribeRunStream(runId, 1).getReader();
  assert.equal((await replay.read()).value.kind, "reasoning");
  assert.equal((await replay.read()).value.kind, "done");
  assert.equal((await replay.read()).done, true);
});

test("SSE 路由仅限本机，序号与事件可被客户端消费", async () => {
  const runId = "synthetic-run-2";
  beginRunStream(runId);
  publishRunEvent(runId, "progress", "正在处理");
  finishRunStream(runId, "done");
  const request = new Request(`http://127.0.0.1:3211/api/run-stream?runId=${runId}`, { headers: { host: "127.0.0.1:3211" } });
  const response = GET(request);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const body = await response.text();
  assert.match(body, /"kind":"snapshot"/);
  assert.match(body, /"status":"done"/);
  const denied = GET(new Request(`http://evil.test/api/run-stream?runId=${runId}`, { headers: { host: "evil.test" } }));
  assert.equal(denied.status, 403);
});
