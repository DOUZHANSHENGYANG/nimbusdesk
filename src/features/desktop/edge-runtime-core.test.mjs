import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';

function load(file) {
  const path = new URL(file, import.meta.url);
  if (!existsSync(path)) return {};
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => load(`${name}.ts`), module, module.exports);
  return module.exports;
}
function core() {
  const api = load('./edge-runtime-core.ts');
  assert.equal(typeof api.hubWindowChanges, 'function', 'runtime reconciliation helpers must exist');
  return api;
}
const monitor = { id: 'primary', x: 0, y: 0, w: 1366, h: 768, scale: 1 };
const queue = { monitorId: 'primary', edge: 'right', order: [], offset: 48, collapsed: false };

test('hub label parser accepts exactly the bounded native hexadecimal contract', () => {
  const { hubKeyFromLabel } = core();
  assert.equal(hubKeyFromLabel('edge-hub-aB10'), 'aB10');
  assert.equal(hubKeyFromLabel(`edge-hub-${'a'.repeat(512)}`), 'a'.repeat(512));
  for (const label of ['main', 'edge-hub-', 'edge-hub-main', 'edge-hub-aa/bb', 'edge-hub-１２', `edge-hub-${'a'.repeat(513)}`]) assert.equal(hubKeyFromLabel(label), null);
});

test('desired hubs include occupied capsule groups and exclude normal windows or stale groups', () => {
  const { desiredHubKeys } = core();
  const { groupKey } = load('./queue-core.ts');
  const key = groupKey('primary', 'right'), unused = groupKey('primary', 'left');
  const groups = { [key]: queue, [unused]: { ...queue, edge: 'left' } };
  assert.deepEqual(desiredHubKeys(groups, [{ id: 'a', form: 'capsule', edge: 'right', edgeMonitor: 'primary' }]), [key]);
  assert.deepEqual(desiredHubKeys(groups, [{ id: 'a', form: 'paper', edge: 'right', edgeMonitor: 'primary' }]), []);
});

test('invalid or noncanonical persisted group keys never reach native hub commands', () => {
  const { desiredHubKeys } = core();
  assert.deepEqual(desiredHubKeys({ main: queue, aa: queue }, [{ id: 'a', form: 'capsule', edge: 'right', edgeMonitor: 'primary' }]), []);
  const { groupKey } = load('./queue-core.ts');
  const id = 'display'.repeat(100), key = groupKey(id, 'right');
  assert.deepEqual(desiredHubKeys({ [key]: { ...queue, monitorId: id } }, [{ id: 'a', form: 'capsule', edge: 'right', edgeMonitor: id }]), []);
});

test('hub reconciliation leaves existing hidden hubs untouched and only opens missing or closes stale hubs', () => {
  const { hubWindowChanges } = core();
  assert.deepEqual(hubWindowChanges(['aa', 'bb'], ['main', 'todo-a', 'edge-hub-aa', 'edge-hub-cc']), { open: ['bb'], close: ['cc'] });
  assert.deepEqual(hubWindowChanges(['aa'], ['edge-hub-aa']), { open: [], close: [] });
});

test('hub reconciliation deduplicates requests and cannot close unrelated or malformed labels', () => {
  assert.deepEqual(core().hubWindowChanges(['aa', 'aa', '../main'], ['main', 'edge-hub-bb', 'edge-hub-bb', 'edge-hub-', 'edge-hub-main']), { open: ['aa'], close: ['bb'] });
});

test('display comparison ignores enumeration order but detects DPI, position and work area changes', () => {
  const { sameMonitors } = core();
  const other = { ...monitor, id: 'other', x: -1920, scale: 1.5 };
  assert.equal(sameMonitors([monitor, other], [other, { ...monitor }]), true);
  for (const change of [{ scale: 1.25 }, { x: -10 }, { h: 720 }, { y: 40 }]) assert.equal(sameMonitors([monitor], [{ ...monitor, ...change }]), false);
  assert.equal(sameMonitors([monitor], []), false);
});

test('native group drag resolves physical monitor and returns logical top-relative offset', () => {
  const other = { id: 'other', x: -2560, y: -300, w: 2560, h: 1440, scale: 1.5 };
  const result = core().groupDragDestination({ x: -2540, y: 0, w: 36, h: 60 }, [monitor, other]);
  assert.equal(result.area, other);
  assert.equal(result.edge, 'left');
  assert.equal(result.offset, 200);
});

test('group drag chooses the destination edge from physical center and handles no monitors', () => {
  const { groupDragDestination } = core();
  assert.deepEqual(groupDragDestination({ x: 1340, y: -30, w: 24, h: 40 }, [monitor]), { area: monitor, edge: 'right', offset: 0 });
  assert.equal(groupDragDestination({ x: 0, y: 0, w: 24, h: 40 }, []), null);
});
