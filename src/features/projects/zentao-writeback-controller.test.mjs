import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
function setup(invokeOverride) {
 const cache=new Map(),calls=[];let busy=false,onFlush;
 const stores={};const stateStore=s=>({getState:()=>s,setState:patch=>Object.assign(s,typeof patch==='function'?patch(s):patch),persist:{hasHydrated:()=>true}});
 const mocks={
  '@/lib/storage':{flushAllStorage:async()=>{calls.push({cmd:'flush'});onFlush?.();}},
  './store':{useProjects:null,projectData:s=>structuredClone(s)},
  './zentao-store':{useZentao:null},
  './zentao-controller':{exclusive:async(_id,fn)=>{if(busy)throw Error('busy');busy=true;try{return await fn();}finally{busy=false;}}},
  '@tauri-apps/api/core':{invoke:async(cmd,args)=>{calls.push({cmd,args});return invokeOverride?invokeOverride(cmd,args,stores):{...task,...(args?.changes??{})};}}
 };
 function load(name){if(mocks[name])return mocks[name];if(!name.startsWith('.'))return require(name);if(cache.has(name))return cache.get(name).exports;const m={exports:{}};cache.set(name,m);new Function('require','module','exports',ts.transpileModule(readFileSync(new URL(`${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(load,m,m.exports);return m.exports;}
 const task={id:'c:task:7',connectionId:'c',remoteId:7,title:'base',note:'base note',deadline:null,status:'wait',start:null,remoteProjectId:null,executionId:null,parentRemoteId:null,assignedTo:'dev',teamAccounts:[],lastEditedDate:null,updatedAt:1};
 const connection={id:'c',baseUrl:'https://example.com/',account:'dev',apiVersion:'v1',writeFields:['title']};
 const core=load('./zentao-core'),w=load('./zentao-writeback-core');let d=core.applyZenSnapshot(load('./types').emptyProjectData(),'c',{apiVersion:'v1',tasks:[task],executions:[],unavailableIds:[],fetchedAt:1},1).data;d.items[0].title='local';d=w.reconcileZenChanges(d,[connection],2);
 const projects=stateStore(d),zen=stateStore({connections:[connection],syncStates:{c:{authRequired:false,resolvedVersion:'v1'}}});mocks['./store'].useProjects=projects;mocks['./zentao-store'].useZentao=zen;Object.assign(stores,{projects,zen,w,task,calls});
 return {...stores,api:load('./zentao-writeback-controller'),onFlush:fn=>{onFlush=fn;}};
}
test('intent is durably marked sending before minimal ordinary-field request and verified result advances baseline',async()=>{
 const s=setup((cmd,args,st)=>{if(cmd==='zentao_write_task'){assert.equal(st.projects.getState().remoteChanges[0].status,'sending');assert.equal(st.calls.at(-2).cmd,'flush');assert.deepEqual(args.changes,{title:'local'});return {...st.task,title:'local'};}return st.task;});
 await s.api.sendZenChanges('c:task:7');assert.equal(s.projects.getState().remoteLinks[0].baseline.title,'local');assert.equal(s.projects.getState().remoteChanges.length,0);
});
test('unknown write survives and cannot be sent again before explicit readback',async()=>{
 const s=setup(()=>{throw 'ZENTAO_WRITE_UNCERTAIN private response';});await assert.rejects(s.api.sendZenChanges('c:task:7'));
 assert.equal(s.projects.getState().remoteChanges[0].status,'uncertain');assert.ok(!s.projects.getState().remoteChanges[0].lastError.includes('private response'));
 const calls=s.calls.length;await assert.rejects(s.api.sendZenChanges('c:task:7'),/Verify/i);assert.equal(s.calls.filter(c=>c.cmd==='zentao_write_task').length,1);assert.ok(s.calls.length>=calls);
});
test('fresh source detects stale conflict choices instead of applying them',async()=>{
 const s=setup((_cmd,_args,st)=>({...st.task,title:'remote changed'}));const before=s.projects.getState().remoteChanges[0].updatedAt;
 await assert.rejects(s.api.resolveZenChanges('c:task:7',{title:{choice:'remote'}},before),/changed/i);
 assert.equal(s.projects.getState().items[0].title,'local');assert.equal(s.projects.getState().remoteChanges[0].status,'conflict');
});
test('changed remote guard refreshes comparison and never retries an update automatically',async()=>{
 const s=setup((cmd,_args,st)=>{if(cmd==='zentao_write_task')throw 'ZENTAO_REMOTE_CHANGED';return {...st.task,title:'other editor'};});
 await assert.rejects(s.api.sendZenChanges('c:task:7'));
 assert.equal(s.projects.getState().remoteChanges[0].status,'conflict');assert.equal(s.calls.filter(c=>c.cmd==='zentao_write_task').length,1);
});
test('local edits made while request is in flight remain queued after acknowledged write',async()=>{
 let complete;const s=setup(cmd=>cmd==='zentao_write_task'?new Promise(r=>complete=r):{});
 const job=s.api.sendZenChanges('c:task:7');await new Promise(r=>setImmediate(r));s.projects.getState().items[0].title='newer local';complete({...s.task,title:'local'});await job;
 assert.equal(s.projects.getState().items[0].title,'newer local');assert.equal(s.projects.getState().remoteChanges[0].local.title,'newer local');
});
test('readonly and restored unauthenticated profiles cannot invoke native update',async()=>{
 const s=setup();s.zen.getState().connections[0].writeFields=[];await assert.rejects(s.api.sendZenChanges('c:task:7'));assert.equal(s.calls.filter(c=>c.cmd==='zentao_write_task').length,0);
 const auth=setup();auth.zen.getState().syncStates.c.authRequired=true;await assert.rejects(auth.api.sendZenChanges('c:task:7'));assert.equal(auth.calls.filter(c=>c.cmd==='zentao_write_task').length,0);
});
test('a canonical edit received during initial flush invalidates the reviewed send before any request',async()=>{
 const s=setup(),review=s.projects.getState().remoteChanges[0].updatedAt;
 s.onFlush(()=>{s.projects.getState().items[0].title='not reviewed';s.projects.setState(s.w.reconcileZenChanges(s.projects.getState(),s.zen.getState().connections,20));});
 await assert.rejects(s.api.sendZenChanges('c:task:7',review),/changed/i);assert.equal(s.calls.filter(c=>c.cmd==='zentao_write_task').length,0);
});
test('canonical JSON key ordering during flush does not invalidate an unchanged review',async()=>{
 const s=setup();let first=true;
 const sorted=v=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
 s.onFlush(()=>{if(first){first=false;s.projects.getState().remoteChanges=s.projects.getState().remoteChanges.map(sorted);}});
 await s.api.sendZenChanges('c:task:7');assert.equal(s.projects.getState().remoteChanges.length,0);
});
