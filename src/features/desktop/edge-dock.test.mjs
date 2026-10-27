import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);
const area = { id: 'primary', x: 0, y: 0, w: 1280, h: 800, scale: 1 };
const owner = 'fence-a';
const normal = { x: 200, y: 180, w: 320, h: 400 };

// Mutation runs change only an in-memory AST. The same behavioral tests must
// fail when the independent storage effect is removed, without touching files.
function removeStorageEffect(source) {
  let removed = 0;
  const file = ts.createSourceFile('edge-dock.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callsStorage = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'onStorageSynced') return true;
    return ts.forEachChild(node, callsStorage) === true;
  };
  const transformed = ts.transform(file, [context => root => {
    const visit = node => {
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'useEffect'
        && callsStorage(node.expression)) { removed++; return undefined; }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit);
  }]);
  try {
    assert.equal(removed, 1, 'mutation must remove exactly the hook storage effect');
    return ts.createPrinter().printFile(transformed.transformed[0]);
  } finally { transformed.dispose(); }
}

function load(file, dependencies = {}, globals = {}) {
  let source = readFileSync(new URL(file, import.meta.url), 'utf8');
  if (file === './edge-dock.tsx' && process.env.EDGE_DOCK_TEST_REMOVE_STORAGE_LISTENER === '1') source = removeStorageEffect(source);
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), code)(name => dependencies[name] ?? nativeRequire(name), module, module.exports, ...Object.values(globals));
  return module.exports;
}

async function fixture({ collapsed = true, active = true } = {}) {
  const storageListeners = new Set(), effects = [], trace = [], errors = [];
  const storage = {
    tauriJsonStorage: { getItem: () => null, setItem: () => {} },
    onStorageSynced: callback => { storageListeners.add(callback); return () => storageListeners.delete(callback); },
  };
  const core = load('./queue-core.ts');
  const edgeCore = load('./edge-core.ts');
  const { useEdgeWorkspace: store } = load('./edge-workspace.ts', { '@/lib/storage': storage });
  const key = core.groupKey(area.id, 'right');
  const initialGroup = { monitorId: area.id, edge: 'right', order: [owner, 'fence-b'], offset: 48, collapsed };
  store.setState({ groups: { [key]: initialGroup } });
  const entries = [owner, 'fence-b'].map(id => ({ id, form: 'capsule', edge: 'right', edgeMonitor: area.id, normal: { ...normal } }));
  const registry = {
    desktopEntries: () => entries, useDesktopEntries: () => entries,
    saveDockPosition: (id, patch) => Object.assign(entries.find(entry => entry.id === id), patch),
    setDesktopForm: (id, form) => { entries.find(entry => entry.id === id).form = form; },
  };
  // Call the actual Zustand store imperatively while suppressing its React
  // subscription, matching a hidden view whose state updates cannot repaint.
  const workspace = Object.assign(selector => selector(store.getState()), store);
  const queue = load('./queue-registry.ts', { './registry': registry, './edge-workspace': { useEdgeWorkspace: workspace }, './queue-core': core });
  let visible = false, desktopVisible = true;
  const win = { label: owner };
  for (const method of ['setIgnoreCursorEvents', 'setResizable', 'setAlwaysOnBottom', 'setAlwaysOnTop', 'setSize', 'setPosition', 'setFocus']) {
    win[method] = async value => { trace.push({ method, value }); };
  }
  win.show = async () => { visible = true; trace.push({ method: 'show' }); };
  win.hide = async () => { visible = false; trace.push({ method: 'hide' }); };
  const listeners = new Map();
  const react = {
    useRef: value => ({ current: value }),
    useState: initial => {
      let value = typeof initial === 'function' ? initial() : initial;
      return [value, next => { value = typeof next === 'function' ? next(value) : next; }];
    },
    useCallback: fn => fn,
    useEffect: fn => effects.push(fn),
  };
  const { useEdgeDock } = load('./edge-dock.tsx', {
    react, 'lucide-react': {},
    '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => win },
    '@tauri-apps/api/core': { invoke: async () => true },
    '@tauri-apps/api/window': { currentMonitor: async () => area },
    '@tauri-apps/api/event': { emit: async () => {}, listen: async (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); } },
    '@tauri-apps/api/dpi': {
      PhysicalPosition: class { constructor(x, y) { this.x = x; this.y = y; } },
      PhysicalSize: class { constructor(width, height) { this.width = width; this.height = height; } },
    },
    './edge-core': edgeCore, '@/lib/tauri': { inTauri: true }, '@/lib/storage': storage,
    './sticky-presentation': load('./sticky-presentation.ts'), './sticky-settings': { StickySettings: () => null },
    './registry': registry, './edge-workspace': { useEdgeWorkspace: workspace },
    './monitors': { readMonitors: async () => [area], monitorArea: value => value, resolveMonitor: async () => area },
    './queue-core': core, './queue-registry': queue,
    './visibility': { isDesktopVisible: () => desktopVisible, setDesktopVisibility: (_label, value) => { desktopVisible = value; } },
  }, { document: { activeElement: null }, HTMLElement: class {} });
  let undocked = 0;
  const dock = useEdgeDock({ active, edge: 'right', edgeY: 999, pinned: false, normal: () => normal,
    onAppearanceChange: patch => { entries[0].appearance = { ...entries[0].appearance, ...patch }; },
    onEdgeChange: () => {}, onEdgeYChange: () => {}, onUndock: () => undocked++, onError: error => errors.push(error) });
  const cleanups = effects.map(effect => effect());
  const settle = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await edgeCore.queueWindowOperation(owner, async () => {});
    assert.deepEqual(errors, []);
  };
  const sync = (partial, eventKey = 'edge-workspace') => {
    const value = { version: 1, state: { groups: { ...store.getState().groups, [key]: { ...store.getState().groups[key], ...partial } } } };
    for (const callback of storageListeners) callback(eventKey, value);
  };
  await settle();
  return { dock, trace, sync, settle, store, entries, key,
    get visible() { return visible; }, get undocked() { return undocked; },
    dispose: async () => { for (const cleanup of cleanups) cleanup?.(); await settle(); },
  };
}

