import { desktopEntries, saveDockPosition } from "./registry";
import { useEdgeWorkspace } from "./edge-workspace";
import { groupKey, planQueue, type MonitorArea, type QueueEdge, type QueueGroup } from "./queue-core";

export function queueSnapshot(id: string, area: MonitorArea, edge: QueueEdge) {
  const key = groupKey(area.id, edge);
  const members = desktopEntries().filter(entry => entry.form === "capsule" && entry.edge === edge && (entry.edgeMonitor === area.id || entry.id === id));
  const group = useEdgeWorkspace.getState().groups[key] ?? { monitorId: area.id, edge, offset: 48, collapsed: false, order: [] };
  const layout = planQueue(area, group, members);
  return { key, group, members, layout, slot: layout.slots.find(slot => slot.id === id) };
}

export function reserveQueue(id: string, area: MonitorArea, edge: QueueEdge) {
  saveDockPosition(id, { edge, edgeMonitor: area.id });
  const snapshot = queueSnapshot(id, area, edge);
  if (!useEdgeWorkspace.getState().groups[snapshot.key]) useEdgeWorkspace.getState().updateGroup(snapshot.key, snapshot.group);
  return snapshot;
}

function anchorVisible(snapshot: ReturnType<typeof queueSnapshot>) {
  for (const slot of snapshot.layout.slots) if (slot.visible) saveDockPosition(slot.id, { dockOffset: slot.y });
}

export function moveDockItem(id: string, area: MonitorArea, edge: QueueEdge, y?: number, index?: number, sourceArea?: MonitorArea) {
  const entries = desktopEntries(), entry = entries.find(member => member.id === id);
  const sourceLocked = entries.some(member => member.locked && member.form === "capsule" && member.edgeMonitor === entry?.edgeMonitor && member.edge === entry?.edge);
  const snapshot = queueSnapshot(id, area, edge);
  if (entry?.locked || (index !== undefined && (sourceLocked || snapshot.members.some(member => member.locked)))) return false;
  const source = queueSnapshot(id, sourceArea ?? { ...area, id: entry?.edgeMonitor ?? area.id }, entry?.edge ?? edge);
  const ownSlot = source.slot;
  anchorVisible(source); anchorVisible(snapshot);
  const otherSlots = snapshot.layout.slots.filter(slot => slot.id !== id && slot.visible);
  const at = index ?? (y === undefined ? snapshot.layout.order.length : otherSlots.filter(slot => y > slot.y + slot.h / 2).length);
  const targetSlot = index === undefined ? undefined : snapshot.layout.slots.find(slot => slot.id === snapshot.layout.order[at]);
  if (targetSlot && targetSlot.id !== id && ownSlot?.visible) saveDockPosition(targetSlot.id, { dockOffset: ownSlot.y });
  const last = otherSlots[otherSlots.length - 1];
  const offset = y ?? targetSlot?.y ?? ownSlot?.y ?? (last ? last.y + last.h + 4 : snapshot.group.offset + snapshot.layout.hubH + 4);
  useEdgeWorkspace.getState().moveMember(id, snapshot.key, at, snapshot.group, snapshot.layout.order);
  useEdgeWorkspace.getState().setCollapsed(snapshot.key, false);
  saveDockPosition(id, { edge, edgeY: offset, dockOffset: offset, edgeMonitor: area.id });
  return true;
}

export function moveDockGroup(sourceKey: string, target: MonitorArea, edge: QueueEdge, offset: number, reason: "user" | "monitor-recovery" = "user", sourceArea?: MonitorArea) {
  const source = useEdgeWorkspace.getState().groups[sourceKey];
  if (!source) return false;
  const members = desktopEntries().filter(entry => entry.form === "capsule" && entry.edgeMonitor === source.monitorId && entry.edge === source.edge);
  if (reason === "user" && (members.some(member => member.locked) || desktopEntries().some(entry => entry.locked && entry.form === "capsule" && entry.edgeMonitor === target.id && entry.edge === edge))) return false;
  // Ordering is independent of work-area dimensions; normalize legacy implicit order too.
  const sourceLayout = planQueue(sourceArea ?? target, { ...source, collapsed: false }, members);
  const sourceOrder = sourceLayout.order;
  const key = groupKey(target.id, edge);
  const other = useEdgeWorkspace.getState().groups[key];
  const destination: QueueGroup = { monitorId: target.id, edge, collapsed: source.collapsed, offset, order: [...sourceOrder, ...(other?.order ?? []).filter(id => !sourceOrder.includes(id))] };
  for (const member of members) {
    const slot = sourceLayout.slots.find(slot => slot.id === member.id && slot.visible);
    const previous = slot?.y ?? (Number.isFinite(member.dockOffset) ? member.dockOffset : undefined);
    saveDockPosition(member.id, { edge, edgeMonitor: target.id, dockOffset: previous === undefined ? undefined : Math.max(0, previous + offset - sourceLayout.hubY) });
  }
  if (sourceKey !== key) useEdgeWorkspace.getState().updateGroup(sourceKey, { order: [] });
  useEdgeWorkspace.getState().updateGroup(key, destination);
  return true;
}
