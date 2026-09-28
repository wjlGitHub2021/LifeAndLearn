import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDirectory = mkdtempSync(join(tmpdir(), "model-connections-"));
process.env.AGENT_DB_PATH = join(testDirectory, "agents.sqlite");
const router = await import("../src/lib/model-connections.ts");
const deepseek = await import("../src/lib/deepseek.ts");
const agents = await import("../src/lib/agent-work.ts");
const workflow = await import("../src/lib/agent-workflow.ts");
const workItems = await import("../src/lib/work-items.ts");
const workFlow = await import("../src/lib/workflow.ts");
const practice = await import("../src/lib/practice.ts");
const quickApi = await import("../src/app/api/work-items/route.ts");
const agentApi = await import("../src/app/api/agent-work/route.ts");
const store = await import("../src/lib/store.ts");
test.after(() => {
  store.getDatabase().close();
  for (const file of readdirSync(testDirectory)) unlinkSync(join(testDirectory, file));
  rmdirSync(testDirectory);
});

const list = ids => new Response(JSON.stringify({ data: ids.map(id => ({ id, name: `Name ${id}` })) }));

test("multiple credentials route each Agent to its assigned model without storing secrets", async () => {
  agents.profiles();
  let reads = 0;
  const fetcher = async (url, options) => {
    reads++;
    if (url === "https://api.openai.com/v1/models") {
      assert.equal(options.headers.Authorization, "Bearer synthetic-secret-a");
      return list(["model-a"]);
    }
    if (url === "https://openrouter.ai/api/v1/models") {
      assert.equal(options.headers.Authorization, "Bearer synthetic-secret-b");
      return list(["vendor/model-b"]);
    }
    if (url === "https://api.openai.com/v1/chat/completions") {
      assert.equal(options.headers.Authorization, "Bearer synthetic-secret-a");
      assert.equal(JSON.parse(options.body).model, "model-a");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ content: "中文提纲", appliedCorrections: [] }) } }] }));
    }
    if (url === "https://openrouter.ai/api/v1/chat/completions") {
      assert.equal(options.headers.Authorization, "Bearer synthetic-secret-b");
      assert.equal(JSON.parse(options.body).model, "vendor/model-b");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ content: "English output", appliedCorrections: [] }) } }] }));
    }
    throw new Error(`unexpected endpoint ${url}`);
  };
  const first = await router.connectChannel({ provider: "openai", name: "A", key: "synthetic-secret-a" }, fetcher);
  const second = await router.connectChannel({ provider: "openrouter", name: "B", key: "synthetic-secret-b" }, fetcher);
  router.setDefaultChoice(first.id, "model-a", 0);
  router.setAgentChoice("english", second.id, "vendor/model-b", 0);
  assert.equal(deepseek.beginGeneration("career").model, "model-a");
  assert.equal(deepseek.beginGeneration("english").model, "vendor/model-b");
  const jobId = agents.createJob("准备面试表达", "", [{ agentId: "career", upstream: [] }, { agentId: "english", upstream: [0] }]);
  await workflow.startAgentJob(jobId, "model-routing-run", fetcher).completion;
  const runs = agents.runsFor(jobId).reverse();
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map(run => run.status), ["success", "success"]);
  assert.deepEqual(runs.map(run => run.model), ["A · model-a", "B · vendor/model-b"]);
  assert.equal(reads, 4);
  const saved = JSON.stringify(store.getDatabase().prepare("SELECT key,value FROM settings WHERE key LIKE 'model.%'").all());
  const status = JSON.stringify(deepseek.connectionStatus());
  assert.equal(saved.includes("synthetic-secret"), false);
  assert.equal(status.includes("synthetic-secret"), false);
  assert.throws(() => router.setAgentChoice("english", first.id, "model-a", 0), error => error.status === 409);
  assert.throws(() => router.setDefaultChoice(second.id, "vendor/model-b", 0), error => error.status === 409);

  let release;
  const pending = deepseek.generate(deepseek.beginGeneration("english"), [{ role: "user", content: "json" }], async () => new Promise(resolve => { release = resolve; }));
  router.disconnectChannel(second.id);
  await assert.rejects(pending, error => error.code === "stale");
  assert.equal(typeof release, "function");
  assert.equal(deepseek.beginGeneration("career").model, "model-a");
  assert.throws(() => deepseek.beginGeneration("english"), error => error.status === 409 && error.message.includes("重新连接"));
  const reconnected = await router.connectChannel({ id: second.id, key: "synthetic-secret-b" }, fetcher);
  assert.equal(reconnected.id, second.id);
  assert.equal(deepseek.beginGeneration("english").model, "vendor/model-b");
  router.setAgentChoice("english", null, null, 1);
  assert.equal(router.channelState().assignmentRevisions.english, 2);
  assert.equal(deepseek.beginGeneration("english").model, "model-a");
  assert.throws(() => router.setAgentChoice("english", second.id, "vendor/model-b", 1), error => error.status === 409);
  router.setAgentChoice("english", second.id, "vendor/model-b", 2);
  router.disconnectChannel(first.id);
  router.disconnectChannel(second.id);
});

