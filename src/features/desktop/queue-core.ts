export type QueueEdge = "left" | "right" | "top";

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
  /** Logical coordinate along the selected edge; absent records retain compact queue placement. */
  dockOffset?: number;
  locked?: boolean;
  tabHeight?: number;
  tabWidth?: number;
}

const GAP = 4;
const HUB_HEIGHT = 40;
export const HUB_WIDTH = 44;
const MIN_TAB_HEIGHT = 40;
const MAX_TAB_HEIGHT = 120;
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

/** Find the closest non-overlapping logical position, leaving the outer screen edges usable. */
function freePosition(length: number, span: number, preferred: number, occupied: { y: number; h: number }[]): number | undefined {
  let start = 0, nearest: number | undefined, distance = Infinity;
  const consider = (end: number) => {
    if (end - start < span - 1e-8) return;
    const next = clamp(preferred, start, end - span), delta = Math.abs(next - preferred);
    if (delta < distance) { nearest = next; distance = delta; }
  };
  for (const slot of [...occupied].sort((a, b) => a.y - b.y)) {
    consider(slot.y - GAP);
    start = Math.max(start, slot.y + slot.h + GAP);
  }
  consider(length);
  return nearest;
}

function anchoredQueue(length: number, hubH: number, offset: number, order: string[], byId: Map<string, QueueMember>, spans: number[], minimum: number) {
  const capacity = Math.max(0, Math.floor((length - hubH) / (minimum + GAP)));
  const priority = [...order].sort((a, b) => {
    const first = byId.get(a)!, second = byId.get(b)!;
    return Number(Boolean(second.locked)) - Number(Boolean(first.locked))
      || Number(Number.isFinite(second.dockOffset)) - Number(Number.isFinite(first.dockOffset));
  }).slice(0, capacity);
  const extra = priority.reduce((sum, id) => sum + spans[order.indexOf(id)] - minimum, 0);
  const budget = Math.max(0, length - hubH - priority.length * (minimum + GAP));
  const ratio = extra ? Math.min(1, budget / extra) : 0;
  const spanFor = (id: string) => minimum + (spans[order.indexOf(id)] - minimum) * ratio;
  const occupied = new Map<string, { y: number; h: number }>();
  const place = (id: string, preferred: number) => {
    const h = spanFor(id), y = freePosition(length, h, preferred, [...occupied.values()]);
    if (y !== undefined) occupied.set(id, { y, h });
  };
  const locked = priority.filter(id => byId.get(id)!.locked && Number.isFinite(byId.get(id)!.dockOffset));
  for (const id of locked) place(id, byId.get(id)!.dockOffset!);
  let hubY = freePosition(length, hubH, offset, [...occupied.values()]);
  // Even a fully occupied edge must keep an entry point to overflow and restore controls.
  while (hubY === undefined && occupied.size) {
    const ids = [...occupied.keys()];
    occupied.delete(ids[ids.length - 1]);
    hubY = freePosition(length, hubH, offset, [...occupied.values()]);
  }
  hubY ??= 0;
  const withHub = () => [{ y: hubY, h: hubH }, ...occupied.values()];
  for (const id of priority) {
    if (occupied.has(id)) continue;
    const member = byId.get(id)!, h = spanFor(id);
    const preferred = Number.isFinite(member.dockOffset) ? member.dockOffset! : hubY + hubH + GAP;
    const y = freePosition(length, h, preferred, withHub());
    if (y !== undefined) occupied.set(id, { y, h });
  }
  const slots = order.map(id => ({ id, ...(occupied.get(id) ?? { y: hubY, h: 0 }), visible: occupied.has(id) }));
  return { order, slots, hubY, hubH, overflow: order.filter(id => !occupied.has(id)) };
}

/** Returned y/h values are logical coordinate/span along the edge: horizontal for top docking. */
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
    const ay = Number.isFinite(a.dockOffset) ? a.dockOffset! : Number.isFinite(a.edgeY) ? a.edgeY! : Infinity;
    const by = Number.isFinite(b.dockOffset) ? b.dockOffset! : Number.isFinite(b.edgeY) ? b.edgeY! : Infinity;
    return (ay === by ? 0 : ay - by) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const order = [...saved, ...missing.map(member => member.id)];
  const scale = Number.isFinite(area.scale) && area.scale > 0 ? area.scale : 1;
  const top = group.edge === "top", extent = top ? area.w : area.h;
  const height = Number.isFinite(extent) ? Math.max(0, extent / scale) : 0;
  const minimum = top ? 96 : MIN_TAB_HEIGHT, maximum = top ? 280 : MAX_TAB_HEIGHT;
  const hubH = Math.min(top ? HUB_WIDTH : HUB_HEIGHT, height);
  const offset = Number.isFinite(group.offset) ? group.offset : 48;
  const spans = order.map(id => {
    const member = byId.get(id)!, value = top ? member.tabWidth : member.tabHeight;
    return clamp(Number.isFinite(value) ? value! : top ? 112 : 44, minimum, maximum);
  });
  if (!group.collapsed && order.some(id => Number.isFinite(byId.get(id)!.dockOffset))) {
    return anchoredQueue(height, hubH, offset, order, byId, spans, minimum);
  }
  const capacity = Math.max(0, Math.floor((height - hubH) / (minimum + GAP)));
  const count = group.collapsed ? 0 : Math.min(order.length, capacity);
  const heights = spans.slice(0, count);
  const wanted = heights.reduce((sum, h) => sum + h + GAP, hubH);
  const hubY = clamp(offset, 0, Math.max(0, height - wanted));
  const extra = heights.reduce((sum, h) => sum + h - minimum, 0);
  const budget = Math.max(0, height - hubY - hubH - count * (minimum + GAP));
  const ratio = extra ? Math.min(1, budget / extra) : 0;
  let nextY = hubY + hubH + GAP;
  const slots = order.map((id, index) => {
    const visible = index < count, h = visible ? minimum + (heights[index] - minimum) * ratio : 0;
    const slot = { id, y: visible ? nextY : hubY, h, visible };
    if (visible) nextY += h + GAP;
    return slot;
  });
  return {
    order,
    slots,
    hubY,
    hubH,
    overflow: order.slice(count),
  };
}
