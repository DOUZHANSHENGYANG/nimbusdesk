import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const nativeRequire=createRequire(import.meta.url),cache=new Map();
function load(name='./skill-drop') {
 if(cache.has(name)) return cache.get(name).exports;
 const code=ts.transpileModule(readFileSync(new URL(`${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const m={exports:{}};cache.set(name,m);new Function('require','module','exports',code)(s=>s.startsWith('.')?load(s):nativeRequire(s),m,m.exports);return m.exports;
}
const drop=load();

test('zip and folder drops are told apart by extension, case insensitive',()=>{
 assert.equal(drop.classifyDroppedPath('C:/Users/me/skills/a.zip'),'zip');
 assert.equal(drop.classifyDroppedPath('C:/Users/me/skills/A.ZIP'),'zip');
 assert.equal(drop.classifyDroppedPath('C:/Users/me/skills/a'),'folder');
 assert.equal(drop.classifyDroppedPath('C:\\Users\\me\\skills\\zipdir'),'folder');
 assert.equal(drop.classifyDroppedPath('  C:/x/a.zip  '),'zip');
});

test('one drop can carry folders and zips, blanks are ignored',()=>{
 const split=drop.splitDroppedPaths(['C:/a/skill-one',' C:/b/two.zip ','','   ','C:\\c\\skill-two']);
 assert.deepEqual(split.folders,['C:/a/skill-one','C:\\c\\skill-two']);
 assert.deepEqual(split.zips,['C:/b/two.zip']);
 assert.deepEqual(drop.splitDroppedPaths([]),{folders:[],zips:[]});
});

test('a parent folder full of skills is routed to explore instead of failing',()=>{
 assert.equal(drop.needsExplore('no SKILL.md in C:/skills/pack'),true);
 assert.equal(drop.needsExplore('缺少 SKILL.md'),true);
 assert.equal(drop.needsExplore('exists: my-skill'),false);
 assert.equal(drop.needsExplore('permission denied'),false);
});

test('drop position picks the card under the cursor',()=>{
 const rects={folder:{left:0,top:0,right:100,bottom:50},zip:{left:120,top:0,right:220,bottom:50}};
 assert.equal(drop.slotAtPoint(rects,10,10),'folder');
 assert.equal(drop.slotAtPoint(rects,150,49),'zip');
 assert.equal(drop.slotAtPoint(rects,110,10),null);
 assert.equal(drop.slotAtPoint({folder:null,zip:rects.zip},10,10),null);
 assert.equal(drop.slotAtPoint({},0,0),null);
});
