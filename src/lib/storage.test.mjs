import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Load the actual adapter with isolated native, event and timer boundaries.
const source = await readFile(new URL("./storage.ts", import.meta.url), "utf8");
let sequence = 0;
const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const state = (count) => ({ state: { count }, version: 1 });
const copy = (value) => value === undefined ? undefined : structuredClone(value);

async function loadStorage({ initial = state(0), read, write } = {}) {
  const key = `__storageTest${++sequence}`;
  const calls = { reads: [], writes: [], emits: [], reports: [], clears: [] };
  const persisted = new Map([["plans", copy(initial)]]);
  const timers = new Map();
  let timerId = 0;
  let listener;
  const origin = `test-view-${sequence}`;
  const dependencies = {
    inTauri: true,
    crypto: { randomUUID: () => origin },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    emit: async (name, payload) => { calls.emits.push({ name, payload: copy(payload) }); },
    listen: async (_name, handler) => { listener = handler; return () => {}; },
    readJson: async (name) => {
      calls.reads.push(name);
      return copy(read ? await read(name, calls.reads.length) : persisted.get(name) ?? null);
    },
    writeJson: async (name, value, baseline) => {
      calls.writes.push({ name, value: copy(value), baseline: copy(baseline) });
      const canonical = write ? await write(name, value, baseline, calls.writes.length) : value;
      persisted.set(name, copy(canonical));
      return copy(canonical);
    },
    useStorageHealth: { getState: () => ({
      report: (problem, name, error) => calls.reports.push({ problem, name, error }),
      clear: (name) => calls.clears.push(name),
    }) },
  };
  globalThis[key] = dependencies;
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText
    .replace(/^import .*;\r?\n/gm, "");
  let api;
  try {
    api = await import(`data:text/javascript;base64,${Buffer.from(`const { emit, listen, readJson, writeJson, inTauri, useStorageHealth, crypto, setTimeout, clearTimeout } = globalThis.${key};\n${code}`).toString("base64")}`);
  } finally { delete globalThis[key]; }
  return {
    ...api,
    storage: api.tauriJsonStorage,
    calls,
    persisted,
    origin,
    remote: async (name = "plans", eventSource = "other-view") => {
      assert.equal(typeof listener, "function", "the native storage listener must be installed");
      await listener({ payload: { key: name, source: eventSource } });
    },
  };
}

test("flush waits for every in-flight write and serializes later edits", async () => {
  const first = deferred();
  const second = deferred();
  let concurrent = 0;
  let maxConcurrent = 0;
  const api = await loadStorage({ write: async (_key, _value, _base, index) => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    try { return await (index === 1 ? first.promise : second.promise); }
    finally { concurrent--; }
  } });
  await api.storage.getItem("plans");
  await api.storage.setItem("plans", JSON.stringify(state(1)));
  let settled = false;
  const flushing = api.flushAllStorage().then(() => { settled = true; });
  await turn();
  assert.equal(api.calls.writes.length, 1);
  assert.equal(settled, false);
  await api.storage.setItem("plans", JSON.stringify(state(2)));
  const alsoFlushing = api.flushAllStorage();
  await turn();
  assert.equal(api.calls.writes.length, 1, "later edits must not overtake the active write");
  first.resolve(state(1));
  await turn();
  assert.equal(api.calls.writes.length, 2);
  assert.equal(settled, false, "flush must also await the edit queued during its first write");
  assert.deepEqual(api.calls.writes[1].baseline, { value: state(1) });
  second.resolve(state(2));
  await Promise.all([flushing, alsoFlushing]);
  assert.equal(settled, true);
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(api.persisted.get("plans"), state(2));
});

for (const [label, next] of [["revert", state(0)], ["null tombstone", null]]) {
  test(`an in-flight ${label} uses the in-flight value as its merge base`, async () => {
    const saving = deferred();
    const api = await loadStorage({ write: (_key, value, _base, index) => index === 1 ? saving.promise : value });
    await api.storage.getItem("plans");
    await api.storage.setItem("plans", JSON.stringify(state(1)));
    const flushing = api.flushAllStorage();
    await turn();
    const removing = next === null ? api.storage.removeItem("plans") : api.storage.setItem("plans", JSON.stringify(next));
    saving.resolve(state(1));
    await Promise.all([flushing, removing]);
    assert.equal(api.calls.writes.length, 2);
    assert.deepEqual(api.calls.writes[0].baseline, { value: state(0) });
    assert.deepEqual(api.calls.writes[1], { name: "plans", value: next, baseline: { value: state(1) } });
    assert.deepEqual(api.persisted.get("plans"), next);
  });
}

for (const [label, next] of [["the failed value", undefined], ["a newer edit", state(2)], ["a newer tombstone", null]]) {
  test(`a failed write retains ${label} and the original base for retry`, async () => {
    const saving = deferred();
    const api = await loadStorage({ write: (_key, value, _base, index) => index === 1 ? saving.promise : value });
    await api.storage.getItem("plans");
    await api.storage.setItem("plans", JSON.stringify(state(1)));
    const failure = assert.rejects(api.flushAllStorage(), /disk full/);
    await turn();
    if (next !== undefined) await api.storage.setItem("plans", JSON.stringify(next));
    saving.reject(new Error("disk full"));
    await failure;
    assert.equal(api.calls.writes.length, 1);
    assert.deepEqual(api.persisted.get("plans"), state(0));
    assert.deepEqual(api.calls.reports[0], { problem: "write", name: "plans", error: "disk full" });
    await api.flushAllStorage();
    const wanted = next === undefined ? state(1) : next;
    assert.deepEqual(api.calls.writes[1], { name: "plans", value: wanted, baseline: { value: state(0) } });
    assert.deepEqual(api.persisted.get("plans"), wanted);
    assert.deepEqual(api.calls.clears, ["plans"]);
  });
}

