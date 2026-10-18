import { getAllWebviewWindows, type WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo } from "@tauri-apps/api/event";
import { closeFence, inTauri, openFence } from "@/lib/tauri";
import { flushAllStorage } from "@/lib/storage";
import { useFiles, useFences, DEFAULT_FENCE } from "@/stores/files";
import { queueWindowOperation } from "@/features/desktop/edge-core";
import { useEdgeWorkspace } from "@/features/desktop/edge-workspace";

function unfoldFenceQueue(id: string) {
  const fence = useFences.getState().fences[id];
  if (fence?.form !== "capsule") return;
  for (const [key, group] of Object.entries(useEdgeWorkspace.getState().groups)) {
    if (group.collapsed && group.monitorId === fence.edgeMonitor && group.edge === (fence.edge ?? "right")) {
      useEdgeWorkspace.getState().setCollapsed(key, false);
    }
  }
}

async function showFence(id: string, index: number, enable: boolean, reveal: boolean) {
  const category = useFiles.getState().categories.find(category => category.id === id);
  const previous = useFences.getState().fences[id];
  if (!category || (!enable && !previous?.open)) return;
  const existing = (await getAllWebviewWindows()).find(window => window.label === `fence-${id}`);
  if (existing && !reveal) return;
  const wasOpen = previous?.open ?? false;
  try {
    if (!previous) useFences.getState().setGeometry(id, { x: 180 + (index % 5) * 32, y: 160 + (index % 5) * 24, w: DEFAULT_FENCE.w, h: DEFAULT_FENCE.h });
    if (!wasOpen) useFences.getState().setOpen(id, true);
    if (reveal) unfoldFenceQueue(id);
    // A new WebView must hydrate the enabled value, not race an older disabled record.
    await flushAllStorage();
    const geometry = useFences.getState().fences[id] ?? DEFAULT_FENCE;
    await openFence(id, category.name, geometry);
    if (existing && reveal) await emitTo(existing.label, "desktop://window-action", { action: "show" });
  } catch (error) {
    if (!wasOpen) {
      useFences.getState().setOpen(id, false);
      try { await flushAllStorage(); }
      catch (rollback) { throw new Error(`${String(error)}; ${String(rollback)}`); }
    }
    throw error;
  }
}

async function closeAndWait(id: string, window: WebviewWindow) {
  let destroyed!: () => void;
  const destruction = new Promise<void>(resolve => { destroyed = resolve; });
  const off = await window.once("tauri://destroyed", destroyed);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await closeFence(id);
    if (!(await getAllWebviewWindows()).some(item => item.label === window.label)) return;
    await Promise.race([destruction, new Promise<void>(resolve => { timer = setTimeout(resolve, 3500); })]);
    if ((await getAllWebviewWindows()).some(item => item.label === window.label)) throw new Error("窗口正在操作或未能关闭，请稍后重试 / Window is busy or could not close; retry shortly.");
  } finally { clearTimeout(timer); off(); }
}

/** Persistent category switch. The owning window may reject close while moving files. */
export function setFenceOnDesktop(id: string, visible: boolean, index = 0): Promise<void> {
  return queueWindowOperation(`fence-${id}`, async () => {
    if (!inTauri) throw new Error("Desktop fences require the desktop application.");
    if (visible) { await showFence(id, index, true, true); return; }
    const window = (await getAllWebviewWindows()).find(window => window.label === `fence-${id}`);
    if (window) {
      try { await closeAndWait(id, window); }
      catch (error) {
        // Do not mark a live, busy fence disabled. It remains actionable for retry.
        useFences.getState().setOpen(id, true);
        try { await flushAllStorage(); }
        catch (rollback) { throw new Error(`${String(error)}; ${String(rollback)}`); }
        throw error;
      }
    }
    if (useFences.getState().fences[id]?.open) useFences.getState().setOpen(id, false);
    await flushAllStorage();
  });
}

/** Startup and the shortcut may reveal enabled fences, but cannot enable disabled ones. */
export function restoreFenceOnDesktop(id: string, reveal = false): Promise<void> {
  return queueWindowOperation(`fence-${id}`, () => showFence(id, 0, false, reveal));
}

export function hideFenceTemporarily(id: string): Promise<void> {
  return queueWindowOperation(`fence-${id}`, async () => {
    const window = (await getAllWebviewWindows()).find(window => window.label === `fence-${id}`);
    if (!window) return;
    await emitTo(window.label, "desktop://window-action", { action: "hide" });
    await window.hide();
  });
}

export async function setAllFencesOnDesktop(visible: boolean, progress?: (done: number, total: number) => void) {
  const categories = [...useFiles.getState().categories];
  const failed: { id: string; name: string; error: unknown }[] = [];
  let done = 0;
  for (const [index, category] of categories.entries()) {
    try { await setFenceOnDesktop(category.id, visible, index); done++; }
    catch (error) { failed.push({ id: category.id, name: category.name, error }); }
    progress?.(index + 1, categories.length);
  }
  return { done, failed };
}
