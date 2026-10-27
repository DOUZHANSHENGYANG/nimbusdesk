import { useMemo } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { useFiles, useFences } from "@/stores/files";
import { openFence } from "@/lib/tauri";
import { flushAllStorage } from "@/lib/storage";
import { queueWindowOperation } from "./edge-core";
import type { NormalRect, Edge } from "./edge-core";
import type { QueueMember } from "./queue-core";
import type { StickyAppearance } from "./sticky-presentation";

export interface DesktopEntry extends QueueMember {
  title: string; form: "paper" | "capsule"; normal: NormalRect; appearance?: StickyAppearance;
}

function entries(fences = useFences.getState().fences, categories = useFiles.getState().categories): DesktopEntry[] {
  return Object.entries(fences).filter(([, f]) => f.open).map(([id, f]): DesktopEntry => ({ id: `fence-${id}`, title: categories.find(c => c.id === id)?.name ?? id, form: f.form ?? "paper", normal: { x: f.x, y: f.y, w: f.w, h: f.h }, edge: f.edge ?? "right", edgeY: f.edgeY, dockOffset: f.dockOffset, edgeMonitor: f.edgeMonitor, locked: f.locked ?? false, tabHeight: f.tabHeight, tabWidth: f.tabWidth, appearance: f }));
}
export const desktopEntries = () => entries();
export function useDesktopEntries() {
  const fences = useFences(s => s.fences), categories = useFiles(s => s.categories);
  return useMemo(() => entries(fences, categories), [fences, categories]);
}
export function saveDockPosition(id: string, placement: { edge?: Edge; edgeY?: number; edgeMonitor?: string; dockOffset?: number }) {
  if (id.startsWith("fence-")) useFences.getState().setDockPosition(id.slice(6), placement);
}
export function setDesktopForm(id: string, form: "paper" | "capsule") {
  if (id.startsWith("fence-")) useFences.getState().setForm(id.slice(6), form);
}

export type DesktopAction = "restore" | "fold" | "hide";
/** Open a missing fence through its constructor; a live window restores in its own queue. */
export function desktopAction(id: string, action: DesktopAction): Promise<void> {
  // Tray recovery must not recreate a fence after Files has disabled it.
  return queueWindowOperation(id, () => applyDesktopAction(id, action));
}

async function applyDesktopAction(id: string, action: DesktopAction) {
  const entry = entries().find(item => item.id === id);
  if (!entry || !useFiles.getState().categories.some(category => `fence-${category.id}` === id)) return;
  const existing = (await getAllWebviewWindows()).find(win => win.label === id);
  if (existing) {
    if (action === "hide") { await emitTo(id, "desktop://window-action", { action }); await existing.hide(); return; }
    await existing.show();
    await emitTo(id, "desktop://window-action", { action });
    return;
  }
  if (action === "hide") return;
  useFences.getState().setForm(id.slice(6), action === "fold" ? "capsule" : "paper");
  await flushAllStorage();
  await openFence(id.slice(6), entry.title, entry.normal);
}
