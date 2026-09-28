import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const path = join(mkdtempSync(join(tmpdir(), "agent-correction-")), "agents.sqlite");
const workflowUrl = new URL("../src/lib/workflow.ts", import.meta.url).href;
const itemsUrl = new URL("../src/lib/work-items.ts", import.meta.url).href;
const deepseekUrl = new URL("../src/lib/deepseek.ts", import.meta.url).href;
test("arbitrary correction updates both versions; preferences are explicit, scoped and revocable", () => {
  const script = `
    const flow=await import('${workflowUrl}'); const w=await import('${itemsUrl}'); const d=await import('${deepseekUrl}');
    const inputs=[];
    const fetcher=async(url,init)=>{
      if(url.endsWith('/models')) return {ok:true,json:async()=>({data:[{id:'deepseek-flash'}]})};
      const payload=JSON.parse(init.body); const context=JSON.parse(payload.messages[1].content); inputs.push(context);
      const career=payload.messages[0].content.includes('求职顾问');
      const content=career ? '中文：'+(context.facts.at(-1)?.text||context.material) : 'English: '+(context.upstream?.content||context.material)+' '+context.preferences.map(p=>p.text).join(' ');
      return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({content,appliedCorrections:context.facts.map(fact=>({id:fact.id,sourceText:fact.text,excerpt:fact.text}))})}}]})};
    };
    await d.connect('test-only',fetcher);
    const first=w.createWorkItem('Prepare a career story in English','Private first item notes',['career','english'],3,45);
    await flow.startWork(first,'initial',fetcher).completion;
    const firstCareer=w.getWorkArtifacts(first).find(a=>a.role==='career');
    const firstEnglish=w.getWorkArtifacts(first).find(a=>a.role==='english');
    w.addWorkCorrection(first,'My actual role was supporting research, not owning delivery',w.getWorkItem(first).revision);
    await flow.startWork(first,'after-correction',fetcher).completion;
    const updated=w.getWorkArtifacts(first);
    const newCareer=updated.find(a=>a.role==='career'); const newEnglish=updated.find(a=>a.role==='english');
    if(updated.length!==4 || newCareer.version!==2 || newEnglish.version!==2 || newEnglish.upstream_artifact_id!==newCareer.id) process.exit(2);
    if(!newCareer.content.includes('supporting research') || !newEnglish.content.includes('supporting research')) process.exit(3);
    if(firstCareer.content===newCareer.content || firstEnglish.content===newEnglish.content) process.exit(4);
    const pref=w.saveWorkPreference('english','Use plain vocabulary');
    const second=w.createWorkItem('English writing task','Second item only',['english'],3,20);
    await flow.startWork(second,'with-preference',fetcher).completion;
    const secondRun=w.workState().runs.find(r=>r.item_id===second);
    if(!secondRun.context_json.includes('Use plain vocabulary') || secondRun.context_json.includes('Private first item notes')) process.exit(5);
    w.updateWorkPreference(pref,'Use plain vocabulary',false,'Use plain vocabulary',true);
    const third=w.createWorkItem('Another English writing task','Third item only',['english'],3,20);
    await flow.startWork(third,'after-revoke',fetcher).completion;
    const thirdRun=w.workState().runs.find(r=>r.item_id===third);
    if(thirdRun.context_json.includes('Use plain vocabulary') || !secondRun.context_json.includes('Use plain vocabulary')) process.exit(6);
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: { ...process.env, AGENT_DB_PATH: path }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("uncited correction is rejected and preference capacity is explicit", () => {
  const isolated = join(mkdtempSync(join(tmpdir(), "agent-correction-gate-")), "agents.sqlite");
  const script = `
    const flow=await import('${workflowUrl}'); const w=await import('${itemsUrl}'); const d=await import('${deepseekUrl}');
    const fetcher=async(url)=>url.endsWith('/models')
      ? {ok:true,json:async()=>({data:[{id:'deepseek-flash'}]})}
      : {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({content:'I owned delivery'})}}]})};
    await d.connect('test-only',fetcher);
    const id=w.createWorkItem('Career story','I owned delivery',['career'],3,30);
    w.addWorkCorrection(id,'I only observed research',w.getWorkItem(id).revision);
    await flow.startWork(id,'uncited',fetcher).completion;
    if(w.getWorkItem(id).status!=='failed' || w.getWorkArtifacts(id).length!==0 || !w.workState().runs[0].error.includes('纠正')) process.exit(2);
    for(let i=0;i<5;i++) if(!w.saveWorkPreference('english','Preference '+i)) process.exit(3);
    if(w.saveWorkPreference('english','Sixth preference')!==null || w.getActivePreferences('english').length!==5) process.exit(4);
    const s=await import('${new URL("../src/lib/store.ts", import.meta.url).href}');
    s.getDatabase().prepare("INSERT INTO work_preferences VALUES (?,?,?,1,datetime('now'),datetime('now'))").run('older-sixth','english','Historical active preference');
    let flagged=false; try { w.getActivePreferences('english'); } catch(error) { flagged=error.message.includes('超过 5 条'); }
    if(!flagged || w.workState().preferences.filter(p=>p.active).length!==6) process.exit(5);
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: { ...process.env, AGENT_DB_PATH: isolated }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("correction citation tolerates whitespace changes but still needs a matching passage", () => {
  const isolated = join(mkdtempSync(join(tmpdir(), "agent-correction-whitespace-")), "agents.sqlite");
  const script = `
    const flow=await import('${workflowUrl}'); const w=await import('${itemsUrl}'); const d=await import('${deepseekUrl}');
    let excerpt='Use active recall';
    const fetcher=async(url,init)=>{
      if(url.endsWith('/models')) return {ok:true,json:async()=>({data:[{id:'deepseek-flash'}]})};
      const context=JSON.parse(JSON.parse(init.body).messages[1].content);
      return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({content:'Use active\\nrecall in 25 minutes.',appliedCorrections:[{id:context.facts[0].id,sourceText:context.facts[0].text,excerpt}]})}}]})};
    };
    await d.connect('test-only',fetcher);
    const id=w.createWorkItem('Review vocabulary','',['english'],3,25);
    w.addWorkCorrection(id,'Use active recall',w.getWorkItem(id).revision);
    await flow.startWork(id,'whitespace-citation',fetcher).completion;
    if(w.getWorkItem(id).status!=='ready') process.exit(2);
    const other=w.createWorkItem('Review vocabulary again','',['english'],3,25);
    w.addWorkCorrection(other,'Use active recall',w.getWorkItem(other).revision);
    excerpt='Unrelated answer';
    await flow.startWork(other,'wrong-citation',fetcher).completion;
    if(w.getWorkItem(other).status!=='failed') process.exit(3);
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: { ...process.env, AGENT_DB_PATH: isolated }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
