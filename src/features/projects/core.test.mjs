import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const nativeRequire=createRequire(import.meta.url),cache=new Map();
export function load(name='./core') {
 if(cache.has(name)) return cache.get(name).exports;
 const code=ts.transpileModule(readFileSync(new URL(`${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const m={exports:{}};cache.set(name,m);new Function('require','module','exports',code)(s=>s.startsWith('.')?load(s):nativeRequire(s),m,m.exports);return m.exports;
}
const core=load(),{emptyProjectData,DEFAULT_REMINDER_RULE}=load('./types');
const item=(id='i',extra={})=>({id,title:id,note:'',status:'todo',areaId:null,projectId:null,activeIterationId:null,deadline:null,createdAt:1,updatedAt:1,...extra});
test('two/three week defaults use Monday to final Friday and custom leap dates validate',()=>{
 assert.deepEqual(core.iterationRange('2026-10-18',2),{start:'2026-10-12',end:'2026-10-23'});
 assert.deepEqual(core.iterationRange('2026-10-19',3),{start:'2026-10-19',end:'2026-11-06'});
 assert.equal(core.validDate('2024-02-29'),true);assert.equal(core.validDate('2025-02-29'),false);
 assert.throws(()=>core.iterationRange('bad',2));
});
test('carryover keeps identity, snapshots old iteration and deduplicates memberships',()=>{
 const d=emptyProjectData();d.iterations=[{id:'old',start:'2026-10-01',end:'2026-10-14'},{id:'next',start:'2026-10-15',end:'2026-10-28'}];d.items=[item('i',{activeIterationId:'old'})];d.memberships=[{id:'m',itemId:'i',iterationId:'old',joinedAt:1,leftAt:null,carriedFrom:null,updatedAt:1}];
 const n=core.carryItem(d,'i','next',50);assert.equal(n.items[0].id,'i');assert.equal(n.items[0].activeIterationId,'next');assert.equal(n.memberships[0].snapshot.title,'i');assert.equal(n.memberships[0].leftAt,50);
 assert.equal(core.carryItem(n,'i','next',60).memberships.length,2);assert.throws(()=>core.carryItem(n,'i','missing',70));
 const backlog=core.carryItem(n,'i',null,70);assert.equal(backlog.items[0].activeIterationId,null);
});
test('plan bindings inherit through ancestors, support override/unbound and stop cycles',()=>{
 const tasks=[{id:'p',parentId:null,workItemId:'i'},{id:'c',parentId:'p'},{id:'u',parentId:'p',workItemId:null},{id:'o',parentId:'p',workItemId:'other'}];
 assert.equal(core.resolvePlanWorkItem(tasks,'c'),'i');assert.equal(core.resolvePlanWorkItem(tasks,'u'),null);assert.equal(core.resolvePlanWorkItem(tasks,'o'),'other');
 assert.equal(core.resolvePlanWorkItem([{id:'a',parentId:'b'},{id:'b',parentId:'a'}],'a'),null);
});
test('reminders use explicit active iteration, coalesce missed slots, dedupe successful delivery',()=>{
 const d=emptyProjectData();d.items=[item('i',{activeIterationId:'old'})];d.iterations=[{id:'old',end:'2026-10-18'},{id:'new',end:'2026-10-20'}];
 let due=core.dueProjectReminders(d,new Date('2026-10-18T09:00:00+08:00'));assert.equal(due.length,1);assert.deepEqual(due[0].slots,['09:00']);
 due=core.dueProjectReminders(d,new Date('2026-10-18T17:00:00+08:00'));assert.deepEqual(due[0].slots,['09:00','16:50']);
 d.deliveries=[{...due[0],notifiedAt:1}];assert.deepEqual(core.dueProjectReminders(d,new Date('2026-10-18T18:00:00+08:00')),[]);
 assert.deepEqual(core.dueProjectReminders(d,new Date('2026-10-19T09:00:00+08:00')),[]);
 d.items[0].status='done';assert.deepEqual(core.dueProjectReminders(d,new Date('2026-10-18T09:00:00+08:00')),[]);
});
test('weekday fallback and per-item disabled override work across date/timezone boundaries',()=>{
 const d=emptyProjectData();d.items=[item('i',{deadline:'2026-10-18'})];d.reminderRule={...DEFAULT_REMINDER_RULE,weekdays:[1,2,3,4,5],nonWorkingDay:'previous'};
 assert.equal(core.dueProjectReminders(d,new Date('2026-10-16T09:00:00+08:00')).length,1);
 d.items[0].reminder={...d.reminderRule,enabled:false};assert.equal(core.dueProjectReminders(d,new Date('2026-10-16T09:00:00+08:00')).length,0);
 assert.throws(()=>core.validateReminderRule({...DEFAULT_REMINDER_RULE,times:['99:00']}));assert.throws(()=>core.validateReminderRule({...DEFAULT_REMINDER_RULE,timezone:'invalid'}));
});
test('validation rejects duplicate current iterations, dangling deliveries and malformed metadata before saving',()=>{
 const d=emptyProjectData();d.iterations=['a','b'].map(id=>({id,name:id,start:'2026-10-01',end:'2026-10-20',createdAt:1,updatedAt:1}));d.items=[item('i',{activeIterationId:'a'})];d.memberships=['a','b'].map(id=>({id,itemId:'i',iterationId:id,joinedAt:1,leftAt:null,carriedFrom:null,updatedAt:1}));
 assert.throws(()=>core.validateProjectData(d),/current iteration/);d.memberships.pop();core.validateProjectData(d);
 d.deliveries=[{id:'x',itemId:'missing',date:'invalid',slots:['99:00'],notifiedAt:-1}];assert.throws(()=>core.validateProjectData(d),/delivery/);d.deliveries=[];d.items[0].updatedAt=-1;assert.throws(()=>core.validateProjectData(d),/timestamp/);
});
