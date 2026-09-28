import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = new URL("../src/lib/agent-work.ts", import.meta.url).href;
const workflow = new URL("../src/lib/agent-workflow.ts", import.meta.url).href;
const store = new URL("../src/lib/store.ts", import.meta.url).href;
const deepseek = new URL("../src/lib/deepseek.ts", import.meta.url).href;
const route = new URL("../src/app/api/agent-work/route.ts", import.meta.url).href;
function child(script, path) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const a=await import('${root}'); const w=await import('${workflow}'); const s=await import('${store}'); const d=await import('${deepseek}'); ${script}`], { env: { ...process.env, AGENT_DB_PATH: path }, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
function isolated() { const folder = mkdtempSync(join(tmpdir(), "agent-custom-")); return { folder, path: join(folder, "agents.sqlite") }; }

test("additive migration preserves WAL history, backup, paused preset and idempotence", () => {
  const { folder, path } = isolated();
  child(`s.updateAgent('english',false,''); const database=s.getDatabase(); database.exec("CREATE TABLE legacy_probe (value TEXT)"); database.prepare("INSERT INTO legacy_probe VALUES ('kept')").run();`, path);
  child(`const first=a.agentState(); if(first.profiles.find(p=>p.id==='english').enabled!==0) throw Error('paused preset'); a.agentState();`, path);
  const backups = readdirSync(folder).filter(name => name.includes("backup-agent-work-"));
  assert.equal(backups.length, 1);
  const backup = new Database(join(folder, backups[0]), { readonly: true });
  assert.equal(backup.prepare("SELECT value FROM legacy_probe").get().value, "kept");
  backup.close();
  child(`if(a.agentState().profiles.find(p=>p.id==='english').enabled!==0) throw Error('lost pause'); a.setProfileEnabled('english',true,1); if(!a.profile('english').enabled || !s.getAgent('english').enabled) throw Error('restore');`, path);
  assert.equal(readdirSync(folder).filter(name => name.includes("backup-agent-work-")).length, 1);
});

test("existing profiles gain a content revision without losing their current version or backup", () => {
  const { folder, path } = isolated();
  child(`s.getDatabase();`, path);
  const old = new Database(path);
  old.exec(`CREATE TABLE agent_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL, deliverable TEXT NOT NULL,
    allow_material INTEGER NOT NULL, allow_upstream INTEGER NOT NULL, enabled INTEGER NOT NULL,
    revision INTEGER NOT NULL, template TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  old.prepare("INSERT INTO agent_profiles VALUES (?,?,?,?,?,?,?, ?,NULL,datetime('now'),datetime('now'))")
    .run("old-custom", "旧生活助手", "整理安排", "清单", 1, 0, 0, 4);
  old.close();
  child(`const entry=a.profile('old-custom'); if(entry.revision!==4 || entry.content_revision!==4 || entry.enabled!==0) throw Error('migration changed profile');`, path);
  const backups = readdirSync(folder).filter(name => name.includes("backup-agent-work-"));
  assert.equal(backups.length, 1);
  const backup = new Database(join(folder, backups[0]), { readonly: true });
  assert.equal(backup.prepare("SELECT revision FROM agent_profiles WHERE id='old-custom'").get().revision, 4);
  assert.equal(backup.prepare("PRAGMA table_info(agent_profiles)").all().some(column => column.name === "content_revision"), false);
  backup.close();
  child(`if(a.profile('old-custom').content_revision!==4) throw Error('repeat migration changed profile');`, path);
  assert.equal(readdirSync(folder).filter(name => name.includes("backup-agent-work-")).length, 1);
});

