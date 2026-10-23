import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {create} from 'zustand';
import {persist,createJSONStorage} from 'zustand/middleware';
async function load(path,deps={}){const key='__fenceEdgeTest';const code=ts.transpileModule(await readFile(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import[\s\S]*?;\s*/gm,'');globalThis[key]=deps;try{return await import(`data:text/javascript;base64,${Buffer.from(`const {${Object.keys(deps).join(',')}}=globalThis.${key};\n${code}`).toString('base64')}`);}finally{delete globalThis[key];}}
test('docking and restoring fences preserves normal geometry and prior settings',async()=>{
 const {useFences}=await load('../../stores/files.ts',{create,persist,createJSONStorage,tauriJsonStorage:{getItem:()=>null,setItem:()=>{}},filesTableStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}});
 const store=useFences.getState();store.setGeometry('a',{x:-800,y:50,w:320,h:400});store.setPinned('a',true);store.setEdge('a','left');store.setEdgeY('a',240);store.setForm('a','capsule');
 assert.deepEqual(useFences.getState().fences.a,{x:-800,y:50,w:320,h:400,ghost:true,open:false,viewMode:'icons',locked:false,pinned:true,edge:'left',edgeY:240,form:'capsule'});
 useFences.getState().setForm('a','paper');assert.equal(useFences.getState().fences.a.w,320);assert.equal(useFences.getState().fences.a.edgeY,240);
});
test('automatic edge docking requires a real drag and chooses the closest supported work-area edge',async()=>{
 const {dragDockEdge,logicalFenceGeometry}=await load('./fence-geometry.ts');
 const area={x:-1920,y:0,w:1920,h:1080};
 assert.equal(dragDockEdge({x:-1910,y:20,w:300,h:400},area,true),'left');
 assert.equal(dragDockEdge({x:-308,y:20,w:300,h:400},area,true),'right');
 assert.equal(dragDockEdge({x:-1910,y:20,w:300,h:400},area,false),null);
 assert.equal(dragDockEdge({x:-1100,y:0,w:300,h:400},area,true),'top');
 assert.equal(dragDockEdge({x:-1910,y:3,w:300,h:400},area,true),'top');
 assert.equal(dragDockEdge({x:-1918,y:3,w:300,h:400},area,true),'left');
 assert.equal(dragDockEdge({x:-1100,y:13,w:300,h:400},area,true),null);
 assert.equal(dragDockEdge({x:-1100,y:0,w:300,h:400},area,false),null);
 assert.equal(dragDockEdge({x:-1100,y:680,w:300,h:400},area,true),null);
 assert.equal(dragDockEdge({x:0,y:0,w:300,h:400},{x:0,y:0,w:300,h:1080},true),'left');
 assert.deepEqual(logicalFenceGeometry({x:-1200,y:150},{width:600,height:750},1.5),{x:-800,y:100,w:400,h:500});
});

test('menu lifecycle releases holds when ready fails, request rejects, action closes, and owner unmounts',async()=>{
 const cleanup=[];const changes=[];const timers=[];const revealChecks=[];let ready=false;let fail=false;let handler;let sized;
 const {usePopupMenu}=await load('./use-popup-menu.ts',{
   useRef:value=>({current:value}),useCallback:fn=>fn,useEffect:fn=>{cleanup.push(fn());},
   useTranslation:()=>({t:key=>key,i18n:{language:'zh'}}),
   useSettings:fn=>fn({theme:'dark',filesRoot:''}),useFiles:fn=>fn({categories:[],updateItem:()=>{}}),
   ensurePopupReady:async()=>{if(fail)throw new Error('init failed');return ready;},
   closeMenu:async()=>{},ownerLabel:()=> 'fence-a',beginMenu:()=>1,
   subscribeMenuSize:async(_seq,callback)=>{sized=callback;return()=>{};},emitMenuRequest:async()=>{},revealMenu:async(_anchor,_size,valid)=>{revealChecks.push(valid);},
   useMenuActions:fn=>{handler=fn;},
   setTimeout:callback=>{timers.push(callback);return timers.length;},clearTimeout:()=>{},
   window:{addEventListener:()=>{},removeEventListener:()=>{}},
 });
 const open=usePopupMenu({actions:{},onOpenChange:value=>changes.push(value)});
 await open({kind:'blank',categoryId:'a'},{x:0,y:0});assert.equal(changes.at(-1),false);
 fail=true;await assert.rejects(open({kind:'blank',categoryId:'a'},{x:0,y:0}),/init failed/);assert.equal(changes.at(-1),false);
 fail=false;ready=true;await open({kind:'blank',categoryId:'a'},{x:0,y:0});assert.equal(changes.at(-1),true);
 timers.at(-1)();assert.equal(changes.at(-1),false);
 await open({kind:'blank',categoryId:'a'},{x:0,y:0});const staleTimer=timers.at(-1);
 await open({kind:'blank',categoryId:'a'},{x:0,y:0});staleTimer();assert.equal(changes.at(-1),true);
 sized({w:200,h:150});assert.equal(revealChecks.at(-1)(),true);
 handler({action:'close'});assert.equal(changes.at(-1),false);assert.equal(revealChecks.at(-1)(),false);
 await open({kind:'blank',categoryId:'a'},{x:0,y:0});for(const stop of cleanup)stop?.();assert.equal(changes.at(-1),false);
});

test('a dismissed menu cannot reappear after its deferred owner-position lookup finishes',async()=>{
 let finishPosition;let valid=true;const shown=[];
 const position=new Promise(resolve=>{finishPosition=resolve;});
 const {revealMenu}=await load('./popup.ts',{
   getCurrentWebviewWindow:()=>({innerPosition:()=>position,scaleFactor:async()=>1.5}),
   showPopupMenu:async(...args)=>{shown.push(args);},
 });
 const reveal=revealMenu({x:10,y:20,w:0,h:0},{w:200,h:150},()=>valid);
 valid=false;finishPosition({x:150,y:300});await reveal;
 assert.deepEqual(shown,[]);
 valid=true;await revealMenu({x:10,y:20,w:0,h:0},{w:200,h:150},()=>valid);
 assert.deepEqual(shown,[[110,220,200,150]]);
});
