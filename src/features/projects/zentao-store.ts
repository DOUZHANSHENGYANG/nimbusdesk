import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { onStorageSynced, tauriJsonStorage } from "@/lib/storage";
import { useStorageHealth } from "@/stores/storage-health";
import { useProjects } from "./store";
import { normalizeZenUrl, validateZenConnections } from "./zentao-core";
import { emptyZenSyncMeta, type ZenConnection, type ZenConnectionData } from "./zentao-types";

interface Store extends ZenConnectionData {
  addConnection(input: Partial<ZenConnection>): string;
  updateConnection(id: string, patch: Partial<ZenConnection>): void;
  removeConnection(id: string): void;
}
export function zenConnectionData(s: ZenConnectionData): ZenConnectionData { return { connections: s.connections, syncStates: s.syncStates }; }
export const useZentao = create<Store>()(persist<Store, [], [], ZenConnectionData>((set) => {
  function change(fn: (d: ZenConnectionData) => ZenConnectionData) {
    if (!useZentao.persist.hasHydrated() || !useProjects.persist.hasHydrated()) throw new Error("Project connections are still loading");
    set(s => { const d = fn(zenConnectionData(s)); validateZenConnections(d); return d; });
  }
  return {
    connections: [], syncStates: {},
    addConnection(input) {
      const now = Date.now(), id = crypto.randomUUID();
      const c: ZenConnection = { name: "禅道", baseUrl: "", account: "", apiVersion: "auto", executionIds: [], autoSync: false, syncMinutes: 15, ...input, id, createdAt: now, updatedAt: now };
      if (c.baseUrl) c.baseUrl = normalizeZenUrl(c.baseUrl);
      change(d => ({ ...d, connections: [...d.connections, c], syncStates: { ...d.syncStates, [id]: emptyZenSyncMeta() } })); return id;
    },
    updateConnection(id, patch) { change(d => ({ ...d, connections: d.connections.map(c => {
      if (c.id !== id) return c;
      const next = { ...c, ...patch, id: c.id, createdAt: c.createdAt, updatedAt: Date.now() };
      if (next.baseUrl) next.baseUrl = normalizeZenUrl(next.baseUrl);
      if (useProjects.getState().remoteTasks.some(t => t.connectionId === id) && (next.baseUrl !== c.baseUrl || next.account !== c.account)) throw new Error("Create another connection to change the instance or account");
      return next;
    }) })); if (patch.writeFields !== undefined) useProjects.getState().refreshWriteback?.(); },
    removeConnection(id) { change(d => {
      if (useProjects.getState().remoteTasks.some(t => t.connectionId === id)) throw new Error("This connection is referenced by cached tasks; disable automatic sync instead");
      const syncStates = { ...d.syncStates }; delete syncStates[id]; return { connections: d.connections.filter(c => c.id !== id), syncStates };
    }); },
  };
}, {
  name: "zentao", version: 1, storage: createJSONStorage(() => tauriJsonStorage), partialize: zenConnectionData,
  merge: (saved, current) => { if (!saved) return current; validateZenConnections(saved as ZenConnectionData); return { ...current, ...(saved as ZenConnectionData) }; },
  onRehydrateStorage: () => (_s, error) => { if (error) useStorageHealth.getState().report("unavailable", "zentao", "Unable to load ZenTao connection settings"); },
}));
onStorageSynced((key, value) => {
  if (key !== "zentao" || !value || typeof value !== "object") return;
  try {
    const data = (value as { state: ZenConnectionData }).state; validateZenConnections(data);
    const policies = (connections: ZenConnection[]) => JSON.stringify(connections.map(c => [c.id, c.writeFields ?? []]));
    const changed = policies(useZentao.getState().connections) !== policies(data.connections);
    useZentao.setState(data);
    if (changed && useProjects.persist.hasHydrated() && useZentao.persist.hasHydrated()) useProjects.getState().refreshWriteback?.();
  }
  catch { useStorageHealth.getState().report("unavailable", "zentao", "Unable to load ZenTao connection settings"); }
});
