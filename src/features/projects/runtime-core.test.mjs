import assert from 'node:assert/strict';import test from 'node:test';import {readFileSync} from 'node:fs';import{createRequire}from'node:module';import ts from'typescript';
const req=createRequire(import.meta.url),cache=new Map();function load(name){if(cache.has(name))return cache.get(name).exports;const m={exports:{}};cache.set(name,m);const code=ts.transpileModule(readFileSync(new URL(`${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(s=>s.startsWith('.')?load(s):req(s),m,m.exports);return m.exports;}
const {emptyProjectData}=load('./types');
test('failed notifications remain retryable; successful catchup persists once and concurrent ticks coalesce',async()=>{
 const {createProjectReminderRunner}=load('./runtime-core'),data=emptyProjectData();data.items=[{id:'i',title:'Deadline',status:'todo',deadline:'2026-10-18',activeIterationId:null}];let sent=0,saved=0,ok=false;
 const tick=createProjectReminderRunner({getData:()=>data,notify:async()=>{sent++;await Promise.resolve();return ok;},save:async rows=>{data.deliveries.push(...rows);saved++;},now:()=>new Date('2026-10-18T17:00:00+08:00')});
 await tick();assert.equal(saved,0);ok=true;await Promise.all([tick(),tick()]);assert.equal(sent,2);assert.equal(saved,1);assert.deepEqual(data.deliveries[0].slots,['09:00','16:50']);await tick();assert.equal(sent,2);
});
test('actual runtime effect remount shares in-flight sender and saves success after first cleanup',async()=>{
 const data=emptyProjectData();data.reminderRule={...data.reminderRule,times:['00:00'],timezone:'UTC'};data.items=[{id:'strict',title:'Strict',status:'todo',deadline:new Date().toISOString().slice(0,10),activeIterationId:null}];
 let notify=0,resolve;const gate=new Promise(r=>resolve=r),effects=[];const win=globalThis.window,doc=globalThis.document;
 globalThis.window={setInterval:()=>1,addEventListener(){},removeEventListener(){}};globalThis.document={addEventListener(){},removeEventListener(){}};
 const fakeStore={getState:()=>({...data,markDelivered:row=>data.deliveries.push(row)}),persist:{hasHydrated:()=>true,onFinishHydration:()=>()=>{}}};
 const dependencies={react:{useEffect:effect=>effects.push(effect)},sonner:{toast:{warning(){},error(){}}},'./store':{useProjects:fakeStore},'./runtime-core':load('./runtime-core'),'@/lib/tauri':{inTauri:true},'@/lib/storage':{flushAllStorage:async()=>{}},'@/lib/notify':{sendNotification:async()=>{notify++;await gate;return true;},requestNotificationPermission:async()=>{}},'@/lib/i18n':{i18n:{language:'en'}}};
 const m={exports:{}};const code=ts.transpileModule(readFileSync(new URL('./runtime.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 try{new Function('require','module','exports',code)(s=>dependencies[s],m,m.exports);m.exports.ProjectRuntime();const cleanFirst=effects[0]();cleanFirst();const cleanSecond=effects[0]();assert.equal(notify,1);resolve();await new Promise(r=>setImmediate(r));assert.equal(data.deliveries.length,1);cleanSecond();}
 finally{globalThis.window=win;globalThis.document=doc;}
});
