export type QueueEdge = "left" | "right";

/** Native monitor work areas always use physical pixels. */
export interface MonitorArea {
  id: string;
  name?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

export interface QueueGroup {
  monitorId: string;
  edge: QueueEdge;
  order: string[];
  offset: number;
  collapsed: boolean;
}

export interface QueueMember {
  id: string;
  edge?: QueueEdge;
  edgeMonitor?: string;
  edgeY?: number;
  locked?: boolean;
}

const GAP = 4;
const HUB_HEIGHT = 40;
export const HUB_WIDTH = 44;
const MIN_TAB_HEIGHT = 40;
const MAX_TAB_HEIGHT = 44;
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** Reversible UTF-8 hex avoids unsafe Tauri label characters and hash collisions. */
export function groupKey(monitorId: string, edge: QueueEdge): string {
  return Array.from(new TextEncoder().encode(JSON.stringify([monitorId, edge])), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function monitorAt(point: { x: number; y: number }, monitors: MonitorArea[]): MonitorArea | null {
  const contains = monitors.find(area => point.x >= area.x && point.x < area.x + area.w && point.y >= area.y && point.y < area.y + area.h);
  if (contains) return contains;
  let nearest: MonitorArea | null = null;
  let distance = Infinity;
  for (const area of monitors) {
    const dx = Math.max(area.x - point.x, 0, point.x - area.x - area.w);
    const dy = Math.max(area.y - point.y, 0, point.y - area.y - area.h);
    const next = dx * dx + dy * dy;
    if (next < distance) { distance = next; nearest = area; }
  }
  return nearest;
}

export function insertionOrder(order: string[], id: string, index: number): string[] {
  const result = [...new Set(order)].filter(member => member !== id);
  const position = Number.isNaN(index) ? result.length : clamp(Math.trunc(index), 0, result.length);
  result.splice(position, 0, id);
  return result;
}

/** Returned geometry is logical and relative to the work area's top edge. */
export function planQueue(area: MonitorArea, group: QueueGroup, members: QueueMember[]): {
  order: string[];
  slots: { id: string; y: number; h: number; visible: boolean }[];
  hubY: number;
  hubH: number;
  overflow: string[];
} {
  const byId = new Map<string, QueueMember>();
  for (const member of members) {
    if (member.edge && member.edge !== group.edge) continue;
    if (member.edgeMonitor && member.edgeMonitor !== group.monitorId) continue;
    if (!byId.has(member.id)) byId.set(member.id, member);
  }
  const saved = [...new Set(group.order)].filter(id => byId.has(id));
  const savedIds = new Set(saved);
  const missing = [...byId.values()].filter(member => !savedIds.has(member.id)).sort((a, b) => {
    const ay = Number.isFinite(a.edgeY) ? a.edgeY! : Infinity;
    const by = Number.isFinite(b.edgeY) ? b.edgeY! : Infinity;
    return (ay === by ? 0 : ay - by) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const order = [...saved, ...missing.map(member => member.id)];
  const scale = Number.isFinite(area.scale) && area.scale > 0 ? area.scale : 1;
  const height = Number.isFinite(area.h) ? Math.max(0, area.h / scale) : 0;
  const hubH = Math.min(HUB_HEIGHT, height);
  const capacity = Math.max(0, Math.floor((height - hubH) / (MIN_TAB_HEIGHT + GAP)));
  const count = group.collapsed ? 0 : Math.min(order.length, capacity);
  const minimumHeight = hubH + count * (MIN_TAB_HEIGHT + GAP);
  const offset = Number.isFinite(group.offset) ? group.offset : 48;
  const hubY = clamp(offset, 0, height - minimumHeight);
  const tabH = count ? Math.min(MAX_TAB_HEIGHT, (height - hubY - hubH - count * GAP) / count) : 0;
  return {
    order,
    slots: order.map((id, index) => ({
      id,
      // Invisible entries have inert geometry; only overflow controls open them.
      y: index < count ? hubY + hubH + GAP + index * (tabH + GAP) : hubY,
      h: index < count ? tabH : 0,
      visible: index < count,
    })),
    hubY,
    hubH,
    overflow: order.slice(count),
  };
}
