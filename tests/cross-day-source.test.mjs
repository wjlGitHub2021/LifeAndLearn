import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const urls = Object.fromEntries(["work-items", "workflow", "practice", "deepseek", "agent-work", "store"].map(name => [name, new URL(`../src/lib/${name}.ts`, import.meta.url).href]));
function isolated(script) {
  const path = join(mkdtempSync(join(tmpdir(), "agent-cross-day-")), "agents.sqlite");
  const imports = `const w=await import('${urls["work-items"]}');const flow=await import('${urls.workflow}');const p=await import('${urls.practice}');const d=await import('${urls.deepseek}');const a=await import('${urls["agent-work"]}');const s=await import('${urls.store}');`;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", imports + script], { env: { ...process.env, AGENT_DB_PATH: path }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("seven linked days pass accepted outputs and completed practice into later model inputs", () => {
  isolated(`
    const calls=[];
    const fetcher=async(url,init)=>{
      if(url.endsWith('/models')) return {ok:true,json:async()=>({data:[{id:'deepseek-flash'}]})};
      const payload=JSON.parse(init.body);
      const context=JSON.parse(payload.messages[1].content);
      calls.push({system:payload.messages[0].content,context,maxTokens:payload.max_tokens});
      const content=payload.messages[0].content.includes('一道可直接回答')
        ? JSON.stringify({question:'Use one word from yesterday in a sentence.'})
        : context.answer
          ? JSON.stringify({evidenceId:'s1',feedback:'Your actual answer used one word.',nextSuggestion:'Review the same word tomorrow.'})
          : JSON.stringify({content:'Day '+context.request.split(' ')[1]+' vocabulary result',appliedCorrections:[]});
      return {ok:true,json:async()=>({choices:[{message:{content}}]})};
    };
    await d.connect('test-only',fetcher);
    let previous=null;
    for(let day=1;day<=7;day++){
      const id=w.createWorkItem('Day '+day+' IELTS vocabulary','Fictional study goal',['english'],3,30,{plannedDate:['2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-02','2026-10-03','2026-10-04'][day-1]});
      if(previous){
        const artifact=w.currentWorkArtifact(w.getWorkItem(previous),'english');
        if(w.setWorkSource(id,1,{kind:'quick',id:previous,artifactId:artifact.id})!==2) process.exit(2);
      }
      const run=flow.startWork(id,'day-'+day,fetcher,w.getWorkItem(id).revision);
      await run.completion;
      const artifact=w.currentWorkArtifact(w.getWorkItem(id),'english');
      if(!artifact || !w.acceptWorkArtifact(id,artifact.id,w.getWorkItem(id).revision)) process.exit(3);
      const generated=calls.findLast(call=>call.context.request==='Day '+day+' IELTS vocabulary');
      if(!generated || (generated.context.sources||[]).length!==day-1) process.exit(4);
      if(generated.maxTokens!==(day===1?2800:4800)) process.exit(10);
      if(day>=2 && generated.context.sources[0].content!=='Day 1 vocabulary result') process.exit(5);
      if(day>=2 && generated.context.sources[0].practice?.answer!=='[Synthetic QA answer] I used the word.') process.exit(6);
      if(day===1){
        await p.startPractice(id,'english','question-day-1',1,undefined,undefined,fetcher).completion;
        const round=w.workState().practices.find(entry=>entry.item_id===id);
        await p.startPractice(id,'english','feedback-day-1',1,round.id,'[Synthetic QA answer] I used the word.',fetcher).completion;
        if(w.workState().practices.find(entry=>entry.id===round.id)?.status!=='feedback') process.exit(7);
      }
      if(day===2){
        await p.startPractice(id,'english','question-day-2',2,undefined,undefined,fetcher).completion;
        const question=calls.at(-1).context;
        if(question.sources[0].practice?.suggestion!=='Review the same word tomorrow.') process.exit(8);
      }
      previous=id;
    }
    const last=w.getWorkItem(previous);
    if(w.sourcesOf(last).length!==6 || w.workState().items.length!==7) process.exit(9);
  `);
});

