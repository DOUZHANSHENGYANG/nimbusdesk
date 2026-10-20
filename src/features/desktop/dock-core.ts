/** Dock 几何：全部逻辑像素，与 edge-core 的 MonitorArea 同一口径。 */

export type DockEdge = "left" | "right";
export interface DockArea { x: number; y: number; w: number; h: number; scale?: number }
export interface DockBounds { x: number; y: number; w: number; h: number }

/** 收起态只显示图标条；展开态向屏幕内侧长出标签面板。 */
export const DOCK_STRIP_W = 56;
export const DOCK_PANEL_W = 248;
/** 高度最多占工作区的 80%，避免盖满整条边。 */
export const DOCK_MAX_H = 520;
/** 展开面板里每行的高度，供图标布局对齐。 */
export const DOCK_ROW_H = 44;

/**
 * 收起/展开两种状态的窗口矩形。垂直方向在工作区居中；
 * 右缘锚定右边界（x 随宽度外移），左缘锚定左边界（x 不变）。
 * 展开的方向永远朝屏幕内侧，绝不越过工作区。
 */
export function dockBounds(area: DockArea, edge: DockEdge, expanded: boolean): DockBounds {
  const h = Math.min(area.h, DOCK_MAX_H);
  const w = expanded ? DOCK_PANEL_W : DOCK_STRIP_W;
  const y = area.y + Math.round((area.h - h) / 2);
  const x = edge === "left" ? area.x : Math.round(area.x + area.w - w);
  return { x, y, w, h };
}

/** 弹簧动画的起止矩形：只变 x/宽度，y/高度保持不动。 */
export function dockSpringPair(area: DockArea, edge: DockEdge, from: boolean, to: boolean): { from: DockBounds; to: DockBounds } {
  return { from: dockBounds(area, edge, from), to: dockBounds(area, edge, to) };
}
