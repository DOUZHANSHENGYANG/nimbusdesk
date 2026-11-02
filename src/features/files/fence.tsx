import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { resolveMonitor } from "@/features/desktop/monitors";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { X, Pin, PinOff, PanelRightClose, ArrowLeftRight, Expand, List, LayoutGrid, LockKeyhole, UnlockKeyhole, MoreHorizontal, Palette, Search, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Providers } from "@/app/providers";
import { useFiles, useFences, DEFAULT_FENCE, type FileItem, type FenceSortMode } from "@/stores/files";
import { useSettings } from "@/stores/settings";
import { inTauri, dragOut, windowReady } from "@/lib/tauri";
import { invoke } from "@tauri-apps/api/core";
import { moveDroppedFiles } from "./fence-drop";
import { openTarget } from "./open-target";
import { ItemVisual } from "./file-preview";
import { boxAppearance, boxDisplayName, boxFontFamily } from "./box-appearance";
import { BoxAppearancePanel } from "./box-appearance-panel";
import { openFenceGroup } from "./desktop-actions";
import { useFileActions } from "@/features/files/actions";
import { usePopupMenu } from "@/features/files/use-popup-menu";
import { ITEM_ATTR } from "@/features/files/menu-model";
import { cn } from "@/lib/utils";
import { flushAllStorage } from "@/lib/storage";
import { EdgeDockFrame, useEdgeDock, queueWindowOperation } from "@/features/desktop/edge-dock";
import { logicalFenceGeometry, dragDockEdge } from "./fence-geometry";
import { fenceLayout, fenceInsertionBefore, FENCE_GAP as GAP } from "./fence-presentation";


const win = inTauri ? getCurrentWebviewWindow() : null;

/** 桌面悬浮栅栏：自适应网格 + 置顶 + 拖拽排序 + Ctrl 滚轮缩放 + 幽灵 + 翻页 + 拖入/拖出 */
export function FenceWindow({ categoryId }: { categoryId: string }) {
  const [hydrated, setHydrated] = useState(() => useFiles.persist.hasHydrated() && useFences.persist.hasHydrated());
  useEffect(() => {
    const ready = () => setHydrated(useFiles.persist.hasHydrated() && useFences.persist.hasHydrated());
    const offFiles = useFiles.persist.onFinishHydration(ready);
    const offFences = useFences.persist.onFinishHydration(ready);
    ready();
    return () => { offFiles(); offFences(); };
  }, []);
  return (
    <Providers>
      {hydrated && <FencePanel categoryId={categoryId} />}
    </Providers>
  );
}

const SCALE_MIN = 0.7;
/** 吸附阈值（逻辑像素，按显示器缩放换算为物理像素） */
const SNAP_TOLERANCE = 12;
const SCALE_MAX = 1.6;