test("custom instances, preference scopes, provenance, ordered handoff and local invalidation", () => {
  const { path } = isolated();
  child(`
    const first=a.saveProfile({name:'阅读伙伴',instructions:'摘要',deliverable:'摘要',allow_material:1,allow_upstream:0});
    const second=a.saveProfile({name:'表达伙伴',instructions:'改写',deliverable:'表达',allow_material:0,allow_upstream:1});
    a.savePreference(first,'只列原文事实');
    const id=a.createJob('处理合成短文','虚构短文内容',[{agentId:first,upstream:[]},{agentId:second,upstream:[0]}]);
    const job=a.job(id); const input=a.inputFor(job,0);
    if(input.context.preferences.length!==1 || input.context.material!=='虚构短文内容') throw Error('first scope');
    const one=a.claimRun(id,0,'one','mock',input.context,input.inputHash);
    if(!one.newClaim || !a.finishRun(one.run.id,'success','摘要 v1',null)) throw Error('first run');
    const artifact=a.currentArtifact(a.job(id),0);
    const next=a.inputFor(a.job(id),1);
    if(next.context.material!==null || next.context.preferences.length || next.context.upstream.length!==1 || next.context.upstream[0].id!==artifact.id || next.context.upstream[0].version!==1 || next.context.upstream[0].content!=='摘要 v1') throw Error('handoff scope');
    const two=a.claimRun(id,1,'two','mock',next.context,next.inputHash);
    a.finishRun(two.run.id,'success','表达 v1',null);
    if(a.nextStep(a.job(id))!==-1) throw Error('complete');
    const history=a.artifactsFor(id);
    a.saveProfile({name:'表达伙伴新版',instructions:'改写更短',deliverable:'短表达',allow_material:0,allow_upstream:1},second,1);
    if(a.currentArtifact(a.job(id),0)?.id!==artifact.id || a.currentArtifact(a.job(id),1)!==null) throw Error('local invalidation');
    const oldConfig=JSON.parse(history[0].config_json);
    if(a.artifactsFor(id).length!==2 || oldConfig.name!=='表达伙伴' || oldConfig.allowMaterial!==false || oldConfig.allowUpstream!==true) throw Error('history or permission snapshot changed');
    const again=a.inputFor(a.job(id),1); const three=a.claimRun(id,1,'three','mock',again.context,again.inputHash); a.finishRun(three.run.id,'success','表达 v2',null);
    if(a.currentArtifact(a.job(id),1)?.version!==2) throw Error('new version');
  `, path);
});

test("revoked preference cannot enter a newly claimed run and unchanged profile does not invalidate", () => {
  const { path } = isolated();
  child(`
    const agent=a.saveProfile({name:'伙伴',instructions:'摘要',deliverable:'文本',allow_material:1,allow_upstream:0});
    const id=a.createJob('合成请求','合成资料',[{agentId:agent,upstream:[]}]);
    a.savePreference(agent,'旧偏好');
    const stale=a.inputFor(a.job(id),0); const pref=a.agentState().preferences[0];
    a.updatePreference(pref.id,pref.text,false,pref.text,true);
    let blocked=false; try { a.claimRun(id,0,'stale','mock',stale.context,stale.inputHash); } catch { blocked=true; }
    if(!blocked) throw Error('revoked preference accepted');
    const fresh=a.inputFor(a.job(id),0); const run=a.claimRun(id,0,'fresh','mock',fresh.context,fresh.inputHash);
    a.finishRun(run.run.id,'success','保存的摘要',null);
    const artifact=a.currentArtifact(a.job(id),0);
    a.saveProfile({name:'伙伴',instructions:'摘要',deliverable:'文本',allow_material:1,allow_upstream:0},agent,1);
    if(a.profile(agent).revision!==1 || a.currentArtifact(a.job(id),0)?.id!==artifact.id) throw Error('no-op invalidated');
    if(a.setProfileEnabled(agent,true,1)!==false || a.currentArtifact(a.job(id),0)?.id!==artifact.id) throw Error('no-op toggle invalidated');
  `, path);
});

