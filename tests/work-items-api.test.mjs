import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const path = join(mkdtempSync(join(tmpdir(), "agent-work-api-")), "agents.sqlite");
const route = new URL("../src/app/api/work-items/route.ts", import.meta.url).href;
function child(script) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const api=await import('${route}'); ${script}`], { env: { ...process.env, AGENT_DB_PATH: path }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
test("non-template items persist, out-of-scope items stay limited and empty requests fail", () => {
  child(`
    const req=(body)=>new Request('http://127.0.0.1:3901/api/work-items',{method:'POST',headers:{host:'127.0.0.1:3901',origin:'http://127.0.0.1:3901','content-type':'application/json'},body:JSON.stringify(body)});
    const invalid=await api.POST(req({type:'create',request:'   ',material:'',roles:[],priority:3,minutes:30}));
    if(invalid.status!==400) process.exit(2);
    const created=await (await api.POST(req({type:'create',request:'Prepare a portfolio discussion in English',material:'A fictional project summary',roles:['career','english'],priority:4,minutes:35}))).json();
    if(created.state.items.find(i=>i.id===created.id)?.request!=='Prepare a portfolio discussion in English') process.exit(3);
    const limited=await (await api.POST(req({type:'create',request:'Plan my grocery shopping',material:'',roles:[],priority:2,minutes:20}))).json();
    if(limited.state.items.find(i=>i.id===limited.id)?.status!=='limited') process.exit(4);
    const updated=await (await api.POST(req({type:'update',id:created.id,revision:1,material:'A different fictional project summary',priority:4,minutes:50}))).json();
    if(updated.state.items.find(i=>i.id===created.id)?.revision!==2) process.exit(5);
    const read=await (await api.GET(new Request('http://127.0.0.1:3901/api/work-items',{headers:{host:'127.0.0.1:3901'}}))).json();
    if(read.items.length!==2) process.exit(6);
  `);
});

test("stale item and preference writes are rejected; saved roles match execution order", () => {
  child(`
    const req=(body)=>new Request('http://127.0.0.1:3901/api/work-items',{method:'POST',headers:{host:'127.0.0.1:3901',origin:'http://127.0.0.1:3901','content-type':'application/json'},body:JSON.stringify(body)});
    const created=await (await api.POST(req({type:'create',request:'Prepare an English interview story',material:'Original',roles:['english','career'],priority:3,minutes:30}))).json();
    const id=created.id;
    if(created.state.items.find(i=>i.id===id)?.roles!=='["career","english"]') process.exit(2);
    const first=await api.POST(req({type:'update',id,revision:1,material:'Tab A saved',priority:3,minutes:30}));
    if(first.status!==200) process.exit(3);
    const stale=await api.POST(req({type:'update',id,revision:1,material:'Tab B stale draft',priority:3,minutes:30}));
    if(stale.status!==409) process.exit(4);
    const staleCorrection=await api.POST(req({type:'correct',id,revision:1,text:'I only observed the research'}));
    if(staleCorrection.status!==409) process.exit(5);
    const staleStart=await api.POST(req({type:'start',id,revision:1,requestId:'stale-start'}));
    if(staleStart.status!==409) process.exit(6);
    const current=await (await api.GET(new Request('http://127.0.0.1:3901/api/work-items',{headers:{host:'127.0.0.1:3901'}}))).json();
    if(current.items.find(i=>i.id===id)?.material!=='Tab A saved' || current.items.find(i=>i.id===id)?.revision!==2) process.exit(7);
    const pref=await (await api.POST(req({type:'preference.save',role:'english',text:'Plain language'}))).json();
    const revoked=await api.POST(req({type:'preference.update',id:pref.id,text:'Plain language',active:false,expectedText:'Plain language',expectedActive:true}));
    if(revoked.status!==200) process.exit(8);
    const stalePref=await api.POST(req({type:'preference.update',id:pref.id,text:'Old tab edit',active:true,expectedText:'Plain language',expectedActive:true}));
    if(stalePref.status!==409) process.exit(9);
    const after=await (await api.GET(new Request('http://127.0.0.1:3901/api/work-items',{headers:{host:'127.0.0.1:3901'}}))).json();
    if(after.preferences.find(p=>p.id===pref.id)?.active!==0) process.exit(10);
  `);
});

test("saved item changes roles only through explicit update", () => {
  child(`
    const req=(body)=>new Request('http://127.0.0.1:3901/api/work-items',{method:'POST',headers:{host:'127.0.0.1:3901',origin:'http://127.0.0.1:3901','content-type':'application/json'},body:JSON.stringify(body)});
    const created=await (await api.POST(req({type:'create',request:'Shopping list',material:'Eggs',roles:[],priority:2,minutes:20}))).json();
    const id=created.id;
    const materialOnly=await (await api.POST(req({type:'update',id,revision:1,material:'Eggs, milk; please translate',priority:2,minutes:20}))).json();
    if(materialOnly.state.items.find(item=>item.id===id)?.roles!=='[]') process.exit(2);
    const revised=await (await api.POST(req({type:'update',id,revision:2,request:'Translate this shopping list',material:'Eggs, milk',englishRequirement:'Use plain English',roles:['english'],priority:2,minutes:20}))).json();
    const item=revised.state.items.find(entry=>entry.id===id);
    if(item.roles!=='["english"]' || item.status!=='planned' || item.english_requirement!=='Use plain English') process.exit(3);
    const stale=await api.POST(req({type:'update',id,revision:2,request:'Different request',material:'Eggs, milk',roles:['career'],priority:2,minutes:20}));
    if(stale.status!==409) process.exit(4);
  `);
});
