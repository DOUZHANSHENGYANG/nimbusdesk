import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const native = createRequire(import.meta.url);
function load(file, deps = {}, clock = globalThis) {
  if (!existsSync(new URL(file, import.meta.url))) return {};
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function('require', 'module', 'exports', 'setInterval', 'clearInterval', code)(name => deps[name] ?? native(name), module, module.exports, clock.setInterval, clock.clearInterval);
  return module.exports;
}
const core = load('./directory-mapping-core.ts');
function harness(scan) {
  let writes = 0;
  const files = load('../../stores/files.ts', { '@/lib/storage': { tauriJsonStorage: { getItem: () => null, setItem: () => { writes++; } } },
    '@/features/desktop/sticky-presentation': load('../desktop/sticky-presentation.ts'), '@/features/files/directory-mapping-core': core });
  const api = load('./directory-mapping.ts', { '@/stores/files': files, '@/lib/tauri': { fileDirectorySnapshot: scan }, './directory-mapping-core': core });
  return { useFiles: files.useFiles, ...api, get writes() { return writes; } };
}
const category = (id, dir = 'D:\\Docs') => ({ id, name: id, createdAt: 1, dir, syncDir: true });
const snapshot = (root = 'D:\\Docs', name = 'a.txt') => ({ root, entries: [{ path: `${root}\\${name}`, name, kind: 'file' }] });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('refresh publishes progress and successful snapshot, unchanged polling does not write storage', async () => {
  const h = harness(async root => snapshot(root));
  assert.equal(typeof h.refreshMappedCategory, 'function');
  h.useFiles.setState({ categories: [category('a')], items: [] });
  const task = h.refreshMappedCategory('a');
  assert.equal(h.useDirectoryMappingStatuses.getState().statuses.a.busy, true);
  await task;
  const status = h.useDirectoryMappingStatuses.getState().statuses.a;
  assert.equal(status.busy, false);
  assert.equal(status.count, 1);
  assert.ok(status.lastSynced > 0);
  const writes = h.writes;
  await h.refreshMappedCategory('a');
  assert.equal(h.writes, writes);
});

test('failed scan preserves cached rows and last success, publishes one actionable error', async () => {
  let failed = false;
  const h = harness(async root => { if (failed) throw new Error('Offline folder'); return snapshot(root); });
  assert.equal(typeof h.refreshMappedCategory, 'function');
  h.useFiles.setState({ categories: [category('a')], items: [] });
  await h.refreshMappedCategory('a');
  const items = h.useFiles.getState().items;
  const lastSynced = h.useDirectoryMappingStatuses.getState().statuses.a.lastSynced;
  failed = true;
  await assert.rejects(h.refreshMappedCategory('a'), /Offline/);
  assert.equal(h.useFiles.getState().items, items);
  assert.equal(h.useDirectoryMappingStatuses.getState().statuses.a.lastSynced, lastSynced);
  assert.equal(h.useDirectoryMappingStatuses.getState().statuses.a.error, 'Offline folder');
});

test('same-category refreshes deduplicate, changed roots can run while old request waits and cannot commit stale results', async () => {
  const calls = [];
  const h = harness(root => new Promise(resolve => calls.push({ root, resolve })));
  assert.equal(typeof h.refreshMappedCategory, 'function');
  h.useFiles.setState({ categories: [category('a')], items: [] });
  const old = h.refreshMappedCategory('a');
  const joined = h.refreshMappedCategory('a');
  await tick();
  assert.equal(calls.length, 1);
  h.useFiles.getState().setCategoryMapping('a', 'D:\\New');
  const fresh = h.refreshMappedCategory('a');
  await tick();
  assert.equal(calls.length, 2);
  calls[1].resolve(snapshot('D:\\New', 'new.txt'));
  await fresh;
  calls[0].resolve(snapshot());
  await Promise.all([old, joined]);
  assert.deepEqual(h.useFiles.getState().items.map(x => x.title), ['new.txt']);
  assert.equal(h.useDirectoryMappingStatuses.getState().statuses.a.root, 'D:\\New');
});

