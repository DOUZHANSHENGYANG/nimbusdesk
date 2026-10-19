import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const nativeRequire=createRequire(import.meta.url);
async function setup() {
 const cache=new Map(),tasks=[],writes=[],synced=[],reports=[];
 const mocks={
  './store':{useProjects:{persist:{hasHydrated:()=>true},getState:()=>({remoteTasks:tasks})}},
  '@/lib/storage':{tauriJsonStorage:{getItem:async()=>null,setItem:async(_key,value)=>writes.push(JSON.parse(value))},onStorageSynced:fn=>{synced.push(fn);return()=>{};}},
  '@/stores/storage-health':{useStorageHealth:{getState:()=>({report:(...args)=>reports.push(args)})}}
 };
 function load(name){if(mocks[name])return mocks[name];if(!name.startsWith('.'))return nativeRequire(name);if(cache.has(name))return cache.get(name).exports;const m={exports:{}};cache.set(name,m);const code=ts.transpileModule(readFileSync(new URL(`${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(load,m,m.exports);return m.exports;}
 const store=load('./zentao-store').useZentao;await store.persist.rehydrate();return {store,tasks,writes,synced,reports};
}
test('multiple connection drafts are offline metadata with strict credential exclusion',async()=>{
 const {store,writes}=await setup();const a=store.getState().addConnection({name:'公司'}),b=store.getState().addConnection({name:'测试'});
 assert.notEqual(a,b);assert.equal(store.getState().connections[0].autoSync,false);assert.equal(store.getState().connections[0].baseUrl,'');
 assert.throws(()=>store.getState().updateConnection(a,{token:'do-not-store'}));assert.throws(()=>store.getState().addConnection({name:'bad',password:'do-not-store'}));
 assert.ok(writes.every(value=>!JSON.stringify(value).includes('do-not-store')));assert.equal(store.getState().connections.length,2);
});
test('source identity and referenced profile deletion stay locked after initial sync',async()=>{
 const {store,tasks,synced,reports}=await setup(),id=store.getState().addConnection({name:'公司',baseUrl:'https://example.com/zentao/api.php/v1',account:'dev'});
 assert.equal(store.getState().connections[0].baseUrl,'https://example.com/zentao/');tasks.push({connectionId:id});
 assert.throws(()=>store.getState().updateConnection(id,{baseUrl:'https://other.example.com/'}));assert.throws(()=>store.getState().updateConnection(id,{account:'another'}));assert.throws(()=>store.getState().removeConnection(id));
 store.getState().updateConnection(id,{autoSync:true,executionIds:[12]});assert.equal(store.getState().connections[0].autoSync,true);
 synced[0]('zentao',{state:{connections:[],syncStates:{},password:'secret'}});assert.equal(store.getState().connections.length,1);assert.equal(reports.length,1);
});
