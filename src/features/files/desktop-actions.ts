import { getAllWebviewWindows, type WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { closeFence, inTauri, openFence } from "@/lib/tauri";
import { flushAllStorage } from "@/lib/storage";
import { useFiles, useFences, DEFAULT_FENCE, DEFAULT_GROUP_GEOMETRY } from "@/stores/files";
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

/** 打开同色编组的宿主窗口（成员盒子仍各自保留 fence 窗口）。 */
export async function openFenceGroup(color: string): Promise<void> {
  if (!inTauri) return;
  const key = color.toLowerCase();
  useFences.getState().ensureGroup(key);
  const group = useFences.getState().groups[key];
  if (!group) return;
  if (!group.open) useFences.getState().setGroupOpen(key, true);
  await flushAllStorage();
  await invoke("open_fence_group", {
    groupId: key.replace("#", ""),
    title: navigator.language.toLowerCase().startsWith("zh") ? "编组窗口" : "Group host",
    x: group.x ?? DEFAULT_GROUP_GEOMETRY.x,
    y: group.y ?? DEFAULT_GROUP_GEOMETRY.y,
    w: group.w ?? DEFAULT_GROUP_GEOMETRY.w,
    h: group.h ?? DEFAULT_GROUP_GEOMETRY.h,
  });
  /*
   * 合并后成员栅栏只是藏起来，不销毁：宿主窗口关闭时还能按原几何恢复。
   * 用 hideFenceTemporarily 而不是 setOpen(false)，避免把用户「启用」的
   * 选择改掉 —— open 仍是持久状态，hidden 只是这一次合并的呈现。
   */
  const members = useFiles.getState().categories.filter((category) => category.groupColor?.toLowerCase() === key);
  await Promise.all(members.map(async (category) => {
    if (useFences.getState().fences[category.id]?.open) {
      await hideFenceTemporarily(category.id).catch(() => undefined);
    }
  }));
}

/** 编组宿主窗口没有独立命令：用 label 直接隐藏/关闭由前端处理。 */
export async function hideFenceGroup(color: string): Promise<void> {
  const window = (await getAllWebviewWindows()).find((item) => item.label === `fence-group-${color.replace("#", "")}`);
  if (window) await window.hide();
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
