import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

let sequence = 0;
async function load(path, dependencies = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const key = `__moveTest${++sequence}`;
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
  id: 'i1', categoryId: 'a', type: 'file', title: 'a.txt', path: 'E:/a.txt', tags: [], createdAt: 1, ...over,
});

const stubs = {
  invoke: async () => [],
  inTauri: false,
  useFiles: { getState: () => ({ categories: [], items: [], updateItem: () => {} }) },
  categoryKind: (c) => c.kind ?? 'shortcut',
};

test('mapped targets accept nothing — their contents belong to the folder on disk', async () => {
  const { planBoxMove } = await load('./move-between-boxes.ts', stubs);
  const plan = planBoxMove([item()], 'mapped', 'b');
  assert.deepEqual(plan.movable, []);
  assert.equal(plan.physical, false);
});

test('moving into a storage box moves the file itself', async () => {
  const { planBoxMove } = await load('./move-between-boxes.ts', stubs);
  const plan = planBoxMove([item()], 'storage', 'b');
  assert.equal(plan.movable.length, 1);
  assert.equal(plan.physical, true, '存储盒的语义是「文件搬进来」');
});

test('moving into a shortcut box only changes ownership', async () => {
  const { planBoxMove } = await load('./move-between-boxes.ts', stubs);
  const plan = planBoxMove([item()], 'shortcut', 'b');
  assert.equal(plan.movable.length, 1);
  assert.equal(plan.physical, false, '只记引用，不动磁盘');
});

test('url items change box but are never part of a physical move', async () => {
  const { planBoxMove } = await load('./move-between-boxes.ts', stubs);
  const mixed = planBoxMove(
    [item({ id: 'url', type: 'url', path: 'https://example.test' }), item({ id: 'same', categoryId: 'b' }), item({ id: 'ok' })],
    'storage',
    'b',
  );
  // 网址条目同样要换归属（否则拖了没反应、原处还在），只是不参与搬文件
  assert.deepEqual(mixed.movable.map((entry) => entry.id), ['url', 'ok']);
  assert.equal(mixed.physical, true);

  const onlyUrls = planBoxMove([item({ id: 'url', type: 'url', path: 'https://example.test' })], 'storage', 'b');
  assert.deepEqual(onlyUrls.movable.map((entry) => entry.id), ['url']);
  assert.equal(onlyUrls.physical, false, 'nothing to copy to disk when the selection has no files');
});

test('an empty selection never reports a physical move', async () => {
  const { planBoxMove } = await load('./move-between-boxes.ts', stubs);
  const plan = planBoxMove([], 'storage', 'b');
  assert.deepEqual(plan.movable, []);
  assert.equal(plan.physical, false);
});