test("custom endpoints reject local URLs and manual model fallback does not claim verification", async () => {
  for (const baseUrl of ["http://api.vendor.com/v1", "https://localhost/v1", "https://127.0.0.1/v1", "https://user:secret@api.vendor.com/v1", "https://api.vendor.com/v1?key=secret"]) {
    await assert.rejects(router.connectChannel({ provider: "custom", name: "Unsafe", baseUrl, key: "synthetic-secret" }, async () => { throw new Error("must not send"); }), error => error.status === 400);
  }
  const accepted = await router.connectChannel({ provider: "custom", name: "Manual", baseUrl: "https://api.vendor.com/v1", key: "synthetic-secret", manualModels: "model-x, model-y" }, async (url, options) => {
    assert.equal(url, "https://api.vendor.com/v1/models");
    assert.equal(options.redirect, "error");
    return new Response("", { status: 404 });
  });
  assert.deepEqual(accepted.models, ["model-x", "model-y"]);
  assert.equal(accepted.verified, false);
  await assert.rejects(router.connectChannel({ id: accepted.id, key: "replacement", manualModels: "model-z" }, async () => new Response("", { status: 401 })), error => error.status === 401);
  assert.equal(router.liveChannel({ connectionId: accepted.id, model: "model-x", revision: 1 }).key, "synthetic-secret");
  router.disconnectChannel(accepted.id);
});

