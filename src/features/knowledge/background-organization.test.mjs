import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { automaticCandidates, normalizeOrganizationPreferences, runAutomaticOrganization } from './auto-organize.ts';
import { createOrganizationCoordinator, dueOrganizationSchedule, organizationWritesNote } from './background-organization-core.ts';
import { loadOrganizationMaterials } from './organization-materials.ts';
import { vaultKey } from './folders.ts';

const source=await readFile(new URL('./background-organization.ts',import.meta.url),'utf8');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function until(check){for(let i=0;i<25;i++){if(check())return;await turn();}assert.fail('background task did not reach expected state');}
let sequence=0;
async function fixture(options={}){
 globalThis.window=new EventTarget();globalThis.document=new EventTarget();
 const note={path:'08-收件箱/a.md',title:'A',kind:'inbox',modifiedAt:1,preview:'body'};
 const state={vaultRoot:'E:/vault',organization:normalizeOrganizationPreferences(null)};
 let job=options.job ?? null;let receipts={};let folders={experience:'old/experience',recipe:'old/recipe',resource:'old/resource'};
 const calls=[];const listeners=new Map();
 const jobs={getState:()=>({job,receipts,setJob:value=>{job=value;},claim:(key,value)=>{receipts={...receipts,[key]:value};}}),persist:{hasHydrated:()=>true}};
 const knowledge={getState:()=>state,subscribe:()=>()=>{},persist:{hasHydrated:()=>true}};
 const dependencies={
  emit:async(event,payload)=>{calls.push(['emit',event,payload]);},
  emitTo:async(label,event,payload)=>{calls.push(['emitTo',label,event,payload]);if(options.ack && event==='knowledge:organization-request')listeners.get('knowledge:organization-ack')?.({payload:{requestId:payload.requestId,jobId:'accepted-main-job'}});},
  listen:async(event,callback)=>{listeners.set(event,callback);return ()=>listeners.delete(event);},
  getCurrentWindow:()=>({label:options.capture?'capture':'main'}),inTauri:options.tauri ?? false,
  flushAllStorage:async()=>{calls.push(['flush',job?.progress]);if(options.flush)await options.flush(job);},providersReady:async()=>{},useProviders:{getState:()=>({})},selectProvider:()=>({}),
  scanNotes:async(root,snapshot)=>{calls.push(['scan',root,snapshot]);return [note];},listCaptures:async()=>[],readNote:async(_root,path)=>({path,content:'original',fingerprint:'original-fp'}),
  organizeNotes:async(root,input,snapshot)=>{calls.push(['save',root,input,snapshot]);if(options.save)await options.save;return {...note,path:'old/resource/A.md',organized:true};},
  automaticCandidates,normalizeOrganizationPreferences,runAutomaticOrganization,createOrganizationCoordinator,dueOrganizationSchedule,
  loadNoteDraft:async()=>options.draft?.() ?? null,vaultKey,loadOrganizationMaterials,
  suggestOrganization:async(_root,_materials,_images,prefs)=>{calls.push(['ai',prefs]);if(options.ai)await options.ai;return {title:'A',kind:'resource',tags:['topic'],content:'organized'};},
  useOrganizationJobs:jobs,getKnowledgeFolders:()=>folders,useKnowledge:knowledge,
 };
 const key=`__backgroundTest${++sequence}`;globalThis[key]=dependencies;
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020}}).outputText.replace(/^import .*;\r?\n/gm,'');
 const module=await import(`data:text/javascript;base64,${Buffer.from(`const {${Object.keys(dependencies).join(',')}}=globalThis.${key};\n${code}`).toString('base64')}`);
 delete globalThis[key];
 return {module,calls,listeners,state,jobs,get job(){return job;},setFolders:value=>{folders=value;}};
}

