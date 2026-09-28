import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

const workUrl = new URL("../src/lib/agent-work.ts", import.meta.url).href;
const metricsUrl = new URL("../src/lib/agent-metrics.ts", import.meta.url).href;
const storeUrl = new URL("../src/lib/store.ts", import.meta.url).href;
const routeUrl = new URL("../src/app/api/agent-metrics/route.ts", import.meta.url).href;
function child(path, script) {
  const source = `import assert from 'node:assert/strict';
    const a=await import('${workUrl}'); const m=await import('${metricsUrl}');
    const s=await import('${storeUrl}'); const route=await import('${routeUrl}');
    ${script}`;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
    env: { ...process.env, AGENT_DB_PATH: path }, encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function isolated(script) {
  child(join(mkdtempSync(join(tmpdir(), "agent-metrics-")), "agents.sqlite"), script);
}

test("empty isolated database has honest zero metrics and no history", () => isolated(`
  const result=m.projectAgentMetrics(a.agentMetricsState(),new Date('2026-09-27T12:00:00Z'));
  assert.equal(result.scope,'agent-jobs');
  assert.deepEqual(result.team,{runs:0,successfulRuns:0,failedRuns:0,acceptedArtifacts:0});
  assert.deepEqual(result.events,[]);
  assert.equal(result.agents.length,2);
  assert(result.agents.every(entry=>entry.lastActivityAt===null && !('events' in entry) && !('jobs' in entry) && entry.sevenDay.participatingJobs===0));
  const detail=m.projectAgentMetricDetail(a.agentMetricsState(),'career',{limit:2},new Date('2026-09-27T12:00:00Z'));
  assert.equal(detail.pagination.total,0);
  assert.deepEqual(detail.agent.events,[]);
  const request=new Request('http://127.0.0.1:3901/api/agent-metrics',{headers:{host:'127.0.0.1:3901'}});
  const response=route.GET(request);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  const body=await response.json();
  assert.equal(body.team.runs,0);
  assert.equal(body.events.length,0);
  const detailResponse=route.GET(new Request('http://127.0.0.1:3901/api/agent-metrics?agentId=career&limit=2',{headers:{host:'127.0.0.1:3901'}}));
  assert.equal(detailResponse.status,200);
  assert.equal((await detailResponse.json()).agent.profile.id,'career');
  assert.equal(route.GET(new Request('http://127.0.0.1:3901/api/agent-metrics?agentId=missing',{headers:{host:'127.0.0.1:3901'}})).status,404);
  assert.equal(route.GET(new Request('http://127.0.0.1:3901/api/agent-metrics?agentId=career&limit=101',{headers:{host:'127.0.0.1:3901'}})).status,400);
  assert.equal(route.GET(new Request('http://127.0.0.1:3901/api/agent-metrics?agentId=career&offset=-1',{headers:{host:'127.0.0.1:3901'}})).status,400);
  assert.equal(route.GET(new Request('http://127.0.0.1:3901/api/agent-metrics?agentId=career&cursor=bad',{headers:{host:'127.0.0.1:3901'}})).status,400);
  assert.equal(route.GET(new Request('http://outside.test/api/agent-metrics',{headers:{host:'outside.test'}})).status,403);
`));

test("retained agent profiles remain visible after profile journal markers are cleared", () => isolated(`
  const custom=a.saveProfile({name:'测试阅读助手',instructions:'整理虚构资料',deliverable:'摘要',allow_material:1,allow_upstream:0});
  const jobId=a.createJob('整理虚构阅读资料','虚构资料',[{agentId:custom,upstream:[]}]);
  const input=a.inputFor(a.job(jobId),0);
  const run=a.claimRun(jobId,0,'missing-profile-marker-run','mock',input.context,input.inputHash).run;
  a.finishRun(run.id,'success','虚构摘要',null);
  const original=a.agentMetricsState();
  const missingMarkers={...original,metricJournal:original.metricJournal.filter(entry=>entry.kind!=='profile_created')};
  const now=new Date(Date.now()+1000);
  const team=m.projectAgentMetrics(missingMarkers,now);
  assert.equal(team.agents.length,3);
  assert.equal(m.projectAgentMetrics(missingMarkers,new Date('2000-01-01T00:00:00Z')).agents.length,0);
  assert.equal(team.agents.find(entry=>entry.profile.id===custom)?.sevenDay.successfulRuns,1);
  const detail=m.projectAgentMetricDetail(missingMarkers,custom,{limit:10},now);
  assert.equal(detail.agent.jobs[0].id,jobId);
  assert.equal(detail.agent.events.filter(event=>event.runId===run.id && event.kind==='run_succeeded').length,1);
`));

test("seven-day metrics drill into exact events and retain execution snapshots", () => isolated(`
  const first=a.saveProfile({name:'旧名称',instructions:'整理资料',deliverable:'摘要',allow_material:1,allow_upstream:0});
  const second=a.saveProfile({name:'第二位',instructions:'整理',deliverable:'清单',allow_material:1,allow_upstream:0});
  function make(agent,request,requestId,status,error=null) {
    const jobId=a.createJob(request,'虚构资料',[{agentId:agent,upstream:[]}]);
    const input=a.inputFor(a.job(jobId),0);
    const run=a.claimRun(jobId,0,requestId,'mock',input.context,input.inputHash).run;
    a.finishRun(run.id,status,status==='success'?'虚构成果':null,error);
    return {jobId,runId:run.id,artifact:a.artifactsFor(jobId)[0]};
  }
  const old=make(first,'旧事项','old-run','success');
  a.acceptArtifact(old.jobId,old.artifact.id,a.job(old.jobId).revision);
  a.saveProfile({name:'新名称',instructions:'新职责',deliverable:'新版摘要',allow_material:1,allow_upstream:0},first,1);
  const failed=make(first,'新事项','failed-run','failed','unexpected secret-token from provider');
  const nextInput=a.inputFor(a.job(failed.jobId),0);
  const retry=a.claimRun(failed.jobId,0,'retry-run','mock',nextInput.context,nextInput.inputHash).run;
  a.finishRun(retry.id,'success','重试成果',null);
  const retryArtifact=a.artifactsFor(failed.jobId)[0];
  a.acceptArtifact(failed.jobId,retryArtifact.id,a.job(failed.jobId).revision);
  a.setJobLifecycle(failed.jobId,'complete',a.job(failed.jobId).revision);
  const outside=make(second,'窗口外事项','outside-run','success');
  a.acceptArtifact(outside.jobId,outside.artifact.id,a.job(outside.jobId).revision);
  const boundary=make(second,'边界事项','boundary-run','failed','DeepSeek 请求超时，请重试');
  const db=s.getDatabase();
  for(const id of [old.jobId,failed.jobId,outside.jobId,boundary.jobId]) db.prepare('UPDATE agent_jobs SET created_at=? WHERE id=?').run('2026-09-21 10:00:00',id);
  function times(id,started,finished) { db.prepare('UPDATE agent_runs SET created_at=?,finished_at=? WHERE id=?').run(started,finished,id); }
  times(old.runId,'2026-09-22 10:00:00','2026-09-22 10:01:00');
  times(failed.runId,'2026-09-24 10:00:00','2026-09-24 10:01:00');
  times(retry.id,'2026-09-25 10:00:00','2026-09-25 10:01:00');
  times(outside.runId,'2026-09-20 11:59:59','2026-09-20 12:00:05');
  times(boundary.runId,'2026-09-20 12:00:00','2026-09-20 12:00:01');
  db.prepare('UPDATE agent_artifacts SET created_at=?,accepted_at=? WHERE id=?').run('2026-09-22 10:01:00','2026-09-26 10:00:00',old.artifact.id);
  db.prepare('UPDATE agent_artifacts SET created_at=?,accepted_at=? WHERE id=?').run('2026-09-25 10:01:00','2026-09-26 11:00:00',retryArtifact.id);
  db.prepare('UPDATE agent_artifacts SET created_at=?,accepted_at=? WHERE id=?').run('2026-09-20 12:00:05','2026-09-23 10:00:00',outside.artifact.id);
  const state=a.agentMetricsState(); const now=new Date('2026-09-27T12:00:00Z');
  const result=m.projectAgentMetrics(state,now);
  assert.deepEqual(result.window,{from:'2026-09-20T12:00:00.000Z',to:'2026-09-27T12:00:00.000Z'});
  assert.deepEqual([result.team.runs,result.team.successfulRuns,result.team.failedRuns,result.team.acceptedArtifacts],[4,3,2,3]);
  for(const [key,kind] of [['runs','run_started'],['successfulRuns','run_succeeded'],['failedRuns','run_failed'],['acceptedArtifacts','artifact_accepted']]) {
    const matches=m.projectAgentMetrics(state,now,{metric:key}).events;
    assert.equal(result.team[key],matches.length);
    assert(matches.every(event=>event.kind===kind));
  }
  assert(!m.projectAgentMetrics(state,now,{metric:'runs'}).events.some(event=>event.runId===outside.runId));
  assert(m.projectAgentMetrics(state,now,{metric:'successfulRuns'}).events.some(event=>event.runId===outside.runId));
  assert(m.projectAgentMetrics(state,now,{metric:'runs'}).events.some(event=>event.runId===boundary.runId));
  const one=result.agents.find(entry=>entry.profile.id===first);
  const two=result.agents.find(entry=>entry.profile.id===second);
  const oneDetail=m.projectAgentMetricDetail(state,first,{limit:100},now).agent;
  const twoDetail=m.projectAgentMetricDetail(state,second,{limit:100},now).agent;
  assert.deepEqual([one.sevenDay.participatingJobs,one.sevenDay.runs,one.sevenDay.successfulRuns,one.sevenDay.failedRuns,one.sevenDay.acceptedArtifacts],[2,3,2,1,2]);
  assert(oneDetail.jobs.find(job=>job.id===old.jobId)?.recent);
  assert(oneDetail.jobs.find(job=>job.id===failed.jobId)?.recent);
  assert.deepEqual([two.sevenDay.participatingJobs,two.sevenDay.runs,two.sevenDay.successfulRuns,two.sevenDay.failedRuns,two.sevenDay.acceptedArtifacts],[2,1,1,1,1]);
  assert(twoDetail.jobs.find(job=>job.id===outside.jobId)?.recent);
  assert.equal(one.profile.name,'新名称');
  assert.equal(oneDetail.events.find(event=>event.runId===old.runId).agentName,'旧名称');
  assert.equal(oneDetail.events.find(event=>event.artifactId===old.artifact.id).agentSnapshot.instructions,'整理资料');
  assert.equal(oneDetail.events.find(event=>event.runId===failed.runId).agentName,'新名称');
  assert.equal(oneDetail.events.find(event=>event.runId===failed.runId && event.kind==='run_failed').errorSummary,'运行失败，请打开关联事项查看详情');
  assert(!JSON.stringify(result).includes('secret-token'));
  assert.equal(oneDetail.jobs.find(job=>job.id===failed.jobId).lifecycle,'completed');
  assert.equal(one.sevenDay.successfulRuns,2);
  assert.equal(oneDetail.events.filter(event=>event.kind==='artifact_accepted').length,2);
  assert(oneDetail.events.every((event,index,events)=>index===0 || Date.parse(events[index-1].occurredAt)>=Date.parse(event.occurredAt)));
  assert(one.lastActivityAt===oneDetail.events[0].occurredAt);
  assert(twoDetail.events.some(event=>event.runId===outside.runId && event.kind==='run_started'));
`));

test("failed run events retain selected upstream artifact IDs and versions", () => isolated(`
  const source=a.saveProfile({name:'来源',instructions:'整理',deliverable:'摘要',allow_material:1,allow_upstream:0});
  const receiver=a.saveProfile({name:'接收',instructions:'改写',deliverable:'改写',allow_material:0,allow_upstream:1});
  const id=a.createJob('合成接续','虚构资料',[{agentId:source,upstream:[]},{agentId:receiver,upstream:[0]}]);
  const firstInput=a.inputFor(a.job(id),0);
  const first=a.claimRun(id,0,'source-run','mock',firstInput.context,firstInput.inputHash).run;
  a.finishRun(first.id,'success','来源成果',null);
  const artifact=a.artifactsFor(id)[0];
  const secondInput=a.inputFor(a.job(id),1);
  const second=a.claimRun(id,1,'failed-upstream-run','mock',secondInput.context,secondInput.inputHash).run;
  a.finishRun(second.id,'failed',null,'模型请求超时');
  const detail=m.projectAgentMetricDetail(a.agentMetricsState(),receiver,{limit:30});
  const related=detail.agent.events.filter(event=>event.runId===second.id);
  assert.deepEqual(related.map(event=>event.kind).sort(),['run_failed','run_started']);
  assert(related.every(event=>JSON.stringify(event.upstream)===JSON.stringify([{id:artifact.id,version:1}])));
  assert.equal(detail.agent.events.some(event=>event.kind==='artifact_created'),false);
`));

test("team payload stays compact while agent history is fully pageable", () => isolated(`
  const marker='LONG-INSTRUCTION-'+('x'.repeat(3900));
  const agent=a.saveProfile({name:'分页 Agent',instructions:marker,deliverable:'摘要',allow_material:1,allow_upstream:0});
  for(let index=0;index<8;index++) {
    const id=a.createJob('事项 '+index+' '+('y'.repeat(350)),'虚构资料',[{agentId:agent,upstream:[]}]);
    const input=a.inputFor(a.job(id),0);
    const run=a.claimRun(id,0,'paged-'+index,'mock',input.context,input.inputHash).run;
    a.finishRun(run.id,'success','成果 '+index,null);
  }
  const state=a.agentMetricsState();
  const team=m.projectAgentMetrics(state);
  const teamAgent=team.agents.find(entry=>entry.profile.id===agent);
  assert(!('events' in teamAgent) && !('jobs' in teamAgent));
  assert(!JSON.stringify(team).includes(marker));
  const teamPage=m.projectAgentMetrics(state,new Date(),{metric:'runs',limit:3});
  assert(teamPage.events.every(event=>event.jobRequest.length<=160 && !('agentSnapshot' in event) && !('upstream' in event)));
  assert.equal(teamPage.events.length,3);
  let cursor; const collected=[];
  while(true) {
    const page=m.projectAgentMetricDetail(state,agent,{cursor,limit:3});
    assert(page.agent.events.length<=3);
    collected.push(...page.agent.events.map(event=>event.id));
    if(!page.pagination.hasMore) { assert.equal(collected.length,page.pagination.total); break; }
    cursor=page.pagination.nextCursor;
  }
  assert.equal(new Set(collected).size,collected.length);
  assert.equal(collected.length,24);
  assert(m.projectAgentMetricDetail(state,agent,{limit:1}).agent.events[0].agentSnapshot.instructions===marker);
  const filtered=m.projectAgentMetricDetail(state,agent,{limit:2,metric:'successfulRuns'});
  assert.equal(filtered.pagination.total,8);
  assert(filtered.agent.events.every(event=>event.kind==='run_succeeded'));
  const first=m.projectAgentMetricDetail(state,agent,{limit:3,metric:'successfulRuns'});
  const api=new Request('http://127.0.0.1:3901/api/agent-metrics?agentId='+agent+'&limit=2&metric=successfulRuns&cursor='+encodeURIComponent(first.pagination.nextCursor)+'&asOf='+encodeURIComponent(first.pagination.asOf),{headers:{host:'127.0.0.1:3901'}});
  const body=await route.GET(api).json();
  assert.equal(body.pagination.total,8);
  assert.equal(body.pagination.metric,'successfulRuns');
  assert.equal(body.pagination.asOf,first.pagination.asOf);
  assert.equal(body.agent.events.length,2);
  assert(body.agent.events.every(event=>!first.agent.events.some(firstEvent=>firstEvent.id===event.id)));
  assert.equal(route.GET(new Request('http://127.0.0.1:3901/api/agent-metrics?agentId='+agent+'&metric=unknown',{headers:{host:'127.0.0.1:3901'}})).status,400);
`));

test("team events and agent jobs stay bounded with many items", () => isolated(`
  const agent=a.saveProfile({name:'容量 Agent',instructions:'整理',deliverable:'清单',allow_material:1,allow_upstream:0});
  for(let index=0;index<70;index++) {
    const id=a.createJob('容量事项 '+index+' '+('x'.repeat(180)),'虚构资料',[{agentId:agent,upstream:[]}]);
    const input=a.inputFor(a.job(id),0);
    const run=a.claimRun(id,0,'capacity-'+index,'mock',input.context,input.inputHash).run;
    a.finishRun(run.id,'success','容量成果',null);
  }
  const state=a.agentMetricsState();
  const team=m.projectAgentMetrics(state,new Date(),{metric:'runs'});
  const detail=m.projectAgentMetricDetail(state,agent);
  assert.equal(team.team.runs,70);
  assert.equal(team.events.length,30);
  assert.equal(detail.agent.jobs.length,30);
  assert.equal(detail.agent.events.length,30);
  assert.equal(detail.jobsPagination.total,70);
  assert(team.pagination.hasMore && detail.jobsPagination.hasMore && detail.pagination.hasMore);
  assert(Buffer.byteLength(JSON.stringify(team))<25000);
  assert(Buffer.byteLength(JSON.stringify(detail))<50000);
  const last=m.projectAgentMetricDetail(state,agent,{jobsCursor:detail.jobsPagination.nextCursor});
  assert.equal(last.agent.jobs.length,30);
  assert(last.agent.jobs.every(job=>!detail.agent.jobs.some(previous=>previous.id===job.id)));
`));

test("cursor keeps existing event pages stable when a newer run arrives", () => isolated(`
  const agent=a.saveProfile({name:'翻页 Agent',instructions:'整理',deliverable:'清单',allow_material:1,allow_upstream:0});
  const db=s.getDatabase();
  const old=[];
  for(let index=0;index<5;index++) {
    const id=a.createJob('旧事项 '+index,'虚构资料',[{agentId:agent,upstream:[]}]);
    const input=a.inputFor(a.job(id),0);
    const run=a.claimRun(id,0,'cursor-'+index,'mock',input.context,input.inputHash).run;
    db.prepare('UPDATE agent_runs SET created_at=? WHERE id=?').run('2026-09-27 11:59:'+String(40-index).padStart(2,'0'),run.id);
    old.push(run.id);
  }
  const now=new Date('2026-09-27T12:00:00.000Z');
  const first=m.projectAgentMetricDetail(a.agentMetricsState(),agent,{limit:2},now);
  const freshId=a.createJob('新事项','虚构资料',[{agentId:agent,upstream:[]}]);
  const freshInput=a.inputFor(a.job(freshId),0);
  const fresh=a.claimRun(freshId,0,'cursor-new','mock',freshInput.context,freshInput.inputHash).run;
  db.prepare('UPDATE agent_runs SET created_at=? WHERE id=?').run('2026-09-27 11:59:55',fresh.id);
  const next=m.projectAgentMetricDetail(a.agentMetricsState(),agent,{limit:4,cursor:first.pagination.nextCursor,asOf:first.pagination.asOf},now);
  const combined=[...first.agent.events,...next.agent.events];
  assert.equal(combined.length,5);
  assert.equal(new Set(combined.map(event=>event.id)).size,5);
  assert.deepEqual(new Set(combined.map(event=>event.runId)),new Set(old));
  assert.equal(next.pagination.asOf,first.pagination.asOf);
`));

test("asOf sequence freezes same-second run, finish, acceptance and job membership", () => isolated(`
  const agent=a.saveProfile({name:'快照 Agent',instructions:'整理',deliverable:'摘要',allow_material:1,allow_upstream:0});
  const db=s.getDatabase();
  const pendingJob=a.createJob('待结束事项','虚构资料',[{agentId:agent,upstream:[]}]);
  const pendingInput=a.inputFor(a.job(pendingJob),0);
  const pending=a.claimRun(pendingJob,0,'pending-same-second','mock',pendingInput.context,pendingInput.inputHash).run;
  db.prepare('UPDATE agent_runs SET created_at=? WHERE id=?').run('2026-09-27 12:00:00',pending.id);
  const acceptedJob=a.createJob('待确认事项','虚构资料',[{agentId:agent,upstream:[]}]);
  const acceptedInput=a.inputFor(a.job(acceptedJob),0);
  const acceptedRun=a.claimRun(acceptedJob,0,'accepted-same-second','mock',acceptedInput.context,acceptedInput.inputHash).run;
  a.finishRun(acceptedRun.id,'success','待确认成果',null);
  db.prepare('UPDATE agent_jobs SET created_at=? WHERE id IN (?,?)').run('2026-09-27 12:00:00',pendingJob,acceptedJob);
  const artifact=a.artifactsFor(acceptedJob)[0];
  db.prepare('UPDATE agent_runs SET created_at=?,finished_at=? WHERE id=?').run('2026-09-27 11:59:59','2026-09-27 12:00:00',acceptedRun.id);
  db.prepare('UPDATE agent_artifacts SET created_at=? WHERE id=?').run('2026-09-27 12:00:00',artifact.id);
  const now=new Date('2026-09-27T12:00:00.900Z');
  const beforeState=a.agentMetricsState();
  const first=m.projectAgentMetricDetail(beforeState,agent,{limit:1,jobsLimit:1},now);
  const teamFirst=m.projectAgentMetrics(beforeState,now,{metric:'runs',limit:1});
  const trendSummary=m.projectAgentTrend(beforeState,7,{},now);
  const trendFirst=m.projectAgentTrend(beforeState,7,{bucket:6,metric:'runs',limit:1,asOf:trendSummary.asOf},now);
  assert.equal(first.pagination.total,4);
  assert.equal(first.jobsPagination.total,2);
  assert.equal(first.agent.sevenDay.failedRuns,0);
  assert.equal(first.agent.sevenDay.acceptedArtifacts,0);
  assert(first.pagination.asOf.startsWith('2026-09-27T12:00:00.900Z~'));
  assert(Number.isSafeInteger(Number(first.pagination.asOf.split('~')[1])));
  a.finishRun(pending.id,'failed',null,'模型请求超时');
  db.prepare('UPDATE agent_runs SET finished_at=? WHERE id=?').run('2026-09-27 12:00:00',pending.id);
  a.acceptArtifact(acceptedJob,artifact.id,a.job(acceptedJob).revision);
  db.prepare('UPDATE agent_artifacts SET accepted_at=? WHERE id=?').run('2026-09-27 12:00:00',artifact.id);
  const newJob=a.createJob('同秒新增事项','虚构资料',[{agentId:agent,upstream:[]}]);
  const newInput=a.inputFor(a.job(newJob),0);
  const newRun=a.claimRun(newJob,0,'new-same-second','mock',newInput.context,newInput.inputHash).run;
  db.prepare('UPDATE agent_jobs SET created_at=? WHERE id=?').run('2026-09-27 12:00:00',newJob);
  db.prepare('UPDATE agent_runs SET created_at=? WHERE id=?').run('2026-09-27 12:00:00',newRun.id);
  const afterState=a.agentMetricsState();
  const frozen=m.projectAgentMetricDetail(afterState,agent,{limit:100,jobsLimit:100,asOf:first.pagination.asOf},now);
  const teamFrozen=m.projectAgentMetrics(afterState,now,{metric:'runs',limit:100,asOf:teamFirst.pagination.asOf});
  const trendFrozen=m.projectAgentTrend(afterState,7,{asOf:trendSummary.asOf},now);
  const trendNext=m.projectAgentTrend(afterState,7,{bucket:6,metric:'runs',limit:100,cursor:trendFirst.pagination.nextCursor,asOf:trendSummary.asOf},now);
  assert.equal(frozen.pagination.total,first.pagination.total);
  assert.equal(frozen.jobsPagination.total,first.jobsPagination.total);
  assert.equal(teamFrozen.pagination.total,teamFirst.pagination.total);
  assert.deepEqual(trendFrozen.buckets,trendSummary.buckets);
  assert.deepEqual(trendFrozen.totals,trendSummary.totals);
  assert.equal(trendNext.pagination.total,trendFirst.pagination.total);
  assert.equal(trendFirst.events.length+trendNext.events.length,trendFirst.pagination.total);
  assert.equal(new Set([...trendFirst.events,...trendNext.events].map(event=>event.id)).size,trendFirst.pagination.total);
  assert.equal(frozen.agent.sevenDay.failedRuns,0);
  assert.equal(frozen.agent.sevenDay.acceptedArtifacts,0);
  assert(!frozen.agent.events.some(event=>event.runId===newRun.id || event.kind==='run_failed' || event.kind==='artifact_accepted'));
  assert(!frozen.agent.jobs.some(job=>job.id===newJob));
  assert.equal(frozen.agent.events.find(event=>event.artifactId===artifact.id).acceptedAt,null);
  const next=m.projectAgentMetricDetail(afterState,agent,{limit:100,cursor:first.pagination.nextCursor,asOf:first.pagination.asOf},now);
  const combined=[first.agent.events[0],...next.agent.events];
  assert.equal(combined.length,first.pagination.total);
  assert.equal(new Set(combined.map(event=>event.id)).size,combined.length);
  const fresh=m.projectAgentMetricDetail(afterState,agent,{limit:100,jobsLimit:100},now);
  const freshTrend=m.projectAgentTrend(afterState,7,{},now);
  assert.equal(fresh.pagination.total,7);
  assert.equal(fresh.jobsPagination.total,3);
  assert.equal(fresh.agent.sevenDay.failedRuns,1);
  assert.equal(fresh.agent.sevenDay.acceptedArtifacts,1);
  assert.equal(m.projectAgentMetrics(afterState,now,{metric:'runs'}).team.runs,3);
  assert.equal(freshTrend.buckets[6].runs,3);
  assert.equal(freshTrend.buckets[6].failedRuns,1);
  assert.equal(freshTrend.buckets[6].acceptedArtifacts,1);
  assert.equal(route.GET(new Request('http://127.0.0.1:3901/api/agent-metrics?agentId='+agent+'&asOf=2026-09-27T12%3A00%3A00.900Z',{headers:{host:'127.0.0.1:3901'}})).status,400);
`));

test("legacy agent rows are backed up and journal backfill is idempotent", () => {
  const folder = mkdtempSync(join(tmpdir(), "agent-metrics-legacy-"));
  const path = join(folder, "agents.sqlite");
  child(path, `
    const db=s.getDatabase();
    db.exec(\`
      CREATE TABLE agent_profiles (id TEXT PRIMARY KEY,name TEXT NOT NULL,instructions TEXT NOT NULL,deliverable TEXT NOT NULL,allow_material INTEGER NOT NULL,allow_upstream INTEGER NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL,template TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,content_revision INTEGER NOT NULL);
      CREATE TABLE agent_jobs (id TEXT PRIMARY KEY,request TEXT NOT NULL,material TEXT NOT NULL,steps_json TEXT NOT NULL,revision INTEGER NOT NULL,correction_revision INTEGER NOT NULL,status TEXT NOT NULL,lifecycle TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,source_job_id TEXT,source_artifact_id TEXT,source_artifact_version INTEGER,target_label TEXT NOT NULL);
      CREATE TABLE agent_runs (id TEXT PRIMARY KEY,job_id TEXT NOT NULL,step_index INTEGER NOT NULL,agent_id TEXT NOT NULL,request_id TEXT NOT NULL,status TEXT NOT NULL,model TEXT NOT NULL,job_revision INTEGER NOT NULL,agent_revision INTEGER NOT NULL,input_hash TEXT NOT NULL,context_json TEXT NOT NULL,owner_pid INTEGER NOT NULL,owner_started_at INTEGER NOT NULL,error TEXT,created_at TEXT NOT NULL,finished_at TEXT);
      CREATE TABLE agent_artifacts (id TEXT PRIMARY KEY,job_id TEXT NOT NULL,step_index INTEGER NOT NULL,agent_id TEXT NOT NULL,version INTEGER NOT NULL,input_hash TEXT NOT NULL,content TEXT NOT NULL,run_id TEXT NOT NULL,upstream_json TEXT NOT NULL,config_json TEXT NOT NULL,accepted_at TEXT,created_at TEXT NOT NULL);
    \`);
    const at='2026-09-27 11:59:00';
    db.prepare('INSERT INTO agent_profiles VALUES (?,?,?,?,?,?,?, ?,?,?,?,?)').run('legacy-agent','旧 Agent','整理','摘要',1,0,1,1,null,at,at,1);
    db.prepare('INSERT INTO agent_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy-job','旧事项','资料',JSON.stringify([{agentId:'legacy-agent',upstream:[]}]),1,0,'ready','open',at,at,null,null,null,'');
    db.prepare('INSERT INTO agent_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy-run','legacy-job',0,'legacy-agent','legacy-request','success','mock',1,1,'hash',JSON.stringify({agentName:'旧 Agent',request:'旧事项'}),1,1,null,at,at);
    db.prepare('INSERT INTO agent_artifacts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy-artifact','legacy-job',0,'legacy-agent',1,'hash','旧成果','legacy-run','[]',JSON.stringify({name:'旧 Agent'}),at,at);
  `);
  child(path, `
    const state=a.agentMetricsState();
    const kinds=state.metricJournal.filter(entry=>['legacy-agent','legacy-job','legacy-run','legacy-artifact'].includes(entry.entity_id));
    assert.deepEqual(kinds.map(entry=>entry.kind).sort(),['artifact_accepted','artifact_created','job_created','profile_created','run_finished','run_started']);
    const before=state.metricHighWater;
    const again=a.agentMetricsState();
    assert.equal(again.metricHighWater,before);
    assert.equal(again.metricJournal.length,state.metricJournal.length);
    const result=m.projectAgentMetricDetail(again,'legacy-agent',{limit:20},new Date('2026-09-27T12:00:00Z'));
    assert.equal(result.agent.events.length,4);
    assert.equal(result.agent.sevenDay.acceptedArtifacts,1);
  `);
  const backups = readdirSync(folder).filter(name => name.includes("backup-agent-work-"));
  assert.equal(backups.length, 1);
  const backup = new Database(join(folder, backups[0]), { readonly: true });
  assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM agent_runs").get().count, 1);
  assert.equal(backup.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_metric_events'").get(), undefined);
  backup.close();
  child(path, `
    const state=a.agentMetricsState();
    assert.equal(state.metricJournal.filter(entry=>entry.entity_id==='legacy-run').length,2);
  `);
  assert.equal(readdirSync(folder).filter(name => name.includes("backup-agent-work-")).length, 1);
});

test("journal entries roll back with their source write", () => isolated(`
  const agent=a.saveProfile({name:'回滚 Agent',instructions:'整理',deliverable:'摘要',allow_material:1,allow_upstream:0});
  const before=a.agentMetricsState();
  const db=s.getDatabase();
  assert.throws(()=>db.transaction(()=>{
    a.createJob('未提交事项','虚构资料',[{agentId:agent,upstream:[]}]);
    throw new Error('synthetic rollback');
  }).immediate(),/synthetic rollback/);
  const after=a.agentMetricsState();
  assert.equal(after.metricHighWater,before.metricHighWater);
  assert.equal(after.jobs.length,before.jobs.length);
  assert.equal(after.metricJournal.length,before.metricJournal.length);
`));

test("empty 7/30 day trends use real zero buckets and reject invalid drill parameters", () => isolated(`
  const state=a.agentMetricsState();
  const now=new Date('2026-09-27T12:00:00.000Z');
  for(const days of [7,30]) {
    const trend=m.projectAgentTrend(state,days,{},now);
    assert.equal(trend.days,days);
    assert.equal(trend.buckets.length,days);
    assert.deepEqual(trend.totals,{runs:0,successfulRuns:0,failedRuns:0,acceptedArtifacts:0});
    assert(trend.buckets.every(bucket=>bucket.runs===0 && bucket.successfulRuns===0 && bucket.failedRuns===0 && bucket.acceptedArtifacts===0));
    assert.equal(Date.parse(trend.window.to)-Date.parse(trend.window.from),days*24*60*60*1000);
    assert.deepEqual(trend.events,[]);
    assert.equal(trend.pagination,null);
    const emptyPage=m.projectAgentTrend(state,days,{bucket:days-1,metric:'runs',limit:3,asOf:trend.asOf},now);
    assert.equal(emptyPage.pagination.total,0);
    assert.equal(emptyPage.pagination.asOf,trend.asOf);
  }
  const url='http://127.0.0.1:3901/api/agent-metrics';
  const local={host:'127.0.0.1:3901'};
  for(const query of ['trendDays=0','trendDays=8','trendDays=abc','trendDays=7&bucket=7&metric=runs',
    'trendDays=7&bucket=-1&metric=runs','trendDays=7&bucket=0','trendDays=7&metric=runs',
    'trendDays=7&cursor=abc','trendDays=7&limit=2','trendDays=7&agentId=career',
    'trendDays=7&bucket=0&metric=wrong','trendDays=7&bucket=0&metric=runs','trendDays=7&asOf=bad']) {
    assert.equal(route.GET(new Request(url+'?'+query,{headers:local})).status,400,query);
  }
  assert.equal(route.GET(new Request('http://outside.test/api/agent-metrics?trendDays=7',{headers:{host:'outside.test'}})).status,403);
  const response=route.GET(new Request(url+'?trendDays=7',{headers:local}));
  assert.equal(response.status,200,await response.clone().text());
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  const body=await response.json();
  assert.equal(body.buckets.length,7);
  const drill=route.GET(new Request(url+'?trendDays=7&bucket=6&metric=runs&asOf='+encodeURIComponent(body.asOf),{headers:local}));
  assert.equal(drill.status,200);
  const drillBody=await drill.json();
  assert.equal(drillBody.pagination.asOf,body.asOf);
  assert.equal(drillBody.pagination.total,0);
`));

test("rolling 24-hour boundaries and trend drill match the existing seven-day KPI", () => isolated(`
  const marker='PRIVATE-FIXTURE-'+('x'.repeat(300));
  const agent=a.saveProfile({name:'趋势 Agent',instructions:marker,deliverable:'摘要',allow_material:1,allow_upstream:0});
  const db=s.getDatabase();
  function make(label,status,at,accepted=false) {
    const id=a.createJob(label,marker,[{agentId:agent,upstream:[]}]);
    const input=a.inputFor(a.job(id),0);
    const run=a.claimRun(id,0,'trend-'+label,'mock',input.context,input.inputHash).run;
    a.finishRun(run.id,status,status==='success'?'虚构成果':null,status==='failed'?'合成失败':null);
    db.prepare('UPDATE agent_runs SET created_at=?,finished_at=? WHERE id=?').run(at,at,run.id);
    const artifact=a.artifactsFor(id)[0];
    if(artifact) {
      if(accepted) a.acceptArtifact(id,artifact.id,a.job(id).revision);
      db.prepare('UPDATE agent_artifacts SET created_at=?,accepted_at=? WHERE id=?').run(at,accepted?at:null,artifact.id);
    }
    return {id,runId:run.id,artifactId:artifact?.id};
  }
  const thirtyStart=make('三十天起点','success','2026-08-28 12:00:00',true);
  make('三十天之前','success','2026-08-28 11:59:59',true);
  const sevenStart=make('七天起点','failed','2026-09-20 12:00:00');
  const nextBoundary=make('次日边界','success','2026-09-21 12:00:00',true);
  const rightEdge=make('当前边界','success','2026-09-27 12:00:00',true);
  make('未来一秒','failed','2026-09-27 12:00:01');
  const state=a.agentMetricsState();
  const now=new Date('2026-09-27T12:00:00.000Z');
  const seven=m.projectAgentTrend(state,7,{},now);
  const thirty=m.projectAgentTrend(state,30,{},now);
  const kpi=m.projectAgentMetrics(state,now);
  assert.deepEqual(seven.totals,kpi.team);
  assert.deepEqual(seven.totals,{runs:3,successfulRuns:2,failedRuns:1,acceptedArtifacts:2});
  assert.deepEqual(thirty.totals,{runs:4,successfulRuns:3,failedRuns:1,acceptedArtifacts:3});
  assert.equal(seven.buckets.length,7);
  assert.equal(thirty.buckets.length,30);
  assert.equal(seven.buckets[0].from,'2026-09-20T12:00:00.000Z');
  assert.equal(seven.buckets[0].to,'2026-09-21T12:00:00.000Z');
  assert.equal(seven.buckets[0].runs,1);
  assert.equal(seven.buckets[0].failedRuns,1);
  assert.equal(seven.buckets[1].runs,1);
  assert.equal(seven.buckets[1].successfulRuns,1);
  assert.equal(seven.buckets[1].acceptedArtifacts,1);
  assert.equal(seven.buckets[6].runs,1);
  assert.equal(seven.buckets[6].successfulRuns,1);
  assert.equal(seven.buckets[6].acceptedArtifacts,1);
  assert.equal(thirty.buckets[0].runs,1);
  assert.equal(thirty.buckets[0].acceptedArtifacts,1);
  for(let index=0;index<7;index++) {
    assert.deepEqual([seven.buckets[index].runs,seven.buckets[index].successfulRuns,seven.buckets[index].failedRuns,seven.buckets[index].acceptedArtifacts],
      [thirty.buckets[index+23].runs,thirty.buckets[index+23].successfulRuns,thirty.buckets[index+23].failedRuns,thirty.buckets[index+23].acceptedArtifacts]);
  }
  for(let index=1;index<seven.buckets.length;index++) assert.equal(seven.buckets[index-1].to,seven.buckets[index].from);
  for(const key of ['runs','successfulRuns','failedRuns','acceptedArtifacts']) assert.equal(seven.buckets.reduce((sum,bucket)=>sum+bucket[key],0),seven.totals[key]);
  const failedPage=m.projectAgentTrend(state,7,{bucket:0,metric:'failedRuns',limit:3,asOf:seven.asOf},now);
  assert.equal(failedPage.pagination.total,1);
  assert.equal(failedPage.events[0].runId,sevenStart.runId);
  const acceptedPage=m.projectAgentTrend(state,7,{bucket:1,metric:'acceptedArtifacts',limit:3,asOf:seven.asOf},now);
  assert.equal(acceptedPage.pagination.total,1);
  assert.equal(acceptedPage.events[0].artifactId,nextBoundary.artifactId);
  const startPage=m.projectAgentTrend(state,30,{bucket:0,metric:'runs',limit:3,asOf:thirty.asOf},now);
  assert.equal(startPage.events[0].runId,thirtyStart.runId);
  const rightPage=m.projectAgentTrend(state,7,{bucket:6,metric:'runs',limit:3,asOf:seven.asOf},now);
  assert.equal(rightPage.events[0].runId,rightEdge.runId);
  assert(!JSON.stringify(seven).includes(marker));
  assert(!JSON.stringify(rightPage).includes(marker));
  assert(rightPage.events.every(event=>!('agentSnapshot' in event) && !('upstream' in event)));
  const url='http://127.0.0.1:3901/api/agent-metrics';
  const local={host:'127.0.0.1:3901'};
  const liveSummary=await route.GET(new Request(url+'?trendDays=7',{headers:local})).json();
  const api=route.GET(new Request(url+'?trendDays=7&bucket=6&metric=runs&limit=2&asOf='+encodeURIComponent(liveSummary.asOf),{headers:local}));
  assert.equal(api.status,200);
  assert.equal((await api.json()).selection.metric,'runs');
`));
