import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrganizationCoordinator, dueOrganizationSchedule, interruptedJob, metadataResult, organizationWritesNote } from './background-organization-core.ts';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
const result={completed:[],failed:[],cancelled:false};
function fixture(overrides={}){
 let job=null;let seq=0;const writes=[];const completions=[];
 const runner=createOrganizationCoordinator({ready:async()=>{},readJob:()=>job,writeJob:value=>{job=value;writes.push(value);},flush:async()=>{},execute:async()=>result,completed:value=>completions.push(value),id:()=>`job-${++seq}`,now:()=>100,...overrides});
 return {runner,writes,completions,get job(){return job;}};
}
test('submission returns while work remains running and rejects a second concurrent request',async()=>{
 const wait=deferred();const state=fixture({execute:()=>wait.promise});
 assert.equal(await state.runner.start({root:'E:/vault'}),'job-1');
 await tick();assert.equal(state.job.status,'running');
 await assert.rejects(state.runner.start({root:'E:/other'}),/ORGANIZATION_BUSY/);
 wait.resolve(result);await tick();
 assert.equal(state.job.status,'completed');assert.equal(state.completions.length,1);
 assert.equal(await state.runner.start({root:'E:/other'}),'job-2');
});
test('the hydration and durable acceptance boundary precede any AI work',async()=>{
 const ready=deferred(),persist=deferred();let runs=0;
 const state=fixture({ready:()=>ready.promise,flush:()=>persist.promise,execute:async()=>{runs++;return result;}});
 const acceptance=state.runner.start({root:'E:/vault'});
 await tick();assert.equal(state.job,null);assert.equal(runs,0);
 ready.resolve();await tick();assert.equal(state.job.status,'running');assert.equal(runs,0);
 persist.resolve();await acceptance;await tick();assert.equal(runs,1);
});
test('cancellation remains single flight until current operation finishes',async()=>{
 const wait=deferred();let stop;
 const state=fixture({execute:async(_request,control)=>{stop=control.shouldStop;await wait.promise;return {...result,cancelled:stop()};}});
 await state.runner.start({root:'E:/vault',trigger:'capture'});await tick();
 await state.runner.stop();assert.equal(stop(),true);assert.equal(state.job.status,'stopping');
 await assert.rejects(state.runner.start({root:'E:/vault'}),/ORGANIZATION_BUSY/);
 wait.resolve();await tick();assert.equal(state.job.status,'cancelled');
});
test('failures and progress survive independently of a mounted component',async()=>{
 const state=fixture({execute:async(_request,control)=>{control.progress({processed:1,total:2,title:'Note'});throw new Error('No provider');}});
 await state.runner.start({root:'E:/vault'});await tick();
 assert.equal(state.job.status,'failed');assert.equal(state.job.error,'No provider');
 assert.deepEqual(state.job.progress,{processed:1,total:2,title:'Note'});
});
test('restart marks only unfinished jobs interrupted and never reruns them implicitly',()=>{
 const running={id:'old',root:'E:/vault',status:'running',startedAt:1,progress:{processed:1,total:3,title:'A'}};
 assert.equal(interruptedJob(running,10).status,'interrupted');assert.equal(interruptedJob(running,10).finishedAt,10);
 assert.equal(interruptedJob({...running,status:'completed'},10).status,'completed');
 assert.equal(interruptedJob(null,10),null);
});
test('local daily schedule catches up once and never starts before configured time',()=>{
 const schedule={enabled:true,time:'20:00'};
 assert.equal(dueOrganizationSchedule(new Date(2026,9,17,19,59), 'E:/Vault',schedule,{}),null);
 const claim=dueOrganizationSchedule(new Date(2026,9,17,22,30), 'E:/Vault',schedule,{});
 assert.equal(claim.day,'2026-10-17');assert.equal(claim.time,'20:00');
 const receipts={'e:/vault':claim};
 assert.equal(dueOrganizationSchedule(new Date(2026,9,17,23), 'e:\\vault\\',schedule,receipts),null);
 assert.equal(dueOrganizationSchedule(new Date(2026,9,17,23), 'E:/Vault',{enabled:true,time:'21:00'},receipts),null);
 assert.equal(dueOrganizationSchedule(new Date(2026,9,18,21), 'E:/Vault',schedule,receipts).day,'2026-10-18');
 assert.equal(dueOrganizationSchedule(new Date(2026,9,18,21), 'E:/Vault',{enabled:false,time:'20:00'},receipts),null);
});
test('persisted results retain status metadata but no frontmatter or article preview',()=>{
 const saved=metadataResult({completed:[{path:'x.md',title:'X',kind:'recipe',modifiedAt:1,preview:'secret body',frontmatter:'private yaml',organized:true}],failed:[{path:'bad.md',error:'Oops'}],cancelled:false});
 assert.equal(saved.completed[0].preview,'');assert.equal(saved.completed[0].frontmatter,undefined);
 assert.equal(saved.completed[0].path,'x.md');
});
test('the short write lease matches the vault and note while running or stopping only',()=>{
 const job={root:'E:/Vault',status:'running',progress:{processed:0,total:1,title:'A',phase:'saving',path:'08-收件箱/a.md'}};
 assert.equal(organizationWritesNote(job,'e:\\vault\\','08-收件箱\\A.md'),true);
 assert.equal(organizationWritesNote({...job,status:'stopping'},'E:/Vault','08-收件箱/a.md'),true);
 assert.equal(organizationWritesNote(job,'E:/other','08-收件箱/a.md'),false);
 assert.equal(organizationWritesNote(job,'E:/Vault','08-收件箱/b.md'),false);
 assert.equal(organizationWritesNote({...job,status:'completed'},'E:/Vault','08-收件箱/a.md'),false);
 assert.equal(organizationWritesNote({...job,progress:{processed:0,total:1,title:'A'}},'E:/Vault','08-收件箱/a.md'),false);
});
