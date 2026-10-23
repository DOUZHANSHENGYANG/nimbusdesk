import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const nativeRequire=createRequire(import.meta.url),cache=new Map();
function load(name='./overview-core') {
 if(cache.has(name)) return cache.get(name).exports;
 const code=ts.transpileModule(readFileSync(new URL(`${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const m={exports:{}};cache.set(name,m);new Function('require','module','exports',code)(s=>s.startsWith('.')?load(s):nativeRequire(s),m,m.exports);return m.exports;
}
const home=load();
const item=(id,status,deadline=null,extra={})=>({id,title:id,status,deadline,...extra});
const entry=(id,pubDate)=>({id,title:id,pubDate});

test('open work items sort by deadline and undated ones go last',()=>{
 const items=[item('none','todo'),item('late','todo','2026-10-20'),item('done','done','2026-10-01'),item('cancelled','cancelled'),item('soon','doing','2026-10-16')];
 assert.deepEqual(home.prioritizeWorkItems(items).map(i=>i.id),['soon','late','none']);
 assert.deepEqual(home.prioritizeWorkItems(items).map(i=>i.status),['doing','todo','todo']);
 assert.deepEqual(home.prioritizeWorkItems(items,2).map(i=>i.id),['soon','late']);
 assert.deepEqual(home.prioritizeWorkItems(items,0),[]);
 assert.deepEqual(home.prioritizeWorkItems([]),[]);
});

test('feed timeline merges sources by publish date and drops duplicates',()=>{
 const entriesBySource={
  'github-trending':[entry('a',300),entry('b',100)],
  'hacker-news':[entry('c',500),entry('a',300)],
  'rss-empty':[],
 };
 assert.deepEqual(home.latestEntries(entriesBySource).map(({sourceId,entry})=>[sourceId,entry.id]),[
  ['hacker-news','c'],['github-trending','a'],['github-trending','b'],
 ]);
 assert.deepEqual(home.latestEntries(entriesBySource,2).map(({entry})=>entry.id),['c','a']);
 assert.deepEqual(home.latestEntries({}),[]);
 // 没有发布时间的排在有时间的后面，但仍然会出现
 assert.deepEqual(home.latestEntries({'x':[entry('noDate'),entry('dated',1)]}).map(({entry})=>entry.id),['dated','noDate']);
});

test('relative time stays at minute/hour/day granularity',()=>{
 const now=Date.parse('2026-10-23T12:00:00Z');
 assert.deepEqual(home.timeAgo(now-30_000,now),{amount:0,unit:'minute'});
 assert.deepEqual(home.timeAgo(now-5*60_000,now),{amount:5,unit:'minute'});
 assert.deepEqual(home.timeAgo(now-3*3_600_000,now),{amount:3,unit:'hour'});
 assert.deepEqual(home.timeAgo(now-50*3_600_000,now),{amount:2,unit:'day'});
 // 未来时间不出现负数
 assert.deepEqual(home.timeAgo(now+60_000,now),{amount:0,unit:'minute'});
});
