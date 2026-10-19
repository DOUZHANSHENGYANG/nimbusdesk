import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const nativeRequire=createRequire(import.meta.url);
function setup(invokeOverride) {
 const store=state=>({getState:()=>state,setState:patch=>Object.assign(state,typeof patch==='function'?patch(state):patch),persist:{hasHydrated:()=>true}});
 const projects=store({areas:[],projects:[],iterations:[],items:[],memberships:[],deliveries:[],remoteTasks:[],remoteLinks:[],remoteExecutions:[],remoteChanges:[],reminderRule:{enabled:true,times:['09:00'],advanceDays:0,weekdays:[1],nonWorkingDay:'same',timezone:'Asia/Shanghai'}});
 const zen=store({connections:[{id:'c',name:'公司',baseUrl:'https://example.com/zentao/',account:'dev',apiVersion:'v1',executionIds:[],autoSync:false,syncMinutes:15,createdAt:1,updatedAt:1}],syncStates:{}}),plans=store({days:{}}),archive=store({days:{}}),calls=[];
 const envelopes=()=>({projects:{state:structuredClone(projects.getState()),version:1},plans:{state:structuredClone(plans.getState()),version:4},'plans-archive':{state:structuredClone(archive.getState()),version:3}});
 let failFlush=false;
 const cache=new Map(),mocks={
  '@/lib/storage':{flushAllStorage:async()=>{if(failFlush)throw Error('disk unavailable');},acceptCommittedStorage:async values=>{for(const [k,v] of Object.entries(values))({projects,plans,'plans-archive':archive}[k]).setState(v.state);}},
  '@/lib/tauri':{readJson:async key=>envelopes()[key],inTauri:true},
  '@/stores/storage-health':{useStorageHealth:{getState:()=>({problem:null,key:null})}},
  '@/features/plans/store':{usePlans:plans,usePlansArchive:archive},
  '@tauri-apps/api/core':{invoke:async(cmd,args)=>{calls.push({cmd,args});if(invokeOverride)return invokeOverride(cmd,args);if(cmd==='project_apply_remote_binding')return {projects:args.projects,plans:args.plans,archive:args.archive};return {apiVersion:'v1',tasks:[],executions:[],unavailableIds:[],fetchedAt:1};}},
  '@tauri-apps/plugin-opener':{openUrl:async url=>calls.push({url})},
  './store':{useProjects:projects,projectData:x=>structuredClone(x)},'./zentao-store':{useZentao:zen}
 };
 function load(name){if(mocks[name])return mocks[name];if(!name.startsWith('.'))return nativeRequire(name);if(cache.has(name))return cache.get(name).exports;const m={exports:{}};cache.set(name,m);const code=ts.transpileModule(readFileSync(new URL(`${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(load,m,m.exports);return m.exports;}
 return {api:load('./zentao-controller'),projects,zen,plans,archive,calls,failFlush:()=>{failFlush=true;}};
}
test('sync is nonblocking, suppresses duplicate requests and preserves local edits made during network IO',async()=>{
 let complete;const s=setup((cmd)=>cmd==='zentao_fetch_tasks'?new Promise(r=>complete=r):{});
 const job=s.api.syncZenConnection('c');await new Promise(r=>setImmediate(r));assert.equal(s.api.useZentaoRuntimeState.getState().busy.c,true);
 await assert.rejects(s.api.syncZenConnection('c'),/progress/);s.projects.getState().areas.push({id:'a',name:'新增分类',createdAt:1,updatedAt:1});
 complete({apiVersion:'v1',tasks:[],executions:[],unavailableIds:[],fetchedAt:20});await job;
 assert.equal(s.projects.getState().areas.length,1);assert.equal(s.api.useZentaoRuntimeState.getState().busy.c,false);assert.equal(s.zen.getState().syncStates.c.lastSyncAt,20);
});
test('failed authentication pauses automatic sync, sanitizes errors and leaves last good cache',async()=>{
 const s=setup(()=>{throw 'ZENTAO_AUTH_REQUIRED: secret-response';});s.projects.getState().items.push({id:'cached'});
 await assert.rejects(s.api.syncZenConnection('c'));
 assert.equal(s.projects.getState().items.length,1);assert.equal(s.zen.getState().syncStates.c.authRequired,true);assert.ok(!s.zen.getState().syncStates.c.lastError.includes('secret-response'));
});
test('no native requests run with unsaved configuration or unavailable storage',async()=>{
 const s=setup();s.failFlush();await assert.rejects(s.api.testZenConnection('c','secret'));assert.equal(s.calls.length,0);
});
test('restored/expired credentials require explicit validation before any task request',async()=>{
 const s=setup();s.zen.getState().syncStates.c={authRequired:true};
 await assert.rejects(s.api.syncZenConnection('c'),/Verify/);assert.equal(s.calls.length,0);
 await s.api.testZenConnection('c',undefined,'fixture-only');assert.equal(s.zen.getState().syncStates.c.authRequired,false);
 await s.api.syncZenConnection('c');assert.ok(s.calls.some(c=>c.cmd==='zentao_fetch_tasks'));
});
test('unsaved profile changes during IO cannot attach the previous server snapshot',async()=>{
 let complete;const s=setup(cmd=>cmd==='zentao_fetch_tasks'?new Promise(r=>complete=r):{});
 const job=s.api.syncZenConnection('c');await new Promise(r=>setImmediate(r));s.zen.getState().connections[0].account='different';
 complete({apiVersion:'v1',tasks:[],executions:[],unavailableIds:[],fetchedAt:10});await assert.rejects(job);assert.equal(s.zen.getState().syncStates.c.lastSyncAt,null);
});
test('binding commits three envelopes, retains identity, and undo rejects intervening edits',async()=>{
 const s=setup(),d=s.projects.getState(),base={createdAt:1,updatedAt:1,title:'manual',note:'',status:'todo',projectId:null,areaId:null,activeIterationId:null,deadline:null};
 d.items=[{...base,id:'a'},{...base,id:'b',title:'remote'}];d.remoteTasks=[{id:'c:task:7',connectionId:'c',remoteId:7,title:'remote',note:'',status:'wait',deadline:null,start:null,remoteProjectId:null,executionId:null,parentRemoteId:null,assignedTo:'dev',teamAccounts:[],lastEditedDate:null,updatedAt:1}];d.remoteLinks=[{id:'c:task:7',connectionId:'c',remoteId:7,itemId:'b',baseline:{title:'remote',note:'',status:'todo',deadline:null},divergedFields:[],updatedAt:1}];
 s.plans.getState().days={'2026-10-20':[{id:'p',parentId:null,workItemId:'b',title:'todo',done:false,createdAt:1,updatedAt:1}]};
 const result=await s.api.bindZenTask('a','c:task:7');assert.equal(s.calls.filter(c=>c.cmd==='project_apply_remote_binding').length,1);assert.equal(s.plans.getState().days['2026-10-20'][0].workItemId,'a');
 s.projects.getState().items[0].note='新修改';await assert.rejects(result.undo(),/changed/);assert.equal(s.projects.getState().items[0].note,'新修改');
});
function bindingFixture(s){const d=s.projects.getState();d.items=[{id:'local',createdAt:1,updatedAt:1,title:'local',note:'',status:'todo',projectId:null,areaId:null,activeIterationId:null,deadline:null}];d.remoteTasks=[{id:'c:task:7',connectionId:'c',remoteId:7,title:'remote',note:'',status:'wait',deadline:null,start:null,remoteProjectId:null,executionId:null,parentRemoteId:null,assignedTo:'dev',teamAccounts:[],lastEditedDate:null,updatedAt:1}];}
test('immediate undo restores the original bundle when commit matches the proposal',async()=>{
 const s=setup();bindingFixture(s);const before=structuredClone(s.projects.getState());
 const result=await s.api.bindZenTask('local','c:task:7');assert.equal(typeof result.undo,'function');await result.undo();assert.deepEqual(s.projects.getState(),before);
});
test('binding does not offer destructive snapshot undo when native merge includes another window edit',async()=>{
 const s=setup((cmd,args)=>{if(cmd==='project_apply_remote_binding'){const canonical=structuredClone(args);canonical.projects.state.areas.push({id:'concurrent',name:'Other window edit',createdAt:1,updatedAt:1});return{projects:canonical.projects,plans:canonical.plans,archive:canonical.archive};}return{};});bindingFixture(s);
 const result=await s.api.bindZenTask('local','c:task:7');assert.equal(result.undo,undefined);assert.equal(s.projects.getState().areas[0].name,'Other window edit');
});
