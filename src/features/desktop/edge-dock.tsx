import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { ChevronLeft, ChevronRight, ChevronDown, Expand, ArrowLeftRight, ArrowUp, ArrowDown, EyeOff, Minimize2, LockKeyhole, UnlockKeyhole, Palette, Grip, X } from "lucide-react";
import { EdgeController, edgeTabOffset, nearestDockEdge, queueWindowOperation, type Edge, type NormalRect } from "./edge-core";
import { inTauri } from "@/lib/tauri";
import { onStorageSynced } from "@/lib/storage";
import { desktopEntries, useDesktopEntries, setDesktopForm } from "./registry";
import { useEdgeWorkspace } from "./edge-workspace";
import { readMonitors, monitorArea } from "./monitors";
import { monitorAt, type MonitorArea } from "./queue-core";
import { moveDockItem, queueSnapshot, reserveQueue } from "./queue-registry";
import { isDesktopVisible, setDesktopVisibility } from "./visibility";
import { STICKY_LIMITS, stickyAppearance, stickyColorStyle, type StickyAppearance } from "./sticky-presentation";
import { StickySettings } from "./sticky-settings";
export { queueWindowOperation } from "./edge-core";

interface DockOptions {
  active: boolean; edge: Edge; edgeY?: number; normal: () => NormalRect; pinned: boolean; locked?: boolean;
  appearance?: StickyAppearance; onAppearanceChange?(patch: Partial<StickyAppearance>): void;
  onEdgeChange(edge: Edge): void; onEdgeYChange(y: number): void; onUndock(): void; onError?(error: unknown): void;
}