test('service freezes preferences and folder bindings across navigation/settings changes',async()=>{
 const wait=deferred();const f=await fixture({ai:wait.promise});
 f.state.organization.instructions='Keep code';
 const accepted=await f.module.startOrganization({root:'E:/vault'});
 assert.ok(accepted);await until(()=>f.calls.some(call=>call[0]==='ai'));
 f.state.organization=normalizeOrganizationPreferences({template:'recipe',instructions:'changed'});
 f.setFolders({experience:'new/experience',recipe:'new/recipe',resource:'new/resource'});
 wait.resolve();await until(()=>f.job.status==='completed');
 const save=f.calls.find(call=>call[0]==='save');
 assert.equal(save[3].resource,'old/resource');assert.equal(save[2].kind,'resource');
 assert.match(f.calls.find(call=>call[0]==='ai')[1].template,/Keep code/);
 assert.equal(f.job.result.completed[0].preview,'');
});
test('unsaved persisted editor draft is skipped before sending article to AI',async()=>{
 const f=await fixture({draft:()=>({base:{content:'old'},content:'unsaved'})});
 await f.module.startOrganization({root:'E:/vault'});await until(()=>f.job.status==='completed');
 assert.equal(f.calls.filter(call=>call[0]==='ai').length,0);
 assert.equal(f.calls.filter(call=>call[0]==='save').length,0);assert.match(f.job.result.failed[0].error,/草稿/);
});
test('typing into an editor during AI generation prevents the pending write',async()=>{
 const wait=deferred();const f=await fixture({ai:wait.promise});
 await f.module.startOrganization({root:'E:/vault'});await until(()=>f.calls.some(call=>call[0]==='ai'));
 f.module.setOrganizationBlockedPath('E:/vault','08-收件箱/a.md',true);
 wait.resolve();await until(()=>f.job.status==='completed');
 assert.equal(f.calls.filter(call=>call[0]==='save').length,0);assert.match(f.job.result.failed[0].error,/未保存/);
});
test('the final native write publishes and flushes a short edit lease, including while stopping',async()=>{
 const saving=deferred();const f=await fixture({save:saving.promise});
 await f.module.startOrganization({root:'E:/vault'});
 await until(()=>f.calls.some(call=>call[0]==='save'));
 assert.equal(organizationWritesNote(f.job,'E:/vault','08-收件箱/a.md'),true);
 const writeIndex=f.calls.findIndex(call=>call[0]==='save');
 assert.ok(f.calls.slice(0,writeIndex).some(call=>call[0]==='flush' && call[1]?.phase==='saving' && call[1]?.path==='08-收件箱/a.md'));
 await f.module.stopOrganization();assert.equal(f.job.status,'stopping');
 assert.equal(organizationWritesNote(f.job,'E:/vault','08-收件箱/a.md'),true);
 saving.resolve();await until(()=>f.job.status==='cancelled');
 assert.equal(organizationWritesNote(f.job,'E:/vault','08-收件箱/a.md'),false);
});
test('an edit racing with lease publication is checked again before invoking the native write',async()=>{
 let dirty=false;
 const f=await fixture({flush:job=>{if(job?.progress.phase==='saving')dirty=true;},draft:()=>dirty?{base:{content:'old'},content:'new draft'}:null});
 await f.module.startOrganization({root:'E:/vault'});await until(()=>f.job.status==='completed');
 assert.equal(f.calls.filter(call=>call[0]==='save').length,0);
 assert.match(f.job.result.failed[0].error,/草稿/);
 assert.equal(organizationWritesNote(f.job,'E:/vault','08-收件箱/a.md'),false);
});
test('runtime claims today durably before scheduled work and focus does not repeat it',async()=>{
 const f=await fixture();f.state.organization.schedule={enabled:true,time:'00:00'};
 const cleanup=f.module.startOrganizationRuntime();
 try{
  await until(()=>f.job?.status==='completed');
  const receipt=f.jobs.getState().receipts['e:/vault'];assert.equal(receipt.time,'00:00');
  const runs=f.calls.filter(call=>call[0]==='ai').length;window.dispatchEvent(new Event('focus'));await turn();await turn();
  assert.equal(f.calls.filter(call=>call[0]==='ai').length,runs);
 }finally{cleanup();}
});
test('a scheduled acceptance reserves single flight while its daily claim is being persisted',async()=>{
 const persisted=deferred();const f=await fixture({flush:()=>persisted.promise});
 f.state.organization.schedule={enabled:true,time:'00:00'};
 const cleanup=f.module.startOrganizationRuntime();
 try{
  await until(()=>f.job?.status==='running');
  await assert.rejects(f.module.startOrganization({root:'E:/vault',trigger:'manual'}),/已有整理任务/);
  assert.equal(f.calls.filter(call=>call[0]==='ai').length,0);
  persisted.resolve();await until(()=>f.job?.status==='completed');
  assert.equal(f.job.trigger,'schedule');assert.equal(f.calls.filter(call=>call[0]==='ai').length,1);
 }finally{persisted.resolve();cleanup();}
});
test('watcher cleanup never cancels accepted work and remount does not interrupt a live job',async()=>{
 const wait=deferred();const f=await fixture({ai:wait.promise});
 const cleanup=f.module.startOrganizationRuntime();await f.module.startOrganization({root:'E:/vault'});
 await until(()=>f.calls.some(call=>call[0]==='ai'));cleanup();
 const nextCleanup=f.module.startOrganizationRuntime();await turn();assert.equal(f.job.status,'running');
 wait.resolve();await until(()=>f.job.status==='completed');nextCleanup();
});
test('capture registers its acknowledgment listener before sending a path-only request',async()=>{
 const f=await fixture({tauri:true,capture:true,ack:true});
 assert.equal(await f.module.startOrganization({root:'E:/vault',paths:['08-收件箱/a.md'],trigger:'capture'}),'accepted-main-job');
 const request=f.calls.find(call=>call[0]==='emitTo')[3];
 assert.deepEqual(request.paths,['08-收件箱/a.md']);assert.equal(request.content,undefined);assert.equal(request.materials,undefined);
 assert.equal(f.listeners.has('knowledge:organization-ack'),false);
});
