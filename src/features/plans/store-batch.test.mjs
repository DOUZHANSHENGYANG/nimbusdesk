import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);
function loadStore() {
  const cache = new Map();
  function load(name) {
    if (name === "@/lib/storage") return { tauriJsonStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }, onStorageSynced: () => () => {} };
    if (!name.startsWith("@/features/plans/")) return nativeRequire(name);
    if (cache.has(name)) return cache.get(name).exports;
    const file = new URL(`./${name.split("/").at(-1)}.ts`, import.meta.url);
    const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const module = { exports: {} };
    cache.set(name, module);
    new Function("require", "module", "exports", code)(load, module, module.exports);
    return module.exports;
  }
  return load("@/features/plans/store");
}
const date = "2026-10-18";
const task = (id, parentId = null, extra = {}) => ({ id, parentId, title: id, done: false, createdAt: 1, updatedAt: 1, ...extra });
function setup(tasks, policy = { autoClear: false, autoSortDone: false }) {
  const module = loadStore();
  module.setCompletionPolicyReader(() => policy);
  const store = module.usePlans;
  store.setState({ days: { [date]: tasks }, history: { past: [], future: [] } });
  return store;
}

test("moving a task to another day carries its subtree, rewrites time and undoes in one step", () => {
  const other = "2026-10-20";
  const tasks = [task("parent", null, { start: "09:00", end: "10:00", note: "keep" }), task("child", "parent"), task("stay")];
  const store = setup(tasks);
  assert.equal(typeof store.getState().moveTaskToDate, "function", "cross-day move must be implemented");
  assert.equal(store.getState().moveTaskToDate(date, "parent", other, { start: "14:00", end: "15:30" }), true);
  const state = store.getState();
  assert.deepEqual(state.days[date].map(t => t.id), ["stay"], "source day keeps unrelated tasks");
  assert.deepEqual(state.days[other].map(t => t.id), ["parent", "child"], "subtree travels with the parent");
  const moved = state.days[other].find(t => t.id === "parent");
  assert.equal(moved.start, "14:00");
  assert.equal(moved.end, "15:30");
  assert.equal(moved.note, "keep", "metadata survives the move");
  assert.equal(state.history.past.length, 1, "one history entry covers both days");
  assert.equal(state.undo(), true);
  assert.deepEqual(store.getState().days[date], tasks, "undo restores the original day");
  assert.equal(store.getState().days[other], undefined, "undo removes the created day");
});

test("moving onto the same day is a no-op and a colliding id never overwrites", () => {
  const other = "2026-10-20";
  const store = setup([task("a"), task("b")]);
  assert.equal(store.getState().moveTaskToDate(date, "a", date), false);
  store.setState({ days: { [date]: [task("a")], [other]: [task("a")] } });
  assert.equal(store.getState().moveTaskToDate(date, "a", other), false, "duplicate id must not be overwritten");
  assert.deepEqual(store.getState().days[date].map(t => t.id), ["a"]);
});

test("batch removal deduplicates parent/child selections and one undo restores all metadata", () => {  const tasks = [task("parent", null, { note: "notes", start: "09:00", attachments: [{ id: "a", path: "owned/a.txt" }] }), task("child", "parent"), task("keep")];
  const store = setup(tasks);
  assert.equal(typeof store.getState().removeTasks, "function", "batch removal must be implemented");
  store.getState().removeTasks(date, ["parent", "child", "parent", "missing"]);
  assert.deepEqual(store.getState().days[date].map(t => t.id), ["keep"]);
  assert.equal(store.getState().history.past.length, 1);
  assert.equal(store.getState().undo(), true);
  assert.deepEqual(store.getState().days[date], tasks);
  assert.equal(store.getState().redo(), true);
  assert.deepEqual(store.getState().days[date].map(t => t.id), ["keep"]);
});

test("bulk completion uses the normal done-last policy with exactly one history step", () => {
  const tasks = [task("first"), task("child", "first"), task("second"), task("third")];
  const store = setup(tasks, { autoClear: false, autoSortDone: true });
  assert.equal(typeof store.getState().setTasksDone, "function", "bulk completion must be implemented");
  store.getState().setTasksDone(date, ["first", "second"], true);
  assert.deepEqual(store.getState().days[date].map(t => [t.id, t.done]), [["third", false], ["first", true], ["child", false], ["second", true]]);
  assert.equal(store.getState().history.past.length, 1);
  store.getState().undo();
  assert.deepEqual(store.getState().days[date], tasks);
});

test("bulk auto-clear removes selected subtrees and never deletes unrelated completed tasks", () => {
  const tasks = [task("first"), task("child", "first"), task("old", null, { done: true }), task("keep")];
  const store = setup(tasks, { autoClear: true, autoSortDone: true });
  assert.equal(typeof store.getState().setTasksDone, "function");
  store.getState().setTasksDone(date, ["first", "child", "old"], true);
  assert.deepEqual(store.getState().days[date].map(t => t.id), ["old", "keep"]);
  assert.equal(store.getState().history.past.length, 1);
  store.getState().undo();
  assert.deepEqual(store.getState().days[date], tasks);
});

