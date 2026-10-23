import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const nativeRequire=createRequire(import.meta.url),cache=new Map();
function load(name='./board-core') {
 if(cache.has(name)) return cache.get(name).exports;
 const code=ts.transpileModule(readFileSync(new URL(`${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const m={exports:{}};cache.set(name,m);new Function('require','module','exports',code)(s=>s.startsWith('.')?load(s):nativeRequire(s),m,m.exports);return m.exports;
}
const board=load();
const item=(id,status,extra={})=>({id,title:id,status,...extra});

test('board buckets keep the caller order and hold every status',()=>{
 const items=[item('a','doing'),item('b','todo'),item('c','done'),item('d','cancelled'),item('e','todo')];
 const b=board.groupByStatus(items);
 assert.deepEqual(b.todo.map(i=>i.id),['b','e']);
 assert.deepEqual(b.doing.map(i=>i.id),['a']);
 assert.deepEqual(b.done.map(i=>i.id),['c']);
 assert.deepEqual(b.cancelled.map(i=>i.id),['d']);
 assert.deepEqual([...board.BOARD_COLUMNS],['todo','doing','done','cancelled']);
});

test('empty board still exposes four droppable columns',()=>{
 const b=board.groupByStatus([]);
 for(const column of board.BOARD_COLUMNS) assert.deepEqual(b[column],[]);
});

test('unknown status lands in todo instead of vanishing, and input is not mutated',()=>{
 const items=[item('x','weird'),item('y','todo')];
 const b=board.groupByStatus(items);
 assert.deepEqual(b.todo.map(i=>i.id),['x','y']);
 assert.equal(items.length,2);
 assert.equal(items[0].status,'weird');
});

test('dropping inside the same column is a no-op, crossing columns writes the target status',()=>{
 assert.equal(board.nextStatusFor('doing','doing'),null);
 assert.equal(board.nextStatusFor('todo','doing'),'doing');
 assert.equal(board.nextStatusFor('done','todo'),'todo');
});
