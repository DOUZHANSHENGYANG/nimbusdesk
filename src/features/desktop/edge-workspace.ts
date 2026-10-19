import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { onStorageSynced, tauriJsonStorage } from "@/lib/storage";
import type { QueueGroup } from "./queue-core";

interface EdgeWorkspace {
  groups: Record<string, QueueGroup>;
  updateGroup: (key: string, partial: Partial<QueueGroup>) => void;
  moveMember: (id: string, targetKey: string, index: number, seed: QueueGroup, currentOrder?: string[]) => void;
  setCollapsed: (key: string, value: boolean) => void;
  setOffset: (key: string, value: number) => void;
}

const emptyGroup = (): QueueGroup => ({ monitorId: "", edge: "right", order: [], offset: 48, collapsed: false });
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function cleanGroup(value: unknown): QueueGroup | null {
  if (!isRecord(value) || typeof value.monitorId !== "string" || (value.edge !== "left" && value.edge !== "right" && value.edge !== "top")) return null;
  return {
    monitorId: value.monitorId,
    edge: value.edge,
    order: Array.isArray(value.order) ? [...new Set(value.order.filter((id): id is string => typeof id === "string"))] : [],
    offset: typeof value.offset === "number" && Number.isFinite(value.offset) ? Math.max(0, value.offset) : 48,
    collapsed: value.collapsed === true,
  };
}

function cleanGroups(value: unknown): Record<string, QueueGroup> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, raw]) => {
    const group = cleanGroup(raw);
    return group ? [[key, group]] : [];
  }));
}

export const useEdgeWorkspace = create<EdgeWorkspace>()(persist((set, get) => ({
  groups: {},
  updateGroup: (key, partial) => set(state => {
    const group = cleanGroup({ ...(state.groups[key] ?? emptyGroup()), ...partial });
    return group ? { groups: { ...state.groups, [key]: group } } : {};
  }),
  moveMember: (id, targetKey, index, seed, currentOrder) => set(state => {
    const target = state.groups[targetKey] ?? cleanGroup(seed) ?? emptyGroup();
    const groups = Object.fromEntries(Object.entries(state.groups).map(([key, group]) => [key, { ...group, order: group.order.filter(member => member !== id) }]));
    const order = [...new Set(currentOrder ?? target.order)].filter(member => member !== id);
    const position = Number.isNaN(index) ? order.length : Math.min(order.length, Math.max(0, Math.trunc(index)));
    order.splice(position, 0, id);
    groups[targetKey] = { ...target, order };
    return { groups };
  }),
  setCollapsed: (key, collapsed) => get().updateGroup(key, { collapsed }),
  setOffset: (key, offset) => get().updateGroup(key, { offset }),
}), {
  name: "edge-workspace",
  version: 1,
  storage: createJSONStorage(() => tauriJsonStorage),
  partialize: state => ({ groups: state.groups }),
  merge: (persisted, current) => ({ ...current, groups: cleanGroups(isRecord(persisted) ? persisted.groups : undefined) }),
}));

onStorageSynced((key, value) => {
  if (key !== "edge-workspace" || !isRecord(value) || !isRecord(value.state) || !isRecord(value.state.groups)) return;
  // storage.ts applies these callbacks under its synchronous echo-suppression guard.
  useEdgeWorkspace.setState({ groups: cleanGroups(value.state.groups) });
});
