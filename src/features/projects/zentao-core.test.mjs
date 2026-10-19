import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const nativeRequire=createRequire(import.meta.url),cache=new Map();
function load(name='./zentao-core') { if(cache.has(name))return cache.get(name).exports; const m={exports:{}};cache.set(name,m);const code=ts.transpileModule(readFileSync(new URL(`${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(s=>s.startsWith('.')?load(s):nativeRequire(s),m,m.exports);return m.exports; }
const z=load(),{emptyProjectData}=load('./types'),{validateProjectData}=load('./core');
const task=(remoteId=7,patch={})=>({id:`c:task:${remoteId}`,connectionId:'c',remoteId,title:'云端任务',note:'资料',status:'wait',deadline:'2026-10-30',start:null,remoteProjectId:1,executionId:2,parentRemoteId:null,assignedTo:'dev',teamAccounts:[],lastEditedDate:null,updatedAt:10,...patch});
const result=(tasks)=>({tasks,executions:[],unavailableIds:[],apiVersion:'v1',fetchedAt:10});
test('sync deduplicates stable remote identity across pages and preserves missing tasks',()=>{
 let d=z.applyZenSnapshot(emptyProjectData(),'c',result([task(),task()]),20).data;validateProjectData(d);
 assert.equal(d.items.length,1);assert.equal(d.remoteLinks.length,1);const id=d.items[0].id;
 d=z.applyZenSnapshot(d,'c',result([task(7,{status:'closed',title:'新标题'})]),30).data;
 assert.equal(d.items[0].id,id);assert.equal(d.items[0].status,'done');assert.equal(d.items[0].title,'新标题');
 d=z.applyZenSnapshot(d,'c',result([]),40).data;assert.equal(d.items.length,1);assert.equal(d.remoteTasks.length,1);
 const other=task(7,{id:'other:task:7',connectionId:'other'});d=z.applyZenSnapshot(d,'other',result([other]),50).data;assert.equal(d.items.length,2);
});
test('sync protects local changes with per-field baselines, retaining remote comparison data',()=>{
 let d=z.applyZenSnapshot(emptyProjectData(),'c',result([task()]),20).data;
 d.items[0].title='本地修改';d.items[0].deadline=null;
 d=z.applyZenSnapshot(d,'c',result([task(7,{title:'云端也修改',status:'doing'})]),30).data;
 assert.equal(d.items[0].title,'本地修改');assert.equal(d.items[0].status,'doing');assert.equal(d.items[0].deadline,null);
 assert.deepEqual(d.remoteLinks[0].divergedFields,['title']);assert.equal(d.remoteLinks[0].baseline.title,'云端任务');
 d.items[0].title='云端也修改';d=z.applyZenSnapshot(d,'c',result([task(7,{title:'云端也修改',status:'doing'})]),40).data;
 assert.deepEqual(d.remoteLinks[0].divergedFields,[]);assert.equal(d.remoteLinks[0].baseline.title,'云端也修改');
});
test('late binding merges explicitly, rewires active and archived plans without losing attachments or history',()=>{
 let d=z.applyZenSnapshot(emptyProjectData(),'c',result([task()]),20).data;const donor=d.items[0];
 d.items.push({...donor,id:'manual',title:'先做的需求',note:'本地资料',deadline:null});
 d.iterations=[{id:'it',name:'一期',start:'2026-10-01',end:'2026-10-30',createdAt:1,updatedAt:1}];
 donor.activeIterationId='it';donor.status='doing';d.memberships=[{id:'m',itemId:donor.id,iterationId:'it',joinedAt:1,leftAt:null,carriedFrom:null,updatedAt:1}];
 const p={id:'p',parentId:null,title:'计划',workItemId:donor.id,start:'09:00',end:'10:00',attachments:[{id:'a',name:'file',path:'a'}],createdAt:1,updatedAt:1};
 const plans={'2026-10-20':[p,{...p,id:'child',parentId:'p',workItemId:undefined}]},archive={'2026-10-19':{archivedAt:2,tasks:[{...p,id:'archived'}]}};
 const n=z.buildZenBinding(d,plans,archive,'manual',task().id,{status:'remote'},50);validateProjectData(n.data);
 assert.equal(n.data.remoteLinks[0].itemId,'manual');assert.equal(n.data.items.find(x=>x.id==='manual').title,'先做的需求');
 assert.equal(n.data.items.find(x=>x.id===donor.id).mergedIntoId,'manual');assert.equal(n.data.items.find(x=>x.id===donor.id).status,'cancelled');
 assert.equal(n.data.items.find(x=>x.id===donor.id).mergedSnapshot.item.status,'doing');assert.equal(n.data.memberships.find(x=>x.itemId==='manual').snapshot.status,'doing');
 assert.equal(n.plans['2026-10-20'][0].workItemId,'manual');assert.deepEqual(n.plans['2026-10-20'][0].attachments,p.attachments);
 assert.equal(n.archive['2026-10-19'].tasks[0].workItemId,'manual');assert.equal(n.plans['2026-10-20'][1].workItemId,undefined);
 assert.ok(n.data.memberships.some(x=>x.itemId==='manual'&&x.iterationId==='it'));assert.equal(d.items[0].mergedIntoId,undefined);
 assert.throws(()=>z.buildZenBinding(n.data,n.plans,n.archive,'manual',task().id,{},60),/bound/);
});
test('validation refuses cross-instance malformed identities, dangling links and merged donors',()=>{
 let d=z.applyZenSnapshot(emptyProjectData(),'c',result([task()]),20).data;
 assert.throws(()=>z.applyZenSnapshot(d,'c',result([task(8,{connectionId:'other'})]),30));
 d.remoteLinks.push({...d.remoteLinks[0],id:'bad'});assert.throws(()=>validateProjectData(d));d.remoteLinks.pop();
 d.items[0].mergedIntoId='missing';assert.throws(()=>validateProjectData(d));
});
test('connection drafts permit missing endpoint, reject credentials and normalize safe URLs',()=>{
 const c={id:'c',createdAt:1,updatedAt:1,name:'公司',baseUrl:'',account:'',apiVersion:'auto',executionIds:[],autoSync:false,syncMinutes:15};
 z.validateZenConnections({connections:[c],syncStates:{}});
 assert.throws(()=>z.validateZenConnections({connections:[{...c,password:'secret'}],syncStates:{}}));
 assert.throws(()=>z.normalizeZenUrl('https://user:secret@example.com/'));
 assert.throws(()=>z.normalizeZenUrl('file:///c:/a'));
 assert.equal(z.normalizeZenUrl('https://example.com/zentao/api.php/v1/'),'https://example.com/zentao/');
});
test('remote cache rejects oversized fields and malformed dates before publishing to a store',()=>{
 assert.throws(()=>z.applyZenSnapshot(emptyProjectData(),'c',result([task(7,{note:'界'.repeat(333334)})]),20));
 assert.throws(()=>z.applyZenSnapshot(emptyProjectData(),'c',result([task(7,{lastEditedDate:'2026-10-20T99:00:00'})]),20));
 assert.throws(()=>z.applyZenSnapshot(emptyProjectData(),'c',result([task(7,{teamAccounts:['']})]),20));
 const d=z.applyZenSnapshot(emptyProjectData(),'c',result([task(7,{lastEditedDate:'2026-10-20T12:30:01.123+08:00'})]),20).data;validateProjectData(d);
});
