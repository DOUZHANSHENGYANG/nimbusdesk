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

const { dockBounds, dockSpringPair, DOCK_RAIL_W, DOCK_FLYOUT_W } = load("./dock-core.ts");
const area = { x: -1920, y: 0, w: 1920, h: 1080 };

test("the rail hugs the work-area edge, fits its content and stays centered", () => {
  const left = dockBounds(area, "left", "strip");
  assert.deepEqual(left, { x: -1920, y: 396, w: DOCK_RAIL_W, h: 288 });
  const right = dockBounds(area, "right", "strip");
  assert.equal(right.x + right.w, area.x + area.w, "right edge must anchor to the border");
  assert.equal(right.y, left.y);
});

test("rail and flyout grow inward without crossing the work area", () => {
  for (const mode of ["expand", "flyout"]) {
    const left = dockBounds(area, "left", mode);
    assert.equal(left.x, area.x, "left dock keeps its anchor");
    const right = dockBounds(area, "right", mode);
    assert.equal(right.x + right.w, area.x + area.w, "right dock grows toward the screen interior");
  }
  assert.equal(dockBounds(area, "left", "expand").w, DOCK_RAIL_W, "no expand step: rail is permanent");
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
    assert.equal(dockBounds(area, edge, "expand").h, dockBounds(area, edge, "strip").h);
  }
});

test("spring pair passes both modes through unchanged", () => {
  const { from, to } = dockSpringPair(area, "right", "strip", "flyout");
  assert.equal(from.w, DOCK_RAIL_W);
  assert.equal(to.w, DOCK_FLYOUT_W);
  assert.equal(from.x + from.w, to.x + to.w, "right anchor stays pinned");
});

test("short work areas clamp the dock height instead of overflowing", () => {
  const small = { x: 0, y: 0, w: 800, h: 300 };
  const bounds = dockBounds(small, "left", "flyout");
  assert.equal(bounds.h, 300);
  assert.equal(bounds.y, 0);
});

test("top edge is a horizontal bar pinned to the top, centered, growing downward", () => {
  const strip = dockBounds(area, "top", "strip");
  assert.equal(strip.y, area.y, "strip hugs the top border");
  assert.equal(strip.x + strip.w / 2, area.x + area.w / 2, "horizontally centered");
  const expand = dockBounds(area, "top", "expand");
  const flyout = dockBounds(area, "top", "flyout");
  for (const rect of [expand, flyout]) {
    assert.equal(rect.y, area.y, "top anchor fixed");
    assert.equal(rect.x + rect.w / 2, area.x + area.w / 2, "centering fixed");
  }
  assert.equal(expand.h, strip.h, "rail is permanent: no hover growth");
  assert.ok(flyout.h > expand.h);
  const clamped = dockBounds({ x: 0, y: 0, w: 400, h: 300 }, "top", "strip");
  assert.equal(clamped.w, 400, "narrow work areas clamp the width");
});

test("anchor pops the flyout next to the triggering icon, clamped to the work area", () => {
  const anchored = dockBounds(area, "right", "flyout", 400);
  assert.equal(anchored.y, 352, "panel leads the icon by the fixed distance");
  const high = dockBounds(area, "right", "flyout", -500);
  assert.equal(high.y, area.y, "never above the work area");
  const plain = dockBounds(area, "right", "flyout");
  const low = dockBounds(area, "right", "flyout", 99999);
  assert.equal(low.y, area.y + area.h - plain.h, "never below the work area");
  const topAnchored = dockBounds(area, "top", "flyout", 600);
  assert.equal(topAnchored.x, area.x + area.w - DOCK_FLYOUT_W, "top edge anchors horizontally, clamped");
  assert.equal(dockBounds(area, "right", "strip", 400).y, 396, "non-flyout modes stay centered");
});
