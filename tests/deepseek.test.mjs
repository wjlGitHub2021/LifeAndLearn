import test from "node:test";
import assert from "node:assert/strict";
import { beginGeneration, connect, connectionStatus, DeepSeekError, disconnect, generate } from "../src/lib/deepseek.ts";

const list = data => new Response(JSON.stringify({ data: data.map(id => ({ id })) }), { status: 200 });
test("连接只接受官方模型，状态不回传 Key", async () => {
  disconnect();
  const key = "test-key-not-real";
  const result = await connect(key, async (url, options) => {
    assert.equal(url, "https://api.deepseek.com/models");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    return new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }, { id: "deepseek-v4-pro" }, { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" }] }), { status: 200 });
  });
  assert.deepEqual(result.models, ["deepseek-v4-pro", "deepseek-flash"]);
  assert.equal(result.model, "deepseek-flash");
  assert.equal(result.modelNames["deepseek-flash"], "DeepSeek-V4.1-Flash");
  assert.equal(result.modelNames["deepseek-v4-pro"], "DeepSeek-V4-Pro");
  assert.equal(JSON.stringify(result).includes(key), false);
  disconnect();
});

test("替换失败保留原连接，并区分鉴权、余额、限流", async () => {
  disconnect();
  await connect("old-test-key", async () => list(["deepseek-flash"]));
  for (const [status, code] of [[401, "auth"], [402, "balance"], [429, "rate"]]) {
    await assert.rejects(connect("new-test-key", async () => new Response("secret upstream body", { status })), e => e instanceof DeepSeekError && e.code === code && !e.message.includes("secret"));
    assert.equal(connectionStatus().connected, true);
    assert.equal(connectionStatus().model, "deepseek-flash");
  }
  disconnect();
});

test("迟到验证不能覆盖较新连接或断开", async () => {
  disconnect();
  let release;
  const old = connect("old-test-key", async () => new Promise(resolve => { release = resolve; }));
  await connect("new-test-key", async () => list(["deepseek-v4-pro"]));
  release(list(["deepseek-flash"]));
  await assert.rejects(old, e => e.code === "stale");
  assert.deepEqual(connectionStatus().models, ["deepseek-v4-pro"]);
  const late = connect("third-test-key", async () => new Promise(resolve => { release = resolve; }));
  disconnect();
  release(list(["deepseek-flash"]));
  await assert.rejects(late, e => e.code === "stale");
  assert.equal(connectionStatus().connected, false);
});

test("供应商忽略取消时，旧连接验证仍立即结束", async () => {
  disconnect();
  const pending = connect("never-test-key", async () => new Promise(() => {}));
  await connect("replacement-test-key", async () => list(["deepseek-flash"]));
  await assert.rejects(pending, e => e.code === "stale");
  disconnect();
});

test("生成只能发往官方地址；断开后丢弃迟到响应", async () => {
  disconnect();
  await connect("run-test-key", async () => list(["deepseek-flash"]));
  const slot = beginGeneration();
  let release;
  const pending = generate(slot, [{ role: "user", content: "test" }], async (url, options) => {
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    assert.equal(options.redirect, "error");
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, "deepseek-flash");
    assert.deepEqual(payload.thinking, { type: "disabled" });
    assert.deepEqual(payload.response_format, { type: "json_object" });
    return new Promise(resolve => { release = resolve; });
  });
  disconnect();
  release(new Response(JSON.stringify({ choices: [{ message: { content: "late" } }] }), { status: 200 }));
  await assert.rejects(pending, e => e.code === "stale");
});

test("输出达到长度上限时保留可诊断原因，不把截断 JSON 当成果", async () => {
  disconnect();
  await connect("run-test-key", async () => list(["deepseek-flash"]));
  await assert.rejects(generate(beginGeneration(), [{ role: "user", content: "json" }], async () =>
    new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '{"content":"partial' } }] }), { status: 200 })), error =>
    error instanceof DeepSeekError && error.code === "format" && error.message.includes("长度上限"));
  disconnect();
});

test("供应商忽略取消时，断开立即结束本地生成等待", async () => {
  disconnect();
  await connect("run-test-key", async () => list(["deepseek-flash"]));
  const pending = generate(beginGeneration(), [{ role: "user", content: "test" }], async () => new Promise(() => {}));
  disconnect();
  await assert.rejects(pending, e => e.code === "stale");
});

test("旧 Key 的生成返回 401 不取消正在验证的新 Key", async () => {
  disconnect();
  await connect("old-test-key", async () => list(["deepseek-flash"]));
  let releaseGeneration;
  const oldGeneration = generate(beginGeneration(), [{ role: "user", content: "test" }], async () => new Promise(resolve => { releaseGeneration = resolve; }));
  let releaseValidation;
  const replacement = connect("new-test-key", async () => new Promise(resolve => { releaseValidation = resolve; }));
  releaseGeneration(new Response("", { status: 401 }));
  await assert.rejects(oldGeneration, e => e.code === "auth");
  assert.equal(connectionStatus().needsReconnect, true);
  releaseValidation(list(["deepseek-v4-pro"]));
  const result = await replacement;
  assert.equal(result.connected, true);
  assert.equal(result.needsReconnect, false);
  assert.deepEqual(result.models, ["deepseek-v4-pro"]);
  disconnect();
});

test("生成超时明确返回 timeout", async () => {
  disconnect();
  await connect("timeout-test-key", async () => list(["deepseek-flash"]));
  const slot = beginGeneration();
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 60000 ? 1 : delay, ...args);
  try {
    await assert.rejects(generate(slot, [{ role: "user", content: "test" }], async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })), e => e.code === "timeout");
  } finally { globalThis.setTimeout = nativeSetTimeout; disconnect(); }
});

test("验证超时后即使供应商迟到成功也不提交 Key", async () => {
  disconnect();
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 10000 ? 1 : delay, ...args);
  let release;
  try {
    const pending = connect("late-test-key", async () => new Promise(resolve => { release = resolve; }));
    const rejected = assert.rejects(pending, e => e.code === "timeout");
    await new Promise(resolve => nativeSetTimeout(resolve, 5));
    release(list(["deepseek-flash"]));
    await rejected;
    assert.equal(connectionStatus().connected, false);
  } finally { globalThis.setTimeout = nativeSetTimeout; disconnect(); }
});

test("供应商忽略 abort 且永不响应时，验证仍有硬超时", async () => {
  disconnect();
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 10000 ? 1 : delay, ...args);
  try {
    await assert.rejects(connect("never-test-key", async () => new Promise(() => {})), e => e.code === "timeout");
    assert.equal(connectionStatus().connected, false);
  } finally { globalThis.setTimeout = nativeSetTimeout; disconnect(); }
});
