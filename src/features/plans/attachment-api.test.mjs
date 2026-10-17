import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Exercise the real API module with native/store boundaries replaced, without a browser or user data.
const source = await readFile(new URL("./attachment-api.ts", import.meta.url), "utf8");
let sequence = 0;
async function loadApi(dependencies) {
  const key = `__attachmentTest${++sequence}`;
  globalThis[key] = dependencies;
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText
    .replace(/^import .*;\r?\n/gm, "");
  const module = await import(`data:text/javascript;base64,${Buffer.from(`const { invoke, openPath, pickFile, revealInExplorer, usePlans } = globalThis.${key};\n${code}`).toString("base64")}`);
  delete globalThis[key];
  return module;
}

function taskStore(task) {
  const patches = [];
  const state = {
    days: { "2026-10-17": [task] },
    updateTask(date, id, patch) {
      patches.push(patch);
      state.days[date] = state.days[date].map((item) => item.id === id ? { ...item, ...patch } : item);
    },
  };
  return { state, patches, usePlans: { getState: () => state } };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const date = "2026-10-17";
const first = { id: "first", name: "one.txt", path: "modules/plans/tasks/task/attachments/first/one.txt", size: 3, createdAt: 1 };
const second = { ...first, id: "second", name: "two.txt" };

test("an upload merges with fresh metadata after a concurrent edit", async () => {
  const store = taskStore({ id: "task", title: "before", attachments: [] });
  const copy = deferred();
  const api = await loadApi({ ...store, pickFile: async () => "C:/source.txt", invoke: () => copy.promise });
  const pending = api.addTaskAttachment(date, "task");
  await new Promise((done) => setImmediate(done));
  store.state.days[date][0] = { id: "task", title: "changed elsewhere", attachments: [first] };
  copy.resolve([first, second]);
  assert.equal(await pending, true);
  assert.equal(store.state.days[date][0].title, "changed elsewhere");
  assert.deepEqual(store.state.days[date][0].attachments, [first, second]);
});

test("deleting a task while files are copied does not resurrect it", async () => {
  const store = taskStore({ id: "task", title: "gone soon" });
  const copy = deferred();
  const api = await loadApi({ ...store, pickFile: async () => "C:/source.txt", invoke: () => copy.promise });
  const pending = api.addTaskAttachment(date, "task");
  await new Promise((done) => setImmediate(done));
  store.state.days[date] = [];
  copy.resolve([first]);
  assert.equal(await pending, false);
  assert.deepEqual(store.patches, []);
});

test("canceling the picker performs no file or store writes", async () => {
  const store = taskStore({ id: "task", title: "still here" });
  const api = await loadApi({ ...store, pickFile: async () => null, invoke: () => assert.fail("must not invoke") });
  assert.equal(await api.addTaskAttachment(date, "task"), true);
  assert.deepEqual(store.patches, []);
});

test("unlinking changes only metadata; opening and revealing resolve managed locations first", async () => {
  const store = taskStore({ id: "task", title: "with files", attachments: [first, second] });
  const calls = [];
  const api = await loadApi({ ...store,
    invoke: async (command, args) => { calls.push([command, args]); return "E:/managed/one.txt"; },
    openPath: async (path) => calls.push(["open", path]),
    revealInExplorer: async (path) => calls.push(["reveal", path]),
  });
  api.unlinkTaskAttachment(date, "task", "first");
  assert.deepEqual(store.patches, [{ attachments: [second] }]);
  assert.deepEqual(calls, []);
  await api.openTaskAttachment(first);
  await api.openTaskAttachment(first, true);
  assert.deepEqual(calls, [
    ["task_attachment_location", { path: first.path }], ["open", "E:/managed/one.txt"],
    ["task_attachment_location", { path: first.path }], ["reveal", "E:/managed/one.txt"],
  ]);
});
