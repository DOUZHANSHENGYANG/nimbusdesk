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
const overview=load();
const item=(id,status,extra={})=>({id,title:id,status,deadline:null,updatedAt:1,...extra});

test('status counts sum every bucket and treat unknown statuses as todo',()=>{
 const counts=overview.statusCounts([item('a','todo'),item('b','doing'),item('c','done'),item('d','cancelled'),item('e','weird')]);
 assert.deepEqual({...counts},{todo:2,doing:1,done:1,cancelled:1,total:5,open:3});
 assert.deepEqual({...overview.statusCounts([])},{todo:0,doing:0,done:0,cancelled:0,total:0,open:0});
});

test('completion rate excludes cancelled items from the denominator',()=>{
 assert.equal(overview.completionRate(overview.statusCounts([item('a','done'),item('b','todo')])),50);
 // 取消掉一条待办后剩下的都完成了 → 100%，而不是 50%
 assert.equal(overview.completionRate(overview.statusCounts([item('a','done'),item('b','cancelled')])),100);
 assert.equal(overview.completionRate(overview.statusCounts([])),0);
 assert.equal(overview.completionRate(overview.statusCounts([item('a','cancelled')])),0);
});

test('attention splits overdue/today/soon, skips closed and undated, sorts by date',()=>{
 const items=[
  item('later','todo',{deadline:'2026-10-20'}),
  item('outOfWindow','todo',{deadline:'2026-10-25'}),
  item('soon','doing',{deadline:'2026-10-17'}),
  item('today','todo',{deadline:'2026-10-15'}),
  item('past','doing',{deadline:'2026-10-01'}),
  item('past2','todo',{deadline:'2026-10-09'}),
  item('donePast','done',{deadline:'2026-10-01'}),
  item('cancelledPast','cancelled',{deadline:'2026-10-01'}),
  item('undated','todo',{deadline:null}),
 ];
 const buckets=overview.needsAttention(items,'2026-10-15');
 assert.deepEqual(buckets.overdue.map(i=>i.id),['past','past2']);
 assert.deepEqual(buckets.today.map(i=>i.id),['today']);
 assert.deepEqual(buckets.soon.map(i=>i.id),['soon','later']); // 10-17、10-20 在 7 天窗口内
 assert.deepEqual(buckets.overdue.map(i=>i.id).concat(buckets.soon.map(i=>i.id)).includes('outOfWindow'),false);
});

test('progress rows group by key and put the most unfinished first',()=>{
 const items=[
  item('a','todo',{projectId:'p1'}),item('b','doing',{projectId:'p1'}),item('c','done',{projectId:'p1'}),
  item('d','todo',{projectId:'p2'}),
  item('e','cancelled',{projectId:'none'}),
 ];
 const rows=overview.groupProgress(items,value=>value.projectId);
 assert.deepEqual(rows.map(r=>r.key),['p1','p2','none']);
 assert.deepEqual(rows.map(r=>r.counts.open),[2,1,0]);
 assert.equal(rows[0].items.length,3);
 assert.deepEqual(overview.groupProgress([],value=>value.projectId),[]);
});

test('recently updated keeps the newest few in order',()=>{
 const items=[item('a','todo',{updatedAt:10}),item('b','todo',{updatedAt:30}),item('c','todo',{updatedAt:20})];
 assert.deepEqual(overview.recentlyUpdated(items,2).map(i=>i.id),['b','c']);
 assert.deepEqual(overview.recentlyUpdated(items,0),[]);
});
