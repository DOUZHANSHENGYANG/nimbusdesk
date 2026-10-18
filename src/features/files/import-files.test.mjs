import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

let sequence = 0;
async function load(path, deps = {}) {
  const key = `__fileImport${sequence++}`;
  const code = ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/^import[\s\S]*?;\s*/gm, '');
  globalThis[key] = deps;
  try { return await import(`data:text/javascript;base64,${Buffer.from(`const {${Object.keys(deps).join(',')}}=globalThis.${key};\n${code}`).toString('base64')}`); }
  finally { delete globalThis[key]; }
}

async function harness(probe) {
  const writes = [];
  const { useFiles } = await load('../../stores/files.ts', { create, persist, createJSONStorage,
    tauriJsonStorage: { getItem: () => null, setItem: (_key, value) => writes.push(JSON.parse(value)) } });
  let flushes = 0;
  let flush = async () => { flushes++; };
  const api = await load('./import-files.ts', { useFiles, probePaths: probe, flushAllStorage: () => flush() });
  return { ...api, useFiles, writes, get flushes() { return flushes; }, setFlush: value => { flush = value; } };
}

test('mixed files and folders are collected as references in a default category, after a durable flush', async () => {
  const paths = ['D:\\Docs\\report.pdf', 'D:\\Projects\\demo', 'D:\\gone'];
  const h = await harness(async received => {
    assert.deepEqual(received, paths);
    return [{ path: paths[0], kind: 'file', name: 'report.pdf' }, { path: paths[1], kind: 'folder', name: 'demo' }, { path: paths[2], kind: 'missing', name: 'gone' }];
  });
  let release;
  h.setFlush(() => new Promise(resolve => { release = resolve; }));
  let settled = false;
  const pending = h.importDroppedFiles(paths, '默认分类').then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(h.useFiles.getState().items.length, 2);
  release();
  const result = await pending;
  assert.deepEqual(result, { categoryId: h.useFiles.getState().categories[0].id, added: 2, duplicates: 0, missing: 1 });
  assert.deepEqual(h.useFiles.getState().items.map(({ type, path, title, tags }) => ({ type, path, title, tags })), [
    { type: 'file', path: paths[0], title: 'report.pdf', tags: [] },
    { type: 'folder', path: paths[1], title: 'demo', tags: [] },
  ]);
});

test('deduplication is case/slash/trailing separator insensitive across all categories, without moving existing classifications', async () => {
  const h = await harness(async paths => paths.map(path => ({ path, kind: 'file', name: path.split(/[\\/]/).filter(Boolean).at(-1) })));
  const existing = h.useFiles.getState().addCategory('Other');
  h.useFiles.getState().addItem({ categoryId: existing, type: 'file', title: 'Mine', path: 'D:\\Docs\\A.TXT', tags: ['keep'] });
  const result = await h.importDroppedFiles(['d:/docs/a.txt/', 'D:\\Docs\\b.txt', 'd:/DOCS/b.txt\\'], '默认分类');
  assert.equal(result.added, 1);
  assert.equal(result.duplicates, 2);
  assert.equal(h.useFiles.getState().items[0].categoryId, existing);
  assert.deepEqual(h.useFiles.getState().items[0].tags, ['keep']);
});

test('Chinese and English top-level defaults are reused across locale changes, never a child category', async () => {
  for (const [existingName, requested] of [['默认分类', 'Default'], ['Default', '默认分类']]) {
    const h = await harness(async paths => paths.map(path => ({ path, kind: 'folder', name: 'folder' })));
    const parent = h.useFiles.getState().addCategory('Parent');
    h.useFiles.getState().addCategory(requested, parent);
    const defaultId = h.useFiles.getState().addCategory(existingName);
    const result = await h.importDroppedFiles(['D:\\folder'], requested);
    assert.equal(result.categoryId, defaultId);
    assert.equal(h.useFiles.getState().categories.length, 3);
  }
});

test('missing, empty and duplicate-only drops do not create an empty default category', async () => {
  let probes = 0;
  const h = await harness(async paths => { probes++; return paths.map(path => ({ path, kind: 'missing', name: '' })); });
  assert.deepEqual(await h.importDroppedFiles([], '默认分类'), { categoryId: null, added: 0, duplicates: 0, missing: 0 });
  assert.equal(probes, 0);
  assert.deepEqual(await h.importDroppedFiles(['D:\\gone'], '默认分类'), { categoryId: null, added: 0, duplicates: 0, missing: 1 });
  assert.equal(h.useFiles.getState().categories.length, 0);
  const same = await harness(async paths => paths.map(path => ({ path, kind: 'file', name: 'same' })));
  const id = same.useFiles.getState().addCategory('Existing');
  same.useFiles.getState().addItem({ categoryId: id, type: 'file', path: 'D:\\same', title: 'same', tags: [] });
  assert.equal((await same.importDroppedFiles(['d:/same'], '默认分类')).duplicates, 1);
  assert.equal(same.useFiles.getState().categories.length, 1);
});

test('concurrent probing reads the latest state and adds one reference and one default only', async () => {
  const resolve = [];
  const h = await harness(paths => new Promise(done => resolve.push(() => done(paths.map(path => ({ path, kind: 'file', name: 'same.txt' }))))));
  const first = h.importDroppedFiles(['D:\\same.txt'], 'Default');
  const second = h.importDroppedFiles(['d:/SAME.txt'], '默认分类');
  resolve[1]();
  const b = await second;
  resolve[0]();
  const a = await first;
  assert.equal(a.added + b.added, 1);
  assert.equal(a.duplicates + b.duplicates, 1);
  assert.equal(h.useFiles.getState().categories.length, 1);
  assert.equal(h.useFiles.getState().items.length, 1);
});

test('probe failure leaves storage untouched, and persistence failure rejects instead of claiming success', async () => {
  const h = await harness(async () => { throw new Error('probe failed'); });
  await assert.rejects(h.importDroppedFiles(['D:\\x'], 'Default'), /probe failed/);
  assert.equal(h.useFiles.getState().categories.length, 0);
  assert.equal(h.writes.length, 0);
  const saved = await harness(async paths => paths.map(path => ({ path, kind: 'file', name: 'x' })));
  saved.setFlush(async () => { throw new Error('disk full'); });
  await assert.rejects(saved.importDroppedFiles(['D:\\x'], 'Default'), /disk full/);
  let retried = 0;
  saved.setFlush(async () => { retried++; });
  const retry = await saved.importDroppedFiles(['d:/X'], '默认分类');
  assert.equal(retried, 1, 'a duplicate-only retry must still drain the pending failed write');
  assert.equal(retry.added, 0);
  assert.equal(retry.duplicates, 1);
  assert.equal(saved.useFiles.getState().items.length, 1);
});