test("single completion plus automatic sorting is one reversible action", () => {
  const tasks = [task("first"), task("second")];
  const store = setup(tasks, { autoClear: false, autoSortDone: true });
  store.getState().toggleDone(date, "first");
  assert.equal(store.getState().history.past.length, 1);
  store.getState().undo();
  assert.deepEqual(store.getState().days[date], tasks);
});

test("sibling reordering moves a complete subtree without changing fields and undo restores it", () => {
  const tasks = [task("a"), task("a-child", "a", { note: "preserve", end: "10:00" }), task("b"), task("b-child", "b"), task("c")];
  const store = setup(tasks);
  assert.equal(typeof store.getState().reorderTask, "function", "sibling reordering must be implemented");
  store.getState().reorderTask(date, "a", "b", "after");
  assert.deepEqual(store.getState().days[date].map(t => t.id), ["b", "b-child", "a", "a-child", "c"]);
  assert.deepEqual(store.getState().days[date].find(t => t.id === "a-child"), tasks[1]);
  assert.equal(store.getState().history.past.length, 1);
  store.getState().undo();
  assert.deepEqual(store.getState().days[date], tasks);
});

test("no-op, stale, and cross-parent reorder requests create no history", () => {
  const tasks = [task("a"), task("child", "a"), task("b")];
  const store = setup(tasks);
  assert.equal(typeof store.getState().reorderTask, "function");
  store.getState().reorderTask(date, "a", "child", "before");
  store.getState().reorderTask(date, "missing", "a", "after");
  store.getState().reorderTask(date, "a", "a", "after");
  store.getState().removeTasks(date, ["missing"]);
  store.getState().setTasksDone(date, ["a"], false);
  assert.equal(store.getState().history.past.length, 0);
  assert.deepEqual(store.getState().days[date], tasks);
});

test("clearing a completed parent also removes descendants instead of leaving invisible orphans", () => {
  const tasks = [task("parent", null, { done: true }), task("child", "parent"), task("keep")];
  const store = setup(tasks);
  assert.equal(store.getState().clearDone(date), 2);
  assert.deepEqual(store.getState().days[date].map(t => t.id), ["keep"]);
  assert.equal(store.getState().history.past.length, 1);
  store.getState().undo();
  assert.deepEqual(store.getState().days[date], tasks);
});

test("linked plan creation is one complete undoable operation and deletion restores the binding", () => {
  const store = setup([]);
  assert.equal(typeof store.getState().addLinkedTask, "function", "linked plans must be created atomically");
  const id = store.getState().addLinkedTask(date, null, "Derived plan", "work-item");
  assert.equal(store.getState().days[date][0].workItemId, "work-item");
  assert.equal(store.getState().history.past.length, 1);
  store.getState().undo(); assert.deepEqual(store.getState().days[date], []);
  store.getState().redo(); assert.equal(store.getState().days[date][0].workItemId, "work-item");
  store.getState().removeTask(date,id);store.getState().undo();
  assert.equal(store.getState().days[date][0].workItemId,"work-item");
});

test("child association overrides and explicit standalone markers survive undo and automatic removal", () => {
  const tasks=[task("p",null,{workItemId:"work"}),task("c","p",{workItemId:null})];
  const store=setup(tasks,{autoClear:true,autoSortDone:true});
  store.getState().updateTask(date,"c",{workItemId:"other"});store.getState().undo();
  assert.equal(store.getState().days[date][1].workItemId,null);
  store.getState().toggleDone(date,"p");store.getState().undo();assert.deepEqual(store.getState().days[date],tasks);
});

test("archive/restore undo and redo restore both stores with task bindings, never duplicates or loss", () => {
  const module=loadStore(), store=module.usePlans, archive=module.usePlansArchive;
  const tasks=[task('linked',null,{workItemId:'work',attachments:[{id:'a',path:'owned/a'}]})];
  store.setState({days:{[date]:tasks},history:{past:[],future:[]}});archive.setState({days:{}});
  module.archiveDay(date);assert.equal(store.getState().days[date],undefined);assert.deepEqual(archive.getState().days[date].tasks,tasks);
  store.getState().undo();assert.deepEqual(store.getState().days[date],tasks);assert.equal(archive.getState().days[date],undefined);
  store.getState().redo();assert.equal(store.getState().days[date],undefined);assert.deepEqual(archive.getState().days[date].tasks,tasks);
  module.restoreDay(date);store.getState().undo();assert.equal(store.getState().days[date],undefined);assert.deepEqual(archive.getState().days[date].tasks,tasks);
  store.getState().redo();assert.deepEqual(store.getState().days[date],tasks);assert.equal(archive.getState().days[date],undefined);
});
