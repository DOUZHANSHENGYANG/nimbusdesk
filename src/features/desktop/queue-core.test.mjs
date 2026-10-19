import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);
function load(file, dependencies = {}) {
  const path = new URL(file, import.meta.url);
  if (!existsSync(path)) return {};
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => dependencies[name] ?? nativeRequire(name), module, module.exports);
  return module.exports;
}
function core() {
  const api = load('./queue-core.ts');
  assert.equal(typeof api.planQueue, 'function', 'bounded queue planner must exist');
  return api;
}
const area = { id: 'primary', x: 0, y: 0, w: 1366, h: 768, scale: 1 };
const group = (extra = {}) => ({ monitorId: 'primary', edge: 'right', order: [], offset: 48, collapsed: false, ...extra });
const members = count => Array.from({ length: count }, (_, i) => ({ id: `paper-${String(i).padStart(2, '0')}`, edge: 'right', edgeMonitor: 'primary' }));
function assertBounded(plan, height) {
  const visible = [{ y: plan.hubY, h: plan.hubH }, ...plan.slots.filter(slot => slot.visible)].sort((a, b) => a.y - b.y);
  for (const slot of visible) { assert.ok(slot.y >= 0); assert.ok(slot.y + slot.h <= height + 1e-8); }
  for (let i = 1; i < visible.length; i++) assert.ok(visible[i].y >= visible[i - 1].y + visible[i - 1].h + 4 - 1e-8);
}

test('independent offsets survive free moves without snapping all tabs into a compact queue',()=>{
 const plan=core().planQueue(area,group(),[{id:'a',dockOffset:180},{id:'b',dockOffset:530}]);
 assert.equal(plan.slots.find(s=>s.id==='a').y,180);
 assert.equal(plan.slots.find(s=>s.id==='b').y,530);
 assertBounded(plan,768);
});
test('colliding moved tabs avoid locked individual anchors and keep the hub reachable',()=>{
 const plan=core().planQueue(area,group({order:['moving','locked']}),[{id:'moving',dockOffset:320},{id:'locked',dockOffset:320,locked:true}]);
 assert.equal(plan.slots.find(s=>s.id==='locked').y,320);
 assert.notEqual(plan.slots.find(s=>s.id==='moving').y,320);
 assertBounded(plan,768);
});
test('top queue uses horizontal logical positions, custom widths and a bounded hub',()=>{
 const top={...area,w:1800,h:900,scale:1.5};
 const plan=core().planQueue(top,group({edge:'top'}),[{id:'a',edge:'top',dockOffset:150,tabWidth:180},{id:'b',edge:'top',dockOffset:800,tabWidth:200}]);
 assert.equal(plan.hubH,44);
 assert.deepEqual(plan.slots.map(s=>[s.y,s.h]),[[150,180],[800,200]]);
 assertBounded(plan,1200);
 const overflow=core().planQueue({...top,w:300},group({edge:'top'}),Array.from({length:20},(_,i)=>({id:`top-${i}`,edge:'top',dockOffset:i*10,tabWidth:180})));
 assert.ok(overflow.overflow.length>0);assertBounded(overflow,200);
});
test('locked anchors take precedence over the hub and survive high-DPI monitor coordinates',()=>{
 const plan=core().planQueue({...area,x:-2560,y:-200,h:1152,scale:1.5},group(),[{id:'locked',dockOffset:48,locked:true},{id:'bottom',dockOffset:700}]);
 assert.equal(plan.slots.find(s=>s.id==='locked').y,48);
 assert.equal(plan.slots.find(s=>s.id==='bottom').y,700);
 assert.notEqual(plan.hubY,48);assertBounded(plan,768);
});
test('anchored overflow remains complete, bounded and deterministic for crowded and tiny work areas',()=>{
 const {planQueue}=core();
 for(const edge of ['left','right','top'])for(const extent of [0,24,150,220,768]){
  const input=Array.from({length:25},(_,i)=>({id:`${i}`,edge,dockOffset:(i*113)%900-40,locked:i%4===0,tabHeight:40+i*3,tabWidth:96+i*7}));
  const monitor={...area,w:extent*1.5,h:extent*1.5,scale:1.5},prefs=group({edge});
  const before=structuredClone(input),plan=planQueue(monitor,prefs,input);
  assertBounded(plan,extent);
  const represented=[...plan.slots.filter(s=>s.visible).map(s=>s.id),...plan.overflow];
  assert.equal(new Set(represented).size,input.length);assert.equal(represented.length,input.length);
  assert.deepEqual(plan,planQueue(monitor,prefs,input));assert.deepEqual(input,before);
 }
});
test('collapsed anchored groups keep all entries accessible and clamp invalid offsets safely',()=>{
 const {planQueue}=core(),input=[{id:'a',dockOffset:600},{id:'b',dockOffset:NaN}];
 const collapsed=planQueue(area,group({collapsed:true}),input);
 assert.deepEqual(collapsed.overflow,collapsed.order);assertBounded(collapsed,768);
 const invalid=planQueue(area,group(),[{id:'a',dockOffset:NaN},{id:'b',dockOffset:Infinity}]);
 assert.deepEqual(invalid.slots.map(s=>s.y),[92,140]);
});

