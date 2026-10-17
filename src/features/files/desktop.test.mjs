import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {create} from 'zustand';import {persist,createJSONStorage} from 'zustand/middleware';
let sequence=0;
async function load(path,deps={}){const key=`__desktopTest${++sequence}`;const code=ts.transpileModule(await readFile(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import[\s\S]*?;\s*/gm,'');globalThis[key]=deps;try{return await import(`data:text/javascript;base64,${Buffer.from(`const {${Object.keys(deps).join(',')}}=globalThis.${key};\n${code}`).toString('base64')}`);}finally{delete globalThis[key];}}
async function files(){return(await load('../../stores/files.ts',{create,persist,createJSONStorage,tauriJsonStorage:{getItem:()=>null,setItem:()=>{}}})).useFiles;}
const item=(id,path,categoryId='old')=>({id,path,categoryId,title:path.split('/').at(-1),type:'file',tags:['kept'],createdAt:1});

test('moving dropped entries updates existing references and descendants, adds the destination once',async()=>{
 const store=await files();store.setState({categories:[{id:'old',name:'Old',dir:'C:/Desktop/project'},{id:'target',name:'Target'}],items:[item('one','C:/Desktop/note.txt'),{...item('folder','C:/Desktop/project'),type:'folder'},item('nested','C:/Desktop/project/src/a.ts','other'),item('lookalike','C:/Desktop/project-old/a.ts','other')]});
 store.getState().applyMovedEntries('target',[{source:'C:/Desktop/note.txt',path:'E:/Files/note (2).txt',name:'note (2).txt',kind:'file'},{source:'C:/Desktop/project',path:'E:/Files/project',name:'project',kind:'folder'}]);
 assert.equal(store.getState().categories.find(category=>category.id==='old').dir,'E:/Files/project');
 const entries=store.getState().items;assert.equal(entries.find(x=>x.id==='one').path,'E:/Files/note (2).txt');assert.equal(entries.find(x=>x.id==='one').categoryId,'target');assert.deepEqual(entries.find(x=>x.id==='one').tags,['kept']);assert.equal(entries.find(x=>x.id==='nested').path,'E:/Files/project/src/a.ts');assert.equal(entries.find(x=>x.id==='lookalike').path,'C:/Desktop/project-old/a.ts');
 store.getState().applyMovedEntries('target',[{source:'E:/Files/note (2).txt',path:'E:/Files/note (2).txt',name:'note (2).txt',kind:'file'}]);assert.equal(store.getState().items.length,4);
});

test('newly moved paths are registered, Windows case is ignored, and retained originals keep their references',async()=>{
 const store=await files();store.setState({categories:[{id:'target',name:'Target'}],items:[item('original','C:/Desktop/locked.txt')]});
 store.getState().applyMovedEntries('target',[{source:'c:/desktop/locked.txt',path:'E:/Files/locked.txt',name:'locked.txt',kind:'file',sourceRetained:true}]);
 assert.equal(store.getState().items.find(x=>x.id==='original').path,'C:/Desktop/locked.txt');assert.equal(store.getState().items.filter(x=>x.categoryId==='target').length,1);
 store.getState().applyMovedEntries('target',[{source:'e:\\files\\LOCKED.txt',path:'E:/Files/locked.txt',name:'locked.txt',kind:'file'}]);assert.equal(store.getState().items.length,2);
});

test('desktop toggle hides visible fences and shows enabled ones without changing persistent open flags',async()=>{
 const state={fences:{a:{open:true,x:10,y:20,w:200,h:300},b:{open:false}}};const calls=[];let visible=true;
 const window={label:'fence-a',isVisible:async()=>visible,hide:async()=>{visible=false;calls.push('hide');}};
 const {toggleDesktopFences}=await load('./desktop-runtime.tsx',{useEffect:()=>{},inTauri:true,getAllWebviewWindows:async()=>[window],useFiles:{getState:()=>({categories:[{id:'a',name:'One'},{id:'b',name:'Two'}]})},useFences:{getState:()=>state},openFence:async(id)=>{calls.push(id);visible=true;},DEFAULT_FENCE:{x:0,y:0,w:300,h:200}});
 await toggleDesktopFences();assert.deepEqual(calls,['hide']);await toggleDesktopFences();assert.deepEqual(calls,['hide','a']);assert.equal(state.fences.a.open,true);assert.equal(state.fences.b.open,false);
});
