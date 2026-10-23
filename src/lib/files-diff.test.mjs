import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url), cache = new Map();
function load(name = "./files-diff") {
  if (cache.has(name)) return cache.get(name).exports;
  const code = ts.transpileModule(readFileSync(new URL(`${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const m = { exports: {} };
  cache.set(name, m);
  new Function("require", "module", "exports", code)((s) => (s.startsWith(".") ? load(s) : nativeRequire(s)), m, m.exports);
  return m.exports;
}

const { diffFiles, applyFilesDelta, emptyDelta, isEmptyDelta } = load();

const category = (id, name = id) => ({ id, name });
const item = (id, categoryId = "work", title = id) => ({ id, categoryId, title, path: `E:/${id}.txt`, tags: [] });

test("库里是空的：首写就是全量插入", () => {
  const next = { categories: [category("work")], items: [item("a"), item("b")] };
  const delta = diffFiles(null, next);
  assert.deepEqual(delta.categories.upsert.map((entry) => [entry.value.id, entry.order]), [["work", 0]]);
  assert.deepEqual(delta.items.upsert.map((entry) => [entry.value.id, entry.order]), [["a", 0], ["b", 1]]);
  assert.deepEqual(delta.items.remove, []);
  assert.deepEqual(delta.items.reorder, []);
  assert.equal(isEmptyDelta(delta), false);
});

test("什么都没变：空增量（不产生任何写入）", () => {
  const prev = { categories: [category("work")], items: [item("a"), item("b")] };
  // 同一批引用，只有外层数组是新的 —— 这正是 store 里「没改任何东西」的形状
  const delta = diffFiles(prev, { categories: [...prev.categories], items: [...prev.items] });
  assert.deepEqual(delta, emptyDelta());
  assert.equal(isEmptyDelta(delta), true);
});

test("只改一条：只推这一条的 payload，其余一条都不动", () => {
  const a = item("a");
  const b = item("b");
  const prev = { categories: [category("work")], items: [a, b] };
  const next = { categories: prev.categories, items: [ { ...a, title: "改了" }, b ] };
  const delta = diffFiles(prev, next);
  assert.deepEqual(delta.items.upsert.map((entry) => entry.value.id), ["a"]);
  assert.equal(delta.items.upsert[0].value.title, "改了");
  assert.deepEqual(delta.items.reorder, [], "位置没变就不该产生 reorder");
  assert.deepEqual(delta.items.remove, []);
  assert.deepEqual(delta.categories.upsert, []);
});

test("拖动排序：只推位置，不重写 payload", () => {
  const a = item("a");
  const b = item("b");
  const c = item("c");
  const prev = { categories: [category("work")], items: [a, b, c] };
  // a 移到最后：a/b/c 三个下标都变了
  const next = { categories: prev.categories, items: [b, c, a] };
  const delta = diffFiles(prev, next);
  assert.deepEqual(delta.items.upsert, [], "内容没变，不该重写任何 payload");
  assert.deepEqual(delta.items.reorder, [
    { id: "b", order: 0 },
    { id: "c", order: 1 },
    { id: "a", order: 2 },
  ]);
});

test("删除与改分类：删除走 remove，改分类走 upsert", () => {
  const a = item("a");
  const prev = { categories: [category("work")], items: [a, item("b")] };
  const next = { categories: prev.categories, items: [{ ...a, categoryId: "archive" }] };
  const delta = diffFiles(prev, next);
  assert.deepEqual(delta.items.remove, ["b"]);
  assert.deepEqual(delta.items.upsert.map((entry) => [entry.value.id, entry.value.categoryId]), [["a", "archive"]]);
});

test("回放：本地应用增量后与发送方状态一致", () => {
  const a = item("a");
  const b = item("b");
  const c = item("c");
  const sender = { categories: [category("work"), category("archive")], items: [b, { ...c, title: "新标题" }] };
  const receiver = { categories: [category("work")], items: [a, b, c] };
  const delta = diffFiles(receiver, sender);
  const applied = applyFilesDelta(receiver, delta);
  assert.deepEqual(applied.items.map((entry) => entry.id), ["b", "c"]);
  assert.equal(applied.items[1].title, "新标题");
  assert.deepEqual(applied.categories.map((entry) => entry.id), ["work", "archive"]);
});

test("回放是幂等的：同一份增量再来一次结果不变", () => {
  const a = item("a");
  const b = item("b");
  const sender = { categories: [category("work")], items: [b, a] };
  const receiver = { categories: [category("work")], items: [a, b] };
  const delta = diffFiles(receiver, sender);
  const once = applyFilesDelta(receiver, delta);
  const twice = applyFilesDelta(once, delta);
  assert.deepEqual(twice.items.map((entry) => entry.id), once.items.map((entry) => entry.id));
});
