import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),cache=new Map();
function load(name){if(cache.has(name))return cache.get(name).exports;const m={exports:{}};cache.set(name,m);new Function('require','module','exports',ts.transpileModule(readFileSync(new URL(`${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(s=>s.startsWith('.')?load(s):require(s),m,m.exports);return m.exports;}
const z=load('./zentao-writeback-core'),{applyZenSnapshot,buildZenBinding}=load('./zentao-core'),{emptyProjectData}=load('./types'),{validateProjectData}=load('./core');
const connection={id:'c',writeFields:['title','note','deadline']};
const task={id:'c:task:7',connectionId:'c',remoteId:7,title:'base',note:'base note',deadline:null,status:'wait',start:null,remoteProjectId:null,executionId:null,parentRemoteId:null,assignedTo:'dev',teamAccounts:[],lastEditedDate:null,updatedAt:1};
const snapshot=t=>({apiVersion:'v1',tasks:[t],executions:[],unavailableIds:[],fetchedAt:1});
function data(){return applyZenSnapshot(emptyProjectData(),'c',snapshot(task),1).data;}
test('only explicitly enabled ordinary local fields queue with the task in the same envelope',()=>{
 const d=data();d.items[0].title='local';d.items[0].status='done';d.items[0].note='local note';
 assert.equal(z.reconcileZenChanges(d,[]).remoteChanges.length,0);
 const n=z.reconcileZenChanges(d,[{...connection,writeFields:['title']}],5);validateProjectData(n);
 assert.equal(n.remoteChanges[0].status,'pending');assert.deepEqual(n.remoteChanges[0].fields,['title']);assert.equal(d.remoteChanges.length,0);
});
test('same-field remote edits conflict, unrelated changes merge and equal values converge',()=>{
 let d=data();d.items[0].title='local';d=applyZenSnapshot(d,'c',snapshot({...task,title:'remote',note:'remote note'}),2).data;
 d=z.reconcileZenChanges(d,[connection],3);assert.equal(d.remoteChanges[0].status,'conflict');assert.equal(d.items[0].note,'remote note');assert.equal(d.remoteChanges[0].base.title,'base');
 d=applyZenSnapshot(d,'c',snapshot({...task,title:'local',note:'remote note'}),4).data;d=z.reconcileZenChanges(d,[connection],5);assert.equal(d.remoteChanges.length,0);
});
test('resolution accepts individual remote fields or edited local proposal and rejects stale choices',()=>{
 let d=data();d.items[0].title='local';d.items[0].note='local note';d=applyZenSnapshot(d,'c',snapshot({...task,title:'remote',note:'remote note'}),2).data;d=z.reconcileZenChanges(d,[connection],3);
 const change=d.remoteChanges[0];
 assert.throws(()=>z.resolveZenChange(d,change.id,{title:{choice:'local'},note:{choice:'remote'}},2,[connection],4),/changed/);
 const n=z.resolveZenChange(d,change.id,{title:{choice:'edit',value:'merged title'},note:{choice:'remote'}},change.updatedAt,[connection],4);
 assert.equal(n.items[0].title,'merged title');assert.equal(n.items[0].note,'remote note');assert.deepEqual(n.remoteChanges[0].fields,['title']);assert.equal(n.remoteChanges[0].status,'pending');validateProjectData(n);
});
test('in-flight payload stays immutable, and acknowledgment retains newer local edits as a new intention',()=>{
 let d=data();d.items[0].title='sent';d=z.reconcileZenChanges(d,[connection],2);d=z.prepareZenWrite(d,task.id,[connection],3).data;assert.equal(d.remoteChanges[0].status,'sending');
 d.items[0].title='new edit';const queued=z.reconcileZenChanges(d,[connection],4);assert.equal(queued.remoteChanges[0].local.title,'sent');
 const n=z.acknowledgeZenWrite(queued,task.id,{...task,title:'sent'},[connection],5);assert.equal(n.items[0].title,'new edit');assert.equal(n.remoteLinks[0].baseline.title,'sent');assert.equal(n.remoteChanges[0].status,'pending');assert.equal(n.remoteChanges[0].local.title,'new edit');
});
test('ambiguous results survive policy disable and need verification before retry or resolution',()=>{
 let d=data();d.items[0].title='sent';d=z.reconcileZenChanges(d,[connection],2);d.remoteChanges[0].status='uncertain';
 d=z.reconcileZenChanges(d,[],3);assert.equal(d.remoteChanges[0].status,'uncertain');assert.throws(()=>z.prepareZenWrite(d,task.id,[connection],4),/verif/i);
 const n=z.verifyZenChange(d,task.id,{...task,title:'sent'},[connection],5);assert.equal(n.remoteChanges.length,0);assert.equal(n.remoteLinks[0].baseline.title,'sent');
});
test('verified unknown write that did not apply becomes manually retryable, third value becomes conflict',()=>{
 let d=data();d.items[0].title='sent';d=z.reconcileZenChanges(d,[connection],2);d.remoteChanges[0].status='uncertain';
 const n=z.verifyZenChange(d,task.id,task,[connection],3);assert.equal(n.remoteChanges[0].status,'failed');
 const c=z.verifyZenChange(d,task.id,{...task,title:'someone else'},[connection],4);assert.equal(c.remoteChanges[0].status,'conflict');
});
test('validation rejects dangling queue, status writes and repeated fields',()=>{
 let d=data();d.items[0].title='local';d=z.reconcileZenChanges(d,[connection],2);
 const q=d.remoteChanges[0];q.fields.push('status');assert.throws(()=>validateProjectData(d));q.fields=['title','title'];assert.throws(()=>validateProjectData(d));q.fields=['title'];q.itemId='missing';assert.throws(()=>validateProjectData(d));
});
test('binding keeps the old draft in merge audit and never reassigns an uncertain external operation',()=>{
 let d=data();const donor=d.items[0];donor.title='donor draft';d=z.reconcileZenChanges(d,[connection],2);d.items.push({...donor,id:'manual',title:'manual'});
 const n=buildZenBinding(d,{}, {},'manual',task.id,{},3);validateProjectData(n.data);assert.equal(n.data.remoteChanges.length,0);assert.equal(n.data.items.find(i=>i.id===donor.id).mergedSnapshot.change.local.title,'donor draft');
 d.remoteChanges[0].status='uncertain';assert.throws(()=>buildZenBinding(d,{}, {},'manual',task.id,{},4),/Verify/);
});
test('interrupted sending becomes uncertain on hydration without altering the original record',()=>{
 let d=data();d.items[0].title='local';d=z.reconcileZenChanges(d,[connection],2);d.remoteChanges[0].status='sending';const n=z.recoverZenChanges(d);assert.equal(n.remoteChanges[0].status,'uncertain');assert.equal(d.remoteChanges[0].status,'sending');
});
