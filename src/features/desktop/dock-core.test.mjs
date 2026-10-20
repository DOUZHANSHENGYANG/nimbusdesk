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

const { dockBounds, dockSpringPair, DOCK_STRIP_W, DOCK_PANEL_W } = load("./dock-core.ts");
const area = { x: -1920, y: 0, w: 1920, h: 1080 };

test("strip hugs the work-area edge and stays vertically centered", () => {
  const left = dockBounds(area, "left", false);
  assert.deepEqual(left, { x: -1920, y: 280, w: DOCK_STRIP_W, h: 520 });
  const right = dockBounds(area, "right", false);
  assert.equal(right.x + right.w, area.x + area.w, "right edge must anchor to the border");
  assert.equal(right.y, left.y);
});

test("expanding grows inward without crossing the work area", () => {
  const left = dockBounds(area, "left", true);
  assert.equal(left.x, area.x, "left dock keeps its anchor");
  assert.equal(left.w, DOCK_PANEL_W);
  const right = dockBounds(area, "right", true);
  assert.equal(right.x + right.w, area.x + area.w, "right dock grows toward the screen interior");
  assert.equal(right.x, area.x + area.w - DOCK_PANEL_W);
});

test("the strip and the panel share one anchor, so the spring only moves one side", () => {
  for (const edge of ["left", "right"]) {
    const { from, to } = dockSpringPair(area, edge, false, true);
    assert.equal(from.y, to.y);
    assert.equal(from.h, to.h);
    if (edge === "left") assert.equal(from.x, to.x);
    else assert.equal(from.x + from.w, to.x + to.w);
  }
});

test("short work areas clamp the dock height instead of overflowing", () => {
  const small = { x: 0, y: 0, w: 800, h: 300 };
  const bounds = dockBounds(small, "left", true);
  assert.equal(bounds.h, 300);
  assert.equal(bounds.y, 0);
});
