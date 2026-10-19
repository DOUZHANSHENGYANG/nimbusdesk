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

async function loadStorage({ initial = state(0), initialArchive = state(10), read, write, pair } = {}) {
  const key = `__storageTest${++sequence}`;
  const calls = { reads: [], writes: [], pairs: [], emits: [], reports: [], clears: [] };
  const persisted = new Map([["plans", copy(initial)], ["plans-archive", copy(initialArchive)]]);
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
    writePlanPair: async (plans, archive, basePlans, baseArchive) => {
      const entry = { plans: copy(plans), archive: copy(archive), basePlans: copy(basePlans), baseArchive: copy(baseArchive) };
      calls.pairs.push(entry);
      const canonical = pair ? await pair(entry, calls.pairs.length) : { plans, archive };
      // A native transaction publishes both values only after it succeeds.
      persisted.set("plans", copy(canonical.plans));
      persisted.set("plans-archive", copy(canonical.archive));
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
    api = await import(`data:text/javascript;base64,${Buffer.from(`const { emit, listen, readJson, writeJson, writePlanPair, inTauri, useStorageHealth, crypto, setTimeout, clearTimeout } = globalThis.${key};\n${code}`).toString("base64")}`);
  } finally { delete globalThis[key]; }
  return {
    ...api,
    storage: api.tauriJsonStorage,
    calls,
    persisted,
    origin,
    fireTimers: async () => { for (const callback of [...timers.values()]) callback(); await turn(); },
    remote: async (name = "plans", eventSource = "other-view") => {
      assert.equal(typeof listener, "function", "the native storage listener must be installed");
      await listener({ payload: { key: name, source: eventSource } });
    },
  };
}

test("externally committed batch updates baselines without echo writes and preserves queued edits", async () => {
  const api = await loadStorage(), received = [];
  await api.storage.getItem("plans");
  api.onStorageSynced((key, value) => { received.push([key,value]); void api.storage.setItem(key,JSON.stringify(value)); });
  await api.acceptCommittedStorage({ plans: state(4), projects: state(5) });
  assert.deepEqual(received, [["plans",state(4)],["projects",state(5)]]);
  await api.flushAllStorage();assert.equal(api.calls.writes.length,0);
  await api.storage.setItem("plans",JSON.stringify(state(6)));
  await api.acceptCommittedStorage({ plans: state(7) });
  assert.equal(received.length,2,"queued local edits must not be visually overwritten");
  await api.flushAllStorage();assert.deepEqual(api.calls.writes[0].baseline.value,state(4));
});

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


async function hydratePlanPair(api) {
  await Promise.all([api.storage.getItem("plans"), api.storage.getItem("plans-archive")]);
}
async function enqueuePlanPair(api, plans, archive) {
  await api.storage.setItem("plans", JSON.stringify(plans));
  await api.storage.setItem("plans-archive", JSON.stringify(archive));
}

test("queued plan and archive edits commit together exactly once", async () => {
  const api = await loadStorage();
  await hydratePlanPair(api);
  await enqueuePlanPair(api, state(1), state(11));
  await api.flushAllStorage();
  assert.deepEqual(api.calls.pairs, [{ plans: state(1), archive: state(11), basePlans: state(0), baseArchive: state(10) }]);
  assert.deepEqual(api.calls.writes, []);
  assert.deepEqual(api.persisted.get("plans"), state(1));
  assert.deepEqual(api.persisted.get("plans-archive"), state(11));
  assert.deepEqual(api.calls.emits.map(event => event.payload.key), ["plans", "plans-archive"]);
});

for (const newer of [false, true]) {
  test(`failed plan pair retains both ${newer ? "newer edits" : "original edits"} and their original merge bases`, async () => {
    const saving = deferred();
    const api = await loadStorage({ pair: (entry, index) => index === 1 ? saving.promise : entry });
    await hydratePlanPair(api);
    await enqueuePlanPair(api, state(1), state(11));
    const failure = assert.rejects(api.flushAllStorage(), /pair disk full/);
    await turn();
    if (newer) await enqueuePlanPair(api, state(2), state(12));
    saving.reject(new Error("pair disk full"));
    await failure;
    assert.deepEqual(api.persisted.get("plans"), state(0));
    assert.deepEqual(api.persisted.get("plans-archive"), state(10));
    assert.deepEqual(api.calls.reports.map(({name}) => name), ["plans", "plans-archive"]);
    assert.equal(api.calls.emits.length, 0);
    await api.flushAllStorage();
    assert.deepEqual(api.calls.pairs[1], { plans: state(newer ? 2 : 1), archive: state(newer ? 12 : 11), basePlans: state(0), baseArchive: state(10) });
    assert.deepEqual(api.calls.writes, []);
  });
}

