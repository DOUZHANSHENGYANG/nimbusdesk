export interface NormalRect { x: number; y: number; w: number; h: number }
export interface WorkArea extends NormalRect { scale: number }
export type Edge = "left" | "right" | "top";
export const EDGE_TAB_W = 112;
export const EDGE_TAB_H = 44;
export function allocateEdgeY(id: string, slots: { id: string; y?: number }[], preferred?: number): number {
  const used = slots.filter(slot => slot.id !== id && slot.y !== undefined).map(slot => slot.y!);
  if (preferred !== undefined && !used.some(y => Math.abs(y - preferred) < EDGE_TAB_H + 4)) return preferred;
  let result = 48;
  for (const slot of [...slots.filter(slot => slot.y === undefined), { id }].filter((slot, index, all) => all.findIndex(item => item.id === slot.id) === index).sort((a, b) => a.id.localeCompare(b.id))) {
    let y = 48;
    while (used.some(value => Math.abs(value - y) < EDGE_TAB_H + 4)) y += EDGE_TAB_H + 4;
    if (slot.id === id) result = y;
    used.push(y);
  }
  return result;
}

const queues = new Map<string, Promise<void>>();
/** Shared across React lifetimes: an old resize must finish before a new form writes. */
export function queueWindowOperation(label: string, operation: () => Promise<void>): Promise<void> {
  const next = (queues.get(label) ?? Promise.resolve()).catch(() => undefined).then(operation);
  queues.set(label, next);
  void next.finally(() => { if (queues.get(label) === next) queues.delete(label); }).catch(() => undefined);
  return next;
}

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), Math.max(min, max));
export function edgeBounds(area: WorkArea, edge: Edge, y: number, opened: boolean, normal: NormalRect, tabHeight = EDGE_TAB_H, tabWidth = EDGE_TAB_W): NormalRect {
  const s = area.scale;
  const width = clamp(Number.isFinite(tabWidth) ? tabWidth : EDGE_TAB_W, 96, 280);
  if (edge === "top") {
    const w = Math.min(area.w, Math.round((opened ? Math.max(width, clamp(normal.w, 280, 900)) : width) * s));
    const h = Math.min(area.h, Math.round((opened ? clamp(normal.h, 240, 1000) + tabHeight : tabHeight) * s));
    return { x: Math.round(clamp(area.x + y * s, area.x, area.x + area.w - w)), y: Math.round(area.y), w, h };
  }
  const w = Math.min(area.w, Math.round((opened ? clamp(normal.w, 280, 900) + width : width) * s));
  const h = Math.min(area.h, Math.round((opened ? clamp(normal.h, 240, 1000) : tabHeight) * s));
  return { x: Math.round(edge === "left" ? area.x : area.x + area.w - w), y: Math.round(clamp(area.y + y * s, area.y, area.y + area.h - h)), w, h };
}

/** Keep the sticky arrow under a stationary pointer when a bottom preview grows upward. */
export function edgeTabOffset(area: WorkArea, y: number, normal: NormalRect, tabHeight = EDGE_TAB_H, edge: Edge = "left", tabWidth = EDGE_TAB_W): number {
  const closed = edgeBounds(area, edge, y, false, normal, tabHeight, tabWidth);
  const opened = edgeBounds(area, edge, y, true, normal, tabHeight, tabWidth);
  return (edge === "top" ? closed.x - opened.x : closed.y - opened.y) / area.scale;
}

/** All coordinates are physical; the bottom edge intentionally remains unsupported. */
export function nearestDockEdge(rect: NormalRect, area: NormalRect): Edge {
  const candidates: { edge: Edge; distance: number }[] = [
    { edge: "top", distance: Math.abs(rect.y - area.y) },
    { edge: "left", distance: Math.abs(rect.x - area.x) },
    { edge: "right", distance: Math.abs(rect.x + rect.w - area.x - area.w) },
  ];
  return candidates.reduce((nearest, candidate) => candidate.distance < nearest.distance ? candidate : nearest).edge;
}

export interface EdgePort {
  label: string;
  monitor(): Promise<WorkArea | null>;
  ignore(value: boolean): Promise<void>;
  size(rect: NormalRect): Promise<void>;
  position(rect: NormalRect): Promise<void>;
  layer(pinned: boolean, valid: () => boolean): Promise<void>;
  resize?(allowed: boolean): Promise<void>;
  show(mode?: "dock" | "normal"): Promise<void>;
}

/** Every awaited native write checks the latest intent before continuing. No animation IPC. */
export class EdgeController {
  private generation = 0;
  private disposed = false;
  private area: WorkArea | null = null;
  constructor(private port: EdgePort, private normal: () => NormalRect,
    private appearance: () => { tabWidth?: number; tabHeight?: number; previewWidth?: number; previewHeight?: number } = () => ({})) {}
  dispose() { this.disposed = true; this.generation++; }

  place(opened: boolean, edge: Edge, y: number, span?: number): Promise<void> {
    return this.perform(async valid => {
      this.area = await this.port.monitor() ?? this.area;
      if (!valid()) return;
      if (!this.area) throw new Error("Cannot locate the screen work area");
      const normal = this.normal(), appearance = this.appearance();
      const tabHeight = edge === "top" ? appearance.tabHeight ?? EDGE_TAB_H : span ?? appearance.tabHeight ?? EDGE_TAB_H;
      const tabWidth = edge === "top" ? span ?? appearance.tabWidth : appearance.tabWidth;
      const rect = edgeBounds(this.area, edge, y, opened, { ...normal, w: appearance.previewWidth ?? normal.w, h: appearance.previewHeight ?? normal.h }, tabHeight, tabWidth);
      await this.port.ignore(false); if (!valid()) return;
      await this.port.resize?.(false); if (!valid()) return;
      await this.port.layer(true, valid); if (!valid()) return;
      await this.port.size(rect); if (!valid()) return;
      await this.port.position(rect); if (!valid()) return;
      await this.port.show("dock");
    });
  }

  restore(pinned: boolean): Promise<void> {
    return this.perform(async valid => {
      this.area = await this.port.monitor() ?? this.area; if (!valid()) return;
      const a = this.area, n = this.normal(), s = a?.scale ?? 1;
      const rect = { x: Math.round(n.x * s), y: Math.round(n.y * s), w: Math.round(n.w * s), h: Math.round(n.h * s) };
      if (a) { rect.w = Math.min(rect.w, a.w); rect.h = Math.min(rect.h, a.h); rect.x = clamp(rect.x, a.x, a.x + a.w - rect.w); rect.y = clamp(rect.y, a.y, a.y + a.h - rect.h); }
      await this.port.ignore(false); if (!valid()) return;
      await this.port.resize?.(true); if (!valid()) return;
      await this.port.size(rect); if (!valid()) return;
      await this.port.position(rect); if (!valid()) return;
      await this.port.layer(pinned, valid); if (!valid()) return;
      await this.port.show("normal");
    });
  }

  private perform(operation: (valid: () => boolean) => Promise<void>): Promise<void> {
    const generation = ++this.generation;
    const valid = () => !this.disposed && this.generation === generation;
    return queueWindowOperation(this.port.label, async () => { if (valid()) await operation(valid); });
  }
}