test("pausing a custom agent preserves existing open results but cancels in-flight work", () => {
  const { path } = isolated();
  child(`
    const agent=a.saveProfile({name:'生活助手',instructions:'整理安排',deliverable:'生活清单',allow_material:1,allow_upstream:0});
    const old=a.createJob('整理采购','牛奶和水果',[{agentId:agent,upstream:[]}]);
    const initial=a.inputFor(a.job(old),0); const first=a.claimRun(old,0,'initial','mock',initial.context,initial.inputHash);
    a.finishRun(first.run.id,'success','采购清单',null);
    const artifact=a.currentArtifact(a.job(old),0);
    const pending=a.createJob('整理家务','整理书桌',[{agentId:agent,upstream:[]}]);
    const pendingInput=a.inputFor(a.job(pending),0); const inFlight=a.claimRun(pending,0,'in-flight','mock',pendingInput.context,pendingInput.inputHash);
    a.setProfileEnabled(agent,false,1);
    if(a.currentArtifact(a.job(old),0)?.id!==artifact.id) throw Error('pause invalidated old result');
    a.acceptArtifact(old,artifact.id,1);
    if(a.finishRun(inFlight.run.id,'success','迟到家务结果',null) || a.artifactsFor(pending).length) throw Error('paused run committed');
    a.setProfileEnabled(agent,true,2);
    if(a.currentArtifact(a.job(old),0)?.id!==artifact.id) throw Error('resume invalidated old result');
    a.setJobLifecycle(old,'complete',1);
    const fresh=a.inputFor(a.job(pending),0); const run=a.claimRun(pending,0,'manual','mock',fresh.context,fresh.inputHash);
    a.finishRun(run.run.id,'success','家务清单',null);
    if(!a.currentArtifact(a.job(pending),0)) throw Error('manual continuation failed');
    a.saveProfile({name:'生活助手',instructions:'仅整理一项家务',deliverable:'生活清单',allow_material:1,allow_upstream:0},agent,3);
    if(a.currentArtifact(a.job(pending),0)) throw Error('real content edit kept stale result');
    if(a.job(old).lifecycle!=='completed' || a.currentArtifact(a.job(old),0)?.id!==artifact.id) throw Error('completed snapshot changed');
  `, path);
});

test("mock model uses exact upstream version and cancelled late response cannot commit", () => {
  const { path } = isolated();
  child(`
    const modelFetch=async (url, options) => {
      if(url.endsWith('/models')) return new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}),{status:200});
      const user=JSON.parse(JSON.parse(options.body).messages[1].content);
      const content=JSON.stringify({content:user.upstream.length?'英文改写':'短文摘要',appliedCorrections:[]});
      return new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200});
    };
    await d.connect('synthetic-test-key',modelFetch);
    const first=a.saveProfile({name:'阅读伙伴',instructions:'摘要',deliverable:'摘要',allow_material:1,allow_upstream:0});
    const second=a.saveProfile({name:'表达伙伴',instructions:'改写',deliverable:'表达',allow_material:0,allow_upstream:1});
    const id=a.createJob('处理合成材料','合成短文',[{agentId:first,upstream:[]},{agentId:second,upstream:[0]}]);
    await w.startAgentJob(id,'chain',modelFetch,1).completion;
    const artifacts=a.artifactsFor(id); if(artifacts.length!==2) throw Error('chain failed');
    const input=JSON.parse(a.runsFor(id).find(r=>r.step_index===1).context_json);
    const source=artifacts.find(r=>r.step_index===0);
    if(input.upstream[0].id!==source.id || input.upstream[0].version!==source.version || input.material!==null) throw Error('wrong source');
    const late=a.createJob('稍后取消','合成材料',[{agentId:first,upstream:[]}]);
    let resolve; const pending=new Promise(done=>{resolve=done});
    const delayed=async (url, options)=>{ await pending; return modelFetch(url,options); };
    const started=w.startAgentJob(late,'late',delayed,1);
    a.setProfileEnabled(first,false,1);
    resolve(); await started.completion;
    if(a.artifactsFor(late).length || a.runsFor(late)[0].status==='success') throw Error('late committed');
  `, path);
});

test("corrections stay within authorized source scope and request IDs cannot cross steps", () => {
  const { path } = isolated();
  child(`
    const first=a.saveProfile({name:'资料伙伴',instructions:'摘要',deliverable:'摘要',allow_material:1,allow_upstream:0});
    const second=a.saveProfile({name:'交接伙伴',instructions:'改写',deliverable:'表达',allow_material:0,allow_upstream:1});
    const id=a.createJob('处理合成资料','保密合成细节',[{agentId:first,upstream:[]},{agentId:second,upstream:[0]}]);
    a.correctJob(id,'合成事实字段 X',1);
    const one=a.inputFor(a.job(id),0);
    if(one.context.corrections.length!==1) throw Error('authorized correction missing');
    const run=a.claimRun(id,0,'same-id','mock',one.context,one.inputHash);
    if(a.claimRun(id,0,'same-id','mock',one.context,one.inputHash).newClaim) throw Error('duplicate claimed');
    let altered=false; try { a.claimRun(id,0,'same-id','mock',{...one.context,request:'other context'},one.inputHash); } catch(error) { altered=error.status===409; }
    if(!altered) throw Error('request ID reused with altered context');
    a.finishRun(run.run.id,'success','无私有字段摘要',null);
    const two=a.inputFor(a.job(id),1);
    if(two.context.corrections.length || two.context.material!==null) throw Error('unauthorized source leaked');
    let blocked=false; try { a.claimRun(id,1,'same-id','mock',two.context,two.inputHash); } catch { blocked=true; }
    if(!blocked) throw Error('request ID reused across steps');
    const artifact=a.currentArtifact(a.job(id),0);
    a.correctJob(id,'另一合成事实',2);
    if(a.currentArtifact(a.job(id),0) || a.currentArtifact(a.job(id),1)) throw Error('authorized upstream not invalidated');
    if(a.artifactsFor(id)[0].id!==artifact.id) throw Error('history lost');
  `, path);
});

