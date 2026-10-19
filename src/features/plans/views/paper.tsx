import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, CheckSquare, ChevronDown, ChevronUp, Copy, PictureInPicture2, Pin, PinOff, Plus, Redo2, Search, Trash2, Undo2, X } from "lucide-react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { readMonitors } from "@/features/desktop/monitors";
import { dragDockEdge } from "@/features/files/fence-geometry";
import { isDesktopVisible, setDesktopVisibility } from "@/features/desktop/visibility";
import {
  childrenOf,
  parseDate,
  shouldSplitPaste,
  splitPastedLines,
  type PlanTask,
} from "@/features/plans/types";
import { useDayTasks, useNow, usePlans } from "@/features/plans/store";
import { flattenTree } from "@/features/plans/capsule";
import { findPaperTasks, paperDragScroll, paperKeyAction, pastedTaskTitles } from "@/features/plans/paper-interactions";
import { CapsuleView } from "@/features/plans/views/capsule";
import { queueWindowOperation } from "@/features/desktop/edge-dock";
import { COLLAPSED_PAPER_H, normalPaperGeometry } from "@/features/plans/capsule-window";
import { IconBtn, PaperRow } from "@/features/plans/views/paper-row";
import { usePapers } from "@/stores/papers";
import { cn } from "@/lib/utils";
import { inTauri, windowReady } from "@/lib/tauri";
import { usePlanCopy } from "@/features/plans/copy";
import { closeDailyTodo, useTaskWindowSettings } from "@/features/plans/window-runtime";
import { StorageAlert } from "@/components/shell/storage-alert";
import { Providers } from "@/app/providers";

/**
 * 桌面「待办纸片」窗口。
 *
 * 形态目标（对齐 PaperTodo 的「纸片」心智）：一张常驻桌面的小纸条，
 * 一眼看完今天的待办，勾一下就走 —— 不是第二个全屏列表。
 *
 * 与文件栅栏的差别：
 *   - 栅栏是「内容容器」：图标网格 + 分页 + 拖入收集文件
 *   - 纸片是「列表视图」：任务行 + 勾选 + 快速添加
 *   两者共用同一套窗口机制（透明/无边框/置底）与几何持久化思路，
 *   但内容与交互完全不同，所以是独立组件而不是给 FencePanel 加分支。
 */

/**
 * store 是否已完成水合。
 *
 * 「写错会留下粘性标记」的操作（层级就是典型）必须先等水合：
 * 水合前读到的是缺省值，据此写下的东西本身就是待撤销的，
 * 而「写下」和「撤销」两条 async 链交错时落地顺序并不保证。
 */
function usePapersHydrated(): boolean {
  const [ok, setOk] = useState(() => usePapers.persist.hasHydrated());
  useEffect(() => {
    if (usePapers.persist.hasHydrated()) {
      setOk(true);
      return;
    }
    // 刻意不用 useRef 一次性门控：StrictMode 的 effect→cleanup→effect 会让
    // 第二次直接 return，退订后再不重订（本项目在纸片恢复上已经踩过一次）
    return usePapers.persist.onFinishHydration(() => setOk(true));
  }, []);
  return ok;
}

