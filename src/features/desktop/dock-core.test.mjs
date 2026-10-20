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

const { dockBounds, dockSpringPair, DOCK_STRIP_W, DOCK_EXPAND_W, DOCK_FLYOUT_W } = load("./dock-core.ts");
const area = { x: -1920, y: 0, w: 1920, h: 1080 };

test("strip hugs the work-area edge and stays vertically centered", () => {
  const left = dockBounds(area, "left", "strip");
  assert.deepEqual(left, { x: -1920, y: 280, w: DOCK_STRIP_W, h: 520 });
  const right = dockBounds(area, "right", "strip");
  assert.equal(right.x + right.w, area.x + area.w, "right edge must anchor to the border");
  assert.equal(right.y, left.y);
});

test("hover preview and flyout grow inward without crossing the work area", () => {
  for (const mode of ["expand", "flyout"]) {
    const left = dockBounds(area, "left", mode);
    assert.equal(left.x, area.x, "left dock keeps its anchor");
    const right = dockBounds(area, "right", mode);
    assert.equal(right.x + right.w, area.x + area.w, "right dock grows toward the screen interior");
  }
  assert.equal(dockBounds(area, "left", "expand").w, DOCK_EXPAND_W);
  assert.equal(dockBounds(area, "left", "flyout").w, DOCK_FLYOUT_W);
});

test("all modes share one anchor, so the spring only moves one side", () => {
  const modes = ["strip", "expand", "flyout"];
  for (const edge of ["left", "right"]) {
    const rects = modes.map((mode) => dockBounds(area, edge, mode));
    for (const rect of rects) {
      if (edge === "left") assert.equal(rect.x, rects[0].x, "left anchor fixed");
      else assert.equal(rect.x + rect.w, rects[0].x + rects[0].w, "right anchor fixed");
    }
    // strip 与 expand 同高（只是变宽）；flyout 更高一档，属预期。
    assert.equal(dockBounds(area, edge, "expand").h, dockBounds(area, edge, "strip").h);
  }
});

test("spring pair passes both modes through unchanged", () => {
  const { from, to } = dockSpringPair(area, "right", "strip", "flyout");
  assert.equal(from.w, DOCK_STRIP_W);
  assert.equal(to.w, DOCK_FLYOUT_W);
  assert.equal(from.x + from.w, to.x + to.w, "right anchor stays pinned");
});

test("short work areas clamp the dock height instead of overflowing", () => {
  const small = { x: 0, y: 0, w: 800, h: 300 };
  const bounds = dockBounds(small, "left", "flyout");
  assert.equal(bounds.h, 300);
  assert.equal(bounds.y, 0);
});
