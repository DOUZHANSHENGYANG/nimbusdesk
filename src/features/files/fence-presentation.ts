import type { BoxAppearance } from "./box-appearance";

export type FenceViewMode = "icons" | "list";
export const FENCE_GAP = 6;

/**
 * A list row shares the grid's paging/keyboard model, with a single column.
 *
 * `appearance` is optional on purpose: old fences and the existing tests call
 * the three-argument form and must keep the original geometry. When a box has
 * an appearance record, its icon size and “no text” mode participate in the
 * cell size so the grid never clips.
 */
export function fenceLayout(
  mode: FenceViewMode,
  scale: number,
  width: number,
  height: number,
  appearance?: Pick<BoxAppearance, "iconSize" | "nameMode">,
) {
  const list = mode === "list";
  const baseIcon = appearance?.iconSize ?? (list ? 22 : 34);
  const iconSize = Math.max(14, Math.round(baseIcon * scale));
  const noText = appearance?.nameMode === "none";
  const cellW = list ? Math.max(1, width) : Math.max(64, Math.round(iconSize * 2.3));
  const cellH = list
    ? Math.max(30, Math.round(34 * scale))
    : noText
      ? Math.max(40, Math.round(iconSize + 12))
      : Math.max(64, Math.round(iconSize * 2.76));
  const cols = list ? 1 : Math.max(1, Math.floor((width + FENCE_GAP) / (cellW + FENCE_GAP)));
  const rows = Math.max(1, Math.floor((height + FENCE_GAP) / (cellH + FENCE_GAP)));
  return { cellW, cellH, cols, rows, pageSize: cols * rows, iconSize };
}

export function fenceInsertionBefore(mode: FenceViewMode, rect: Pick<DOMRect, "left" | "top" | "bottom" | "width" | "height">, x: number, y: number) {
  return mode === "list" ? y < rect.top + rect.height / 2 : y < rect.bottom && (y < rect.top || x < rect.left + rect.width / 2);
}