export function TodoPaperWindow({ date }: { date: string }) {
  useTaskWindowSettings();
  const form = usePapers((s) => s.papers[date]?.form) ?? "paper";
  const pinned = usePapers((s) => s.papers[date]?.pinned) ?? false;
  const hydrated = usePapersHydrated();
  const [windowError, setWindowError] = useState("");
  const initialWindowShown = useRef(false);

  useEffect(() => {
    if (!inTauri || !hydrated || form !== "paper") return;
    const win = getCurrentWebviewWindow();
    let alive = true;
    const current = () => alive && (usePapers.getState().papers[date]?.form ?? "paper") === "paper";
    const subscription = listen<{ action: "restore" | "fold" | "hide" }>("desktop://window-action", ({ payload }) => {
      setDesktopVisibility(win.label, payload.action !== "hide");
      void queueWindowOperation(win.label, async () => {
        if (payload.action === "hide") { if (!isDesktopVisible(win.label)) await win.hide(); return; }
        if (!current()) return;
        if (!isDesktopVisible(win.label)) return;
        if (payload.action === "fold") {
          const geometry = await normalPaperGeometry(win, () => ({ active: current(), collapsed: usePapers.getState().papers[date]?.collapsed ?? false }));
          if (!current() || !isDesktopVisible(win.label)) return;
          if (geometry) usePapers.getState().setGeometry(date, geometry);
          usePapers.getState().setForm(date, "capsule");
          return;
        }
        const [position, size, areas] = await Promise.all([win.outerPosition(), win.outerSize(), readMonitors()]);
        if (!current() || !isDesktopVisible(win.label)) return;
        if (!areas.some(area => position.x + size.width > area.x && position.x < area.x + area.w && position.y + 36 > area.y && position.y < area.y + area.h) && areas[0]) {
          const area = areas[0];
          await win.setPosition(new PhysicalPosition(area.x + 40 * area.scale, area.y + 40 * area.scale));
        }
        if (!current() || !isDesktopVisible(win.label)) return;
        await win.show();
        if (current() && isDesktopVisible(win.label)) await win.setFocus();
      }).catch(error => { if (current()) setWindowError(String(error)); });
    }, { target: win.label });
    return () => { alive = false; void subscription.then(off => off()); };
  }, [date, form, hydrated]);

  // System close follows the same explicit, persisted-close path as the header.
  useEffect(() => {
    if (!inTauri) return;
    const win = getCurrentWebviewWindow();
    const unClose = win.onCloseRequested((event) => {
      event.preventDefault();
      void closeDailyTodo(date);
    });
    return () => {
      void unClose.then((fn) => fn());
    };
  }, [date]);

  useEffect(() => {
    if (!inTauri || !hydrated) return;
    if (form === "capsule") { initialWindowShown.current = true; return; }
    if (initialWindowShown.current) return;
    initialWindowShown.current = true;
    void windowReady().catch((error) => setWindowError(String(error)));
  }, [hydrated, form]);

  // Normal paper owns its paired top/bottom flags only while mounted in paper form.
  // Capsule placement and z-order are exclusively owned by the shared edge dock.
  useEffect(() => {
    if (!inTauri || !hydrated || form !== "paper") return;
    const win = getCurrentWebviewWindow();
    let canceled = false;
    const current = () => !canceled && (usePapers.getState().papers[date]?.form ?? "paper") === "paper";
    // The edge controller uses this same queue. A pending normal-window write
    // finishes before docking; its canceled remainder cannot push the tab down.
    void queueWindowOperation(win.label, async () => {
      if (!current()) return;
      if (pinned) await win.setAlwaysOnBottom(false);
      else await win.setAlwaysOnTop(false);
      if (!current()) return;
      if (pinned) await win.setAlwaysOnTop(true);
      else await win.setAlwaysOnBottom(true);
      if (current()) setWindowError("");
    }).catch((error) => { if (current()) setWindowError(String(error)); });
    return () => { canceled = true; };
  }, [date, form, pinned, hydrated]);

  return <Providers>{hydrated && <>{windowError && <div role="alert" className="absolute inset-x-2 top-10 z-50 rounded bg-destructive/15 p-2 text-xs text-destructive">{windowError}</div>}{form === "capsule" ? <CapsuleWindow date={date} /> : <PaperPanel date={date} />}</>}</Providers>;
}

/** Switch the stored form only after the shared edge controller restores the normal window. */
function CapsuleWindow({ date }: { date: string }) {
  const setForm = usePapers((s) => s.setForm);
  // The dock restores size, position and paired z-order before this callback.
  const expand = useCallback(() => setForm(date, "paper"), [date, setForm]);
  const close = useCallback(async () => {
    await closeDailyTodo(date);
  }, [date]);

  return <CapsuleView date={date} onExpand={expand} onClose={() => void close()} />;
}

