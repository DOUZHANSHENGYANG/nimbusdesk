import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function apiWith(invoke) {
  const source = await readFile(new URL('./api.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText.replace(/^import[^\n]+\n/gm, '');
  const id = `__projectFiles${Math.random().toString(36).slice(2)}`;
  globalThis[id] = invoke;
  const api = await import(`data:text/javascript;base64,${Buffer.from(`const invoke=globalThis.${id};\n${compiled}`).toString('base64')}`);
  delete globalThis[id];
  return api;
}
test('project imports default to copy and every operation sends project identity instead of a root', async () => {
  const calls = [];
  const api = await apiWith(async (command, args) => { calls.push({command,args}); return []; });
  await api.importProjectFile('p', 'C:/source.txt', 'notes');
  await api.writeProjectText('p', 'notes/a.md', 'original', 'updated');
  await api.moveProjectFile('p', 'notes/a.md', 'notes/b.md');
  assert.deepEqual(calls, [
    {command:'project_import_file', args:{projectId:'p',source:'C:/source.txt',path:'notes',moveSource:false}},
    {command:'project_write_text', args:{projectId:'p',path:'notes/a.md',expected:'original',content:'updated'}},
    {command:'project_transfer_file', args:{projectId:'p',path:'notes/a.md',destination:'notes/b.md'}},
  ]);
});
test('native file conflicts propagate so the editor can preserve its local draft', async () => {
  const api = await apiWith(async () => { throw 'file-conflict'; });
  await assert.rejects(async () => api.writeProjectText('p','a.md','base','mine'), error => error === 'file-conflict');
});
