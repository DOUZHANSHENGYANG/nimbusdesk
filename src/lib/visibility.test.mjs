import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url), cache = new Map();
function load(name = "./visibility") {
  if (cache.has(name)) return cache.get(name).exports;
  const code = ts.transpileModule(readFileSync(new URL(`${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const m = { exports: {} };
  cache.set(name, m);
  new Function("require", "module", "exports", code)((s) => (s.startsWith(".") ? load(s) : nativeRequire(s)), m, m.exports);
  return m.exports;
}

/** 造一个可控的「假窗口」：翻 visibilityState、手动打拍子、手动触发 wake。 */
function fakeDom() {
  const listeners = new Map();
  const doc = {
    visibilityState: "visible",
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== fn)),
  };
  const win = {
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== fn)),
  };
  globalThis.document = doc;
  globalThis.window = win;
  const timers = new Map();
  let nextId = 1;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => {
    const id = nextId++;
    timers.set(id, { fn, ms });
    return id;
  };
  globalThis.clearInterval = (id) => timers.delete(id);
  return {
    hide: () => {
      doc.visibilityState = "hidden";
      for (const fn of listeners.get("visibilitychange") ?? []) fn();
    },
    show: () => {
      doc.visibilityState = "visible";
      for (const fn of listeners.get("visibilitychange") ?? []) fn();
    },
    focus: () => {
      for (const fn of listeners.get("focus") ?? []) fn();
    },
    /** 打一拍：把当前注册的定时器回调按注册顺序各调一次 */
    beat: () => {
      for (const { fn } of [...timers.values()]) fn();
    },
    timerCount: () => timers.size,
    intervalMs: () => [...timers.values()][0]?.ms,
    restore: () => {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      delete globalThis.document;
      delete globalThis.window;
    },
  };
}

test("shouldTick：foreground 策略只在前台干活，always 一律干活", () => {
  const { shouldTick } = load();
  assert.equal(shouldTick("foreground", true), true);
  assert.equal(shouldTick("foreground", false), false);
  assert.equal(shouldTick("always", true), true);
  assert.equal(shouldTick("always", false), true);
});

test("isForeground 在没有 document 的环境里当作可见", () => {
  const { isForeground } = load();
  assert.equal(isForeground(), true);
});

test("隐藏时跳过拍子，回到前台立即补一拍", () => {
  const dom = fakeDom();
  const { startForegroundInterval } = load();
  let runs = 0;
  const stop = startForegroundInterval(() => {
    runs += 1;
  }, 3000);
  try {
    assert.equal(dom.intervalMs(), 3000, "应按给定间隔注册定时器");

    dom.beat();
    assert.equal(runs, 1, "前台时每拍都干活");

    dom.hide();
    dom.beat();
    dom.beat();
    assert.equal(runs, 1, "隐藏后不再干活");

    dom.show();
    assert.equal(runs, 2, "回到前台立刻补一拍");

    dom.beat();
    assert.equal(runs, 3, "恢复后继续按拍干活");
  } finally {
    stop();
    assert.equal(dom.timerCount(), 0, "停止函数要清掉定时器");
    dom.restore();
  }
});

test("catchUp=false：调用方自己管唤醒时不重复补拍", () => {
  const dom = fakeDom();
  const { startForegroundInterval } = load();
  let runs = 0;
  const stop = startForegroundInterval(() => {
    runs += 1;
  }, 30_000, { catchUp: false });
  try {
    dom.hide();
    dom.beat();
    assert.equal(runs, 0);
    dom.show();
    assert.equal(runs, 0, "关掉 catchUp 后回到前台由调用方自己触发");
    dom.beat();
    assert.equal(runs, 1);
  } finally {
    stop();
    dom.restore();
  }
});

test("policy=always：不可见也照常跑（边缘坞那类轮询）", () => {
  const dom = fakeDom();
  const { startForegroundInterval } = load();
  let runs = 0;
  const stop = startForegroundInterval(
    () => {
      runs += 1;
    },
    2500,
    { policy: "always", catchUp: false },
  );
  try {
    dom.hide();
    dom.beat();
    assert.equal(runs, 1, "always 策略不受可见性影响");
  } finally {
    stop();
    dom.restore();
  }
});
