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
const core=load(),{emptyProjectData}=load('./types');
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
test('validation rejects duplicate current iterations and malformed metadata before saving',()=>{
 const d=emptyProjectData();d.iterations=['a','b'].map(id=>({id,name:id,start:'2026-10-01',end:'2026-10-20',createdAt:1,updatedAt:1}));d.items=[item('i',{activeIterationId:'a'})];d.memberships=['a','b'].map(id=>({id,itemId:'i',iterationId:id,joinedAt:1,leftAt:null,carriedFrom:null,updatedAt:1}));
 assert.throws(()=>core.validateProjectData(d),/current iteration/);d.memberships.pop();core.validateProjectData(d);
 d.items[0].updatedAt=-1;assert.throws(()=>core.validateProjectData(d),/timestamp/);
});
test('active tab keeps project-only panels honest',()=>{
 // 图表与文件挂在项目上：没选项目时退回任务列表，而不是渲染一个空面板
 assert.equal(core.resolveActiveTab('charts',false),'tasks');
 assert.equal(core.resolveActiveTab('files',false),'tasks');
 assert.equal(core.resolveActiveTab('charts',true),'charts');
 assert.equal(core.resolveActiveTab('files',true),'files');
 assert.equal(core.resolveActiveTab('overview',false),'overview');
 assert.equal(core.resolveActiveTab('board',false),'board');
 assert.equal(core.resolveActiveTab('tasks',false),'tasks');
});
test('sub-plans: weighted progress, manual percent and cancelled children excluded',()=>{
 const root=item('root',{status:'todo',weight:3,projectId:'p'}),a=item('a',{parentId:'root',status:'done',weight:2,projectId:'p'}),b=item('b',{parentId:'root',status:'todo',weight:1,percent:50,projectId:'p'}),c=item('c',{parentId:'root',status:'cancelled',weight:5,projectId:'p'});
 assert.equal(core.planPercent([root,a,b,c],'root'),83);assert.equal(core.planPercent([root,a,b,c],'a'),100);assert.equal(core.planPercent([root,a,b,c],'b'),50);
 assert.equal(core.itemPercent({status:'done'}),100);assert.equal(core.itemPercent({status:'doing',percent:40}),40);assert.equal(core.itemPercent({status:'todo'}),0);
 const grand=item('g',{parentId:'a',status:'done',projectId:'p'}),half=item('h',{parentId:'g',status:'todo',percent:50,projectId:'p'});
 assert.equal(core.planPercent([grand,half],'g'),50);
 // 父计划只看子计划，自己的 status 不再参与：done 也不会把它抬到 100
 assert.equal(core.planPercent([grand,{...half,percent:0}],'g'),0);
 // 默认权重、无人工完成度时与旧的 done/total 完全一致（老的算法没有迁移成本）
 const legacy=[item('x',{status:'done',projectId:'p'}),item('y',{status:'todo',projectId:'p'}),item('z',{status:'cancelled',projectId:'p'})];
 assert.deepEqual(core.projectProgress({id:'p'},legacy,'2026-01-01'),{value:50,source:'items'});
 // 项目按顶层计划加权：×3 的那条算 83，另一条完成的 ×1 算 100 → (249+100)/4
 assert.equal(core.projectProgress({id:'p'},[root,a,b,c],'2026-01-01').value,83);
 assert.equal(core.projectProgress({id:'p'},[...[root,a,b,c],item('r2',{status:'done',projectId:'p'})],'2026-01-01').value,87);
 assert.equal(core.projectProgress({id:'p',progressManual:120},[],'2026-01-01').value,100);
});
test('sub-plan validation rejects self, cross-project and cyclic parents plus bad tags',()=>{
 const base=()=>{const d=emptyProjectData();d.projects=['p','q'].map(id=>({id,name:id,areaId:null,note:'',status:'active',folder:null,createdAt:1,updatedAt:1}));return d;};
 const ok=base();ok.items=[item('a',{projectId:'p',weight:2,percent:40,startDate:'2026-01-01',endDate:'2026-02-01'}),item('b',{projectId:'p',parentId:'a'})];core.validateProjectData(ok);
 const self=base();self.items=[item('a',{projectId:'p',parentId:'a'})];assert.throws(()=>core.validateProjectData(self),/own parent/);
 const cross=base();cross.items=[item('a',{projectId:'p'}),item('b',{projectId:'q',parentId:'a'})];assert.throws(()=>core.validateProjectData(cross),/share the project/);
 const cycle=base();cycle.items=[item('a',{projectId:'p',parentId:'b'}),item('b',{projectId:'p',parentId:'a'})];assert.throws(()=>core.validateProjectData(cycle),/cycle/);
 const bad=base();bad.items=[item('a',{percent:101})];assert.throws(()=>core.validateProjectData(bad),/percent/);
 const weight=base();weight.items=[item('a',{weight:0})];assert.throws(()=>core.validateProjectData(weight),/weight/);
 const tags=base();tags.projects[0].tags=['x','x'];assert.throws(()=>core.validateProjectData(tags),/tags/);
 const good=base();good.projects[0].tags=['桌面','Tauri'];core.validateProjectData(good);
});

test('orderedProjects keeps pinned first and preserves array order inside each group',()=>{
 const list=[{id:'a'},{id:'b',pinned:true},{id:'c'},{id:'d',pinned:true}];
 assert.deepEqual(core.orderedProjects(list).map(p=>p.id),['b','d','a','c']);
 // 不就地改原数组（侧栏每帧都调它）
 assert.deepEqual(list.map(p=>p.id),['a','b','c','d']);
 assert.deepEqual(core.orderedProjects([]).map(p=>p.id),[]);
});
