export type FenceViewMode = "icons" | "list";
export const FENCE_GAP = 6;

/** A list row shares the grid's paging/keyboard model, with a single column. */
export function fenceLayout(mode: FenceViewMode, scale: number, width: number, height: number) {
  const list = mode === "list";
  const cellW = list ? Math.max(1, width) : Math.max(64, Math.round(78 * scale));
  const cellH = list ? Math.max(30, Math.round(34 * scale)) : Math.max(80, Math.round(94 * scale));
  const cols = list ? 1 : Math.max(1, Math.floor((width + FENCE_GAP) / (cellW + FENCE_GAP)));
  const rows = Math.max(1, Math.floor((height + FENCE_GAP) / (cellH + FENCE_GAP)));
  return { cellW, cellH, cols, rows, pageSize: cols * rows, iconSize: Math.round((list ? 22 : 34) * scale) };
}

export function fenceInsertionBefore(mode: FenceViewMode, rect: Pick<DOMRect, "left" | "top" | "bottom" | "width" | "height">, x: number, y: number) {
  return mode === "list" ? y < rect.top + rect.height / 2 : y < rect.bottom && (y < rect.top || x < rect.left + rect.width / 2);
}
