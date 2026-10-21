import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { availableMonitors, currentMonitor, cursorPosition, type Monitor } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  BookOpen, CalendarCheck, ChevronLeft, ChevronRight, FolderKanban, GripHorizontal,
  GripVertical, LayoutGrid, List, Search, Settings2, X,
} from "lucide-react";
import { RiAddLine, RiAttachment2, RiClipboardLine, RiCloseLine, RiDeleteBinLine, RiPushpinLine, RiSparklingLine } from "@remixicon/react";
import { chatWithProvider, testProvider } from "@/features/ai/client";
import { selectProvider } from "@/features/ai/core";
import { providersReady, useProviders } from "@/features/ai/providers";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useModal } from "@/components/shell/modal-host";
import { inTauri, openPath, openUrl } from "@/lib/tauri";
import { useSettings } from "@/stores/settings";
import { sortedTopCategories, useFiles } from "@/stores/files";
import { usePlans } from "@/features/plans/store";
import { todayStr } from "@/features/plans/types";
import { addTaskAttachment, attachmentSize, openTaskAttachment, unlinkTaskAttachment } from "@/features/plans/attachment-api";
import { useProjects } from "@/features/projects/store";
import { CaptureForm } from "@/features/knowledge/capture";
import { beginMenu, closeMenu, emitMenuRequest, ensurePopupReady, ownerLabel, revealMenu, subscribeMenuSize, useMenuActions, type MenuAction } from "@/features/files/popup";
import type { MenuIconKey, MenuNode } from "@/features/files/menu-model";import { monitorArea } from "./monitors";
import { DOCK_CAPTURE_H, dockBounds, dockSpringPair, type DockArea, type DockMode, type DockPanel } from "./dock-core";
import { nearestDockEdge } from "./edge-core";
import { ItemIcon } from "@/features/files/icons";
import "./dock.css";

/** 与 Rust 侧 `dock_open` 固定的 label 一致。 */
const LABEL = "desktop-dock";

function report(error: unknown) { toast.error(String(error)); }