/** One owner of native placement, hover intent, drag handoff and deliberate dismissal. */
export function useEdgeDock(options: DockOptions) {
  const latest = useRef(options); latest.current = options;
  const controller = useRef<EdgeController | null>(null), monitorRef = useRef<MonitorArea | null>(null);
  const [monitor, setMonitor] = useState<MonitorArea | null>(null);
  const [ready, setReady] = useState(false), [opened, setOpened] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [resizePreview, setResizePreview] = useState<{ w: number; h: number } | null>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  const readyRef = useRef(false);
  // Registry helpers read current stores; subscriptions trigger layout recomputation.
  useDesktopEntries();
  useEdgeWorkspace(s => s.groups);
  const label = inTauri ? getCurrentWebviewWindow().label : "preview";
  const openedRef = useRef(false), restoring = useRef(false), dragging = useRef(false), inside = useRef(false), holds = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), dragCleanup = useRef<(() => void) | null>(null), intent = useRef(0);
  const suppressClickUntil = useRef(0);
  const clearTimer = useCallback(() => { clearTimeout(timer.current); timer.current = undefined; }, []);
  const report = useCallback((cause: unknown) => { setError(String(cause)); latest.current.onError?.(cause); }, []);

  const resolveArea = useCallback(async () => {
    const available = await readMonitors();
    const preferred = desktopEntries().find(entry => entry.id === label)?.edgeMonitor ?? monitorRef.current?.id;
    const current = preferred ? null : await currentMonitor();
    const area = available.find(area => area.id === preferred) ?? (current ? monitorArea(current) : available[0]);
    if (!area) throw new Error("Cannot locate the screen work area");
    monitorRef.current = area;
    setMonitor(previous => JSON.stringify(previous) === JSON.stringify(area) ? previous : area);
    return area;
  }, [label]);

  const place = useCallback(async (open: boolean, activate = false) => {
    const native = controller.current;
    if (!native || restoring.current || dragging.current) return;
    const serial = ++intent.current;
    clearTimer(); setBusy(true); setError(null);
    openedRef.current = open; setOpened(open);
    try {
      const area = await resolveArea(); if (serial !== intent.current) return;
      const entry = desktopEntries().find(entry => entry.id === label);
      const edge = entry?.edge ?? latest.current.edge;
      if (entry?.edgeMonitor !== area.id) reserveQueue(label, area, edge);
      const { slot } = queueSnapshot(label, area, edge);
      await native.place(open, edge, slot?.y ?? entry?.dockOffset ?? latest.current.edgeY ?? 48, slot?.h || undefined);
      if (serial !== intent.current) return;
      if (activate) await getCurrentWebviewWindow().setFocus();
      if (serial === intent.current) { readyRef.current = true; setReady(true); }
    } catch (cause) { if (serial === intent.current) report(cause); }
    finally { if (serial === intent.current) setBusy(false); }
  }, [clearTimer, label, report, resolveArea]);
  const open = useCallback((activate = false) => activate && Date.now() < suppressClickUntil.current ? Promise.resolve() : place(true, activate), [place]);
  const close = useCallback(() => holds.current.size ? Promise.resolve() : place(false), [place]);
  const dismiss = useCallback(async () => {
    if ([...holds.current].some(key => /native-drop|item-drag|edge-drag|edge-resize/.test(key))) return;
    setAppearanceOpen(false);
    holds.current.clear();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    await place(false);
  }, [place]);
  const scheduleClose = useCallback(() => {
    clearTimer();
    if (!inside.current && !holds.current.size && openedRef.current && !restoring.current && !dragging.current) timer.current = setTimeout(() => void close(), 850);
  }, [clearTimer, close]);
  const enter = useCallback(() => {
    inside.current = true; clearTimer();
    if (!openedRef.current && !restoring.current && !dragging.current) timer.current = setTimeout(() => void open(), 120);
  }, [clearTimer, open]);
  const leave = useCallback(() => { inside.current = false; scheduleClose(); }, [scheduleClose]);
  const hold = useCallback((key: string, value: boolean) => {
    if (value) { holds.current.add(key); clearTimer(); } else { holds.current.delete(key); scheduleClose(); }
  }, [clearTimer, scheduleClose]);
  const undock = useCallback(async () => {
    const native = controller.current;
    if (!native || restoring.current || dragging.current || [...holds.current].some(key => /native-drop|item-drag|edge-resize/.test(key))) return;
    restoring.current = true; clearTimer(); const serial = ++intent.current; setBusy(true);
    try { await native.restore(latest.current.pinned); if (serial === intent.current && isDesktopVisible(label)) latest.current.onUndock(); }
    catch (cause) { if (serial === intent.current) { restoring.current = false; report(cause); } }
    finally { if (serial === intent.current) setBusy(false); }
  }, [clearTimer, report, label]);

  useEffect(() => {
    if (!options.active || !inTauri) return;
    const win = getCurrentWebviewWindow(); let alive = true;
    const native = new EdgeController({
      label: win.label,
      // Restore can still show the saved normal window when monitor discovery fails.
      monitor: async () => { try { return await resolveArea(); } catch { return null; } },
      ignore: value => win.setIgnoreCursorEvents(value),
      resize: allowed => win.setResizable(allowed && !latest.current.locked),
      size: rect => win.setSize(new PhysicalSize(rect.w, rect.h)),
      position: rect => win.setPosition(new PhysicalPosition(rect.x, rect.y)),
      layer: async (pinned, valid) => { await win.setAlwaysOnBottom(false); if (!valid()) return; await win.setAlwaysOnTop(pinned); if (!valid()) return; if (!pinned) await win.setAlwaysOnBottom(true); },
      show: async mode => {
        if (!isDesktopVisible(label)) { await win.hide(); return; }
        const area = monitorRef.current;
        const edge = desktopEntries().find(entry => entry.id === label)?.edge ?? latest.current.edge;
        const slot = area ? queueSnapshot(label, area, edge).slot : undefined;
        if (mode !== "normal" && slot && !slot.visible) await win.hide();
        else { await win.show(); if (mode === "normal") await win.setFocus(); }
      },
    }, () => latest.current.normal(), () => stickyAppearance(desktopEntries().find(entry => entry.id === label)?.appearance ?? latest.current.appearance));
    controller.current = native; readyRef.current = false; restoring.current = false; dragging.current = false; openedRef.current = false; setOpened(false); setReady(false);
    const serial = ++intent.current, current = () => alive && serial === intent.current;
    let cancelHydration: (() => void) | undefined;
    void (async () => {
      if (!useEdgeWorkspace.persist.hasHydrated()) await new Promise<void>(resolve => {
        const off = useEdgeWorkspace.persist.onFinishHydration(() => { off(); resolve(); });
        cancelHydration = () => { off(); resolve(); };
      });
      if (!current()) return;
      const area = await resolveArea(); if (!current()) return;
      const snapshot = reserveQueue(label, area, latest.current.edge);
      const slot = snapshot.slot;
      await native.place(false, latest.current.edge, slot?.y ?? 48, slot?.h || undefined);
      if (current()) { readyRef.current = true; setReady(true); }
    })().catch(async cause => {
      if (!current()) return; report(cause);
      try { await native.restore(latest.current.pinned); if (current()) latest.current.onUndock(); }
      catch (recovery) { if (current()) { readyRef.current = true; setReady(true); report(recovery); } }
    });
    return () => { alive = false; cancelHydration?.(); ++intent.current; clearTimer(); dragCleanup.current?.(); resizeCleanup.current?.(); native.dispose(); controller.current = null; holds.current.clear(); };
  }, [options.active, clearTimer, label, report, resolveArea]);

  // Remote queue changes reuse this window; they never overwrite its ordinary geometry.
  const queueKey = monitor ? JSON.stringify(queueSnapshot(label, monitor, options.edge).layout) : "";
  useEffect(() => {
    if (!options.active || !ready || dragging.current || restoring.current) return;
    const hidden = monitor && queueSnapshot(label, monitor, options.edge).slot?.visible === false;
    if (hidden) { resizeCleanup.current?.(); openedRef.current = false; setOpened(false); }
    void place(hidden ? false : openedRef.current);
  }, [options.active, options.edge, queueKey, ready, place, monitor, label, options.appearance?.tabWidth, options.appearance?.tabHeight, options.appearance?.previewWidth, options.appearance?.previewHeight]);
  // Retain subscriptions even for the ordinary fence form, where restore means show/recall.
  const methods = useRef({ undock, dismiss, place }); methods.current = { undock, dismiss, place };
  useEffect(() => onStorageSynced(key => {
    if (!["edge-workspace", "todo-papers", "fences", "files"].includes(key) || !readyRef.current || !latest.current.active || !controller.current) return;
    if (desktopEntries().find(entry => entry.id === label)?.form !== "capsule") return;
    // Hidden WebView2 windows may defer React's post-paint effects indefinitely.
    // Storage listeners run independently; native show must wake the view first.
    void methods.current.place(openedRef.current);
  }), [label]);
  useEffect(() => {
    if (!inTauri) return;
    const win = getCurrentWebviewWindow(); let alive = true;
    const actions = listen<{ action: "restore" | "fold" | "hide" | "show" }>("desktop://window-action", ({ payload }) => {
      if (!alive) return;
      if (payload.action === "hide") {
        resizeCleanup.current?.(); setAppearanceOpen(false); holds.current.clear();
        setDesktopVisibility(label, false); ++intent.current; restoring.current = false;
        clearTimer(); setBusy(false); openedRef.current = false; setOpened(false);
        void queueWindowOperation(label, async () => { if (!isDesktopVisible(label)) await win.hide(); }).catch(report);
        return;
      }
      setDesktopVisibility(label, true);
      if (payload.action === "show" && latest.current.active) { void methods.current.place(false); return; }
      if (payload.action === "restore" && latest.current.active) { void methods.current.undock(); return; }
      if (payload.action === "fold") {
        resizeCleanup.current?.();
        if (latest.current.active) void methods.current.dismiss();
        else {
          // The owner's normal view observes this stored form and mounts the dock.
          setDesktopForm(label, "capsule");
        }
        return;
      }
      void queueWindowOperation(label, async () => {
        if (!alive) return;
        const [pos, size, available] = await Promise.all([win.outerPosition(), win.outerSize(), readMonitors()]);
        if (!alive) return;
        const visible = available.some(area => pos.x + size.width > area.x && pos.x < area.x + area.w && pos.y + Math.min(size.height, 36) > area.y && pos.y < area.y + area.h);
        if (!visible && available[0]) { const a = available[0]; await win.setPosition(new PhysicalPosition(a.x + 40 * a.scale, a.y + 40 * a.scale)); }
        if (!alive) return; await win.show(); if (!alive) return; await win.setFocus();
      }).catch(report);
    }, { target: label });
    const displays = listen("desktop://display-change", () => { if (alive && latest.current.active) void methods.current.place(openedRef.current); });
    const previews = listen<{ id: string; monitorId: string; edge: Edge }>("desktop://preview-open", ({ payload }) => {
      if (payload.id !== label && payload.monitorId === monitorRef.current?.id && payload.edge === latest.current.edge && !holds.current.size) void methods.current.dismiss();
    });
    return () => { alive = false; void actions.then(off => off()); void displays.then(off => off()); void previews.then(off => off()); };
  }, [label, report, clearTimer]);
  useEffect(() => { if (opened && monitor) void emit("desktop://preview-open", { id: label, monitorId: monitor.id, edge: options.edge }); }, [opened, monitor?.id, options.edge, label]);

  const dockToEdge = useCallback(async (edge: Edge) => {
    if (restoring.current || dragging.current || latest.current.locked) return;
    const area = await resolveArea();
    if (!moveDockItem(label, area, edge)) return;
    latest.current.onEdgeChange(edge); latest.current = { ...latest.current, edge };
    await place(openedRef.current);
  }, [label, place, resolveArea]);
  const switchEdge = useCallback(() => dockToEdge(latest.current.edge === "left" ? "right" : "left"), [dockToEdge]);
  const moveInQueue = useCallback(async (direction: number) => {
    if (latest.current.locked) return;
    const area = await resolveArea(), snapshot = queueSnapshot(label, area, latest.current.edge);
    const index = snapshot.layout.order.indexOf(label);
    moveDockItem(label, area, latest.current.edge, undefined, Math.max(0, index + direction));
  }, [label, resolveArea]);

  const startDrag = useCallback((event: PointerEvent, tab = false) => {
    if (event.button !== 0 || !inTauri || restoring.current || dragging.current || latest.current.locked) return;
    if (!tab && (event.target as HTMLElement).closest("button,input,textarea,select,[role=button],[role=checkbox]")) return;
    const win = getCurrentWebviewWindow(), sx = event.clientX, sy = event.clientY, owner = controller.current;
    if (!owner) return;
    let started = false, canceled = false, released = false, handedOff = false;
    dragCleanup.current?.();
    const abort = () => { canceled = true; released = true; cleanup(); };
    const cleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancel); window.removeEventListener("keydown", key); if (dragCleanup.current === abort) dragCleanup.current = null; };
    const finish = async () => {
      cleanup();
      try {
        if (!canceled) {
          const [pos, size, available] = await Promise.all([win.outerPosition(), win.outerSize(), readMonitors()]);
          if (canceled || controller.current !== owner) return;
          const area = monitorAt({ x: pos.x + size.width / 2, y: pos.y + size.height / 2 }, available);
          if (area) {
            const edge = nearestDockEdge({ x: pos.x, y: pos.y, w: size.width, h: size.height }, area);
            const offset = ((edge === "top" ? pos.x - area.x : pos.y - area.y)) / area.scale;
            if (!moveDockItem(label, area, edge, offset, undefined, monitorRef.current ?? undefined)) return;
            monitorRef.current = area; setMonitor(area);
            latest.current.onEdgeChange(edge); latest.current = { ...latest.current, edge };
          }
        }
      } catch (cause) { if (controller.current) report(cause); }
      finally { if (controller.current === owner) { suppressClickUntil.current = Date.now() + 350; dragging.current = false; hold("edge-drag", false); await place(false); } }
    };
    const move = (e: globalThis.PointerEvent) => {
      if (started || Math.hypot(e.clientX - sx, e.clientY - sy) < 5) return;
      if (latest.current.locked) { canceled = true; cleanup(); return; }
      started = true; dragging.current = true; suppressClickUntil.current = Date.now() + 350; hold("edge-drag", true); clearTimer(); openedRef.current = false; setOpened(false);
      const native = controller.current;
      if (!native) { cleanup(); dragging.current = false; hold("edge-drag", false); return; }
      const area = monitorRef.current;
      const slot = area ? queueSnapshot(label, area, latest.current.edge).slot : undefined;
      void native.place(false, latest.current.edge, slot?.y ?? 48, slot?.h || undefined).then(async () => {
        if (released || canceled || controller.current !== native || latest.current.locked) { canceled = true; return; }
        handedOff = true;
        await win.startDragging();
        if (!await invoke<boolean>("desktop_wait_drag_end")) canceled = true;
      }).catch(cause => { canceled = true; if (controller.current === owner) report(cause); }).finally(() => void finish());
    };
    const up = () => { released = true; if (!started) cleanup(); };
    const cancel = () => { if (handedOff) return; canceled = true; released = true; if (!started) cleanup(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.isComposing) { canceled = true; released = true; } };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", cancel); window.addEventListener("keydown", key);
    dragCleanup.current = abort;
  }, [clearTimer, hold, label, place, report]);

  const snapshot = monitor ? queueSnapshot(label, monitor, options.edge) : null;
  const top = options.edge === "top";
  const appearance = stickyAppearance(options.appearance);
  const tabWidth = Math.min((top ? snapshot?.slot?.h : undefined) || appearance.tabWidth, monitor ? monitor.w / monitor.scale : Infinity);
  const tabHeight = (top ? undefined : snapshot?.slot?.h) || appearance.tabHeight;
  const normal = options.normal();
  const preview = { ...normal,
    w: Math.min(900, Math.max(280, appearance.previewWidth ?? normal.w)),
    h: Math.min(1000, Math.max(240, appearance.previewHeight ?? normal.h)) };
  const tabOffset = monitor && opened ? edgeTabOffset(monitor, snapshot?.slot?.y ?? options.edgeY ?? 48, preview, tabHeight, options.edge, tabWidth) : 0;
  const tabTop = top ? 0 : tabOffset, tabLeft = top ? tabOffset : 0;
  const queueLocked = !!snapshot?.members.some(member => member.locked);
  const tabHeightLocked = !top && queueLocked, tabWidthLocked = top && queueLocked;
  const resizeFromLeft = options.edge === "right" || (top && tabLeft > 0);
  const changeAppearance = (patch: Partial<StickyAppearance>) => {
    const allowed = { ...patch };
    if (latest.current.locked) {
      delete allowed.tabWidth; delete allowed.tabHeight; delete allowed.previewWidth; delete allowed.previewHeight;
    } else if (monitorRef.current && queueSnapshot(label, monitorRef.current, latest.current.edge).members.some(member => member.locked)) {
      if (latest.current.edge === "top") delete allowed.tabWidth; else delete allowed.tabHeight;
    }
    latest.current.onAppearanceChange?.(allowed);
  };
  const previewSize = (w: number, h: number) => ({
    w: Math.round(Math.min(STICKY_LIMITS.previewWidth.max, monitor ? Math.max(280, monitor.w / monitor.scale - (top ? 0 : tabWidth)) : Infinity, Math.max(280, w))),
    h: Math.round(Math.min(STICKY_LIMITS.previewHeight.max, monitor ? Math.max(240, monitor.h / monitor.scale - (top ? tabHeight : 0)) : Infinity, Math.max(240, h))),
  });
  const resizeBy = (dx: number, dy: number) => {
    if (latest.current.locked) return;
    const size = previewSize(preview.w + dx, preview.h + dy);
    changeAppearance({ previewWidth: size.w, previewHeight: size.h });
  };
  const startResize = (event: PointerEvent) => {
    if (event.button !== 0 || latest.current.locked || !latest.current.onAppearanceChange) return;
    event.preventDefault(); event.stopPropagation(); resizeCleanup.current?.();
    const target = event.currentTarget as HTMLElement, pointer = event.pointerId;
    const sx = event.screenX, sy = event.screenY;
    const start = { w: preview.w, h: preview.h };
    const up = tabTop > 0;
    let next = start;
    target.setPointerCapture(pointer); hold("edge-resize", true); setResizePreview(start);
    const cleanup = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel); window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", cleanup); target.removeEventListener("lostpointercapture", cleanup);
      if (target.hasPointerCapture(pointer)) target.releasePointerCapture(pointer);
      resizeCleanup.current = null; setResizePreview(null); hold("edge-resize", false);
    };
    const move = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointer) return;
      if (latest.current.locked) { cleanup(); return; }
      next = previewSize(start.w + (e.screenX - sx) * (resizeFromLeft ? -1 : 1), start.h + (e.screenY - sy) * (up ? -1 : 1));
      setResizePreview(next);
    };
    const finish = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointer) return;
      cleanup(); if (!latest.current.locked) changeAppearance({ previewWidth: next.w, previewHeight: next.h });
    };
    const cancel = (e: globalThis.PointerEvent) => { if (e.pointerId === pointer) cleanup(); };
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); e.stopImmediatePropagation(); cleanup(); } };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel); window.addEventListener("keydown", key, true);
    window.addEventListener("blur", cleanup); target.addEventListener("lostpointercapture", cleanup);
    resizeCleanup.current = cleanup;
  };
  useEffect(() => { if (options.locked) resizeCleanup.current?.(); }, [options.locked]);
  return { ready, opened, busy, error, edge: options.edge, tabHeight, tabWidth, tabTop, tabLeft, top, resizeFromLeft, appearance, appearanceOpen, resizePreview, startResize, resizeBy, tabHeightLocked, tabWidthLocked, queueLocked, dockToEdge,
    canResize: !!options.onAppearanceChange && !options.locked, sizeLocked: !!options.locked,
    changeAppearance, openAppearance: async () => { await open(true); hold("appearance-settings", true); setAppearanceOpen(true); },
    closeAppearance: () => { setAppearanceOpen(false); hold("appearance-settings", false); },
    movementLocked: !!options.locked, open, close, dismiss, undock, switchEdge, moveInQueue, enter, leave, hold,
    startDrag: (event: PointerEvent) => startDrag(event), startTabDrag: (event: PointerEvent) => startDrag(event, true),
    hide: async () => { setDesktopVisibility(label, false); ++intent.current; restoring.current = false; await getCurrentWebviewWindow().hide().catch(report); }, report };
}

