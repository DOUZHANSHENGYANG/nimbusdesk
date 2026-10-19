import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);
function load(file, dependencies = {}) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => dependencies[name] ?? nativeRequire(name), module, module.exports);
  return module.exports;
}
const queueCore = load('./queue-core.ts');
const runtimeCore = load('./edge-runtime-core.ts', { './queue-core': queueCore, './edge-core': load('./edge-core.ts') });
const first = { id: 'primary', x: 0, y: 0, w: 1366, h: 768, scale: 1 };
const normal = { x: -1000, y: 90, w: 320, h: 400 };
const group = (monitorId, order, extra = {}) => ({ monitorId, edge: 'right', order, collapsed: false, offset: 48, ...extra });

function fixture(initialEntries, initialGroups = {}) {
  let entries = initialEntries;
  const writes = [];
  const state = { groups: initialGroups, updateGroup: (key, value) => { writes.push(['group', key]); state.groups = { ...state.groups, [key]: { ...state.groups[key], ...value } }; } };
  const workspace = { useEdgeWorkspace: { getState: () => state } };
  const registry = {
    desktopEntries: () => entries,
    saveDockPosition: (id, value) => { writes.push(['placement', id]); entries = entries.map(entry => entry.id === id ? { ...entry, ...value } : entry); },
  };
  const queueRegistry = load('./queue-registry.ts', { './registry': registry, './edge-workspace': workspace, './queue-core': queueCore });
  const runtime = load('./edge-runtime.tsx', {
    '@/lib/tauri': { inTauri: false }, '@/stores/files': {}, '@/stores/papers': {},
    './edge-core': {}, './edge-workspace': workspace, './queue-core': queueCore,
    './registry': registry, './queue-registry': queueRegistry, './monitors': {}, './edge-runtime-core': runtimeCore,
    '@tauri-apps/api/core': {}, '@tauri-apps/api/event': {}, '@tauri-apps/api/webviewWindow': {},
  });
  return { synchronize: runtime.synchronizeDockMonitors, get entries() { return entries; }, state, writes };
}

test('removed-monitor migration transfers the whole ordered group before individual tabs re-reserve', () => {
  const oldKey = queueCore.groupKey('removed', 'right'), targetKey = queueCore.groupKey(first.id, 'right');
  const f = fixture([
    { id: 'a', form: 'capsule', edge: 'right', edgeMonitor: 'removed', normal, locked: true },
    { id: 'b', form: 'capsule', edge: 'right', edgeMonitor: 'removed', normal },
    { id: 'local', form: 'capsule', edge: 'right', edgeMonitor: first.id, normal },
  ], { [oldKey]: group('removed', ['b', 'a'], { offset: 88, collapsed: true }), [targetKey]: group(first.id, ['local']) });
  f.synchronize([first]);
  assert.deepEqual(f.state.groups[targetKey].order, ['b', 'a', 'local']);
  assert.equal(f.state.groups[targetKey].offset, 88);
  assert.equal(f.state.groups[targetKey].collapsed, true);
  assert.deepEqual(f.state.groups[oldKey].order, []);
  assert.ok(f.entries.every(entry => entry.edgeMonitor === first.id && entry.normal === normal));
  assert.equal(f.writes.filter(([kind]) => kind === 'placement').length, 2);
});

test('unassigned legacy capsules receive a monitor once without rewriting stable preferences on every pass', () => {
  const f = fixture([{ id: 'a', form: 'capsule', edge: 'right', normal }, { id: 'b', form: 'capsule', edge: 'right', normal }]);
  f.synchronize([first]);
  const count = f.writes.length;
  f.synchronize([first]);
  assert.equal(f.writes.length, count);
  assert.ok(f.entries.every(entry => entry.edgeMonitor === first.id));
  assert.equal(Object.keys(f.state.groups).length, 1);
});

test('ordinary windows keep their saved geometry and placement intent during display migration', () => {
  const original = { id: 'paper', form: 'paper', edge: 'right', edgeMonitor: 'removed', normal };
  const f = fixture([original]);
  f.synchronize([first]);
  assert.equal(f.entries[0], original);
  assert.deepEqual(f.writes, []);
});

test('empty monitor snapshots preserve queues for the next successful display refresh', () => {
  const oldKey = queueCore.groupKey('removed', 'right');
  const f = fixture([{ id: 'a', form: 'capsule', edge: 'right', edgeMonitor: 'removed', normal }], { [oldKey]: group('removed', ['a']) });
  f.synchronize([]);
  assert.deepEqual(f.writes, []);
  assert.equal(f.entries[0].edgeMonitor, 'removed');
});

test('display recovery preserves the top edge and its horizontal group anchor', () => {
  const oldKey = queueCore.groupKey('removed', 'top'), targetKey = queueCore.groupKey(first.id, 'top');
  const f = fixture([
    { id: 'a', form: 'capsule', edge: 'top', edgeMonitor: 'removed', dockOffset: 300, normal },
    { id: 'b', form: 'capsule', edge: 'top', edgeMonitor: 'removed', dockOffset: 500, normal },
  ], { [oldKey]: group('removed', ['b', 'a'], { edge: 'top', offset: 170 }) });
  f.synchronize([first]);
  assert.equal(f.state.groups[targetKey].edge, 'top');
  assert.equal(f.state.groups[targetKey].offset, 170);
  assert.deepEqual(f.state.groups[targetKey].order, ['b', 'a']);
  assert.ok(f.entries.every(entry => entry.edge === 'top' && entry.edgeMonitor === first.id && entry.normal === normal));
  const count = f.writes.length;
  f.synchronize([first]);
  assert.equal(f.writes.length, count, 'stable display snapshots must not rewrite placements');
});