test("orphaned run recovers after restart and only manual retry creates a result", () => {
  const { path } = isolated();
  const id = child(`
    const agent=a.saveProfile({name:'阅读伙伴',instructions:'摘要',deliverable:'摘要',allow_material:1,allow_upstream:0});
    const id=a.createJob('合成短文','虚构内容',[{agentId:agent,upstream:[]}]);
    const input=a.inputFor(a.job(id),0); a.claimRun(id,0,'orphan','mock',input.context,input.inputHash);
    console.log(id);
  `, path).trim();
  child(`
    const id='${id}'; const state=a.agentState();
    if(state.runs.find(run=>run.job_id===id)?.status!=='interrupted' || state.artifacts.some(artifact=>artifact.job_id===id)) throw Error('restart recovery');
    const fetcher=async (url)=>url.endsWith('/models') ? new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}),{status:200}) : new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({content:'恢复后的摘要',appliedCorrections:[]})}}]}),{status:200});
    await d.connect('synthetic-test-key',fetcher);
    await w.startAgentJob(id,'manual-retry',fetcher,1).completion;
    if(a.artifactsFor(id).length!==1 || a.runsFor(id).length!==2 || a.runsFor(id)[0].status!=='success') throw Error('manual retry');
  `, path);
});

test("partial failure keeps first artifact; correction creates a new version with evidence", () => {
  const { path } = isolated();
  child(`
    const model=async (url, options)=>{
      if(url.endsWith('/models')) return new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}),{status:200});
      const user=JSON.parse(JSON.parse(options.body).messages[1].content);
      if(user.upstream.length && !globalThis.retry) return new Response('unavailable',{status:503});
      const fact=user.corrections[0];
      const content=fact ? '摘要：'+fact.text : user.upstream.length ? '改写：'+user.upstream[0].content : '初版摘要';
      const checks=fact?[{id:fact.id,sourceText:fact.text,excerpt:fact.text}]:[];
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({content,appliedCorrections:checks})}}]}),{status:200});
    };
    await d.connect('synthetic-test-key',model);
    const first=a.saveProfile({name:'阅读伙伴',instructions:'摘要',deliverable:'摘要',allow_material:1,allow_upstream:0});
    const second=a.saveProfile({name:'表达伙伴',instructions:'改写',deliverable:'表达',allow_material:0,allow_upstream:1});
    const id=a.createJob('处理短文','虚构文本',[{agentId:first,upstream:[]},{agentId:second,upstream:[0]}]);
    await w.startAgentJob(id,'initial',model,1).completion;
    if(a.artifactsFor(id).length!==1 || a.runsFor(id)[0].status!=='failed') throw Error('partial failure');
    globalThis.retry=true;
    await w.startAgentJob(id,'retry-step',model,1).completion;
    if(a.artifactsFor(id).length!==2 || a.artifactsFor(id).find(artifact=>artifact.step_index===0).version!==1) throw Error('duplicate first step');
    a.correctJob(id,'合成事实 X',1);
    if(a.currentArtifact(a.job(id),0)) throw Error('correction did not invalidate');
    await w.startAgentJob(id,'after-correction',model,2).completion;
    const current=a.currentArtifact(a.job(id),0);
    if(current?.version!==2 || !current.content.includes('合成事实 X') || a.artifactsFor(id).length!==4) throw Error('correction version');
  `, path);
});