test('a hidden dock wakes from remote queue expansion without a React rerender and uses the latest slot', async () => {
  const h = await fixture();
  try {
    assert.equal(h.visible, false, 'the collapsed queue initially hides its member window');
    assert.equal(h.dock.ready, false, 'the rendered closure deliberately never receives the ready state update');
    h.trace.length = 0;
    h.sync({ collapsed: false, order: ['fence-b', owner], offset: 120 });
    await h.settle();
    assert.equal(h.visible, true, 'the independent storage listener must call native.show before React can repaint');
    const position = h.trace.findLast(call => call.method === 'setPosition').value;
    const size = h.trace.findLast(call => call.method === 'setSize').value;
    assert.deepEqual({ x: position.x, y: position.y }, { x: 1168, y: 212 });
    assert.deepEqual({ width: size.width, height: size.height }, { width: 112, height: 44 });
    assert.equal(h.trace.some(call => call.method === 'setFocus'), false, 'queue expansion must not steal focus');
    assert.equal(h.undocked, 0);
    assert.deepEqual(h.entries[0].normal, normal, 'queue synchronization cannot overwrite ordinary geometry');
  } finally { await h.dispose(); }
});

test('the same storage listener can fold and wake the hidden member repeatedly using new queue offsets', async () => {
  const h = await fixture({ collapsed: false });
  try {
    assert.equal(h.visible, true);
    h.sync({ collapsed: true }); await h.settle();
    assert.equal(h.visible, false, 'remote folding must hide members without waiting for React effects');
    h.sync({ collapsed: false, offset: 200 }); await h.settle();
    assert.equal(h.visible, true);
    assert.equal(h.trace.findLast(call => call.method === 'setPosition').value.y, 244);
    h.sync({ collapsed: true }); await h.settle();
    assert.equal(h.visible, false);
    h.sync({ collapsed: false, offset: 300 }); await h.settle();
    assert.equal(h.visible, true);
    assert.equal(h.trace.findLast(call => call.method === 'setPosition').value.y, 344);
  } finally { await h.dispose(); }
});

test('hidden native placement reads changed sticky dimensions directly from the registry without a render', async () => {
  const h = await fixture();
  try {
    h.entries[0].appearance = { tabWidth: 200 };
    h.sync({ collapsed: false }); await h.settle();
    const size = h.trace.findLast(call => call.method === 'setSize').value;
    assert.equal(size.width, 200);
  } finally { await h.dispose(); }
});

test('changing appearance cannot indirectly reposition a locked queue neighbor', async () => {
  const h = await fixture();
  try {
    h.entries[1].locked = true;
    h.dock.changeAppearance({ tabHeight: 100, tabWidth: 200, previewHeight: 500, stickyColor: '#f0d070' });
    assert.deepEqual(h.entries[0].appearance, { tabWidth: 200, previewHeight: 500, stickyColor: '#f0d070' });
  } finally { await h.dispose(); }
});

test('unrelated storage and unmounted or inactive docks cannot issue native writes', async () => {
  const h = await fixture();
  h.trace.length = 0;
  h.sync({ collapsed: false }, 'settings'); await h.settle();
  assert.deepEqual(h.trace, []);
  await h.dispose();
  h.sync({ collapsed: false }); await h.settle();
  assert.deepEqual(h.trace, [], 'unmount must remove the direct storage subscription');
  assert.equal(h.store.getState().groups[h.key].collapsed, false, 'the workspace store still receives remote snapshots after owner unmount');
  const inactive = await fixture({ active: false });
  try {
    inactive.sync({ collapsed: false }); await inactive.settle();
    assert.deepEqual(inactive.trace, []);
  } finally { await inactive.dispose(); }
});
