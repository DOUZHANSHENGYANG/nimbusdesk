import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const load=async()=>import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(await readFile(new URL('./edge-core.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64'));
const area={x:-1920,y:0,w:1920,h:1080,scale:1.5};
test('new papers and fences receive distinct persistent slots, including undefined prior positions',async()=>{
 const {allocateEdgeY}=await load();const slots=[{id:'todo-a'},{id:'todo-b'},{id:'fence-a'}];
 assert.equal(new Set(slots.map(slot=>allocateEdgeY(slot.id,slots))).size,3);
 assert.notEqual(allocateEdgeY('todo-c',[{id:'fence-a',y:48}]),48);
});
test('switching sides avoids occupied target slots and preserves a free preferred position',async()=>{
 const {allocateEdgeY}=await load();const target=[{id:'todo-a',y:48},{id:'fence-a',y:116}];
 assert.equal(allocateEdgeY('todo-b',target,48),192);
 assert.equal(allocateEdgeY('todo-b',target,252),252);
});
test('real tab and open card stay within either edge of negative-origin scaled monitors',async()=>{
 const {edgeBounds}=await load();
 for(const edge of ['left','right'])for(const opened of [false,true]){
  const b=edgeBounds(area,edge,9999,opened,{x:100,y:100,w:300,h:400});
  assert.ok(b.x>=area.x&&b.x+b.w<=0);assert.ok(b.y>=area.y&&b.y+b.h<=1080);
  if(!opened)assert.deepEqual({w:b.w,h:b.h},{w:168,h:66});
 }
});

test('sticky arrows expose a wide horizontal target and preserve their on-screen anchor when bottom previews clamp upward',async()=>{
 const {edgeBounds,edgeTabOffset,EDGE_TAB_W,EDGE_TAB_H}=await load();
 assert.equal(EDGE_TAB_W,112);assert.equal(EDGE_TAB_H,44);assert.equal(typeof edgeTabOffset,'function');
 for(const scale of [1,1.25,1.5])for(const edge of ['left','right']){
  const monitor={x:-1920,y:-100,w:1920,h:1080,scale};const normal={x:20,y:30,w:320,h:400};
  const y=monitor.h/scale-50;
  const closed=edgeBounds(monitor,edge,y,false,normal,44),opened=edgeBounds(monitor,edge,y,true,normal,44);
  const offset=edgeTabOffset(monitor,y,normal,44);
  assert.ok(offset>0);assert.equal(Math.round(opened.y+offset*scale),closed.y);
  assert.ok(opened.x>=monitor.x&&opened.x+opened.w<=monitor.x+monitor.w);
 }
});
test('one queue serializes across controller lifetimes and recovers after rejected writes',async()=>{
 const {queueWindowOperation}=await load();const trace=[];let release;
 const first=queueWindowOperation('owned',async()=>{trace.push(1);await new Promise(r=>release=r);trace.push(2);throw Error('owned failure');});
 const rejected=assert.rejects(first,/owned failure/);const second=queueWindowOperation('owned',async()=>trace.push(3));
 await new Promise(r=>setTimeout(r,0));assert.deepEqual(trace,[1]);release();await rejected;await second;assert.deepEqual(trace,[1,2,3]);
});
test('latest intent cancels remaining native writes and restore leaves normal geometry unchanged',async()=>{
 const {EdgeController}=await load();const normal={x:-900,y:100,w:300,h:400},calls=[];let release;
 const port={label:'owned2',monitor:async()=>area,ignore:async v=>calls.push(['ignore',v]),size:async b=>{calls.push(['size',b]);if(release===undefined)await new Promise(r=>release=r);},position:async b=>calls.push(['position',b]),layer:async()=>{},show:async()=>{}};
 const c=new EdgeController(port,()=>normal);const init=c.place(false,'right',100);await new Promise(r=>setTimeout(r,0));
 const restore=c.restore(false);release();await init;await restore;
 assert.equal(calls.filter(x=>x[0]==='position').length,1);assert.equal(calls.at(-1)[1].x,normal.x*area.scale);assert.deepEqual(normal,{x:-900,y:100,w:300,h:400});
});
test('disposed controllers cannot position a newer native window',async()=>{
 const {EdgeController}=await load();const calls=[];let release;
 const c=new EdgeController({label:'owned3',monitor:()=>new Promise(r=>release=r),ignore:async()=>calls.push('ignore'),size:async()=>calls.push('size'),position:async()=>calls.push('position'),layer:async()=>{},show:async()=>{}},()=>({x:10,y:10,w:300,h:400}));
 const pending=c.place(false,'left',50);await new Promise(r=>setTimeout(r,0));c.dispose();release(area);await pending;assert.deepEqual(calls,[]);
});
test('monitor work area changes are refreshed before each placement, including DPI changes',async()=>{
 const {EdgeController}=await load();let monitor={x:0,y:0,w:1920,h:1080,scale:1},last;
 const c=new EdgeController({label:'changing-monitor',monitor:async()=>monitor,ignore:async()=>{},size:async()=>{},position:async b=>{last=b;},layer:async()=>{},show:async()=>{}},()=>({x:200,y:100,w:300,h:400}));
 await c.place(false,'right',50);assert.equal(last.x,1808);
 monitor={x:-2560,y:0,w:2560,h:1440,scale:1.5};await c.place(false,'left',50);
 assert.equal(last.x,-2560);assert.equal(last.y,75);assert.equal(last.w,168);
});
