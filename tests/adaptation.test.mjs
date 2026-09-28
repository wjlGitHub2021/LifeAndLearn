import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.AGENT_DB_PATH = join(mkdtempSync(join(tmpdir(), "agent-adaptation-")), "agents.sqlite");
const action = await import("../src/app/api/action/route.ts");
const store = await import("../src/lib/store.ts");
const base = "http://127.0.0.1:3000";
async function post(body) {
  const request = new Request(base + "/api/action", { method: "POST", headers: { host: "127.0.0.1:3000", origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await action.POST(request);
  return { status: response.status, body: await response.json() };
}

test("口语边界、训练偏好、完成记录和纠正记忆改变后续任务", async () => {
  const spoken = await post({ type: "goal.create", domain: "english", title: "英语口语", detail: "练习日常表达", priority: 5 });
  assert.equal(spoken.status, 200);
  const oral = store.propose(30);
  assert.match(oral.items[0].prompt, /口头回答/);
  assert.match(oral.items[0].prompt, /转写/);
  assert.doesNotMatch(oral.items[0].prompt, /写一段/);

  await post({ type: "goal.update", id: spoken.body.id, domain: "english", title: "英语口语", detail: "只练口语，不进行写作，允许提交文字转写", priority: 5 });
  const oralOnly = store.propose(30);
  assert.match(oralOnly.items[0].prompt, /口头回答/);
  assert.match(oralOnly.items[0].prompt, /转写/);
  await post({ type: "goal.update", id: spoken.body.id, domain: "english", title: "英语口语", detail: "纯语音练习，不接受文字转写", priority: 5 });
  const unsupported = store.propose(30);
  assert.equal(unsupported.items.length, 0);
  assert.match(unsupported.issues.join(" "), /纯语音/);
  await post({ type: "goal.schedule", id: spoken.body.id, active: false });

  const english = await post({ type: "goal.create", domain: "english", title: "英语表达", detail: "练习清晰表达", priority: 3 });
  const career = await post({ type: "goal.create", domain: "career", title: "岗位面试", detail: "", priority: 2 });
  await post({ type: "agent.update", id: "english", enabled: true, preference: "重点练习短句" });
  const preferred = store.propose(40);
  assert.match(preferred.items.find(item => item.goalId === english.body.id).prompt, /重点练习短句/);
  assert.match(preferred.items.find(item => item.goalId === english.body.id).title, /偏好专项/);
  await post({ type: "agent.update", id: "english", enabled: true, preference: "" });

  const initial = store.propose(40);
  store.acceptProposal(initial);
  const task = store.state().tasks.find(item => item.goal_id === english.body.id && item.status === "waiting");
  const run = store.createRun(task.id, "english", "adaptation-1", "I went home yesterday.", "mock-model", []);
  store.completeRun(run, task.id, "success", "上次作答反馈", null, "练习过去式");
  store.finishTask(task.id);

  const history = store.propose(80);
  assert.match(history.items.find(item => item.goalId === english.body.id).title, /迁移练习/);
  assert.match(history.items.find(item => item.goalId === english.body.id).prompt, /不同于上次/);
  assert.match(history.items.find(item => item.goalId === english.body.id).prompt, /练习过去式/);
  assert.match(history.items.find(item => item.goalId === english.body.id).prompt, /尚未被你采用/);

  const memoryId = store.saveMemory(english.body.id, "english", run, "练习过去式", "accepted");
  const accepted = store.propose(80);
  const acceptedItem = accepted.items.find(item => item.goalId === english.body.id);
  assert.match(acceptedItem.title, /反馈专项/);
  assert.match(acceptedItem.prompt, /练习过去式/);
  assert.notEqual(accepted.token, history.token);
  assert.doesNotMatch(accepted.items.find(item => item.goalId === career.body.id).prompt, /练习过去式/);

  store.correctMemory(memoryId, "练习结构化表达");
  const corrected = store.propose(80);
  const correctedItem = corrected.items.find(item => item.goalId === english.body.id);
  assert.match(correctedItem.prompt, /练习结构化表达/);
  assert.doesNotMatch(correctedItem.prompt, /练习过去式/);
  assert.notEqual(corrected.token, accepted.token);
  assert.equal((await post({ type: "plan.accept", budget: 80, token: accepted.token })).status, 409);
  assert.equal((await post({ type: "plan.accept", budget: 80, token: corrected.token })).status, 200);
  assert.equal(store.getTask(task.id).status, "done");
});