test('unmap/remap to the same path invalidates an older in-flight snapshot', async () => {
  const calls = [];
  const h = harness(root => new Promise(resolve => calls.push({ root, resolve })));
  assert.equal(typeof h.refreshMappedCategory, 'function');
  h.useFiles.setState({ categories: [category('a')], items: [] });
  const task = h.refreshMappedCategory('a');
  await tick();
  h.useFiles.getState().setCategoryMapping('a', null);
  h.useFiles.getState().setCategoryMapping('a', 'D:\\Docs');
  calls[0].resolve(snapshot());
  await task;
  assert.equal(h.useFiles.getState().items.length, 0);
});

test('canonical storage echoes and category renames do not multiply or discard an in-flight scan', async () => {
  const calls = [];
  const h = harness(root => new Promise(resolve => calls.push({ root, resolve })));
  h.useFiles.setState({ categories: [category('a')], items: [] });
  const first = h.refreshMappedCategory('a');
  await tick();
  h.useFiles.setState({ categories: h.useFiles.getState().categories.map(c => ({ ...c })) });
  h.useFiles.getState().renameCategory('a', 'Renamed');
  const same = h.refreshMappedCategory('a');
  await tick();
  assert.equal(calls.length, 1);
  calls[0].resolve(snapshot());
  await Promise.all([first, same]);
  assert.equal(h.useFiles.getState().items.length, 1);
});

test('background scans have at most two native calls active; an offline root cannot block every category', async () => {
  const calls = [];
  const h = harness(root => new Promise(resolve => calls.push({ root, resolve })));
  assert.equal(typeof h.refreshMappedCategory, 'function');
  h.useFiles.setState({ categories: [category('a'), category('b', 'D:\\B'), category('c', 'D:\\C')], items: [] });
  const tasks = ['a', 'b', 'c'].map(h.refreshMappedCategory);
  await tick();
  assert.equal(calls.length, 2);
  calls[1].resolve(snapshot('D:\\B'));
  await tick();
  assert.equal(calls.length, 3);
  calls[2].resolve(snapshot('D:\\C'));
  calls[0].resolve(snapshot());
  await Promise.all(tasks);
});

test('runtime waits for hydration, observes new mappings, polls and releases timers/subscriptions', async () => {
  let hydrated = false, hydrate, listener, interval, cleared = false, unsubscribed = false;
  const polls = [];
  let categories = [{ id: 'legacy', dir: 'D:\\Legacy' }, category('a')];
  const calls = [];
  const useFiles = { getState: () => ({ categories }), subscribe: fn => { listener = fn; return () => { unsubscribed = true; }; },
    persist: { hasHydrated: () => hydrated, onFinishHydration: fn => { hydrate = fn; return () => {}; } } };
  // 前台门控本身由 src/lib/visibility.test.mjs 覆盖；这里只验「运行时装了轮询、并能拆干净」，
  // 所以把 startForegroundInterval 换成一个能手动打拍子的替身。
  const runtime = load('./directory-mapping-runtime.tsx', { '@/stores/files': { useFiles }, '@/lib/tauri': { inTauri: true },
    '@/lib/visibility': { startForegroundInterval: (run, ms, options = {}) => { polls.push({ ms, options }); interval = run; return () => { cleared = true; }; } },
    './directory-mapping': { refreshMappedCategory: async id => { calls.push(id); } } });
  assert.equal(typeof runtime.startDirectoryMappingRuntime, 'function');
  const stop = runtime.startDirectoryMappingRuntime();
  assert.equal(polls.length, 1, '启动时应注册一次轮询');
  assert.equal(polls[0].ms, runtime.DIRECTORY_MAPPING_INTERVAL_MS);
  // 唤醒（focus / 变可见）由轮询自己的 catchUp 负责，运行时不再各挂一份监听
  assert.notEqual(polls[0].options.catchUp, false);
  assert.deepEqual(calls, []);
  hydrated = true; hydrate();
  assert.deepEqual(calls, ['a']);
  listener();
  assert.deepEqual(calls, ['a'], 'ordinary item changes do not trigger another scan');
  categories = [...categories, category('b')]; listener();
  assert.deepEqual(calls, ['a', 'b']);
  interval();
  assert.deepEqual(calls, ['a', 'b', 'a', 'b']);
  stop();
  assert.equal(cleared, true); assert.equal(unsubscribed, true);
  interval(); listener();
  assert.equal(calls.length, 4);
});
