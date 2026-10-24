import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Search,
  Pencil,
  Trash2,
  ExternalLink,
  Monitor,
  MonitorOff,
  FolderInput,
  Loader2,
  X,
  MoreHorizontal,
  FolderOpen,
  Copy,
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
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { CategoryKind } from "@/stores/files";
import {
  openPath,
  openUrl,
  revealInExplorer,
  pickFolder,
  pickFile,
  fetchSiteMeta,
} from "@/lib/tauri";
import { useModal } from "@/components/shell/modal-host";
import { invoke } from "@tauri-apps/api/core";
import { ListSentinel, useIncrementalCount } from "@/components/ui/incremental-list";
import { copyText } from "@/lib/clipboard";
import { motion } from "motion/react";
import { ItemIcon } from "@/features/files/icons";
import { useFileActions, type FileActions } from "@/features/files/actions";
import { usePopupMenu } from "@/features/files/use-popup-menu";
import { ITEM_ATTR } from "@/features/files/menu-model";
import { importDroppedFiles } from "./import-files";
import { useFileDrop } from "./use-file-drop";
import { restoreFenceOnDesktop, setAllFencesOnDesktop, setFenceOnDesktop } from "./desktop-actions";
import { MapFolderButton, CategoryMappingBar } from "./directory-mapping-controls";

