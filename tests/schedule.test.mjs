import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const workUrl = new URL("../src/lib/work-items.ts", import.meta.url).href;
const agentUrl = new URL("../src/lib/agent-work.ts", import.meta.url).href;
const storeUrl = new URL("../src/lib/store.ts", import.meta.url).href;
const workRouteUrl = new URL("../src/app/api/work-items/route.ts", import.meta.url).href;
const agentRouteUrl = new URL("../src/app/api/agent-work/route.ts", import.meta.url).href;
function isolated() { const folder = mkdtempSync(join(tmpdir(), "agent-schedule-")); return { folder, path: join(folder, "agents.sqlite") }; }
function child(path, script) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const w=await import('${workUrl}');const a=await import('${agentUrl}');const s=await import('${storeUrl}');const wr=await import('${workRouteUrl}');const ar=await import('${agentRouteUrl}');${script}`], { env: { ...process.env, AGENT_DB_PATH: path }, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("both create routes accept due-only dates and reject invalid calendar or date order", () => {
  const { path } = isolated();
  child(path, `
    const req=(path,body)=>new Request('http://127.0.0.1:3901'+path,{method:'POST',headers:{host:'127.0.0.1:3901',origin:'http://127.0.0.1:3901','content-type':'application/json'},body:JSON.stringify(body)});
    const agent=a.saveProfile({name:'日程助手',instructions:'整理',deliverable:'结果',allow_material:1,allow_upstream:0});
    const workBody={type:'create',request:'快捷事项',material:'',roles:['career'],priority:3,minutes:30,plannedDate:null,dueDate:'2028-02-29'};
    const work=await (await wr.POST(req('/api/work-items',workBody))).json();
    const item=work.state.items.find(row=>row.id===work.id);
    if(item.planned_date!==null || item.due_date!=='2028-02-29' || item.schedule_revision!==1) throw Error('due-only work create');
    const agentBody={type:'job.create',request:'Agent 事项',material:'',steps:[{agentId:agent,upstream:[]}],plannedDate:null,dueDate:'2028-02-29'};
    const made=await (await ar.POST(req('/api/agent-work',agentBody))).json();
    const job=made.state.jobs.find(row=>row.id===made.id);
    if(job.planned_date!==null || job.due_date!=='2028-02-29' || job.schedule_revision!==1) throw Error('due-only agent create');
    for(const bad of ['2027-02-29','2028-02-30','2028-13-01','0000-01-01','2028-2-09','2028-02-29T00:00:00','']) {
      if((await wr.POST(req('/api/work-items',{...workBody,dueDate:bad}))).status!==400) throw Error('invalid work date accepted: '+bad);
      if((await ar.POST(req('/api/agent-work',{...agentBody,dueDate:bad}))).status!==400) throw Error('invalid agent date accepted: '+bad);
    }
    if((await wr.POST(req('/api/work-items',{...workBody,plannedDate:'2028-03-01'}))).status!==400) throw Error('work reversed dates');
    if((await ar.POST(req('/api/agent-work',{...agentBody,plannedDate:'2028-03-01'}))).status!==400) throw Error('agent reversed dates');
    if(w.workState().items.length!==1 || a.agentState().jobs.length!==1) throw Error('invalid create wrote records');
  `);
});

test("schedule CAS is independent of content and preserves in-flight results in both chains", () => {
  const { path } = isolated();
  child(path, `
    const agent=a.saveProfile({name:'日程助手',instructions:'整理',deliverable:'结果',allow_material:1,allow_upstream:0});
    const work=w.createWorkItem('快捷事项','虚构资料',['career'],3,30);
    const item=w.getWorkItem(work);
    const context={request:item.request,material:item.material,englishRequirement:'',facts:[],preferences:[],upstream:null,agentEpochs:{career:s.getAgentEpoch('career')},revision:item.revision,minutes:item.minutes,priority:item.priority};
    const running=w.claimWorkRun(work,'career','schedule-work','mock',context,null);
    if(!running || running.status!=='running') throw Error('work claim');
    const workContext=running.context_json;
    if(w.setWorkSchedule(work,null,'2028-02-29',1)!==2) throw Error('work schedule');
    const changed=w.getWorkItem(work);
    if(changed.revision!==item.revision || changed.career_revision!==item.career_revision || changed.status!=='running' || running.context_json!==workContext) throw Error('work run changed');
    let staleWork=false;try{w.setWorkSchedule(work,'2028-02-28',null,1)}catch(error){staleWork=error.status===409}
    if(!staleWork || w.getWorkItem(work).due_date!=='2028-02-29') throw Error('work stale CAS');
    if(!w.completeWorkRun(running.id,'success','快捷成果',null) || w.currentWorkArtifact(w.getWorkItem(work),'career')?.content!=='快捷成果') throw Error('work result invalidated');
    if(w.setWorkSchedule(work,null,null,2)!==3 || w.getWorkItem(work).due_date!==null || w.currentWorkArtifact(w.getWorkItem(work),'career')?.content!=='快捷成果') throw Error('work clear');
    const jobId=a.createJob('Agent 事项','虚构资料',[{agentId:agent,upstream:[]}]);
    const before=a.job(jobId);const input=a.inputFor(before,0);const run=a.claimRun(jobId,0,'schedule-agent','mock',input.context,input.inputHash);
    if(a.setJobSchedule(jobId,'2028-02-28','2028-02-29',1)!==2) throw Error('agent schedule');
    const after=a.job(jobId);
    if(after.revision!==before.revision || after.status!=='running' || a.inputFor(after,0).inputHash!==input.inputHash || a.runsFor(jobId)[0].context_json!==JSON.stringify(input.context)) throw Error('agent run changed');
    let staleAgent=false;try{a.setJobSchedule(jobId,null,null,1)}catch(error){staleAgent=error.status===409}
    if(!staleAgent || a.job(jobId).planned_date!=='2028-02-28') throw Error('agent stale CAS');
    if(!a.finishRun(run.run.id,'success','Agent 成果',null) || a.currentArtifact(a.job(jobId),0)?.content!=='Agent 成果') throw Error('agent result invalidated');
    if(a.setJobSchedule(jobId,null,null,2)!==3 || a.job(jobId).due_date!==null || a.currentArtifact(a.job(jobId),0)?.content!=='Agent 成果') throw Error('agent clear');
  `);
});

test("schedule routes require both dates and return a clear stale conflict", () => {
  const { path } = isolated();
  child(path, `
    const req=(path,body)=>new Request('http://127.0.0.1:3901'+path,{method:'POST',headers:{host:'127.0.0.1:3901',origin:'http://127.0.0.1:3901','content-type':'application/json'},body:JSON.stringify(body)});
    const agent=a.saveProfile({name:'日程助手',instructions:'整理',deliverable:'结果',allow_material:1,allow_upstream:0});
    const work=w.createWorkItem('快捷','',['career'],3,30);
    const job=a.createJob('Agent','',[{agentId:agent,upstream:[]}]);
    const base={type:'schedule.update',scheduleRevision:1,plannedDate:null,dueDate:'2028-02-29'};
    if((await wr.POST(req('/api/work-items',{...base,id:work}))).status!==200) throw Error('work route');
    if((await ar.POST(req('/api/agent-work',{...base,id:job}))).status!==200) throw Error('agent route');
    if((await wr.POST(req('/api/work-items',{...base,id:work}))).status!==409) throw Error('work stale route');
    if((await ar.POST(req('/api/agent-work',{...base,id:job}))).status!==409) throw Error('agent stale route');
    if((await wr.POST(req('/api/work-items',{type:'schedule.update',id:work,scheduleRevision:2,plannedDate:null}))).status!==400) throw Error('work missing due date');
    if((await ar.POST(req('/api/agent-work',{type:'schedule.update',id:job,scheduleRevision:2,dueDate:null}))).status!==400) throw Error('agent missing planned date');
    if(w.getWorkItem(work).schedule_revision!==2 || a.job(job).schedule_revision!==2) throw Error('invalid route changed schedule');
  `);
});

test("existing rows receive null dates and revision one after one backed-up migration", () => {
  const { folder, path } = isolated();
  child(path, `
    const db=s.getDatabase();
    db.exec("CREATE TABLE work_items (id TEXT PRIMARY KEY,request TEXT NOT NULL,material TEXT NOT NULL,english_requirement TEXT NOT NULL,roles TEXT NOT NULL,priority INTEGER NOT NULL,minutes INTEGER NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,lifecycle TEXT NOT NULL,career_revision INTEGER NOT NULL,english_revision INTEGER NOT NULL)");
    db.exec("CREATE TABLE agent_jobs (id TEXT PRIMARY KEY,request TEXT NOT NULL,material TEXT NOT NULL,steps_json TEXT NOT NULL,revision INTEGER NOT NULL,correction_revision INTEGER NOT NULL,status TEXT NOT NULL,lifecycle TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,source_job_id TEXT,source_artifact_id TEXT,source_artifact_version INTEGER,target_label TEXT NOT NULL)");
    db.prepare("INSERT INTO work_items (id,request,material,english_requirement,roles,priority,minutes,revision,status,created_at,updated_at,lifecycle,career_revision,english_revision) VALUES ('old-work','旧快捷资料','','','[]',3,30,4,'limited',datetime('now'),datetime('now'),'open',4,4)").run();
    db.prepare("INSERT INTO agent_jobs (id,request,material,steps_json,revision,correction_revision,status,lifecycle,created_at,updated_at,source_job_id,source_artifact_id,source_artifact_version,target_label) VALUES ('old-agent','旧 Agent 事项','','[]',6,0,'planned','open',datetime('now'),datetime('now'),NULL,NULL,NULL,'原目标')").run();
  `);
  child(path, `
    const work=w.getWorkItem('old-work');const job=a.job('old-agent');
    if(work.revision!==4 || work.planned_date!==null || work.due_date!==null || work.schedule_revision!==1) throw Error('work migration');
    if(job.revision!==6 || job.target_label!=='原目标' || job.planned_date!==null || job.due_date!==null || job.schedule_revision!==1) throw Error('agent migration');
  `);
  const workBackups = readdirSync(folder).filter(name => name.includes("backup-work-items-"));
  const agentBackups = readdirSync(folder).filter(name => name.includes("backup-agent-work-"));
  assert.equal(workBackups.length, 1);
  assert.equal(agentBackups.length, 1);
  for (const [name, table, id] of [[workBackups[0], "work_items", "old-work"], [agentBackups[0], "agent_jobs", "old-agent"]]) {
    const backup = new Database(join(folder, name), { readonly: true });
    assert.ok(backup.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id));
    assert.equal(backup.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === "planned_date"), false);
    backup.close();
  }
  child(path, `if(w.getWorkItem('old-work').schedule_revision!==1 || a.job('old-agent').schedule_revision!==1) throw Error('repeat migration');`);
  assert.equal(readdirSync(folder).filter(name => name.includes("backup-work-items-")).length, 1);
  assert.equal(readdirSync(folder).filter(name => name.includes("backup-agent-work-")).length, 1);
});

test("an interrupted date migration rolls back both schemas before a clean retry", () => {
  const { path } = isolated();
  child(path, `
    const db=s.getDatabase();
    db.exec("CREATE TABLE work_items (id TEXT PRIMARY KEY,request TEXT NOT NULL,material TEXT NOT NULL,english_requirement TEXT NOT NULL,roles TEXT NOT NULL,priority INTEGER NOT NULL,minutes INTEGER NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,lifecycle TEXT NOT NULL,career_revision INTEGER NOT NULL,english_revision INTEGER NOT NULL)");
    db.exec("CREATE TABLE agent_jobs (id TEXT PRIMARY KEY,request TEXT NOT NULL,material TEXT NOT NULL,steps_json TEXT NOT NULL,revision INTEGER NOT NULL,correction_revision INTEGER NOT NULL,status TEXT NOT NULL,lifecycle TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,source_job_id TEXT,source_artifact_id TEXT,source_artifact_version INTEGER,target_label TEXT NOT NULL)");
    const original=db.exec.bind(db);
    const columns=table=>db.prepare('PRAGMA table_info('+table+')').all().map(row=>row.name);
    db.exec=sql=>{if(sql==='ALTER TABLE agent_jobs ADD COLUMN due_date TEXT') throw Error('injected agent migration failure');return original(sql)};
    let agentFailed=false;try{a.agentState()}catch(error){agentFailed=error.message.includes('injected agent')}
    if(!agentFailed || columns('agent_jobs').includes('planned_date')) throw Error('agent migration was partial');
    db.exec=original;
    if(a.job('missing')!==undefined || !columns('agent_jobs').includes('schedule_revision')) throw Error('agent retry failed');
    db.exec=sql=>{if(sql==='ALTER TABLE work_items ADD COLUMN due_date TEXT') throw Error('injected work migration failure');return original(sql)};
    let workFailed=false;try{w.workState()}catch(error){workFailed=error.message.includes('injected work')}
    if(!workFailed || columns('work_items').includes('planned_date')) throw Error('work migration was partial');
    db.exec=original;
    w.workState();
    if(!columns('work_items').includes('schedule_revision')) throw Error('work retry failed');
  `);
});
