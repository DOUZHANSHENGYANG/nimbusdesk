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
const core = load('./directory-mapping-core.ts');
function store() {
  return load('../../stores/files.ts', { '@/lib/storage': { tauriJsonStorage: { getItem: () => null, setItem: () => {} } },
    './files-storage': { filesTableStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } },
    '@/features/desktop/sticky-presentation': load('../desktop/sticky-presentation.ts'),
    '@/features/files/directory-mapping-core': core }).useFiles;
}
const item = (id, path, extra = {}) => ({ id, categoryId: 'a', path, title: path.split(/[\\/]/).at(-1), type: 'file', tags: [], createdAt: 1, ...extra });
const scan = entries => ({ root: 'D:\\Docs', entries: entries.map(([name, kind = 'file']) => ({ path: `D:\\Docs\\${name}`, name, kind })) });

test('Windows mapping paths compare canonical drive, UNC, extended prefixes, case and separators', () => {
  assert.equal(typeof core.normalizedMappingPath, 'function', 'mapping normalization is implemented');
  assert.equal(core.normalizedMappingPath('\\\\?\\D:\\Docs\\'), 'd:/docs');
  assert.equal(core.normalizedMappingPath('\\\\?\\UNC\\Server\\Share\\'), '//server/share');
  assert.equal(core.normalizedMappingPath('d:/DOCS'), 'd:/docs');
});

test('complete snapshots preserve manual references and mapped identities, tags and custom titles', () => {
  assert.equal(typeof core.reconcileDirectoryItems, 'function');
  const existing = [item('manual', 'd:/docs/A.txt', { title: 'My title' }),
    item('keep', 'D:\\Docs\\B.txt', { mappedRoot: 'D:\\Docs', tags: ['keep'], title: 'Custom', note: 'note' }),
    item('gone', 'D:\\Docs\\gone.txt', { mappedRoot: 'D:\\Docs' }),
    item('other', 'D:\\Docs\\gone.txt', { categoryId: 'b', mappedRoot: 'D:\\Docs' })];
  const result = core.reconcileDirectoryItems(existing, 'a', 'd:/docs/', scan([['a.TXT'], ['B.txt'], ['Folder', 'folder']]), () => 'new', 10);
  assert.equal(result.length, 4);
  assert.equal(result[0], existing[0]);
  assert.equal(result.find(x => x.id === 'keep'), existing[1]);
  assert.equal(result.find(x => x.id === 'other'), existing[3]);
  assert.deepEqual(result.find(x => x.id === 'new'), item('new', 'D:\\Docs\\Folder', { type: 'folder', mappedRoot: 'd:/docs/', createdAt: 10, updatedAt: 10 }));
  assert.equal(core.reconcileDirectoryItems(result, 'a', 'd:/docs/', scan([['a.TXT'], ['B.txt'], ['Folder', 'folder']]), () => 'unused', 20), result, 'no-op scans retain array identity');
});

test('malformed, mismatching and partial/out-of-root snapshots never delete cached records', () => {
  assert.equal(typeof core.reconcileDirectoryItems, 'function');
  for (const snapshot of [{ root: 'D:\\Other', entries: [] }, { root: 'D:\\Docs', entries: null },
    { root: 'D:\\Docs', entries: [{ path: 'D:\\Docs\\nested\\a', name: 'a', kind: 'file' }] },
    { root: 'D:\\Docs', entries: [{ path: 'D:\\Docs\\..\\a', name: 'a', kind: 'file' }] },
    { root: 'D:\\Docs', entries: [{ path: 'D:\\Docs\\a', name: 'a', kind: 'missing' }] }]) {
    const existing = [item('cached', 'D:\\Docs\\cached', { mappedRoot: 'D:\\Docs' })];
    assert.throws(() => core.reconcileDirectoryItems(existing, 'a', 'D:\\Docs', snapshot, () => 'new', 1));
    assert.equal(existing.length, 1);
  }
});

