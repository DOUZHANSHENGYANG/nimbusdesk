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

const { dockBounds, dockSpringPair, DOCK_RAIL_W, DOCK_RAIL_H, DOCK_FLYOUT_W, DOCK_PANEL_H } = load("./dock-core.ts");
const { dockFloatBounds, dockFloatSpringPair, dockFloatEdgeBounds, nearestFloatEdge, DOCK_FLOAT_GAP, DOCK_CAPSULE_W, DOCK_CAPSULE_H, DOCK_CARD_W, DOCK_CARD_H } = load("./dock-core.ts");
const area = { x: -1920, y: 0, w: 1920, h: 1080 };
/** 侧栏在垂直方向居中时的 y */
const railY = area.y + Math.round((area.h - DOCK_RAIL_H) / 2);

test("the rail hugs the work-area edge, fits its content and stays centered", () => {
  const left = dockBounds(area, "left", "strip");
  assert.deepEqual(left, { x: area.x, y: railY, w: DOCK_RAIL_W, h: DOCK_RAIL_H });
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
  assert.equal(bounds.h, Math.min(300, DOCK_PANEL_H), "flyout clamps to the work area");
  assert.equal(bounds.y, Math.round((300 - bounds.h) / 2));
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
  assert.equal(dockBounds(area, "right", "strip", 400).y, railY, "non-flyout modes stay centered");
});

/* ── 悬浮锚点：卡片化的 Dock 不贴边 ───────────────────────── */

test("float anchor centers both forms and keeps a fixed gap from the top", () => {
  const capsule = dockFloatBounds(area, "strip");
  const card = dockFloatBounds(area, "flyout");
  assert.deepEqual(capsule, {
    x: area.x + Math.round((area.w - DOCK_CAPSULE_W) / 2),
    y: area.y + DOCK_FLOAT_GAP,
    w: DOCK_CAPSULE_W,
    h: DOCK_CAPSULE_H,
  });
  assert.deepEqual(card, {
    x: area.x + Math.round((area.w - DOCK_CARD_W) / 2),
    y: area.y + DOCK_FLOAT_GAP,
    w: DOCK_CARD_W,
    h: DOCK_CARD_H,
  });
  assert.equal(capsule.x + capsule.w / 2, card.x + card.w / 2, "两种形态共用一条中心线，切换时只变宽高");
  assert.equal(dockBounds(area, "left", "strip").y, railY, "侧栏几何不受悬浮锚点影响");
});

/* ── 悬浮吸附：上 / 左 / 右（用户定的规矩，下不算） ───────────────── */

test("nearestFloatEdge picks the closest of the three allowed edges", () => {
  const workarea = { x: 0, y: 0, w: 2000, h: 1000 };
  assert.equal(nearestFloatEdge({ x: 900, y: 8, w: 244, h: 44 }, workarea), "top", "贴顶");
  assert.equal(nearestFloatEdge({ x: 6, y: 400, w: 244, h: 44 }, workarea), "left", "贴左");
  assert.equal(nearestFloatEdge({ x: 1740, y: 500, w: 244, h: 44 }, workarea), "right", "贴右");
  // 拖到正中：三条边里最最近的一条赢（这里左与右等距时取先判的左）
  assert.equal(nearestFloatEdge({ x: 878, y: 480, w: 244, h: 44 }, workarea), "left");
});

test("dockFloatEdgeBounds pins left/right to the edge and centers vertically by default", () => {
  const workarea = { x: 0, y: 0, w: 2000, h: 1000 };
  const left = dockFloatEdgeBounds(workarea, "strip", "left", null, null);
  assert.equal(left.x, DOCK_FLOAT_GAP, "左缘留一条呼吸缝");
  assert.equal(left.w, DOCK_CAPSULE_H, "贴左右缘时胶囊转竖排（宽 = 胶囊高 44）");
  assert.equal(left.y, Math.round((workarea.h - 150) / 2), "没拖过就垂直居中");
  const right = dockFloatEdgeBounds(workarea, "flyout", "right", null, 300);
  assert.equal(right.x, workarea.w - DOCK_CARD_W - DOCK_FLOAT_GAP, "卡片从右缘向屏幕内长");
  assert.equal(right.y, 300, "纵向用拖拽保存的 floatY");
});

test("dockFloatEdgeBounds clamps the side Y into the work area", () => {
  const workarea = { x: 0, y: 0, w: 2000, h: 600 };
  const placed = dockFloatEdgeBounds(workarea, "strip", "left", null, 9999);
  assert.ok(placed.y + placed.h <= workarea.h, "纵向位置不许越出工作区");
});

test("top edge keeps the legacy capsule-center behavior", () => {
  const workarea = { x: 0, y: 0, w: 2000, h: 1000 };
  const placed = dockFloatEdgeBounds(workarea, "strip", "top", 600, null);
  assert.equal(placed.x, 600, "floatX 就是胶囊的左缘候选位（strip 模式宽 = 胶囊宽）");
  assert.equal(placed.y, DOCK_FLOAT_GAP);
});

test("float anchor never leaves the work area", () => {
  const narrow = { x: 0, y: 0, w: 400, h: 900 };
  const clampedWidth = dockFloatBounds(narrow, "flyout");
  assert.equal(clampedWidth.w, 400, "窄工作区按宽度裁");
  assert.equal(clampedWidth.x, 0);

  const short = { x: 0, y: 0, w: 1920, h: 300 };
  const clampedHeight = dockFloatBounds(short, "flyout");
  assert.equal(clampedHeight.h, 300, "矮工作区按高度裁");
  assert.equal(clampedHeight.y, 0, "放不下 12px 间距时贴顶，不留缝");
  assert.ok(clampedHeight.y + clampedHeight.h <= short.h);
});

test("float spring pair keeps the center line while only the size changes", () => {
  const { from, to } = dockFloatSpringPair(area, "strip", "flyout");
  assert.equal(from.x + from.w / 2, to.x + to.w / 2, "中心线不动");
  assert.equal(from.y, to.y, "顶边不动");
  assert.ok(to.w > from.w && to.h > from.h);
});

test("left 锚定：展开时 x 不动，只向右长", () => {
  const area = { x: 0, y: 0, w: 1920, h: 1080 };
  const strip = dockFloatBounds(area, "strip", "left");
  const flyout = dockFloatBounds(area, "flyout", "left");
  assert.equal(flyout.x, strip.x, "左缘钉住，x 不变");
  assert.ok(flyout.w > strip.w, "宽度仍然变大");
  assert.ok(flyout.x + flyout.w <= area.w, "不越过工作区右边");
  const centered = dockFloatBounds(area, "flyout", "center");
  assert.notEqual(centered.x, flyout.x, "两种锚点位置不同");
});
