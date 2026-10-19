import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
const native=createRequire(import.meta.url);
function load(file,deps={}){const module={exports:{}};const code=ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(name=>deps[name]??native(name),module,module.exports);return module.exports;}
const core=load('./queue-core.ts');
const area={id:'primary',x:0,y:0,w:1280,h:800,scale:1};
function harness(){
 const {useEdgeWorkspace:store}=load('./edge-workspace.ts',{'@/lib/storage':{onStorageSynced:()=>{},tauriJsonStorage:{getItem:()=>null,setItem:()=>{}}}});
 const entries=['a','b','c'].map(id=>({id,form:'capsule',edge:'right',edgeMonitor:'primary'}));
 const api=load('./queue-registry.ts',{'./edge-core':{},'./queue-core':core,'./edge-workspace':{useEdgeWorkspace:store},'./registry':{desktopEntries:()=>entries,saveDockPosition:(id,patch)=>Object.assign(entries.find(entry=>entry.id===id),patch)}});
 return{store,entries,...api};
}
test('moving the first implicit member down materializes the whole derived queue',()=>{const h=harness();h.reserveQueue('a',area,'right');h.moveDockItem('a',area,'right',undefined,1);assert.deepEqual(h.queueSnapshot('a',area,'right').layout.order,['b','a','c']);});
test('moving a middle implicit member down preserves all other members in order',()=>{const h=harness();h.reserveQueue('b',area,'right');h.moveDockItem('b',area,'right',undefined,2);assert.deepEqual(h.queueSnapshot('b',area,'right').layout.order,['a','c','b']);});
test('dragging to a new queue inserts after its implicit members rather than jumping to the top',()=>{const h=harness();h.entries[2].edge='left';h.reserveQueue('a',area,'right');h.moveDockItem('c',area,'right',700);assert.deepEqual(h.queueSnapshot('c',area,'right').layout.order,['a','b','c']);});
test('moving a whole implicit queue preserves its visible order independent of creation order',()=>{const h=harness();h.entries.reverse();h.reserveQueue('a',area,'right');const key=core.groupKey(area.id,'right');h.moveDockGroup(key,area,'left',80);assert.deepEqual(h.queueSnapshot('a',area,'left').layout.order,['a','b','c']);});

test('a locked member blocks its own drag and group relocation while an unlocked neighbor may move independently',()=>{
 const h=harness();h.entries[1].locked=true;h.reserveQueue('a',area,'right');
 const before=JSON.stringify(h.store.getState().groups),positions=JSON.stringify(h.entries);
 assert.equal(h.moveDockItem('b',area,'left',200),false);
 assert.equal(h.moveDockGroup(core.groupKey(area.id,'right'),area,'left',80),false);
 assert.equal(JSON.stringify(h.store.getState().groups),before);assert.equal(JSON.stringify(h.entries),positions);
 const lockedBefore=h.queueSnapshot('b',area,'right').slot.y;
 assert.equal(h.moveDockItem('a',area,'right',400),true);
 assert.equal(h.queueSnapshot('b',area,'right').slot.y,lockedBefore,'locked neighbor retains its exact visible anchor');
 assert.equal(h.queueSnapshot('a',area,'right').slot.y,400);
});

test('dropping one sticky at a free height persists that anchor rather than returning to the queue start',()=>{
 const h=harness();h.reserveQueue('a',area,'right');
 assert.equal(h.moveDockItem('a',area,'right',440),true);
 assert.equal(h.entries[0].dockOffset,440);
 assert.equal(h.queueSnapshot('a',area,'right').slot.y,440);
 assert.notEqual(h.queueSnapshot('b',area,'right').slot.y,440);
});

test('moving a folded group retains independently positioned members and its folded preference',()=>{
 const h=harness();h.entries[0].dockOffset=440;h.reserveQueue('a',area,'right');
 const key=core.groupKey(area.id,'right');h.store.getState().setCollapsed(key,true);
 assert.equal(h.moveDockGroup(key,area,'left',100),true);
 assert.equal(h.entries[0].dockOffset,492);
 assert.equal(h.queueSnapshot('a',area,'left').group.collapsed,true);
});