/** 分类 chip 上的标记：右键时据此判断命中了哪个分类 */
const CAT_ATTR = "data-cat-id";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
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
  const removeCategory = useFiles((s) => s.removeCategory);
  const moveItemBefore = useFiles((s) => s.moveItemBefore);
  const fences = useFences((s) => s.fences);
  const [filesHydrated, setFilesHydrated] = useState(useFiles.persist.hasHydrated);
  const [fencesHydrated, setFencesHydrated] = useState(useFences.persist.hasHydrated);

  const [selected, setSelected] = useState<string | null>(null); // null = 全部
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [modal, setModal] = useState<{ open: boolean; editing: FileItem | null }>({
    open: false,
    editing: null,
  });
  const restored = useRef(new Set<string>());
  const mounted = useRef(false);
  const desktopLock = useRef(false);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [desktopProgress, setDesktopProgress] = useState({ done: 0, total: 0 });
  /** 浮窗菜单触发的分类改名目标 */
  const [renamingCategoryId, setRenamingCategoryId] = useState<string | null>(null);

  const actions = useFileActions();

  useEffect(() => {
    mounted.current = true;
    const offFiles = useFiles.persist.onFinishHydration(() => setFilesHydrated(true));
    const offFences = useFences.persist.onFinishHydration(() => setFencesHydrated(true));
    setFilesHydrated(useFiles.persist.hasHydrated());
    setFencesHydrated(useFences.persist.hasHydrated());
    return () => { mounted.current = false; offFiles(); offFences(); };
  }, []);

  const { dragging, busy: importing } = useFileDrop({
    enabled: filesHydrated && !modal.open,
    onDrop: async paths => {
      const result = await importDroppedFiles(paths, t("files.defaultCategory"));
      if (!mounted.current) return;
      if (result.categoryId) {
        setSelected(result.categoryId);
        setSearch("");
        setActiveTags([]);
      }
      const message = t("files.dropResult", { ...result });
      if (result.added) toast.success(message);
      else if (result.missing) toast.error(message);
      else toast.message(message);
    },
    onError: error => { if (mounted.current) toast.error(String(error)); },
  });

  // 首次使用：默认分类
  useEffect(() => {
    if (filesHydrated && categories.length === 0) {
      addCategory(t("files.defaultCategory"));
    }
  }, [filesHydrated, categories.length, addCategory, t]);

  // 启动恢复已开启的栅栏
  useEffect(() => {
    if (!filesHydrated || !fencesHydrated) return;
    for (const cat of categories) {
      const f = fences[cat.id];
      if (f?.open && !restored.current.has(cat.id)) {
        restored.current.add(cat.id);
        void restoreFenceOnDesktop(cat.id).catch(error => toast.error(String(error)));
      }
    }
  }, [filesHydrated, fencesHydrated, categories, fences]);

  const scoped = selected ? items.filter((i) => i.categoryId === selected) : items;

  const allTags = useMemo(
    () => [...new Set(scoped.flatMap((i) => i.tags))].sort(),
    [scoped],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scoped
      .filter((i) => activeTags.every((tag) => i.tags.includes(tag)))
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

  const openItem = (item: FileItem) => {
    const p = item.type === "url" ? openUrl(item.path) : openPath(item.path);
    void p.catch(() => toast.error(t("files.openErr")));
  };

  /* ── 条目拖拽排序 ──
     与栅栏同一套手势语义：单击选中、双击打开、选中后拖动排序（落点竖线）。
     区别是这里不涉及系统拖出（文件页是管理界面，不需要把条目拖到桌面）。 */
  const [dragId, setDragId] = useState<string | null>(null);
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

  const startItemDrag = (e: React.PointerEvent, item: FileItem) => {
    if (e.button !== 0) return;
    // 悬停操作按钮上的按下不参与拖拽
    if ((e.target as HTMLElement).closest("button")) return;
    const el = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    const sx = e.clientX;
    const sy = e.clientY;
    let dragging = false;
    let pending: typeof drop = null;

    const cleanup = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
    };

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        dragging = true;
        setDragId(item.id);
      }
      pending = computeDrop(ev.clientX, ev.clientY, item.categoryId);
      setDrop(pending);
    };

    const onUp = () => {
      if (dragging && pending) {
        moveItemBefore(item.id, pending.anchorId);
      }
      onCancel();
    };

    const onCancel = () => {
      pending = null;
      setDrop(null);
      setDragId(null);
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

  const toggleFence = (catId: string) => updateDesktop(async () => {
    restored.current.add(catId);
    await setFenceOnDesktop(catId, !useFences.getState().fences[catId]?.open);
  });

  const toggleAllFences = (visible: boolean) => updateDesktop(async () => {
    for (const category of useFiles.getState().categories) restored.current.add(category.id);
    const result = await setAllFencesOnDesktop(visible, (done, total) => {
      if (mounted.current) setDesktopProgress({ done, total });
    });
    if (result.failed.length) {
      toast.error(t("files.desktopPartial", { count: result.done, failed: result.failed.length }), {
        description: result.failed.map(item => `${item.name}: ${String(item.error)}`).join("\n"),
      });
    } else toast.success(t(visible ? "files.desktopShown" : "files.desktopHidden", { count: result.done }));
  }, categories.length);

  /** 新建分类的第二步：先选盒子种类，再创建（映射盒还要挑目录）。 */
  const [kindFor, setKindFor] = useState<string | null>(null);
  const setCategoryMapping = useFiles((s) => s.setCategoryMapping);

  const chooseKind = async (kind: CategoryKind) => {
    const name = kindFor;
    if (!name) return;
    if (kind === "mapped") {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      const id = addCategory(name, undefined, "mapped");
      setCategoryMapping(id, picked);
    } else {
      addCategory(name, undefined, kind);
    }
    setKindFor(null);
  };

  const onAddCategory = async () => {
    const name = await prompt({ title: t("files.addCategory") });
    if (!name?.trim()) return;
    const dup = categories.some((c) => c.name.toLowerCase() === name.trim().toLowerCase());
    if (dup) {
      await alert({ title: t("files.dupCategory") });
      return;
    }
    // 第二步：选三种盒子之一（快捷 / 存储 / 映射），不再用「是/否」两段式
    setKindFor(name.trim());
  };

  /** 双击/菜单就地改名：重名返回 false（保持编辑态），成功返回 true */
  const onRenameConfirm = async (catId: string, name: string): Promise<boolean> => {
    const clean = name.trim();
    if (!clean) return false;
    const dup = categories.some(
      (c) => c.id !== catId && c.name.toLowerCase() === clean.toLowerCase(),
    );
    if (dup) {
      toast.error(t("files.dupCategory"));
      return false;
    }
    renameCategory(catId, clean);
    return true;
  };

  const onDeleteCategory = async (catId: string) => {
    const cat = categories.find((c) => c.id === catId);
    if (!cat) return;
    // 子分类存在时不允许删除，避免连带删掉用户没意识到的东西
    if (categories.some((c) => c.parentId === catId)) {
      await alert({ title: t("files.categoryHasChildren") });
      return;
    }
    if (items.some((i) => i.categoryId === catId)) {
      await alert({ title: t("files.categoryHasItems") });
      return;
    }
    const ok = await confirm({
      title: t("files.deleteCategoryConfirm", { name: cat.name }),
      danger: true,
    });
    if (ok) await updateDesktop(async () => {
      restored.current.add(catId);
      await setFenceOnDesktop(catId, false);
      // A drop may finish while confirmation or native close is pending.
      const latest = useFiles.getState();
      if (latest.categories.some(c => c.parentId === catId)) throw new Error(t("files.categoryHasChildren"));
      if (latest.items.some(item => item.categoryId === catId)) throw new Error(t("files.categoryHasItems"));
      removeCategory(catId);
      if (mounted.current) setSelected(current => current === catId ? null : current);
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
  const copyCategoryPaths = async (catId: string) => {
    const paths = items.filter((i) => i.categoryId === catId).map((i) => i.path);
    if (!paths.length) return;
    if (await copyText(paths.join("\n"))) toast.success(t("files.copied"));
  };

  /** 新建子分类。单层约束：只允许挂在顶级分类下 */
  const onAddSubCategory = async (parentId: string) => {
    const parent = categories.find((c) => c.id === parentId);
    if (!parent) return;
    const name = await prompt({
      title: t("files.subCategoryOf", { name: parent.name }),
    });
    if (!name?.trim()) return;
    const clean = name.trim();
    const dup = categories.some(
      (c) =>
        c.parentId === parentId && c.name.toLowerCase() === clean.toLowerCase(),
    );
    if (dup) {
      await alert({ title: t("files.dupCategory") });
      return;
    }
    const id = addCategory(clean, parentId);
    setSelected(id);
  };


  const openMenu = usePopupMenu({
    actions,
    onToggleFence: (id) => {
      const cat = categories.find((c) => c.id === id);
      if (cat) void toggleFence(cat.id);
    },
    onCategoryRename: (id) => setRenamingCategoryId(id),
    onCategoryDelete: (id) => void onDeleteCategory(id),
    onCategoryAddChild: (id) => void onAddSubCategory(id),
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

  return (
    <div className="relative h-full overflow-y-auto">
      {(dragging || importing) && (
        <div role="status" className="pointer-events-none absolute inset-3 z-30 flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-brand bg-background/95 text-center shadow-lg">
          {importing ? <Loader2 className="size-7 animate-spin text-brand" /> : <FolderInput className="size-7 text-brand" />}
          <p className="text-sm font-medium">{t(importing ? "files.dropWorking" : "files.dropReady")}</p>
          <p className="text-xs text-muted-foreground">{t("files.dropHint")}</p>
        </div>
      )}
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6 pb-10">
        {/* 分类 chip 右键由该容器统一处理（浮窗菜单） */}
        {/* ── 分类 rail ── */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2" onContextMenu={onRailContextMenu}>
          <CategoryChip
            label={t("files.all")}
            count={items.length}
            active={selected === null}
            onClick={() => setSelected(null)}
          />
          {/* 顶级分类；每个顶级分类后跟它的子分类（单层，缩进 + 前缀符区分） */}
          {topCategories.map((cat) => {
            const kids = childrenOf(cat.id);
            return (
              <span key={cat.id} className="flex flex-wrap items-center gap-1.5">
                <CategoryChip
                  catId={cat.id}
                  label={cat.name}
                  count={countIn(cat.id)}
                  active={selected === cat.id}
                  fenceOn={fences[cat.id]?.open ?? false}
                  forceRename={renamingCategoryId === cat.id}
                  actions={actions}
                  onClick={() => setSelected(cat.id)}
                  onToggleFence={() => void toggleFence(cat.id)}
                  onRenameConfirm={onRenameConfirm}
                  onDelete={() => void onDeleteCategory(cat.id)}
                  onCopyPaths={() => void copyCategoryPaths(cat.id)}
                />
                {kids.length > 0 && (
                  <span className="flex flex-wrap items-center gap-1.5 border-l border-border/70 pl-2">
                    {kids.map((kid) => (
                      <CategoryChip
                        key={kid.id}
                        catId={kid.id}
                        label={kid.name}
                        count={countIn(kid.id)}
                        active={selected === kid.id}
                        fenceOn={fences[kid.id]?.open ?? false}
                        forceRename={renamingCategoryId === kid.id}
                        actions={actions}
                        sub
                        onClick={() => setSelected(kid.id)}
                        onToggleFence={() => void toggleFence(kid.id)}
                        onRenameConfirm={onRenameConfirm}
                        onDelete={() => void onDeleteCategory(kid.id)}
                        onCopyPaths={() => void copyCategoryPaths(kid.id)}
                      />
                    ))}
                  </span>
                )}
              </span>
            );
          })}
          <button
            type="button"
            onClick={() => void onAddCategory()}
            title={t("files.addCategory")}
            className="grid size-7 place-items-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:border-brand/50 hover:text-brand"
          >
            <Plus className="size-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 pb-3">
          <span className="mr-auto text-xs text-muted-foreground" role="status" aria-live="polite">
            {desktopBusy
              ? t("files.desktopUpdating", desktopProgress)
              : t("files.desktopCount", { count: categories.filter(cat => fences[cat.id]?.open).length, total: categories.length })}
          </span>
          <button type="button" disabled={desktopBusy || !filesHydrated || !fencesHydrated || !categories.length}
            onClick={() => void toggleAllFences(true)}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-brand disabled:pointer-events-none disabled:opacity-45">
            <Monitor className="size-3.5" />{t("files.showAllDesktop")}
          </button>
          <button type="button" disabled={desktopBusy || !filesHydrated || !fencesHydrated || !categories.length}
            onClick={() => void toggleAllFences(false)}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-brand disabled:pointer-events-none disabled:opacity-45">
            <MonitorOff className="size-3.5" />{t("files.hideAllDesktop")}
          </button>
        </div>

        {/* ── 搜索 + 添加 ── */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 focus-within:border-brand/50">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("files.searchPlaceholder")}
              className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
            />
            {search && (
              <button type="button" onClick={() => setSearch("")} className="text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <MapFolderButton onMapped={id => { setSelected(id); setSearch(""); setActiveTags([]); }} />
          <button
            type="button"
            onClick={() => setModal({ open: true, editing: null })}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-brand-strong"
          >
            <Plus className="size-4" />
            {t("files.addItem")}
          </button>
        </div>

        {selected && <CategoryMappingBar key={selected} categoryId={selected} />}

        {/* ── 标签筛选 ── */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() =>
                  setActiveTags((s) => (s.includes(tag) ? s.filter((x) => x !== tag) : [...s, tag]))
                }
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
                  activeTags.includes(tag)
                    ? "border-brand bg-brand/10 text-brand"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                #{tag}
              </button>
            ))}
            {activeTags.length > 0 && (
              <button
                type="button"
                onClick={() => setActiveTags([])}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        )}

        {/* ── 条目网格（右键菜单在独立浮窗渲染，可溢出窗口边界） ── */}
        <div
          ref={gridRef}
          onContextMenu={onContextMenu}
          onMouseDown={(e) => {
            // 点空白处取消选中（卡片带 data-card 标记）
            if (!(e.target as HTMLElement).closest("[data-card]")) setSelectedItemId(null);
          }}
          className="relative grid min-h-24 grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5"
        >
            {filtered.slice(0, visibleCount).map((item) => (
              <div
                key={item.id}
                {...{ [ITEM_ATTR]: item.id }}
                data-card
                data-cat={item.categoryId}
                onPointerDown={(e) => startItemDrag(e, item)}
                onClick={() => setSelectedItemId(item.id)}
                onDoubleClick={() => openItem(item)}
                title={t("files.dblclickHint")}
                className={cn(
                  "group relative flex cursor-pointer flex-col rounded-xl border bg-card p-3 shadow-[var(--pr-shadow-1)] transition-all duration-150 hover:-translate-y-0.5 hover:shadow-[var(--pr-shadow-2)]",
                  selectedItemId === item.id ? "border-brand ring-1 ring-brand/40" : "border-border",
                  dragId === item.id && "opacity-40",
                )}
              >
                  <div className="flex items-start gap-2">
                    <ItemIcon
                      type={item.type}
                      path={item.path}
                      iconUrl={item.iconUrl}
                      size={20}
                      className="size-5"
                    />
                    <p
                      className="min-w-0 flex-1 break-all text-[13px] font-medium leading-5"
                      title={item.type === "url" ? item.title : item.path}
                    >
                      {item.type === "url" ? item.path : item.title}
                    </p>

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
              <div className="mt-auto flex flex-wrap items-center gap-1 pt-1.5">
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
        </div>

        {filtered.length === 0 && (
          <p className="py-10 text-center text-[13px] text-muted-foreground">{t("files.empty")}</p>
        )}
      </div>

      {/* ── 添加/编辑条目弹窗 ── */}
      <ItemModal
        key={modal.editing?.id ?? "new"}
        open={modal.open}
        editing={modal.editing}
        defaultCategory={selected}
        onClose={() => setModal({ open: false, editing: null })}
      />

      {/* ── 新建分类第二步：三种盒子选一个 ── */}
      <Dialog open={!!kindFor} onOpenChange={(next) => { if (!next) setKindFor(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("files.kindTitle")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {(["shortcut", "storage", "mapped"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => void chooseKind(kind)}
                className="flex flex-col items-start gap-0.5 rounded-xl border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-brand/60"
              >
                <span className="text-[13px] font-medium text-foreground">{t(`files.kind.${kind}`)}</span>
                <span className="text-[11px] leading-snug text-muted-foreground">{t(`files.kindHint.${kind}`)}</span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CategoryChip({
  catId,
  label,
  count,
  active,
  fenceOn,
  actions,
  forceRename,
  sub,
  onClick,
  onToggleFence,
  onRenameConfirm,
  onDelete,
  onCopyPaths,
}: {
  catId?: string;
  label: string;
  count: number;
  active: boolean;
  fenceOn?: boolean;
  actions?: FileActions;
  /** 由浮窗菜单触发的外来改名请求 */
  forceRename?: boolean;
  /** 子分类：用较弱的视觉重量区分层级 */
  sub?: boolean;
  onClick: () => void;
  onToggleFence?: () => void;
  onRenameConfirm?: (id: string, name: string) => Promise<boolean>;
  onDelete?: () => void;
  onCopyPaths?: () => void;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const boundDir = catId ? actions?.categoryOf(catId)?.dir : undefined;

  const startRename = () => {
    setDraft(label);
    setRenaming(true);
    requestAnimationFrame(() => inputRef.current?.select());
  };

  // 浮窗菜单请求改名 → 进入编辑态
  useEffect(() => {
    if (forceRename) startRename();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceRename]);

  const commit = async () => {
    if (!renaming || !catId) return;
    const ok = await onRenameConfirm?.(catId, draft);
    if (ok) setRenaming(false); // 重名 → 保持编辑态让用户改
  };

  const chip = (
    <div
      {...(catId ? { [CAT_ATTR]: catId } : {})}
      className={cn(
        "flex items-center gap-0.5 rounded-full border py-1 text-[12px] font-medium transition-colors",
        sub ? "pl-2 pr-1 text-[11px]" : "pl-3 pr-1",
        active
          ? "border-brand bg-brand/10 text-brand"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {sub && <span className="text-muted-foreground/50">└</span>}
      {renaming ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") setRenaming(false);
          }}
          className="w-24 bg-transparent text-[12px] outline-none"
        />
      ) : (
        <button type="button" onClick={onClick} onDoubleClick={startRename} className="flex items-center gap-1.5">
          {label}
          <span className="rounded-full bg-muted px-1.5 text-[10px]">{count}</span>
        </button>
      )}

      {boundDir && !renaming && (
        <FolderOpen className="size-3 shrink-0 text-brand/70" aria-label={boundDir} />
      )}

      {onToggleFence && !renaming && (
        <button
          type="button"
          title={t("files.fence")}
          onClick={onToggleFence}
          className={cn(
            "grid size-5 place-items-center rounded-full transition-colors",
            fenceOn ? "text-brand" : "text-muted-foreground/60 hover:text-foreground",
          )}
        >
          <Monitor className="size-3" />
        </button>
      )}

      {catId && onRenameConfirm && onDelete && !renaming && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={label}
              className="grid size-5 place-items-center rounded-full text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuItem onClick={onToggleFence}>
              <Monitor className="size-3.5" />
              {t("files.fence")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={startRename}>
              <Pencil className="size-3.5" />
              {t("files.renameCategory")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onCopyPaths?.()}>
              <Copy className="size-3.5" />
              {t("files.copyPaths")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 className="size-3.5" />
              {t("files.deleteCategory")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );

  return chip;
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
  const [selectedCategoryId, setCategoryId] = useState(
    editing?.categoryId ?? defaultCategory ?? categories[0]?.id ?? "",
  );
  const categoryId = categories.some((category) => category.id === selectedCategoryId)
    ? selectedCategoryId
    : categories.find((category) => category.id === defaultCategory)?.id ?? categories[0]?.id ?? "";
  const [tagsText, setTagsText] = useState((editing?.tags ?? []).join(", "));
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
    if (!title.trim() || !path.trim() || !categoryId) return;
    if (type === "url" && !URL_RE.test(path.trim())) {
      toast.error(t("files.openErr"));
      return;
    }
    const tags = tagsText
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
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
      <DialogContent className="max-w-sm rounded-2xl border-border bg-popover">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {editing
              ? t("files.editItem")
              : t("files.newItem", { name: categories.find((c) => c.id === categoryId)?.name ?? "" })}
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
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-brand/50"
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
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[12px] outline-none focus:border-brand/50"
            />
          </Field>

          {/*
            分类（可改）。与上面的「属性」刻意分开展示：
            属性 = 磁盘上的真实类型，创建后锁定；
            分类 = 库里的归属，随时可以移到别的分类。
          */}
          <Field label={t("files.categoryLabel")} hint={t("files.categoryHint")}>
            <div className="flex flex-wrap gap-1.5">
              {categories.map((cat) => {
                const parent = cat.parentId
                  ? categories.find((p) => p.id === cat.parentId)
                  : undefined;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setCategoryId(cat.id)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[12px] transition-colors",
                      categoryId === cat.id
                        ? "border-brand bg-brand/10 text-brand"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {/* 子分类把父名一起写出来：单看名字分不清同名子分类属于谁 */}
                    {parent && (
                      <span className="text-muted-foreground/60">{parent.name} / </span>
                    )}
                    {cat.name}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label={t("files.tagsLabel")} hint={t("files.tagsHint")}>
            <TagEditor value={tagsText} onChange={setTagsText} placeholder={t("files.tagsAdd")} />
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


/**
 * 标签编辑器：把逗号分隔串呈现为可逐个删除的 chip。
 * 直接在输入框里编辑逗号串对用户不直观（看不到已有标签的边界）。
 */
function TagEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const tags = value
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const commit = () => {
    const clean = draft.trim().replace(/[,，]/g, "");
    if (!clean || tags.includes(clean)) {
      setDraft("");
      return;
    }
    onChange([...tags, clean].join(", "));
    setDraft("");
  };

  const removeAt = (i: number) => {
    onChange(tags.filter((_, idx) => idx !== i).join(", "));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1.5 focus-within:border-brand/50">
      {tags.map((tag, i) => (
        <span
          key={`${tag}-${i}`}
          className="flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] text-brand"
        >
          #{tag}
          <button
            type="button"
            onClick={() => removeAt(i)}
            title="×"
            className="text-brand/60 transition-colors hover:text-brand"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "," || e.key === "，") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !draft && tags.length) {
            removeAt(tags.length - 1);
          }
        }}
        onBlur={commit}
        placeholder={tags.length ? "" : placeholder}
        className="min-w-24 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
      />
    </div>
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
