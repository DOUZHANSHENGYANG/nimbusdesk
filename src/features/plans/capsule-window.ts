/** Read normal paper geometry without allowing an older IPC response to save edge-tab dimensions. */
interface PaperGeometryWindow {
  outerPosition(): Promise<{ x: number; y: number }>;
  innerSize(): Promise<{ width: number; height: number }>;
  scaleFactor(): Promise<number>;
}

export const COLLAPSED_PAPER_H = 116;

export async function normalPaperGeometry(
  win: PaperGeometryWindow,
  current: () => { active: boolean; collapsed: boolean },
): Promise<{ x: number; y: number; w: number; h?: number } | null> {
  const before = current();
  if (!before.active) return null;
  const [pos, size, factor] = await Promise.all([win.outerPosition(), win.innerSize(), win.scaleFactor()]);
  const after = current();
  if (!after.active || before.collapsed !== after.collapsed || !Number.isFinite(factor) || factor <= 0) return null;
  if (![pos.x, pos.y, size.width, size.height].every(Number.isFinite)) return null;
  return {
    x: Math.round(pos.x / factor),
    y: Math.round(pos.y / factor),
    w: Math.round(size.width / factor),
    // Collapsing changes only the displayed height, never the saved expanded size.
    ...(!after.collapsed ? { h: Math.round(size.height / factor) } : {}),
  };
}