test("completed result stays visible after rename; archive does not revive stale result", () => {
  const { path } = isolated();
  child(`
    const agent=a.saveProfile({name:'旧名称',instructions:'摘要',deliverable:'摘要',allow_material:1,allow_upstream:0});
    const done=a.createJob('完成事项','合成文本',[{agentId:agent,upstream:[]}]);
    const input=a.inputFor(a.job(done),0); const run=a.claimRun(done,0,'done','mock',input.context,input.inputHash); a.finishRun(run.run.id,'success','旧摘要',null);
    const artifact=a.currentArtifact(a.job(done),0); a.acceptArtifact(done,artifact.id,1); a.setJobLifecycle(done,'complete',1);
    a.saveProfile({name:'新名称',instructions:'新职责',deliverable:'新摘要',allow_material:1,allow_upstream:0},agent,1);
    if(a.job(done).lifecycle!=='completed' || a.currentArtifact(a.job(done),0)?.id!==artifact.id) throw Error('completed snapshot missing');
    const archived=a.createJob('归档事项','合成文本',[{agentId:agent,upstream:[]}]);
    const next=a.inputFor(a.job(archived),0); const second=a.claimRun(archived,0,'archive','mock',next.context,next.inputHash); a.finishRun(second.run.id,'success','待归档摘要',null);
    a.saveProfile({name:'再次改名',instructions:'再次变化',deliverable:'摘要',allow_material:1,allow_upstream:0},agent,2);
    if(a.currentArtifact(a.job(archived),0)) throw Error('stale artifact revived before archive');
    a.setJobLifecycle(archived,'archive',1);
    if(a.currentArtifact(a.job(archived),0) || a.artifactsFor(archived).length!==1) throw Error('archive revived stale artifact or lost history');
  `, path);
});

test("lifecycle changes reject stale job edits after reopen", () => {
  const { path } = isolated();
  child(`
    const agent=a.saveProfile({name:'伙伴',instructions:'摘要',deliverable:'摘要',allow_material:1,allow_upstream:0});
    const id=a.createJob('原事项','合成资料',[{agentId:agent,upstream:[]}]);
    const input=a.inputFor(a.job(id),0); const run=a.claimRun(id,0,'lifecycle','mock',input.context,input.inputHash);
    a.finishRun(run.run.id,'success','摘要',null);
    a.acceptArtifact(id,a.currentArtifact(a.job(id),0).id,1);
    a.setJobLifecycle(id,'complete',1);
    a.setJobLifecycle(id,'reopen',2);
    let stale=false; try { a.updateJob(id,'旧标签覆盖','合成资料',a.stepsOf(a.job(id)),1); } catch(error) { stale=error.status===409; }
    if(!stale || a.job(id).request!=='原事项' || a.job(id).revision!==3) throw Error('stale lifecycle edit accepted');
  `, path);
});

test("bounded corrections can be archived without deleting history", () => {
  const { path } = isolated();
  child(`
    const agent=a.saveProfile({name:'伙伴',instructions:'摘要',deliverable:'摘要',allow_material:1,allow_upstream:0});
    const id=a.createJob('合成事项','合成资料',[{agentId:agent,upstream:[]}]);
    for(let i=0;i<12;i++) a.correctJob(id,'更正'+i,a.job(id).revision);
    let bounded=false; try { a.correctJob(id,'第十三条',a.job(id).revision); } catch(error) { bounded=error.status===409; }
    if(!bounded) throw Error('not bounded');
    const old=a.correctionsFor(id)[0];
    a.archiveCorrection(id,old.id,a.job(id).revision);
    if(a.correctionsFor(id).length!==11 || a.agentState().corrections.length!==12 || !a.agentState().corrections.find(entry=>entry.id===old.id && entry.active===0)) throw Error('history not preserved');
    a.correctJob(id,'替代纠正',a.job(id).revision);
    if(a.correctionsFor(id).length!==12) throw Error('capacity not released');
  `, path);
});