test('group keys are stable hex and distinguish side, Unicode and delimiter-like monitor IDs', () => {
  const { groupKey } = core();
  const keys = ['显示器/1', 'primary', 'primary:right', ''].flatMap(id => ['left', 'right'].map(edge => groupKey(id, edge)));
  assert.ok(keys.every(key => /^[0-9a-f]+$/.test(key)));
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(groupKey('显示器/1', 'left'), groupKey('显示器/1', 'left'));
});

test('monitor lookup uses physical negative coordinates independently of monitor DPI', () => {
  const { monitorAt } = core();
  const secondary = { id: 'secondary', x: -2560, y: -200, w: 2560, h: 1440, scale: 1.5 };
  assert.equal(monitorAt({ x: -1200, y: 50 }, [area, secondary]), secondary);
  assert.equal(monitorAt({ x: 50, y: 50 }, [secondary, area]), area);
  assert.equal(monitorAt({ x: 0, y: 50 }, [secondary, area]), area);
});

test('monitor lookup chooses nearest work area in gaps and handles an empty inventory', () => {
  const { monitorAt } = core();
  const far = { ...area, id: 'far', x: 1600 };
  assert.equal(monitorAt({ x: 1500, y: 20 }, [area, far]), far);
  assert.equal(monitorAt({ x: -10000, y: 20 }, [area, far]), area);
  assert.equal(monitorAt({ x: 0, y: 0 }, []), null);
});

test('12 tabs shrink to fit 768px with a reachable hub and no overlaps', () => {
  const plan = core().planQueue(area, group(), members(12));
  assert.equal(plan.slots.filter(slot => slot.visible).length, 12);
  assert.equal(plan.overflow.length, 0);
  assert.equal(plan.hubY, 48);
  assert.ok(plan.slots.every(slot => slot.h >= 40 && slot.h <= 44));
  assertBounded(plan, 768);
});

test('40 tabs expose every hidden entry in overflow instead of stacking bottom tabs', () => {
  const input = members(40), plan = core().planQueue(area, group(), input);
  const visible = plan.slots.filter(slot => slot.visible);
  assert.ok(plan.overflow.length > 0);
  assert.equal(new Set(visible.map(slot => slot.y)).size, visible.length);
  assert.deepEqual([...visible.map(slot => slot.id), ...plan.overflow], plan.order);
  assert.equal(new Set([...visible.map(slot => slot.id), ...plan.overflow]).size, input.length);
  assertBounded(plan, 768);
});

test('mixed DPI planning returns logical positions relative to work area top', () => {
  const plan = core().planQueue({ ...area, x: -2560, y: -300, h: 1152, scale: 1.5 }, group(), members(12));
  assert.equal(plan.hubY, 48);
  assert.equal(plan.slots.filter(slot => slot.visible).length, 12);
  assertBounded(plan, 768);
});

test('saved order wins and missing members sort by previous position then stable ID', () => {
  const input = [{ id: 'd', edgeY: 90 }, { id: 'c', edgeY: 50 }, { id: 'b', edgeY: 50 }, { id: 'a' }];
  const plan = core().planQueue(area, group({ order: ['d', 'stale', 'd'] }), input);
  assert.deepEqual(plan.order, ['d', 'b', 'c', 'a']);
});

test('planner excludes members explicitly assigned to another side or monitor and deduplicates IDs', () => {
  const input = [...members(2), members(2)[0], { id: 'left', edge: 'left' }, { id: 'remote', edgeMonitor: 'remote' }];
  assert.deepEqual(core().planQueue(area, group(), input).order, ['paper-00', 'paper-01']);
});

test('collapsed groups preserve full order and overflow access while only the hub remains visible', () => {
  const plan = core().planQueue(area, group({ collapsed: true, order: ['paper-02'] }), members(3));
  assert.deepEqual(plan.order, ['paper-02', 'paper-00', 'paper-01']);
  assert.deepEqual(plan.overflow, plan.order);
  assert.ok(plan.slots.every(slot => !slot.visible));
  assertBounded(plan, 768);
});

test('offset survives when possible and clamps at both bounds after work area changes', () => {
  const { planQueue } = core();
  assert.equal(planQueue(area, group({ offset: -80 }), members(1)).hubY, 0);
  assert.equal(planQueue(area, group({ offset: 300 }), members(1)).hubY, 300);
  const plan = planQueue({ ...area, h: 200 }, group({ offset: 9999 }), members(3));
  assert.ok(plan.hubY < 200);
  assertBounded(plan, 200);
});

test('individual sticky heights persist without overlap and compress safely on a small screen', () => {
 const input=[{id:'a',tabHeight:90},{id:'b',tabHeight:60},{id:'c'}];
 const plan=core().planQueue(area,group({order:['a','b','c']}),input);
 assert.deepEqual(plan.slots.map(s=>s.h),[90,60,44]);assertBounded(plan,768);
 const small=core().planQueue({...area,h:200},group({order:['a','b','c']}),input);
 assert.equal(small.slots.filter(s=>s.visible).length,3);assertBounded(small,200);
 assert.ok(small.slots.every(s=>s.h>=40));
 const invalid=core().planQueue(area,group(),[{id:'bad',tabHeight:NaN}]);
 assert.equal(invalid.slots[0].h,44);
});

