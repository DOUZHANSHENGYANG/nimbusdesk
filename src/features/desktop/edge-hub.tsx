import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ArrowLeftRight, ChevronDown, ChevronUp, EyeOff, GripVertical, LayoutGrid, Monitor, X } from "lucide-react";
import { inTauri } from "@/lib/tauri";
import { useSettings } from "@/stores/settings";
import { queueWindowOperation } from "./edge-core";
import { useEdgeWorkspace } from "./edge-workspace";
import { useDesktopHydrated } from "./edge-runtime";
import { planQueue, type MonitorArea, type QueueEdge } from "./queue-core";
import { desktopAction, useDesktopEntries, type DesktopAction } from "./registry";
import { moveDockGroup } from "./queue-registry";
import { readMonitors } from "./monitors";
import { groupDragDestination, hubKeyFromLabel, sameMonitors } from "./edge-runtime-core";

/** One small native window controls a single monitor/side queue. */
export function EdgeHub() {
  const label = inTauri ? getCurrentWebviewWindow().label : "preview";
  const key = hubKeyFromLabel(label);
  const hydrated = useDesktopHydrated();
  const groups = useEdgeWorkspace(state => state.groups), entries = useDesktopEntries();
  const en = useSettings(state => state.lang) === "en";
  const [monitors, setMonitors] = useState<MonitorArea[]>([]);
  const [menu, setMenu] = useState(false), [error, setError] = useState("");
  const [visibilityKnown, setVisibilityKnown] = useState(!inTauri);
  const group = key ? groups[key] : undefined;
  const area = monitors.find(area => area.id === group?.monitorId);
  const members = entries.filter(entry => entry.form === "capsule" && entry.edgeMonitor === group?.monitorId && entry.edge === group?.edge);
  const layout = area && group ? planQueue(area, group, members) : null;
  const latest = useRef({ group, area, members, layout, menu, hydrated, visibilityKnown });
  latest.current = { group, area, members, layout, menu, hydrated, visibilityKnown };
  const alive = useRef(false), intent = useRef(0), dragging = useRef(false), hidden = useRef(false);
  const monitorIntent = useRef(0);
  const dragCleanup = useRef<(() => void) | null>(null), suppressClickUntil = useRef(0), focusAfterPlace = useRef(false);
  const button = useRef<HTMLButtonElement>(null), menuRef = useRef<HTMLDivElement>(null);
  const report = useCallback((cause: unknown) => { if (alive.current) setError(String(cause)); }, []);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; ++intent.current; ++monitorIntent.current; dragCleanup.current?.(); };
  }, []);

  const refreshMonitors = useCallback(async () => {
    const owner = ++monitorIntent.current;
    try {
      const next = await readMonitors();
      if (alive.current && owner === monitorIntent.current) setMonitors(previous => sameMonitors(previous, next) ? previous : next);
    } catch (cause) { report(cause); }
  }, [report]);

  const place = useCallback((activate = false) => {
    if (!inTauri || !key || dragging.current || !latest.current.hydrated || !latest.current.visibilityKnown) return Promise.resolve();
    const owner = ++intent.current;
    const current = () => alive.current && owner === intent.current;
    return queueWindowOperation(label, async () => {
      if (!current()) return;
      const win = getCurrentWebviewWindow(), state = latest.current;
      if (hidden.current || !state.members.length || !state.area || !state.group || !state.layout) {
        await win.hide();
        return;
      }
      const area = state.area, scale = area.scale, logicalH = area.h / scale;
      const w = Math.min(state.menu ? 280 : 24, area.w / scale);
      const h = Math.min(state.menu ? Math.max(264, Math.min(560, 176 + state.layout.order.length * 32)) : 40, logicalH);
      const y = Math.max(0, Math.min(state.layout.hubY, logicalH - h));
      const x = state.group.edge === "left" ? area.x : area.x + area.w - w * scale;
      await win.setAlwaysOnBottom(false); if (!current()) return;
      await win.setAlwaysOnTop(true); if (!current()) return;
      await win.setSize(new PhysicalSize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)))); if (!current()) return;
      await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(area.y + y * scale))); if (!current()) return;
      await win.show(); if (!current()) return;
      if (activate) await win.setFocus();
    }).catch(report);
  }, [key, label, report]);

  useEffect(() => {
    if (!inTauri || !key) return;
    void refreshMonitors();
    const display = listen("desktop://display-change", () => void refreshMonitors());
    const focus = getCurrentWebviewWindow().onFocusChanged(({ payload: focused }) => {
      if (alive.current && !focused && latest.current.menu && !dragging.current) setMenu(false);
    });
    return () => { [display, focus].forEach(subscription => void subscription.then(stop => stop()).catch(() => undefined)); };
  }, [key, refreshMonitors]);

  useEffect(() => {
    if (!inTauri || !key) return;
    let listening = true;
    let retry: ReturnType<typeof setInterval> | undefined;
    const requestVisibility = () => emitTo("main", "desktop://hub-ready", { label }).catch(report);
    const visibility = listen<{ visible: boolean }>("desktop://hub-visibility", ({ payload }) => {
      if (!listening || !payload || typeof payload.visible !== "boolean") return;
      hidden.current = !payload.visible;
      clearInterval(retry);
      setVisibilityKnown(true);
      void place();
    }, { target: label });
    void visibility.then(() => {
      if (!listening) return;
      void requestVisibility();
      retry = setInterval(() => void requestVisibility(), 1000);
    }).catch(report);
    const hide = listen("desktop://hide-all", () => {
      hidden.current = true; setMenu(false); ++intent.current;
      void queueWindowOperation(label, async () => { if (alive.current) await getCurrentWebviewWindow().hide(); }).catch(report);
    });
    const reveal = () => { hidden.current = false; setMenu(false); void place(); };
    const recall = listen("desktop://recall-all", reveal), fold = listen("desktop://fold-all", reveal);
    return () => {
      listening = false; clearInterval(retry);
      [visibility, hide, recall, fold].forEach(subscription => void subscription.then(stop => stop()).catch(() => undefined));
    };
  }, [key, label, place, report]);

  const geometryKey = JSON.stringify({ area, layout, edge: group?.edge, members: members.length });
  useEffect(() => {
    const focus = focusAfterPlace.current; focusAfterPlace.current = false;
    void place(focus).then(() => {
      if (!alive.current || !latest.current.menu || !focus) return;
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
  }, [geometryKey, menu, hydrated, visibilityKnown, place]);

  const closeMenu = useCallback(() => { setMenu(false); requestAnimationFrame(() => button.current?.focus()); }, []);
  const openMenu = useCallback(() => { focusAfterPlace.current = true; setMenu(true); }, []);
  const toggle = () => {
    if (!key || !group || Date.now() < suppressClickUntil.current) return;
    useEdgeWorkspace.getState().setCollapsed(key, !group.collapsed);
  };
  const act = async (action: DesktopAction, ids = members.map(member => member.id)) => {
    closeMenu();
    for (const id of ids) {
      if (!alive.current) return;
      try { await desktopAction(id, action); } catch (cause) { report(cause); }
    }
    if (action === "hide") {
      hidden.current = true;
      await place();
    }
  };
  const transfer = (target: MonitorArea, edge: QueueEdge) => {
    closeMenu();
    if (key && group) moveDockGroup(key, target, edge, group.offset);
  };
  const main = async (route: string) => {
    closeMenu();
    try { if (inTauri) await invoke("desktop_open_main", { route }); } catch (cause) { report(cause); }
  };

  const startDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !inTauri || !key || dragging.current || menu) return;
    const start = { x: event.clientX, y: event.clientY };
    let started = false, released = false, canceled = false, handedOff = false;
    const cleanup = () => {
      canceled = true;
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel); window.removeEventListener("keydown", escape);
      if (dragCleanup.current === cleanup) dragCleanup.current = null;
    };
    dragCleanup.current?.();
    const move = (moveEvent: globalThis.PointerEvent) => {
      if (started || Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < 5) return;
      started = true; dragging.current = true; suppressClickUntil.current = Date.now() + 350;
      const owner = ++intent.current, win = getCurrentWebviewWindow();
      const current = () => alive.current && owner === intent.current;
      void queueWindowOperation(label, async () => {
        if (!current() || released || canceled) return;
        handedOff = true;
        await win.startDragging();
        if (!current()) return;
        const committed = await invoke<boolean>("desktop_wait_drag_end");
        if (!committed) canceled = true;
        if (!current() || canceled) return;
        const [pos, size, available] = await Promise.all([win.outerPosition(), win.outerSize(), readMonitors()]);
        if (!current() || canceled) return;
        const destination = groupDragDestination({ x: pos.x, y: pos.y, w: size.width, h: size.height }, available);
        if (destination) {
          const source = latest.current.group;
          if (source && (source.monitorId !== destination.area.id || source.edge !== destination.edge)) hidden.current = true;
          moveDockGroup(key, destination.area, destination.edge, destination.offset);
        }
      }).catch(report).finally(() => {
        cleanup();
        if (!alive.current) return;
        dragging.current = false; suppressClickUntil.current = Date.now() + 350;
        void place();
      });
    };
    const up = () => { released = true; if (!started) cleanup(); };
    const cancel = () => { if (handedOff) return; canceled = true; released = true; if (!started) cleanup(); };
    const escape = (keyEvent: globalThis.KeyboardEvent) => { if (keyEvent.key === "Escape" && !keyEvent.isComposing) { canceled = true; released = true; } };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel); window.addEventListener("keydown", escape);
    dragCleanup.current = cleanup;
  };

  const menuKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
    if (event.key === "Tab") { event.preventDefault(); closeMenu(); return; }
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (current + 1) % items.length : current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    items[index].focus();
  };

  if (!key || !group) return null;
  const menuItem = (text: string, icon: ReactNode, action: () => unknown) => <button type="button" role="menuitem" className="flex min-h-8 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-muted focus-visible:bg-muted focus-visible:outline-none" onClick={action}>{icon}<span className="min-w-0 flex-1 truncate">{text}</span></button>;
  return <div className="fixed inset-0 select-none text-foreground" onContextMenu={event => { event.preventDefault(); openMenu(); }}>
    {!menu && <button ref={button} type="button" aria-label={en ? `Desktop queue, ${members.length} windows` : `桌面队列，${members.length}个窗口`} aria-expanded={!group.collapsed}
      title={error || (en ? "Click to collapse / expand queue · Right click for windows and actions · Drag to move queue" : "单击收放整列 · 右键查看窗口与操作 · 拖动移动整列")}
      onClick={toggle} onPointerDown={startDrag}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10") || event.key === "ArrowDown") { event.preventDefault(); openMenu(); }
      }}
      className="flex h-10 w-6 flex-col items-center justify-center gap-0.5 overflow-hidden border border-brand/40 bg-popover text-brand outline-none hover:bg-brand/15 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
      style={{ borderRadius: group.edge === "left" ? "0 8px 8px 0" : "8px 0 0 8px" }}>
      <GripVertical className="size-3" aria-hidden="true" /><span className="text-[10px] font-medium tabular-nums">{members.length}</span>
    </button>}
    {menu && <div ref={menuRef} role="menu" aria-label={en ? "Desktop queue actions" : "桌面队列操作"} onKeyDown={menuKeyboard} className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl">
      <div className="flex h-8 shrink-0 items-center gap-1 px-2 text-xs font-medium"><span className="min-w-0 flex-1 truncate">{en ? `Desktop windows (${members.length})` : `桌面窗口（${members.length}）`}</span><button type="button" aria-label={en ? "Close menu" : "关闭菜单"} className="flex size-6 items-center justify-center rounded hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand" onClick={closeMenu}><X className="size-3.5" /></button></div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {menuItem(group.collapsed ? (en ? "Expand queue" : "展开整列胶囊") : (en ? "Collapse queue" : "收起整列胶囊"), group.collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />, () => { toggle(); closeMenu(); })}
        {menuItem(en ? "Restore all windows" : "恢复整列窗口", <LayoutGrid className="size-3.5" />, () => void act("restore"))}
        {menuItem(en ? "Hide queue until recalled" : "隐藏整列（托盘可找回）", <EyeOff className="size-3.5" />, () => void act("hide"))}
        {area && menuItem(en ? "Move to opposite edge" : "移到屏幕另一侧", <ArrowLeftRight className="size-3.5" />, () => transfer(area, group.edge === "left" ? "right" : "left"))}
        {monitors.filter(monitor => monitor.id !== group.monitorId).map(monitor => <div key={monitor.id}>{menuItem(en ? `Move to ${monitor.name ?? monitor.id}` : `移到${monitor.name ?? monitor.id}`, <Monitor className="size-3.5" />, () => transfer(monitor, group.edge))}</div>)}
        <div role="separator" className="my-1 h-px bg-border" />
        {layout?.order.map(id => {
          const member = members.find(member => member.id === id);
          if (!member) return null;
          const overflow = layout.overflow.includes(id);
          return <button key={id} type="button" role="menuitem" title={member.title} className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-muted focus-visible:bg-muted focus-visible:outline-none" onClick={() => void act("restore", [id])}>
            <span className="min-w-0 flex-1 truncate">{member.title}</span>{overflow && <span className="shrink-0 text-[10px] text-muted-foreground">{en ? "Hidden" : "已收起"}</span>}
          </button>;
        })}
        <div role="separator" className="my-1 h-px bg-border" />
        {menuItem(en ? "Open tasks" : "打开计划", <LayoutGrid className="size-3.5" />, () => void main("/plans"))}
        {menuItem(en ? "Open files" : "打开文件", <LayoutGrid className="size-3.5" />, () => void main("/files"))}
        {menuItem(en ? "Open settings" : "打开设置", <LayoutGrid className="size-3.5" />, () => void main("/settings"))}
      </div>
      {error && <p role="status" className="max-h-12 shrink-0 overflow-y-auto px-2 py-1 text-[10px] text-destructive">{en ? "Action failed. Try again from the tray." : "操作未完成，请从托盘重试。"}</p>}
    </div>}
  </div>;
}

/** Public alias matches other auxiliary window entry components. */
export const EdgeHubWindow = EdgeHub;