test("continuation reads only the accepted fixed version after source changes and archive", () => {
  const { path } = isolated();
  child(`
    const sourceAgent=a.saveProfile({name:'来源助手',instructions:'摘要',deliverable:'摘要',allow_material:1,allow_upstream:0});
    const receiver=a.saveProfile({name:'接收助手',instructions:'续写',deliverable:'后续稿',allow_material:0,allow_upstream:1});
    a.savePreference(sourceAgent,'来源私有偏好');
    const source=a.createJob('来源事项','来源私有资料',[{agentId:sourceAgent,upstream:[]}]);
    a.correctJob(source,'来源私有纠正',1);
    const first=a.inputFor(a.job(source),0);
    const run1=a.claimRun(source,0,'source-v1','mock',first.context,first.inputHash);
    a.finishRun(run1.run.id,'success','已确认 v1',null);
    const v1=a.currentArtifact(a.job(source),0);
    a.acceptArtifact(source,v1.id,a.job(source).revision);
    const target=a.createContinuationJob('后续事项','',[{agentId:receiver,upstream:[],source:true},{agentId:receiver,upstream:[],source:false}], '学习目标',source,v1.id,v1.version,a.job(source).revision);
    const firstTarget=a.inputFor(a.job(target),0);
    if(firstTarget.context.upstream.length!==1 || firstTarget.context.upstream[0].id!==v1.id || firstTarget.context.upstream[0].content!=='已确认 v1') throw Error('wrong fixed source');
    const exposed=JSON.stringify(firstTarget.context);
    if(exposed.includes('来源私有资料') || exposed.includes('来源私有纠正') || exposed.includes('来源私有偏好') || exposed.includes('学习目标')) throw Error('source or label leaked');
    a.updateJob(source,'来源事项更新','新来源资料',a.stepsOf(a.job(source)),a.job(source).revision);
    const second=a.inputFor(a.job(source),0);
    const run2=a.claimRun(source,0,'source-v2','mock',second.context,second.inputHash);
    a.finishRun(run2.run.id,'success','新版 v2',null);
    const v2=a.currentArtifact(a.job(source),0);
    a.acceptArtifact(source,v2.id,a.job(source).revision);
    a.setJobLifecycle(source,'archive',a.job(source).revision);
    if(a.inputFor(a.job(target),0).context.upstream[0].id!==v1.id || a.inputFor(a.job(target),0).context.upstream[0].content!=='已确认 v1') throw Error('source drifted after archive');
    const targetRun=a.claimRun(target,0,'target-v1','mock',firstTarget.context,firstTarget.inputHash);
    a.finishRun(targetRun.run.id,'success','后续成果',null);
    const secondTarget=a.inputFor(a.job(target),1);
    if(secondTarget.context.upstream.length || JSON.stringify(secondTarget.context).includes('已确认 v1')) throw Error('unselected step received source');
    const history=JSON.parse(a.artifactsFor(target)[0].upstream_json);
    if(history.length!==1 || history[0].id!==v1.id || history[0].version!==1 || a.job(target).target_label!=='学习目标') throw Error('provenance or label missing');
  `, path);
});

test("continuation rejects unconfirmed, forged, stale and unauthorized sources without a partial job", () => {
  const { path } = isolated();
  child(`
    const maker=a.saveProfile({name:'来源',instructions:'摘要',deliverable:'摘要',allow_material:1,allow_upstream:0});
    const receiver=a.saveProfile({name:'接收',instructions:'处理',deliverable:'成果',allow_material:0,allow_upstream:1});
    const blocked=a.saveProfile({name:'禁用上游',instructions:'处理',deliverable:'成果',allow_material:0,allow_upstream:0});
    const source=a.createJob('源','秘密资料',[{agentId:maker,upstream:[]}]);
    const input=a.inputFor(a.job(source),0); const run=a.claimRun(source,0,'unaccepted','mock',input.context,input.inputHash);
    a.finishRun(run.run.id,'success','源成果',null);
    const artifact=a.currentArtifact(a.job(source),0);
    const steps=[{agentId:receiver,upstream:[],source:true}];
    const attempt=(description,fn)=>{let denied=false; try{fn()}catch(error){denied=error.status===409 || error.status===400} if(!denied) throw Error(description)};
    attempt('unconfirmed',()=>a.createContinuationJob('续','',steps,'',source,artifact.id,artifact.version,a.job(source).revision));
    a.acceptArtifact(source,artifact.id,a.job(source).revision);
    attempt('forged id',()=>a.createContinuationJob('续','',steps,'',source,'fake',artifact.version,a.job(source).revision));
    attempt('forged version',()=>a.createContinuationJob('续','',steps,'',source,artifact.id,artifact.version+1,a.job(source).revision));
    attempt('wrong source job',()=>a.createContinuationJob('续','',steps,'','fake',artifact.id,artifact.version,a.job(source).revision));
    attempt('stale revision',()=>a.createContinuationJob('续','',steps,'',source,artifact.id,artifact.version,a.job(source).revision-1));
    attempt('unauthorized receiver',()=>a.createContinuationJob('续','',[{agentId:blocked,upstream:[],source:true}],'',source,artifact.id,artifact.version,a.job(source).revision));
    attempt('unauthorized later receiver',()=>a.createContinuationJob('续','',[{agentId:receiver,upstream:[],source:true},{agentId:blocked,upstream:[],source:true}],'',source,artifact.id,artifact.version,a.job(source).revision));
    attempt('no receiver',()=>a.createContinuationJob('续','',[{agentId:receiver,upstream:[],source:false}],'',source,artifact.id,artifact.version,a.job(source).revision));
    if(a.agentState().jobs.length!==1 || a.artifactsFor(source).length!==1) throw Error('failed create changed history');
    const target=a.createContinuationJob('续','',steps,'',source,artifact.id,artifact.version,a.job(source).revision);
    a.saveProfile({name:'接收',instructions:'处理',deliverable:'成果',allow_material:0,allow_upstream:0},receiver,1);
    let revoked=false; try{a.inputFor(a.job(target),0)}catch(error){revoked=error.status===409 && error.message.includes('无权')}
    if(!revoked || a.currentArtifact(a.job(target),0)) throw Error('revoked permission still reads source');
  `, path);
});

