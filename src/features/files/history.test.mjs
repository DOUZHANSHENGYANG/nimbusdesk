import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

let sequence = 0;
async function load(path, dependencies = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const key = `__historyTest${++sequence}`;
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

const stubs = {
  create: () => () => ({}),
  persist: (fn) => fn,
  createJSONStorage: () => () => ({}),
  tauriJsonStorage: {},
};

const op = (over = {}) => ({
  id: 'o1', kind: 'rename', at: 1, from: 'E:/a.txt', to: 'E:/b.txt', label: 'a → b', ...over,
});

test('only rename / move / create are undoable — deletes are not faked', async () => {
  const { isUndoable } = await load('./history.ts', stubs);
  assert.equal(isUndoable(op({ kind: 'rename' })), true);
  assert.equal(isUndoable(op({ kind: 'move' })), true);
  assert.equal(isUndoable(op({ kind: 'create' })), true);
  assert.equal(isUndoable(op({ kind: 'delete' })), false, 'delete goes through the recycle bin');
});

test('nextUndoable skips delete records and finds the newest reversible step', async () => {
  const { nextUndoable } = await load('./history.ts', stubs);
  const stack = [
    op({ id: 'del', kind: 'delete', label: 'deleted' }),
    op({ id: 'move', kind: 'move' }),
    op({ id: 'ren', kind: 'rename' }),
  ];
  assert.equal(nextUndoable(stack).id, 'move');
  assert.equal(nextUndoable([op({ id: 'only-del', kind: 'delete' })]), undefined);
});

test('pushOp keeps the newest first and caps the stack', async () => {
  const { pushOp, HISTORY_LIMIT } = await load('./history.ts', stubs);
  const stack = Array.from({ length: HISTORY_LIMIT }, (_, i) => op({ id: `old-${i}` }));
  const next = pushOp(stack, op({ id: 'fresh' }));
  assert.equal(next.length, HISTORY_LIMIT);
  assert.equal(next[0].id, 'fresh');
  assert.equal(next.some((entry) => entry.id === `old-${HISTORY_LIMIT - 1}`), false, 'oldest entry falls off');
});

test('drop removes the whole batch that shares a groupId', async () => {
  const { pushOp } = await load('./history.ts', stubs);
  // 一次拖入多个文件：同 groupId 的几条要一起出栈，否则撤销一半会留下错乱的历史
  const stack = [
    op({ id: 'a', kind: 'move', groupId: 'g1' }),
    op({ id: 'b', kind: 'move', groupId: 'g1' }),
    op({ id: 'c', kind: 'rename' }),
  ];
  const grouped = stack.filter((entry) => entry.id !== 'a' && entry.groupId !== 'g1');
  assert.deepEqual(grouped.map((entry) => entry.id), ['c']);
  assert.equal(pushOp([], op({ id: 'x' }))[0].id, 'x');
});
