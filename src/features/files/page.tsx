import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Plus,
  Search,
  Pencil,
  Trash2,
  ExternalLink,
  Loader2,
  X,
  MoreHorizontal,
  FolderOpen,
  Copy,
  ArrowLeft,
  Settings,
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  CircleHelp,
  FolderSearch,
  LayoutGrid,
  List,
  FolderPlus,
  Monitor,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  useFiles,
  useFences,
  type FileItem,
  type ItemType,
} from "@/stores/files";
import { useSettings } from "@/stores/settings";
import { categoryKind, type CategoryKind } from "@/stores/files";
import {
  revealInExplorer,
  pickFolder,
  pickFile,
  fetchSiteMeta,
  fileDirectorySnapshot,
  moveFenceEntries,
  probePaths,
  pathMeta,
  dragOut,
  type DirectorySnapshot,
} from "@/lib/tauri";
import { useModal } from "@/components/shell/modal-host";
import { invoke } from "@tauri-apps/api/core";
import { ListSentinel, useIncrementalCount } from "@/components/ui/incremental-list";
import { copyText } from "@/lib/clipboard";
import { motion } from "motion/react";
import { ItemIcon } from "@/features/files/icons";
import { boxAppearance, boxDisplayName, boxFontFamily } from "./box-appearance";
import { BoxAppearancePanel } from "./box-appearance-panel";
import { ItemVisual } from "./file-preview";
import { useFileActions } from "@/features/files/actions";
import { usePopupMenu } from "@/features/files/use-popup-menu";
import { ITEM_ATTR } from "@/features/files/menu-model";
import { useFileDrop, type FileDropPoint } from "./use-file-drop";
import { openFenceGroup, restoreFenceOnDesktop, setAllFencesOnDesktop, setFenceOnDesktop } from "./desktop-actions";
import { useItemMetaRefresh } from "./use-meta-cache";
import { moveDroppedFiles } from "./fence-drop";
import { dissolveBox } from "./dissolve";
import { moveItemsToBox } from "./move-between-boxes";
import { useFileHistory } from "./history";
import { undoLastFileOp } from "./undo";
import { CategoryMappingBar } from "./directory-mapping-controls";
import { QuickAccessDrawer } from "./quick-access-drawer";
import { openTarget } from "./open-target";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { useAppMenuItems } from "@/components/shell/app-context-menu";

/**
 * 盒子配色**按种类固定**，不是每盒随机的。
 * 颜色是给「这是哪一类盒子」用的：快捷=蓝、存储=黄、映射=橙。
 * 让用户自选颜色会让分类信息消失 —— 三个盒子三种颜色，却看不出哪个是映射盒。
 */
const BOX_KIND_COLOR: Record<CategoryKind, string> = {
  shortcut: "kind-shortcut",
  storage: "kind-storage",
  mapped: "kind-mapped",
};
const boxAccent = (category: { kind?: CategoryKind; syncDir?: boolean }) => BOX_KIND_COLOR[categoryKind(category)];

/** 分类 chip 上的标记：右键时据此判断命中了哪个分类 */
const CAT_ATTR = "data-cat-id";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { gsap, useGSAP } from "@/lib/gsap";
import { cn } from "@/lib/utils";

function nameFromPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** 文件管理：分类 + 多标签 + 三类绑定（文件夹/文件/网站）+ 桌面栅栏开关 */
export function FilesPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const requestedItem = searchParams.get("item") || "";
  const consumedSearch = useRef("");
  const { confirm, alert, prompt } = useModal();
  const categories = useFiles((s) => s.categories);
  const items = useFiles((s) => s.items);
  const addCategory = useFiles((s) => s.addCategory);
  const renameCategory = useFiles((s) => s.renameCategory);
  const moveItemBefore = useFiles((s) => s.moveItemBefore);
  const setCategoryAppearance = useFiles((s) => s.setCategoryAppearance);
  const fences = useFences((s) => s.fences);
  const quickDirs = useSettings((s) => s.quickDirs);
  const collectConfirmMb = useSettings((s) => s.collectConfirmMb);
  const boxTileSizeSetting = useSettings((s) => s.boxTileSize);
  const boxTileSize = boxTileSizeSetting === "sm" || boxTileSizeSetting === "lg" ? boxTileSizeSetting : "md";
  /** 方块上的缩略图标跟着档位缩放，不再固定 20px */
  const previewIconSize = boxTileSize === "sm" ? 18 : boxTileSize === "lg" ? 44 : 28;
  const tileIconSize = boxTileSize === "sm" ? 38 : boxTileSize === "lg" ? 72 : 52;
  const setBoxTileSize = useSettings((s) => s.setBoxTileSize);
  /** boxes 视图里点开的分类；null = 展示全部分类盒子 */
  const [openBoxId, setOpenBoxId] = useState<string | null>(null);
  /** 指针是否压在「桌面」落点上：只用于高亮，真正的判定在拖拽手势里 */
  const [deskTarget, setDeskTarget] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  /** 内联文件夹：栈里的路径 + 当前游标；空栈 = 盒子根，不是内联视图 */
  const [inlineTrail, setInlineTrail] = useState<string[]>([]);
  const [inlineCursor, setInlineCursor] = useState(-1);
  const [inlineEntries, setInlineEntries] = useState<DirectorySnapshot["entries"]>([]);
  const [inlineBusy, setInlineBusy] = useState(false);
  /** 点开的那个方块在视口里的矩形：浮层的缩放原点从这里算，视觉上「从这个方块长出来」 */
  const boxOrigin = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelOrigin, setPanelOrigin] = useState("50% 50%");
  const [filesHydrated, setFilesHydrated] = useState(useFiles.persist.hasHydrated);
  const [fencesHydrated, setFencesHydrated] = useState(useFences.persist.hasHydrated);

  const [selected, setSelected] = useState<string | null>(null); // null = 全部
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  /** 多选：Ctrl/Cmd 挑、Shift 连选、Alt 减选。映射盒是磁盘镜像，不参与 */
  const [picked, setPicked] = useState<string[]>([]);
  const pickAnchor = useRef<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [modal, setModal] = useState<{ open: boolean; editing: FileItem | null }>({
    open: false,
    editing: null,
  });
  const restored = useRef(new Set<string>());
  const mounted = useRef(false);
  const desktopLock = useRef(false);
  const dragOutBusy = useRef(false);
  /** 墙上拖盒子排序：正在拖的那个 + 松开后要抑制的那次点击 */
  const [boxDragId, setBoxDragId] = useState<string | null>(null);
  const [boxDropBefore, setBoxDropBefore] = useState<string | null>(null);
  const [looseDropId, setLooseDropId] = useState<string | null>(null);
  /** 拖动时跟着指针的小卡片：位置直接写 DOM transform，不走 state（否则每次移动都整页重渲染，卡片会跳） */
  const [dragGhost, setDragGhost] = useState<{ item: FileItem } | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const dragGhostPos = useRef({ x: 0, y: 0 });
  const suppressBoxOpenUntil = useRef(0);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [desktopProgress, setDesktopProgress] = useState({ done: 0, total: 0 });
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickDropId, setQuickDropId] = useState<string | null>(null);
  /** 栅栏是全开或全关：任一盒子在桌面上就视为「开」 */
  const desktopShown = categories.some((cat) => fences[cat.id]?.open);

  const actions = useFileActions();

  useEffect(() => {
    mounted.current = true;
    const offFiles = useFiles.persist.onFinishHydration(() => setFilesHydrated(true));
    const offFences = useFences.persist.onFinishHydration(() => setFencesHydrated(true));
    setFilesHydrated(useFiles.persist.hasHydrated());
    setFencesHydrated(useFences.persist.hasHydrated());
    return () => { mounted.current = false; offFiles(); offFences(); };
  }, []);

  /** 原生拖放落点：先按 CSS 像素找，找不到再按物理像素找（Tauri 各平台不一致） */
  const atDropPoint = (point: FileDropPoint | null | undefined, selector: string, attr: string): string | null => {
    if (!point) return null;
    const hit = (x: number, y: number) =>
      document.elementFromPoint(x, y)?.closest<HTMLElement>(selector)?.getAttribute(attr) ?? null;
    const scale = window.devicePixelRatio || 1;
    return hit(point.x / scale, point.y / scale) ?? hit(point.x, point.y);
  };
  const boxAtDropPoint = (point?: FileDropPoint | null) => atDropPoint(point, "[data-box-card]", CAT_ATTR);
  const quickAtDropPoint = (point?: FileDropPoint | null) => atDropPoint(point, "[data-drop-quick]", "data-drop-quick");

  const { dragging, busy: importing } = useFileDrop({
    enabled: filesHydrated && !modal.open,
    onOver: point => setNativeDropBoxId(boxAtDropPoint(point)),
    onDrop: async (paths, point) => {
      const quickId = quickAtDropPoint(point);
      if (quickId) {
        setNativeDropBoxId(null);
        await movePathsToQuickDir(paths, quickId);
        return;
      }
      // 优先用鼠标落点下的盒子；否则退回当前打开的盒子（兼容旧操作）。
      const target = boxAtDropPoint(point) ?? openBoxId;
      setNativeDropBoxId(null);
      if (!target) {
        // 空墙上的落点没有盒子：直接开「新建收纳盒」并把文件带上，不要丢掉这次拖放
        setNewBox({ name: nameFromPath(paths[0]), kind: "shortcut", paths });
        return;
      }
      const targetCategory = categories.find((category) => category.id === target);
      await collectIntoBox(target, paths);
      if (!mounted.current) return;
      if (targetCategory) {
        setSelected(targetCategory.id);
        setSearch("");
        setActiveTags([]);
      }
    },
    onError: error => { if (mounted.current) toast.error(String(error)); },
  });

  // 启动恢复已开启的栅栏；已合并的编组只开宿主窗口，不再单独开成员栅栏
  useEffect(() => {
    if (!filesHydrated || !fencesHydrated) return;
    const groups = useFences.getState().groups;
    const restoredGroups = new Set<string>();
    for (const cat of categories) {
      const f = fences[cat.id];
      if (!f?.open || restored.current.has(cat.id)) continue;
      const color = cat.groupColor?.toLowerCase();
      const group = color ? groups[color] : undefined;
      if (color && group?.open) {
        restored.current.add(cat.id);
        if (!restoredGroups.has(color)) {
          restoredGroups.add(color);
          void openFenceGroup(color).catch(error => toast.error(String(error)));
        }
        continue;
      }
      restored.current.add(cat.id);
      void restoreFenceOnDesktop(cat.id).catch(error => toast.error(String(error)));
    }
  }, [filesHydrated, fencesHydrated, categories, fences]);

  /** 条目元信息缓存：过期了才刷，每轮最多 200 条（纯前端，不阻塞渲染） */
  useItemMetaRefresh(items);

  /** 撤销：Ctrl+Z 走 history 栈（rename/move/create 能倒回；删除只能去回收站还原） */
  const undoBusy = useRef(false);
  const onUndo = useCallback(async () => {
    if (undoBusy.current) return;
    undoBusy.current = true;
    try {
      const op = await undoLastFileOp();
      if (op) toast.success(t("files.undone", { label: op.label }));
    } catch (error) {
      toast.error(String(error));
    } finally {
      undoBusy.current = false;
    }
  }, [t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      void onUndo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onUndo]);

  const scoped = selected ? items.filter((i) => i.categoryId === selected) : items;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scoped
      .filter(
        (i) =>
          !q ||
          i.title.toLowerCase().includes(q) ||
          i.path.toLowerCase().includes(q),
      );
  }, [scoped, activeTags, search]);

  /**
   * 条目网格分片渲染。
   *
   * 文件页的条目可能上千（整目录映射进来时尤其明显）：以前是一次性把整批卡片铺进 DOM，
   * 每次筛选重算都要重排整张网格。这里只先铺一批，滚到底部自动续下一批 ——
   * DOM 数量有上界，布局仍然交给浏览器（不需要按行高算位置，卡片换行也不会错位）。
   * 换分类 / 改标签 / 改搜索词都回到第一批。
   */
  const { count: visibleCount, hasMore, sentinelRef, ensureVisible } = useIncrementalCount(filtered.length, {
    resetKey: `${selected ?? ""}|${activeTags.join(",")}|${search}`,
    // 条目网格现在只在盒子浮层里渲染，浮层自己是滚动容器
    root: panelRef,
  });

  /** 分类显示名（子分类带父名前缀）；找不到时回退空串 */
  const categoryLabelOf = (categoryId: string): string => {
    const cat = categories.find((c) => c.id === categoryId);
    if (!cat) return "";
    const parent = cat.parentId ? categories.find((p) => p.id === cat.parentId) : undefined;
    return parent ? `${parent.name} / ${cat.name}` : cat.name;
  };

  const gridRef = useRef<HTMLDivElement>(null);
  /** 深链要定位的条目：先记下来，等过滤条件落定、网格把它渲染出来之后再滚 */
  const pendingScroll = useRef<{ id: string; categoryId: string } | null>(null);
  useEffect(() => {
    const request = `${location.key}:${requestedItem}`;
    if (!requestedItem || consumedSearch.current === request || !items.some(item => item.id === requestedItem)) return;
    consumedSearch.current = request;
    const item = items.find(item => item.id === requestedItem)!;
    setSelected(item.categoryId); setSearch(""); setActiveTags([]); setSelectedItemId(item.id);
    // 只有盒子视图：深链必须把目标所在盒子打开，否则网格根本不渲染
    boxOrigin.current = null;
    setOpenBoxId(item.categoryId);
    pendingScroll.current = { id: item.id, categoryId: item.categoryId };
  }, [location.key, requestedItem, items]);

  /**
   * 把深链目标滚进视野。
   *
   * 两件事要一起处理，缺一个就会「静默丢目标」：
   *
   * 1. **过滤条件要落定**。深链会同时切分类、清空搜索与标签，这些改到下一次渲染才生效；
   *    本 effect 在这次 commit 里拿到的 `filtered` 仍是**旧**过滤条件的结果 —— 用户本来
   *    就在别的分类里（或搜索框有字）时，旧条件下根本没有目标条目。此时把它当成
   *    「找不到、放弃」就正好丢目标，所以先等 `selected/search/activeTags` 追上目标状态。
   * 2. **网格是分片的**。目标可能排在 `filtered` 第 200 位，而首批只铺 120 张卡片，
   *    DOM 里没有它，直接 `scrollIntoView` 会失败；先算出下标交给 `ensureVisible`
   *    把那一批补出来，补完重渲染（依赖里带 `visibleCount`）再滚。
   */
  useEffect(() => {
    const target = pendingScroll.current;
    if (!target) return;
    // 目标已经从数据里消失了（别处删除、备份恢复）：不必再等
    if (!items.some(item => item.id === target.id)) { pendingScroll.current = null; return; }
    const settled = selected === target.categoryId && !search && activeTags.length === 0;
    if (!settled) return;
    const card = Array.from(gridRef.current?.querySelectorAll<HTMLElement>(`[${ITEM_ATTR}]`) ?? [])
      .find(node => node.getAttribute(ITEM_ATTR) === target.id);
    if (card) {
      card.scrollIntoView({ block: "center", behavior: "instant" });
      pendingScroll.current = null;
      return;
    }
    const index = filtered.findIndex(item => item.id === target.id);
    // 过滤条件已落定仍找不到：目标不在这个分类里，放弃
    if (index < 0) { pendingScroll.current = null; return; }
    if (index >= visibleCount) ensureVisible(index);
  }, [items, selected, search, activeTags, filtered, visibleCount, ensureVisible]);
  useGSAP(
    () => {
      const cards = gridRef.current?.querySelectorAll<HTMLElement>("[data-card]");
      if (cards?.length) {
        gsap.from(cards, { autoAlpha: 0, y: 8, duration: 0.28, stagger: 0.02, ease: "power2.out", clearProps: "all" });
      }
    },
    { dependencies: [filtered.length, selected, search, activeTags.join(",")], scope: gridRef },
  );

  const loadInline = async (path: string) => {
    setInlineBusy(true);
    try {
      const snapshot = await fileDirectorySnapshot(path);
      setInlineEntries(snapshot.entries);
    } catch {
      toast.error(t("files.openErr"));
    } finally {
      setInlineBusy(false);
    }
  };
  const enterInline = (path: string) => {
    const next = inlineTrail.slice(0, inlineCursor + 1);
    next.push(path);
    setInlineTrail(next);
    setInlineCursor(next.length - 1);
    setSearch("");
    setActiveTags([]);
    void loadInline(path);
  };
  const gotoInline = (cursor: number) => {
    if (cursor < 0 || cursor >= inlineTrail.length) return;
    setInlineCursor(cursor);
    setSearch("");
    setActiveTags([]);
    void loadInline(inlineTrail[cursor]);
  };
  const leaveInline = () => {
    setInlineTrail([]);
    setInlineCursor(-1);
    setInlineEntries([]);
    setSearch("");
    setActiveTags([]);
  };
  const upInline = () => {
    const current = inlineTrail[inlineCursor];
    if (!current) return;
    const normalized = current.replace(/[\\/]+$/, "");
    const cut = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
    if (cut <= 2) return;
    enterInline(normalized.slice(0, cut));
  };
  const openItem = (item: FileItem) => {
    if (item.type === "folder") {
      enterInline(item.path);
      return;
    }
    void openTarget(item.path, item.type).catch(() => toast.error(t("files.openErr")));
  };

  /* ── 条目拖拽排序 ──
     与栅栏同一套手势语义：单击选中、双击打开、选中后拖动排序（落点竖线）。
     区别是这里不涉及系统拖出（文件页是管理界面，不需要把条目拖到桌面）。 */
  const [dragId, setDragId] = useState<string | null>(null);
  /** 从桌面拖入时鼠标下方的盒子（物理像素换算成 CSS 像素后命中） */
  const [nativeDropBoxId, setNativeDropBoxId] = useState<string | null>(null);
  /** 墙上内部拖拽：正在拖的条目 id 与光标下的盒子 id */
  const [tileDragItem, setTileDragItem] = useState<string | null>(null);
  const [tileDropBoxId, setTileDropBoxId] = useState<string | null>(null);
  /** 拖动中悬停的目标盒子（跨盒移动的落点） */
  const [dropBoxId, setDropBoxId] = useState<string | null>(null);
  /** 悬停够久就展开的那个盒子（放手前的预览） */
  const [expandedBoxId, setExpandedBoxId] = useState<string | null>(null);
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [drop, setDrop] = useState<{ anchorId: string | null; x: number; y: number; h: number } | null>(
    null,
  );

  /**
   * 指针位置 → 插入位 + 竖线几何（相对网格容器）。
   *
   * 只在「同一分类」的卡片之间找落点：moveItemBefore 是分类内重排，
   * 跨分类落点会被 store 拒绝。若不过滤，「全部」视图里把 A 拖到别的分类的
   * 卡片上会显示落点线但松手后毫无变化 —— 比不显示更让人困惑。
   */
  const computeDrop = (cx: number, cy: number, movingCategoryId: string) => {
    const grid = gridRef.current;
    if (!grid || filtered.length === 0) return null;
    const gr = grid.getBoundingClientRect();
    const cards = [...grid.querySelectorAll<HTMLElement>("[data-card]")].filter(
      (c) => c.getAttribute("data-cat") === movingCategoryId,
    );
    if (!cards.length) return null;

    // 找到指针所在行：取垂直距离最近的一行
    let best: HTMLElement | null = null;
    let bestDist = Infinity;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      const dy = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
      if (dy < bestDist) {
        bestDist = dy;
        best = c;
      }
    }
    if (!best) return null;
    const br = best.getBoundingClientRect();

    // 在同一行内按 x 决定插到该卡片前还是后
    const sameRow = cards.filter((c) => {
      const r = c.getBoundingClientRect();
      return Math.abs(r.top - br.top) < r.height / 2;
    });
    let anchor: HTMLElement = best;
    let atEnd = false;
    for (const c of sameRow) {
      const r = c.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right) {
        anchor = c;
        atEnd = cx > r.left + r.width / 2;
        break;
      }
      if (cx > r.right) {
        anchor = c;
        atEnd = true;
      }
    }

    const ar = anchor.getBoundingClientRect();
    const id = anchor.getAttribute(ITEM_ATTR);
    if (!id) return null;

    // anchorId = 插到谁之前；插到行尾时用「下一个」条目作为锚点
    let anchorId: string | null = id;
    let x = (atEnd ? ar.right : ar.left) - gr.left;
    if (atEnd) {
      const idx = cards.indexOf(anchor);
      const next = cards[idx + 1];
      if (next && Math.abs(next.getBoundingClientRect().top - ar.top) < ar.height / 2) {
        anchorId = next.getAttribute(ITEM_ATTR);
        x = next.getBoundingClientRect().left - gr.left;
      } else {
        anchorId = null; // 行尾且无后继 → 移到末尾
      }
    }
    return { anchorId, x, y: ar.top - gr.top, h: ar.height };
  };

  /** 把条目拖进另一个盒子（映射盒既不作为来源也不作为目标） */
  const dropIntoBox = async (ids: string[], targetId: string) => {
    try {
      const before = new Map(useFiles.getState().items.filter(item => ids.includes(item.id)).map(item => [item.id, item.categoryId]));
      const outcome = await moveItemsToBox(ids, targetId);
      // 只改归属的移动可撤销；真的搬了磁盘的（存储盒）不假装能一步撤回
      if (outcome.moved && !outcome.physical) {
        const push = useFileHistory.getState().push;
        const groupId = crypto.randomUUID();
        for (const [itemId, from] of before) {
          if (from === targetId) continue;
          push({ kind: "rebox", itemId, from, to: targetId, groupId, label: categoryLabelOf(targetId) });
        }
      }
      if (!outcome.moved && !outcome.failed) return;
      if (outcome.failed) toast.error(t("files.moveFailed", { count: outcome.failed }));
      if (outcome.moved) toast.success(t("files.movedToBox", { count: outcome.moved, name: categoryLabelOf(targetId) }));
      setPicked([]);
      pickAnchor.current = null;
    } catch (error) {
      toast.error(String(error));
    }
  };

  /** 条目 → 快捷访问目录：文件真的搬过去，条目路径跟着改；网址没有文件可搬 */
  const moveIntoQuickDir = async (ids: string[], dirId: string) => {
    const dir = quickDirs.find((entry) => entry.id === dirId);
    if (!dir) return;
    const targets = items.filter((item) => ids.includes(item.id) && item.type !== "url");
    if (targets.length < ids.length) toast.error(t("files.quickAccessUrl"));
    if (!targets.length) return;
    try {
      const result = await moveFenceEntries(targets.map((item) => item.path), dir.path);
      for (const moved of result.moved) {
        const owner = targets.find((item) => item.path === moved.source);
        if (owner) useFiles.getState().updateItem(owner.id, { path: moved.path });
      }
      if (result.moved.length) toast.success(t("files.quickAccessMoved", { count: result.moved.length, name: dir.name }));
      if (result.failed.length) toast.error(t("files.quickAccessFailed", { count: result.failed.length }));
    } catch (error) {
      toast.error(String(error));
    }
  };

  /** 原生拖进来的文件：只动磁盘，不进库 */
  const movePathsToQuickDir = async (paths: string[], dirId: string) => {
    const dir = quickDirs.find((entry) => entry.id === dirId);
    if (!dir) return;
    try {
      const result = await moveFenceEntries(paths, dir.path);
      if (result.moved.length) toast.success(t("files.quickAccessMoved", { count: result.moved.length, name: dir.name }));
      if (result.failed.length) toast.error(t("files.quickAccessFailed", { count: result.failed.length }));
    } catch (error) {
      toast.error(String(error));
    }
  };

  /** 大文件 / 大文件夹先问一句：收纳是移动，不是复制 */
  const needsMoveConfirm = async (paths: string[]) => {
    const probed = await probePaths(paths).catch(() => []);
    if (probed.some((entry) => entry.kind === "folder")) return true;
    if (collectConfirmMb <= 0) return false;
    const files = probed.filter((entry) => entry.kind === "file").map((entry) => entry.path);
    if (!files.length) return false;
    const metas = await pathMeta(files).catch(() => []);
    return metas.reduce((sum, meta) => sum + (meta.size ?? 0), 0) >= collectConfirmMb * 1024 * 1024;
  };

  /**
   * 收纳 = 把文件真的搬进这个盒子（映射盒搬进它绑定的目录）。
   * 不再是「快捷盒只记引用」：用户要的是资源管理器那种移动。
   */
  const collectIntoBox = async (categoryId: string, paths: string[]) => {
    if (!paths.length) return;
    if (await needsMoveConfirm(paths)) {
      const ok = await confirm({
        title: t("files.collectConfirmTitle"),
        description: t("files.collectConfirmHint"),
        confirmText: t("files.collect"),
      });
      if (!ok) return;
    }
    const destination = await actions.ensureDir(categoryId);
    if (!destination) return;
    try {
      const result = await moveDroppedFiles(categoryId, paths, destination);
      if (result.failed.length) toast.error(t("files.collectFailed", { count: result.failed.length }));
      else toast.success(t("files.collected"));
    } catch (error) {
      toast.error(String(error));
    }
  };

  /**
   * 墙上的盒子只支持拖拽排序：拖过 6px 才算拖动，松手插到目标盒子前面。
   * 不做「把一个盒子放进另一个盒子」—— 收纳盒之间只有顺序关系。
   */
  const startBoxDrag = (e: React.PointerEvent, categoryId: string) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    const sx = e.clientX;
    const sy = e.clientY;
    let active = false;
    let target: string | null = null;
    const cleanup = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
      document.body.style.userSelect = "";
    };
    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        active = true;
        // 只有真的开始拖了才抢指针：按下就 capture 会把后续 click 从按钮上拐走，盒子点不开
        el.setPointerCapture(pointerId);
        document.body.style.userSelect = "none";
        setBoxDragId(categoryId);
      }
      const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(`[${CAT_ATTR}]`);
      const id = hit?.getAttribute(CAT_ATTR) ?? null;
      target = id && id !== categoryId ? id : null;
      setBoxDropBefore(target);
    };
    const onUp = () => {
      if (active) {
        // 拖完紧接着的 click 不该把盒子打开
        suppressBoxOpenUntil.current = Date.now() + 350;
        if (target) useFiles.getState().moveCategoryBefore(categoryId, target);
      }
      setBoxDragId(null);
      setBoxDropBefore(null);
      cleanup();
    };
    const onCancel = () => {
      setBoxDragId(null);
      setBoxDropBefore(null);
      cleanup();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
  };

  const startItemDrag = (e: React.PointerEvent, item: FileItem) => {
    if (e.button !== 0) return;
    // 新的一次按下意味着上一次系统拖拽已经结束：清掉可能卡住的闸门
    dragOutBusy.current = false;
    // 悬停操作按钮上的按下不参与拖拽
    if ((e.target as HTMLElement).closest("button")) return;
    const el = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    const sx = e.clientX;
    const sy = e.clientY;
    let dragging = false;
    let pending: typeof drop = null;
    /** 指针当前压着的目标盒子：手势内自己记账，避免回调闭包读到上一帧的 state */
    let hoverBox: string | null = null;
    /** 指针是否压在「桌面」这个落点上（= 把条目移出所有盒子） */
    let hoverDesk = false;
    /** 指针是否压在快捷访问目录那一行上 */
    let hoverQuick: string | null = null;
    /** 指针压着的另一个散放条目（松手插到它前面） */
    let hoverLoose: string | null = null;

    const cleanup = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
    };

    /** 指针出窗口 = 交给系统 OLE 拖拽（能落到桌面 / 资源管理器），不当成 HTML5 文本 */
    const outsideWindow = (x: number, y: number) =>
      x <= 0 || y <= 0 || x >= window.innerWidth || y >= window.innerHeight;

    const beginDragOut = () => {
      dragOutBusy.current = true;
      const paths = (picked.includes(item.id) ? picked : [item.id])
        .map((id) => items.find((entry) => entry.id === id))
        .filter((entry): entry is FileItem => entry !== undefined && entry.type !== "url")
        .map((entry) => entry.path);
      onCancel();
      if (!paths.length) { dragOutBusy.current = false; return; }
      void dragOut(paths).catch(() => undefined).finally(() => { dragOutBusy.current = false; });
    };

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        dragging = true;
        // 拖动期间全局禁选中：按下拖动不会把名字刷成蓝色选区
        document.body.style.userSelect = "none";
        setDragId(item.id);
        dragGhostPos.current = { x: ev.clientX, y: ev.clientY };
        setDragGhost({ item });
      }
      dragGhostPos.current = { x: ev.clientX, y: ev.clientY };
      if (dragGhostRef.current) {
        dragGhostRef.current.style.transform = `translate3d(${ev.clientX + 14}px, ${ev.clientY + 14}px, 0)`;
      }
      if (outsideWindow(ev.clientX, ev.clientY)) {
        beginDragOut();
        return;
      }
      // 先看指针下面是不是「其他盒子」「桌面」或「快捷访问目录」，其次才是盒内重排
      const hit = document
        .elementFromPoint(ev.clientX, ev.clientY);
      const boxHit = hit?.closest<HTMLElement>("[data-drop-box]");
      const looseHit = hit?.closest<HTMLElement>("[data-desktop-item]");
      const deskHit = hit?.closest<HTMLElement>("[data-drop-desktop]");
      const quickHit = hit?.closest<HTMLElement>("[data-drop-quick]");
      const boxId = boxHit?.dataset.dropBox ?? null;
      const looseId = looseHit?.getAttribute("data-desktop-item") ?? null;
      hoverLoose = looseId && looseId !== item.id && !item.categoryId ? looseId : null;
      hoverDesk = Boolean(deskHit) && !hoverLoose;
      hoverQuick = quickHit?.dataset.dropQuick ?? null;
      hoverBox = boxId;
      setDropBoxId(boxId);
      setLooseDropId(hoverLoose);
      setDeskTarget(hoverDesk);
      setQuickDropId(hoverQuick);
      // 悬停片刻就把那个盒子「打开」给你看一眼：松手仍然只是移入，不改当前盒子
      if (expandTimer.current) clearTimeout(expandTimer.current);
      expandTimer.current = null;
      if (!boxId) {
        setExpandedBoxId(null);
      } else if (boxId !== expandedBoxId) {
        expandTimer.current = setTimeout(() => setExpandedBoxId(boxId), 450);
      }
      if (boxId || hoverDesk || hoverQuick || hoverLoose) {
        pending = null;
        setDrop(null);
        return;
      }
      pending = computeDrop(ev.clientX, ev.clientY, item.categoryId);
      setDrop(pending);
    };

    const onUp = () => {
      const targetBox = hoverBox;
      const toDesk = hoverDesk;
      const toQuick = hoverQuick;
      const toLoose = hoverLoose;
      const ids = picked.includes(item.id) ? picked : [item.id];
      if (dragging && toQuick) {
        // 拖到快捷访问目录 = 把文件真的搬进那个磁盘目录，条目路径跟着改
        void moveIntoQuickDir(ids, toQuick);
      } else if (dragging && toLoose) {
        // 拖到另一个散放条目上 = 在桌面上排序
        useFiles.getState().moveItemBefore(item.id, toLoose);
      } else if (dragging && toDesk) {
        // 拖到桌面 = 直接散放在墙上，不包一层盒子
        void moveToDesktop(ids);
      } else if (dragging && targetBox) {
        void dropIntoBox(ids, targetBox);
      } else if (dragging && pending) {
        moveItemBefore(item.id, pending.anchorId);
      }
      onCancel();
    };

    const onCancel = () => {
      pending = null;
      hoverBox = null;
      hoverDesk = false;
      hoverQuick = null;
      hoverLoose = null;
      setLooseDropId(null);
      if (expandTimer.current) clearTimeout(expandTimer.current);
      expandTimer.current = null;
      setDrop(null);
      setDragId(null);
      setDragGhost(null);
      setDropBoxId(null);
      setDeskTarget(false);
      setQuickDropId(null);
      setExpandedBoxId(null);
      cleanup();
    };

    el.setPointerCapture(pointerId);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
  };

  // 删除统一走 actions（本地文件进回收站，网址仅移出列表）
  const onDeleteItem = async (item: FileItem) => {
    /*
     * 存储盒里的条目有两个东西：列表里的记录、以及 stash 里那份副本。
     * 删除时把选择权交回用户，默认只移出列表（不动文件）——
     * 确认框只问「要不要连副本一起删」，不问就什么都不删。
     */
    const root = useSettings.getState().dataDir;
    const normalized = item.path.replace(/\\/g, "/").toLowerCase();
    const stashed = !!root && normalized.startsWith(root.replace(/\\/g, "/").toLowerCase() + "/stash/");
    if (stashed) {
      const dropCopy = await confirm({ title: t("files.stashDeleteAsk"), danger: true });
      if (dropCopy) {
        await invoke("stash_delete", { path: item.path }).catch((error) => toast.error(String(error)));
      }
    }
    void actions.remove(item);
  };

  const updateDesktop = async (operation: () => Promise<void>, total = 1) => {
    if (desktopLock.current || !filesHydrated || !fencesHydrated) return;
    desktopLock.current = true;
    setDesktopBusy(true);
    setDesktopProgress({ done: 0, total });
    try { await operation(); }
    catch (error) { toast.error(String(error)); }
    finally {
      desktopLock.current = false;
      if (mounted.current) setDesktopBusy(false);
    }
  };

  /**
   * 桌面栅格是全开或全关 —— 不做「这个盒子上桌面、那个不上」的精细管理。
   * 逐个开窗由 desktop-actions 串行处理，进度写进状态行。
   */
  const toggleAllFences = (visible: boolean) => updateDesktop(async () => {
    const outcome = await setAllFencesOnDesktop(visible, (done, total) => {
      if (mounted.current) setDesktopProgress({ done, total });
    });
    if (outcome.failed.length) {
      throw new Error(t("files.desktopPartial", { count: outcome.done, failed: outcome.failed.length }));
    }
  }, categories.length);

  // 右键菜单：只在这个页面出现的两项（全局菜单只剩搜索与设置）
  useAppMenuItems([
    { id: "files.new-box", label: t("files.newBox"), icon: FolderPlus, onSelect: () => setNewBox({ name: "", kind: "shortcut" }) },
    {
      id: "files.desktop-grid",
      label: desktopShown ? t("files.desktopGridOff") : t("files.desktopGridOn"),
      icon: Monitor,
      onSelect: () => void toggleAllFences(!desktopShown),
    },
  ]);

  /** 新建盒子：一个弹框里填名字 + 选种类 + 选配色，不再分两步 */
  const [newBox, setNewBox] = useState<null | { name: string; kind: CategoryKind; move?: string[]; paths?: string[]; dir?: string }>(null);
  const setCategoryMapping = useFiles((s) => s.setCategoryMapping);

  /** 映射盒换目录：重挑文件夹；名字保持用户起的那个 */
  const changeMapping = async (catId: string) => {
    const picked = await pickFolder();
    if (!picked) return;
    setCategoryMapping(catId, picked);
  };

  /** 一步建盒：名字 + 种类 + 配色都在同一个弹框里；映射盒紧接着挑目录 */
  const commitNewBox = async () => {
    if (!newBox) return;
    const clean = newBox.name.trim();
    if (!clean) return;
    if (categories.some((c) => !c.parentId && c.name.toLowerCase() === clean.toLowerCase())) {
      await alert({ title: t("files.dupCategory") });
      return;
    }
    const kind = newBox.kind;
    const droppedPaths = newBox.paths ?? [];
    const id = addCategory(clean, undefined, kind);
    if (newBox.move?.length) {
      // 用选中条目建的盒子：建好就把它们搬进去（不嵌套：选中的是条目，不是盒子）
      const patch = useFiles.getState().updateItem;
      for (const itemId of newBox.move) patch(itemId, { categoryId: id });
      setPicked([]);
      pickAnchor.current = null;
    }
    setNewBox(null);
    if (kind === "mapped") {
      const dir = newBox.dir;
      if (!dir) return;
      setCategoryMapping(id, dir);
      // 拖入的文件直接搬进刚绑定的目录；扫描后自然出现在盒子里
      if (droppedPaths.length) {
        try {
          await moveFenceEntries(droppedPaths, dir);
          toast.success(t("files.collected"));
        } catch (error) {
          toast.error(String(error));
        }
      }
      return;
    }
    if (droppedPaths.length) {
      // 拖到墙上建的盒子：文件搬进去，然后直接打开这个盒子
      await collectIntoBox(id, droppedPaths);
      setSelected(id);
      setOpenBoxId(id);
      return;
    }
    setOpenBoxId(null);
  };

  /** 分类改名（右键菜单入口）：prompt 式。分类 chips 收起来后没有内联输入框可用。 */
  const renameCategoryPrompt = async (catId: string) => {
    const cat = categories.find((c) => c.id === catId);
    if (!cat) return;
    const entered = await prompt({ title: t("files.renameCategory"), initial: cat.name });
    const clean = entered?.trim();
    if (!clean || clean === cat.name) return;
    const dup = categories.some((c) => c.id !== catId && c.name.toLowerCase() === clean.toLowerCase());
    if (dup) {
      await alert({ title: t("files.dupCategory") });
      return;
    }
    renameCategory(catId, clean);
  };

  /** 新建映射盒时先选文件夹：名字没填过就跟着文件夹名走，之后还能改 */
  const pickMappedDir = async () => {
    const picked = await pickFolder();
    if (!picked || !newBox) return;
    setNewBox({ ...newBox, dir: picked, name: newBox.name.trim() ? newBox.name : nameFromPath(picked) });
  };

  const onAddCategory = () => {
    setNewBox({ name: "", kind: "shortcut" });
  };

  /**
   * 解散收纳盒。
   *
   * 映射盒 = 解除映射：盒子与条目消失，磁盘文件一个都不动；
   * 其他盒 = 条目散到默认分类，盒子删除。语义在 dissolve.ts 里，这里只负责确认与关栅栏。
   */
  const onDeleteCategory = async (catId: string) => {
    const cat = categories.find((c) => c.id === catId);
    if (!cat) return;
    if (categories.some((c) => c.parentId === catId)) {
      await alert({ title: t("files.categoryHasChildren") });
      return;
    }
    const kind = categoryKind(cat);
    const count = items.filter((i) => i.categoryId === catId).length;
    const ok = await confirm({
      title: t("files.dissolveConfirm", { name: cat.name }),
      description: kind === "mapped"
        ? t("files.dissolveMappedHint", { count })
        : t("files.dissolveHint", { count }),
      danger: true,
      confirmText: t("files.dissolve"),
    });
    if (!ok) return;
    await updateDesktop(async () => {
      restored.current.add(catId);
      await setFenceOnDesktop(catId, false);
      const outcome = dissolveBox(catId);
      if (!outcome.ok) {
        throw new Error(outcome.reason === "has-children" ? t("files.categoryHasChildren") : t("files.categoryMissing"));
      }
      if (mounted.current) {
        setSelected(null);
        setOpenBoxId(null);
      }
    });
  };

  /** 顶级分类 / 子分类查询（单层：只查直接子级） */
  const topCategories = useMemo(() => categories.filter((c) => !c.parentId), [categories]);
  const childrenOf = useCallback(
    (id: string) => categories.filter((c) => c.parentId === id),
    [categories],
  );
  /** 该分类的条目数。子分类不并入父分类计数，避免「父分类里其实没东西」的误解 */
  const countIn = useCallback(
    (id: string) => items.filter((i) => i.categoryId === id).length,
    [items],
  );

  /**
   * 收纳盒视图按「顶级分类 + 它的子分类」铺开。子分类跟在父盒子后面，
   * 名字用 categoryLabelOf 带上父名前缀，避免两个同名子分类分不清。
   */
  /** 拖到桌面：条目直接散放在墙上（categoryId 置空），不建「桌面」盒。 */
  const moveToDesktop = (ids: string[]) => {
    const patch = useFiles.getState().updateItem;
    for (const id of ids) patch(id, { categoryId: "" });
    toast.success(t("files.movedToDesktop", { count: ids.length }));
  };
  const looseItems = useMemo(
    () => items.filter((item) => !categories.some((category) => category.id === item.categoryId)),
    [items, categories],
  );
  const boxCategories = useMemo(
    () => topCategories.flatMap((cat) => [cat, ...childrenOf(cat.id)]),
    [topCategories, childrenOf],
  );
  const openBox = openBoxId ? categories.find((category) => category.id === openBoxId) ?? null : null;
  /** 当前打开盒子的种类：映射盒只读（内容归磁盘目录管） */
  const openKind: CategoryKind = openBox ? categoryKind(openBox) : "shortcut";
  /** 文件页浮层与栅栏/快速面板共用同一份外观参数 */
  const openLook = boxAppearance(openBox?.appearance);
  const inlinePath = inlineCursor >= 0 ? inlineTrail[inlineCursor] ?? null : null;
  const inlineItems = useMemo<FileItem[]>(() => inlineEntries.map((entry) => ({
    id: `inline:${entry.path}`,
    categoryId: openBoxId ?? "",
    type: entry.kind,
    title: entry.name,
    path: entry.path,
    tags: [],
    createdAt: 0,
  })), [inlineEntries, openBoxId]);
  const visibleBoxItems = useMemo(() => {
    if (!inlinePath) return filtered;
    const q = search.trim().toLowerCase();
    return q ? inlineItems.filter((item) => item.title.toLowerCase().includes(q) || item.path.toLowerCase().includes(q)) : inlineItems;
  }, [inlinePath, inlineItems, filtered, search]);
  /** 可作为跨盒落点的其他盒子：映射盒的内容归磁盘目录管，不接收条目 */
  const otherBoxes = useMemo(
    () => categories.filter((c) => c.id !== openBoxId && categoryKind(c) !== "mapped"),
    [categories, openBoxId],
  );

    const openCategoryBox = (categoryId: string, tile?: HTMLElement | null) => {
    // 记下被点的方块在视口里的位置：浮层从这个点长出来（iOS 文件夹那种观感）
    const rect = tile?.getBoundingClientRect();
    boxOrigin.current = rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null;
    setSelected(categoryId);
    setOpenBoxId(categoryId);
    setSearch("");
    setActiveTags([]);
    setPicked([]);
    setAppearanceOpen(false);
    setInlineTrail([]);
    setInlineCursor(-1);
    setInlineEntries([]);
    pickAnchor.current = null;
  };
  const closeBox = useCallback(() => {
    setOpenBoxId(null);
    setSelected(null);
    setAppearanceOpen(false);
    setInlineTrail([]);
    setInlineCursor(-1);
    setInlineEntries([]);
  }, []);

  /** 浮层挂上之后把缩放原点对到被点的方块；量不到就退回居中缩放 */
  useEffect(() => {
    if (!openBoxId) { setPanelOrigin("50% 50%"); return; }
    const rect = panelRef.current?.getBoundingClientRect();
    const origin = boxOrigin.current;
    if (!rect || !origin) return;
    setPanelOrigin(
      `${Math.round(origin.x + origin.w / 2 - rect.left)}px ${Math.round(origin.y + origin.h / 2 - rect.top)}px`,
    );
  }, [openBoxId]);

  /** Esc 收起盒子浮层（和背景点击同一个出口） */
  useEffect(() => {
    if (!openBoxId) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeBox(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openBoxId, closeBox]);
;

  /** 新建子分类。单层约束：只允许挂在顶级分类下 */


  const openMenu = usePopupMenu({
    actions,
    onCategoryRename: (id) => void renameCategoryPrompt(id),
    onCategoryDelete: (id) => void onDeleteCategory(id),
    onChangeMapping: (id) => void changeMapping(id),
    onCategoryAdd: () => onAddCategory(),
  });

  /** 条目网格右键：命中条目 → 条目菜单；否则空白菜单 */
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = (e.target as HTMLElement).closest(`[${ITEM_ATTR}]`);
    const id = el?.getAttribute(ITEM_ATTR) ?? null;
    const item = id ? items.find((i) => i.id === id) : undefined;
    void openMenu(
      item ? { kind: "item", item } : { kind: "blank", categoryId: selected },
      { x: e.clientX, y: e.clientY },
    );
  };

  /** 分类 rail 右键：命中 chip → 分类菜单；否则空白菜单 */
  const onRailContextMenu = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest(`[${CAT_ATTR}]`);
    const id = el?.getAttribute(CAT_ATTR) ?? null;
    if (!id) return; // chip 之外的空白不接管，避免与页面其他区域冲突
    e.preventDefault();
    void openMenu({ kind: "category", categoryId: id }, { x: e.clientX, y: e.clientY });
  };

  /**
   * 卡片点击：默认单选；Ctrl/Cmd 挑、Shift 连选、Alt 减选。
   * 映射盒的内容归磁盘目录管，多选建盒对它没有意义，直接退化成单选。
   */
  const onPickItem = (event: React.MouseEvent, item: FileItem) => {
    if (openKind === "mapped") {
      setSelectedItemId(item.id);
      return;
    }
    const toggle = event.ctrlKey || event.metaKey;
    const range = event.shiftKey;
    const subtract = event.altKey;
    const order = filtered.slice(0, visibleCount).map((entry) => entry.id);
    if (range && pickAnchor.current) {
      const from = order.indexOf(pickAnchor.current);
      const to = order.indexOf(item.id);
      if (from >= 0 && to >= 0) {
        const span = order.slice(Math.min(from, to), Math.max(from, to) + 1);
        setPicked((prev) => (subtract ? prev.filter((id) => !span.includes(id)) : [...new Set([...prev, ...span])]));
        setSelectedItemId(item.id);
        return;
      }
    }
    if (subtract) {
      setPicked((prev) => prev.filter((id) => id !== item.id));
      return;
    }
    if (toggle) {
      setPicked((prev) => (prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]));
      pickAnchor.current = item.id;
      setSelectedItemId(item.id);
      return;
    }
    setPicked([]);
    pickAnchor.current = item.id;
    setSelectedItemId(item.id);
  };

  return (
    <div className="relative h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6 pb-10">
        {/* 标题视觉上交给侧栏，这里只留一个读屏可见的 h1 */}
        <h1 className="sr-only">{t("files.title")}</h1>
        {/* ── 状态行 + 工具栏：这一行只放状态与操作 ── */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="text-[11px] text-muted-foreground" role="status" aria-live="polite">
                {importing
                  ? t("files.dropWorking")
                  : dragging
                    ? t("files.dropReady")
                    : desktopBusy
                      ? t("files.desktopUpdating", desktopProgress)
                      : t("files.inventory", { boxes: topCategories.length, items: items.length })}
              </p>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("files.kindHelpTitle")}
                    className="grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <CircleHelp className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start" className="max-w-sm p-3">
                  <div className="space-y-1.5">
                    <p className="font-medium">{t("files.kindHelpTitle")}</p>
                    {(["shortcut", "storage", "mapped"] as const).map((kind) => (
                      <div key={kind} className="flex items-start gap-2">
                        <span
                          className="mt-1 size-2 shrink-0 rounded-full"
                          style={{ background: `var(--${BOX_KIND_COLOR[kind]})` }}
                        />
                        <span className="min-w-0">
                          <span className="font-medium">{t(`files.kind.${kind}`)}</span>
                          <span className="text-background/75"> · {t(`files.kindHint.${kind}`)}</span>
                        </span>
                      </div>
                    ))}
                    <p className="border-t border-background/20 pt-1.5 text-background/75">
                      {t("files.kindHelpDrop")}
                    </p>
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex w-44 items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 transition-shadow focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/25 sm:w-56">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("files.searchPlaceholder")}
                aria-label={t("files.searchPlaceholder")}
                className="w-full min-w-0 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
              />
              {search && (
                <button type="button" aria-label={t("files.boxSearchClear")} onClick={() => setSearch("")} className="shrink-0 text-muted-foreground hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5" role="group" aria-label={t("files.boxSize")}>
              {([
                { size: "sm" as const, label: t("files.boxSizeSmall") },
                { size: "md" as const, label: t("files.boxSizeMedium") },
                { size: "lg" as const, label: t("files.boxSizeLarge") },
              ]).map((option) => (
                <button
                  key={option.size}
                  type="button"
                  aria-pressed={boxTileSize === option.size}
                  onClick={() => setBoxTileSize(option.size)}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-[11px] transition-colors",
                    boxTileSize === option.size ? "bg-brand/10 text-brand" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {/* 栅栏整体开关：全开或全关，不做单盒精细管理 */}
            <label
              className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-[11px] text-muted-foreground"
              title={t("files.desktopGridHint")}
            >
              <Switch
                size="sm"
                checked={desktopShown}
                disabled={desktopBusy || categories.length === 0}
                onCheckedChange={(next) => void toggleAllFences(next === true)}
                aria-label={t("files.desktopGrid")}
              />
              {t("files.desktopGrid")}
            </label>
            <button
              type="button"
              onClick={() => setQuickOpen(true)}
              title={t("files.quickAccess")}
              aria-label={t("files.quickAccess")}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <FolderSearch className="size-4" />
              {t("files.quickAccess")}
            </button>
            <button
              type="button"
              onClick={() => onAddCategory()}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-[11px] text-foreground transition-colors hover:bg-muted"
            >
              <Plus className="size-3.5" />
              {t("files.newBox")}
            </button>
            <button
              type="button"
              onClick={() => setModal({ open: true, editing: null })}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-[11px] text-foreground transition-colors hover:bg-muted"
            >
              <Plus className="size-3.5" />
              {t("files.addItem")}
            </button>
          </div>
        </div>

        {selected && <CategoryMappingBar key={selected} categoryId={selected} />}

        {/* ── 收纳盒视图：分类 = 玻璃方块，点开原位放大成浮层 ── */}
        {!openBox && (
          <div
            className={cn(
              "grid gap-x-5 gap-y-6",
              boxTileSize === "sm"
                ? "grid-cols-[repeat(auto-fill,minmax(84px,1fr))]"
                : boxTileSize === "lg"
                  ? "grid-cols-[repeat(auto-fill,minmax(150px,1fr))]"
                  : "grid-cols-[repeat(auto-fill,minmax(96px,1fr))]",
            )}
            data-files-boxes
            onContextMenu={onRailContextMenu}
            onMouseDown={(event) => {
              // 点空白处取消选中（方块本身带 data-card）
              if (!(event.target as HTMLElement).closest("[data-card]")) setSelectedItemId(null);
            }}
            onDragOver={event => {
              if (!tileDragItem) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setTileDropBoxId(null);
            }}
            onDrop={event => {
              if (!tileDragItem) return;
              event.preventDefault();
              const target = event.target as HTMLElement;
              // 落在方块上由方块自己处理；落在空白处 = 回到桌面
              if (target.closest("[data-box-card]")) {
                setTileDragItem(null); setTileDropBoxId(null);
                return;
              }
              moveToDesktop([tileDragItem]);
              setTileDragItem(null);
              setTileDropBoxId(null);
            }}
          >
            {boxCategories.map((category) => {
              const count = countIn(category.id);
              const kind = categoryKind(category);
              const accent = `--${boxAccent(category)}`;
              const preview = items.filter((item) => item.categoryId === category.id).slice(0, 6);
              return (
                <div key={category.id} className={cn("group relative w-full", boxDragId === category.id && "opacity-45")}
                  data-drop-box={category.id}
                  onPointerDown={(event) => { if (!category.parentId) startBoxDrag(event, category.id); }}
                  onDragOver={event => {
                    if (!tileDragItem || kind === "mapped") return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = "move";
                    setTileDropBoxId(category.id);
                  }}
                  onDragLeave={() => setTileDropBoxId(current => current === category.id ? null : current)}
                  onDrop={event => {
                    if (!tileDragItem || kind === "mapped") return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (tileDragItem) void dropIntoBox([tileDragItem], category.id);
                    setTileDragItem(null);
                    setTileDropBoxId(null);
                  }}
                >
                  {/* 盒子排序落点：一根插入线，不碰盒子自己的描边 */}
                  {boxDragId && boxDropBefore === category.id && (
                    <span aria-hidden className="pointer-events-none absolute inset-y-0 -left-2.5 z-10 w-0.5 rounded-full bg-brand" />
                  )}
                  {/* 排序落点：拖拽中不画任何边框，只把被拖的盒子淡下去 */}
                  <motion.button
                    type="button"
                    data-box-card
                    {...{ [CAT_ATTR]: category.id }}
                    onClick={(event) => { if (Date.now() < suppressBoxOpenUntil.current) return; openCategoryBox(category.id, event.currentTarget); }}
                    whileHover={{ y: boxDragId ? 0 : -2 }}
                    whileTap={{ scale: boxDragId ? 1 : 0.97 }}
                    transition={{ type: "spring", stiffness: 420, damping: 30 }}
                    className="flex w-full select-none flex-col items-center gap-1.5"
                    title={`${categoryLabelOf(category.id)} · ${t(`files.kind.${kind}`)}`}
                  >
                  {/* 盒面只有一圈品类色描边：颜色即种类，其余一律中性玻璃 */}
                  <span
                    data-box-preview
                    className="relative grid aspect-square w-full grid-cols-3 grid-rows-3 place-items-center gap-1.5 rounded-[18px] border p-2.5"
                    style={{
                      borderColor: `var(${accent})`,
                      background: (nativeDropBoxId === category.id || tileDropBoxId === category.id || dropBoxId === category.id)
                        ? "color-mix(in oklch, var(--brand) 22%, var(--card))"
                        : "color-mix(in oklch, var(--card) 80%, transparent)",
                      boxShadow: "var(--pr-shadow-2), inset 0 1px 0 var(--glass-edge)",
                      backdropFilter: "blur(var(--pr-glass-blur)) saturate(var(--pr-glass-saturate))",
                    }}
                    aria-hidden="true"
                  >
                    {preview.map((item) => (
                        <span key={item.id} className="grid place-items-center"
                          draggable
                          data-tile-item={item.id}
                          onClick={event => event.stopPropagation()}
                          onDragStart={event => {
                            event.stopPropagation();
                            setTileDragItem(item.id);
                            event.dataTransfer.effectAllowed = "move";
                            // 自定义 MIME，不写 text/plain：拖出窗口时资源管理器会把那段文字存成 .txt
                            event.dataTransfer.setData("application/x-nimbus-item", item.id);
                          }}
                          onDragEnd={() => { setTileDragItem(null); setTileDropBoxId(null); }}
                          title={item.title}>
                          <ItemIcon type={item.type} path={item.path} iconUrl={item.iconUrl} size={previewIconSize} />
                        </span>
                      ))}
                    {category.groupColor && (
                      <span
                        data-box-group
                        aria-hidden="true"
                        title={t("files.appearanceGroup")}
                        className="absolute left-1.5 top-1.5 size-2.5 rounded-full border border-white/80 shadow-sm"
                        style={{ background: category.groupColor }}
                      />
                    )}
                  </span>
                  {/* 数量徽标：0 不显示，避免空盒子也挂个 0；中性色，不跟品类色抢 */}
                  {count > 0 && (
                    <span data-box-badge className="absolute -left-1 -top-1 min-w-5 rounded-full border border-border bg-card px-1.5 text-center text-[10px] leading-5 font-medium text-foreground tabular-nums">
                      {count}
                    </span>
                  )}
                  <span className="mt-0.5 line-clamp-2 w-full break-all text-center text-[12px] leading-tight text-foreground">
                    {categoryLabelOf(category.id)}
                  </span>
                  </motion.button>
                  {/* 悬停才出现的「⋯」：分类 chips 在收纳盒视图里收起来了，
                      右键菜单不该是唯一入口 */}
                  <button
                    type="button"
                    data-box-menu
                    aria-label={t("files.boxMenu")}
                    title={t("files.boxMenu")}
                    onClick={(event) => {
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      void openMenu(
                        { kind: "category", categoryId: category.id },
                        { x: rect.left, y: rect.bottom + 4 },
                      );
                    }}
                    className="absolute -right-1 -top-1 z-10 grid size-5 place-items-center rounded-full border border-border bg-card text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <MoreHorizontal className="size-3" />
                  </button>
                </div>
              );
            })}
            {/* 桌面上散放的条目：和盒子同尺寸、排在最末尾，不再单独分一块 */}
            {looseItems.map((item) => (
              <div key={item.id} className="group relative w-full" data-drop-desktop>
                {looseDropId === item.id && (
                  <span aria-hidden className="pointer-events-none absolute inset-y-0 -left-2.5 z-10 w-0.5 rounded-full bg-brand" />
                )}
                <div
                  data-card
                  data-desktop-item={item.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selectedItemId === item.id}
                  onClick={() => setSelectedItemId(item.id)}
                  onPointerDown={(event) => startItemDrag(event, item)}
                  onDoubleClick={() => openItem(item)}
                  onKeyDown={(event) => { if (event.key === "Enter") openItem(item); }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setSelectedItemId(item.id);
                    void openMenu({ kind: "item", item }, { x: event.clientX, y: event.clientY });
                  }}
                  title={t("files.dblclickHint")}
                  className={cn(
                    "flex w-full cursor-pointer select-none flex-col items-center gap-1.5 rounded-xl p-1.5 transition-colors",
                    selectedItemId === item.id && "bg-brand/10",
                    looseDropId === item.id && "bg-brand/20",
                  )}
                >
                  <span className="grid aspect-square w-full place-items-center rounded-lg transition-colors group-hover:bg-card/40">
                    <ItemIcon type={item.type} path={item.path} iconUrl={item.iconUrl} size={tileIconSize} />
                  </span>
                  <span className="mt-0.5 line-clamp-2 w-full break-all text-center text-[12px] leading-tight text-foreground">
                    {item.title}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── 盒子浮层的背景：模糊 + 变暗，点它收起（iOS 点空白关闭） ── */}
        {openBox && (
          <motion.div
            data-box-backdrop
            aria-hidden
            onClick={closeBox}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-40 bg-black/35 backdrop-blur-sm"
          />
        )}

        {/* ── 盒子浮层：点开方块后，内容在这里从方块位置长出来（iOS 文件夹观感） ── */}
        <motion.div
          ref={panelRef}
          data-box-panel={openBox ? "" : undefined}
          initial={openBox ? { opacity: 0.7, scale: 0.9 } : false}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 28 }}
          style={openBox ? {
            transformOrigin: panelOrigin,
            borderColor: `var(--${boxAccent(openBox)})`,
            borderRadius: openLook.radius + 8,
            background: `color-mix(in oklch, var(--card) ${Math.round(openLook.backgroundAlpha * 100)}%, transparent)`,
            boxShadow: "var(--pr-shadow-3)",
            backdropFilter: "blur(var(--pr-glass-blur)) saturate(var(--pr-glass-saturate))",
          } : undefined}
          className={cn(
            openBox
              ? "fixed inset-0 z-50 m-auto flex h-fit max-h-[86vh] w-[min(760px,92vw)] flex-col gap-3 overflow-y-auto rounded-3xl border p-5"
              : "contents",
          )}
        >
          {openBox && (
            <header className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <button
                type="button"
                onClick={closeBox}
                aria-label={t("files.boxBack")}
                title={t("files.boxBack")}
                className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <ArrowLeft className="size-4" />
              </button>
              <span className="min-w-0 shrink truncate text-[15px] font-semibold leading-tight">{categoryLabelOf(openBox.id)}</span>
              {/* 信息层：条目数与种类都按次要文字排，不各占一个胶囊 */}
              <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="tabular-nums">{t("files.boxCount", { count: countIn(openBox.id) })}</span>
                <span aria-hidden>·</span>
                <span data-box-kind-label title={t(`files.kindHint.${openKind}`)} className="flex items-center gap-1">
                  <span className="size-1.5 rounded-full" style={{ background: `var(--${boxAccent(openBox)})` }} />
                  {t(`files.kind.${openKind}`)}
                </span>
              </span>
              {inlinePath && (
                <div className="order-last flex w-full min-w-0 items-center gap-0.5" data-inline-nav>
                  <button type="button" disabled={inlineCursor <= 0} onClick={() => gotoInline(inlineCursor - 1)}
                    aria-label="Back" title="Back"
                    className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30">
                    <ChevronLeft className="size-3.5" />
                  </button>
                  <button type="button" disabled={inlineCursor >= inlineTrail.length - 1} onClick={() => gotoInline(inlineCursor + 1)}
                    aria-label="Forward" title="Forward"
                    className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30">
                    <ChevronRight className="size-3.5" />
                  </button>
                  <button type="button" onClick={upInline} aria-label="Up" title="Up"
                    className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
                    <ArrowUp className="size-3.5" />
                  </button>
                  <button type="button" onClick={leaveInline}
                    className="ml-1 min-w-0 truncate rounded-md bg-muted px-2 py-0.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
                    title={inlinePath}>
                    {inlinePath.replace(/\\/g, " / ")}
                  </button>
                  {inlineBusy && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
                </div>
              )}
              {/* 工具层：设置、添加、收起一组，靠右 */}
              <div className="ml-auto flex items-center gap-1">
                {/* 视图切换放在工具区最前：图标 / 列表一眼可切 */}
                <div className="flex items-center rounded-lg border border-border p-0.5">
                  <button
                    type="button"
                    aria-pressed={openLook.view === "icons"}
                    title={t("files.appearanceIcons")}
                    aria-label={t("files.appearanceIcons")}
                    onClick={() => setCategoryAppearance(openBox.id, { view: "icons" })}
                    className={cn(
                      "grid size-6 place-items-center rounded-md transition-colors",
                      openLook.view === "icons" ? "bg-brand/10 text-brand" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <LayoutGrid className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-pressed={openLook.view === "list"}
                    title={t("files.appearanceList")}
                    aria-label={t("files.appearanceList")}
                    onClick={() => setCategoryAppearance(openBox.id, { view: "list" })}
                    className={cn(
                      "grid size-6 place-items-center rounded-md transition-colors",
                      openLook.view === "list" ? "bg-brand/10 text-brand" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <List className="size-3.5" />
                  </button>
                </div>
                <div className="relative">
                  <button
                    type="button"
                    aria-expanded={appearanceOpen}
                    title={t("files.appearanceTitle")}
                    onClick={() => setAppearanceOpen((open) => !open)}
                    className={cn(
                      "grid size-7 place-items-center rounded-lg border transition-colors",
                      appearanceOpen ? "border-brand bg-brand/10 text-brand" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Settings className="size-3.5" />
                  </button>
                  {appearanceOpen && createPortal(
                    <div
                      className="fixed inset-0 z-[60] grid place-items-center bg-background/50 p-4"
                      role="dialog" aria-modal="true" aria-label={t("files.appearanceTitle")}
                      onClick={() => setAppearanceOpen(false)}
                    >
                      <div onClick={event => event.stopPropagation()}>
                        <BoxAppearancePanel
                          category={openBox}
                          onChange={(patch) => setCategoryAppearance(openBox.id, patch)}
                          onClose={() => setAppearanceOpen(false)}
                          onMerge={openBox.groupColor ? () => {
                            void openFenceGroup(openBox.groupColor!).catch((error) => toast.error(String(error)));
                          } : undefined}
                          className="max-h-[calc(100dvh-2rem)] w-[320px] overflow-y-auto shadow-2xl"
                        />
                      </div>
                    </div>,
                    document.body,
                  )}
                </div>
                {openKind !== "mapped" && (
                  <button
                    type="button"
                    onClick={() => setModal({ open: true, editing: null })}
                    className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-muted"
                  >
                    <Plus className="size-3" />
                    {t("files.addItemToBox")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={closeBox}
                  aria-label={t("files.boxClose")}
                  className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>
            </header>
          )}

        {/* ── 条目网格（右键菜单在独立浮窗渲染，可溢出窗口边界） ── */}
        {openBox && picked.length > 0 && (
          <div data-picked-bar className="flex flex-wrap items-center gap-2 rounded-xl border border-brand/40 bg-brand/5 px-3 py-2 text-[12px]">
            <span className="font-medium">{t("files.pickedCount", { count: picked.length })}</span>
            <span className="hidden text-muted-foreground sm:inline">{t("files.pickedHint")}</span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => setNewBox({
                name: "",
                kind: "shortcut",
                move: picked,
              })}
              className="rounded-lg bg-brand px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-brand-strong"
            >
              {t("files.newBoxFromPicked")}
            </button>
            <button
              type="button"
              onClick={() => { setPicked([]); pickAnchor.current = null; }}
              className="rounded-lg px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted"
            >
              {t("files.clearPicked")}
            </button>
          </div>
        )}

        {openBox && openKind === "mapped" && (
          <p className="rounded-lg border border-border/60 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
            {t("files.mappedReadOnly")}
          </p>
        )}

        {openBox && <div
          ref={gridRef}
          onContextMenu={onContextMenu}
          onMouseDown={(e) => {
            // 点空白处取消选中（卡片带 data-card 标记）
            if (!(e.target as HTMLElement).closest("[data-card]")) setSelectedItemId(null);
          }}
          className={cn(
            "relative grid min-h-24 gap-2.5",
            openLook.view === "list"
              ? "grid-cols-1 items-start"
              : "grid-cols-[repeat(auto-fill,minmax(150px,1fr))]",
          )}
          style={{ fontFamily: boxFontFamily(openLook.fontFamily) || undefined }}
        >
            {visibleBoxItems.slice(0, inlinePath ? visibleBoxItems.length : visibleCount).map((item) => (
              <div
                key={item.id}
                {...{ [ITEM_ATTR]: item.id }}
                data-card
                data-cat={item.categoryId}
                onPointerDown={(e) => { if (openKind !== "mapped") startItemDrag(e, item); }}
                onClick={(event) => onPickItem(event, item)}
                onDoubleClick={() => openItem(item)}
                title={t("files.dblclickHint")}
                className={cn(
                  "group relative flex cursor-pointer select-none border bg-card shadow-[var(--pr-shadow-1)] transition-all duration-150 hover:shadow-[var(--pr-shadow-2)]",
                  openLook.view === "list"
                    ? "items-center gap-2 rounded-lg border-border/70 bg-card/60 px-2.5 py-1.5"
                    : "flex-col rounded-xl border-border p-3 hover:-translate-y-0.5",
                  selectedItemId === item.id ? "border-brand ring-1 ring-brand/40" : openLook.view === "list" ? "border-border/70" : "border-border",
                  picked.includes(item.id) && "bg-brand/10 ring-2 ring-brand/70",
                  dragId === item.id && "opacity-40",
                )}
              >
                  <div className={cn("flex", openLook.view === "list" ? "min-w-0 flex-1 flex-row items-center gap-2" : "flex-col items-center gap-1.5")}>
                    <ItemVisual
                      item={item}
                      size={openLook.view === "list" ? 20 : openLook.iconSize}
                      appearance={openLook}
                      iconClassName="shrink-0"
                    />
                    {openLook.nameMode !== "none" && (
                      <p
                        className={cn("min-w-0 flex-1 break-all font-medium leading-5", openLook.view !== "list" && "flex-none w-full text-center")}
                        style={{ fontSize: openLook.view === "list" ? Math.max(openLook.fontSize, 12) : openLook.fontSize }}
                        title={item.type === "url" ? item.title : item.path}
                      >
                        {item.type === "url" ? item.path : boxDisplayName(item.title, openLook.nameMode)}
                      </p>
                    )}
                  </div>

                  {item.note && (
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70" title={item.note}>
                      {item.note}
                    </p>
                  )}

              {/*
                徽标行 mt-auto 钉在卡片底部。
                卡片是 grid item，同一行会被拉伸到等高；若徽标紧跟内容，
                标题折 2 行的卡片就会把徽标推低，同行卡片的「属性」不在一条水平线上。
              */}
              <div className={cn("flex flex-wrap items-center gap-1", openLook.view === "list" ? "shrink-0" : "mt-auto justify-center pt-1.5")}>
                {/* 属性：系统固有维度，始终展示 */}
                <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">
                  {t(`files.type.${item.type}`)}
                </span>
                {/*
                  在「全部」视图里显示所属分类：这里是唯一能一眼看出
                  「哪些条目还没归好类」的地方，也是移动后确认结果的地方。
                */}
                {!selected && (
                  <span className="max-w-full truncate rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground/80">
                    {categoryLabelOf(item.categoryId)}
                  </span>
                )}
                {item.tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-brand/10 px-1.5 text-[10px] text-brand">
                    #{tag}
                  </span>
                ))}
              </div>

                  {/* 悬停操作 */}
                  <div className="absolute inset-x-2 top-2 flex justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <CardAction
                      title={t("files.copyPath")}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (await copyText(item.path)) toast.success(t("files.copied"));
                      }}
                    >
                      <Copy className="size-3.5" />
                    </CardAction>
                    {item.type !== "url" && (
                      <CardAction
                        title={t("files.ctx.reveal")}
                        onClick={(e) => {
                          e.stopPropagation();
                          void revealInExplorer(item.path).catch(() => toast.error(t("files.openErr")));
                        }}
                      >
                        <ExternalLink className="size-3.5" />
                      </CardAction>
                    )}
                    <CardAction
                      title={t("files.editItem")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setModal({ open: true, editing: item });
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </CardAction>
                    <CardAction
                      title={t("files.ctx.deleteDisk")}
                      danger
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDeleteItem(item);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </CardAction>
                  </div>
              </div>
            ))}
          {/* 分片哨兵：滚到这里就再铺一批（没有更多时它渲染为 null） */}
          <ListSentinel sentinelRef={sentinelRef} hasMore={hasMore} className="col-span-full h-px w-full" />
          {/* 拖拽落点竖线 */}
          {drop && (
            <span
              aria-hidden
              className="pointer-events-none absolute z-10 w-0.5 rounded-full bg-brand"
              style={{ left: drop.x - 1, top: drop.y, height: drop.h }}
            />
          )}
        </div>}

        {openBox && openKind !== "mapped" && (
          <div className="relative flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
            <span>{t("files.dropToBox")}</span>
            <span data-drop-desktop="" className={cn("rounded-full border px-2 py-0.5 transition-colors", deskTarget ? "border-brand bg-brand/15 text-brand" : "border-border")}>{t("files.desktopTarget")}</span>
            {otherBoxes.map((category) => (
              <span
                key={category.id}
                data-drop-box={category.id}
                className={cn(
                  "rounded-full border px-2 py-0.5 transition-colors",
                  dropBoxId === category.id ? "border-brand bg-brand/15 text-brand" : "border-border",
                )}
              >
                {categoryLabelOf(category.id)}
              </span>
            ))}
            {quickDirs.map((dir) => (
              <span
                key={dir.id}
                data-drop-quick={dir.id}
                title={dir.path}
                className={cn(
                  "max-w-32 truncate rounded-full border px-2 py-0.5 transition-colors",
                  quickDropId === dir.id ? "border-brand bg-brand/15 text-brand" : "border-border",
                )}
              >
                {dir.name}
              </span>
            ))}

            {/* 悬停够久的那个盒子就地展开：先看清里面是什么，再决定松不松手 */}
            {expandedBoxId && (() => {
              const target = categories.find((category) => category.id === expandedBoxId);
              if (!target) return null;
              const inside = items.filter((item) => item.categoryId === expandedBoxId).slice(0, 8);
              const total = items.filter((item) => item.categoryId === expandedBoxId).length;
              return (
                <span
                  data-drop-preview
                  className="absolute bottom-full left-0 z-30 mb-1.5 flex max-w-[min(420px,90%)] flex-wrap items-center gap-1.5 rounded-xl border border-brand/40 bg-popover px-2.5 py-2 shadow-lg"
                >
                  <span className="w-full truncate text-[11px] font-medium text-foreground">
                    {categoryLabelOf(expandedBoxId)}
                    <span className="ml-1.5 font-normal text-muted-foreground">{total}</span>
                  </span>
                  {inside.length === 0 && (
                    <span className="text-[11px] text-muted-foreground">{t("files.boxEmptyShort")}</span>
                  )}
                  {inside.map((item) => (
                    <span key={item.id} className="grid size-5 place-items-center" title={item.title}>
                      <ItemIcon type={item.type} path={item.path} iconUrl={item.iconUrl} size={18} />
                    </span>
                  ))}
                  <span className="ml-auto text-[10px] text-brand">{t("files.dropToHint")}</span>
                </span>
              );
            })()}
          </div>
        )}

        {visibleBoxItems.length === 0 && openKind === "mapped" && (
          <p className="py-8 text-center text-[12px] text-muted-foreground">{t("files.mappedEmpty")}</p>
        )}
        </motion.div>
      </div>

      {/* ── 添加/编辑条目弹窗 ── */}
      <ItemModal
        key={modal.editing?.id ?? "new"}
        open={modal.open}
        editing={modal.editing}
        defaultCategory={openBoxId}
        onClose={() => setModal({ open: false, editing: null })}
      />

      {/* ── 新建收纳盒：名字 / 种类 / 配色一次填完，不再两步 ── */}
      <Dialog open={!!newBox} onOpenChange={(next) => { if (!next) setNewBox(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("files.newBox")}</DialogTitle>
          </DialogHeader>
          {newBox && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-foreground/90">{t("files.boxKind")}</span>
                {(["shortcut", "mapped"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={newBox.kind === kind}
                    onClick={() => setNewBox({ ...newBox, kind })}
                    className={cn(
                      "flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors",
                      newBox.kind === kind ? "border-brand bg-brand/5" : "border-border bg-card hover:border-brand/50",
                    )}
                  >
                    <span className="text-[12px] font-medium text-foreground">{t(`files.kind.${kind}`)}</span>
                    <span className="text-[11px] leading-snug text-muted-foreground">{t(`files.kindHint.${kind}`)}</span>
                  </button>
                ))}
              </div>
              {newBox.kind === "mapped" && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-foreground/90">{t("files.mapping.folderLabel")}</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void pickMappedDir()}
                      className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-foreground transition-colors hover:bg-muted"
                    >
                      <FolderOpen className="size-3.5" />
                      {t("files.mapping.add")}
                    </button>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={newBox.dir ?? ""}>
                      {newBox.dir ?? t("files.mapping.notPicked")}
                    </span>
                  </div>
                </div>
              )}
              <Field label={t("files.titleLabel")}>
                <input
                  value={newBox.name}
                  onChange={(e) => setNewBox({ ...newBox, name: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commitNewBox(); } }}
                  placeholder={newBox.kind === "mapped" ? t("files.nameFromFolder") : t("files.boxNamePlaceholder")}
                  className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-[13px] outline-none focus:border-brand/50"
                />
              </Field>
            </div>
          )}
          <DialogFooter>
            <button type="button" onClick={() => setNewBox(null)}
              className="rounded-lg px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted">
              {t("files.cancel")}
            </button>
            <button type="button" onClick={() => void commitNewBox()} disabled={!newBox || !newBox.name.trim() || (newBox.kind === "mapped" && !newBox.dir)}
              className="rounded-lg bg-brand px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-brand-strong disabled:opacity-40">
              {t("files.createBox")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <QuickAccessDrawer
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
        dropDirId={quickDropId}
      />

      {/* 拖动时跟着指针的卡片：确认手势真的开始了，也看得清拖的是哪一条 */}
      {dragGhost && (
        <div
          ref={dragGhostRef}
          className="pointer-events-none fixed left-0 top-0 z-[80] flex w-20 flex-col items-center gap-1 rounded-lg border border-brand/40 bg-popover/95 p-1.5 shadow-xl"
          style={{ transform: `translate3d(${dragGhostPos.current.x + 14}px, ${dragGhostPos.current.y + 14}px, 0)` }}
        >
          <ItemIcon type={dragGhost.item.type} path={dragGhost.item.path} iconUrl={dragGhost.item.iconUrl} size={30} />
          <span className="line-clamp-2 w-full break-all text-center text-[10px] leading-tight text-foreground">{dragGhost.item.title}</span>
        </div>
      )}
    </div>
  );
}

function CardAction({
  title,
  danger,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "grid size-6 place-items-center rounded-md bg-card/90 text-muted-foreground backdrop-blur transition-colors",
        danger ? "hover:text-destructive" : "hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/* ── 添加/编辑条目弹窗 ────────────────────────────────── */

const TYPES: ItemType[] = ["folder", "file", "url"];
const URL_RE = /^https?:\/\/\S+\.\S+/i;

function ItemModal({
  open,
  editing,
  defaultCategory,
  onClose,
}: {
  open: boolean;
  editing: FileItem | null;
  defaultCategory: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const categories = useFiles((s) => s.categories);
  const addItem = useFiles((s) => s.addItem);
  const updateItem = useFiles((s) => s.updateItem);

  const [type, setType] = useState<ItemType>(editing?.type ?? "folder");
  const [title, setTitle] = useState(editing?.title ?? "");
  const [path, setPath] = useState(editing?.path ?? "");
  // 新建时跟着当前打开的盒子走；没开盒就预选第一个可用的盒子——否则确认按钮永远是灰的，
  // 用户看不出是"没选盒子"还是"表单没填完"。
  const fallbackCategory = categories.find(category => categoryKind(category) !== "mapped")?.id ?? "";
  const [selectedCategoryId, setCategoryId] = useState(editing?.categoryId ?? defaultCategory ?? fallbackCategory);
  const categoryId = categories.some((category) => category.id === selectedCategoryId) ? selectedCategoryId : "";
  /** 可加入的收纳盒：映射盒不收手工条目 */
  const boxesForPick = categories.filter((category) => categoryKind(category) !== "mapped");

  // 弹框常驻挂载，初值只算一次：每次打开时把「当前盒子」同步进来
  useEffect(() => {
    if (!open || editing) return;
    setCategoryId(defaultCategory ?? "");
  }, [open, editing, defaultCategory]);
  const [note, setNote] = useState(editing?.note ?? "");
  const [fetchedIcon, setFetchedIcon] = useState<string | undefined>(undefined);
  const [browsing, setBrowsing] = useState(false);
  const [fetchingMeta, setFetchingMeta] = useState(false);

  /** 从系统选择器选路径：自动填 path + 默认标题 */
  const applyPicked = (picked: string | null) => {
    if (!picked) return;
    setPath(picked);
    if (!title.trim()) setTitle(nameFromPath(picked));
  };

  const browse = async () => {
    setBrowsing(true);
    try {
      if (type === "folder") applyPicked(await pickFolder());
      else if (type === "file") applyPicked(await pickFile());
    } finally {
      setBrowsing(false);
    }
  };

  const isLocal = type !== "url";
  const urlInvalid = type === "url" && path.trim() !== "" && !URL_RE.test(path.trim());

  // 网站链接 → 自动抓取 title / description / favicon（700ms 防抖，只填空字段）
  useEffect(() => {
    if (type !== "url" || urlInvalid) return;
    const target = path.trim();
    const timer = setTimeout(async () => {
      setFetchingMeta(true);
      try {
        const meta = await fetchSiteMeta(target);
        if (meta.title) setTitle((prev) => (prev.trim() ? prev : meta.title!));
        if (meta.description) setNote((prev) => (prev.trim() ? prev : meta.description!));
        if (meta.iconUrl) setFetchedIcon(meta.iconUrl);
        if (meta.title || meta.description || meta.iconUrl) {
          toast.success(t("files.metaFetched"));
        }
      } catch {
        /* 抓取失败静默，用户可手填 */
      } finally {
        setFetchingMeta(false);
      }
    }, 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, type]);

  const save = () => {
    if (!title.trim() || !path.trim()) return;
    if (type === "url" && !URL_RE.test(path.trim())) {
      toast.error(t("files.openErr"));
      return;
    }
    if (!categoryId) return; // 没选收纳盒就不加（按钮此时也是禁用的）
    const tags = editing?.tags ?? [];
    const iconUrl = type === "url" ? fetchedIcon ?? editing?.iconUrl : undefined;
    if (editing) {
      updateItem(editing.id, {
        type, title: title.trim(), path: path.trim(), categoryId, tags,
        note: note.trim() || undefined, iconUrl,
      });
    } else {
      addItem({ type, title: title.trim(), path: path.trim(), categoryId, tags, note: note.trim() || undefined, iconUrl });
    }
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl rounded-2xl border-border bg-popover">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {editing ? t("files.editItem") : t("files.addItem")}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* 属性（系统固有）：由来源决定，创建后不可改 ——
              磁盘上文件夹就是文件夹，改属性不成立。
              编辑时只展示当前值（静态徽标），新建时才允许选择。 */}
          <Field label={t("files.attrLabel")}>
            {editing ? (
              <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-1.5">
                <span className="rounded-md bg-card px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border">
                  {t("files.attrLocked")}
                </span>
                <span className="text-[12px] font-semibold text-foreground">
                  {t(`files.type.${type}`)}
                </span>
              </div>
            ) : (
              <div className="relative flex rounded-xl border border-border bg-muted/40 p-1">
                {TYPES.map((ty) => (
                  <button
                    key={ty}
                    type="button"
                    onClick={() => setType(ty)}
                    className="relative flex-1 rounded-lg py-1.5 text-[12px]"
                  >
                    {type === ty && (
                      <motion.span
                        layoutId="item-type-pill"
                        className="absolute inset-0 rounded-lg bg-card shadow-[var(--pr-shadow-1)] ring-1 ring-border"
                        transition={{ type: "spring", stiffness: 550, damping: 42 }}
                      />
                    )}
                    <span
                      className={cn(
                        "relative z-10",
                        type === ty ? "font-semibold text-brand" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t(`files.type.${ty}`)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Field>
          <Field label={t("files.titleLabel")}>
            <textarea
              autoFocus
              rows={1}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); } }}
              className="min-h-9 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-[13px] leading-snug outline-none focus:border-brand/50"
            />
          </Field>

          <Field label={fetchingMeta ? t("files.fetching") : isLocal ? t("files.pathLabel") : t("files.urlLabel")}>
            {isLocal ? (
              /* 本地路径：系统选择器 + 只读回显 */
              <div className="flex items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[12px] text-muted-foreground">
                  {path || t("files.browse")}
                </code>
                <button
                  type="button"
                  onClick={() => void browse()}
                  disabled={browsing}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[12px] transition-colors hover:border-brand/50 hover:text-brand"
                >
                  <FolderOpen className="size-3.5" />
                  {t("files.browse")}
                </button>
              </div>
            ) : (
              /* 网址：文本输入 + 校验 */
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && save()}
                placeholder="https://"
                className={cn(
                  "w-full rounded-lg border bg-background px-3 py-2 font-mono text-[12px] outline-none",
                  urlInvalid ? "border-destructive" : "border-border focus:border-brand/50",
                )}
              />
            )}
          </Field>

          <Field label={t("files.noteLabel")}>
            <textarea
              rows={1}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); } }}
              className="min-h-9 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-[12px] leading-snug outline-none focus:border-brand/50"
            />
          </Field>

          {/*
            收纳盒（可改）：只列非映射盒 —— 映射盒的内容归磁盘目录管，往里塞手工条目没有意义。
            「不加入」= 不建条目，文件就留在桌面上。
          */}
          <Field label={t("files.boxLabel")} hint={t("files.boxHint")}>
            <div data-box-picker className="flex flex-wrap gap-1.5">
              {boxesForPick.map((cat) => {
                const parent = cat.parentId
                  ? categories.find((p) => p.id === cat.parentId)
                  : undefined;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    aria-pressed={categoryId === cat.id}
                    onClick={() => setCategoryId(cat.id)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[12px] transition-colors",
                      categoryId === cat.id
                        ? "border-brand bg-brand/10 text-brand"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {parent && (
                      <span className="text-muted-foreground/60">{parent.name} / </span>
                    )}
                    {cat.name}
                  </button>
                );
              })}
            </div>
          </Field>
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-4 py-1.5 text-[13px] text-muted-foreground hover:bg-muted"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!title.trim() || !path.trim() || !categoryId || urlInvalid}
            className="rounded-full bg-brand px-4 py-1.5 text-[13px] font-medium text-white hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("common.confirm")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-foreground/90">
        {label}
        {hint && <span className="ml-1.5 font-normal text-muted-foreground/70">{hint}</span>}
      </span>
      {children}
    </div>
  );
}