export function DockWindow() {
  const { t, i18n } = useTranslation();
  const modal = useModal();
  const edge = useSettings((s) => s.dockEdge);
  const theme = useSettings((s) => s.theme);
  const today = todayStr();
  const todayTasks = usePlans((s) => s.days[today]);
  const allItems = useProjects((s) => s.items);
  const allProjects = useProjects((s) => s.projects);
  const areaRef = useRef<DockArea | null>(null);
  const modeRef = useRef<DockMode>("strip");
  const switchAt = useRef(0);
  const [panel, setPanelState] = useState<DockPanel | null>(null);
  const [mode, setModeState] = useState<DockMode>("strip");
  const panelRef = useRef<DockPanel | null>(null);

  /** 角标：计划=今天未完成数；项目=逾期未完成数 */
  const plansBadge = useMemo(() => (todayTasks ?? []).filter((task) => !task.done).length, [todayTasks]);
  const overdueBadge = useMemo(() =>
    allItems.filter((item) => item.status !== "done" && item.status !== "cancelled" && item.deadline && item.deadline < today).length,
  [allItems, today]);
  const activeProjects = useMemo(() =>
    allProjects
      .filter((project) => project.status === "active")
      .sort((a, b) => b.updatedAt - a.updatedAt), [allProjects]);

  const setMode = useCallback((next: DockMode) => {
    modeRef.current = next;
    setModeState(next);
  }, []);

  const applyMode = useCallback(async (mode: DockMode) => {
    if (!inTauri) return;
    // 跟随鼠标：Dock 落在光标所在的显示器（多屏时在哪个屏工作就出现在哪）
    const [cursor, monitors, current] = await Promise.all([
      cursorPosition().catch(() => null),
      availableMonitors().catch(() => [] as Monitor[]),
      currentMonitor().catch(() => null),
    ]);
    const monitor = (cursor && monitors.find((m) => {
      const p = m.position;
      const s = m.size;
      return cursor.x >= p.x && cursor.x < p.x + s.width && cursor.y >= p.y && cursor.y < p.y + s.height;
    })) ?? current;
    if (!monitor) return;
    const raw = monitorArea(monitor);
    const scale = raw.scale || 1;
    // MonitorArea 是物理像素；dock-core 的口径是逻辑像素。
    const area: DockArea = { x: raw.x / scale, y: raw.y / scale, w: raw.w / scale, h: raw.h / scale };
    areaRef.current = area;
    const height = panelRef.current === "capture" ? DOCK_CAPTURE_H : undefined;
    const bounds = dockBounds(area, edge, mode, undefined, height);
    const sameMode = mode === modeRef.current;
    // 顶缘的形变是高度变化，而 dock_spring 只做横向弹簧，故顶缘直接落位。
    if (sameMode || edge === "top") {
      await invoke("window_set_bounds", {
        label: LABEL, x: Math.round(bounds.x * scale), y: Math.round(bounds.y * scale),
        width: Math.round(bounds.w * scale), height: Math.round(bounds.h * scale),
      });
      if (!sameMode) setMode(mode);
      return;
    }
    const { from, to } = dockSpringPair(area, edge, modeRef.current, mode, undefined, height);
    setMode(mode);
    await invoke("dock_spring", {
      label: LABEL, fromX: from.x, toX: to.x, fromW: from.w, toW: to.w,
      y: to.y, h: to.h, style: "stiff",
    });
  }, [edge, setMode]);

  /** 面板开合；窗口位置固定，侧栏绝不因开面板而移动。 */
  const setPanel = useCallback((next: DockPanel | null) => {
    panelRef.current = next;
    switchAt.current = Date.now();
    setPanelState(next);
    void applyMode(next ? "flyout" : "strip").catch(report);
  }, [applyMode]);

  /** 拖动 grip 松手后，按窗口落点吸附到最近的顶/左/右缘（复用 edge-core 口径）。 */
  const dragging = useRef(false);
  const startDrag = useCallback(() => {
    if (dragging.current || !inTauri) return;
    dragging.current = true;
    const win = getCurrentWebviewWindow();
    void (async () => {
      await win.startDragging();
      const committed = await invoke<boolean>("desktop_wait_drag_end").catch(() => false);
      dragging.current = false;
      if (!committed) return;
      // 拖动换位后飞出面板不再贴合新缘，直接收起
      if (panelRef.current) setPanel(null);
      const [pos, size, monitor] = await Promise.all([
        win.outerPosition(), win.outerSize(), currentMonitor().catch(() => null),
      ]);
      if (!monitor) return;
      const raw = monitorArea(monitor);
      const scale = raw.scale || 1;
      const area: DockArea = { x: raw.x / scale, y: raw.y / scale, w: raw.w / scale, h: raw.h / scale };
      const rect = { x: pos.x / scale, y: pos.y / scale, w: size.width / scale, h: size.height / scale };
      const store = useSettings.getState();
      const next = nearestDockEdge(rect, area);
      if (next !== store.dockEdge) store.setDockEdge(next);
      else void applyMode(modeRef.current).catch(report);
    })().catch((error) => { dragging.current = false; report(error); });
  }, [applyMode, setPanel]);

  useEffect(() => {
    if (!inTauri) return;
    void (async () => {
      await applyMode("strip");
      await invoke("window_show_no_activate", { label: LABEL });
    })().catch(report);
    // 失焦即收起面板：点击了外部应用或打开了文件后，面板不该留在原地。
    // 切换面板的点击会引发瞬时失焦，宽限期内忽略，否则第一次点击只收不放。
    const webview = getCurrentWebviewWindow();
    const offFocus = webview.onFocusChanged(({ payload: focused }) => {
      if (!focused && panelRef.current && Date.now() - switchAt.current > 400) setPanel(null);
    });
    return () => { void offFocus.then((off) => off()).catch(() => undefined); };
  }, [applyMode, setPanel]);

  /** 拖放投递：文件拖到「收纳盒」=收录条目；拖到「计划」=建任务并挂链接。 */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dockAutoHide = useSettings((s) => s.dockAutoHide);
  const dockShortcut = useSettings((s) => s.dockShortcut);
  useEffect(() => {
    if (!inTauri) return;
    const webview = getCurrentWebviewWindow();
    let off: (() => void) | undefined;
    let target: string | null = null;
    const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
    const kindOf = (p: string): "file" | "folder" => (basename(p).includes(".") ? "file" : "folder");
    const handleDrop = (paths: string[], key: string) => {
      if (key === "fences") {
        const state = useFiles.getState();
        const tops = sortedTopCategories(state.categories);
        const categoryId = tops[0]?.id ?? state.addCategory(t("dock.fences"));
        state.addItems(paths.map((p) => ({ title: basename(p), type: kindOf(p), path: p, categoryId, tags: [] })));
        toast.success(t("dock.dropStashed", { count: paths.length }));
      } else if (key === "plans") {
        const date = todayStr();
        for (const p of paths) {
          const store = usePlans.getState();
          const before = new Set((store.days[date] ?? []).map((task) => task.id));
          store.addTask(date, null, basename(p));
          const created = (usePlans.getState().days[date] ?? []).find((task) => !before.has(task.id));
          if (created) usePlans.getState().updateTask(date, created.id, { link: { type: kindOf(p), path: p } });
        }
        toast.success(t("dock.dropPlanned", { count: paths.length }));
      }
    };
    void webview.onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        const { x, y } = event.payload.position; // 物理像素
        void currentMonitor().then((monitor) => {
          const scale = monitor?.scaleFactor ?? 1;
          const icon = document.elementFromPoint(x / scale, y / scale)?.closest("[data-dockdrop]");
          const key = icon?.getAttribute("data-dockdrop") ?? null;
          if (key !== target) { target = key; setDropTarget(key); }
        }).catch(() => undefined);
      } else if (event.payload.type === "drop") {
        const paths = [...event.payload.paths];
        const key = target;
        target = null;
        setDropTarget(null);
        if ((key === "fences" || key === "plans") && paths.length > 0) handleDrop(paths, key);
      } else {
        target = null;
        setDropTarget(null);
      }
    }).then((off2) => { off = off2; });
    return () => off?.();
  }, [t]);

  /** 全局快捷键与全屏自动隐藏：设置变化即应用到 Rust 侧。 */
  useEffect(() => {
    if (!inTauri) return;
    invoke("set_dock_shortcut", { shortcut: dockShortcut }).catch(report);
  }, [dockShortcut]);
  useEffect(() => {
    if (!inTauri) return;
    invoke("dock_set_autohide", { on: dockAutoHide }).catch(report);
  }, [dockAutoHide]);

  const nav = (route: string) => invoke("desktop_open_main", { route }).catch(report);

  /** 右键菜单：复用 popup-menu 浮窗传输层，动作在 Dock 窗口内解释执行。 */
  const menuRequest = useRef(0);
  const menuUnlisten = useRef<(() => void) | null>(null);
  const menuStop = useCallback(() => {
    menuUnlisten.current?.();
    menuUnlisten.current = null;
  }, []);
  useMenuActions((action: MenuAction) => {
    switch (action.action) {
      case "plans.open": nav("/plans"); break;
      case "projects.open": if (action.value) nav(`/projects?project=${action.value}`); break;
      case "projects.all": nav("/projects"); break;
      case "fences.files": nav("/files"); break;
      case "knowledge.panel": setPanel("capture"); break;
      case "knowledge.window": invoke("open_capture").catch(report); break;
      case "settings.open": nav("/settings"); break;
    }
  });
  const openMenu = useCallback(async (nodes: MenuNode[], at: { x: number; y: number }) => {
    menuStop();
    const request = ++menuRequest.current;
    switchAt.current = Date.now(); // 菜单夺焦不收面板
    try {
      if (!(await ensurePopupReady())) return;
      const seq = beginMenu();
      const owner = ownerLabel();
      let revealed = false;
      const unlisten = await subscribeMenuSize(seq, (s) => {
        if (request !== menuRequest.current) return;
        revealed = true;
        void revealMenu({ ...at, w: 0, h: 0 }, s, () => request === menuRequest.current).catch(() => {
          if (request !== menuRequest.current) return;
          menuStop();
          void closeMenu(owner);
        });
      });
      if (request !== menuRequest.current) { unlisten(); return; }
      menuUnlisten.current = unlisten;
      await emitMenuRequest(seq, owner, nodes, i18n.language, theme);
      setTimeout(() => {
        if (!revealed && request === menuRequest.current) { void closeMenu(owner); menuStop(); }
      }, 1500);
    } catch { /* 菜单失败静默：右键是增强路径 */ }
  }, [i18n.language, theme, menuStop]);
  const menuFor = useCallback((key: string): MenuNode[] => {
    const item = (action: string, label: string, icon: MenuIconKey = "open", value?: string): MenuNode =>
      ({ kind: "item", action, label, icon, value });
    const sep = (cond: boolean): MenuNode[] => (cond ? [{ kind: "sep" }] : []);
    if (key === "plans") {
      const open = (todayTasks ?? []).filter((task) => !task.done).slice(0, 8);
      return [
        ...open.map((task): MenuNode => ({ kind: "item", action: "plans.none", label: task.title, disabled: true })),
        ...sep(open.length > 0),
        item("plans.open", t("dock.menuPlans")),
      ];
    }
    if (key === "projects") {
      const list = activeProjects.slice(0, 8);
      return [
        ...list.map((project): MenuNode => item("projects.open", project.name, "folder", project.id)),
        ...sep(list.length > 0),
        item("projects.all", t("dock.menuProjects")),
      ];
    }
    if (key === "fences") return [item("fences.files", t("dock.menuFiles"))];
    if (key === "knowledge") {
      return [
        item("knowledge.panel", t("dock.knowledge")),
        item("knowledge.window", t("dock.captureDetach")),
      ];
    }
    if (key === "settings") return [item("settings.open", t("dock.menuSettings"))];
    return [];
  }, [activeProjects, t, todayTasks]);

  const actions = [
    { key: "search", icon: Search, run: () => invoke("search_open_window").catch(report) },
    { key: "fences", icon: LayoutGrid, panel: "fences" as const },
    { key: "plans", icon: CalendarCheck, panel: "plans" as const },
    { key: "projects", icon: FolderKanban, panel: "projects" as const },
    { key: "knowledge", icon: BookOpen, panel: "capture" as const },
    { key: "settings", icon: Settings2, route: "/settings" },
  ];

  const close = () => {
    modal.confirm({ title: t("dock.close"), description: t("dock.closeHint"), confirmText: t("dock.close"), danger: true })
      .then((ok) => {
        if (!ok) return;
        useSettings.getState().setDockOpen(false);
        invoke("dock_close").catch(report);
      });
  };

  if (!inTauri) {
    return <div className="dock-root" data-edge={edge}><p className="dock-hint">{t("dock.tauriOnly")}</p></div>;
  }
  return (
    <div className="dock-root" data-edge={edge} data-mode={mode}
      onContextMenu={(event) => { event.preventDefault(); close(); }}>
      {panel === "fences" && <FencesFlyout />}
      {panel === "plans" && <PlansFlyout />}
      {panel === "projects" && <ProjectsFlyout />}
      {panel === "capture" && <CapturePanel setPanel={setPanel} />}
      <div className="dock-strip"
        onPointerDown={(event) => {
          // 空白处与 grip 都能拖动换边；按钮和输入框照常点击
          if (event.button !== 0) return;
          if ((event.target as HTMLElement).closest("button, input")) return;
          startDrag();
        }}>
        <div className="dock-grip" title={t("dock.grip")} aria-hidden="true">
          {edge === "top"
            ? <GripVertical className="size-3.5" aria-hidden="true" />
            : <GripHorizontal className="size-3.5" aria-hidden="true" />}
        </div>
        <ul className="dock-list" role="toolbar" aria-label={t("dock.title")}
          aria-orientation={edge === "top" ? "horizontal" : "vertical"}>
          {actions.map(({ key, icon: Icon, route, run, panel: actionPanel }) => {
            const badge = key === "plans" ? plansBadge : key === "projects" ? overdueBadge : 0;
            const menuNodes = menuFor(key);
            return (
              <li key={key}>
                <button type="button" className={`dock-item${panel === actionPanel ? " is-active" : ""}${dropTarget === key ? " is-drop" : ""}`}
                  title={t(`dock.${key}`)} aria-label={t(`dock.${key}`)} aria-pressed={panel === actionPanel}
                  data-dockdrop={key}
                  onClick={() => {
                    if (actionPanel) { setPanel(panel === actionPanel ? null : actionPanel); return; }
                    if (run) { void run(); return; }
                    if (route) nav(route);
                  }}
                  onContextMenu={(event) => {
                    if (menuNodes.length === 0) return;
                    event.preventDefault();
                    event.stopPropagation();
                    void openMenu(menuNodes, { x: event.clientX, y: event.clientY });
                  }}>
                  <Icon className="dock-icon" aria-hidden="true" />
                  <span className="dock-label">{t(`dock.${key}`)}</span>
                  {badge > 0 && <i className="dock-badge" aria-hidden="true">{badge > 99 ? "99+" : badge}</i>}
                </button>
              </li>
            );
          })}
        </ul>
        <button type="button" className="dock-close" title={t("dock.close")} aria-label={t("dock.close")} onClick={close}>
          <X className="size-3" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** 收纳盒飞出：宫格/列表两种展示，Ctrl+滚轮调图标大小，拖拽排序。 */
function FencesFlyout() {
  const { t } = useTranslation();
  const categories = useFiles((s) => s.categories);
  const items = useFiles((s) => s.items);
  const moveCategory = useFiles((s) => s.moveCategory);
  const moveItemBefore = useFiles((s) => s.moveItemBefore);
  const tileSize = useSettings((s) => s.dockTileSize);
  const tops = useMemo(() => sortedTopCategories(categories), [categories]);
  const childrenOf = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const category of categories) {
      if (!category.parentId) continue;
      map.set(category.parentId, [...(map.get(category.parentId) ?? []), category.id]);
    }
    return map;
  }, [categories]);
  const [chip, setChip] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const draggingId = useRef<string | null>(null);
  /** 面板根节点：挂在它上面，宫格/列表切换与空列表都不会丢监听 */
  const panelRef = useRef<HTMLDivElement | null>(null);
  const needle = query.trim().toLocaleLowerCase();

  /*
   * Ctrl+滚轮调节磁贴大小。
   * 两个坑：① React 的 onWheel 是被动监听，preventDefault 无效（会触发页面缩放），
   * 必须用原生 addEventListener + passive: false；② 不能把监听挂在宫格容器上——
   * 首次渲染时它可能还不存在（空列表），effect 的 [] 依赖下监听器就永远绑不上。
   * 挂在始终存在的面板根节点上，两个问题一起消失。
   */
  useEffect(() => {
    const node = panelRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const store = useSettings.getState();
      store.setDockTileSize(store.dockTileSize + (event.deltaY < 0 ? 4 : -4));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const visible = useMemo(() => {
    const ids = chip === null ? null : new Set([chip, ...(childrenOf.get(chip) ?? [])]);
    return items.filter((item) => {
      if (ids && !ids.has(item.categoryId)) return false;
      return !needle || item.title.toLocaleLowerCase().includes(needle);
    });
  }, [items, chip, childrenOf, needle]);

  const open = (item: typeof items[number]) =>
    (item.type === "url" ? openUrl(item.path) : openPath(item.path)).catch(report);

  /** 剪贴板快收：URL 直接收录成条目；纯文本提示去收集知识粘贴。 */
  const collectClipboard = async () => {
    let text = "";
    try { text = (await navigator.clipboard.readText()).trim(); } catch { report("剪贴板不可读"); return; }
    if (!text) return;
    const state = useFiles.getState();
    const tops = sortedTopCategories(state.categories);
    const categoryId = tops[0]?.id ?? state.addCategory(t("dock.fences"));
    if (/^https?:\/\//i.test(text)) {
      state.addItem({ title: text.replace(/^https?:\/\//i, "").slice(0, 80), type: "url", path: text, categoryId, tags: [] });
      toast.success(t("dock.clipAdded"));
    } else {
      toast.info(t("dock.clipNotUrl"));
    }
  };

  const dragProps = (id: string) => ({
    draggable: true,
    onDragStart: () => { draggingId.current = id; },
    onDragOver: (event: React.DragEvent) => event.preventDefault(),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      if (draggingId.current && draggingId.current !== id) moveItemBefore(draggingId.current, id);
      draggingId.current = null;
    },
  });

  const itemBody = (item: typeof items[number]) => (
    <>
      <ItemIcon type={item.type} path={item.path} iconUrl={item.iconUrl} size={view === "grid" ? tileSize : 18} />
      <span className="dock-tile-label">{item.title}</span>
    </>
  );

  return (
    <div className="dock-panel" role="region" aria-label={t("dock.fences")} ref={panelRef}>
      <div className="dock-panel-search">
        <Search className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
        <input className="dock-panel-input" value={query} placeholder={t("dock.fencesSearch")}
          onChange={(event) => setQuery(event.target.value)} />
        <span className="dock-view-toggle">
          <button type="button" aria-label={t("dock.fencesGrid")} aria-pressed={view === "grid"}
            onClick={() => setView("grid")}><LayoutGrid className="size-3.5" aria-hidden="true" /></button>
          <button type="button" aria-label={t("dock.fencesList")} aria-pressed={view === "list"}
            onClick={() => setView("list")}><List className="size-3.5" aria-hidden="true" /></button>
          <button type="button" aria-label={t("dock.clipCollect")} title={t("dock.clipCollect")}
            onClick={() => void collectClipboard()}>
            <RiClipboardLine className="size-3.5" aria-hidden="true" />
          </button>
        </span>
      </div>
      <div className="dock-chips" role="tablist" aria-label={t("dock.fences")}>
        <button type="button" role="tab" aria-selected={chip === null} className={`dock-chip${chip === null ? " is-active" : ""}`}
          onClick={() => setChip(null)}>{t("dock.fencesAll")}</button>
        {tops.map((category) => (
          <span key={category.id} className="dock-chip-box">
            <button type="button" role="tab" aria-selected={chip === category.id}
              className={`dock-chip${chip === category.id ? " is-active" : ""}`}
              onClick={() => setChip(category.id)}>{category.name}</button>
            <span className="dock-chip-sort">
              <button type="button" aria-label={t("dock.sortEarlier")} onClick={() => moveCategory(category.id, -1)}>
                <ChevronLeft className="size-3" aria-hidden="true" />
              </button>
              <button type="button" aria-label={t("dock.sortLater")} onClick={() => moveCategory(category.id, 1)}>
                <ChevronRight className="size-3" aria-hidden="true" />
              </button>
            </span>
          </span>
        ))}
      </div>
      {visible.length === 0
        ? <p className="dock-panel-empty">{t("dock.fencesEmpty")}</p>
        : view === "grid"
          ? <div className={`dock-grid${tileSize <= 24 ? " is-compact" : ""}`}
              style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileSize + 12}px, 1fr))` }}>
              {visible.map((item) => (
                <button type="button" key={item.id} className="dock-tile" title={item.path}
                  onClick={() => void open(item)} {...dragProps(item.id)}>
                  {itemBody(item)}
                </button>
              ))}
            </div>
          : <ul className="dock-lrows">
              {visible.map((item) => (
                <li key={item.id}>
                  <button type="button" className="dock-lrow" title={item.path}
                    onClick={() => void open(item)} {...dragProps(item.id)}>
                    {itemBody(item)}
                  </button>
                </li>
              ))}
            </ul>}
    </div>
  );
}

/** 收集知识内嵌面板：完整收集表单（草稿/图片/AI 整理），AI 快问条，pin 脱离为独立窗口。 */

/** AI 快问探测结果缓存：key = 默认文本服务商 id|baseUrl|model，配置变了才重新探测。 */
let aiProbe: { key: string; ok: boolean } | null = null;

function CapturePanel({ setPanel }: { setPanel: (next: DockPanel | null) => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"capture" | "ask">("capture");
  const defaultTextId = useProviders((s) => s.defaultTextId);
  const defaultProvider = useProviders((s) => s.providers.find((p) => p.id === s.defaultTextId) ?? null);
  const probeKey = defaultProvider ? `${defaultTextId}|${defaultProvider.baseUrl}|${defaultProvider.model}` : "none";
  const [aiState, setAiState] = useState<"checking" | "ready" | "off">(
    aiProbe?.key === probeKey ? (aiProbe.ok ? "ready" : "off") : "checking",
  );

  // 有默认文本服务商且连接测试通过才亮 AI 快问标签；配置变更自动重新探测
  useEffect(() => {
    let cancelled = false;
    if (aiProbe?.key === probeKey) {
      setAiState(aiProbe.ok ? "ready" : "off");
      return () => { cancelled = true; };
    }
    setAiState("checking");
    void (async () => {
      await providersReady();
      if (cancelled) return;
      try {
        const provider = selectProvider(useProviders.getState(), false);
        if (!provider.baseUrl || !provider.model) throw new Error("AI_NO_PROVIDER");
        await testProvider(provider);
        aiProbe = { key: probeKey, ok: true };
        if (!cancelled) setAiState("ready");
      } catch {
        aiProbe = { key: probeKey, ok: false };
        if (!cancelled) setAiState("off");
      }
    })();
    return () => { cancelled = true; };
  }, [probeKey]);

  // AI 变为不可用时从快问页退回收集页
  useEffect(() => {
    if (tab === "ask" && aiState !== "ready") setTab("capture");
  }, [aiState, tab]);

  const showAsk = aiState === "ready";
  return (
    <div className="dock-panel dock-capture" role="region" aria-label={t("dock.knowledge")}>
      <div className="dock-capture-bar">
        <span className="dock-capture-tabs">
          <button type="button" aria-pressed={tab === "capture"}
            onClick={() => setTab("capture")}>{t("dock.knowledge")}</button>
          {showAsk && (
            <button type="button" aria-pressed={tab === "ask"} onClick={() => setTab("ask")}>
              <RiSparklingLine size={12} aria-hidden="true" />{t("dock.aiAsk")}
            </button>
          )}
        </span>
        <button type="button" className="dock-capture-pin" title={t("dock.captureDetach")}
          aria-label={t("dock.captureDetach")}
          onClick={() => { invoke("open_capture").catch(report); setPanel(null); }}>
          <RiPushpinLine size={12} aria-hidden="true" />{t("dock.captureDetach")}
        </button>
      </div>
      {tab === "ask" && showAsk ? <AiAsk /> : <div className="dock-capture-form"><CaptureForm onHide={() => setPanel(null)} /></div>}
    </div>
  );
}

/** AI 快问：走应用已配置的 AI 管线，一问一答，不落库。 */
function AiAsk() {
  const { t } = useTranslation();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setAnswer("");
    try { setAnswer(await chatWithProvider([{ role: "user", content: q }])); }
    catch (cause) { setAnswer(String(cause)); }
    finally { setBusy(false); }
  };
  return (
    <div className="dock-ask">
      <form className="dock-panel-search" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
        <input className="dock-panel-input" value={question} placeholder={t("dock.aiAskPlaceholder")}
          maxLength={2000} onChange={(event) => setQuestion(event.target.value)} />
        <button type="submit" className="dock-ask-send" disabled={busy || !question.trim()}
          aria-label={t("dock.aiAsk")}>
          <RiSparklingLine size={13} aria-hidden="true" />
        </button>
      </form>
      {busy && <p className="dock-pnone">{t("dock.aiBusy")}</p>}
      {answer && <div className="dock-ask-answer">{answer}</div>}
    </div>
  );
}

/** 计划飞出：勾选在行尾、完成划线沉底，可加子任务、删除与附件；完整编辑在主窗口。 */
function PlansFlyout() {
  const { t } = useTranslation();
  const date = todayStr();
  const tasks = usePlans((s) => s.days[date]) ?? [];
  const toggleDone = usePlans((s) => s.toggleDone);
  const addTask = usePlans((s) => s.addTask);
  const [draft, setDraft] = useState("");
  const [attsFor, setAttsFor] = useState<string | null>(null);
  const [subFor, setSubFor] = useState<string | null>(null);
  const [subDraft, setSubDraft] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const tops = [...tasks.filter((task) => !task.parentId)].sort((a, b) => Number(a.done) - Number(b.done));
  const childrenOf = useMemo(() => {
    const map = new Map<string, typeof tasks>();
    for (const task of tasks) {
      if (!task.parentId) continue;
      map.set(task.parentId, [...(map.get(task.parentId) ?? []), task]);
    }
    return map;
  }, [tasks]);

  const submit = () => {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    addTask(date, null, title);
  };
  const submitSub = () => {
    const title = subDraft.trim();
    if (!title || !subFor) return;
    addTask(date, subFor, title);
    setSubDraft("");
  };

  const remove = (id: string) => {
    usePlans.getState().removeTask(date, id);
    if (attsFor === id) setAttsFor(null);
    if (subFor === id) setSubFor(null);
    toast(t("dock.plansDeleted"), { action: { label: t("dock.plansUndo"), onClick: () => usePlans.getState().undo() } });
  };

  const todoRow = (task: (typeof tasks)[number], sub = false) => (
    <div className={`dock-todo-row${sub ? " is-sub" : ""}${task.done ? " is-done" : ""}`}>
      <button type="button" className="dock-todo"
        onClick={() => toggleDone(date, task.id)}
        aria-pressed={task.done} title={task.title}>
        <span className="dock-todo-title">{task.title}</span>
        {task.start && <span className="dock-todo-time">{task.start}</span>}
        <span className="dock-todo-mark" aria-hidden="true">{task.done ? "✓" : ""}</span>
      </button>
      {!sub && (
        <span className="dock-todo-actions">
          <button type="button" title={t("dock.plansAddSub")} aria-label={t("dock.plansAddSub")}
            aria-expanded={subFor === task.id}
            onClick={() => { setSubFor(subFor === task.id ? null : task.id); setSubDraft(""); }}>
            <RiAddLine size={13} aria-hidden="true" />
          </button>
          <button type="button" title={t("dock.plansAttach")} aria-label={t("dock.plansAttach")}
            aria-expanded={attsFor === task.id}
            onClick={() => setAttsFor(attsFor === task.id ? null : task.id)}>
            <RiAttachment2 size={13} aria-hidden="true" />
            {(task.attachments?.length ?? 0) > 0 && <i>{task.attachments!.length}</i>}
          </button>
          <button type="button" className="is-danger" title={t("dock.plansDelete")} aria-label={t("dock.plansDelete")}
            onClick={() => remove(task.id)}>
            <RiDeleteBinLine size={13} aria-hidden="true" />
          </button>
        </span>
      )}
      {sub && (
        <span className="dock-todo-actions">
          <button type="button" className="is-danger" title={t("dock.plansDelete")} aria-label={t("dock.plansDelete")}
            onClick={() => remove(task.id)}>
            <RiDeleteBinLine size={13} aria-hidden="true" />
          </button>
        </span>
      )}
    </div>
  );

  return (
    <div className="dock-panel" role="region" aria-label={t("dock.plans")}>
      <form className="dock-panel-search" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <input className="dock-panel-input" value={draft} placeholder={t("dock.plansAdd")}
          maxLength={200} onChange={(event) => setDraft(event.target.value)} />
      </form>
      {tops.length === 0
        ? <p className="dock-panel-empty">{t("dock.plansEmpty")}</p>
        : <ul className="dock-todos">
            {tops.map((task) => (
              <li key={task.id}>
                {todoRow(task)}
                {subFor === task.id && (
                  <form className="dock-sub-add" onSubmit={(event) => { event.preventDefault(); submitSub(); }}>
                    <input className="dock-panel-input" value={subDraft} placeholder={t("dock.plansAddSub")}
                      maxLength={200} autoFocus onChange={(event) => setSubDraft(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Escape") setSubFor(null); }} />
                  </form>
                )}
                {attsFor === task.id && (
                  <div className="dock-atts">
                    {(task.attachments ?? []).map((attachment) => (
                      <span className="dock-att" key={attachment.id}>
                        <button type="button" className="dock-att-name" title={attachment.name}
                          onClick={() => openTaskAttachment(attachment).catch(report)}>
                          {attachment.name}<small>{attachmentSize(attachment.size)}</small>
                        </button>
                        <button type="button" className="dock-att-x" title={t("dock.plansUnlink")}
                          aria-label={`${t("dock.plansUnlink")}: ${attachment.name}`}
                          onClick={() => unlinkTaskAttachment(date, task.id, attachment.id)}>
                          <RiCloseLine size={12} aria-hidden="true" />
                        </button>
                      </span>
                    ))}
                    <button type="button" className="dock-att-add" disabled={addBusy}
                      onClick={() => { setAddBusy(true); addTaskAttachment(date, task.id).catch(report).finally(() => setAddBusy(false)); }}>
                      <RiAddLine size={12} aria-hidden="true" />{t("dock.plansAddAttachment")}
                    </button>
                  </div>
                )}
                {(childrenOf.get(task.id) ?? []).map((child) => (
                  <div key={child.id}>{todoRow(child, true)}</div>
                ))}
              </li>
            ))}
          </ul>}
      <button type="button" className="dock-panel-link" onClick={() => invoke("desktop_open_main", { route: "/plans" }).catch(report)}>
        {t("dock.plansOpen")}
      </button>
    </div>
  );
}

/** 项目飞出：所有项目连同未完成工作项一屏展开，点项目名进主窗口，点条目深链详情。 */
function ProjectsFlyout() {
  const { t } = useTranslation();
  const projects = useProjects((s) => s.projects);
  const items = useProjects((s) => s.items);
  const addProject = useProjects((s) => s.addProject);
  const addItem = useProjects((s) => s.addItem);
  const [query, setQuery] = useState("");
  const [projectDraft, setProjectDraft] = useState("");
  const [addFor, setAddFor] = useState<string | null>(null);
  const [itemDraft, setItemDraft] = useState("");
  const needle = query.trim().toLocaleLowerCase();

  const active = useMemo(() =>
    projects
      .filter((project) => project.status === "active")
      .sort((a, b) => b.updatedAt - a.updatedAt), [projects]);

  const stats = useMemo(() => {
    const map = new Map<string, { done: number; total: number; open: typeof items }>();
    for (const item of items) {
      if (!item.projectId || item.status === "cancelled") continue;
      const entry = map.get(item.projectId) ?? { done: 0, total: 0, open: [] as typeof items };
      entry.total += 1;
      if (item.status === "done") entry.done += 1;
      else entry.open.push(item);
      map.set(item.projectId, entry);
    }
    for (const entry of map.values()) {
      entry.open.sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999"));
    }
    return map;
  }, [items]);

  const visible = useMemo(() => active.filter((project) => {
    if (!needle) return true;
    if (project.name.toLocaleLowerCase().includes(needle)) return true;
    return (stats.get(project.id) ?? { open: [] }).open.some((item) => item.title.toLocaleLowerCase().includes(needle));
  }), [active, needle, stats]);

  const submitItem = (projectId: string) => {
    const title = itemDraft.trim();
    if (!title) return;
    addItem({ title, projectId });
    setItemDraft("");
  };

  return (
    <div className="dock-panel" role="region" aria-label={t("dock.projects")}>
      <div className="dock-panel-search">
        <Search className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
        <input className="dock-panel-input" value={query} placeholder={t("dock.projectsSearch")}
          onChange={(event) => setQuery(event.target.value)} />
      </div>
      {visible.length === 0
        ? <p className="dock-panel-empty">{t("dock.projectsEmpty")}</p>
        : <ul className="dock-plist">
            {visible.map((entry) => {
              const stat = stats.get(entry.id);
              const open = stat?.open ?? [];
              const shown = needle ? open.filter((item) => item.title.toLocaleLowerCase().includes(needle)) : open;
              const pct = stat && stat.total > 0 ? Math.round((stat.done / stat.total) * 100) : 0;
              return (
                <li key={entry.id} className="dock-psection">
                  <div className="dock-phead">
                    <button type="button" className="dock-pname" title={entry.name}
                      onClick={() => invoke("desktop_open_main", { route: `/projects?project=${entry.id}` }).catch(report)}>
                      {entry.name}
                    </button>
                    <span className="dock-prow-count">{stat ? `${stat.done}/${stat.total}` : "0/0"}</span>
                    <button type="button" className="dock-padd-item" aria-label={t("dock.projectsAddItem")}
                      aria-expanded={addFor === entry.id}
                      onClick={() => { setAddFor(addFor === entry.id ? null : entry.id); setItemDraft(""); }}>
                      <RiAddLine size={12} aria-hidden="true" />
                    </button>
                  </div>
                  <span className="dock-pbar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
                  {addFor === entry.id && (
                    <form className="dock-panel-search dock-padd" onSubmit={(event) => { event.preventDefault(); submitItem(entry.id); }}>
                      <input className="dock-panel-input" value={itemDraft} placeholder={t("dock.projectsAddItem")}
                        maxLength={120} autoFocus onChange={(event) => setItemDraft(event.target.value)} />
                    </form>
                  )}
                  {shown.length === 0
                    ? <p className="dock-pnone">{t("dock.projectsItemsEmpty")}</p>
                    : <ul>
                        {shown.map((item) => (
                          <li key={item.id}>
                            <button type="button" className="dock-prow" title={item.title}
                              onClick={() => invoke("desktop_open_main", { route: `/projects?item=${item.id}` }).catch(report)}>
                              <span className={`dock-pchip${item.status === "doing" ? " is-doing" : ""}`}>
                                {t(item.status === "doing" ? "dock.projectsDoing" : "dock.projectsTodo")}
                              </span>
                              <span className="dock-prow-name">{item.title}</span>
                              {item.deadline && <span className="dock-prow-count">{item.deadline.slice(5)}</span>}
                            </button>
                          </li>
                        ))}
                      </ul>}
                </li>
              );
            })}
          </ul>}
      <form className="dock-panel-search dock-padd" onSubmit={(event) => {
        event.preventDefault();
        const name = projectDraft.trim();
        if (!name) return;
        addProject({ name });
        setProjectDraft("");
      }}>
        <input className="dock-panel-input" value={projectDraft} placeholder={t("dock.projectsAdd")}
          maxLength={60} onChange={(event) => setProjectDraft(event.target.value)} />
      </form>
      <button type="button" className="dock-panel-link" onClick={() => invoke("desktop_open_main", { route: "/projects" }).catch(report)}>
        {t("dock.projectsOpen")}
      </button>
    </div>
  );
}
