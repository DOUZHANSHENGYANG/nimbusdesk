import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { readFileSync } from "node:fs";

function load(file) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(() => undefined, module, module.exports);
  return module.exports;
}

const { ageBucket, childProgress, dateKey, monthGrid, summarizeDay } = load("./dock-float-core.ts");

const task = (over = {}) => ({ id: Math.random().toString(36).slice(2), parentId: null, title: "t", done: false, createdAt: 0, updatedAt: 0, ...over });

test("month grid is always six Monday-first weeks", () => {
  const cells = monthGrid(2026, 7); // 2026-08：1 号是周六
  assert.equal(cells.length, 42);
  assert.equal(cells[0].date, "2026-07-27", "8 月 1 日是周六，格里从 7/27 周一开头");
  assert.equal(cells[0].inMonth, false);
  assert.equal(cells[5].date, "2026-08-01");
  assert.equal(cells[5].inMonth, true);
  const days = monthGrid(2026, 1); // 2026-02：28 天，1 号周日
  assert.equal(days.filter((cell) => cell.inMonth).length, 28);
  assert.equal(days[6].date, "2026-02-01", "2 月 1 日落在第一行的周日");
});

test("day summary counts top-level tasks only", () => {
  const tasks = [
    task({ done: true, start: "09:00" }),
    task({ start: "08:00" }), // 已过点未完成
    task({ start: "23:30" }), // 还没到点
    task(), // 无时间
    task({ parentId: "x" }), // 子任务不计
  ];
  const summary = summarizeDay(tasks, new Date(2026, 7, 31, 12, 0));
  assert.deepEqual(summary, { total: 4, todo: 3, done: 1, late: 1, percent: 25 });
  assert.deepEqual(summarizeDay([], new Date()), { total: 0, todo: 0, done: 0, late: 0, percent: 0 }, "空的一天不能除零");
});

test("child progress reports done/total and null without children", () => {
  const tasks = [task({ id: "p" }), task({ id: "a", parentId: "p", done: true }), task({ id: "b", parentId: "p" })];
  assert.deepEqual(childProgress(tasks, "p"), { done: 1, total: 2 });
  assert.equal(childProgress(tasks, "a"), null);
});

test("age bucket switches unit at the hour and the day", () => {
  const now = new Date(2026, 7, 31, 12, 0).getTime();
  assert.deepEqual(ageBucket(now - 5 * 60000, now), { unit: "minute", value: 5 });
  assert.deepEqual(ageBucket(now - 90 * 60000, now), { unit: "hour", value: 1 });
  assert.deepEqual(ageBucket(now - 26 * 3600000, now), { unit: "day", value: 1 });
  assert.equal(ageBucket(undefined, now), null);
  assert.deepEqual(ageBucket(now + 60000, now), { unit: "minute", value: 0 }, "时钟偏差不出现负数");
});

test("date key is local and zero padded", () => {
  assert.equal(dateKey(new Date(2026, 0, 5)), "2026-01-05");
});
