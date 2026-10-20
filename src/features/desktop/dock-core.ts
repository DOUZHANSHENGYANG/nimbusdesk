/** Dock 几何：全部逻辑像素，与 edge-core 的 MonitorArea 同一口径。 */

export type DockEdge = "left" | "right" | "top";
export interface DockArea { x: number; y: number; w: number; h: number; scale?: number }
export interface DockBounds { x: number; y: number; w: number; h: number }

/** 三种窗口形态：纯图标条 / 悬停预览（带标签）/ 飞出面板（栅格、计划）。 */
export type DockMode = "strip" | "expand" | "flyout";
export type DockPanel = "fences" | "plans" | "projects" | "capture";

/** 侧边栏常驻「图标 + 文字」，高度贴合内容（六个图标 + 关闭钮），不拉满工作区。 */
export const DOCK_RAIL_W = 134;
export const DOCK_RAIL_H = 288;
export const DOCK_FLYOUT_W = 408;
export const DOCK_FLYOUT_MAX_H = 640;
/** 顶缘横排的尺寸：宽度自适应屏幕，高度贴合内容。 */
export const DOCK_TOP_W = 560;
const TOP_MODE_W: Record<DockMode, number> = { strip: DOCK_TOP_W, expand: DOCK_TOP_W, flyout: DOCK_FLYOUT_W };
const TOP_MODE_H: Record<DockMode, number> = { strip: 64, expand: 64, flyout: DOCK_FLYOUT_MAX_H };
/** 展开面板里每行的高度，供图标布局对齐。 */
export const DOCK_ROW_H = 44;
/** 锚定弹出时，面板前缘与触发图标中心保持的距离（逻辑像素）。保留给未来用。 */
const ANCHOR_LEAD = 48;

const MODE_W: Record<DockMode, number> = { strip: DOCK_RAIL_W, expand: DOCK_RAIL_W, flyout: DOCK_FLYOUT_W };
const MODE_H: Record<DockMode, number> = { strip: DOCK_RAIL_H, expand: DOCK_RAIL_H, flyout: DOCK_RAIL_H };

/**
 * 三种形态的窗口矩形。侧边栏常驻「图标 + 文字」（strip 与 expand 同尺寸）；
 * 飞出面板在锚定图标旁弹出，其余形态在工作区居中。
 * 顶缘是水平横排：锚定顶边界。绝不越过工作区。
 */
export function dockBounds(area: DockArea, edge: DockEdge, mode: DockMode, anchor?: number): DockBounds {
  const lead = mode === "flyout" ? anchor : undefined;
  if (edge === "top") {
    const w = Math.min(area.w, TOP_MODE_W[mode]);
    const h = Math.min(area.h, TOP_MODE_H[mode]);
    const x = lead === undefined
      ? area.x + Math.round((area.w - w) / 2)
      : Math.min(Math.max(Math.round(lead - ANCHOR_LEAD), area.x), area.x + area.w - w);
    return { x, y: area.y, w, h };
  }
  const h = Math.min(area.h, MODE_H[mode]);
  const w = MODE_W[mode];
  const y = lead === undefined
    ? area.y + Math.round((area.h - h) / 2)
    : Math.min(Math.max(Math.round(lead - ANCHOR_LEAD), area.y), area.y + area.h - h);
  const x = edge === "left" ? area.x : Math.round(area.x + area.w - w);
  return { x, y, w, h };
}

/** 弹簧动画的起止矩形：只变 x/宽度，y/高度保持不动（顶缘直接落位，不走弹簧）。 */
export function dockSpringPair(area: DockArea, edge: DockEdge, from: DockMode, to: DockMode, anchor?: number): { from: DockBounds; to: DockBounds } {
  return { from: dockBounds(area, edge, from, anchor), to: dockBounds(area, edge, to, anchor) };
}