test("continuation link edits are revision guarded, reject cycles, and preserve run snapshots", () => {
  const { path } = isolated();
  child(`
    const agent=a.saveProfile({name:'助手',instructions:'处理',deliverable:'结果',allow_material:1,allow_upstream:1});
    const source=a.createJob('源','原资料',[{agentId:agent,upstream:[]}]);
    const sourceInput=a.inputFor(a.job(source),0); const sourceRun=a.claimRun(source,0,'link-source','mock',sourceInput.context,sourceInput.inputHash);
    a.finishRun(sourceRun.run.id,'success','源 v1',null);
    const artifact=a.currentArtifact(a.job(source),0); a.acceptArtifact(source,artifact.id,a.job(source).revision);
    const linked=[{agentId:agent,upstream:[],source:true}];
    const target=a.createContinuationJob('目标','',linked,'目标标签',source,artifact.id,1,a.job(source).revision);
    const oldInput=a.inputFor(a.job(target),0); const oldRun=a.claimRun(target,0,'link-target','mock',oldInput.context,oldInput.inputHash);
    a.finishRun(oldRun.run.id,'success','目标结果',null);
    const targetArtifact=a.currentArtifact(a.job(target),0); a.acceptArtifact(target,targetArtifact.id,a.job(target).revision);
    const oldSnapshot=a.runsFor(target)[0].context_json;
    let stale=false; try{a.updateContinuation(target,0,'新标签',linked,{jobId:source,artifactId:artifact.id,version:1,revision:a.job(source).revision})}catch(error){stale=error.status===409}
    if(!stale) throw Error('stale target revision accepted');
    let implicit=false; try{a.updateJob(target,'目标','',[{agentId:agent,upstream:[],source:false}],a.job(target).revision)}catch(error){implicit=error.status===409 || error.status===400}
    if(!implicit) throw Error('ordinary update changed source visibility');
    let cycle=false; try{a.updateContinuation(source,a.job(source).revision,'',linked,{jobId:target,artifactId:targetArtifact.id,version:1,revision:a.job(target).revision})}catch(error){cycle=error.status===409}
    if(!cycle || a.job(source).source_job_id) throw Error('cycle accepted');
    a.updateContinuation(target,a.job(target).revision,'取消后保留标签',[{agentId:agent,upstream:[],source:false}],null);
    if(a.job(target).source_artifact_id || a.job(target).target_label!=='取消后保留标签' || a.runsFor(target)[0].context_json!==oldSnapshot || a.artifactsFor(target)[0].id!==targetArtifact.id) throw Error('link cancellation changed history');
  `, path);
});

