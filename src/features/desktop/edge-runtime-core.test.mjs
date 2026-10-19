import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

test('group drag chooses the nearest supported work-area edge and handles no monitors', () => {
  const { groupDragDestination } = core();
  assert.deepEqual(groupDragDestination({ x: 1340, y: -30, w: 24, h: 40 }, [monitor]), { area: monitor, edge: 'right', offset: 0 });
  assert.equal(groupDragDestination({ x: 0, y: 0, w: 24, h: 40 }, []), null);
});

test('group drag snaps to the nearest top edge and saves a horizontal logical offset', () => {
  const area = { id: 'scaled', x: -2560, y: -400, w: 2560, h: 1440, scale: 1.5 };
  assert.deepEqual(core().groupDragDestination({ x: -1660, y: -388, w: 66, h: 60 }, [area]), {
    area, edge: 'top', offset: 600,
  });
  assert.equal(core().groupDragDestination({ x: 600, y: 12, w: 44, h: 40 }, [monitor]).edge, 'top');
});

test('top hub bounds keep the closed handle and open menu within a scaled work area', () => {
  const { hubBounds } = core();
  assert.equal(typeof hubBounds, 'function');
  const area = { id: 'scaled', x: -1200, y: 40, w: 1200, h: 900, scale: 1.5 };
  assert.deepEqual(hubBounds(area, 'top', 790, false, 2), { x: -66, y: 40, w: 66, h: 60 });
  assert.deepEqual(hubBounds(area, 'top', 790, true, 2), { x: -420, y: 40, w: 420, h: 396 });
  assert.deepEqual(hubBounds(area, 'left', 590, false, 2), { x: -1200, y: 880, w: 66, h: 60 });
  assert.deepEqual(hubBounds(area, 'right', 590, true, 2), { x: -420, y: 544, w: 420, h: 396 });
});

test('top queues retain canonical hub reconciliation across display changes', () => {
  const { groupKey } = load('./queue-core.ts');
  const key = groupKey('primary', 'top');
  assert.deepEqual(core().desiredHubKeys({ [key]: { ...queue, edge: 'top' } }, [
    { id: 'top', form: 'capsule', edge: 'top', edgeMonitor: 'primary' },
  ]), [key]);
});

test('workspace hydration and storage updates retain valid top groups but reject unsupported edges', () => {
  const { groupKey } = load('./queue-core.ts');
  const key = groupKey('primary', 'top');
  const top = { ...queue, edge: 'top', offset: 300, order: ['a', 'a', 'b'] };
  let synced;
  const nativeRequire = createRequire(import.meta.url);
  const storage = {
    getItem: () => JSON.stringify({ state: { groups: { [key]: top, invalid: { ...queue, edge: 'bottom' } } }, version: 1 }),
    setItem: () => {}, removeItem: () => {},
  };
  const source = readFileSync(new URL('./edge-workspace.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => name === '@/lib/storage'
    ? { tauriJsonStorage: storage, onStorageSynced: callback => { synced = callback; } }
    : nativeRequire(name), module, module.exports);
  const store = module.exports.useEdgeWorkspace;
  assert.deepEqual(store.getState().groups, { [key]: { ...top, order: ['a', 'b'] } });
  store.getState().setOffset(key, 480);
  assert.equal(store.getState().groups[key].edge, 'top');
  synced('edge-workspace', { state: { groups: { [key]: { ...top, offset: 510 }, bad: { ...top, edge: 'bottom' } } } });
  assert.deepEqual(store.getState().groups, { [key]: { ...top, order: ['a', 'b'], offset: 510 } });
});
