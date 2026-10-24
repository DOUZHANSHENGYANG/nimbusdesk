/** Dock 几何：全部逻辑像素，与 edge-core 的 MonitorArea 同一口径。 */

export type DockEdge = "left" | "right" | "top";
export interface DockArea { x: number; y: number; w: number; h: number; scale?: number }
export interface DockBounds { x: number; y: number; w: number; h: number }

/** 三种窗口形态：纯图标条 / 悬停预览（带标签）/ 飞出面板（栅格、计划）。 */
export type DockMode = "strip" | "expand" | "flyout";
export type DockPanel = "fences" | "plans" | "projects" | "capture";

/**
 * 侧边栏常驻「图标 + 文字」，高度固定（不随面板开合变化）。
 * 宽度是可调的唯一尺寸：116 → 100，标签仍放得下「收集知识」。
 */
export const DOCK_RAIL_W = 100;
export const DOCK_RAIL_H = 560;
export const DOCK_FLYOUT_W = 408;
/** 飞出面板与侧栏同高：开合只变宽，形态与高度恒定。 */
export const DOCK_PANEL_H = DOCK_RAIL_H;
export const DOCK_FLYOUT_MAX_H = 640;
/** 顶缘横排的尺寸：宽度自适应屏幕，高度贴合内容。 */
export const DOCK_TOP_W = 560;
const TOP_MODE_W: Record<DockMode, number> = { strip: DOCK_TOP_W, expand: DOCK_TOP_W, flyout: DOCK_FLYOUT_W };
const TOP_MODE_H: Record<DockMode, number> = { strip: 64, expand: 64, flyout: DOCK_FLYOUT_MAX_H };
/** 展开面板里每行的高度，供图标布局对齐。 */
export const DOCK_ROW_H = 44;
/** 锚定弹出时，面板前缘与触发图标中心保持的距离（逻辑像素）。保留给未来用。 */
const ANCHOR_LEAD = 48;

/** 收集知识面板内容多，内容区足够即可（窗口高度与侧栏一致，靠内部滚动）。 */
export const DOCK_CAPTURE_H = DOCK_RAIL_H;
const MODE_W: Record<DockMode, number> = { strip: DOCK_RAIL_W, expand: DOCK_RAIL_W, flyout: DOCK_FLYOUT_W };
const MODE_H: Record<DockMode, number> = { strip: DOCK_RAIL_H, expand: DOCK_RAIL_H, flyout: DOCK_PANEL_H };

/**
 * 三种形态的窗口矩形。侧边栏常驻「图标 + 文字」（strip 与 expand 同尺寸）；
 * 飞出面板在锚定图标旁弹出，其余形态在工作区居中。
 * 顶缘是水平横排：锚定顶边界。绝不越过工作区。
 */
export function dockBounds(area: DockArea, edge: DockEdge, mode: DockMode, anchor?: number, height?: number): DockBounds {
  const lead = mode === "flyout" ? anchor : undefined;
  const capH = mode === "flyout" ? height : undefined;
  if (edge === "top") {
    const w = Math.min(area.w, TOP_MODE_W[mode]);
    const h = Math.min(area.h, capH ?? TOP_MODE_H[mode]);
    const x = lead === undefined
      ? area.x + Math.round((area.w - w) / 2)
      : Math.min(Math.max(Math.round(lead - ANCHOR_LEAD), area.x), area.x + area.w - w);
    return { x, y: area.y, w, h };
  }
  const h = Math.min(area.h, capH ?? MODE_H[mode]);
  const w = MODE_W[mode];
  const y = lead === undefined
    ? area.y + Math.round((area.h - h) / 2)
    : Math.min(Math.max(Math.round(lead - ANCHOR_LEAD), area.y), area.y + area.h - h);
  const x = edge === "left" ? area.x : Math.round(area.x + area.w - w);
  return { x, y, w, h };
}

/** 弹簧动画的起止矩形：只变 x/宽度，y/高度保持不动（顶缘直接落位，不走弹簧）。 */
/* ── 悬浮锚点（卡片化）────────────────────────────────────
 * 侧栏与顶条都是「贴着某条边」；卡片化的 Dock 不贴边 —— 它浮在工作区顶边
 * 下方一小段、水平居中。形式上是同一个窗口换了锚点，所以不进 DockEdge：
 * 吸附逻辑（nearestDockEdge / settings.dockEdge）仍然只认三条边。
 * 两个形态共用一条中心线，切换时只变宽高，和侧栏「只变宽度」是同一思路。
 */

/** 距工作区顶边的距离（逻辑像素）。 */
export const DOCK_FLOAT_GAP = 12;
/** 胶囊态：窗口不能按内容自适应宽度，给一个放得下「云台 · 3 项待办 · 17:15」的保守值。 */
export const DOCK_CAPSULE_W = 464;
export const DOCK_CAPSULE_H = 44;
/** 卡片态：五页共用一个矩形，切页不跳窗（视觉稿实测 660 × 591）。 */
export const DOCK_CARD_W = 660;
export const DOCK_CARD_H = 591;
/** 卡片高度可拖范围：太矮放不下六页，太高会盖住整屏 */
export const DOCK_CARD_MIN_H = 420;
export const DOCK_CARD_MAX_H = 900;

/** 展开方向：居中向两边撑开，还是钉住左缘向右拉出来。 */
export type DockExpandAnchor = "center" | "left";

/**
 * 悬浮锚点的窗口矩形：水平居中、距顶固定间距；工作区不够高时贴底，绝不越过。
 *
 * anchor = "left" 时**钉住胶囊的左缘**，卡片向右长出去。观感差别很明显：
 * 居中是「两边同时推开」，左缘锚定是「从胶囊里拉出来」—— 单侧运动更容易
 * 被眼睛跟住，这也是灵动岛那种「长出来」的感觉来源。
 */
export function dockFloatBounds(
  area: DockArea,
  mode: DockMode,
  anchor: DockExpandAnchor = "center",
  cardHeight: number = DOCK_CARD_H,
): DockBounds {
  const w = Math.min(area.w, mode === "flyout" ? DOCK_CARD_W : DOCK_CAPSULE_W);
  const wanted = mode === "flyout"
    ? Math.min(DOCK_CARD_MAX_H, Math.max(DOCK_CARD_MIN_H, cardHeight))
    : DOCK_CAPSULE_H;
  const h = Math.min(area.h, wanted);
  const centered = area.x + Math.round((area.w - w) / 2);
  // 左缘锚定 = 钉住**胶囊**的左缘（不是当前形态居中后的左缘），否则展开时
  // 起点会漂到卡片自己的居中位置，看上去仍是从中间撑开。
  const capsuleW = Math.min(area.w, DOCK_CAPSULE_W);
  const capsuleX = area.x + Math.round((area.w - capsuleW) / 2);
  const x = anchor === "left"
    ? Math.max(area.x, Math.min(capsuleX, area.x + area.w - w))
    : centered;
  const y = Math.min(area.y + DOCK_FLOAT_GAP, area.y + area.h - h);
  return { x, y, w, h };
}

export function dockFloatSpringPair(area: DockArea, from: DockMode, to: DockMode): { from: DockBounds; to: DockBounds } {
  return { from: dockFloatBounds(area, from), to: dockFloatBounds(area, to) };
}

export function dockSpringPair(area: DockArea, edge: DockEdge, from: DockMode, to: DockMode, anchor?: number, height?: number): { from: DockBounds; to: DockBounds } {
  return { from: dockBounds(area, edge, from, anchor, height), to: dockBounds(area, edge, to, anchor, height) };
}