function FencePanel({ categoryId }: { categoryId: string }) {
  const { t, i18n } = useTranslation();
  const categories = useFiles((s) => s.categories);
  const allItems = useFiles((s) => s.items); // 稳定引用，selector 内不得造新数组
  const moveItemBefore = useFiles((s) => s.moveItemBefore);
  const setCategoryAppearance = useFiles((s) => s.setCategoryAppearance);
  const setCategoryGroupColor = useFiles((s) => s.setCategoryGroupColor);
  const category = useMemo(
    () => categories.find((c) => c.id === categoryId),
    [categories, categoryId],
  );
  const items = useMemo(
    () => allItems.filter((i) => i.categoryId === categoryId),
    [allItems, categoryId],
  );
  const fence = useFences((s) => s.fences[categoryId]) ?? DEFAULT_FENCE;
  const fenceReveal = useSettings((s) => s.fenceReveal);
  const setGeometry = useFences((s) => s.setGeometry);
  const setOpen = useFences((s) => s.setOpen);
  const setPinned = useFences((s) => s.setPinned);
  const setScale = useFences((s) => s.setScale);
  const setForm = useFences((s) => s.setForm);
  const setEdge = useFences((s) => s.setEdge);
  const setEdgeY = useFences((s) => s.setEdgeY);
  const setSortMode = useFences((s) => s.setSortMode);
  const setLocked = useFences((s) => s.setLocked);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  /** 同色编组拖动：起点 + 同伴窗口的起点；Ctrl 拖动时 temp=true（临时解组） */
  const dragGroupRef = useRef<null | {
    temp: boolean;
    origin: { x: number; y: number };
    peers: { label: string; x: number; y: number }[];
  }>(null);
  const docked = fence.form === "capsule";
  const pinned = fence.pinned ?? false;
  const locked = fence.locked ?? false;
  /** 外观以盒子上的 appearance 为准；旧 fence.viewMode / fileNameMode 只作迁移前的 fallback */
  const look = useMemo(() => ({
    ...boxAppearance(category?.appearance),
    // 没有 appearance 的旧盒子继续读 fence.fileNameMode，避免升级后显示口径突变。
    nameMode: category?.appearance ? (category.appearance.nameMode ?? "full") : (fence.fileNameMode ?? "full"),
  }), [category?.appearance, fence.fileNameMode]);
  const viewMode = category?.appearance?.view ?? fence.viewMode ?? "icons";
  const sortMode: FenceSortMode = fence.sortMode ?? "manual";
  const listView = viewMode === "list";
  const dockingBusy = useRef(false);
  const modeRef = useRef(docked);
  modeRef.current = docked || dockingBusy.current;
  const dock = useEdgeDock({
    active: docked, edge: fence.edge ?? "right", edgeY: fence.edgeY,
    normal: () => { const {x,y,w,h} = useFences.getState().fences[categoryId] ?? DEFAULT_FENCE; return {x,y,w,h}; },
    pinned, locked,
    appearance: fence,
    onAppearanceChange: patch => useFences.getState().setStickyAppearance(categoryId, patch),
    onEdgeChange: edge => setEdge(categoryId, edge),
    onEdgeYChange: y => setEdgeY(categoryId, y),
    onUndock: () => setForm(categoryId, "paper"),
    onError: error => toast.error(String(error)),
  });
  const dockRef = useRef(dock);
  dockRef.current = dock;
  const userTitleDrag = useRef(false);
  const settleTitleDrag = useRef<() => void>(() => undefined);
  const closeBusy = useRef(false);

  const [page, setPage] = useState(0);
  /** 盒内搜索：栅栏只有一屏大小，条目一多翻页就不够用了 */
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [hover, setHover] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const controlsRef = useRef<HTMLDivElement>(null);
  const controlsButtonRef = useRef<HTMLButtonElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);
  const categoryRenameActive = useRef(false);
  const dragOutBusy = useRef(false);
  const receivingDrop = useRef(false);
  const [dropActive, setDropActive] = useState(false);
  const [dropBusy, setDropBusy] = useState(false);
  const suppressClickUntil = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const gridWrapRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const [gridSize, setGridSize] = useState({ w: 0, h: 0 });
  /** 当前选中条目；直接拖动排序，越过边界后系统拖出。 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  /** 落点竖线：插入位 + 相对网格容器的坐标 */
  const [drop, setDrop] = useState<{ anchorId: string | null; x: number; y: number; h: number; w: number } | null>(null);

  const actions = useFileActions();
  /** 就地重命名的条目 id（与分类改名互不影响） */
  const [renameItemId, setRenameItemId] = useState<string | null>(null);

  const [itemDraft, setItemDraft] = useState("");
  const itemRenameRef = useRef<HTMLInputElement>(null);
  const activeItemRename = useRef<string | null>(null);

  const renameCategory = useFiles((s) => s.renameCategory);

  const startRename = () => {
    categoryRenameActive.current = true;
    setDraft(category?.name ?? "");
    setRenaming(true);
    requestAnimationFrame(() => renameRef.current?.select());
  };

  /** 双击栅栏标题 = 重命名分类（重名静默还原，不触发最大化） */
  const commitRename = () => {
    if (!categoryRenameActive.current) return;
    categoryRenameActive.current = false;
    const clean = draft.trim();
    if (clean && category && clean !== category.name) {
      const dup = useFiles
        .getState()
        .categories.some(
          (c) => c.id !== categoryId && c.name.toLowerCase() === clean.toLowerCase(),
        );
      if (!dup) renameCategory(categoryId, clean);
    }
    setRenaming(false);
  };

  /** 就地重命名条目：提交时同步磁盘（actions.rename 内部处理） */
  const beginItemRename = (item: FileItem) => {
    activeItemRename.current = item.id;
    setSelectedId(item.id);
    setItemDraft(item.title);
    setRenameItemId(item.id);
    requestAnimationFrame(() => itemRenameRef.current?.select());
  };

  const commitItemRename = async (item: FileItem, restoreFocus = false) => {
    if (activeItemRename.current !== item.id) return;
    activeItemRename.current = null;
    const next = itemDraft.trim();
    setRenameItemId(null);
    if (restoreFocus) requestAnimationFrame(() => itemRefs.current.get(item.id)?.focus());
    if (!next || next === item.title) return;
    await actions.rename(item, next);
  };


  const openMenu = usePopupMenu({ actions, onRenameInline: beginItemRename,
    onOpenChange: open => { setMenuOpen(open); dockRef.current.hold("menu", open); } });
  useEffect(() => { dock.hold("rename-category", renaming); }, [renaming, dock.hold]);
  useEffect(() => { dock.hold("rename-item", !!renameItemId); }, [renameItemId, dock.hold]);
  useEffect(() => { dock.hold("file-drop", dropActive || dropBusy); }, [dropActive, dropBusy, dock.hold]);
  useEffect(() => { dock.hold("controls", controlsOpen); }, [controlsOpen, dock.hold]);
  useEffect(() => {
    if (!controlsOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!controlsRef.current?.contains(event.target as Node)) setControlsOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setControlsOpen(false);
      controlsButtonRef.current?.focus();
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeWithEscape, true);
    return () => { window.removeEventListener("pointerdown", closeOutside); window.removeEventListener("keydown", closeWithEscape, true); };
  }, [controlsOpen]);

  /** 右键：命中条目 → 条目菜单；否则空白菜单（坐标为窗口内 CSS 像素） */
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = (e.target as HTMLElement).closest(`[${ITEM_ATTR}]`);
    const id = el?.getAttribute(ITEM_ATTR) ?? null;
    const item = id ? items.find((i) => i.id === id) : undefined;
    void openMenu(
      item ? { kind: "item", item } : { kind: "blank", categoryId },
      { x: e.clientX, y: e.clientY },
    ).catch(error => toast.error(String(error)));
  };
  const scale = fence.scale ?? 1;

  // Capsule placement owns native sizing while docked. Reapply the saved lock on return.
  useEffect(() => {
    if (!win || docked) return;
    let cancelled = false;
    void queueWindowOperation(win.label, async () => {
      if (!cancelled && !modeRef.current) await win.setResizable(!(useFences.getState().fences[categoryId]?.locked ?? false));
    }).catch(error => toast.error(String(error)));
    return () => { cancelled = true; };
  }, [locked, docked]);

  /* ── 置顶状态应用（启动/切换时） ── */
  useEffect(() => {
    if (!win || docked) return;
    let cancelled = false;
    void queueWindowOperation(win.label, async () => {
      if (cancelled || modeRef.current) return;
      await win.setAlwaysOnBottom(false);
      if (cancelled || modeRef.current) return;
      await win.setAlwaysOnTop(pinned);
      if (!cancelled && !modeRef.current && !pinned) await win.setAlwaysOnBottom(true);
    }).catch(error => toast.error(String(error)));
    return () => { cancelled = true; };
  }, [pinned, docked]);

  const initialWindowShown = useRef(docked);
  /* ── 启动：显示窗口 + 关闭时同步开关状态 ── */
  useEffect(() => {
    if (docked) initialWindowShown.current = true;
    else if (!initialWindowShown.current) {
      initialWindowShown.current = true;
      void windowReady().catch(error => toast.error(String(error)));
    }
    if (!win) return;
    const unClose = win.onCloseRequested(event => {
      event.preventDefault();
      if (receivingDrop.current || dragOutBusy.current || dockingBusy.current || dockRef.current.busy || closeBusy.current) return;
      closeBusy.current = true;
      void (async () => {
        const previous = useFences.getState().fences[categoryId]?.open ?? true;
        if (!modeRef.current) await queueWindowOperation(win.label, async () => {
          const [position, size, factor] = await Promise.all([win.outerPosition(), win.outerSize(), win.scaleFactor()]);
          if (!modeRef.current) setGeometry(categoryId, logicalFenceGeometry(position, size, factor));
        });
        setOpen(categoryId, false);
        try { await flushAllStorage(); await queueWindowOperation(win.label, () => win.destroy()); }
        catch (error) { setOpen(categoryId, previous); throw error; }
      })().catch(error => toast.error(String(error))).finally(() => { closeBusy.current = false; });
    });
    return () => {
      void unClose.then((fn) => fn());
    };
  }, [categoryId, setOpen, setGeometry, docked]);

  /* ── 几何持久化 + 拖拽吸附 ──
     吸附在拖动结束时算一次：读光标所在显示器的工作区、其他栅栏窗口与自身矩形，
     把 x/y 归到最近的对齐线。用 cursorPosition 而非事件的 screenX，
     多显示器下坐标原点才正确（Tauri 用虚拟桌面坐标）。 */
  useEffect(() => {
    if (!win || docked) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settling = false;

    const snap = async () => {
      if (useFences.getState().fences[categoryId]?.locked) { userTitleDrag.current = false; return; }
      const [self, size, scale] = await Promise.all([
        win.outerPosition(),
        win.outerSize(),
        win.scaleFactor(),
      ]);
      if (cancelled || modeRef.current || closeBusy.current || useFences.getState().fences[categoryId]?.locked) return;
      // 多屏解析层（Rust）：auto = 跟随鼠标所在屏（拖到哪块屏，贴的就是哪块屏的边）
      const area = await resolveMonitor(null).catch(() => null);
      if (!area) return;
      if (cancelled || modeRef.current) return;
      const normal = logicalFenceGeometry(self, size, scale);
      const logicalArea = logicalFenceGeometry({ x: area.x, y: area.y }, { width: area.w, height: area.h }, scale);
      const edge = dragDockEdge(normal, logicalArea, userTitleDrag.current);
      userTitleDrag.current = false;
      if (edge) {
        const offset = Math.max(0, (edge === "top" ? self.x - area.x : self.y - area.y) / scale);
        setGeometry(categoryId, normal);
        useFences.getState().setDockPosition(categoryId, { edge, edgeY: offset, dockOffset: offset, edgeMonitor: area.id });
        modeRef.current = true;
        setForm(categoryId, "capsule");
        return;
      }

      // 显示器工作区（物理像素，已排除任务栏）
      const wa = {
        left: area.x,
        top: area.y,
        right: area.x + area.w,
        bottom: area.y + area.h,
      };
      const w = size.width;
      const h = size.height;
      const G = Math.round(SNAP_TOLERANCE * scale);

      // 其他栅栏窗口的矩形（位置 + 尺寸），用于互相吸附
      const peers = (
        await Promise.all(
          (await getAllWebviewWindows())
            .filter((x) => x.label !== win.label && x.label.startsWith("fence-") && !x.label.startsWith("fence-group-"))
            .map(async (x) => {
              try {
                const [p, s] = await Promise.all([x.outerPosition(), x.outerSize()]);
                return { x: p.x, y: p.y, w: s.width, h: s.height };
              } catch {
                return null;
              }
            }),
        )
      ).filter((p): p is { x: number; y: number; w: number; h: number } => p !== null);

      // 候选对齐线：工作区四边 + 中线，以及其他栅栏的四边 + 中线
      const vLines = [wa.left, wa.right, Math.round((wa.left + wa.right) / 2)];
      const hLines = [wa.top, wa.bottom, Math.round((wa.top + wa.bottom) / 2)];
      for (const p of peers) {
        vLines.push(p.x, p.x + p.w, Math.round(p.x + p.w / 2));
        hLines.push(p.y, p.y + p.h, Math.round(p.y + p.h / 2));
      }

      // 自身每条参考边找最近的候选线，取位移最小且落在阈值内的那一条
      const best = (edges: number[], lines: number[]) => {
        let delta = 0;
        let bestAbs = G + 1;
        for (const e of edges) {
          for (const l of lines) {
            const d = l - e;
            if (Math.abs(d) <= G && Math.abs(d) < bestAbs) {
              bestAbs = Math.abs(d);
              delta = d;
            }
          }
        }
        return bestAbs > G ? 0 : delta;
      };

      const dx = best([self.x, self.x + Math.round(w / 2), self.x + w], vLines);
      const dy = best([self.y, self.y + Math.round(h / 2), self.y + h], hLines);
      if (!cancelled && !modeRef.current && !useFences.getState().fences[categoryId]?.locked && (dx !== 0 || dy !== 0)) {
        settling = true;
        await queueWindowOperation(win.label, async () => {
          if (!cancelled && !modeRef.current && !useFences.getState().fences[categoryId]?.locked) await win.setPosition(new PhysicalPosition(self.x + dx, self.y + dy));
        });
      }

      /*
       * 同色编组：拖一个 = 整组平移。
       * 用「本次拖动起点 → 当前位置」的总位移，而不是每次增量 —— onMoved 会
       * 反复触发，增量会越拖越远；总位移是幂等的。
       * Ctrl 按下时 temp=true，只动自己（Pogget 的临时解组）。
       */
      const group = dragGroupRef.current;
      if (group && !group.temp && !cancelled && !modeRef.current) {
        const moveX = self.x + dx - group.origin.x;
        const moveY = self.y + dy - group.origin.y;
        if (moveX !== 0 || moveY !== 0) {
          await Promise.all(group.peers.map(async (peer) => {
            const peerWin = (await getAllWebviewWindows()).find((entry) => entry.label === peer.label);
            if (!peerWin) return;
            await queueWindowOperation(peer.label, () => peerWin.setPosition(new PhysicalPosition(Math.round(peer.x + moveX), Math.round(peer.y + moveY))));
          }));
        }
      }
    };

    const schedule = () => {
      if (closeBusy.current || modeRef.current || cancelled) return;
      if (settling) return; // 吸附自身触发的 moved 事件不再递归
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        await snap().catch(error => toast.error(String(error)));
        settling = false;
        if (cancelled || modeRef.current) return;
        try {
          const [pos, size, factor] = await Promise.all([win.outerPosition(), win.outerSize(), win.scaleFactor()]);
          if (!cancelled && !modeRef.current) setGeometry(categoryId, logicalFenceGeometry(pos, size, factor));
        } catch (error) { if (!cancelled) toast.error(String(error)); }
      }, 300);
    };
    settleTitleDrag.current = schedule;

    const u1 = win.onMoved(schedule);
    const u2 = win.onResized(schedule);
    return () => {
      cancelled = true;
      settleTitleDrag.current = () => undefined;
      if (timer) clearTimeout(timer);
      void u1.then((fn) => fn());
      void u2.then((fn) => fn());
    };
  }, [categoryId, setGeometry, docked, setEdge, setEdgeY, setForm]);

  /* ── 分类改名时同步窗口标题 ──
     窗口标题属于 OS 层，不会随 store 变化自动更新。 */
  useEffect(() => {
    if (!win || !category?.name) return;
    void win.setTitle(category.name).catch(() => undefined);
  }, [category?.name]);

  /* ── 网格尺寸测量（自适应行列） ── */
  useEffect(() => {
    const el = gridWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setGridSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [docked]);

  const { cellW, cellH, cols, pageSize, iconSize } = fenceLayout(viewMode, scale, gridSize.w, gridSize.h, look);

  /* ── 盒内排序 + 搜索：先排序再过滤，翻页在过滤后的列表上算 ── */
  const ordered = useMemo(() => {
    if (sortMode === "manual") return items;
    const copy = [...items];
    if (sortMode === "name") {
      return copy.sort((a, b) => a.title.localeCompare(b.title, i18n.language, { numeric: true, sensitivity: "base" }));
    }
    // 最近创建的在前：优先用文件自身的修改时间，扫描来的条目 createdAt 只是扫描时刻
    return copy.sort((a, b) => (b.mtime ?? b.createdAt ?? 0) - (a.mtime ?? a.createdAt ?? 0) || a.id.localeCompare(b.id));
  }, [items, sortMode, i18n.language]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter(item =>
      item.title.toLowerCase().includes(q) || item.path.toLowerCase().includes(q),
    );
  }, [ordered, query]);

  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const pageItems = visible.slice(safePage * pageSize, safePage * pageSize + pageSize);

  /** 换搜索词或排序后回到第一页，否则可能停在一个已经不存在的页码上 */
  useEffect(() => { setPage(0); }, [query, sortMode]);
  const focusableId = pageItems.some(item => item.id === selectedId) ? selectedId : pageItems[0]?.id;
  const ghosted = fenceReveal === "hover" && !hover && !focusWithin && !renaming && !renameItemId && !menuOpen && !controlsOpen;
  /** 标题栏：Pogget 的 AutoHideTitleBar。hidden 时只留顶部 6px 拖动条 */
  const titleVisible = look.titleBar === "always" || (look.titleBar === "auto" && (hover || focusWithin || renaming || Boolean(renameItemId) || menuOpen || controlsOpen));

  /* ── 拖入收集：桌面/资源管理器 → 栅栏 ── */
  useEffect(() => {
    if (!win) return;
    let cancelled = false;
    const un = win.onDragDropEvent(async (ev) => {
      const p = ev.payload;
      if (p.type === "enter" || p.type === "over") {
        dockRef.current.hold("native-drop", true);
        void dockRef.current.open();
        setHover(true);
        setDropActive(true);
        return;
      }
      if (p.type === "leave") {
        dockRef.current.hold("native-drop", false);
        setHover(false);
        setDropActive(false);
        return;
      }
      if (p.type === "drop") {
        dockRef.current.hold("native-drop", false);
        const paths = p.paths;
        setDropActive(false);
        if (!paths.length || receivingDrop.current) return;
        receivingDrop.current = true;
        setDropBusy(true);
        try {
          const destination = await actions.ensureDir(categoryId);
          if (!destination || cancelled) return;
          const result = await moveDroppedFiles(categoryId, paths, destination);
          if (result.moved.length) toast.success(t("files.collected"));
          if (result.moved.some(entry => entry.sourceRetained)) toast.warning(i18n.language.startsWith('en') ? 'A source could not be removed. Its original was kept.' : '部分源文件无法移除，原文件已保留。');
          if (result.failed.length) toast.error(result.failed.map(item => `${item.source.split(/[\\/]/).pop()}: ${item.error}`).join('\n'));
        } catch (e) {
          toast.error(String(e));
        } finally {
          receivingDrop.current = false;
          setDropBusy(false);
        }
      }
    });
    return () => {
      cancelled = true;
      dockRef.current.hold("native-drop", false);
      void un.then((fn) => fn());
    };
  }, [categoryId, actions.ensureDir, i18n]);

  /* ── 滚轮：翻页 / Ctrl+滚轮缩放（非 passive 才能拦截 Ctrl 滚轮） ── */
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale + (e.deltaY < 0 ? 0.06 : -0.06)));
        setScale(categoryId, Math.round(next * 100) / 100);
        return;
      }
      if (e.deltaY > 0) setPage((p) => Math.min(p + 1, pages - 1));
      else setPage((p) => Math.max(p - 1, 0));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pages, scale, categoryId, setScale, docked]);

  /* ── 落点计算：指针位置 → 插入位 + 竖线几何（相对网格容器） ── */
  const computeDrop = (cx: number, cy: number) => {
    const grid = gridRef.current;
    if (!grid || pageItems.length === 0) return null;
    const gr = grid.getBoundingClientRect();
    let local = pageItems.length;
    for (let i = 0; i < pageItems.length; i++) {
      const el = itemRefs.current.get(pageItems[i].id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      // 行主序：先看是否落在该行之前，再看是否在该行中线左侧
      if (fenceInsertionBefore(viewMode, r, cx, cy)) {
        local = i;
        break;
      }
    }
    const anchorEl = itemRefs.current.get(
      pageItems[Math.min(local, pageItems.length - 1)].id,
    );
    if (!anchorEl) return null;
    const ar = anchorEl.getBoundingClientRect();
    const atEnd = local >= pageItems.length;
    // 插到本页末尾时，锚点为下一页首条（保证跨页顺序正确），无下一页则移到分类末尾
    const globalIdx = safePage * pageSize + local;
    const anchorId = items[globalIdx]?.id ?? null;
    return {
      anchorId,
      x: listView ? ar.left - gr.left : (atEnd ? ar.right : ar.left) - gr.left + (atEnd ? GAP / 2 : -GAP / 2),
      y: listView ? (atEnd ? ar.bottom : ar.top) - gr.top + (atEnd ? GAP / 2 : -GAP / 2) : ar.top - gr.top,
      h: listView ? 2 : ar.height,
      w: listView ? ar.width : 2,
    };
  };

  /* ── 条目指针手势：单击选中 · 窗口内拖动=排序 · 拖出窗口=系统拖出 ── */
  const startItemDrag = (e: React.PointerEvent, item: FileItem) => {
    if (e.button !== 0 || dragOutBusy.current) return;
    setSelectedId(item.id);
    const el = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    const sx = e.clientX;
    const sy = e.clientY;
    dockRef.current.hold("item-drag", true);
    const isLocal = item.type !== "url";
    let mode: "idle" | "reorder" | "out" = "idle";
    let pending: { anchorId: string | null; x: number; y: number; h: number; w: number } | null = null;

    const isOutside = (cx: number, cy: number) => {
      const p = panelRef.current?.getBoundingClientRect();
      if (!p) return false;
      return cx <= p.left || cx >= p.right || cy <= p.top || cy >= p.bottom;
    };

    const cleanup = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
      if (mode !== "out") dockRef.current.hold("item-drag", false);
    };

    /** 交给系统 OLE 拖拽（可落到桌面/资源管理器） */
    const beginDragOut = () => {
      mode = "out";
      dragOutBusy.current = true;
      suppressClickUntil.current = Date.now() + 800;
      pending = null;
      setDrop(null);
      setDragId(null);
      cleanup();
      void dragOut([item.path])
        .catch(() => undefined)
        .finally(() => {
          dragOutBusy.current = false;
          dockRef.current.hold("item-drag", false);
        });
    };

    const onMove = (ev: PointerEvent) => {
      if (mode === "out") return;
      if (mode === "idle") {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        mode = "reorder";
        setDragId(item.id);
      }
      // 越过栅栏边界 → 转为系统拖出（网址条目留在原地）
      if (isOutside(ev.clientX, ev.clientY)) {
        if (isLocal) beginDragOut();
        return;
      }
      if (mode !== "reorder") return;
      pending = computeDrop(ev.clientX, ev.clientY);
      setDrop(pending);
    };

    const onUp = (ev: PointerEvent) => {
      if (mode === "reorder" && pending && !isOutside(ev.clientX, ev.clientY)) {
        moveItemBefore(item.id, pending.anchorId);
        suppressClickUntil.current = Date.now() + 300;
      }
      pending = null;
      setDrop(null);
      setDragId(null);
      cleanup();
    };
    const onCancel = () => {
      pending = null;
      setDrop(null);
      setDragId(null);
      cleanup();
    };

    // 指针捕获：拖出窗口仍能收到 move/up，状态不会卡死
    el.setPointerCapture(pointerId);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
  };

  const openItem = (path: string, type: string) => {
    if (Date.now() < suppressClickUntil.current) return;
    void openTarget(path, type as "file" | "folder" | "url").catch(() => toast.error(t("common.error")));
  };

  const onItemKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, item: FileItem) => {
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
    const index = pageItems.findIndex(entry => entry.id === item.id);
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols };
    let next: number | undefined;
    if (event.key in offsets) next = Math.max(0, Math.min(pageItems.length - 1, index + offsets[event.key]));
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = pageItems.length - 1;
    else if (event.key === "Enter") openItem(item.path, item.type);
    else if (event.key === "F2") beginItemRename(item);
    else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      const rect = event.currentTarget.getBoundingClientRect();
      void openMenu({ kind: "item", item }, { x: rect.left, y: rect.bottom }).catch(error => toast.error(String(error)));
    } else return;
    event.preventDefault();
    event.stopPropagation();
    if (next !== undefined && pageItems[next]) {
      const id = pageItems[next].id;
      setSelectedId(id);
      itemRefs.current.get(id)?.focus();
    }
  };

  /* ── 标题栏拖动 ──
     不用 data-tauri-drag-region：它把双击实现为「切换最大化」，
     而这里双击要用于改名。改为按下后位移超过阈值才发起系统拖动。 */
  const startTitleDrag = (e: React.PointerEvent) => {
    if (e.button !== 0 || !win || useFences.getState().fences[categoryId]?.locked) return;
    // 落在按钮/输入框上时不拖
    if ((e.target as HTMLElement).closest("button,input")) return;
    if (docked) { dock.startDrag(e); return; }
    if (modeRef.current || closeBusy.current) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let dragging = false;
    const el = e.currentTarget as HTMLElement;

    const onMove = (ev: PointerEvent) => {
      if (useFences.getState().fences[categoryId]?.locked) { cleanup(); return; }
      if (dragging) return;
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      dragging = true;
      userTitleDrag.current = true;
      cleanup();
      // 记下同色编组的起点；Ctrl = 临时解组，只拖自己。
      const groupColor = useFiles.getState().categories.find((entry) => entry.id === categoryId)?.groupColor;
      dragGroupRef.current = null;
      const groupTask = groupColor
        ? (async () => {
            const [self, windows] = await Promise.all([win.outerPosition(), getAllWebviewWindows()]);
            const peers = await Promise.all(windows
              .filter((entry) => entry.label !== win.label && entry.label.startsWith("fence-") && !entry.label.startsWith("fence-group-"))
              .map(async (entry) => {
                const peerCategoryId = entry.label.slice("fence-".length);
                const peerCategory = useFiles.getState().categories.find((candidate) => candidate.id === peerCategoryId);
                if (peerCategory?.groupColor !== groupColor) return null;
                const position = await entry.outerPosition();
                return { label: entry.label, x: position.x, y: position.y };
              }));
            dragGroupRef.current = {
              temp: ev.ctrlKey,
              origin: { x: self.x, y: self.y },
              peers: peers.filter((peer): peer is { label: string; x: number; y: number } => peer !== null),
            };
          })().catch(() => undefined)
        : Promise.resolve();
      void groupTask.then(() => win.startDragging()).then(async () => {
        settleTitleDrag.current();
        // startDragging 在按下时就返回；等系统拖动真正结束再丢弃编组起点。
        await invoke("desktop_wait_drag_end").catch(() => undefined);
        dragGroupRef.current = null;
      }).catch(error => {
        userTitleDrag.current = false;
        dragGroupRef.current = null;
        toast.error(String(error));
      });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      el.removeEventListener("pointercancel", cleanup);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    el.addEventListener("pointercancel", cleanup);
  };

  const card = (
    <div
      className="absolute inset-0 p-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false);
      }}
    >
      <div
        ref={panelRef}
        className={cn(
          "relative flex h-full w-full flex-col overflow-hidden border transition-opacity duration-300",
          ghosted && !docked ? "opacity-[0.14]" : "opacity-100",
        )}
        style={{
          background: `color-mix(in oklch, var(--card) ${Math.round(look.backgroundAlpha * 100)}%, transparent)`,
          borderColor: "var(--border)",
          borderRadius: look.radius,
          fontFamily: boxFontFamily(look.fontFamily) || undefined,
          backdropFilter: "blur(2px)",
        }}
      >
        {(dropActive || dropBusy) && <div role="status" className="pointer-events-none absolute inset-0 z-40 grid place-items-center rounded-2xl border-2 border-brand bg-card/95 p-5 text-center text-sm text-foreground">
          {i18n.language.startsWith('en') ? (dropBusy ? 'Moving files…' : 'Drop to move into this fence\u2019s folder') : (dropBusy ? '正在移动文件…' : '松开以移动到此栅格目录')}
        </div>}
        {/* 标题栏隐藏时留一条 6px 拖动带：不占整行，但窗口仍然能移动 */}
        {look.titleBar === "hidden" && (
          <div
            onPointerDown={startTitleDrag}
            className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-move"
            aria-hidden="true"
          />
        )}
        {/* 迷你标题栏：按住拖动移动（自己实现，避免双击被当成最大化）；双击名称 = 改名 */}
        <div
          onPointerDown={startTitleDrag}
          className={cn(
            "flex h-9 shrink-0 cursor-default items-center gap-1.5 border-b border-border/60 px-3 select-none",
            !titleVisible && "hidden",
          )}
          style={docked && dock.tabTop > 0 ? { [dock.edge === "right" ? "paddingLeft" : "paddingRight"]: 24 } : undefined}
        >
          {renaming ? (
            <input
              ref={renameRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                if (e.key === "Escape") {
                  e.preventDefault();
                  categoryRenameActive.current = false;
                  setRenaming(false);
                }
              }}
              data-tauri-drag-region="false"
              className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1 text-[12px] outline-none focus:border-brand/50"
            />
          ) : (
            <span
              onDoubleClick={startRename}
              title={t(locked ? "files.renameLockedHint" : "files.renameHint")}
              className="min-w-0 flex-1 cursor-default truncate text-[12px] font-semibold text-foreground/90"
            >
              {category?.name ?? "…"}
            </span>
          )}
          {/* 计数与按钮区不参与拖动，避免点按钮时误拖窗口 */}
          <span data-tauri-drag-region="false" className="flex shrink-0 items-center gap-1.5">
            {category?.groupColor && (
              <span
                aria-hidden="true"
                title={t("files.appearanceGroup")}
                className="size-2.5 shrink-0 rounded-full border border-black/10"
                style={{ background: category.groupColor }}
              />
            )}
            <span className="text-[10px] text-muted-foreground">
              {query.trim() ? `${visible.length}/${items.length}` : items.length}
            </span>
            {docked && <TitleBtn title={t("plans.capsuleSwitchEdge")} disabled={locked} onClick={() => void dock.switchEdge()}><ArrowLeftRight className="size-3.5" /></TitleBtn>}
            <TitleBtn title={t(docked ? "plans.capsuleExpand" : "plans.capsuleToEdge")}
              onClick={() => {
                if (docked) { void dock.undock(); return; }
                if (modeRef.current) return;
                dockingBusy.current = true;
                modeRef.current = true;
                void (async () => {
                  if (win) await queueWindowOperation(win.label, async () => {
                    const [position, size, factor] = await Promise.all([win.outerPosition(), win.outerSize(), win.scaleFactor()]);
                    setGeometry(categoryId, logicalFenceGeometry(position, size, factor));
                  });
                  setForm(categoryId, "capsule");
                  dockingBusy.current = false;
                })().catch(error => { dockingBusy.current = false; modeRef.current = false; toast.error(String(error)); });
              }}>
              {docked ? <Expand className="size-3.5" /> : <PanelRightClose className="size-3.5" />}
            </TitleBtn>
            <TitleBtn title={t("files.boxSearch")} active={searching}
              onClick={() => {
                setSearching(open => {
                  if (open) { setQuery(""); }
                  else { requestAnimationFrame(() => searchRef.current?.focus()); }
                  return !open;
                });
              }}>
              <Search className="size-3.5" />
            </TitleBtn>
            <TitleBtn title={t(listView ? "files.iconView" : "files.listView")} active={listView}
              onClick={() => { setCategoryAppearance(categoryId, { view: listView ? "icons" : "list" }); setPage(0); }}>
              {listView ? <LayoutGrid className="size-3.5" /> : <List className="size-3.5" />}
            </TitleBtn>
            <TitleBtn title={t("files.appearanceTitle")} active={appearanceOpen}
              onClick={() => setAppearanceOpen((open) => !open)}>
              <Settings className="size-3.5" />
            </TitleBtn>
            <TitleBtn title={t(locked ? "files.unlockPosition" : "files.lockPosition")} active={locked}
              onClick={() => setLocked(categoryId, !locked)}>
              {locked ? <LockKeyhole className="size-3.5" /> : <UnlockKeyhole className="size-3.5" />}
            </TitleBtn>
            {docked && <TitleBtn title={i18n.language.startsWith("en") ? "Sticky appearance and size" : "便签外观与大小"} onClick={() => void dock.openAppearance()}><Palette className="size-3.5" /></TitleBtn>}
            <div ref={controlsRef} className="relative">
              <button ref={controlsButtonRef} type="button" aria-label={t("files.fenceOptions")} title={t("files.fenceOptions")}
                aria-expanded={controlsOpen} onClick={() => setControlsOpen(open => !open)}
                className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                <MoreHorizontal className="size-3.5" />
              </button>
              {controlsOpen && <div className="absolute right-0 top-8 z-30 w-44 rounded-xl border border-border bg-popover p-1.5 shadow-lg">
                <button type="button" aria-pressed={pinned} onClick={() => setPinned(categoryId, !pinned)}
                  className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-xs text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
                  {pinned ? <Pin className="size-3.5 shrink-0 text-brand" /> : <PinOff className="size-3.5 shrink-0" />}{t(pinned ? "files.unpin" : "files.pin")}
                </button>
                <div className="my-1 h-px bg-border/60" />
                <p className="px-2 pb-1 pt-0.5 text-[10px] text-muted-foreground">{t("files.sortBy")}</p>
                {([
                  { mode: "manual" as FenceSortMode, label: t("files.sortManual") },
                  { mode: "name" as FenceSortMode, label: t("files.sortName") },
                  { mode: "time" as FenceSortMode, label: t("files.sortTime") },
                ]).map(({ mode, label }) => (
                  <button key={mode} type="button" data-sort={mode} aria-pressed={sortMode === mode}
                    onClick={() => setSortMode(categoryId, mode)}
                    className={cn(
                      "flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring",
                      sortMode === mode ? "text-brand" : "text-foreground",
                    )}>
                    <span className={cn("size-1.5 shrink-0 rounded-full", sortMode === mode ? "bg-brand" : "bg-muted-foreground/30")} />
                    {label}
                  </button>
                ))}
                <div className="my-1 h-px bg-border/60" />
                <p className="px-2 pb-1 pt-0.5 text-[10px] text-muted-foreground">{t("files.fileName")}</p>
                {([
                  { mode: "full" as const, label: t("files.fileNameFull") },
                  { mode: "noExt" as const, label: t("files.fileNameNoExt") },
                  { mode: "extOnly" as const, label: t("files.fileNameExtOnly") },
                  { mode: "none" as const, label: t("files.fileNameNone") },
                ]).map(({ mode, label }) => (
                  <button key={mode} type="button" data-name-mode={mode} aria-pressed={look.nameMode === mode}
                    onClick={() => {
                      setCategoryAppearance(categoryId, { nameMode: mode });
                      // 旧字段同步写一份：老版本回退/旧数据仍能读到同一个选择。
                      if (mode !== "none") useFences.getState().setFileNameMode(categoryId, mode);
                    }}
                    className={cn(
                      "flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring",
                      look.nameMode === mode ? "text-brand" : "text-foreground",
                    )}>
                    <span className={cn("size-1.5 shrink-0 rounded-full", look.nameMode === mode ? "bg-brand" : "bg-muted-foreground/30")} />
                    {label}
                  </button>
                ))}
              </div>}
            </div>
            <TitleBtn danger title={t("titlebar.close")} onClick={() => void win?.close().catch(error => toast.error(String(error)))}>
              <X className="size-3.5" />
            </TitleBtn>
          </span>
        </div>

        {appearanceOpen && category && (
          <BoxAppearancePanel
            category={category}
            onChange={(patch) => setCategoryAppearance(categoryId, patch)}
            onClose={() => setAppearanceOpen(false)}
            onGroupColor={(color) => setCategoryGroupColor(categoryId, color)}
            onMerge={category.groupColor ? () => {
              void openFenceGroup(category.groupColor!).catch((error) => toast.error(String(error)));
            } : undefined}
            className="absolute right-1 top-10 z-40 w-[calc(100%-8px)] max-w-[300px] max-h-[calc(100%-52px)] overflow-y-auto"
          />
        )}

        {/* 盒内搜索栏：只在需要时占一行，平时不挤标题栏 */}
        {searching && (
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Escape") { e.preventDefault(); setQuery(""); setSearching(false); }
              }}
              placeholder={t("files.boxSearchPlaceholder")}
              aria-label={t("files.boxSearch")}
              data-tauri-drag-region="false"
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
            />
            {query && (
              <button
                type="button"
                aria-label={t("files.boxSearchClear")}
                onClick={() => { setQuery(""); searchRef.current?.focus(); }}
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        )}

        {/* 条目网格：右键菜单在独立浮窗渲染（可溢出栅栏窗口边界） */}
        <div
          ref={gridWrapRef}
          role="listbox"
          data-view-mode={viewMode}
          aria-label={category?.name ?? t("files.title")}
          onMouseDown={(e) => {
            // 点空白处取消选中（条目上带 data-item 标记）
            if (!(e.target as HTMLElement).closest("[data-item]")) setSelectedId(null);
          }}
          onContextMenu={onContextMenu}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2"
        >
          {pageItems.length === 0 ? (
            <div className="grid h-full place-items-center px-4 text-center text-[11px] leading-relaxed text-muted-foreground">
              {query.trim() ? t("files.boxNoMatch") : t("files.fenceEmpty")}
            </div>
          ) : (
            <div
              ref={gridRef}
              className="relative mx-auto grid"
              style={{
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gap: GAP,
                maxWidth: listView ? "100%" : cols * (cellW + GAP),
              }}
            >
              {pageItems.map((item) => {
                const isSelected = selectedId === item.id;
                const isDragging = dragId === item.id;
                const isRenaming = renameItemId === item.id;
                return (
                  <div
                    key={item.id}
                    {...{ [ITEM_ATTR]: item.id }}
                    data-item
                    role="option"
                    aria-label={item.title}
                    aria-selected={isSelected}
                    tabIndex={item.id === focusableId ? 0 : -1}
                    ref={(el) => {
                      if (el) itemRefs.current.set(item.id, el);
                      else itemRefs.current.delete(item.id);
                    }}
                    onPointerDown={(e) => {
                      if (!isRenaming) {
                        e.currentTarget.focus();
                        startItemDrag(e, item);
                      }
                    }}
                    onFocus={() => setSelectedId(item.id)}
                    onKeyDown={(event) => onItemKeyDown(event, item)}
                    onDoubleClick={() => openItem(item.path, item.type)}
                    title={t("files.itemHint")}
                    className={cn(
                      "group relative flex min-w-0 touch-none items-center rounded-lg transition-colors select-none focus-visible:outline-2 focus-visible:outline-ring",
                      listView ? "flex-row justify-start gap-2 px-2" : "flex-col justify-center gap-1 p-1",
                      isSelected
                        ? "cursor-grab bg-brand/12 ring-1 ring-brand/60 active:cursor-grabbing"
                        : "cursor-pointer hover:bg-surface-hover",
                      isDragging && "opacity-40",
                    )}
                    style={{ height: cellH }}
                  >
                    <span
                      className="grid shrink-0 place-items-center"
                      style={{ width: iconSize, height: iconSize }}
                    >
                      <ItemVisual
                        item={item}
                        size={iconSize}
                        appearance={look}
                        iconClassName="size-full"
                      />
                    </span>
                    {isRenaming ? (
                      <input
                        ref={itemRenameRef}
                        value={itemDraft}
                        onChange={(e) => setItemDraft(e.target.value)}
                        onPointerDown={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        onBlur={() => void commitItemRename(item)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.nativeEvent.isComposing) return;
                          if (e.key === "Enter") { e.preventDefault(); void commitItemRename(item, true); }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            activeItemRename.current = null;
                            setRenameItemId(null);
                            requestAnimationFrame(() => itemRefs.current.get(item.id)?.focus());
                          }
                        }}
                        className={cn("min-w-0 w-full rounded border border-brand/60 bg-card px-1 py-0.5 text-[10px] outline-none", !listView && "text-center")}
                      />
                    ) : look.nameMode !== "none" ? (
                      <span
                        className={cn("w-full leading-tight text-foreground/85", listView ? "min-w-0 truncate text-left" : "line-clamp-2 break-all text-center")}
                        style={{ fontSize: Math.max(8, Math.round(look.fontSize * scale)) }}
                      >
                        {boxDisplayName(item.title, look.nameMode)}
                      </span>
                    ) : null}
                  </div>
                );
              })}

              {/* 落点竖线：指示插入位置 */}
              {drop && (
                <div
                  className="pointer-events-none absolute z-20 w-0.5 rounded-full bg-brand shadow-[0_0_6px_var(--brand)]"
                  style={{ left: drop.x, top: drop.y, height: drop.h, width: drop.w }}
                />
              )}
            </div>
          )}
        </div>

        {/* 翻页圆点 */}
        {pages > 1 && (
          <div className="flex shrink-0 flex-wrap items-center justify-center pb-1">
            {Array.from({ length: pages }, (_, i) => (
              <button
                key={i}
                type="button"
                aria-label={i18n.language.startsWith("en") ? `Page ${i + 1} of ${pages}` : `第 ${i + 1} 页，共 ${pages} 页`}
                aria-current={i === safePage ? "page" : false}
                onClick={() => setPage(i)}
                className="group/page grid size-6 place-items-center rounded focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className={cn("size-1.5 rounded-full transition-all duration-200", i === safePage ? "w-3 bg-brand" : "bg-muted-foreground/40 group-hover/page:bg-muted-foreground")} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
  return docked ? <EdgeDockFrame dock={dock} label={category?.name ?? "…"} summary={String(items.length)} en={i18n.language.startsWith("en")} locked={locked} onToggleLock={() => setLocked(categoryId, !locked)}>{card}</EdgeDockFrame> : card;
}

function TitleBtn({
  title,
  active,
  danger,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-35",
        danger
          ? "text-muted-foreground hover:bg-[var(--close-hover-bg)] hover:text-[var(--close-hover-fg)]"
          : active
            ? "text-brand"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