test("source selection rejects stale and unaccepted versions, cycles and altered claim snapshots", () => {
  isolated(`
    const source=w.createWorkItem('Source','Fictional note',['english'],3,30);
    const ctx=(id,sources=[])=>{const item=w.getWorkItem(id);return {request:item.request,material:item.material,englishRequirement:item.english_requirement,facts:[],preferences:[],upstream:null,sources,agentEpochs:{english:s.getAgentEpoch('english')},revision:item.revision,minutes:item.minutes,priority:item.priority}};
    const run=w.claimWorkRun(source,'english','source-run','mock',ctx(source),null);
    w.completeWorkRun(run.id,'success','Source v1',null);
    const original=w.currentWorkArtifact(w.getWorkItem(source),'english');
    const target=w.createWorkItem('Target','Fictional note',['english'],3,30);
    try { w.setWorkSource(target,1,{kind:'quick',id:source,artifactId:original.id}); process.exit(2); } catch(e) { if(e.status!==409) process.exit(3); }
    w.acceptWorkArtifact(source,original.id,1);
    w.setWorkSource(target,1,{kind:'quick',id:source,artifactId:original.id});
    if(w.claimWorkRun(target,'english','tampered','mock',ctx(target,[]),null)) process.exit(4);
    const valid=w.claimWorkRun(target,'english','valid','mock',ctx(target,w.sourcesOf(w.getWorkItem(target))),null);
    if(!valid) process.exit(5);
    w.completeWorkRun(valid.id,'success','Target result',null);
    const targetArtifact=w.currentWorkArtifact(w.getWorkItem(target),'english');
    w.acceptWorkArtifact(target,targetArtifact.id,2);
    try { w.setWorkSource(source,1,{kind:'quick',id:target,artifactId:targetArtifact.id}); process.exit(6); } catch(e) { if(e.status!==409) process.exit(7); }
    const blocked=w.createWorkItem('Permission check','Fictional note',['english'],3,30);
    w.setWorkSource(blocked,1,{kind:'quick',id:target,artifactId:targetArtifact.id});
    const agent=a.profile('english');
    a.saveProfile({name:agent.name,instructions:agent.instructions,deliverable:agent.deliverable,allow_material:agent.allow_material,allow_upstream:0},'english',agent.revision);
    try { flow.startWork(blocked,'blocked',undefined,2); process.exit(11); } catch(e) { if(e.status!==409 || !e.message.includes('上游成果权限')) process.exit(12); }
    w.setWorkSource(target,2,null);
    if(w.currentWorkArtifact(w.getWorkItem(target),'english') || w.getWorkArtifacts(target).length!==1) process.exit(8);
    w.reviseWorkItem(source,'Source','Changed note','',['english'],30,3,1);
    try { w.setWorkSource(target,3,{kind:'quick',id:source,artifactId:original.id}); process.exit(9); } catch(e) { if(e.status!==409) process.exit(10); }
  `);
});

test("a quick item can explicitly use an accepted custom Agent result", () => {
  isolated(`
    const id=a.createJob('Fictional interview outline','Fictional profile',[{agentId:'career',upstream:[]},{agentId:'english',upstream:[0]}]);
    const input=a.inputFor(a.job(id),0);
    const run=a.claimRun(id,0,'agent-source','mock',input.context,input.inputHash);
    a.finishRun(run.run.id,'success','Interview result',null);
    const artifact=a.currentArtifact(a.job(id),0);
    if(!artifact) process.exit(2);
    a.acceptArtifact(id,artifact.id,1);
    if(!a.currentArtifact(a.job(id),0)?.accepted_at) process.exit(2);
    const secondInput=a.inputFor(a.job(id),1);
    const secondRun=a.claimRun(id,1,'agent-second','mock',secondInput.context,secondInput.inputHash);
    a.finishRun(secondRun.run.id,'success','English result',null);
    const second=a.currentArtifact(a.job(id),1);
    a.acceptArtifact(id,second.id,1);
    const target=w.createWorkItem('Day 2 interview follow-up','Fictional notes',['career'],3,30);
    w.setWorkSource(target,1,{kind:'agent',id,artifactId:artifact.id});
    const sources=w.sourcesOf(w.getWorkItem(target));
    if(sources.length!==1 || sources[0].content!=='Interview result' || sources[0].kind!=='agent' || sources[0].producer!=='求职顾问') process.exit(3);

    const quick=w.createWorkItem('Bilingual source','Fictional note',['career','english'],3,30);
    const ctx=(id,role,upstream=null)=>{const item=w.getWorkItem(id);return {request:item.request,material:item.material,englishRequirement:role==='english'?item.english_requirement:'',facts:[],preferences:[],upstream:upstream?{id:upstream.id,version:upstream.version,revision:upstream.revision,content:upstream.content}:null,sources:[],agentEpochs:{career:s.getAgentEpoch('career'),english:s.getAgentEpoch('english')},revision:item.revision,minutes:item.minutes,priority:item.priority}};
    const firstRun=w.claimWorkRun(quick,'career','quick-first','mock',ctx(quick,'career'),null);
    w.completeWorkRun(firstRun.id,'success','Career facts',null);
    const first=w.currentWorkArtifact(w.getWorkItem(quick),'career');
    w.acceptWorkArtifact(quick,first.id,1);
    const englishRun=w.claimWorkRun(quick,'english','quick-second','mock',ctx(quick,'english',first),first.id);
    w.completeWorkRun(englishRun.id,'success','English expression',null);
    const english=w.currentWorkArtifact(w.getWorkItem(quick),'english');
    w.acceptWorkArtifact(quick,english.id,1);
    const followup=w.createWorkItem('Career-only follow-up','Fictional note',['career'],3,30);
    w.setWorkSource(followup,1,{kind:'quick',id:quick,artifactId:first.id});
    if(w.sourcesOf(w.getWorkItem(followup))[0].producer!=='求职顾问') process.exit(4);
  `);
});
