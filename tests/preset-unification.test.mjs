import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const urls = Object.fromEntries(["agent-work", "work-items", "workflow", "deepseek", "practice", "store"].map(name => [name, new URL(`../src/lib/${name}.ts`, import.meta.url).href]));
const apiUrl = new URL("../src/app/api/agent-work/route.ts", import.meta.url).href;
function child(script) {
  const path = join(mkdtempSync(join(tmpdir(), "preset-unification-")), "agents.sqlite");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const a=await import('${urls["agent-work"]}'); const w=await import('${urls["work-items"]}'); const flow=await import('${urls.workflow}'); const d=await import('${urls.deepseek}'); ${script}`], { env: { ...process.env, AGENT_DB_PATH: path }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("preset permissions, instructions and preferences apply to quick work and both editors", () => {
  child(`
    const before=a.profile('english');
    a.saveProfile({name:before.name,instructions:'SYNTHETIC_ROLE_INSTRUCTION',deliverable:before.deliverable,allow_material:0,allow_upstream:0},'english',before.revision);
    const first=a.savePreference('english','SYNTHETIC_NEW_PREFERENCE');
    const second=w.saveWorkPreference('english','SYNTHETIC_OLD_EDITOR_PREFERENCE');
    if(!a.agentState().preferences.some(entry=>entry.id===second) || !w.workState().preferences.some(entry=>entry.id===first)) throw Error('split preference views');
    const sent=[];
    const fetcher=async(url,options)=>{
      if(url.endsWith('/models')) return new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}),{status:200});
      const payload=JSON.parse(options.body); sent.push(payload.messages);
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({content:sent.length===1?'中文摘要':'English summary',appliedCorrections:[]})}}]}),{status:200});
    };
    await d.connect('synthetic-test-key',fetcher);
    const id=w.createWorkItem('Synthetic career and English task','SYNTHETIC_PRIVATE_MATERIAL',['career','english'],3,30);
    await flow.startWork(id,'unified-preset',fetcher).completion;
    if(sent.length!==2 || !sent[1][0].content.includes('SYNTHETIC_ROLE_INSTRUCTION')) throw Error('instruction not applied');
    const input=JSON.parse(sent[1][1].content);
    if(input.material || input.facts.length || input.upstream || !input.preferences.some(p=>p.id===first) || !input.preferences.some(p=>p.id===second)) throw Error('permission or preferences not applied');
    if(sent[1][1].content.includes('SYNTHETIC_PRIVATE_MATERIAL')) throw Error('material leaked');
    const output=w.getWorkArtifacts(id).find(entry=>entry.role==='english');
    if(!output || output.upstream_artifact_id!==null) throw Error('unexpected upstream');
    w.updateWorkPreference(first,'SYNTHETIC_NEW_PREFERENCE',false,'SYNTHETIC_NEW_PREFERENCE',true);
    a.updatePreference(second,'SYNTHETIC_OLD_EDITOR_PREFERENCE',false,'SYNTHETIC_OLD_EDITOR_PREFERENCE',true);
    if(w.getActivePreferences('english').length || a.activePreferences('english').length) throw Error('revocation not shared');
  `);
});

test("a preset change during a quick run discards the late result", () => {
  child(`
    let release; const gate=new Promise(resolve=>{release=resolve});
    const fetcher=async(url)=>url.endsWith('/models')
      ? new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}),{status:200})
      : (await gate,new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({content:'Late synthetic result',appliedCorrections:[]})}}]}),{status:200}));
    await d.connect('synthetic-test-key',fetcher);
    const id=w.createWorkItem('Synthetic single role','SYNTHETIC_PRIVATE_MATERIAL',['english'],3,20);
    const started=flow.startWork(id,'profile-change',fetcher);
    const old=a.profile('english');
    a.saveProfile({name:old.name,instructions:'Changed synthetic instruction',deliverable:old.deliverable,allow_material:0,allow_upstream:old.allow_upstream},'english',old.revision);
    release(); await started.completion;
    if(w.getWorkArtifacts(id).length || w.getWorkRun(started.runId).status==='success') throw Error('late result committed');
  `);
});

for (const permission of ["allow_material", "allow_upstream", "material_removed"]) {
  test(`practice does not reuse old text after ${permission} changes`, () => {
    child(`
      const p=await import('${urls.practice}');
      const calls=[];
      const fetcher=async(url,options)=>{
        if(url.endsWith('/models')) return new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}),{status:200});
        const messages=JSON.parse(options.body).messages; calls.push(messages);
        const system=messages[0].content;
        const content=system.includes('一道可直接回答')
          ? JSON.stringify({question:'SYNTHETIC_OLD_PRACTICE_SECRET'})
          : system.includes('evidenceId')
            ? JSON.stringify({evidenceId:'s1',feedback:'Synthetic feedback.',nextSuggestion:'Try one detail.'})
            : JSON.stringify({content:'Synthetic source',appliedCorrections:[]});
        return new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200});
      };
      await d.connect('synthetic-test-key',fetcher);
      const id=w.createWorkItem('Synthetic practice','SYNTHETIC_PRIVATE_MATERIAL',['career','english'],3,30);
      await flow.startWork(id,'work-before',fetcher).completion;
      let revision=w.getWorkItem(id).revision;
      await p.startPractice(id,'english','prepare-before',revision,undefined,undefined,fetcher).completion;
      const first=w.workState().practices[0];
      await p.startPractice(id,'english','feedback-before',revision,first.id,'I prepared a synthetic answer.',fetcher).completion;
      if(w.workState().practices[0].status!=='feedback') throw Error('first round failed');
      ${permission === "material_removed" ? "w.reviseWorkItem(id,w.getWorkItem(id).request,'','',['career','english'],30,3,revision); revision=w.getWorkItem(id).revision;" : `const old=a.profile('english'); a.saveProfile({name:old.name,instructions:old.instructions,deliverable:old.deliverable,allow_material:${permission === "allow_material" ? "0" : "old.allow_material"},allow_upstream:${permission === "allow_upstream" ? "0" : "old.allow_upstream"}},'english',old.revision);`}
      await flow.startWork(id,'work-after',fetcher).completion;
      await p.startPractice(id,'english','prepare-after',revision,undefined,undefined,fetcher).completion;
      const last=calls.at(-1)[1].content;
      if(JSON.parse(last).history.length || last.includes('SYNTHETIC_OLD_PRACTICE_SECRET')) throw Error('revoked history leaked');
      if(!w.workState().practices.some(entry=>entry.id===first.id)) throw Error('history disappeared');
    `);
  });
}

test("legacy quick artifact becomes historical after a preset permission change", () => {
  child(`
    const p=await import('${urls.practice}'); const s=await import('${urls.store}');
    const fetcher=async(url)=>url.endsWith('/models')
      ? new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}),{status:200})
      : new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({content:'SYNTHETIC_LEGACY_ARTIFACT_SECRET',appliedCorrections:[]})}}]}),{status:200});
    await d.connect('synthetic-test-key',fetcher);
    const id=w.createWorkItem('Synthetic legacy item','Synthetic notes',['english'],3,20);
    await flow.startWork(id,'legacy-source',fetcher).completion;
    const artifact=w.currentWorkArtifact(w.getWorkItem(id),'english');
    const run=w.getWorkRun(artifact.run_id); const context=JSON.parse(run.context_json);
    delete context.agentConfig; delete context.agentEpochs;
    s.getDatabase().prepare('UPDATE work_runs SET context_json=? WHERE id=?').run(JSON.stringify(context),run.id);
    const old=a.profile('english');
    a.saveProfile({name:old.name,instructions:old.instructions,deliverable:old.deliverable,allow_material:0,allow_upstream:old.allow_upstream},'english',old.revision);
    if(w.currentWorkArtifact(w.getWorkItem(id),'english')) throw Error('legacy result remained current');
    try { p.startPractice(id,'english','legacy-practice',w.getWorkItem(id).revision,undefined,undefined,fetcher); throw Error('practice accepted stale result'); }
    catch(error) { if(error.status!==409) throw error; }
    if(!w.getWorkArtifacts(id).some(entry=>entry.id===artifact.id)) throw Error('old result lost');
  `);
});

test("preset update immediately cancels active quick generation and practice", () => {
  child(`
    const p=await import('${urls.practice}'); const api=await import('${apiUrl}');
    const normal=async(url)=>url.endsWith('/models')
      ? new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}),{status:200})
      : new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({content:'Synthetic current source',appliedCorrections:[]})}}]}),{status:200});
    await d.connect('synthetic-test-key',normal);
    const practiced=w.createWorkItem('Synthetic practice source','Synthetic notes',['english'],3,20);
    await flow.startWork(practiced,'source-ready',normal).completion;
    const active=w.createWorkItem('Synthetic active work','Synthetic notes',['english'],3,20);
    let release; const gate=new Promise(resolve=>{release=resolve});
    const delayed=async()=>{await gate; return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({content:'Late synthetic output',appliedCorrections:[]})}}]}),{status:200});};
    const workRun=flow.startWork(active,'active-work',delayed);
    const practiceRun=p.startPractice(practiced,'english','active-practice',w.getWorkItem(practiced).revision,undefined,undefined,delayed);
    const old=a.profile('english');
    const request=new Request('http://127.0.0.1:3901/api/agent-work',{method:'POST',headers:{host:'127.0.0.1:3901',origin:'http://127.0.0.1:3901','content-type':'application/json'},body:JSON.stringify({type:'profile.update',id:'english',revision:old.revision,name:old.name,instructions:'Updated synthetic instructions',deliverable:old.deliverable,allowMaterial:!!old.allow_material,allowUpstream:!!old.allow_upstream})});
    const response=await api.POST(request);
    if(response.status!==200) throw Error('profile update failed');
    if(w.getWorkRun(workRun.runId).status!=='cancelled' || p.getPracticeRun(practiceRun.runId).status!=='cancelled') throw Error('preset active work was not cancelled immediately');
    release(); await Promise.all([workRun.completion,practiceRun.completion]);
    if(w.getWorkArtifacts(active).length || w.workState().practices.some(round=>round.item_id===practiced && round.status==='question')) throw Error('late result committed');
  `);
});