test("plan pair edits queued in flight stay serial and use the in-flight values as merge bases", async () => {
  const first = deferred(); const second = deferred();
  let concurrent = 0; let maximum = 0;
  const api = await loadStorage({ pair: async (_entry, index) => {
    concurrent++; maximum = Math.max(maximum, concurrent);
    try { return await (index === 1 ? first.promise : second.promise); }
    finally { concurrent--; }
  } });
  await hydratePlanPair(api);
  await enqueuePlanPair(api, state(1), state(11));
  const flushing = api.flushAllStorage(); await turn();
  await enqueuePlanPair(api, state(2), state(12));
  const overlapping = api.flushAllStorage(); await turn();
  assert.equal(api.calls.pairs.length, 1);
  first.resolve({plans: state(1), archive: state(11)}); await turn();
  assert.deepEqual(api.calls.pairs[1], {plans: state(2), archive: state(12), basePlans: state(1), baseArchive: state(11)});
  second.resolve({plans: state(2), archive: state(12)});
  await Promise.all([flushing, overlapping]);
  assert.equal(maximum, 1);
  assert.deepEqual(api.calls.writes, []);
  assert.deepEqual(api.persisted.get("plans"), state(2));
  assert.deepEqual(api.persisted.get("plans-archive"), state(12));
});

for (const failedKey of ["plans", "plans-archive"]) {
  test(`a blocked ${failedKey} read blocks the whole paired commit`, async () => {
    const api = await loadStorage({ read: name => { if (name === failedKey) throw new Error("unreadable"); return state(name === "plans" ? 0 : 10); } });
    await hydratePlanPair(api);
    await enqueuePlanPair(api, state(1), state(11));
    await assert.rejects(api.flushAllStorage(), /paused|暂停/);
    assert.deepEqual(api.calls.writes, []);
    assert.deepEqual(api.calls.pairs, []);
    assert.deepEqual(api.persisted.get("plans"), state(0));
    assert.deepEqual(api.persisted.get("plans-archive"), state(10));
  });
}

test("a paired edit arriving behind an active single-plan write still commits as one pair", async () => {
  const first = deferred();
  const api = await loadStorage({ write: (_key, value, _baseline, index) => index === 1 ? first.promise : value });
  await hydratePlanPair(api);
  await api.storage.setItem("plans", JSON.stringify(state(1)));
  const flushing = api.flushAllStorage(); await turn();
  await enqueuePlanPair(api, state(2), state(12));
  const overlapping = api.flushAllStorage();
  first.resolve(state(1));
  await Promise.all([flushing, overlapping]);
  assert.equal(api.calls.writes.length, 1, "the paired edit must not be split into later single-store writes");
  assert.deepEqual(api.calls.pairs, [{plans: state(2), archive: state(12), basePlans: state(1), baseArchive: state(10)}]);
});

for (const failedKey of ["plans", "plans-archive"]) {
  test(`a blocked ${failedKey} read also blocks a single pending edit of its paired store`, async () => {
    const healthyKey = failedKey === "plans" ? "plans-archive" : "plans";
    const api = await loadStorage({ read: name => { if (name === failedKey) throw new Error("unreadable"); return state(name === "plans" ? 0 : 10); } });
    await hydratePlanPair(api);
    await api.storage.setItem(healthyKey, JSON.stringify(state(20)));
    await assert.rejects(api.flushAllStorage(), /paused|暂停/);
    assert.deepEqual(api.calls.writes, []);
    assert.deepEqual(api.calls.pairs, []);
  });
}

test("an archive-first active write cannot split the following paired edit", async () => {
  const first = deferred();
  const api = await loadStorage({ write: (_key, value, _baseline, index) => index === 1 ? first.promise : value });
  await hydratePlanPair(api);
  await api.storage.setItem("plans-archive", JSON.stringify(state(11)));
  const flushing = api.flushAllStorage(); await turn();
  await enqueuePlanPair(api, state(2), state(12));
  const overlapping = api.flushAllStorage();
  first.resolve(state(11));
  await Promise.all([flushing, overlapping]);
  assert.equal(api.calls.writes.length, 1, "the archive-first case must retain the same transaction guarantee");
  assert.deepEqual(api.calls.pairs, [{plans: state(2), archive: state(12), basePlans: state(0), baseArchive: state(11)}]);
});


test("timer-only paired edits cannot get stranded behind two independent in-flight writes", async () => {
  const savingPlans = deferred(); const savingArchive = deferred();
  const api = await loadStorage({ write: name => name === "plans" ? savingPlans.promise : savingArchive.promise });
  await hydratePlanPair(api);
  await api.storage.setItem("plans", JSON.stringify(state(1)));
  await api.fireTimers();
  await api.storage.setItem("plans-archive", JSON.stringify(state(11)));
  await api.fireTimers();
  assert.equal(api.calls.writes.length, 2);
  await enqueuePlanPair(api, state(2), state(12));
  // Both debounce callbacks run while both keys are active. No caller invokes
  // flushAllStorage: ordinary background persistence must still drain the pair.
  await api.fireTimers();
  savingPlans.resolve(state(1)); savingArchive.resolve(state(11));
  await turn(); await turn();
  assert.deepEqual(api.calls.pairs, [{ plans: state(2), archive: state(12), basePlans: state(1), baseArchive: state(11) }]);
  assert.deepEqual(api.persisted.get("plans"), state(2));
  assert.deepEqual(api.persisted.get("plans-archive"), state(12));
});
