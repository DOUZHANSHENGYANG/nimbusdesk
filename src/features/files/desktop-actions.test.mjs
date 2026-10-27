import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
const native=createRequire(import.meta.url);
function load(file,deps={},globals={}){if(!existsSync(new URL(file,import.meta.url)))return{};const module={exports:{}};const code=ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',...Object.keys(globals),code)(name=>deps[name]??native(name),module,module.exports,...Object.values(globals));return module.exports;}
function fixture(){
 const {useFiles,useFences,DEFAULT_FENCE}=load('../../stores/files.ts',{'@/lib/storage':{tauriJsonStorage:{getItem:()=>null,setItem:()=>{}}},'./files-storage': { filesTableStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }, '@/features/desktop/sticky-presentation':load('../desktop/sticky-presentation.ts'),'@/features/files/directory-mapping-core':load('./directory-mapping-core.ts')});
 const {queueWindowOperation}=load('../desktop/edge-core.ts');
 useFiles.setState({categories:[{id:'a',name:'A',createdAt:1},{id:'b',name:'B',parentId:'a',createdAt:1}],items:[]});
 useFences.setState({fences:{a:{...DEFAULT_FENCE,open:true,x:211,w:333,pinned:true,form:'capsule',edge:'right',edgeMonitor:'primary'}}});
 const windows=new Map(),trace=[],waiters=new Map();let failOpen='',failClose='',busyClose='',failFlush=false,openGate,listGate;
 const window=id=>({label:id,hide:async()=>trace.push(['hide',id]),once:async(event,cb)=>{waiters.set(id,cb);return()=>waiters.delete(id);}});
 windows.set('fence-a',window('fence-a'));windows.set('desktop-dock',window('desktop-dock'));
 const groups={group:{monitorId:'primary',edge:'right',collapsed:true,order:[],offset:48}};
 const deps={
  '@/stores/files':{useFiles,useFences,DEFAULT_FENCE},
  '@/lib/tauri':{inTauri:true,openFence:async(id)=>{trace.push(['open',id,useFences.getState().fences[id]?.open]);if(id===failOpen)throw Error('OPEN_FAILED');await openGate;windows.set('fence-'+id,window('fence-'+id));},closeFence:async(id)=>{trace.push(['close',id]);if(id===failClose)throw Error('CLOSE_FAILED');if(id===busyClose)return;windows.delete('fence-'+id);waiters.get('fence-'+id)?.();}},
  '@/lib/storage':{flushAllStorage:async()=>{trace.push(['flush']);if(failFlush)throw Error('SAVE_FAILED');}},
  '@tauri-apps/api/webviewWindow':{getAllWebviewWindows:async()=>{const gate=listGate;listGate=null;await gate;return [...windows.values()];}},
  '@tauri-apps/api/event':{emitTo:async(id,event,payload)=>trace.push(['emit',id,payload.action])},
  '@/features/desktop/edge-core':{queueWindowOperation},
  '@/features/desktop/edge-workspace':{useEdgeWorkspace:{getState:()=>({groups,setCollapsed:(key,value)=>{groups[key].collapsed=value;trace.push(['unfold',key]);}})}},
 };
 const api=load('./desktop-actions.ts',deps,{setTimeout:(fn)=>setTimeout(fn,8),clearTimeout});
 const registry=load('../desktop/registry.ts',{...deps,'./edge-core':{queueWindowOperation}});
 return{...api,...registry,useFiles,useFences,windows,trace,groups,setFailure:(kind,id)=>{if(kind==='open')failOpen=id;if(kind==='close')failClose=id;if(kind==='busy')busyClose=id;if(kind==='flush')failFlush=true;},gate:promise=>{openGate=promise;},pauseListing:promise=>{listGate=promise;}};
}
test('show all enables every category including children, keeps saved geometry and unfolds affected queues',async()=>{
 const h=fixture();assert.equal(typeof h.setAllFencesOnDesktop,'function');const result=await h.setAllFencesOnDesktop(true);
 assert.equal(result.done,2);assert.deepEqual(result.failed,[]);
 assert.ok(Object.values(h.useFences.getState().fences).every(f=>f.open));assert.equal(h.useFences.getState().fences.a.x,211);assert.equal(h.useFences.getState().fences.a.w,333);
 assert.ok(h.trace.filter(c=>c[0]==='open').every(c=>c[2]===true));assert.equal(h.groups.group.collapsed,false);
 assert.ok(h.trace.some(c=>c[0]==='emit'&&c[1]==='fence-a'&&c[2]==='show'));
});
test('disable all confirms native destruction and leaves unrelated windows untouched',async()=>{
 const h=fixture();assert.equal(typeof h.setAllFencesOnDesktop,'function');await h.setAllFencesOnDesktop(false);
 assert.equal(h.windows.has('fence-a'),false);assert.equal(h.windows.has('desktop-dock'),true);
 assert.equal(h.useFences.getState().fences.a.open,false);assert.equal(h.useFences.getState().fences.b?.open??false,false);
});
test('partial open failure reports only the failed category and rolls back its enabled flag',async()=>{
 const h=fixture();assert.equal(typeof h.setAllFencesOnDesktop,'function');h.setFailure('open','b');const result=await h.setAllFencesOnDesktop(true);
 assert.equal(result.done,1);assert.equal(result.failed.length,1);assert.equal(result.failed[0].id,'b');assert.match(String(result.failed[0].error),/OPEN_FAILED/);
 assert.equal(h.useFences.getState().fences.a.open,true);assert.equal(h.useFences.getState().fences.b.open,false);
});
test('a rejected busy close must not claim success or persist a disabled live fence',async()=>{
 const h=fixture();assert.equal(typeof h.setFenceOnDesktop,'function');h.setFailure('busy','a');await assert.rejects(h.setFenceOnDesktop('a',false));
 assert.equal(h.windows.has('fence-a'),true);assert.equal(h.useFences.getState().fences.a.open,true);
});
test('persist failure prevents constructing a new window and restores the prior enabled value',async()=>{
 const h=fixture();assert.equal(typeof h.setFenceOnDesktop,'function');h.setFailure('flush');await assert.rejects(h.setFenceOnDesktop('b',true),/SAVE_FAILED/);
 assert.equal(h.trace.some(c=>c[0]==='open'),false);assert.equal(h.useFences.getState().fences.b.open,false);
});
test('rapid show then disable is serialized and the last action wins',async()=>{
 const h=fixture();assert.equal(typeof h.setFenceOnDesktop,'function');let release;h.gate(new Promise(r=>{release=r;}));
 const show=h.setFenceOnDesktop('b',true),hide=h.setFenceOnDesktop('b',false);await new Promise(r=>setImmediate(r));assert.equal(h.trace.some(c=>c[0]==='close'),false);
 release();await show;await hide;assert.equal(h.useFences.getState().fences.b.open,false);assert.equal(h.windows.has('fence-b'),false);
});
test('queued startup restoration does not re-enable a category disabled by the user',async()=>{
 const h=fixture();assert.equal(typeof h.restoreFenceOnDesktop,'function');h.useFences.getState().setOpen('a',false);await h.restoreFenceOnDesktop('a');assert.equal(h.trace.some(c=>c[0]==='open'),false);
});

test('tray restoration and persistent disabling share one lifecycle queue, so no disabled window is recreated',async()=>{
 const h=fixture();h.windows.delete('fence-a');let release;
 h.pauseListing(new Promise(resolve=>{release=resolve;}));
 const restore=h.desktopAction('fence-a','restore');await new Promise(resolve=>setImmediate(resolve));
 const disable=h.setFenceOnDesktop('a',false);await new Promise(resolve=>setImmediate(resolve));
 release();await Promise.all([restore,disable]);
 assert.equal(h.useFences.getState().fences.a.open,false);assert.equal(h.windows.has('fence-a'),false);
});

test('tray recovery cannot recreate a fence whose category has been removed',async()=>{
 const h=fixture();h.windows.delete('fence-a');h.useFiles.setState({categories:[]});
 await h.desktopAction('fence-a','restore');
 assert.equal(h.windows.has('fence-a'),false);assert.equal(h.trace.some(call=>call[0]==='open'),false);
});
