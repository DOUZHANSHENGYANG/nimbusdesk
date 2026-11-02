import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const native = createRequire(import.meta.url);
function load(file, deps = {}) {
  if (!existsSync(new URL(file, import.meta.url))) return {};
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => deps[name] ?? native(name), module, module.exports);
  return module.exports;
}
function store() {
  return load('../../stores/files.ts', {
    '@/lib/storage': { tauriJsonStorage: { getItem: () => null, setItem: () => {} } },
    './files-storage': { filesTableStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } },
    '@/features/desktop/sticky-presentation': load('../desktop/sticky-presentation.ts'),
    '@/features/files/directory-mapping-core': load('./directory-mapping-core.ts'),
  });
}

test('a colour group is created once, defaults to the shared geometry, and keeps layout/open/active state independent', () => {
  const { useFences, DEFAULT_GROUP_GEOMETRY } = store();
  useFences.getState().ensureGroup('#B7E1B0');
  const group = useFences.getState().groups['#b7e1b0'];
  assert.deepEqual(group, {
    id: '#b7e1b0', color: '#b7e1b0', layout: 'sections', ...DEFAULT_GROUP_GEOMETRY, open: true,
  });
  useFences.getState().setGroupLayout('#b7e1b0', 'tabs');
  useFences.getState().setGroupGeometry('#b7e1b0', { x: 1, y: 2, w: 300, h: 400 });
  useFences.getState().setGroupOpen('#b7e1b0', false);
  useFences.getState().setGroupActive('#b7e1b0', 'cat-a');
  const changed = useFences.getState().groups['#b7e1b0'];
  assert.equal(changed.layout, 'tabs');
  assert.deepEqual({ x: changed.x, y: changed.y, w: changed.w, h: changed.h }, { x: 1, y: 2, w: 300, h: 400 });
  assert.equal(changed.open, false);
  assert.equal(changed.activeCategoryId, 'cat-a');
});

test('category group colours normalise to lower-case and reject non-hex values', () => {
  const { useFiles } = store();
  useFiles.setState({ categories: [{ id: 'a', name: 'A', createdAt: 1 }] });
  useFiles.getState().setCategoryGroupColor('a', '#B7E1B0');
  assert.equal(useFiles.getState().categories[0].groupColor, '#b7e1b0');
  useFiles.getState().setCategoryGroupColor('a', 'url(evil)');
  assert.equal(useFiles.getState().categories[0].groupColor, undefined);
});