test('tiny work areas keep the hub bounded and expose all tabs as overflow', () => {
  const plan = core().planQueue({ ...area, h: 24 }, group(), members(2));
  assert.deepEqual(plan.overflow, plan.order);
  assertBounded(plan, 24);
});

test('insertion removes old occurrences, clamps index and returns a unique list without mutating input', () => {
  const { insertionOrder } = core();
  const original = ['a', 'b', 'a', 'c'];
  assert.deepEqual(insertionOrder(original, 'a', 2), ['b', 'c', 'a']);
  assert.deepEqual(insertionOrder(original, 'd', -8), ['d', 'a', 'b', 'c']);
  assert.deepEqual(insertionOrder(original, 'd', 99), ['a', 'b', 'c', 'd']);
  assert.deepEqual(original, ['a', 'b', 'a', 'c']);
});

function workspace(snapshot = null) {
  let listener, applying = false;
  const writes = [];
  const storage = {
    getItem: () => snapshot === null ? null : JSON.stringify(snapshot),
    setItem: (key, value) => { if (!applying) writes.push({ key, value: JSON.parse(value) }); },
    removeItem: () => {},
  };
  const api = load('./edge-workspace.ts', { '@/lib/storage': { tauriJsonStorage: storage, onStorageSynced: callback => { listener = callback; return () => {}; } } });
  assert.ok(api.useEdgeWorkspace, 'persisted edge workspace must exist');
  return { store: api.useEdgeWorkspace, writes, remote: (key, value) => { applying = true; try { listener(key, value); } finally { applying = false; } } };
}

test('workspace seeds unknown groups and persists only queue preferences under version 1', () => {
  const { store, writes } = workspace();
  store.getState().updateGroup('first', { offset: 72 });
  assert.deepEqual(store.getState().groups.first, { monitorId: '', edge: 'right', order: [], offset: 72, collapsed: false });
  store.getState().setCollapsed('first', true);
  store.getState().setOffset('first', -50);
  assert.equal(store.getState().groups.first.collapsed, true);
  assert.equal(store.getState().groups.first.offset, 0);
  assert.equal(writes.at(-1).key, 'edge-workspace');
  assert.equal(writes.at(-1).value.version, 1);
  assert.deepEqual(Object.keys(writes.at(-1).value.state), ['groups']);
});

test('cross-group move removes old membership and inserts into target in one atomic update', () => {
  const { store } = workspace();
  store.getState().updateGroup('source', group({ order: ['a', 'move', 'b'] }));
  store.getState().updateGroup('other', group({ order: ['move', 'c'] }));
  const observed = [];
  const stop = store.subscribe(state => observed.push(state.groups));
  store.getState().moveMember('move', 'target', 1, group({ edge: 'left', monitorId: 'secondary', order: ['x', 'y'] }));
  stop();
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0].source.order, ['a', 'b']);
  assert.deepEqual(observed[0].other.order, ['c']);
  assert.deepEqual(observed[0].target.order, ['x', 'move', 'y']);
  assert.equal(observed[0].target.monitorId, 'secondary');
});

test('same-group moves reorder once and retain existing target preferences over the seed', () => {
  const { store } = workspace();
  store.getState().updateGroup('target', group({ order: ['a', 'b', 'c'], offset: 90 }));
  store.getState().moveMember('a', 'target', 2, group({ offset: 0 }));
  assert.deepEqual(store.getState().groups.target.order, ['b', 'c', 'a']);
  assert.equal(store.getState().groups.target.offset, 90);
});

test('remote workspace snapshots replace groups safely without echo and preserve store actions', () => {
  const { store, remote, writes } = workspace();
  store.getState().updateGroup('old', group());
  const before = writes.length;
  remote('edge-workspace', { state: { groups: { remote: group({ order: ['a', 'a', 'b'], offset: -5 }), invalid: null }, updateGroup: null }, version: 1 });
  assert.deepEqual(Object.keys(store.getState().groups), ['remote']);
  assert.deepEqual(store.getState().groups.remote.order, ['a', 'b']);
  assert.equal(store.getState().groups.remote.offset, 0);
  assert.equal(typeof store.getState().updateGroup, 'function');
  assert.equal(writes.length, before);
  remote('unrelated', { state: { groups: {} } });
  remote('edge-workspace', { state: { groups: [] } });
  assert.deepEqual(Object.keys(store.getState().groups), ['remote']);
});

test('persisted hydration validates queue records and never hydrates action-shaped properties', () => {
  const { store } = workspace({ state: { groups: { good: group({ order: ['a', 42, 'a'] }), bad: { edge: 'bottom' } }, setOffset: null }, version: 1 });
  assert.deepEqual(Object.keys(store.getState().groups), ['good']);
  assert.deepEqual(store.getState().groups.good.order, ['a']);
  assert.equal(typeof store.getState().setOffset, 'function');
});
