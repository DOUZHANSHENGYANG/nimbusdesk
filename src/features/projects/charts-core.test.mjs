import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const nativeRequire=createRequire(import.meta.url),cache=new Map();
function load(name='./charts-core') {
  if(cache.has(name)) return cache.get(name).exports;
  const code=ts.transpileModule(readFileSync(new URL(`${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const m={exports:{}};cache.set(name,m);new Function('require','module','exports',code)(s=>s.startsWith('.')?load(s):nativeRequire(s),m,m.exports);return m.exports;
}
const item=(id,extra={})=>({id,title:id,note:'',status:'todo',areaId:null,projectId:'p',activeIterationId:null,deadline:null,createdAt:1,updatedAt:1,...extra});
const snap=(date,extra={})=>({date,projectId:'p',todo:0,doing:0,done:0,cancelled:0,points:0,donePoints:0,...extra});

test('snapshot counts points by weight and keeps cancelled out of the denominator',()=>{
 const {snapshotOf}=load();
 const items=[item('a',{status:'done',weight:3}),item('b',{status:'doing',weight:1,percent:50}),item('c',{status:'cancelled',weight:9}),item('other',{projectId:'q',status:'done'})];
 const s=snapshotOf('p',items,'2026-10-31');
 assert.equal(s.done,1);assert.equal(s.doing,1);assert.equal(s.cancelled,1);assert.equal(s.todo,0);
 assert.equal(s.points,4);assert.equal(s.donePoints,3.5);
});
test('upsert keeps one row per day and drops snapshots older than a year',()=>{
 const {upsertSnapshot}=load();
 const base=[snap('2025-01-01',{points:9}),snap('2026-10-30',{done:1})];
 const after=upsertSnapshot(base,snap('2026-10-30',{done:2}));
 assert.equal(after.filter(s=>s.date==='2026-10-30').length,1);
 assert.equal(after.find(s=>s.date==='2026-10-30').done,2);
 assert.equal(after.some(s=>s.date==='2025-01-01'),false,'older than 365 days is pruned');
 assert.deepEqual(after.map(s=>s.date),[...after.map(s=>s.date)].sort());
});
test('burndown carries the last known value forward and draws an ideal line to zero',()=>{
 const {burndown}=load();
 const list=[snap('2026-10-01',{points:10,donePoints:0}),snap('2026-10-03',{points:10,donePoints:5})];
 const points=burndown(list,'p','2026-10-01','2026-10-04');
 assert.equal(points.length,4);
 assert.equal(points[0].remaining,10);
 assert.equal(points[1].remaining,10,'a missing day is carried forward, not zero');
 assert.equal(points[2].remaining,5);
 assert.equal(points.at(-1).ideal,0);
 assert.equal(burndown([],'p','2026-10-01','2026-10-04').length,0,'no history means no chart');
});
test('cfd skips days without any snapshot instead of inventing zeros',()=>{
 const {cfd}=load();
 const flow=cfd([snap('2026-10-01',{todo:2}),snap('2026-10-04',{done:2})],'p','2026-10-01','2026-10-03');
 assert.deepEqual(flow.map(point=>point.date),['2026-10-01','2026-10-02','2026-10-03']);
 assert.equal(flow[1].todo,2,'keeps carrying the last bucket');
});
test('velocity sums the delta inside each iteration and ignores future ones',()=>{
 const {velocity}=load();
 const iterations=[{id:'a',name:'A',start:'2026-10-01',end:'2026-10-14',createdAt:1,updatedAt:1},{id:'b',name:'B',start:'2026-10-15',end:'2026-10-28',createdAt:1,updatedAt:1},{id:'c',name:'C',start:'2027-01-01',end:'2027-01-14',createdAt:1,updatedAt:1}];
 const list=[snap('2026-09-30',{points:20,donePoints:4}),snap('2026-10-14',{points:20,donePoints:9}),snap('2026-10-28',{points:20,donePoints:15})];
 const bars=velocity(list,'p',iterations);
 assert.deepEqual(bars.map(bar=>[bar.name,bar.donePoints]),[['A',5],['B',6]]);
});
test('gantt only draws plans that have a usable range',()=>{
 const {ganttRows}=load();
 const iterations=[{id:'it',name:'IT',start:'2026-10-01',end:'2026-10-14',createdAt:1,updatedAt:1}];
 const items=[item('a',{status:'doing',activeIterationId:'it'}),item('b',{parentId:'a',startDate:'2026-10-02',endDate:'2026-10-05',percent:100,status:'done'}),item('c',{status:'done'}),item('d',{status:'cancelled',startDate:'2026-10-01',endDate:'2026-10-02'})];
 const rows=ganttRows(items,iterations,'2026-10-10');
 assert.deepEqual(rows.map(row=>row.id),['a','b'],'no range and cancelled plans are skipped');
 const a=rows[0],b=rows[1];
 assert.deepEqual([a.start,a.end,a.depth,a.tone],['2026-10-01','2026-10-14',0,'doing']);
 assert.deepEqual([b.start,b.end,b.depth,b.tone],['2026-10-02','2026-10-05',1,'done']);
});
