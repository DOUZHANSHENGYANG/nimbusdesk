import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getAllWebviewWindows, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { inTauri } from "@/lib/tauri";
import { useFiles, useFences } from "@/stores/files";
import { queueWindowOperation } from "./edge-core";
import { useEdgeWorkspace } from "./edge-workspace";
import { groupKey, type MonitorArea } from "./queue-core";
import { desktopAction, desktopEntries, saveDockPosition, useDesktopEntries, type DesktopAction } from "./registry";
import { moveDockGroup } from "./queue-registry";
import { readMonitors } from "./monitors";
import { desiredHubKeys, hubKeyFromLabel, hubWindowChanges, sameMonitors } from "./edge-runtime-core";

/** Complete group migration before display events can make individual tabs re-reserve. */
export function synchronizeDockMonitors(monitors: MonitorArea[]) {
  if (!monitors.length) return;
  const migrated = new Set<string>();
  for (const entry of desktopEntries().filter(entry => entry.form === "capsule")) {
    const area = monitors.find(area => area.id === entry.edgeMonitor) ?? monitors[0];
    const edge = entry.edge ?? "right";
    if (entry.edgeMonitor && entry.edgeMonitor !== area.id) {
      const oldKey = groupKey(entry.edgeMonitor, edge);
      if (migrated.has(oldKey)) continue;
      const oldGroup = useEdgeWorkspace.getState().groups[oldKey];
      if (oldGroup) {
        moveDockGroup(oldKey, area, edge, oldGroup.offset, "monitor-recovery");
        migrated.add(oldKey);
      } else saveDockPosition(entry.id, { edge, edgeMonitor: area.id });
    } else if (!entry.edgeMonitor) saveDockPosition(entry.id, { edge, edgeMonitor: area.id });
  }
  for (const entry of desktopEntries().filter(entry => entry.form === "capsule")) {
    const area = monitors.find(area => area.id === entry.edgeMonitor);
    if (!area) continue;
    const edge = entry.edge ?? "right", key = groupKey(area.id, edge);
    if (!useEdgeWorkspace.getState().groups[key]) useEdgeWorkspace.getState().updateGroup(key, { monitorId: area.id, edge, offset: 48, collapsed: false, order: [] });
  }
}

/** Auto-hydrating stores must finish before an empty registry can close windows. */
export function useDesktopHydrated() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const stores = [useFiles, useFences, useEdgeWorkspace];
    const check = () => setReady(stores.every(store => store.persist.hasHydrated()));
    const stops = stores.map(store => store.persist.onFinishHydration(check));
    check();
    return () => stops.forEach(stop => stop());
  }, []);
  return ready;
}

/** Main-window coordinator; auxiliary windows only observe their own queue. */
export function EdgeRuntime() {
  const main = inTauri && getCurrentWebviewWindow().label === "main";
  const ready = useDesktopHydrated();
  const entries = useDesktopEntries(), groups = useEdgeWorkspace(state => state.groups);
  const [monitors, setMonitors] = useState<MonitorArea[]>([]);
  const reconcileIntent = useRef(0), collectionIntent = useRef(0);
  const collectionHidden = useRef(false);

  useEffect(() => {
    if (!main || !ready) return;
    let alive = true, polling = false;
    let previous: MonitorArea[] | null = null;
    const poll = async () => {
      if (!alive || polling) return;
      polling = true;
      try {
        const next = await readMonitors();
        if (!alive || !next.length) return;
        if (previous && sameMonitors(previous, next)) return;
        const changed = previous !== null;
        previous = next;
        synchronizeDockMonitors(next);
        setMonitors(next);
        if (changed) await emit("desktop://display-change", next);
      } catch (error) { if (alive) console.warn("Desktop display refresh failed", error); }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [main, ready]);

  useEffect(() => {
    if (!main || !ready || !monitors.length) return;
    const intent = ++reconcileIntent.current;
    let alive = true;
    const current = () => alive && intent === reconcileIntent.current;
    void queueWindowOperation("desktop-hubs-runtime", async () => {
      if (!current()) return;
      synchronizeDockMonitors(monitors);
      const windows = await getAllWebviewWindows();
      if (!current()) return;
      const changes = hubWindowChanges(desiredHubKeys(useEdgeWorkspace.getState().groups, desktopEntries()), windows.map(window => window.label));
      for (const key of changes.close) {
        if (!current()) return;
        await invoke("desktop_close_hub", { key });
      }
      for (const key of changes.open) {
        if (!current()) return;
        await invoke("desktop_open_hub", { key });
      }
    }).catch(error => { if (current()) console.warn("Desktop queue update failed", error); });
    return () => { alive = false; };
  }, [main, ready, monitors, entries, groups]);

  useEffect(() => {
    if (!main || !ready) return;
    let alive = true;
    const apply = (action: DesktopAction) => {
      collectionHidden.current = action === "hide";
      const intent = ++collectionIntent.current;
      const current = () => alive && intent === collectionIntent.current;
      void queueWindowOperation("desktop-collection-actions", async () => {
        if (!current()) return;
        if (action !== "hide") {
          for (const [key, group] of Object.entries(useEdgeWorkspace.getState().groups)) {
            if (group.collapsed) useEdgeWorkspace.getState().setCollapsed(key, false);
          }
        }
        for (const entry of desktopEntries()) {
          if (!current()) return;
          try { await desktopAction(entry.id, action); }
          catch (error) { if (current()) console.warn("Desktop window action failed", error); }
        }
        if (action === "hide") {
          for (const window of await getAllWebviewWindows()) {
            if (!current()) return;
            if (hubKeyFromLabel(window.label)) await window.hide();
          }
        }
      }).catch(error => { if (current()) console.warn("Desktop collection action failed", error); });
    };
    const subscriptions = [
      listen("desktop://recall-all", () => apply("restore")),
      listen("desktop://hide-all", () => apply("hide")),
      listen("desktop://fold-all", () => apply("fold")),
      listen<{ label: string }>("desktop://hub-ready", ({ payload }) => {
        if (!alive || !payload || !hubKeyFromLabel(payload.label)) return;
        void emitTo(payload.label, "desktop://hub-visibility", { visible: !collectionHidden.current }).catch(error => { if (alive) console.warn("Desktop queue visibility failed", error); });
      }),
    ];
    return () => { alive = false; ++collectionIntent.current; subscriptions.forEach(subscription => void subscription.then(stop => stop()).catch(() => undefined)); };
  }, [main, ready]);
  return null;
}
