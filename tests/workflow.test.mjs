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
function child(script) {
  const path = join(mkdtempSync(join(tmpdir(), "agent-workflow-")), "agents.sqlite");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const flow=await import('${workflowUrl}'); const w=await import('${itemsUrl}'); const d=await import('${deepseekUrl}'); ${script}`], { env: { ...process.env, AGENT_DB_PATH: path }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("career output is the actual English input and two runs retain source versions", () => {
  child(`
    const prompts=[];
    const fetcher=async (url,init)=>{
      if(url.endsWith('/models')) return {ok:true,json:async()=>({data:[{id:'deepseek-flash',name:'DeepSeek Flash'}]})};
      const payload=JSON.parse(init.body); prompts.push(payload);
      const isCareer=payload.messages[0].content.includes('求职顾问');
      const content=isCareer?'中文提纲：只参与用户研究':'I supported user research.';
      return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({content})}}]})};
    };
    await d.connect('test-only',fetcher);
    const id=w.createWorkItem('Prepare an English interview introduction','I supported user research',['career','english'],3,45);
    await flow.startWork(id,'workflow-first',fetcher).completion;
    const state=w.workState();
    if(prompts.length!==2 || state.runs.length!==2 || state.artifacts.length!==2 || w.getWorkItem(id).status!=='ready') process.exit(2);
    const career=state.artifacts.find(a=>a.role==='career');
    const english=state.artifacts.find(a=>a.role==='english');
    if(english.upstream_artifact_id!==career.id || state.runs.find(r=>r.role==='english').upstream_artifact_id!==career.id) process.exit(3);
    const input=JSON.parse(state.runs.find(r=>r.role==='english').context_json);
    if(input.upstream.id!==career.id || input.upstream.version!==career.version || input.upstream.content!==career.content) process.exit(4);
    await flow.startWork(id,'workflow-first',fetcher).completion;
    if(prompts.length!==2) process.exit(5);
  `);
});

test("single domain makes one call; partial failure retries only missing downstream step", () => {
  child(`
    let count=0; let failEnglish=true;
    const fetcher=async(url,init)=>{
      if(url.endsWith('/models')) return {ok:true,json:async()=>({data:[{id:'deepseek-flash'}]})};
      const role=JSON.parse(init.body).messages[0].content.includes('求职顾问')?'career':'english';
      count++;
      if(role==='english' && failEnglish) return {ok:true,json:async()=>({choices:[{message:{content:'invalid json'}}]})};
      return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({content:role==='career'?'中文成果':'English result'})}}]})};
    };
    await d.connect('test-only',fetcher);
    const only=w.createWorkItem('English writing practice','A topic',['english'],3,30);
    failEnglish=false;
    await flow.startWork(only,'single',fetcher).completion;
    if(count!==1 || w.getWorkArtifacts(only).length!==1) process.exit(2);
    const both=w.createWorkItem('Prepare career content in English','Fictional facts',['career','english'],3,30);
    failEnglish=true;
    await flow.startWork(both,'combined',fetcher).completion;
    if(count!==3 || w.getWorkArtifacts(both).length!==1 || w.getWorkItem(both).status!=='failed') process.exit(3);
    failEnglish=false;
    await flow.startWork(both,'retry',fetcher).completion;
    if(count!==4 || w.getWorkArtifacts(both).length!==2 || w.getWorkItem(both).status!=='ready') process.exit(4);
  `);
});

test("zero-material generation receives the saved participation time budget", () => {
  child(`
    let input=null;
    const fetcher=async(url,init)=>{
      if(url.endsWith('/models')) return {ok:true,json:async()=>({data:[{id:'deepseek-flash'}]})};
      const payload=JSON.parse(init.body);
      input=JSON.parse(payload.messages[1].content);
      return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({content:'通用练习，个人事实待核对'})}}]})};
    };
    await d.connect('test-only',fetcher);
    const id=w.createWorkItem('Prepare an AI product manager interview','',['career'],3,45);
    await flow.startWork(id,'no-material-time',fetcher).completion;
    if(input?.material!=='' || input.minutes!==45 || w.getWorkItem(id).status!=='ready') process.exit(2);
  `);
});

test("automatic handoff stays on the initiating revision when material changes between steps", () => {
  child(`
    const s=await import('${storeUrl}');
    let count=0;
    const fetcher=async(url,init)=>{
      if(url.endsWith('/models')) return {ok:true,json:async()=>({data:[{id:'deepseek-flash'}]})};
      count++;
      return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({content:count===1?'Career draft':'English draft'})}}]})};
    };
    await d.connect('test-only',fetcher);
    const id=w.createWorkItem('Interview in English','Old notes',['career','english'],3,40);
    s.getDatabase().exec("CREATE TRIGGER change_between_steps AFTER UPDATE OF status ON work_items WHEN NEW.status='waiting' AND OLD.status='running' BEGIN UPDATE work_items SET material='Revised notes',revision=revision+1,status='planned' WHERE id=NEW.id; END");
    await flow.startWork(id,'start-old-revision',fetcher).completion;
    if(count!==1 || w.getWorkItem(id).revision!==2 || w.getWorkItem(id).status!=='planned' || w.getWorkArtifacts(id).length!==1) process.exit(2);
  `);
});
