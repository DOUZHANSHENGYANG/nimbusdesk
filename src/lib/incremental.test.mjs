import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url), cache = new Map();
function load(name = "./incremental") {
  if (cache.has(name)) return cache.get(name).exports;
  const code = ts.transpileModule(readFileSync(new URL(`${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const m = { exports: {} };
  cache.set(name, m);
  new Function("require", "module", "exports", code)((s) => (s.startsWith(".") ? load(s) : nativeRequire(s)), m, m.exports);
  return m.exports;
}

const { clampCount, DEFAULT_STEP, nextCount, revealForSelection } = load();

test("clampCount 把显示条数限制在 0..total 之间", () => {
  assert.equal(clampCount(-5, 10), 0);
  assert.equal(clampCount(5, 10), 5);
  assert.equal(clampCount(50, 10), 10);
  assert.equal(clampCount(3, 0), 0);
  // 数据被删到比当前显示少：不能留一个越界的值
  assert.equal(clampCount(300, 42), 42);
  assert.equal(clampCount(Number.NaN, 10), 0);
});

test("nextCount 每次放一批，到底就停住", () => {
  assert.equal(nextCount(DEFAULT_STEP, 1000), DEFAULT_STEP * 2);
  assert.equal(nextCount(950, 1000), 1000);
  assert.equal(nextCount(1000, 1000), 1000);
  // 空列表不放出任何东西
  assert.equal(nextCount(DEFAULT_STEP, 0), 0);
});

test("revealForSelection 只在选中项跑到已显示范围外时才补", () => {
  const step = 100;
  // 可见：不动（否则每按一次键都要多渲染一批）
  assert.equal(revealForSelection(0, 100, 1000, step), 100);
  assert.equal(revealForSelection(99, 100, 1000, step), 100);
  // 刚越界一条：补到下一批
  assert.equal(revealForSelection(100, 100, 1000, step), 200);
  assert.equal(revealForSelection(150, 100, 1000, step), 200);
  // 一路跑到很后面（End 键）：一次补到覆盖它的那一批
  assert.equal(revealForSelection(987, 100, 1000, step), 1000);
  // 不会越过总数
  assert.equal(revealForSelection(99999, 100, 1000, step), 1000);
});

test("逐批累加正好覆盖全部，不多也不少", () => {
  const total = 337;
  let count = DEFAULT_STEP;
  let batches = 1;
  while (count < total) {
    count = nextCount(count, total);
    batches += 1;
  }
  assert.equal(count, total);
  assert.equal(batches, Math.ceil(total / DEFAULT_STEP));
});