function PaperPanel({ date }: { date: string }) {
  const { t, i18n } = useTranslation();
  const copy = usePlanCopy();
  const tasks = useDayTasks(date);
  const now = useNow();
  const addTask = usePlans((s) => s.addTask);
  const addTasks = usePlans((s) => s.addTasks);
  const toggleDone = usePlans((s) => s.toggleDone);
  const updateTask = usePlans((s) => s.updateTask);
  const history = usePlans((s) => s.history);

  const paper = usePapers((s) => s.papers[date]);
  const setGeometry = usePapers((s) => s.setGeometry);
  const setCollapsed = usePapers((s) => s.setCollapsed);
  const setPinned = usePapers((s) => s.setPinned);
  const setForm = usePapers((s) => s.setForm);

  const collapsed = paper?.collapsed ?? false;
  const pinned = paper?.pinned ?? false;

  const [input, setInput] = useState("");
  const [operationError, setOperationError] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const selectionAnchor = useRef<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const findRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  type DragState = { sourceId: string; targetId?: string; position?: "before" | "after" };
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const dragPointer = useRef({ x: 0, y: 0 });
  const dragFrame = useRef(0);
  const orderedTasks = useMemo(() => flattenTree(tasks).map(row => row.task), [tasks]);
  const selectedIds = useMemo(() => orderedTasks.filter(task => selected.has(task.id)).map(task => task.id), [orderedTasks, selected]);
  const matches = useMemo(() => findPaperTasks(orderedTasks, query), [orderedTasks, query]);
  const activeMatch = matches.length ? matches[matchIndex % matches.length] : undefined;
  const rootRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const resizing = useRef(0);
  const titleDragCleanup = useRef<(() => void) | null>(null);
  const titleDragging = useRef(false);
  useEffect(() => {
    generation.current++;
    return () => {
      generation.current++;
      titleDragCleanup.current?.();
    };
  }, []);
  const current = useCallback((epoch: number) => generation.current === epoch && (usePapers.getState().papers[date]?.form ?? "paper") === "paper", [date]);

  const cancelDrag = useCallback(() => {
    dragRef.current = null; setDrag(null);
    cancelAnimationFrame(dragFrame.current); dragFrame.current = 0;
  }, []);
  useEffect(() => cancelDrag, [cancelDrag]);
  useEffect(() => {
    if (findOpen) findRef.current?.focus();
  }, [findOpen]);
  useEffect(() => {
    if (!activeMatch || !findOpen) return;
    const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-paper-task]") ?? []).find(node => node.dataset.paperTask === activeMatch);
    row?.scrollIntoView({ block: "nearest" });
  }, [activeMatch, findOpen, collapsed]);

  const updateDragTarget = useCallback(() => {
    const session = dragRef.current;
    const list = listRef.current;
    if (!session || !list) return;
    const node = document.elementFromPoint(dragPointer.current.x, dragPointer.current.y)?.closest<HTMLElement>("[data-paper-task]");
    const day = usePlans.getState().days[date] ?? [];
    const source = day.find(task => task.id === session.sourceId);
    const target = day.find(task => task.id === node?.dataset.paperTask);
    const valid = node && list.contains(node) && source && target && source.id !== target.id && source.parentId === target.parentId;
    const next: DragState = valid ? { sourceId: source.id, targetId: target.id, position: dragPointer.current.y < node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2 ? "before" : "after" } : { sourceId: session.sourceId };
    if (next.targetId !== session.targetId || next.position !== session.position) { dragRef.current = next; setDrag(next); }
  }, [date]);

  const startTaskDrag = (event: DragEvent<HTMLElement>, id: string) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/x-nimbus-task", id);
    dragPointer.current = { x: event.clientX, y: event.clientY };
    const next = { sourceId: id }; dragRef.current = next; setDrag(next);
    const frame = () => {
      if (!dragRef.current) return;
      const list = listRef.current;
      if (list) {
        const rect = list.getBoundingClientRect();
        list.scrollTop += paperDragScroll(dragPointer.current.y, rect.top, rect.bottom);
        updateDragTarget();
      }
      dragFrame.current = requestAnimationFrame(frame);
    };
    dragFrame.current = requestAnimationFrame(frame);
  };

  const overTask = (event: DragEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    dragPointer.current = { x: event.clientX, y: event.clientY }; updateDragTarget();
  };
  const dropTask = (event: DragEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    event.preventDefault(); event.stopPropagation();
    dragPointer.current = { x: event.clientX, y: event.clientY }; updateDragTarget();
    const session = dragRef.current;
    cancelDrag();
    if (session?.targetId && session.position) usePlans.getState().reorderTask(date, session.sourceId, session.targetId, session.position);
  };

  const selectTask = (id: string, shift: boolean) => {
    const anchor = orderedTasks.findIndex(task => task.id === selectionAnchor.current);
    const at = orderedTasks.findIndex(task => task.id === id);
    setSelected(previous => {
      const next = new Set(previous);
      if (shift && anchor >= 0 && at >= 0) {
        for (const task of orderedTasks.slice(Math.min(anchor, at), Math.max(anchor, at) + 1)) next.add(task.id);
      } else if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    selectionAnchor.current = id;
  };

  const copySelected = async () => {
    try {
      await navigator.clipboard.writeText(orderedTasks.filter(task => selected.has(task.id)).map(task => `${task.done ? "- [x]" : "- [ ]"} ${task.title}`).join("\n"));
      setOperationError("");
    } catch { setOperationError(copy.copyFailed); }
  };
  const deleteSelected = () => {
    usePlans.getState().removeTasks(date, selectedIds);
    setSelected(new Set());
  };
  const navigateMatch = (direction: number) => setMatchIndex(index => matches.length ? (index + direction + matches.length) % matches.length : 0);

  /**
   * 标题栏拖动。
   *
   * 不用 `data-tauri-drag-region`：它把双击实现成「切换最大化」，
   * 而桌面纸片双击标题的合理行为是「什么都不做」（标题就是日期，不可改）。
   * 也用 4px 阈值：不设阈值的话，单击标题栏（想选中/聚焦窗口）会立刻
   * 触发系统拖动，鼠标一动窗口就跑了。
   */
  const startTitleDrag = (e: React.PointerEvent) => {
    if (e.button !== 0 || !inTauri || titleDragging.current) return;
    if ((e.target as HTMLElement).closest("button,input")) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let dragging = false;
    const el = e.currentTarget as HTMLElement;
    const win = getCurrentWebviewWindow();
    titleDragCleanup.current?.();

    const onMove = (ev: PointerEvent) => {
      if (dragging) return;
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      dragging = true;
      cleanup();
      titleDragging.current = true;
      const epoch = generation.current;
      const active = () => current(epoch) && usePapers.getState().papers[date]?.open !== false;
      void (async () => {
        await win.startDragging();
        const released = await invoke<boolean>("desktop_wait_drag_end");
        if (!released || !active()) return;
        await queueWindowOperation(win.label, async () => {
          if (!active()) return;
          const [geometry, areas, factor] = await Promise.all([
            normalPaperGeometry(win, () => ({ active: active(), collapsed: usePapers.getState().papers[date]?.collapsed ?? false })),
            readMonitors(), win.scaleFactor(),
          ]);
          if (!geometry || !active() || !Number.isFinite(factor) || factor <= 0) return;
          const rect = { ...geometry, h: geometry.h ?? COLLAPSED_PAPER_H };
          const cx = (rect.x + rect.w / 2) * factor, cy = (rect.y + rect.h / 2) * factor;
          const distance = (area: (typeof areas)[number]) => Math.hypot(
            cx - Math.max(area.x, Math.min(cx, area.x + area.w)),
            cy - Math.max(area.y, Math.min(cy, area.y + area.h)),
          );
          const area = areas.reduce<(typeof areas)[number] | undefined>((best, candidate) => !best || distance(candidate) < distance(best) ? candidate : best, undefined);
          if (!active()) return;
          if (!area) { setGeometry(date, geometry); return; }
          const logicalArea = { x: area.x / factor, y: area.y / factor, w: area.w / factor, h: area.h / factor };
          const edge = dragDockEdge(rect, logicalArea, true);
          if (!edge) { setGeometry(date, geometry); return; }
          const offset = Math.max(0, edge === "top" ? rect.x - logicalArea.x : rect.y - logicalArea.y);
          setGeometry(date, { ...geometry, edge, edgeY: offset, dockOffset: offset, edgeMonitor: area.id, form: "capsule" });
        });
        if (active()) setOperationError("");
      })().catch(error => { if (active()) setOperationError(String(error)); }).finally(() => { titleDragging.current = false; });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      el.removeEventListener("pointercancel", cleanup);
      if (titleDragCleanup.current === cleanup) titleDragCleanup.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    el.addEventListener("pointercancel", cleanup);
    titleDragCleanup.current = cleanup;
  };

  /**
   * 收起态只显示根级任务的前几条。
   *
   * 收起的意义是「省桌面空间」，所以这里刻意**不**展开子树 ——
   * 展开子树会让收起态的高度随数据变化，那就不叫收起了。
   */
  const roots = useMemo(() => childrenOf(tasks, null), [tasks]);
  const visible = collapsed ? roots.slice(0, 3) : roots;
  const doneCount = tasks.filter((task) => task.done).length;

  const dateLabel = useMemo(() => {
    return new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" }).format(parseDate(date));
  }, [date, i18n.language]);

  const renderTask = (task: PlanTask, ancestors: Set<string> = new Set()): React.ReactNode => {
    if (ancestors.has(task.id)) return null;
    const next = new Set(ancestors).add(task.id);
    const children = collapsed ? [] : childrenOf(tasks, task.id);
    const siblings = childrenOf(tasks, task.parentId);
    const index = siblings.findIndex(sibling => sibling.id === task.id);
    return (
      <div key={task.id}>
        <PaperRow date={date} task={task} now={now}
          onToggle={() => toggleDone(date, task.id)}
          onEdit={(title) => updateTask(date, task.id, { title })}
          onTimeChange={(time) => updateTask(date, task.id, time)}
          onAddChild={collapsed ? undefined : (title) => addTask(date, task.id, title)}
          onDelete={() => usePlans.getState().removeTask(date, task.id)}
          selected={selected.has(task.id)}
          onSelect={selectionMode ? (shift) => selectTask(task.id, shift) : undefined}
          searchMatch={findOpen && matches.includes(task.id) ? (activeMatch === task.id ? "current" : "match") : undefined}
          reorder={collapsed ? undefined : {
            active: drag?.sourceId === task.id,
            position: drag?.targetId === task.id ? drag.position : undefined,
            onMoveUp: index > 0 ? () => usePlans.getState().reorderTask(date, task.id, siblings[index - 1].id, "before") : undefined,
            onMoveDown: index < siblings.length - 1 ? () => usePlans.getState().reorderTask(date, task.id, siblings[index + 1].id, "after") : undefined,
            onStart: event => startTaskDrag(event, task.id), onEnd: cancelDrag, onOver: overTask, onDrop: dropTask,
          }} />
        {children.length > 0 && <div className="daily-paper-tree" style={next.size > 4 ? { marginLeft: 0, paddingLeft: 2 } : undefined}>
          {children.map((child) => renderTask(child, next))}
        </div>}
      </div>
    );
  };

  const submit = () => {
    const v = input.trim();
    if (!v) return;
    if (shouldSplitPaste(v)) {
      const lines = splitPastedLines(v);
      if (lines.length > 1) {
        addTasks(date, null, lines);
        setInput("");
        return;
      }
    }
    addTask(date, null, v);
    setInput("");
  };

  /* ── 窗口几何持久化 ──────────────────────────────────
     与栅栏同一套做法：拖动/缩放结束时把几何写回 store，
     Rust 侧不保存任何窗口状态（单一数据源在前端）。 */

  const persistGeometry = useCallback(async () => {
    if (!inTauri || resizing.current > 0) return;
    const epoch = generation.current;
    const win = getCurrentWebviewWindow();
    try {
      await queueWindowOperation(win.label, async () => {
        const geometry = await normalPaperGeometry(win, () => ({ active: current(epoch) && resizing.current === 0, collapsed: usePapers.getState().papers[date]?.collapsed ?? false }));
        if (geometry && current(epoch)) setGeometry(date, geometry);
      });
    } catch {
      // Snapshot failures leave the last normal geometry untouched.
    }
  }, [date, setGeometry, current]);

  useEffect(() => {
    const onResize = () => void persistGeometry();
    window.addEventListener("resize", onResize);
    let canceled = false;
    const unMove = inTauri ? getCurrentWebviewWindow().onMoved(() => { if (!canceled) void persistGeometry(); }) : null;
    return () => {
      canceled = true;
      window.removeEventListener("resize", onResize);
      void unMove?.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [persistGeometry]);

  /**
   * 置顶开关只改状态，窗口层级由 TodoPaperWindow 的 effect 统一落。
   *
   * 不在这里顺手调 setAlwaysOnTop：纸片窗口的层级写入点只能有一个 ——
   * 置顶 / 压底是互斥标记，谁最后写入谁说了算，散在两处必然打架
   * （曾经就因此出现「只开一张纸片时置顶正常、多开一张就掉回底层」）。
   */
  const togglePin = () => setPinned(date, !pinned);

  const close = async () => {
    await closeDailyTodo(date);
  };

  /**
   * 收起/展开时要同时改窗口高度。
   *
   * 只改 CSS 会出现「内容变短了但窗口还是那么高」——桌面上一块透明区域
   * 照样拦截鼠标，用户点不到下面的东西。所以必须连窗口一起缩。
   */
  const toggleCollapse = async () => {
    const previous = usePapers.getState().papers[date]?.collapsed ?? false;
    const next = !previous;
    const epoch = generation.current;
    if (inTauri) resizing.current++;
    setCollapsed(date, next);
    if (!inTauri) return;
    try {
      const win = getCurrentWebviewWindow();
      await queueWindowOperation(win.label, async () => {
        const state = usePapers.getState().papers[date];
        if (!current(epoch) || (state?.collapsed ?? false) !== next) return;
        await win.setSize(new LogicalSize(state?.w ?? 260, next ? COLLAPSED_PAPER_H : state?.h ?? 360));
        if (current(epoch)) setOperationError("");
      });
    } catch (error) {
      if (!current(epoch)) return;
      if ((usePapers.getState().papers[date]?.collapsed ?? false) === next) setCollapsed(date, previous);
      setOperationError(String(error));
    } finally {
      resizing.current--;
    }
  };

  const openFind = () => {
    if (collapsed) void toggleCollapse();
    setFindOpen(true);
    requestAnimationFrame(() => { findRef.current?.focus(); findRef.current?.select(); });
  };
  const onPaperKey = (event: globalThis.KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const target = event.target instanceof HTMLElement ? event.target : document.body;
    const editable = !!target.closest("input,textarea,select,[contenteditable=true]");
    const action = paperKeyAction(event, { editable, findInput: !!target.closest("[data-paper-find]"), composing: composing.current, dragging: !!dragRef.current, findOpen, selectedCount: selectedIds.length });
    if (!action) return;
    event.preventDefault(); event.stopPropagation();
    switch (action) {
      case "cancel-edit": target.blur(); break;
      case "cancel-drag": cancelDrag(); break;
      case "close-find": setFindOpen(false); break;
      case "clear-selection": setSelected(new Set()); setSelectionMode(false); break;
      case "fold": setForm(date, "capsule"); break;
      case "find": openFind(); break;
      case "find-next": openFind(); navigateMatch(1); break;
      case "find-previous": openFind(); navigateMatch(-1); break;
      case "undo": usePlans.getState().undo(); break;
      case "redo": usePlans.getState().redo(); break;
      case "select-all": setSelectionMode(true); setSelected(new Set(orderedTasks.map(task => task.id))); break;
      case "copy": void copySelected(); break;
      case "delete": deleteSelected(); break;
    }
  };
  useEffect(() => {
    window.addEventListener("keydown", onPaperKey);
    return () => window.removeEventListener("keydown", onPaperKey);
  });

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      className="daily-paper flex h-screen w-screen flex-col overflow-hidden rounded-xl border border-border/70 text-[13px] shadow-[var(--workbench-shadow)]"
      style={{
        // 半透明纸感：85% 卡片色 + 模糊，桌面内容透出一点点，但文字仍然清晰
        background: "var(--workbench-glass, var(--card))",
        backdropFilter: "blur(14px) saturate(1.1)",
      }}
    >
      {/* ── 标题栏：整条可拖，标题双击不改名（与栅栏一致：纸片标题就是日期） ── */}
      <div
        onPointerDown={startTitleDrag}
        onAuxClick={(event) => { if (event.button === 1 && !(event.target as HTMLElement).closest("button,input")) { event.preventDefault(); cancelDrag(); setForm(date, "capsule"); } }}
        onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
        className="flex h-9 shrink-0 cursor-default items-center gap-2 border-b border-border/60 px-2.5 select-none"
      >
        <span className="min-w-0 flex-1 truncate font-semibold" title={`${date} · ${copy.dailyTodos}`}>
          {dateLabel}
        </span>
        {tasks.length > 0 && (
          <span className="shrink-0 rounded-full bg-brand/10 px-1.5 text-[10px] font-semibold tabular-nums text-brand">
            {doneCount}/{tasks.length}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          <span className={cn("rounded", pinned && "bg-brand/15 text-brand")}>
          <IconBtn pressed={pinned} label={pinned ? copy.unpin : copy.pin} onClick={() => void togglePin()}>
            {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          </IconBtn>
          </span>
          <IconBtn
            label={collapsed ? t("plans.expandPaper") : t("plans.collapsePaper")}
            onClick={() => void toggleCollapse()}
          >
            {collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </IconBtn>
          <IconBtn label={t("plans.capsuleToEdge")} onClick={() => setForm(date, "capsule")}>
            <PictureInPicture2 className="size-3.5" />
          </IconBtn>
          <IconBtn label={copy.close} danger onClick={() => void close()}>
            <X className="size-3.5" />
          </IconBtn>
        </div>
      </div>

      <StorageAlert />
      {operationError && <div role="alert" className="px-2.5 py-1.5 text-xs text-destructive">{operationError}</div>}

      {!collapsed && <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1">
        <IconBtn label={`${copy.find} (Ctrl+F)`} pressed={findOpen} onClick={openFind}><Search size={14}/></IconBtn>
        <IconBtn label={`${copy.selection} (Ctrl+A)`} pressed={selectionMode} onClick={() => { setSelectionMode(!selectionMode); setSelected(new Set()); }}><CheckSquare size={14}/></IconBtn>
        <span className="flex-1"/>
        <IconBtn label={`${copy.undo} (Ctrl+Z)`} disabled={!history.past.length} onClick={() => usePlans.getState().undo()}><Undo2 size={14}/></IconBtn>
        <IconBtn label={`${copy.redo} (Ctrl+Y)`} disabled={!history.future.length} onClick={() => usePlans.getState().redo()}><Redo2 size={14}/></IconBtn>
        <IconBtn label={copy.clearDone} disabled={!doneCount} onClick={() => usePlans.getState().clearDone(date)}><Trash2 size={14}/></IconBtn>
      </div>}

      {findOpen && <div data-paper-find className="flex min-h-9 shrink-0 items-center gap-0.5 border-b border-border/60 px-2">
        <input ref={findRef} value={query} aria-label={copy.find} placeholder={copy.find} className="min-w-0 flex-1 bg-transparent text-xs outline-none"
          onChange={event => { setQuery(event.target.value); setMatchIndex(0); }}
          onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); navigateMatch(event.shiftKey ? -1 : 1); } }}/>
        <span role="status" aria-live="polite" title={matches.length ? undefined : copy.noMatches} className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{matches.length ? `${matchIndex % matches.length + 1}/${matches.length}` : "0/0"}</span>
        <IconBtn label={copy.previousMatch} disabled={!matches.length} onClick={() => navigateMatch(-1)}><ChevronUp size={14}/></IconBtn>
        <IconBtn label={copy.nextMatch} disabled={!matches.length} onClick={() => navigateMatch(1)}><ChevronDown size={14}/></IconBtn>
        <IconBtn label={copy.closeFind} onClick={() => setFindOpen(false)}><X size={14}/></IconBtn>
      </div>}

      {selectionMode && <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1">
        <span className="mr-auto text-[11px] text-muted-foreground" aria-live="polite">{selectedIds.length} {copy.selected}</span>
        <IconBtn label={copy.selectAll} onClick={() => setSelected(new Set(orderedTasks.map(task => task.id)))}><CheckSquare size={14}/></IconBtn>
        <IconBtn label={copy.complete} disabled={!selectedIds.length} onClick={() => usePlans.getState().setTasksDone(date, selectedIds, true)}><Check size={14}/></IconBtn>
        <IconBtn label={copy.restore} disabled={!selectedIds.length} onClick={() => usePlans.getState().setTasksDone(date, selectedIds, false)}><Undo2 size={14}/></IconBtn>
        <IconBtn label={copy.copy} disabled={!selectedIds.length} onClick={() => void copySelected()}><Copy size={14}/></IconBtn>
        <IconBtn label={copy.remove} disabled={!selectedIds.length} danger onClick={deleteSelected}><Trash2 size={14}/></IconBtn>
        <IconBtn label={copy.clearSelection} onClick={() => { setSelected(new Set()); setSelectionMode(false); }}><X size={14}/></IconBtn>
      </div>}

      {/* ── 任务列表 ── */}
      <div ref={listRef} onDragOver={overTask} onDrop={dropTask} onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        if (dragRef.current) { const next = { sourceId: dragRef.current.sourceId }; dragRef.current = next; setDrag(next); }
      }} className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {visible.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-muted-foreground/70">
            {t("plans.emptyDay")}
          </p>
        ) : (
          visible.map((task) => renderTask(task))
        )}
        {collapsed && roots.length > visible.length && (
          <p className="px-2 py-1 text-[11px] text-muted-foreground/70">
            {t("plans.moreTasks", { count: roots.length - visible.length })}
          </p>
        )}
      </div>

      {/* ── 快速添加：收起态隐藏（收起是为了省空间） ── */}
      {!collapsed && (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-border/60 px-2.5 py-1.5">
          <Plus className="size-3.5 shrink-0 text-brand" strokeWidth={2.4} />
          <input
            value={input}
            aria-label={t("plans.addPlaceholder")}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(event) => {
              const field = event.currentTarget;
              const titles = pastedTaskTitles(event.clipboardData.getData("text/plain"), input.slice(0, field.selectionStart ?? input.length), input.slice(field.selectionEnd ?? input.length));
              if (!titles || composing.current) return;
              event.preventDefault(); addTasks(date, null, titles); setInput("");
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "Enter") { event.preventDefault(); submit(); }
              if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w")) { event.preventDefault(); event.stopPropagation(); setInput(""); event.currentTarget.blur(); }
            }}
            placeholder={t("plans.addPlaceholder")}
            className="w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
          />
        </div>
      )}
    </div>
  );
}
