import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("real workflow consumes model deltas and commits only validated Markdown", () => {
  const folder = mkdtempSync(join(tmpdir(), "agent-workflow-stream-"));
  try {
    const code = `
      const d = await import(${JSON.stringify(new URL("../src/lib/deepseek.ts", import.meta.url).href)});
      const w = await import(${JSON.stringify(new URL("../src/lib/work-items.ts", import.meta.url).href)});
      const flow = await import(${JSON.stringify(new URL("../src/lib/workflow.ts", import.meta.url).href)});
      const events = await import(${JSON.stringify(new URL("../src/lib/run-stream.ts", import.meta.url).href)});
      await d.connect('test-key', async () => new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }), { status: 200 }));
      const output = JSON.stringify({ content: '# 面试要点\\n- 澄清需求', appliedCorrections: [] });
      const frame = (delta, reason = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] }) + '\\n\\n';
      globalThis.fetch = async (_url, init) => {
        const request = JSON.parse(init.body);
        if (!request.stream || request.thinking?.type !== 'enabled') throw new Error('streaming thinking was not requested');
        const bytes = new TextEncoder().encode(frame({ reasoning_content: 'I should keep this generic.' }) + frame({ content: output.slice(0, 22) }) + frame({ content: output.slice(22) }) + frame({}, 'stop') + 'data: [DONE]\\n\\n');
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      };
      const id = w.createWorkItem('AI 产品经理面试', '', ['career'], 3, 30);
      const run = flow.startWork(id, 'stream-test');
      await run.completion;
      const state = w.workState();
      const saved = state.artifacts.find(artifact => artifact.run_id === run.runId);
      if (!saved || saved.content !== '# 面试要点\\n- 澄清需求') throw new Error('validated Markdown not committed');
      const reader = events.subscribeRunStream(run.runId).getReader();
      const snapshot = (await reader.read()).value;
      if (snapshot.kind !== 'snapshot' || snapshot.status !== 'done' || !snapshot.reasoning.includes('generic') || snapshot.content !== output) throw new Error('stream replay incomplete');
    `;
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { env: { ...process.env, AGENT_DB_PATH: join(folder, "agents.sqlite") }, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
