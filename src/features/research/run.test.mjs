import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

let sequence = 0;
async function load(path, dependencies = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const key = `__researchTest${++sequence}`;
  const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import[\s\S]*?;\s*/gm, '');
  globalThis[key] = dependencies;
  try { return await import(`data:text/javascript;base64,${Buffer.from(`const {${Object.keys(dependencies).join(',')}}=globalThis.${key};\n${code}`).toString('base64')}`); }
  finally { delete globalThis[key]; }
}

test('the plan JSON is found even when the model wraps it in prose or a fence', async () => {
  const {parseJson}=await load('./run.ts',{invoke:async()=>[],chatWithProvider:async()=>''});
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'),{a:1});
  assert.deepEqual(parseJson('好的：\n{"a":[1,2]}'),{a:[1,2]});
  assert.equal(parseJson('没有 JSON'),null);
  assert.equal(parseJson('{"a":'),null);
});

test('every selected channel searches at least one query', async () => {
  const {queriesFor}=await load('./run.ts',{invoke:async()=>[],chatWithProvider:async()=>''});
  const plan={sub_questions:[],web_queries:[],social_queries:[],repo_query:''};
  for(const channel of ['web','cn-social','global','repo']){
    const queries=queriesFor(channel,plan,'Tauri 桌面应用');
    assert.ok(queries.length>=1,`${channel} 至少要有一条检索词`);
    assert.equal(queries[0],'Tauri 桌面应用');
  }
  const filled={sub_questions:['子问题'],web_queries:['网页词'],social_queries:['社区词'],repo_query:'tauri'};
  assert.deepEqual(queriesFor('web',filled,'主题'),['网页词']);
  assert.deepEqual(queriesFor('global',filled,'主题'),['社区词']);
  assert.deepEqual(queriesFor('repo',filled,'主题'),['tauri']);
});

test('sources are deduped by url and rotated across channels so one channel cannot fill the list', async () => {
  const {pickSources}=await load('./run.ts',{invoke:async()=>[],chatWithProvider:async()=>''});
  const hits=[
    {channel:'web',url:'a'},{channel:'web',url:'b'},{channel:'web',url:'c'},
    {channel:'global',url:'d'},{channel:'global',url:'e'},
    {channel:'repo',url:'f'},{channel:'web',url:'a'},
  ];
  assert.deepEqual(pickSources(hits,3).map(hit=>hit.url),['a','d','f']);
  assert.deepEqual(pickSources(hits,10).map(hit=>hit.url),['a','d','f','b','e','c']);
});
