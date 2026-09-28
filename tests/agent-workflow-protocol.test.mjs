import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const agentWork = new URL("../src/lib/agent-work.ts", import.meta.url).href;
const workflow = new URL("../src/lib/agent-workflow.ts", import.meta.url).href;
const deepseek = new URL("../src/lib/deepseek.ts", import.meta.url).href;

function isolated(script) {
  const path = join(mkdtempSync(join(tmpdir(), "agent-protocol-")), "agents.sqlite");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const a=await import('${agentWork}'); const w=await import('${workflow}'); const d=await import('${deepseek}'); ${script}`], {
    env: { PATH: process.env.PATH, AGENT_DB_PATH: path, NODE_ENV: "test" }, encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("corrected two-step handoff uses source IDs and keeps each step inside its own scope", () => {
  isolated(`
    const sent=[];
    const fetcher=async (url, options)=>{
      if(url.endsWith('/models')) return new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}),{status:200});
      const payload=JSON.parse(options.body); const user=JSON.parse(payload.messages[1].content);
      sent.push({system:payload.messages[0].content,user});
      const result=sent.length===1
        ? {content:'活动时间为下午四点，地点为一楼多功能室，参加者共八人。',appliedCorrections:[{id:user.corrections[0].id,excerpt:'下午四点，地点为一楼多功能室，参加者共八人'}]}
        : {content:'Please join us at 4 p.m. in the first-floor multipurpose room. Eight people will attend.',appliedCorrections:[]};
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}),{status:200});
    };
    await d.connect('synthetic-only',fetcher);
    const first=a.saveProfile({name:'中文整理',instructions:'仅做中文活动摘要',deliverable:'中文活动摘要',allow_material:1,allow_upstream:0});
    const second=a.saveProfile({name:'英文邀请',instructions:'SECOND_PRIVATE_INSTRUCTION 仅做英文邀请',deliverable:'英文邀请函',allow_material:0,allow_upstream:1});
    a.savePreference(first,'只列核实的活动事实');
    a.savePreference(second,'SECOND_PRIVATE_PREFERENCE');
    const id=a.createJob('先整理中文活动信息，再写英文邀请','原定上午十点、二楼、十人',[{agentId:first,upstream:[]},{agentId:second,upstream:[0]}]);
    a.correctJob(id,'活动改为下午四点、一楼多功能室、八人',1);
    await w.startAgentJob(id,'corrected',fetcher,2).completion;
    if(sent.length!==2 || a.runsFor(id).some(run=>run.status!=='success')) throw Error('two-step generation failed');
    if(!sent[0].system.includes('第 1/2 步') || !sent[0].system.includes('本步交付物：中文活动摘要') || !sent[0].system.includes('{id,excerpt}')) throw Error('first step boundary missing');
    if(sent[0].system.includes('SECOND_PRIVATE_') || JSON.stringify(sent[0].user).includes('SECOND_PRIVATE_')) throw Error('other agent configuration leaked');
    if(sent[1].user.material!==null || sent[1].user.corrections.length || sent[1].user.preferences.length!==1 || sent[1].user.upstream.length!==1) throw Error('second step source scope changed');
    if(!sent[1].system.includes('第 2/2 步') || !sent[1].system.includes('本步交付物：英文邀请函') || !sent[1].system.includes('可以完整转换授权上游')) throw Error('second step boundary missing');
    if(a.artifactsFor(id).length!==2 || a.artifactsFor(id)[0].content.includes('原定上午')) throw Error('artifact history or correction failed');
  `);
});

test("saved presentation preferences guide content without changing the JSON protocol or dropping facts", () => {
  isolated(`
    let payload; let calls=0;
    const rawContent=['活动安排','- 时间：周六下午四点','- 地点：一楼多功能室','- 人数：八人','- 内容：共读'].join(String.fromCharCode(10));
    const fetcher=async (url, options)=>{
      if(url.endsWith('/models')) return new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}),{status:200});
      calls++;
      payload=JSON.parse(options.body);
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({content:rawContent,appliedCorrections:[]})}}]}),{status:200});
    };
    await d.connect('synthetic-only',fetcher);
    const agent=a.saveProfile({name:'活动整理',instructions:'整理已核实的活动信息',deliverable:'中文活动摘要',allow_material:1,allow_upstream:0});
    const preference='摘要最多三条，结尾单列待确认问题。标题使用活动安排';
    a.savePreference(agent,preference);
    const id=a.createJob('整理活动','周六下午四点，一楼多功能室，八人共读',[{agentId:agent,upstream:[]}]);
    await w.startAgentJob(id,'format-pref',fetcher,a.job(id).revision).completion;
    const system=payload.messages[0].content;
    const user=JSON.parse(payload.messages[1].content);
    if(user.preferences.length!==1 || user.preferences[0].text!==preference) throw Error('active preference missing from scoped input');
    if(!system.includes('标题、分节、条目数量、顺序等 content 呈现要求') || !system.includes('返回前检查 content 是否符合适用的实例偏好')) throw Error('presentation guidance missing');
    if(!system.includes('不得更改 JSON 字段、纠正来源引用或权限') || !system.includes('不得为满足格式而删去已核实且与本步交付物相关的事实')) throw Error('protocol or factual priority missing');
    if(system.includes(preference)) throw Error('instance preference promoted into system policy');
    if(calls!==1 || a.runsFor(id)[0].status!=='success' || a.artifactsFor(id)[0].content!==rawContent) throw Error('mock result was retried or silently altered');
  `);
});

test("invalid correction references fail with safe branch diagnostics and no automatic retry", () => {
  isolated(`
    let answer; let calls=0;
    const fetcher=async (url)=>{
      if(url.endsWith('/models')) return new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}),{status:200});
      calls++;
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(answer)}}]}),{status:200});
    };
    await d.connect('synthetic-only',fetcher);
    const agent=a.saveProfile({name:'摘要',instructions:'摘要',deliverable:'中文摘要',allow_material:1,allow_upstream:0});
    async function rejected(reason, makeAnswer, correctionCount=1) {
      const id=a.createJob('整理合成资料','虚构资料',[{agentId:agent,upstream:[]}]);
      for(let i=0;i<correctionCount;i++) a.correctJob(id,'PRIVATE_CORRECTION_'+i,a.job(id).revision);
      answer=makeAnswer(a.correctionsFor(id));
      const before=calls;
      await w.startAgentJob(id,'run-'+reason+'-'+before,fetcher,a.job(id).revision).completion;
      const run=a.runsFor(id)[0];
      if(calls!==before+1 || run.status!=='failed' || a.artifactsFor(id).length || !run.error.includes('[agent_correction.'+reason+']')) throw Error('wrong rejection: '+reason);
      if(run.error.includes('PRIVATE_CORRECTION') || run.error.includes('PRIVATE_RESPONSE')) throw Error('raw content leaked: '+reason);
    }
    await rejected('missing_references',()=>({content:'PRIVATE_RESPONSE 正文'}));
    await rejected('unknown_source',()=>({content:'PRIVATE_RESPONSE 正文',appliedCorrections:[{id:'other',excerpt:'正文'}]}));
    await rejected('duplicate_source',facts=>({content:'PRIVATE_RESPONSE 虚构正文',appliedCorrections:[{id:facts[0].id,excerpt:'虚构正文'},{id:facts[0].id,excerpt:'虚构正文'}]}),2);
    await rejected('invalid_excerpt',facts=>({content:'PRIVATE_RESPONSE 正文',appliedCorrections:[{id:facts[0].id,excerpt:'短'}]}));
    await rejected('invalid_excerpt',facts=>({content:'PRIVATE_RESPONSE 无关内容'+String.fromCodePoint(0x200B).repeat(3),appliedCorrections:[{id:facts[0].id,excerpt:String.fromCodePoint(0x200B).repeat(3)}]}));
    await rejected('invalid_excerpt',facts=>({content:'PRIVATE_RESPONSE 无关内容'+String.fromCodePoint(0x2800).repeat(3),appliedCorrections:[{id:facts[0].id,excerpt:String.fromCodePoint(0x2800).repeat(3)}]}));
    await rejected('invalid_excerpt',facts=>({content:'PRIVATE_RESPONSE 无关内容'+String.fromCodePoint(0x3164).repeat(3),appliedCorrections:[{id:facts[0].id,excerpt:String.fromCodePoint(0x3164).repeat(3)}]}));
    await rejected('excerpt_mismatch',facts=>({content:'PRIVATE_RESPONSE 正文',appliedCorrections:[{id:facts[0].id,excerpt:'不在正文中的证据'}]}));
    await rejected('conflicting_source',facts=>({content:'PRIVATE_RESPONSE 正文',appliedCorrections:[{id:facts[0].id,sourceText:'PRIVATE_WRONG_SOURCE',excerpt:'正文'}]}));
    await rejected('unexpected_reference',()=>({content:'PRIVATE_RESPONSE 正文',appliedCorrections:[{id:'other',excerpt:'正文'}]}),0);
    const valid=a.createJob('整理合成资料','虚构资料',[{agentId:agent,upstream:[]}]);
    a.correctJob(valid,'合成活动改为四点',1);
    const marker=String.fromCodePoint(0x200B);
    answer={content:'合成活动'+marker+'四点已确认',appliedCorrections:[{id:a.correctionsFor(valid)[0].id,excerpt:'活动'+marker+'四点'}]};
    await w.startAgentJob(valid,'visible-unicode',fetcher,2).completion;
    if(a.runsFor(valid)[0].status!=='success' || a.artifactsFor(valid).length!==1) throw Error('visible mixed Unicode rejected');
  `);
});
