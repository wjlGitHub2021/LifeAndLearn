import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const workflowUrl = new URL("../src/lib/workflow.ts", import.meta.url).href;
const itemsUrl = new URL("../src/lib/work-items.ts", import.meta.url).href;
const deepseekUrl = new URL("../src/lib/deepseek.ts", import.meta.url).href;
const storeUrl = new URL("../src/lib/store.ts", import.meta.url).href;
function child(script, path = join(mkdtempSync(join(tmpdir(), "agent-work-control-")), "agents.sqlite")) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const flow=await import('${workflowUrl}'); const w=await import('${itemsUrl}'); const d=await import('${deepseekUrl}'); const s=await import('${storeUrl}'); ${script}`], { env: { ...process.env, AGENT_DB_PATH: path }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return path;
}

test("pause stops downstream; resume is explicit and does not rerun career", () => {
  child(`
    let release; const gate=new Promise(resolve=>{release=resolve}); let count=0;
    const fetcher=async(url,init)=>{
      if(url.endsWith('/models')) return {ok:true,json:async()=>({data:[{id:'deepseek-flash'}]})};
      count++; if(count===1) await gate;
      return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({content:count===1?'中文成果':'English result'})}}]})};
    };
    await d.connect('test-only',fetcher);
    const id=w.createWorkItem('Prepare interview material in English','Fictional facts',['career','english'],3,45);
    const started=flow.startWork(id,'initial',fetcher);
    s.updateAgent('english',false,''); release(); await started.completion;
    if(count!==1 || w.getWorkArtifacts(id).length!==1 || w.getWorkItem(id).status!=='waiting') process.exit(2);
    s.updateAgent('english',true,'');
    await flow.startWork(id,'resume',fetcher).completion;
    if(count!==2 || w.getWorkArtifacts(id).length!==2 || w.getWorkItem(id).status!=='ready') process.exit(3);
  `);
});

test("pause then resume before upstream finishes still requires an explicit continue", () => {
  child(`
    let release; const gate=new Promise(resolve=>{release=resolve}); let count=0;
    const fetcher=async(url,init)=>{
      if(url.endsWith('/models')) return {ok:true,json:async()=>({data:[{id:'deepseek-flash'}]})};
      count++; if(count===1) await gate;
      return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({content:count===1?'中文成果':'English result'})}}]})};
    };
    await d.connect('test-only',fetcher);
    const id=w.createWorkItem('Interview in English','Fictional facts',['career','english'],3,45);
    const started=flow.startWork(id,'initial',fetcher);
    s.updateAgent('english',false,''); s.updateAgent('english',true,'');
    release(); await started.completion;
    if(count!==1 || w.getWorkItem(id).status!=='waiting') process.exit(2);
    await flow.startWork(id,'explicit-continue',fetcher).completion;
    if(count!==2 || w.getWorkItem(id).status!=='ready') process.exit(3);
  `);
});

test("duplicate and concurrent requests make one call; cancellation discards late output", () => {
  child(`
    let release; const gate=new Promise(resolve=>{release=resolve}); let count=0;
    const fetcher=async(url,init)=>{
      if(url.endsWith('/models')) return {ok:true,json:async()=>({data:[{id:'deepseek-flash'}]})};
      count++; await gate;
      return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({content:'Late content'})}}]})};
    };
    await d.connect('test-only',fetcher);
    const id=w.createWorkItem('English practice','Only this item',['english'],3,20);
    const started=flow.startWork(id,'same-request',fetcher);
    if(flow.startWork(id,'same-request',fetcher).runId!==started.runId) process.exit(2);
    let rejected=false; try { flow.startWork(id,'another-request',fetcher); } catch { rejected=true; }
    if(!rejected || count!==1) process.exit(3);
    d.cancelRun(started.runId); w.completeWorkRun(started.runId,'cancelled',null,'User cancelled');
    release(); await started.completion;
    if(w.getWorkRun(started.runId).status!=='cancelled' || w.getWorkArtifacts(id).length!==0 || w.getWorkItem(id).status!=='cancelled') process.exit(4);
  `);
});

test("a dead owner becomes interrupted without auto retry", () => {
  const path = child(`
    const id=w.createWorkItem('Career preparation','Fictional notes',['career'],3,30);
    const item=w.getWorkItem(id);
    const context={request:item.request,material:item.material,facts:[],preferences:[],upstream:null,agentEpochs:{career:s.getAgentEpoch('career')},revision:item.revision,minutes:item.minutes,priority:item.priority};
    const run=w.claimWorkRun(id,'career','orphan','mock',context,null);
    if(!run) process.exit(2);
  `);
  child(`
    const state=w.workState();
    if(state.runs.length!==1 || state.runs[0].status!=='interrupted' || state.items[0].status!=='interrupted' || state.artifacts.length!==0) process.exit(2);
  `, path);
});