export function EdgeDockFrame({ dock, label, summary, en = false, children, locked = false, onToggleLock }: { dock: ReturnType<typeof useEdgeDock>; label: string; summary?: string; en?: boolean; children: ReactNode; locked?: boolean; onToggleLock?: () => void }) {
  const left = dock.edge === "left", top = dock.top, [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null), appearanceRef = useRef<HTMLDivElement>(null);
  const tabRef = useRef<HTMLButtonElement>(null), menuWasOpen = useRef(false);
  useEffect(() => {
    if (!menu && menuWasOpen.current) tabRef.current?.focus();
    menuWasOpen.current = menu;
  }, [menu]);
  useEffect(() => {
    if (!dock.appearanceOpen) return;
    appearanceRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: globalThis.PointerEvent) => {
      if (!appearanceRef.current?.contains(event.target as Node)) dock.closeAppearance();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [dock.appearanceOpen]);
  useEffect(() => { dock.hold("edge-menu", menu); return () => dock.hold("edge-menu", false); }, [menu, dock.hold]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: globalThis.PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener("pointerdown", outside); return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);
  const openMenu = async () => { await dock.open(true); setMenu(true); };
  const item = (name: string, icon: ReactNode, action: () => unknown, disabled = false) => <button role="menuitem" type="button" disabled={disabled} className="flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:opacity-40" onClick={() => { setMenu(false); void Promise.resolve().then(action).catch(dock.report); }}>{icon}{name}</button>;
  return <div className="fixed inset-0 select-none" style={{ opacity: dock.ready ? 1 : 0 }} onPointerEnter={dock.enter} onPointerLeave={dock.leave}
    onKeyDown={event => { if (event.defaultPrevented || event.nativeEvent.isComposing) return; if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (dock.appearanceOpen) { dock.closeAppearance(); tabRef.current?.focus(); } else if (menu) setMenu(false); else void dock.dismiss(); } }}>
    <button ref={tabRef} type="button" aria-label={en ? `Open ${label}` : `展开${label}`} title={`${label}${summary ? ` · ${summary}` : ""}${dock.movementLocked ? (en ? " · Position locked; right-click to unlock" : " · 位置已锁定；右键可解锁") : (en ? " · Drag to reposition at top/left/right or another screen; double-click to restore" : " · 拖动调整上、左、右贴边位置或跨屏；双击恢复窗口")}`}
      aria-expanded={dock.opened} onClick={() => void dock.open(true)} onDoubleClick={() => void dock.undock()} onPointerDown={dock.startTabDrag}
      onContextMenu={event => { event.preventDefault(); void openMenu(); }}
      onKeyDown={event => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); void openMenu(); }
        if (event.ctrlKey && event.key === "Enter") { event.preventDefault(); void dock.undock(); }
        if (event.altKey && (top ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"]).includes(event.key)) { event.preventDefault(); void dock.moveInQueue(event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1); }
      }}
      className="group/arrow absolute z-20 flex items-center justify-center gap-1.5 overflow-hidden border-0 bg-popover px-3 text-brand outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
      style={{ ...stickyColorStyle(dock.appearance), top: dock.tabTop, width: dock.tabWidth, height: dock.tabHeight,
        ...(top ? { left: dock.tabLeft, paddingBottom: 8 } : { [left ? "left" : "right"]: 0 }),
        borderRadius: top ? "0 0 8px 8px" : left ? "0 8px 8px 0" : "8px 0 0 8px", flexDirection: left ? "row-reverse" : "row",
        clipPath: top ? "polygon(0 0,100% 0,100% calc(100% - 10px),50% 100%,0 calc(100% - 10px))" : left ? "polygon(0 0,calc(100% - 12px) 0,100% 50%,calc(100% - 12px) 100%,0 100%)" : "polygon(12px 0,100% 0,100% 100%,12px 100%,0 50%)" }}>
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 bg-current opacity-0 transition-opacity duration-100 group-hover/arrow:opacity-[0.06] group-active/arrow:opacity-[0.12]" />
      {top ? <ChevronDown className="relative size-4 shrink-0" /> : left ? <ChevronRight className="relative size-4 shrink-0" /> : <ChevronLeft className="relative size-4 shrink-0" />}
      <span className="relative flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
        <span className="w-full truncate text-[11px] font-semibold leading-4">{label}</span>
        {summary && <span className="w-full truncate text-[10px] leading-3 opacity-75 tabular-nums">{summary}</span>}
      </span>
    </button>
    <div aria-hidden={!dock.opened} inert={!dock.opened} className="absolute inset-y-0 overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-xl motion-safe:transition-opacity motion-safe:duration-150"
      style={{ top: top ? dock.tabHeight : 0, left: !top && left ? dock.tabWidth : 0, right: !top && !left ? dock.tabWidth : 0, visibility: dock.opened ? "visible" : "hidden", opacity: dock.opened ? 1 : 0 }}
      onDoubleClick={event => { if (!(event.target as HTMLElement).closest("button,input,textarea,select,a,[role],.daily-paper-row,[data-item],[data-item-id]")) void dock.undock(); }}>{children}
      {dock.canResize && <button type="button" aria-label={en ? "Resize preview" : "调整预览大小"} title={en ? "Drag to resize; arrow keys adjust by 10 px (Shift: 40)" : "拖动调整大小；方向键微调 10 像素，Shift 加速"}
        onPointerDown={dock.startResize} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? 40 : 10;
          dock.resizeBy(event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0);
        }}
        className={`absolute z-30 flex size-5 items-center justify-center rounded-sm text-muted-foreground/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring ${dock.tabTop > 0 ? "top-0" : "bottom-0"}`}
        style={{ [dock.resizeFromLeft ? "left" : "right"]: 0, cursor: dock.resizeFromLeft === (dock.tabTop > 0) ? "nwse-resize" : "nesw-resize", touchAction: "none" }}><Grip className="size-3" /></button>}
      {dock.resizePreview && <div role="status" className="pointer-events-none absolute inset-x-5 bottom-8 z-40 rounded-md bg-popover px-3 py-2 text-center text-xs tabular-nums shadow-lg">{dock.resizePreview.w} × {dock.resizePreview.h}</div>}
    </div>
    {menu && <div ref={menuRef} role="menu" aria-label={en ? "Window actions" : "窗口操作"} className="absolute z-40 w-48 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg" style={{ top: top ? dock.tabHeight + 8 : Math.max(8, Math.min(dock.tabTop, window.innerHeight - 320)), maxHeight: top ? `calc(100% - ${dock.tabHeight + 16}px)` : "calc(100% - 16px)", ...(top ? { left: Math.max(8, Math.min(dock.tabLeft, window.innerWidth - 200)) } : { [left ? "left" : "right"]: dock.tabWidth + 6 }) }}
      onKeyDown={event => {
        if (event.key === "Tab") { event.preventDefault(); setMenu(false); return; }
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
        buttons[index]?.focus();
      }}>
      {item(en ? "Restore window" : "恢复完整窗口", <Expand className="size-3.5" />, () => dock.undock())}
      {item(en ? "Fold preview" : "收起预览", <Minimize2 className="size-3.5" />, () => dock.dismiss())}
      {onToggleLock && item(locked ? (en ? "Unlock position" : "解锁位置与大小") : (en ? "Lock position" : "锁定位置与大小"), locked ? <UnlockKeyhole className="size-3.5" /> : <LockKeyhole className="size-3.5" />, onToggleLock)}
      {item(en ? "Move to other side" : "移到另一侧", <ArrowLeftRight className="size-3.5" />, () => dock.switchEdge(), dock.movementLocked)}
      {item(en ? "Dock at top" : "吸附顶部", <ArrowUp className="size-3.5" />, () => dock.dockToEdge("top"), dock.movementLocked || top)}
      {item(en ? "Dock at left" : "吸附左侧", <ChevronLeft className="size-3.5" />, () => dock.dockToEdge("left"), dock.movementLocked || left)}
      {item(en ? "Dock at right" : "吸附右侧", <ChevronRight className="size-3.5" />, () => dock.dockToEdge("right"), dock.movementLocked || dock.edge === "right")}
      {item(top ? (en ? "Move left" : "左移一个位置") : (en ? "Move up" : "上移一个位置"), <ArrowUp className="size-3.5" />, () => dock.moveInQueue(-1), dock.movementLocked || dock.queueLocked)}
      {item(top ? (en ? "Move right" : "右移一个位置") : (en ? "Move down" : "下移一个位置"), <ArrowDown className="size-3.5" />, () => dock.moveInQueue(1), dock.movementLocked || dock.queueLocked)}
      {item(en ? "Hide until recalled" : "隐藏（可从队列找回）", <EyeOff className="size-3.5" />, () => dock.hide())}
      {item(en ? "Sticky appearance and size" : "便签外观与大小", <Palette className="size-3.5" />, () => dock.openAppearance())}
    </div>}
    {dock.appearanceOpen && <div ref={appearanceRef} role="dialog" aria-label={en ? "Sticky appearance and size" : "便签外观与大小"}
      className="absolute inset-y-2 z-40 w-[282px] overflow-y-auto rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl"
      style={{ ...(top ? { left: 8, top: dock.tabHeight + 8 } : { [left ? "left" : "right"]: dock.tabWidth + 8 }), maxWidth: `calc(100% - ${top ? 16 : dock.tabWidth + 16}px)` }}
      onDoubleClick={event => event.stopPropagation()}>
      <div className="mb-3 flex items-center justify-between gap-3 text-xs font-semibold">{en ? "Sticky appearance and size" : "便签外观与大小"}
        <button type="button" aria-label={en ? "Close appearance settings" : "关闭外观设置"} onClick={() => { dock.closeAppearance(); tabRef.current?.focus(); }} className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><X className="size-3.5" /></button></div>
      <StickySettings value={dock.appearance} onChange={dock.changeAppearance} en={en} disabled={dock.sizeLocked} tabHeightLocked={dock.tabHeightLocked} tabWidthLocked={dock.tabWidthLocked} />
    </div>}
    {dock.error && <button type="button" onClick={() => void dock.undock()} className="absolute inset-0 z-50 bg-popover text-[10px] text-destructive" title={dock.error}>{en ? "Restore" : "恢复"}</button>}
  </div>;
}
