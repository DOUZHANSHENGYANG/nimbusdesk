import assert from 'node:assert/strict';import test from'node:test';import{createRequire}from'node:module';import{readFileSync}from'node:fs';import ts from'typescript';
const req=createRequire(import.meta.url),cache=new Map();function load(name){if(cache.has(name))return cache.get(name).exports;const m={exports:{}};cache.set(name,m);new Function('require','module','exports',ts.transpileModule(readFileSync(new URL(`${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(s=>s.startsWith('.')?load(s):req(s),m,m.exports);return m.exports;}
const {emptyProjectData}=load('./types');
const entity=(id,extra={})=>({id,createdAt:1,updatedAt:1,...extra});
test('restore retains local task metadata, adopts newer entities and never rebinds foreign project folders',()=>{
 const {mergeProjectBackup}=load('./backup');const local=emptyProjectData(),incoming=emptyProjectData();
 local.projects=[entity('p',{name:'local',areaId:null,status:'active',folder:'C:/local',note:''})];incoming.projects=[entity('p',{name:'new',areaId:null,status:'active',folder:'D:/foreign',note:'',updatedAt:2}),entity('q',{name:'q',areaId:null,status:'active',folder:'E:/other',note:''})];
 const merged=mergeProjectBackup(local,incoming);assert.equal(merged.projects[0].name,'new');assert.equal(merged.projects[0].folder,'C:/local');assert.equal(merged.projects[1].folder,null);assert.equal(local.projects[0].name,'local');
});
test('invalid references fail before backup changes and plan links require an existing work item',()=>{const {mergeProjectBackup,assertPlanLinks}=load('./backup');const incoming=emptyProjectData();incoming.items=[entity('i',{title:'x',projectId:'missing',areaId:null,note:'',deadline:null,status:'todo',activeIterationId:null})];assert.throws(()=>mergeProjectBackup(emptyProjectData(),incoming));assert.throws(()=>assertPlanLinks({state:{days:{day:[{id:'p',workItemId:'missing'}]}}},new Set()));assert.doesNotThrow(()=>assertPlanLinks({state:{days:{day:{tasks:[{id:'p',workItemId:null}]}}}},new Set()));});
test('explicit settings restore recovers project reminder preferences and validates every linked plan ID',()=>{
 const {mergeProjectBackup,assertPlanLinks}=load('./backup');const a=emptyProjectData(),b=emptyProjectData();b.reminderRule={...b.reminderRule,times:['12:34'],timezone:'UTC'};
 assert.deepEqual(mergeProjectBackup(a,b,{overwriteSettings:true}).reminderRule,b.reminderRule);assert.deepEqual(mergeProjectBackup(a,b).reminderRule,a.reminderRule);
 assert.throws(()=>assertPlanLinks({days:{day:[{id:'',workItemId:null}]}},new Set()),/plan ID/);
 assert.throws(()=>assertPlanLinks({days:{day:[{id:'same',workItemId:null},{id:'same',workItemId:null}]}},new Set()),/plan ID/);
});

const profile=(id='office',extra={})=>entity(id,{name:'Office',baseUrl:'https://example.test/zentao/',account:'me',apiVersion:'auto',executionIds:[],autoSync:true,syncMinutes:15,...extra});
const meta={lastSyncAt:10,lastError:null,lastCount:3,resolvedVersion:'v1',authRequired:false};
test('ZenTao backup metadata rejects credential fields at every contract level',()=>{
 const {readZenBackup}=load('./backup');const good={version:1,state:{connections:[profile()],syncStates:{office:meta}}};
 assert.deepEqual(readZenBackup(good),good.state);
 for(const at of ['envelope','state','profile','meta']) for(const key of ['password','token','credentialKey','unknown']) {const bad=structuredClone(good);const object=at==='envelope'?bad:at==='state'?bad.state:at==='profile'?bad.state.connections[0]:bad.state.syncStates.office;object[key]='private';assert.throws(()=>readZenBackup(bad),/metadata|credential|field/i);}
});
test('restored ZenTao profiles are disabled and require a fresh manual test while local identities are retained',()=>{
 const {mergeZenBackup}=load('./backup');const local={connections:[profile('office',{name:'Local',autoSync:true})],syncStates:{office:meta}};
 const incoming={connections:[profile('office',{name:'Backup',updatedAt:20}),profile('new')],syncStates:{office:meta,new:meta}};
 const merged=mergeZenBackup(local,incoming);assert.equal(merged.connections[0].name,'Local');assert.equal(merged.connections[0].autoSync,false);assert.equal(merged.connections[1].autoSync,false);assert.equal(merged.syncStates.office.authRequired,true);assert.equal(merged.syncStates.new.authRequired,true);assert.equal(local.connections[0].autoSync,true);
 const conflicting=structuredClone(incoming);conflicting.connections[0].account='other';assert.throws(()=>mergeZenBackup(local,conflicting),/identity|instance|account/i);
 conflicting.connections[0].account='me';conflicting.connections[0].baseUrl='https://other.test/';assert.throws(()=>mergeZenBackup(local,conflicting),/identity|instance|account/i);
});
test('restoring merged project tasks rewrites explicit active and archived descendants without changing material or inherited bindings',()=>{
 const {rewriteMergedPlanLinks,assertPlanLinks}=load('./backup');const data=emptyProjectData();
 data.items=[entity('survivor',{title:'A',projectId:null,areaId:null,note:'',deadline:null,status:'todo',activeIterationId:null}),entity('donor',{title:'B',projectId:null,areaId:null,note:'',deadline:null,status:'cancelled',activeIterationId:null,mergedIntoId:'survivor'})];
 const plans={version:4,state:{days:{day:[{id:'p',workItemId:'donor',attachments:[{path:'keep'}]},{id:'c',parentId:'p'},{id:'own',parentId:'p',workItemId:'donor'},{id:'none',parentId:'p',workItemId:null}]}}};
 const active=rewriteMergedPlanLinks(plans,data);assert.equal(active.state.days.day[0].workItemId,'survivor');assert.equal(active.state.days.day[2].workItemId,'survivor');assert.equal(Object.hasOwn(active.state.days.day[1],'workItemId'),false);assert.equal(active.state.days.day[3].workItemId,null);assert.deepEqual(active.state.days.day[0].attachments,[{path:'keep'}]);assert.equal(plans.state.days.day[0].workItemId,'donor');
 const archive=rewriteMergedPlanLinks({state:{days:{old:{archivedAt:5,tasks:plans.state.days.day}}}},data);assert.equal(archive.state.days.old.tasks[2].workItemId,'survivor');assert.equal(archive.state.days.old.archivedAt,5);
 assert.throws(()=>assertPlanLinks(plans,new Set(['survivor','donor']),new Set(['donor'])),/merged/i);
});

function queuedData(status='pending') {
 const data=emptyProjectData(),fields={title:'Source',note:'',deadline:null,status:'todo'};
 data.items=[entity('i',{...fields,title:'Local',projectId:null,areaId:null,activeIterationId:null})];
 data.remoteTasks=[{id:'office:task:7',connectionId:'office',remoteId:7,...fields,status:'wait',start:null,remoteProjectId:null,executionId:null,parentRemoteId:null,assignedTo:'me',teamAccounts:[],lastEditedDate:null,updatedAt:1}];
 data.remoteLinks=[{id:'office:task:7',connectionId:'office',remoteId:7,itemId:'i',baseline:fields,divergedFields:[],updatedAt:1}];
 data.remoteChanges=[{id:'office:task:7',connectionId:'office',remoteId:7,itemId:'i',status,base:fields,local:{...fields,title:'Local'},remote:fields,expected:fields,fields:['title'],lastError:null,updatedAt:2}];
 return data;
}
test('restored outbound intentions require verification and preserve all three conflict snapshots',()=>{
 const {mergeProjectBackup}=load('./backup');
 for(const status of ['pending','sending','failed','uncertain','conflict']) {
  const incoming=queuedData(status),merged=mergeProjectBackup(emptyProjectData(),incoming);
  assert.equal(merged.remoteChanges[0].status,status==='conflict'?'conflict':'uncertain');
  assert.deepEqual(merged.remoteChanges[0].base,incoming.remoteChanges[0].base);
  assert.deepEqual(merged.remoteChanges[0].local,incoming.remoteChanges[0].local);
  assert.deepEqual(merged.remoteChanges[0].remote,incoming.remoteChanges[0].remote);
  assert.equal(incoming.remoteChanges[0].status,status);
 }
 const local=queuedData(); assert.equal(mergeProjectBackup(local,emptyProjectData()).remoteChanges[0].status,'pending');
});
test('restored writable connection preferences are always read-only regardless of overwrite settings',()=>{
 const {readZenBackup,mergeZenBackup}=load('./backup');
 const incoming={connections:[profile('office',{writeFields:['title','note','deadline']})],syncStates:{office:meta}};
 assert.deepEqual(readZenBackup(incoming).connections[0].writeFields,['title','note','deadline']);
 const merged=mergeZenBackup(incoming,incoming);assert.deepEqual(merged.connections[0].writeFields,[]);assert.equal(merged.connections[0].autoSync,false);assert.equal(merged.syncStates.office.authRequired,true);
});