test("item model override routes both item types and practice while inherited Agents stay separate", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    if (url.endsWith("/models")) return list(url.includes("openrouter") ? ["model-d"] : ["model-c"]);
    const payload = JSON.parse(options.body);
    calls.push({ url, model: payload.model });
    const system = payload.messages[0].content;
    const content = system.includes("只提出一道可直接回答") ? { question: "What changed?" }
      : system.includes("evidenceId") ? { evidenceId: "s1", feedback: "Good answer.", nextSuggestion: "Try one more example." }
      : { content: system.includes("求职顾问") || system.includes("Agent「求职顾问") ? "中文提纲" : "English outline", appliedCorrections: [] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  };
  const c = await router.connectChannel({ provider: "openai", name: "C", key: "synthetic-c" }, fetcher);
  const d = await router.connectChannel({ provider: "openrouter", name: "D", key: "synthetic-d" }, fetcher);
  router.setDefaultChoice(c.id, "model-c", router.channelState().defaultChoice?.revision ?? 0);
  router.setAgentChoice("english", d.id, "model-d", router.channelState().assignmentRevisions.english ?? 0);
  const request = (path, body) => new Request(`http://127.0.0.1:3901${path}`, { method: "POST", headers: { host: "127.0.0.1:3901", origin: "http://127.0.0.1:3901", "content-type": "application/json" }, body: JSON.stringify(body) });
  const quickCreated = await quickApi.POST(request("/api/work-items", { type: "create", request: "API selected model", material: "", roles: ["career"], priority: 3, minutes: 30, modelChoice: { connectionId: d.id, model: "model-d" } }));
  assert.equal(quickCreated.status, 200);
  const quickBody = await quickCreated.json();
  assert.deepEqual(JSON.parse(quickBody.state.items.find(item => item.id === quickBody.id).model_choice_json), { connectionId: d.id, model: "model-d" });
  assert.equal((await quickApi.POST(request("/api/work-items", { type: "model.update", id: quickBody.id, modelRevision: 1 }))).status, 400);
  assert.equal((await quickApi.POST(request("/api/work-items", { type: "model.update", id: quickBody.id, modelRevision: 1, modelChoice: null }))).status, 200);
  assert.equal((await quickApi.POST(request("/api/work-items", { type: "model.update", id: quickBody.id, modelRevision: 1, modelChoice: null }))).status, 409);
  const agentCreated = await agentApi.POST(request("/api/agent-work", { type: "job.create", request: "API agent model", material: "", steps: [{ agentId: "career", upstream: [] }], modelChoice: { connectionId: d.id, model: "model-d" } }));
  assert.equal(agentCreated.status, 200);
  const agentBody = await agentCreated.json();
  assert.deepEqual(JSON.parse(agentBody.state.jobs.find(job => job.id === agentBody.id).model_choice_json), { connectionId: d.id, model: "model-d" });
  assert.equal((await agentApi.POST(request("/api/agent-work", { type: "model.update", id: agentBody.id, modelRevision: 1, modelChoice: null }))).status, 200);
  const inherited = workItems.createWorkItem("Fictional interview", "", ["career", "english"], 3, 30);
  await workFlow.startWork(inherited, "item-inherit", fetcher).completion;
  assert.deepEqual(workItems.workState().runs.filter(run => run.item_id === inherited).reverse().map(run => run.model), ["C · model-c", "D · model-d"]);

  const fixed = workItems.createWorkItem("Fictional practice", "", ["english"], 3, 30, undefined, { connectionId: c.id, model: "model-c" });
  await workFlow.startWork(fixed, "item-fixed", fetcher).completion;
  assert.equal(workItems.workState().runs.find(run => run.item_id === fixed)?.model, "C · model-c");
  await practice.startPractice(fixed, "english", "practice-prepare", 1, undefined, undefined, fetcher).completion;
  const round = workItems.workState().practices.find(entry => entry.item_id === fixed);
  assert.equal(round?.status, "question");
  await practice.startPractice(fixed, "english", "practice-feedback", 1, round.id, "I improved the plan.", fetcher).completion;
  assert.deepEqual(workItems.workState().practiceRuns.filter(run => run.practice_id === round.id).map(run => run.model), ["C · model-c", "C · model-c"]);
  const artifactId = workItems.workState().artifacts.find(entry => entry.item_id === fixed)?.id;
  workItems.setWorkItemModelChoice(fixed, { connectionId: d.id, model: "model-d" }, 1);
  assert.equal(workItems.currentWorkArtifact(workItems.getWorkItem(fixed), "english")?.id, artifactId);
  assert.throws(() => workItems.setWorkItemModelChoice(fixed, null, 1), error => error.status === 409);

  const custom = agents.createJob("Fictional handoff", "", [{ agentId: "career", upstream: [] }, { agentId: "english", upstream: [0] }], undefined, { connectionId: d.id, model: "model-d" });
  await workflow.startAgentJob(custom, "custom-fixed", fetcher).completion;
  assert.deepEqual(agents.runsFor(custom).reverse().map(run => run.model), ["D · model-d", "D · model-d"]);
  const historical = agents.artifactsFor(custom).map(entry => entry.id);
  agents.setJobModelChoice(custom, { connectionId: c.id, model: "model-c" }, 1);
  assert.deepEqual(agents.artifactsFor(custom).map(entry => entry.id), historical);
  assert.throws(() => agents.setJobModelChoice(custom, null, 1), error => error.status === 409);

  const blocked = workItems.createWorkItem("Unavailable fixed model", "", ["career"], 3, 30, undefined, { connectionId: d.id, model: "model-d" });
  router.disconnectChannel(d.id);
  assert.throws(() => workFlow.startWork(blocked, "no-fallback", fetcher), error => error.status === 409 && error.message.includes("重新连接"));
  assert.equal(workItems.workState().runs.some(run => run.item_id === blocked), false);
  assert.equal(calls.filter(call => call.model === "model-c").length, 4);
  assert.equal(calls.filter(call => call.model === "model-d").length, 3);
  router.disconnectChannel(c.id);
});
