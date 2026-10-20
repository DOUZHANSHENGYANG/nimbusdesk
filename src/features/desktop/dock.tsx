import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  BookOpen, CalendarCheck, ChevronLeft, ChevronRight, FolderKanban, GripHorizontal,
  GripVertical, LayoutGrid, Search, Settings2, X,
} from "lucide-react";
import { RiAddLine, RiAttachment2, RiCloseLine, RiDeleteBinLine } from "@remixicon/react";
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
import { monitorArea } from "./monitors";
import { dockBounds, dockSpringPair, type DockArea, type DockMode, type DockPanel } from "./dock-core";
import { nearestDockEdge } from "./edge-core";
import { ItemIcon } from "@/features/files/icons";
import "./dock.css";

/** 与 Rust 侧 `dock_open` 固定的 label 一致。 */
const LABEL = "desktop-dock";

function report(error: unknown) { toast.error(String(error)); }

export function DockWindow() {
  const { t } = useTranslation();
  const modal = useModal();
  const edge = useSettings((s) => s.dockEdge);
  const areaRef = useRef<DockArea | null>(null);
  const modeRef = useRef<DockMode>("strip");
  const switchAt = useRef(0);
  const [panel, setPanelState] = useState<DockPanel | null>(null);
  const [mode, setModeState] = useState<DockMode>("strip");
  const panelRef = useRef<DockPanel | null>(null);

  const setMode = useCallback((next: DockMode) => {
    modeRef.current = next;
    setModeState(next);
  }, []);

  const applyMode = useCallback(async (mode: DockMode) => {
    if (!inTauri) return;
    const monitor = await currentMonitor().catch(() => null);
    if (!monitor) return;
    const raw = monitorArea(monitor);
    const scale = raw.scale || 1;
    // MonitorArea 是物理像素；dock-core 的口径是逻辑像素。
    const area: DockArea = { x: raw.x / scale, y: raw.y / scale, w: raw.w / scale, h: raw.h / scale };
    areaRef.current = area;
    const bounds = dockBounds(area, edge, mode);
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
    const { from, to } = dockSpringPair(area, edge, modeRef.current, mode);
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

  const nav = (route: string) => invoke("desktop_open_main", { route }).catch(report);
  /** 快捷收集窗居中于工作区（跟随 Dock 所在显示器）。 */
  const captureSpot = () => {
    const area = areaRef.current;
    if (!area) return {};
    return {
      x: Math.round(area.x + (area.w - 400) / 2),
      y: Math.round(area.y + (area.h - 600) / 2),
    };
  };
  const actions = [
    { key: "search", icon: Search, run: () => invoke("search_open_window").catch(report) },
    { key: "fences", icon: LayoutGrid, panel: "fences" as const },
    { key: "plans", icon: CalendarCheck, panel: "plans" as const },
    { key: "projects", icon: FolderKanban, panel: "projects" as const },
    { key: "knowledge", icon: BookOpen, run: () => invoke("open_capture", captureSpot()).catch(report) },
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
      <div className="dock-strip"
        onPointerDown={(event) => {
          // 空白处与 grip 都能拖动换边；按钮和输入框照常点击
          if (event.button !== 0) return;
          if ((event.target as HTMLElement).closest("button, input")) return;
          startDrag();
        }}>
        <div className="dock-grip" title={t("dock.grip")} aria-hidden="true">
          {edge === "top"
            ? <GripHorizontal className="size-3.5" aria-hidden="true" />
            : <GripVertical className="size-3.5" aria-hidden="true" />}
        </div>
        <ul className="dock-list" role="toolbar" aria-label={t("dock.title")}
          aria-orientation={edge === "top" ? "horizontal" : "vertical"}>
          {actions.map(({ key, icon: Icon, route, run, panel: actionPanel }) => (
            <li key={key}>
              <button type="button" className={`dock-item${panel === actionPanel ? " is-active" : ""}`}
                title={t(`dock.${key}`)} aria-label={t(`dock.${key}`)} aria-pressed={panel === actionPanel}
                onClick={() => {
                  if (actionPanel) { setPanel(panel === actionPanel ? null : actionPanel); return; }
                  if (run) { void run(); return; }
                  if (route) nav(route);
                }}>
                <Icon className="dock-icon" aria-hidden="true" />
                <span className="dock-label">{t(`dock.${key}`)}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="dock-close" title={t("dock.close")} aria-label={t("dock.close")} onClick={close}>
          <X className="size-3" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** 栅格飞出：全部分类的条目按手机桌面式网格平铺，可搜索、可按分类筛选与排序。 */
function FencesFlyout() {
  const { t } = useTranslation();
  const categories = useFiles((s) => s.categories);
  const items = useFiles((s) => s.items);
  const moveCategory = useFiles((s) => s.moveCategory);
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
  const needle = query.trim().toLocaleLowerCase();

  const visible = useMemo(() => {
    const ids = chip === null ? null : new Set([chip, ...(childrenOf.get(chip) ?? [])]);
    return items.filter((item) => {
      if (ids && !ids.has(item.categoryId)) return false;
      return !needle || item.title.toLocaleLowerCase().includes(needle);
    });
  }, [items, chip, childrenOf, needle]);

  const open = (item: typeof items[number]) =>
    (item.type === "url" ? openUrl(item.path) : openPath(item.path)).catch(report);

  return (
    <div className="dock-panel" role="region" aria-label={t("dock.fences")}>
      <div className="dock-panel-search">
        <Search className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
        <input className="dock-panel-input" value={query} placeholder={t("dock.fencesSearch")}
          onChange={(event) => setQuery(event.target.value)} />
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
        : <div className="dock-grid">
            {visible.map((item) => (
              <button type="button" key={item.id} className="dock-tile" title={item.path}
                onClick={() => void open(item)}>
                <ItemIcon type={item.type} path={item.path} iconUrl={item.iconUrl} size={46} />
                <span className="dock-tile-label">{item.title}</span>
              </button>
            ))}
          </div>}
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

/** 项目飞出：项目带进度与未完成数，钻取看工作项（状态 + 截止日），点击深链主窗口。 */
function ProjectsFlyout() {
  const { t } = useTranslation();
  const projects = useProjects((s) => s.projects);
  const items = useProjects((s) => s.items);
  const [query, setQuery] = useState("");
  const [openProject, setOpenProject] = useState<string | null>(null);
  const needle = query.trim().toLocaleLowerCase();
  const active = useMemo(() =>
    projects
      .filter((project) => project.status === "active")
      .sort((a, b) => b.updatedAt - a.updatedAt), [projects]);
  const visible = useMemo(() =>
    active.filter((project) => !needle || project.name.toLocaleLowerCase().includes(needle)), [active, needle]);
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
  const project = openProject ? projects.find((entry) => entry.id === openProject) : null;
  const projectItems = openProject ? stats.get(openProject)?.open ?? [] : [];

  return (
    <div className="dock-panel" role="region" aria-label={t("dock.projects")}>
      {project ? (
        <>
          <button type="button" className="dock-pback" onClick={() => setOpenProject(null)}>
            <ChevronLeft className="size-3.5" aria-hidden="true" />{project.name}
          </button>
          {projectItems.length === 0
            ? <p className="dock-panel-empty">{t("dock.projectsItemsEmpty")}</p>
            : <ul className="dock-plist">
                {projectItems.map((item) => (
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
          <button type="button" className="dock-panel-link" onClick={() => invoke("desktop_open_main", { route: `/projects?project=${project.id}` }).catch(report)}>
            {t("dock.projectsOpen")}
          </button>
        </>
      ) : (
        <>
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
                  const pct = stat && stat.total > 0 ? Math.round((stat.done / stat.total) * 100) : 0;
                  return (
                    <li key={entry.id}>
                      <button type="button" className="dock-prow" title={entry.name}
                        onClick={() => setOpenProject(entry.id)}>
                        <span className="dock-prow-main">
                          <span className="dock-prow-head">
                            <span className="dock-prow-name">{entry.name}</span>
                            <span className="dock-prow-count">{stat?.open.length ?? 0}</span>
                          </span>
                          <span className="dock-prow-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>}
          <button type="button" className="dock-panel-link" onClick={() => invoke("desktop_open_main", { route: "/projects" }).catch(report)}>
            {t("dock.projectsOpen")}
          </button>
        </>
      )}
    </div>
  );
}
