/** Dock 几何：全部逻辑像素，与 edge-core 的 MonitorArea 同一口径。 */

export type DockEdge = "left" | "right" | "top";
export interface DockArea { x: number; y: number; w: number; h: number; scale?: number }
export interface DockBounds { x: number; y: number; w: number; h: number }

/** 三种窗口形态：纯图标条 / 悬停预览（带标签）/ 飞出面板（栅格、计划）。 */
export type DockMode = "strip" | "expand" | "flyout";
export type DockPanel = "fences" | "plans";

/** 收起态只显示图标条；悬停长出标签；飞出面板再宽一档放下网格与搜索。 */
export const DOCK_STRIP_W = 56;
export const DOCK_EXPAND_W = 168;
export const DOCK_FLYOUT_W = 408;
/** 高度最多占工作区的 80%，飞出面板可以更高一档。 */
export const DOCK_MAX_H = 520;
export const DOCK_FLYOUT_MAX_H = 640;
/** 顶缘横排的尺寸：条与展开只在高度上变化，宽度自适应屏幕。 */
export const DOCK_TOP_W = 560;
const TOP_MODE_W: Record<DockMode, number> = { strip: DOCK_TOP_W, expand: DOCK_TOP_W, flyout: DOCK_FLYOUT_W };
const TOP_MODE_H: Record<DockMode, number> = { strip: 56, expand: 96, flyout: DOCK_FLYOUT_MAX_H };
/** 展开面板里每行的高度，供图标布局对齐。 */
export const DOCK_ROW_H = 44;

const MODE_W: Record<DockMode, number> = { strip: DOCK_STRIP_W, expand: DOCK_EXPAND_W, flyout: DOCK_FLYOUT_W };
const MODE_H: Record<DockMode, number> = { strip: DOCK_MAX_H, expand: DOCK_MAX_H, flyout: DOCK_FLYOUT_MAX_H };

/**
 * 三种形态的窗口矩形。垂直缘在工作区居中；
 * 右缘锚定右边界（x 随宽度外移），左缘锚定左边界（x 不变）。
 * 顶缘是水平横排：锚定顶边界，水平居中，向下生长。
 * 展开的方向永远朝屏幕内侧，绝不越过工作区。
 */
export function dockBounds(area: DockArea, edge: DockEdge, mode: DockMode): DockBounds {
  if (edge === "top") {
    const w = Math.min(area.w, TOP_MODE_W[mode]);
    const h = Math.min(area.h, TOP_MODE_H[mode]);
    return { x: area.x + Math.round((area.w - w) / 2), y: area.y, w, h };
  }
  const h = Math.min(area.h, MODE_H[mode]);
  const w = MODE_W[mode];
  const y = area.y + Math.round((area.h - h) / 2);
  const x = edge === "left" ? area.x : Math.round(area.x + area.w - w);
  return { x, y, w, h };
}

/** 弹簧动画的起止矩形：只变 x/宽度，y/高度保持不动。 */
export function dockSpringPair(area: DockArea, edge: DockEdge, from: DockMode, to: DockMode): { from: DockBounds; to: DockBounds } {
  return { from: dockBounds(area, edge, from), to: dockBounds(area, edge, to) };
}
