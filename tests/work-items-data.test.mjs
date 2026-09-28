import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

const folder = mkdtempSync(join(tmpdir(), "agent-work-items-"));
const path = join(folder, "agents.sqlite");
const moduleUrl = new URL("../src/lib/work-items.ts", import.meta.url).href;
function child(script) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const w=await import('${moduleUrl}'); const s=await import('${new URL("../src/lib/store.ts", import.meta.url).href}'); const ctx=(id,role,upstream=null)=>{const item=w.getWorkItem(id);return {request:item.request,material:item.material,englishRequirement:role==='english'?item.english_requirement:'',facts:w.getWorkFacts(id).map(f=>({id:f.id,text:f.text,revision:f.revision})),preferences:w.getActivePreferences(role).map(p=>({id:p.id,role:p.role,text:p.text})),upstream:upstream?{id:upstream.id,version:upstream.version,revision:upstream.revision,content:upstream.content}:null,agentEpochs:Object.fromEntries(w.rolesOf(item).map(r=>[r,s.getAgentEpoch(r)])),revision:item.revision,minutes:item.minutes,priority:item.priority}}; ${script}`], { env: { ...process.env, AGENT_DB_PATH: path }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("new tables preserve old records, back up consistently and migrate idempotently", () => {
  const old = new Database(path);
  old.exec("CREATE TABLE IF NOT EXISTS legacy_probe (id TEXT PRIMARY KEY, value TEXT); INSERT INTO legacy_probe VALUES ('old','kept');");
  old.pragma("journal_mode = WAL");
  old.prepare("INSERT INTO legacy_probe VALUES ('wal','kept')").run();
  child("w.workState(); w.workState();");
  const backup = readdirSync(folder).find(name => name.includes("backup-work-items-"));
  assert.ok(backup);
  const saved = new Database(join(folder, backup), { readonly: true });
  assert.equal(saved.prepare("SELECT value FROM legacy_probe WHERE id='wal'").get().value, "kept");
  saved.close();
  child("w.workState();");
  assert.equal(readdirSync(folder).filter(name => name.includes("backup-work-items-")).length, 1);
  assert.equal(old.prepare("SELECT value FROM legacy_probe WHERE id='old'").get().value, "kept");
  old.close();
});

test("existing work item versions survive concurrent additive migration", async () => {
  const folder = mkdtempSync(join(tmpdir(), "agent-old-work-items-"));
  const oldPath = join(folder, "agents.sqlite");
  const old = new Database(oldPath);
  old.exec(`
    CREATE TABLE work_items (id TEXT PRIMARY KEY,request TEXT NOT NULL,material TEXT NOT NULL DEFAULT '',roles TEXT NOT NULL,priority INTEGER NOT NULL,minutes INTEGER NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE work_runs (id TEXT PRIMARY KEY,item_id TEXT NOT NULL,role TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,model TEXT NOT NULL,revision INTEGER NOT NULL,context_json TEXT NOT NULL,upstream_artifact_id TEXT,owner_pid INTEGER NOT NULL,error TEXT,created_at TEXT NOT NULL,finished_at TEXT);
    CREATE TABLE work_artifacts (id TEXT PRIMARY KEY,item_id TEXT NOT NULL,role TEXT NOT NULL,version INTEGER NOT NULL,revision INTEGER NOT NULL,content TEXT NOT NULL,run_id TEXT NOT NULL UNIQUE,upstream_artifact_id TEXT,created_at TEXT NOT NULL,UNIQUE(item_id,role,version));
    INSERT INTO work_items VALUES ('old-item','Old request','Private notes','["career"]',3,45,3,'ready',datetime('now'),datetime('now'));
    INSERT INTO work_runs VALUES ('old-run','old-item','career','old-request','success','mock',3,'{}',NULL,1,NULL,datetime('now'),datetime('now'));
    INSERT INTO work_artifacts VALUES ('old-artifact','old-item','career',2,3,'Old saved result','old-run',NULL,datetime('now'));
  `);
  old.close();
  const script = `const w=await import('${moduleUrl}');const item=w.workState().items.find(i=>i.id==='old-item');if(!item||item.lifecycle!=='open'||item.career_revision!==3||item.english_revision!==3||item.source_context_json!=='[]'||w.currentWorkArtifact(item,'career')?.content!=='Old saved result')process.exit(2);`;
  const run = () => new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: { ...process.env, AGENT_DB_PATH: oldPath } });
    let error = "";
    processChild.stderr.on("data", chunk => { error += chunk; });
    processChild.on("error", reject);
    processChild.on("close", code => code === 0 ? resolve(undefined) : reject(new Error(`migration child ${code}: ${error}`)));
  });
  await Promise.all([run(), run()]);
  assert.ok(readdirSync(folder).some(name => name.includes("backup-work-items-")));
});

test("item, correction and artifact versions retain provenance", () => {
  child(`
    const id=w.createWorkItem('Prepare for an interview','Participated in a project',['career','english'],3,45);
    if(!w.addWorkCorrection(id,'I supported research, not delivery ownership',w.getWorkItem(id).revision)) process.exit(2);
    const first=w.claimWorkRun(id,'career','request-one','mock',ctx(id,'career'),null);
    if(!first || !w.completeWorkRun(first.id,'success','Chinese outline',null)) process.exit(3);
    const career=w.getWorkArtifacts(id)[0];
    const second=w.claimWorkRun(id,'english','request-two','mock',ctx(id,'english',career),career.id);
    if(!second || !w.completeWorkRun(second.id,'success','English introduction',null)) process.exit(4);
    if(!w.addWorkCorrection(id,'Use a modest tone',w.getWorkItem(id).revision)) process.exit(5);
    const third=w.claimWorkRun(id,'career','request-three','mock',ctx(id,'career'),null);
    if(!third || !w.completeWorkRun(third.id,'success','Updated outline',null)) process.exit(6);
    const versions=w.getWorkArtifacts(id).filter(a=>a.role==='career');
    if(versions.length!==2 || versions[0].version!==2 || versions[1].version!==1 || versions[1].content!=='Chinese outline') process.exit(7);
    if(w.getWorkArtifacts(id).find(a=>a.role==='english').upstream_artifact_id!==career.id) process.exit(8);
  `);
});

test("accepted work completes, leaves attention, archives and reopens without losing history", () => {
  child(`
    const id=w.createWorkItem('Practice a fictional interview','Fictional source',['career'],3,30);
    const run=w.claimWorkRun(id,'career','lifecycle-run','mock',ctx(id,'career'),null);
    if(w.setWorkLifecycle(id,'archive',1)) process.exit(2);
    w.completeWorkRun(run.id,'success','Fictional result',null);
    const artifact=w.getWorkArtifacts(id)[0];
    if(w.setWorkLifecycle(id,'complete',1)) process.exit(3);
    if(!w.acceptWorkArtifact(id,artifact.id,1) || !w.setWorkLifecycle(id,'complete',1)) process.exit(4);
    if(w.getWorkItem(id).lifecycle!=='completed' || !w.setWorkLifecycle(id,'archive',1)) process.exit(5);
    if(!w.setWorkLifecycle(id,'reopen',1) || w.getWorkArtifacts(id)[0].accepted_at===null) process.exit(6);
  `);
});

test("completion requires an explicit matching acknowledgement of unfinished current practice", () => {
  child(`
    const id=w.createWorkItem('Fictional bilingual interview','Fictional facts',['career','english'],3,30);
    const careerRun=w.claimWorkRun(id,'career','finish-career','mock',ctx(id,'career'),null);
    w.completeWorkRun(careerRun.id,'success','Chinese outline',null);
    const career=w.currentWorkArtifact(w.getWorkItem(id),'career');
    const englishRun=w.claimWorkRun(id,'english','finish-english','mock',ctx(id,'english',career),career.id);
    w.completeWorkRun(englishRun.id,'success','English introduction',null);
    const english=w.currentWorkArtifact(w.getWorkItem(id),'english');
    w.acceptWorkArtifact(id,career.id,1); w.acceptWorkArtifact(id,english.id,1);
    const db=s.getDatabase();
    db.prepare("INSERT INTO work_practices (id,item_id,role,source_artifact_id,question,answer,feedback,suggestion,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'question',datetime('now'),datetime('now'))").run('career-question',id,'career',career.id,'Tell me about the project',null,null,null);
    db.prepare("INSERT INTO work_practices (id,item_id,role,source_artifact_id,question,answer,feedback,suggestion,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'feedback',datetime('now'),datetime('now'))").run('english-feedback',id,'english',english.id,'Introduce yourself','I observed interviews.','Good start.','Add detail.');
    if(w.setWorkLifecycle(id,'complete',1)) process.exit(2);
    if(w.setWorkLifecycle(id,'complete',1,['career-question'])) process.exit(3);
    if(w.setWorkLifecycle(id,'complete',1,['english-feedback'],true)) process.exit(4);
    if(!w.setWorkLifecycle(id,'complete',1,['career-question'],true)) process.exit(5);
    if(w.workState().practices.find(round=>round.id==='career-question')?.status!=='question') process.exit(6);
    if(!w.setWorkLifecycle(id,'reopen',1) || w.getWorkItem(id).status!=='ready') process.exit(7);
  `);
});

test("time edits keep accepted artifacts and English-only edits preserve current Chinese source", () => {
  child(`
    const id=w.createWorkItem('Fictional English interview','Fictional facts',['career','english'],3,45);
    const a=w.claimWorkRun(id,'career','dep-career','mock',ctx(id,'career'),null);
    w.completeWorkRun(a.id,'success','中文虚构内容',null);
    const career=w.currentWorkArtifact(w.getWorkItem(id),'career');
    const b=w.claimWorkRun(id,'english','dep-english','mock',ctx(id,'english',career),career.id);
    w.completeWorkRun(b.id,'success','English fictional content',null);
    const english=w.currentWorkArtifact(w.getWorkItem(id),'english');
    w.acceptWorkArtifact(id,career.id,1); w.acceptWorkArtifact(id,english.id,1);
    if(!w.reviseWorkItem(id,'Fictional English interview','Fictional facts','',['career','english'],20,3,1)) process.exit(2);
    let item=w.getWorkItem(id);
    if(item.revision!==2 || item.status!=='ready' || w.currentWorkArtifact(item,'career')?.id!==career.id || w.currentWorkArtifact(item,'english')?.id!==english.id || !w.setWorkLifecycle(id,'complete',2)) process.exit(3);
    w.setWorkLifecycle(id,'reopen',2);
    if(!w.reviseWorkItem(id,item.request,item.material,'Keep English under one minute',['career','english'],20,3,2)) process.exit(4);
    item=w.getWorkItem(id);
    if(item.career_revision!==1 || item.english_revision!==3 || w.currentWorkArtifact(item,'career')?.id!==career.id || w.currentWorkArtifact(item,'english')) process.exit(5);
    const c=w.claimWorkRun(id,'english','dep-english-new','mock',ctx(id,'english',career),career.id);
    if(!c || !w.completeWorkRun(c.id,'success','Short English result',null)) process.exit(6);
    if(w.currentWorkArtifact(w.getWorkItem(id),'english')?.upstream_artifact_id!==career.id || w.getWorkArtifacts(id).length!==3) process.exit(7);
  `);
});

test("a role generated after a time edit uses its unchanged content revision", () => {
  child(`
    const id=w.createWorkItem('Fictional interview','Fictional facts',['career','english'],3,45);
    const first=w.claimWorkRun(id,'career','time-career','mock',ctx(id,'career'),null);
    w.completeWorkRun(first.id,'success','中文提纲',null);
    const career=w.currentWorkArtifact(w.getWorkItem(id),'career');
    if(!w.reviseWorkItem(id,'Fictional interview','Fictional facts','',['career','english'],20,3,1)) process.exit(2);
    const item=w.getWorkItem(id);
    const second=w.claimWorkRun(id,'english','time-english','mock',ctx(id,'english',career),career.id);
    if(!second || !w.completeWorkRun(second.id,'success','English introduction',null)) process.exit(3);
    const english=w.currentWorkArtifact(w.getWorkItem(id),'english');
    if(second.revision!==2 || english?.revision!==item.english_revision || english.upstream_artifact_id!==career.id || w.getWorkItem(id).status!=='ready') process.exit(4);
  `);
});

test("explicit role edits add handoff without discarding historical outputs", () => {
  child(`
    const id=w.createWorkItem('Groceries','Eggs and milk',[],2,20);
    if(!w.reviseWorkItem(id,'Translate my grocery list','Eggs and milk','',['english'],20,2,1)) process.exit(2);
    let item=w.getWorkItem(id);
    if(item.status!=='planned' || w.rolesOf(item).join()!=='english') process.exit(3);
    const e=w.claimWorkRun(id,'english','role-english','mock',ctx(id,'english'),null);
    w.completeWorkRun(e.id,'success','Eggs and milk',null);
    if(!w.reviseWorkItem(id,item.request,item.material,'',[],20,2,2)) process.exit(4);
    item=w.getWorkItem(id);
    if(item.status!=='limited' || w.getWorkArtifacts(id).length!==1) process.exit(5);
    if(!w.reviseWorkItem(id,item.request,item.material,'',['career','english'],20,2,3)) process.exit(6);
    item=w.getWorkItem(id);
    if(w.currentWorkArtifact(item,'english') || item.career_revision!==4 || item.english_revision!==4) process.exit(7);
    const c=w.claimWorkRun(id,'career','role-career','mock',ctx(id,'career'),null);
    w.completeWorkRun(c.id,'success','中文清单',null);
    const career=w.currentWorkArtifact(w.getWorkItem(id),'career');
    const e2=w.claimWorkRun(id,'english','role-english-new','mock',ctx(id,'english',career),career.id);
    w.completeWorkRun(e2.id,'success','Translated from Chinese list',null);
    if(w.currentWorkArtifact(w.getWorkItem(id),'english')?.upstream_artifact_id!==career.id || w.getWorkArtifacts(id).length!==3) process.exit(8);
  `);
});

test("handoff rejects another item or stale revision and empty success becomes failure", () => {
  child(`
    const a=w.createWorkItem('Career and English','Own facts',['career','english'],3,40);
    const b=w.createWorkItem('Another career and English task','Private facts',['career','english'],3,40);
    const first=w.claimWorkRun(a,'career','source-career','mock',ctx(a,'career'),null);
    w.completeWorkRun(first.id,'success','Source outline',null);
    const source=w.getWorkArtifacts(a)[0];
    if(w.claimWorkRun(b,'english','cross-item','mock',ctx(b,'english',source),source.id)) process.exit(2);
    const newerRun=w.claimWorkRun(a,'career','newer-career','mock',ctx(a,'career'),null);
    w.completeWorkRun(newerRun.id,'success','Newer outline',null);
    if(w.claimWorkRun(a,'english','old-version','mock',ctx(a,'english',source),source.id)) process.exit(7);
    const newer=w.getWorkArtifacts(a).find(artifact=>artifact.role==='career');
    const valid=w.claimWorkRun(a,'english','new-version','mock',ctx(a,'english',newer),newer.id);
    if(!valid || !w.completeWorkRun(valid.id,'success','English based on newer outline',null)) process.exit(8);
    w.addWorkCorrection(a,'Different factual correction',w.getWorkItem(a).revision);
    if(w.claimWorkRun(a,'english','old-revision','mock',ctx(a,'english',source),source.id)) process.exit(3);
    const run=w.claimWorkRun(a,'career','empty-output','mock',ctx(a,'career'),null);
    if(!w.completeWorkRun(run.id,'success',null,null)) process.exit(4);
    if(w.getWorkRun(run.id).status!=='failed' || w.getWorkItem(a).status!=='failed') process.exit(5);
  `);
});

test("atomic claim rejects stale input and preference snapshots; final success is ready in one transaction", () => {
  child(`
    const id=w.createWorkItem('Prepare a career story','Old material',['career'],3,30);
    const oldContext=ctx(id,'career');
    w.updateWorkItem(id,'New material',30,3,w.getWorkItem(id).revision);
    if(w.claimWorkRun(id,'career','stale-input','mock',oldContext,null)) process.exit(2);
    const pref=w.saveWorkPreference('career','Concise wording');
    const stalePreference=ctx(id,'career');
    w.updateWorkPreference(pref,'Concise wording',false,'Concise wording',true);
    if(w.claimWorkRun(id,'career','stale-preference','mock',stalePreference,null)) process.exit(3);
    const run=w.claimWorkRun(id,'career','current','mock',ctx(id,'career'),null);
    if(!run || !w.completeWorkRun(run.id,'success','中文成果',null)) process.exit(4);
    if(w.getWorkItem(id).status!=='ready') process.exit(5);
  `);
});