test("legacy job rows migrate with one consistent backup and explicit insert columns", () => {
  const { folder, path } = isolated();
  child(`
    const database=s.getDatabase();
    database.exec("CREATE TABLE agent_jobs (id TEXT PRIMARY KEY,request TEXT NOT NULL,material TEXT NOT NULL,steps_json TEXT NOT NULL,revision INTEGER NOT NULL,correction_revision INTEGER NOT NULL,status TEXT NOT NULL,lifecycle TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)");
    database.prepare("INSERT INTO agent_jobs VALUES (?,?,?,?,1,0,'planned','open',datetime('now'),datetime('now'))").run('old-job','旧事项','保留资料','[]');
  `, path);
  child(`
    const old=a.job('old-job');
    if(old.request!=='旧事项' || old.material!=='保留资料' || old.source_artifact_id!==null || old.target_label!=='') throw Error('legacy row changed');
    const agent=a.saveProfile({name:'助手',instructions:'摘要',deliverable:'摘要',allow_material:1,allow_upstream:0});
    if(!a.createJob('新事项','',[{agentId:agent,upstream:[]}])) throw Error('explicit insert failed');
  `, path);
  const backups = readdirSync(folder).filter(name => name.includes("backup-agent-work-"));
  assert.equal(backups.length, 1);
  const backup = new Database(join(folder, backups[0]), { readonly: true });
  assert.equal(backup.prepare("SELECT material FROM agent_jobs WHERE id='old-job'").get().material, "保留资料");
  assert.equal(backup.prepare("PRAGMA table_info(agent_jobs)").all().some(column => column.name === "source_artifact_id"), false);
  backup.close();
  child(`if(a.job('old-job').request!=='旧事项') throw Error('repeat migration changed row');`, path);
  assert.equal(readdirSync(folder).filter(name => name.includes("backup-agent-work-")).length, 1);
});

test("in-flight continuation loses permission without committing a late result", () => {
  const { path } = isolated();
  child(`
    const agent=a.saveProfile({name:'助手',instructions:'摘要',deliverable:'摘要',allow_material:1,allow_upstream:1});
    const source=a.createJob('来源','资料',[{agentId:agent,upstream:[]}]);
    const src=a.inputFor(a.job(source),0); const srcRun=a.claimRun(source,0,'late-source','mock',src.context,src.inputHash);
    a.finishRun(srcRun.run.id,'success','已确认来源',null);
    const artifact=a.currentArtifact(a.job(source),0); a.acceptArtifact(source,artifact.id,a.job(source).revision);
    const target=a.createContinuationJob('目标','',[{agentId:agent,upstream:[],source:true}],'',source,artifact.id,1,a.job(source).revision);
    const input=a.inputFor(a.job(target),0); const run=a.claimRun(target,0,'late-target','mock',input.context,input.inputHash);
    a.saveProfile({name:'助手',instructions:'摘要',deliverable:'摘要',allow_material:1,allow_upstream:0},agent,a.profile(agent).revision);
    if(a.finishRun(run.run.id,'success','迟到成果',null) || a.artifactsFor(target).length || a.runsFor(target)[0].status!=='cancelled') throw Error('late result committed');
    if(!a.runsFor(target)[0].context_json.includes('已确认来源') || !a.artifactsFor(source)[0].accepted_at) throw Error('run snapshot or source changed');
  `, path);
});

test("route creates a continuation with the documented payload and rejects stale source selection", () => {
  const { path } = isolated();
  child(`
    const api=await import('${route}');
    const agent=a.saveProfile({name:'助手',instructions:'摘要',deliverable:'摘要',allow_material:1,allow_upstream:1});
    const source=a.createJob('来源','资料',[{agentId:agent,upstream:[]}]);
    const input=a.inputFor(a.job(source),0); const run=a.claimRun(source,0,'api-source','mock',input.context,input.inputHash);
    a.finishRun(run.run.id,'success','来源成果',null);
    const artifact=a.currentArtifact(a.job(source),0); a.acceptArtifact(source,artifact.id,a.job(source).revision);
    const body={type:'job.continue',sourceJobId:source,sourceArtifactId:artifact.id,sourceVersion:artifact.version,sourceRevision:a.job(source).revision,request:'继续',material:'',targetLabel:'本周',steps:[{agentId:agent,upstream:[],source:true}]};
    const send=async value=>api.POST(new Request('http://127.0.0.1:3000/api/agent-work',{method:'POST',headers:{host:'127.0.0.1:3000',origin:'http://127.0.0.1:3000','content-type':'application/json'},body:JSON.stringify(value)}));
    const made=await send(body); if(made.status!==200) throw Error('route create '+made.status);
    const data=await made.json(); if(data.state.jobs.find(j=>j.id===data.id)?.source_artifact_id!==artifact.id) throw Error('route state missing source');
    const stale=await send({...body,sourceRevision:0}); if(stale.status!==400) throw Error('invalid revision accepted');
    const forged=await send({...body,sourceArtifactId:'forged'}); if(forged.status!==409) throw Error('forged source accepted');
  `, path);
});
