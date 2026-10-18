import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

let sequence = 0;
async function harness(initial = {}, register) {
  const states = [], refs = [], effects = [];
  let stateIndex, refIndex, effectIndex, handler, result, unmounted = false;
  let updatesAfterUnmount = 0, unsubscribed = 0, subscriptions = 0;
  let options = { enabled: true, onDrop: async () => {}, onError: () => {}, ...initial };
  const deps = {
    inTauri: initial.inTauri ?? true,
    getCurrentWebviewWindow: () => ({ onDragDropEvent: fn => {
      subscriptions++; handler = fn;
      return register ? register(() => { unsubscribed++; }) : Promise.resolve(() => { unsubscribed++; });
    } }),
    useState: value => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = value;
      return [states[index], next => { if (unmounted) updatesAfterUnmount++; states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    },
    useRef: value => refs[refIndex++] ??= { current: value },
    useEffect: (fn, dependencies) => {
      const index = effectIndex++, prior = effects[index];
      if (!prior || dependencies.some((value, i) => value !== prior.dependencies[i])) effects[index] = { fn, dependencies, cleanup: prior?.cleanup, pending: true };
    },
  };
  const key = `__fileDrop${sequence++}`;
  const code = ts.transpileModule(await readFile(new URL('./use-file-drop.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/^import[\s\S]*?;\s*/gm, '');
  globalThis[key] = deps;
  const module = await import(`data:text/javascript;base64,${Buffer.from(`const {${Object.keys(deps).join(',')}}=globalThis.${key};\n${code}`).toString('base64')}`);
  delete globalThis[key];
  const render = patch => {
    options = { ...options, ...patch }; stateIndex = 0; refIndex = 0; effectIndex = 0;
    result = module.useFileDrop(options);
    for (const effect of effects) if (effect?.pending) { effect.cleanup?.(); effect.cleanup = effect.fn(); effect.pending = false; }
    return result;
  };
  render();
  return { render, emit: payload => handler?.({ payload }), get value() { return result; }, get subscriptions() { return subscriptions; },
    get unsubscribed() { return unsubscribed; }, get updatesAfterUnmount() { return updatesAfterUnmount; },
    unmount: () => { unmounted = true; for (const effect of effects) effect.cleanup?.(); } };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('native enter/over/leave drive feedback and a real drop forwards every absolute path', async () => {
  const received = [];
  const h = await harness({ onDrop: async paths => { received.push(paths); } });
  h.emit({ type: 'enter', paths: ['D:\\x'] });
  assert.equal(h.render().dragging, true);
  h.emit({ type: 'leave' });
  assert.equal(h.render().dragging, false);
  h.emit({ type: 'over' });
  assert.equal(h.render().dragging, true);
  h.emit({ type: 'drop', paths: ['D:\\x', 'D:\\folder'] });
  await tick();
  assert.deepEqual(received, [['D:\\x', 'D:\\folder']]);
  assert.deepEqual(h.render(), { dragging: false, busy: false });
  h.unmount(); await tick(); assert.equal(h.unsubscribed, 1);
});

test('disabled dialogs ignore native drops and clear feedback without resubscribing', async () => {
  const received = [];
  const h = await harness({ onDrop: async paths => { received.push(paths); } });
  h.emit({ type: 'enter' }); h.render({ enabled: false });
  h.emit({ type: 'drop', paths: ['D:\\blocked'] });
  await tick();
  assert.deepEqual(h.render(), { dragging: false, busy: false });
  assert.deepEqual(received, []);
  assert.equal(h.subscriptions, 1);
  h.render({ enabled: true }); h.emit({ type: 'drop', paths: ['D:\\accepted'] });
  await tick(); assert.deepEqual(received, [['D:\\accepted']]);
});

test('already accepted drops survive disable/unmount; busy tracks all accepted work and no post-unmount state updates occur', async () => {
  const pending = [], received = [];
  const h = await harness({ onDrop: paths => new Promise(resolve => { received.push(paths); pending.push(resolve); }) });
  h.emit({ type: 'drop', paths: ['D:\\one'] });
  h.emit({ type: 'drop', paths: ['D:\\two'] });
  assert.equal(h.render().busy, true);
  pending[0](); await tick(); assert.equal(h.render().busy, true);
  h.render({ enabled: false }); h.unmount();
  pending[1](); await tick();
  assert.deepEqual(received, [['D:\\one'], ['D:\\two']]);
  assert.equal(h.updatesAfterUnmount, 0);
  h.emit({ type: 'drop', paths: ['D:\\late'] });
  assert.equal(received.length, 2);
});

test('a listener that resolves after unmount is immediately removed', async () => {
  let complete;
  const h = await harness({}, stop => new Promise(resolve => { complete = () => resolve(stop); }));
  h.unmount(); complete(); await tick();
  assert.equal(h.unsubscribed, 1);
});

test('drop and listener failures are surfaced, and browser-only pages never register native listeners', async () => {
  const errors = [];
  const h = await harness({ onDrop: async () => { throw new Error('disk'); }, onError: error => errors.push(error.message) });
  h.emit({ type: 'drop', paths: ['D:\\x'] }); await tick();
  assert.deepEqual(errors, ['disk']); assert.equal(h.render().busy, false);
  await harness({ onError: error => errors.push(error.message) }, () => Promise.reject(new Error('listener')));
  await tick(); assert.deepEqual(errors, ['disk', 'listener']);
  const browser = await harness({ inTauri: false });
  assert.equal(browser.subscriptions, 0);
  assert.deepEqual(browser.render(), { dragging: false, busy: false });
});
