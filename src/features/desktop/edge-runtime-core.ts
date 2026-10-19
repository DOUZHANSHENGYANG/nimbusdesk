import { groupKey, HUB_WIDTH, monitorAt, type MonitorArea, type QueueEdge, type QueueGroup, type QueueMember } from "./queue-core";
import { nearestDockEdge } from "./edge-core";

const validKey = (key: string) => /^[0-9a-fA-F]{1,512}$/.test(key);

export function hubKeyFromLabel(label: string): string | null {
  const key = label.startsWith("edge-hub-") ? label.slice(9) : "";
  return validKey(key) ? key : null;
}

export function desiredHubKeys(groups: Record<string, QueueGroup>, members: (QueueMember & { form: string })[]): string[] {
  const occupied = new Set(members.filter(member => member.form === "capsule" && member.edgeMonitor && member.edge).map(member => groupKey(member.edgeMonitor!, member.edge!)));
  return Object.entries(groups).filter(([key, group]) => validKey(key) && key === groupKey(group.monitorId, group.edge) && occupied.has(key)).map(([key]) => key);
}

/** Existing windows may be intentionally hidden: never issue open/show for them. */
export function hubWindowChanges(desiredKeys: string[], labels: string[]): { open: string[]; close: string[] } {
  const desired = new Set(desiredKeys.filter(validKey));
  const existing = new Set(labels.map(hubKeyFromLabel).filter((key): key is string => key !== null));
  return { open: [...desired].filter(key => !existing.has(key)), close: [...existing].filter(key => !desired.has(key)) };
}

export function sameMonitors(a: MonitorArea[], b: MonitorArea[]): boolean {
  const signature = (areas: MonitorArea[]) => JSON.stringify(areas.map(area => [area.id, area.name ?? "", area.x, area.y, area.w, area.h, area.scale]).sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
  return signature(a) === signature(b);
}

export function groupDragDestination(rect: { x: number; y: number; w: number; h: number }, monitors: MonitorArea[]) {
  const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  const area = monitorAt(center, monitors);
  if (!area) return null;
  const edge = nearestDockEdge(rect, area);
  const scale = Number.isFinite(area.scale) && area.scale > 0 ? area.scale : 1;
  return { area, edge, offset: Math.max(0, (edge === "top" ? rect.x - area.x : rect.y - area.y) / scale) };
}

/** Physical bounds: top queues use a horizontal anchor, side queues a vertical one. */
export function hubBounds(area: MonitorArea, edge: QueueEdge, offset: number, menu: boolean, count: number) {
  const scale = Number.isFinite(area.scale) && area.scale > 0 ? area.scale : 1;
  const logicalW = area.w / scale, logicalH = area.h / scale;
  const w = Math.min(menu ? 280 : HUB_WIDTH, logicalW);
  const h = Math.min(menu ? Math.max(264, Math.min(560, 176 + count * 32)) : 40, logicalH);
  const anchor = Number.isFinite(offset) ? offset : 0;
  const x = edge === "top" ? area.x + Math.max(0, Math.min(anchor, logicalW - w)) * scale
    : edge === "left" ? area.x : area.x + area.w - w * scale;
  const y = edge === "top" ? area.y : area.y + Math.max(0, Math.min(anchor, logicalH - h)) * scale;
  return { x: Math.round(x), y: Math.round(y), w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}
