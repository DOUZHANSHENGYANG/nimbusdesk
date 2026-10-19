import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const native = createRequire(import.meta.url);
function load(file, deps = {}) {
  if (!existsSync(new URL(file, import.meta.url))) return {};
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(name => deps[name] ?? native(name), module, module.exports);
  return module.exports;
}
function store(storage = { getItem: () => null, setItem: () => {} }) {
  return load('../../stores/files.ts', { '@/lib/storage': { tauriJsonStorage: storage }, '@/features/desktop/sticky-presentation': load('../desktop/sticky-presentation.ts'), '@/features/files/directory-mapping-core': load('./directory-mapping-core.ts') });
}
test('legacy fences default to icons and unlocked while changing one preference preserves geometry and other fences', () => {
  const { useFences, DEFAULT_FENCE } = store();
  useFences.setState({ fences: { legacy: { ...DEFAULT_FENCE, x: -220, open: true, form: 'capsule', pinned: true }, other: { ...DEFAULT_FENCE } } });
  assert.equal(DEFAULT_FENCE.viewMode, 'icons');
  assert.equal(DEFAULT_FENCE.locked, false);
  useFences.getState().setViewMode('legacy', 'list');
  useFences.getState().setLocked('legacy', true);
  assert.deepEqual(useFences.getState().fences.legacy, { ...DEFAULT_FENCE, x: -220, open: true, form: 'capsule', pinned: true, viewMode: 'list', locked: true });
  assert.deepEqual(useFences.getState().fences.other, DEFAULT_FENCE);
  useFences.getState().setLocked('legacy', false);
  assert.equal(useFences.getState().fences.legacy.viewMode, 'list');
});
test('new fence presentation preferences initialize a complete independent record', () => {
  const { useFences, DEFAULT_FENCE } = store();
  useFences.getState().setViewMode('new', 'list');
  useFences.getState().setLocked('new', true);
  assert.deepEqual(useFences.getState().fences.new, { ...DEFAULT_FENCE, viewMode: 'list', locked: true });
});
test('list mode and position lock survive a fresh store hydration without losing the normal rectangle', async () => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const first = store(storage);
  first.useFences.getState().setGeometry('a', { x: -400, y: 50, w: 320, h: 410 });
  first.useFences.getState().setViewMode('a', 'list');
  first.useFences.getState().setLocked('a', true);
  const second = store(storage);
  await second.useFences.persist.rehydrate();
  assert.deepEqual(second.useFences.getState().fences.a, { ...second.DEFAULT_FENCE, x: -400, y: 50, w: 320, h: 410, viewMode: 'list', locked: true });
});
test('list layout fits more readable rows in the same window and keeps one keyboard column', () => {
  const { fenceLayout } = load('./fence-presentation.ts');
  const icons = fenceLayout('icons', 1, 260, 280);
  const list = fenceLayout('list', 1, 260, 280);
  assert.equal(icons.cols, 3);
  assert.equal(icons.pageSize, 6);
  assert.equal(list.cols, 1);
  assert.equal(list.rows, 7);
  assert.equal(list.pageSize, 7);
  assert.equal(list.iconSize, 22);
  assert.equal(list.cellW, 260);
});
test('layout always retains an actionable row at tiny size and respects user scale', () => {
  const { fenceLayout } = load('./fence-presentation.ts');
  assert.equal(fenceLayout('list', 1, 10, 10).pageSize, 1);
  assert.ok(fenceLayout('list', 1.6, 300, 280).pageSize < fenceLayout('list', 0.7, 300, 280).pageSize);
});
test('list insertion follows row midpoint, independent of pointer horizontal position', () => {
  const { fenceInsertionBefore } = load('./fence-presentation.ts');
  const rect = { left: 8, top: 40, right: 260, bottom: 80, width: 252, height: 40 };
  assert.equal(fenceInsertionBefore('list', rect, 250, 59), true);
  assert.equal(fenceInsertionBefore('list', rect, 9, 61), false);
  assert.equal(fenceInsertionBefore('icons', rect, 9, 61), true);
  assert.equal(fenceInsertionBefore('icons', rect, 250, 61), false);
});
