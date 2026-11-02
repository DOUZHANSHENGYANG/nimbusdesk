import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

let sequence = 0;
async function load(path, dependencies = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const key = `__metaTest${++sequence}`;
  const code = ts
    .transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
    .outputText.replace(/^import[\s\S]*?;\s*/gm, '');
  globalThis[key] = dependencies;
  try {
    return await import(
      `data:text/javascript;base64,${Buffer.from(`const {${Object.keys(dependencies).join(',')}}=globalThis.${key};\n${code}`).toString('base64')}`
    );
  } finally {
    delete globalThis[key];
  }
}

const item = (over = {}) => ({
  id: 'i1', categoryId: 'c1', type: 'file', title: 'a.txt', path: 'E:/a.txt', tags: [], createdAt: 1, ...over,
});

test('an item with no cached metadata is refreshed', async () => {
  const { needsMetaRefresh } = await load('./meta-cache.ts', {});
  assert.equal(needsMetaRefresh(item(), 1_000_000), true);
});

test('fresh cached metadata is left alone', async () => {
  const { needsMetaRefresh, META_TTL } = await load('./meta-cache.ts', {});
  const now = 1_000_000_000_000;
  const cached = item({ size: 10, mtime: 5, metaAt: now - 1000 });
  assert.equal(needsMetaRefresh(cached, now), false);
  assert.equal(needsMetaRefresh(cached, now + META_TTL + 1), true, 'must expire after the TTL');
});

test('a cached null size still counts as cached', async () => {
  const { needsMetaRefresh } = await load('./meta-cache.ts', {});
  const now = 1_000_000_000_000;
  // 目录 size 是 null：写过一次就不该每轮都重新 stat
  assert.equal(needsMetaRefresh(item({ size: null, mtime: 7, metaAt: now }), now), false);
});

test('web links are never refreshed', async () => {
  const { needsMetaRefresh } = await load('./meta-cache.ts', {});
  assert.equal(needsMetaRefresh(item({ type: 'url', path: 'https://example.test' }), 1), false);
});

test('pickMetaTargets takes a bounded chunk of stale items only', async () => {
  const { pickMetaTargets, REFRESH_CHUNK } = await load('./meta-cache.ts', {});
  const now = 1_000_000_000_000;
  const items = [
    item({ id: 'fresh', size: 1, mtime: 1, metaAt: now }),
    item({ id: 'stale-1' }),
    item({ id: 'url', type: 'url' }),
    item({ id: 'stale-2', metaAt: 0 }),
  ];
  assert.deepEqual(pickMetaTargets(items, now).map((i) => i.id), ['stale-1', 'stale-2']);
  assert.equal(pickMetaTargets(Array.from({ length: REFRESH_CHUNK + 50 }, (_, i) => item({ id: `x${i}` })), now).length, REFRESH_CHUNK);
});
