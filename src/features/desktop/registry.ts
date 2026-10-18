import { useMemo } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { useFiles, useFences } from "@/stores/files";
import { usePapers } from "@/stores/papers";
import { openFence, openTodoPaper } from "@/lib/tauri";
import { flushAllStorage } from "@/lib/storage";
import { queueWindowOperation } from "./edge-core";
import type { NormalRect, Edge } from "./edge-core";
import type { QueueMember } from "./queue-core";

export interface DesktopEntry extends QueueMember {
  title: string; kind: "todo" | "fence"; form: "paper" | "capsule"; normal: NormalRect;
}

function entries(papers = usePapers.getState().papers, fences = useFences.getState().fences, categories = useFiles.getState().categories): DesktopEntry[] {
  return [
    ...Object.entries(papers).filter(([, p]) => p.open).map(([date, p]): DesktopEntry => ({ id: `todo-${date}`, title: date, kind: "todo", form: p.form ?? "paper", normal: { x: p.x, y: p.y, w: p.w, h: p.h }, edge: p.edge ?? "right", edgeY: p.edgeY, edgeMonitor: p.edgeMonitor })),
    ...Object.entries(fences).filter(([, f]) => f.open).map(([id, f]): DesktopEntry => ({ id: `fence-${id}`, title: categories.find(c => c.id === id)?.name ?? id, kind: "fence", form: f.form ?? "paper", normal: { x: f.x, y: f.y, w: f.w, h: f.h }, edge: f.edge ?? "right", edgeY: f.edgeY, edgeMonitor: f.edgeMonitor, locked: f.locked ?? false })),
  ];
}
export const desktopEntries = () => entries();
export function useDesktopEntries() {
  const papers = usePapers(s => s.papers), fences = useFences(s => s.fences), categories = useFiles(s => s.categories);
  return useMemo(() => entries(papers, fences, categories), [papers, fences, categories]);
}
export function saveDockPosition(id: string, placement: { edge?: Edge; edgeY?: number; edgeMonitor?: string }) {
  if (id.startsWith("todo-")) usePapers.getState().setGeometry(id.slice(5), placement);
  else if (id.startsWith("fence-")) useFences.getState().setDockPosition(id.slice(6), placement);
}
export function setDesktopForm(id: string, form: "paper" | "capsule") {
  if (id.startsWith("todo-")) usePapers.getState().setForm(id.slice(5), form);
  else if (id.startsWith("fence-")) useFences.getState().setForm(id.slice(6), form);
}

export type DesktopAction = "restore" | "fold" | "hide";
/** Open missing windows through the existing constructors; live windows restore in their own queue. */
export function desktopAction(id: string, action: DesktopAction): Promise<void> {
  // Tray recovery must not recreate a fence after Files has disabled it.
  return id.startsWith("fence-")
    ? queueWindowOperation(id, () => applyDesktopAction(id, action))
    : applyDesktopAction(id, action);
}

async function applyDesktopAction(id: string, action: DesktopAction) {
  const entry = entries().find(item => item.id === id);
  if (!entry || (entry.kind === "fence" && !useFiles.getState().categories.some(category => `fence-${category.id}` === id))) return;
  const existing = (await getAllWebviewWindows()).find(win => win.label === id);
  if (existing) {
    if (action === "hide") { await emitTo(id, "desktop://window-action", { action }); await existing.hide(); return; }
    await existing.show();
    await emitTo(id, "desktop://window-action", { action });
    return;
  }
  if (action === "hide") return;
  const form = action === "fold" ? "capsule" : "paper";
  if (entry.kind === "todo") {
    usePapers.getState().setForm(id.slice(5), form);
    await openTodoPaper(id.slice(5), entry.title, entry.normal);
  } else {
    useFences.getState().setForm(id.slice(6), form);
    await flushAllStorage();
    await openFence(id.slice(6), entry.title, entry.normal);
  }
}