test("a read failure blocks default-state writes instead of overwriting persisted data", async () => {
  const api = await loadStorage({ initial: state(99), read: async () => { throw new Error("corrupt database"); } });
  assert.equal(await api.storage.getItem("plans"), null);
  await api.storage.setItem("plans", JSON.stringify(state(0)));
  await assert.rejects(api.flushAllStorage(), /暂停写入/);
  await assert.rejects(api.flushAllStorage(), /暂停写入/);
  assert.equal(api.calls.writes.length, 0);
  assert.deepEqual(api.persisted.get("plans"), state(99));
  assert.deepEqual(api.calls.reports[0], { problem: "unavailable", name: "plans", error: "corrupt database" });
});

test("self-source events are ignored but an immediate foreign event is applied", async () => {
  const api = await loadStorage();
  const applied = [];
  api.onStorageSynced((key, value) => applied.push({ key, value }));
  await api.storage.getItem("plans");
  await api.storage.setItem("plans", JSON.stringify(state(1)));
  await api.flushAllStorage();
  assert.deepEqual(api.calls.emits, [{ name: "storage://changed", payload: { key: "plans", source: api.origin } }]);
  const reads = api.calls.reads.length;
  applied.length = 0;
  api.persisted.set("plans", state(2));
  await api.remote("plans", api.origin);
  assert.equal(api.calls.reads.length, reads);
  assert.deepEqual(applied, []);
  await api.remote();
  assert.equal(api.calls.reads.length, reads + 1);
  assert.deepEqual(applied, [{ key: "plans", value: state(2) }]);
});

test("a foreign event waits for an active local write and then reads canonical state", async () => {
  const saving = deferred();
  let freshRead = false;
  const api = await loadStorage({ read: () => freshRead ? state(2) : state(0), write: () => saving.promise });
  const applied = [];
  api.onStorageSynced((_key, value) => applied.push(value));
  await api.storage.getItem("plans");
  await api.storage.setItem("plans", JSON.stringify(state(1)));
  const flushing = api.flushAllStorage();
  await turn();
  const received = api.remote();
  await turn();
  assert.equal(api.calls.reads.length, 1);
  freshRead = true;
  saving.resolve(state(1));
  await Promise.all([flushing, received]);
  assert.deepEqual(applied.at(-1), state(2));
  assert.equal(api.calls.reads.length, 2);
});

test("remote setState-triggered setItem does not echo a write or storage event", async () => {
  const api = await loadStorage();
  const applied = [];
  api.onStorageSynced((key, value) => {
    applied.push(value);
    // Zustand persist invokes setItem synchronously from setState during rehydration.
    void api.storage.setItem(key, JSON.stringify(value));
  });
  api.persisted.set("plans", state(7));
  await api.remote();
  await api.flushAllStorage();
  assert.deepEqual(applied, [state(7)]);
  assert.deepEqual(api.calls.writes, []);
  assert.deepEqual(api.calls.emits, []);
  await api.storage.setItem("plans", JSON.stringify(state(8)));
  await api.flushAllStorage();
  assert.deepEqual(api.calls.writes, [{ name: "plans", value: state(8), baseline: { value: state(7) } }]);
  assert.equal(api.calls.emits.length, 1);
});

test("a canonical null returned by native merge is preserved as a tombstone", async () => {
  const api = await loadStorage({ write: () => null });
  const applied = [];
  api.onStorageSynced((_key, value) => applied.push(value));
  await api.storage.getItem("plans");
  // A stale window performs a no-op write after another window deleted the key.
  await api.storage.setItem("plans", JSON.stringify(state(0)));
  await api.flushAllStorage();
  assert.equal(api.persisted.get("plans"), null);
  assert.deepEqual(applied, [null], "the native tombstone must not be replaced by the stale local value");
  await api.storage.setItem("plans", JSON.stringify(state(2)));
  await api.flushAllStorage();
  assert.deepEqual(api.calls.writes[1].baseline, { value: null });
});

test("overlapping remote reads cannot apply an older snapshot after a newer snapshot", async () => {
  const older = deferred();
  const newer = deferred();
  const api = await loadStorage({ read: (_key, index) => index === 1 ? state(0) : index === 2 ? older.promise : newer.promise });
  const applied = [];
  api.onStorageSynced((_key, value) => applied.push(value));
  await api.storage.getItem("plans");
  const firstEvent = api.remote();
  await turn();
  const secondEvent = api.remote();
  await turn();
  newer.resolve(state(2));
  await secondEvent;
  older.resolve(state(1));
  await firstEvent;
  assert.deepEqual(applied.at(-1), state(2), "the stale read must not roll back the newer remote state");
});

test("a remote read started before a local commit cannot undo that commit", async () => {
  const stale = deferred();
  const api = await loadStorage({ read: (_key, index) => index === 1 ? state(0) : stale.promise });
  const applied = [];
  api.onStorageSynced((_key, value) => applied.push(value));
  await api.storage.getItem("plans");
  const reading = api.remote(); await turn();
  await api.storage.setItem("plans", JSON.stringify(state(2)));
  await api.flushAllStorage();
  stale.resolve(state(1)); await reading;
  assert.deepEqual(applied.at(-1), state(2));
});
