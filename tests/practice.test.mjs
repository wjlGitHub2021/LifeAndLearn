import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const path = join(mkdtempSync(join(tmpdir(), "agent-practice-")), "agents.sqlite");
const practiceUrl = new URL("../src/lib/practice.ts", import.meta.url).href;
const itemsUrl = new URL("../src/lib/work-items.ts", import.meta.url).href;
const deepseekUrl = new URL("../src/lib/deepseek.ts", import.meta.url).href;
function child(script) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const p=await import('${practiceUrl}'); const w=await import('${itemsUrl}'); const d=await import('${deepseekUrl}'); ${script}`], { env: { ...process.env, AGENT_DB_PATH: path }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("two rounds retain actual answers, feedback and next round evidence", () => {
  child(`
    const calls=[];
    const fetcher=async(url,init)=>{
      if(url.endsWith('/models')) return {ok:true,json:async()=>({data:[{id:'deepseek-flash'}]})};
      const payload=JSON.parse(init.body); calls.push(payload);
      const question=payload.messages[0].content.includes('一道可直接回答');
      const context=JSON.parse(payload.messages[1].content);
      const content=question?JSON.stringify({question:context.history.length?'What changed?':'What did you do?'}) : JSON.stringify({evidenceId:'s1',feedback:'Based on your actual answer, add one concrete detail.',nextSuggestion:'Practice a concise follow-up.'});
      return {ok:true,json:async()=>({choices:[{message:{content}}]})};
    };
    await d.connect('test-only',fetcher);
    const id=w.createWorkItem('English interview practice','Fictional material',['english'],3,30);
    const item=w.getWorkItem(id);
    const ctx={request:item.request,material:item.material,facts:[],preferences:[],upstream:null,agentEpochs:{english:0},revision:1,minutes:30,priority:3};
    const s=await import('${new URL("../src/lib/store.ts", import.meta.url).href}');
    ctx.agentEpochs.english=s.getAgentEpoch('english');
    const run=w.claimWorkRun(id,'english','source','mock',ctx,null);
    w.completeWorkRun(run.id,'success','English source artifact',null);
    await p.startPractice(id,'english','prepare-1',1,undefined,undefined,fetcher).completion;
    let rounds=w.workState().practices;
    if(rounds.length!==1 || rounds[0].status!=='question') process.exit(2);
    await p.startPractice(id,'english','feedback-1',1,rounds[0].id,'I supported research.',fetcher).completion;
    rounds=w.workState().practices;
    if(rounds[0].status!=='feedback' || !rounds[0].feedback.includes('I supported research.')) process.exit(3);
    await p.startPractice(id,'english','prepare-2',1,undefined,undefined,fetcher).completion;
    rounds=w.workState().practices;
    const second=rounds[0];
    if(second.question!=='What changed?' || !JSON.parse(w.workState().practiceRuns.find(r=>r.practice_id===second.id).context_json).history[0].answer.includes('supported research')) process.exit(4);
    await p.startPractice(id,'english','feedback-2',1,second.id,'I clarified the user needs.',fetcher).completion;
    if(w.workState().practices[0].status!=='feedback' || calls.length!==4) process.exit(5);
  `);
});

test("practice submission IDs cannot accept different answers or stale source", () => {
  child(`
    const s=await import('${new URL("../src/lib/store.ts", import.meta.url).href}');
    const fetcher=async(url,init)=>{
      if(url.endsWith('/models')) return {ok:true,json:async()=>({data:[{id:'deepseek-flash'}]})};
      const payload=JSON.parse(init.body);
      const content=payload.messages[0].content.includes('一道可直接回答')?JSON.stringify({question:'What happened?'}) : JSON.stringify({evidenceId:'s1',feedback:'You answered the question.',nextSuggestion:'Try a shorter answer.'});
      return {ok:true,json:async()=>({choices:[{message:{content}}]})};
    };
    await d.connect('test-only',fetcher);
    const id=w.createWorkItem('English practice','Fictional notes',['english'],3,30);
    const item=w.getWorkItem(id);
    const ctx={request:item.request,material:item.material,facts:[],preferences:[],upstream:null,agentEpochs:{english:s.getAgentEpoch('english')},revision:1,minutes:30,priority:3};
    const run=w.claimWorkRun(id,'english','practice-source','mock',ctx,null);
    w.completeWorkRun(run.id,'success','Practice source',null);
    await p.startPractice(id,'english','prepare-once',1,undefined,undefined,fetcher).completion;
    const round=w.workState().practices[0];
    await p.startPractice(id,'english','answer-once',1,round.id,'I supported research.',fetcher).completion;
    try { p.startPractice(id,'english','answer-once',1,round.id,'I led research.',fetcher); process.exit(2); } catch(error) { if(error.status!==409) process.exit(3); }
    w.reviseWorkItem(id,item.request,'Changed fictional notes','',['english'],30,3,1);
    try { p.startPractice(id,'english','stale-answer',2,round.id,'Another answer.',fetcher); process.exit(4); } catch(error) { if(error.status!==409) process.exit(5); }
  `);
});

test("duplicate practice start makes one call and another request waits for the current round", () => {
  child(`
    const s=await import('${new URL("../src/lib/store.ts", import.meta.url).href}');
    let finish;
    let calls=0;
    const fetcher=async(url)=>{
      if(url.endsWith('/models')) return {ok:true,json:async()=>({data:[{id:'deepseek-flash'}]})};
      calls++;
      return new Promise(resolve=>{ finish=()=>resolve({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({question:'What happened?'})}}]})}); });
    };
    await d.connect('test-only',fetcher);
    const id=w.createWorkItem('English practice','Fictional notes',['english'],3,30);
    const item=w.getWorkItem(id);
    const ctx={request:item.request,material:item.material,facts:[],preferences:[],upstream:null,agentEpochs:{english:s.getAgentEpoch('english')},revision:1,minutes:30,priority:3};
    const source=w.claimWorkRun(id,'english','single-source','mock',ctx,null);
    w.completeWorkRun(source.id,'success','Practice source',null);
    const first=p.startPractice(id,'english','same-start',1,undefined,undefined,fetcher);
    const duplicate=p.startPractice(id,'english','same-start',1,undefined,undefined,fetcher);
    if(first.runId!==duplicate.runId || calls!==1) process.exit(2);
    try { p.startPractice(id,'english','other-start',1,undefined,undefined,fetcher); process.exit(3); } catch(error) { if(error.status!==409) process.exit(4); }
    finish(); await first.completion;
    const state=w.workState();
    if(state.practices.filter(round=>round.item_id===id).length!==1 || state.practiceRuns.filter(run=>run.practice_id===state.practices.find(round=>round.item_id===id)?.id).length!==1) process.exit(5);
    try { p.startPractice(id,'english','next-too-early',1,undefined,undefined,fetcher); process.exit(6); } catch(error) { if(error.status!==409) process.exit(7); }
  `);
});
