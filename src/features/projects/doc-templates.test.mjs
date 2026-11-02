import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const nativeRequire=createRequire(import.meta.url),cache=new Map();
function load(name='./doc-templates') {
  if(cache.has(name)) return cache.get(name).exports;
  const code=ts.transpileModule(readFileSync(new URL(`${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const m={exports:{}};cache.set(name,m);new Function('require','module','exports',code)(s=>s.startsWith('.')?load(s):nativeRequire(s),m,m.exports);return m.exports;
}
test('doc slots: five stable markdown paths under docs/ with usable templates',()=>{
 const {DOC_SLOTS,createdSlots}=load();
 assert.equal(DOC_SLOTS.length,5);
 assert.equal(new Set(DOC_SLOTS.map(s=>s.path)).size,5,'paths must be unique');
 assert.equal(new Set(DOC_SLOTS.map(s=>s.kind)).size,5,'kinds must be unique');
 for(const slot of DOC_SLOTS){
  assert.match(slot.path,/^docs\/[a-z0-9-]+\.md$/);
  assert.match(slot.body,/^# /,'every template starts with a heading');
  assert.ok(slot.body.length>120,`${slot.kind} template too thin`);
  assert.ok(slot.body.includes('|'),`${slot.kind} template should keep at least one table or checklist slot`);
 }
 assert.deepEqual([...createdSlots(['docs/02-prd.md'])],['prd']);
 assert.deepEqual([...createdSlots(['02-prd.md'])],['prd'],'basename only still counts');
 assert.deepEqual([...createdSlots(['docs\\05-dev-plan.md'])],['plan'],'windows separator counts');
 assert.deepEqual([...createdSlots(['docs/02-prd.md','docs/01-feasibility.md'])],['feasibility','prd'],'slot order is stable');
 assert.deepEqual([...createdSlots(['docs/02-prd-旧.md','README.md'])],[],'renamed or unrelated files do not fill a slot');
});
