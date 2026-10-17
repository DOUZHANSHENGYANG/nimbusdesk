import { groupKey, monitorAt, type MonitorArea, type QueueGroup, type QueueMember } from "./queue-core";

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
  return { area, edge: center.x < area.x + area.w / 2 ? "left" as const : "right" as const, offset: Math.max(0, (rect.y - area.y) / area.scale) };
}