test('mapping is opt-in; switching and unmapping only remove generated references', () => {
  const useFiles = store();
  assert.equal(typeof useFiles.getState().setCategoryMapping, 'function');
  useFiles.setState({ categories: [{ id: 'a', name: 'Docs', createdAt: 1, dir: 'D:\\Legacy' }], items: [item('manual', 'D:\\manual')] });
  assert.equal(useFiles.getState().reconcileDirectory('a', 'D:\\Legacy', { root: 'D:\\Legacy', entries: [] }), false);
  useFiles.getState().setCategoryMapping('a', 'D:\\Docs');
  assert.equal(useFiles.getState().reconcileDirectory('a', 'D:\\Docs', scan([['a.txt']])), true);
  assert.equal(useFiles.getState().items.length, 2);
  useFiles.getState().setCategoryMapping('a', 'D:\\Else');
  assert.equal(useFiles.getState().items.length, 1);
  assert.equal(useFiles.getState().reconcileDirectory('a', 'D:\\Docs', scan([['stale.txt']])), false);
  useFiles.getState().setCategoryMapping('a', null);
  assert.equal(useFiles.getState().categories[0].syncDir, undefined);
  assert.equal(useFiles.getState().categories[0].dir, undefined);
  assert.equal(useFiles.getState().items[0].id, 'manual');
});

test('same-root settings do not reset mapped items, scans after category deletion do nothing', () => {
  const useFiles = store();
  assert.equal(typeof useFiles.getState().setCategoryMapping, 'function');
  useFiles.setState({ categories: [{ id: 'a', name: 'Docs', createdAt: 1, dir: 'D:\\Docs', syncDir: true }], items: [item('keep', 'D:\\Docs\\a', { mappedRoot: 'D:\\Docs' })] });
  useFiles.getState().setCategoryMapping('a', 'd:/DOCS/');
  assert.equal(useFiles.getState().items[0].id, 'keep');
  useFiles.getState().removeCategory('a');
  assert.equal(useFiles.getState().reconcileDirectory('a', 'D:\\Docs', scan([['stale']])), false);
  assert.equal(useFiles.getState().items.length, 0);
});

test('reclassifying a mapped entry makes it a manual reference in its chosen category', () => {
  const useFiles = store();
  useFiles.setState({ categories: [], items: [item('keep', 'D:\\Docs\\a', { mappedRoot: 'D:\\Docs' })] });
  useFiles.getState().updateItem('keep', { categoryId: 'b' });
  assert.equal(useFiles.getState().items[0].mappedRoot, undefined);
});

test('editing a mapped target outside its directory or into a URL preserves it as a manual reference', () => {
  for (const patch of [{ path: 'E:\\Other\\a.txt' }, { type: 'url', path: 'https://example.com' }]) {
    const useFiles = store();
    useFiles.setState({ categories: [{ id: 'a', name: 'Docs', createdAt: 1, dir: 'D:\\Docs', syncDir: true }],
      items: [item('keep', 'D:\\Docs\\a.txt', { mappedRoot: 'D:\\Docs' })] });
    useFiles.getState().updateItem('keep', patch);
    useFiles.getState().reconcileDirectory('a', 'D:\\Docs', scan([]));
    assert.equal(useFiles.getState().items[0]?.id, 'keep');
    assert.equal(useFiles.getState().items[0]?.mappedRoot, undefined);
  }
});

test('physically moving a mapped root updates ownership with the directory and avoids duplicate cached rows', () => {
  const useFiles = store();
  useFiles.setState({ categories: [{ id: 'a', name: 'Docs', createdAt: 1, syncDir: true, dir: 'D:\\Docs' }, { id: 'b', name: 'Destination', createdAt: 1 }],
    items: [item('keep', 'D:\\Docs\\a.txt', { mappedRoot: 'D:\\Docs' })] });
  useFiles.getState().applyMovedEntries('b', [{ source: 'D:\\Docs', path: 'E:\\Moved', name: 'Moved', kind: 'folder', sourceRetained: false }]);
  const row = useFiles.getState().items.find(x => x.id === 'keep');
  assert.equal(row.mappedRoot, 'E:\\Moved');
  assert.equal(useFiles.getState().categories[0].dir, 'E:\\Moved');
  assert.equal(useFiles.getState().reconcileDirectory('a', 'E:\\Moved', { root: 'E:\\Moved', entries: [{ path: 'E:\\Moved\\a.txt', name: 'a.txt', kind: 'file' }] }), true);
  assert.equal(useFiles.getState().items.filter(x => x.categoryId === 'a').length, 1);
});
