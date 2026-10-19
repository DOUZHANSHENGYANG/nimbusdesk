import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
test('background polling waits for hydration, skips drafts/auth failures, backs off and cleans up',async()=>{
 let now=100_000,hydrated=false,cleanup,tick,focused,subscribed,unsubscribed=0;const jobs=[],busy={};
 const profiles=[{id:'ready',baseUrl:'https://example.com/',account:'dev',autoSync:true,syncMinutes:1},{id:'draft',baseUrl:'',account:'',autoSync:true,syncMinutes:1},{id:'disabled',baseUrl:'https://example.com/',account:'dev',autoSync:false,syncMinutes:1},{id:'expired',baseUrl:'https://example.com/',account:'dev',autoSync:true,syncMinutes:1}];
 const state={connections:profiles,syncStates:{expired:{authRequired:true}}};
 const store={getState:()=>state,persist:{hasHydrated:()=>hydrated,onFinishHydration:()=>()=>{unsubscribed++;}},subscribe:fn=>{subscribed=fn;return()=>{unsubscribed++;};}};
 const dependencies={react:{useEffect:fn=>{cleanup=fn();}},'./zentao-store':{useZentao:store},'./store':{useProjects:store},'../plans/store':{usePlans:store,usePlansArchive:store},'./zentao-controller':{syncZenConnection:async id=>{jobs.push(id);throw Error('network');},useZentaoRuntimeState:{getState:()=>({busy})}}};
 const code=ts.transpileModule(readFileSync(new URL('./zentao-runtime.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,m={exports:{}};
 new Function('require','module','exports','Date','setInterval','clearInterval','window',code)(name=>dependencies[name],m,m.exports,{now:()=>now},fn=>{tick=fn;return 1;},()=>{unsubscribed++;},{addEventListener:(_name,fn)=>focused=fn,removeEventListener:()=>{unsubscribed++;}});
 m.exports.ZentaoRuntime();assert.equal(jobs.length,0);hydrated=true;tick();assert.deepEqual(jobs,['ready']);
 focused();subscribed();assert.equal(jobs.length,1,'strict-mode/focus/subscriptions do not repeat a failed attempt immediately');
 now+=59_000;tick();assert.equal(jobs.length,1);now+=1_000;busy.ready=true;tick();assert.equal(jobs.length,1);busy.ready=false;tick();assert.equal(jobs.length,2);
 cleanup();assert.equal(unsubscribed,7);await Promise.resolve();
});
