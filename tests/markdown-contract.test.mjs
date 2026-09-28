import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const practiceUrl = new URL("../src/lib/practice.ts", import.meta.url).href;
const itemsUrl = new URL("../src/lib/work-items.ts", import.meta.url).href;
const deepseekUrl = new URL("../src/lib/deepseek.ts", import.meta.url).href;
const storeUrl = new URL("../src/lib/store.ts", import.meta.url).href;

function isolated(script) {
  const folder = mkdtempSync(join(tmpdir(), "agent-markdown-contract-"));
  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const p=await import('${practiceUrl}'); const w=await import('${itemsUrl}'); const d=await import('${deepseekUrl}'); const s=await import('${storeUrl}'); const assert=(await import('node:assert/strict')).default; ${script}`], {
      env: { ...process.env, AGENT_DB_PATH: join(folder, "agents.sqlite") }, encoding: "utf8", timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test("structured choice survives storage, feedback and next-round context while legacy prose stays readable", () => {
  isolated(`
    let preparation=0;
    let nextContext;
    const fetcher=async(url,init)=>{
      if(url.endsWith('/models')) return new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}),{status:200});
      const payload=JSON.parse(init.body);
      const system=payload.messages[0].content;
      const context=JSON.parse(payload.messages[1].content);
      if(system.includes('一道可直接回答')) {
        assert.match(system,/选择题必须返回/);
        assert.match(system,/可读 Markdown/);
        preparation++;
        if(preparation===2) nextContext=context;
        const result=preparation===1
          ? {question:'## 团队协作\\n面试时，你应如何描述自己的职责？',options:['说明自己负责的部分','推断他人的分工','只说团队完成了工作']}
          : {question:'## 追问\\n你会怎样说明核对过程？'};
        return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}),{status:200});
      }
      assert.match(system,/可读 Markdown 正文/);
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({evidenceId:'s1',feedback:'### 反馈\\n\\n回答点出了职责。',nextSuggestion:'- 下次补充一个可核对的例子。'})}}]}),{status:200});
    };
    await d.connect('synthetic-only',fetcher);
    const id=w.createWorkItem('面试练习','虚构经历',['career'],3,30);
    const item=w.getWorkItem(id);
    const run=w.claimWorkRun(id,'career','source','mock',{request:item.request,material:item.material,facts:[],preferences:[],upstream:null,agentEpochs:{career:s.getAgentEpoch('career')},revision:1,minutes:30,priority:3},null);
    w.completeWorkRun(run.id,'success','## 虚构成果',null);
    await p.startPractice(id,'career','prepare-1',1,undefined,undefined,fetcher).completion;
    const first=w.workState().practices[0];
    assert.equal(first.status,'question');
    assert.equal(first.question,'## 团队协作\\n面试时，你应如何描述自己的职责？');
    assert.deepEqual(JSON.parse(first.question_options_json),[{label:'A',text:'说明自己负责的部分'},{label:'B',text:'推断他人的分工'},{label:'C',text:'只说团队完成了工作'}]);
    await p.startPractice(id,'career','answer-1',1,first.id,'A\\n理由：我只能确认自己的职责。',fetcher).completion;
    assert.match(w.workState().practices[0].feedback,/### 反馈/);
    await p.startPractice(id,'career','prepare-2',1,undefined,undefined,fetcher).completion;
    assert.match(nextContext.history[0].question,/\\*\\*A\\.\\*\\* 说明自己负责的部分/);
    const second=w.workState().practices[0];
    assert.equal(second.question,'## 追问\\n你会怎样说明核对过程？');
    assert.deepEqual(JSON.parse(second.question_options_json),[]);
  `);
});

test("invalid structured choices fail without saving a partial question and can be retried", () => {
  isolated(`
    let valid=false;
    const fetcher=async(url)=>{
      if(url.endsWith('/models')) return new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}),{status:200});
      const result=valid?{question:'请说明理由',options:['核对事实','编造分工']}:{question:'请说明理由',options:['重复','重复']};
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}),{status:200});
    };
    await d.connect('synthetic-only',fetcher);
    const id=w.createWorkItem('面试练习','虚构经历',['career'],3,30);
    const item=w.getWorkItem(id);
    const run=w.claimWorkRun(id,'career','source','mock',{request:item.request,material:item.material,facts:[],preferences:[],upstream:null,agentEpochs:{career:s.getAgentEpoch('career')},revision:1,minutes:30,priority:3},null);
    w.completeWorkRun(run.id,'success','虚构成果',null);
    await p.startPractice(id,'career','invalid',1,undefined,undefined,fetcher).completion;
    const failed=w.workState().practices[0];
    assert.equal(failed.status,'failed');
    assert.equal(failed.question,null);
    assert.equal(failed.question_options_json,'[]');
    valid=true;
    await p.startPractice(id,'career','retry',1,failed.id,undefined,fetcher).completion;
    const retried=w.workState().practices[0];
    assert.equal(retried.status,'question');
    assert.equal(JSON.parse(retried.question_options_json).length,2);
  `);
});

test("legacy practice questions gain empty option arrays without losing answers", () => {
  const folder = mkdtempSync(join(tmpdir(), "agent-practice-options-migration-"));
  const dbPath = join(folder, "agents.sqlite");
  const run = script => spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const w=await import('${itemsUrl}'); const s=await import('${storeUrl}'); const assert=(await import('node:assert/strict')).default; ${script}`], {
    env: { ...process.env, AGENT_DB_PATH: dbPath }, encoding: "utf8", timeout: 15000,
  });
  try {
    const legacy = run(`
      const id=w.createWorkItem('旧练习','虚构资料',['career'],3,30);
      const item=w.getWorkItem(id);
      const source=w.claimWorkRun(id,'career','legacy-source','mock',{request:item.request,material:item.material,facts:[],preferences:[],upstream:null,agentEpochs:{career:s.getAgentEpoch('career')},revision:1,minutes:30,priority:3},null);
      w.completeWorkRun(source.id,'success','旧成果',null);
      s.getDatabase().prepare("INSERT INTO work_practices (id,item_id,role,source_artifact_id,question,answer,feedback,suggestion,status,created_at,updated_at) VALUES ('old-round',?,?,?,'你做了什么？','我核对了资料。','有依据。','继续练习。','feedback',datetime('now'),datetime('now'))").run(id,'career',w.getWorkArtifacts(id)[0].id);
      s.getDatabase().exec('ALTER TABLE work_practices DROP COLUMN question_options_json');
    `);
    assert.equal(legacy.status, 0, legacy.stderr);
    const migrated = run(`
      const round=w.workState().practices.find(entry=>entry.id==='old-round');
      assert.equal(round.question,'你做了什么？');
      assert.equal(round.answer,'我核对了资料。');
      assert.equal(round.question_options_json,'[]');
    `);
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.ok(readdirSync(folder).some(name => name.includes("backup-work-items-")));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
