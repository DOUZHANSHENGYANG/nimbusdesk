import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);
const cache = new Map();
function load(name) {
  if (!name.startsWith("@/features/plans/")) return nativeRequire(name);
  if (cache.has(name)) return cache.get(name).exports;
  const file = new URL(`./${name.split("/").at(-1)}.ts`, import.meta.url);
  if (!existsSync(file)) return {};
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  cache.set(name, module);
  new Function("require", "module", "exports", code)(load, module, module.exports);
  return module.exports;
}
const api = load("@/features/plans/paper-interactions");
const idle = { editable: false, composing: false, dragging: false, findOpen: false, selectedCount: 0 };
const event = (key, extra = {}) => ({ key, ...extra });

test("Escape and CtrlW cancel pending interaction before folding, and IME keeps both keys", () => {
  assert.equal(typeof api.paperKeyAction, "function", "paper shortcuts need an IME-aware priority policy");
  for (const key of [event("Escape"), event("w", { ctrlKey: true })]) {
    assert.equal(api.paperKeyAction(key, { ...idle, composing: true }), null);
    assert.equal(api.paperKeyAction(key, { ...idle, editable: true, dragging: true }), "cancel-edit");
    assert.equal(api.paperKeyAction(key, { ...idle, dragging: true, findOpen: true, selectedCount: 2 }), "cancel-drag");
    assert.equal(api.paperKeyAction(key, { ...idle, findOpen: true, selectedCount: 2 }), "close-find");
    assert.equal(api.paperKeyAction(key, { ...idle, selectedCount: 2 }), "clear-selection");
    assert.equal(api.paperKeyAction(key, idle), "fold");
  }
  assert.equal(api.paperKeyAction(event("Escape", { keyCode: 229 }), idle), null);
  assert.equal(api.paperKeyAction(event("w", { ctrlKey: true, repeat: true }), idle), null);
});

test("Undo and selection clipboard shortcuts never steal input editing", () => {
  assert.equal(typeof api.paperKeyAction, "function");
  for (const key of [event("z", { ctrlKey: true }), event("y", { ctrlKey: true }), event("z", { ctrlKey: true, shiftKey: true }), event("c", { ctrlKey: true })]) {
    assert.equal(api.paperKeyAction(key, { ...idle, editable: true, selectedCount: 2 }), null);
  }
  assert.equal(api.paperKeyAction(event("z", { ctrlKey: true }), idle), "undo");
  assert.equal(api.paperKeyAction(event("z", { ctrlKey: true, shiftKey: true }), idle), "redo");
  assert.equal(api.paperKeyAction(event("y", { ctrlKey: true }), idle), "redo");
  assert.equal(api.paperKeyAction(event("f", { ctrlKey: true }), idle), "find");
  assert.equal(api.paperKeyAction(event("F3", { shiftKey: true }), idle), "find-previous");
  assert.equal(api.paperKeyAction(event("c", { ctrlKey: true }), { ...idle, selectedCount: 2 }), "copy");
});

test("find input keeps native text undo while Escape closes just the find bar", () => {
  const state = { ...idle, editable: true, findInput: true, findOpen: true };
  assert.equal(api.paperKeyAction(event("z", { ctrlKey: true }), state), null);
  assert.equal(api.paperKeyAction(event("Escape"), state), "close-find");
});

test("multiline clipboard content is split before an input removes line breaks, preserving draft edges", () => {
  assert.equal(typeof api.pastedTaskTitles, "function", "clipboard-stage splitting must be implemented");
  assert.deepEqual(api.pastedTaskTitles("- [ ] Alpha\r\n2. Beta\n* Gamma"), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(api.pastedTaskTitles("First\nSecond", "Before ", " after"), ["Before First", "Second after"]);
  assert.equal(api.pastedTaskTitles("single line"), null);
  assert.equal(api.pastedTaskTitles("\n \n"), null);
});

test("current-paper find searches task text and notes, deduplicates ids, and ignores case", () => {
  assert.equal(typeof api.findPaperTasks, "function", "current-paper search must be implemented");
  const tasks = [{ id: "a", title: "Alpha", note: "Needle" }, { id: "b", title: "needle twice needle" }, { id: "a", title: "Needle" }, { id: "c", title: "Other" }];
  assert.deepEqual(api.findPaperTasks(tasks, "  NEEDLE "), ["a", "b"]);
  assert.deepEqual(api.findPaperTasks(tasks, ""), []);
});

test("drag scroll responds near either edge and stays still in the center", () => {
  assert.equal(typeof api.paperDragScroll, "function");
  assert.ok(api.paperDragScroll(105, 100, 400) < 0);
  assert.ok(api.paperDragScroll(395, 100, 400) > 0);
  assert.equal(api.paperDragScroll(250, 100, 400), 0);
});
