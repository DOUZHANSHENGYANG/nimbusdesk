import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const nativeRequire=createRequire(import.meta.url);
async function setup(policy){const cache=new Map();function load(name){if(name==='./zentao-store'&&policy)return{useZentao:{getState:()=>policy,persist:{hasHydrated:()=>policy.hydrated}}};if(name==='@/lib/storage')return{tauriJsonStorage:{getItem:async()=>null,setItem:async()=>{}},onStorageSynced:()=>()=>{}};if(name==='@/stores/storage-health')return{useStorageHealth:{getState:()=>({report(){}})}};if(!name.startsWith('.'))return nativeRequire(name);if(cache.has(name))return cache.get(name).exports;const code=ts.transpileModule(readFileSync(new URL(`${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const m={exports:{}};cache.set(name,m);new Function('require','module','exports',code)(load,m,m.exports);return m.exports;}const store=load('./store').useProjects; await store.persist.rehydrate(); return store;}
test('drag reorder moves only the named rows and keeps the rest in place',async()=>{
 const s=await setup();
 const a=s.getState().addProject({name:'A'}),b=s.getState().addProject({name:'B'}),c=s.getState().addProject({name:'C'});
 s.getState().reorderProjects([c,a,b]);
 assert.deepEqual(s.getState().projects.map(p=>p.name),['C','A','B']);
 assert.equal(s.getState().projects[0].id,c);
});
test('deleting a project unassigns its plans and keeps them addressable',async()=>{const s=await setup();const project=s.getState().addProject({name:'临时工程',tags:['桌面']});const kept=s.getState().addItem({title:'要保留的计划',projectId:project});s.getState().removeProject(project);assert.equal(s.getState().projects.length,0);assert.equal(s.getState().items.find(i=>i.id===kept).projectId,null);assert.equal(s.getState().items.find(i=>i.id===kept).title,'要保留的计划');});
test('create in iteration then carry preserves metadata and no duplicate membership',async()=>{const s=await setup(),a=s.getState().addIteration({name:'一期',start:'2026-10-01',end:'2026-10-14'}),b=s.getState().addIteration({name:'二期',start:'2026-10-15',end:'2026-10-28'});const id=s.getState().addItem({title:'先做再绑定',activeIterationId:a,note:'已有资料'});s.getState().carryItem(id,b);s.getState().carryItem(id,b);assert.equal(s.getState().items[0].note,'已有资料');assert.equal(s.getState().memberships.length,2);assert.equal(s.getState().memberships[0].snapshot.title,'先做再绑定');assert.throws(()=>s.getState().updateIteration(b,{end:'bad'}));assert.equal(s.getState().iterations[1].end,'2026-10-28');});
test('cancelling tasks retains IDs and plan references and can restore',async()=>{const s=await setup(),id=s.getState().addItem({title:'small task'});s.getState().removeItem(id);assert.equal(s.getState().items[0].id,id);assert.equal(s.getState().items[0].status,'cancelled');s.getState().updateItem(id,{status:'todo'});assert.equal(s.getState().items[0].status,'todo');});

test('reminder ledger before connection hydration preserves saved pending intentions',async()=>{
 const policy={hydrated:false,connections:[]},s=await setup(policy),base={title:'base',note:'',status:'todo',deadline:null};
 const item={id:'i',createdAt:1,updatedAt:1,...base,title:'local',projectId:null,areaId:null,activeIterationId:null};
 const source={id:'c:task:7',connectionId:'c',remoteId:7};
 const task={...source,title:'base',note:'',status:'wait',deadline:null,start:null,remoteProjectId:null,executionId:null,parentRemoteId:null,assignedTo:'dev',teamAccounts:[],lastEditedDate:null,updatedAt:1};
 const link={...source,itemId:'i',baseline:base,divergedFields:[],updatedAt:1};
 const change={...source,itemId:'i',status:'pending',base,local:{...base,title:'local'},remote:base,expected:base,fields:['title'],lastError:null,updatedAt:2};
 s.setState({items:[item],remoteTasks:[task],remoteLinks:[link],remoteChanges:[change]});
 assert.equal(s.getState().remoteChanges.length,1);
 policy.hydrated=true;policy.connections=[{id:'c',writeFields:['title']}];s.getState().updateItem('i',{title:'new edit'});
 assert.equal(s.getState().remoteChanges[0].local.title,'new edit');
});
