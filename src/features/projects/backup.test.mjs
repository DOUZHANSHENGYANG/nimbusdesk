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
