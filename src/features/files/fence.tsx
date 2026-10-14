import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Eye, EyeOff, X, Pin, PinOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Providers } from "@/app/providers";
import { useFiles, useFences, DEFAULT_FENCE, type FileItem } from "@/stores/files";
import { inTauri, probePaths, openPath, openUrl, dragOut, windowReady } from "@/lib/tauri";
import { ItemIcon } from "@/features/files/icons";
import { useFileActions } from "@/features/files/actions";
import { FileAreaContextMenu, ITEM_ATTR } from "@/features/files/menu";
import { cn } from "@/lib/utils";

const win = inTauri ? getCurrentWebviewWindow() : null;

/** 桌面悬浮栅栏：自适应网格 + 置顶 + 拖拽排序 + Ctrl 滚轮缩放 + 幽灵 + 翻页 + 拖入/拖出 */
export function FenceWindow({ categoryId }: { categoryId: string }) {
  return (
    <Providers>
      <FencePanel categoryId={categoryId} />
    </Providers>
  );
}

const SCALE_MIN = 0.7;
const SCALE_MAX = 1.6;
const GAP = 6;

function FencePanel({ categoryId }: { categoryId: string }) {
  const { t } = useTranslation();
  const categories = useFiles((s) => s.categories);
  const allItems = useFiles((s) => s.items); // 稳定引用，selector 内不得造新数组
  const addItems = useFiles((s) => s.addItems);
  const moveItemBefore = useFiles((s) => s.moveItemBefore);
  const category = useMemo(
    () => categories.find((c) => c.id === categoryId),
    [categories, categoryId],
  );
  const items = useMemo(
    () => allItems.filter((i) => i.categoryId === categoryId),
    [allItems, categoryId],
  );
  const fence = useFences((s) => s.fences[categoryId]) ?? DEFAULT_FENCE;
  const setGhost = useFences((s) => s.setGhost);
  const setGeometry = useFences((s) => s.setGeometry);
  const setOpen = useFences((s) => s.setOpen);
  const setPinned = useFences((s) => s.setPinned);
  const setScale = useFences((s) => s.setScale);

  const [page, setPage] = useState(0);
  const [hover, setHover] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);
  const dragOutBusy = useRef(false);
  const suppressClickUntil = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const gridWrapRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const [gridSize, setGridSize] = useState({ w: 0, h: 0 });
  /** 单击选中的条目（选中后拖动 = 排序） */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  /** 落点竖线：插入位 + 相对网格容器的坐标 */
  const [drop, setDrop] = useState<{ anchorId: string | null; x: number; y: number; h: number } | null>(null);

  const actions = useFileActions();
  /** 就地重命名的条目 id（与分类改名互不影响） */
  const [renameItemId, setRenameItemId] = useState<string | null>(null);
  const [itemDraft, setItemDraft] = useState("");
  const itemRenameRef = useRef<HTMLInputElement>(null);

  const renameCategory = useFiles((s) => s.renameCategory);

  const startRename = () => {
    setDraft(category?.name ?? "");
    setRenaming(true);
    requestAnimationFrame(() => renameRef.current?.select());
  };

  /** 双击栅栏标题 = 重命名分类（重名静默还原，不触发最大化） */
  const commitRename = () => {
    if (!renaming) return;
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
    setSelectedId(item.id);
    setItemDraft(item.title);
    setRenameItemId(item.id);
    requestAnimationFrame(() => itemRenameRef.current?.select());
  };

  const commitItemRename = async (item: FileItem) => {
    if (renameItemId !== item.id) return;
    const next = itemDraft.trim();
    setRenameItemId(null);
    if (!next || next === item.title) return;
    await actions.rename(item, next);
  };

  const scale = fence.scale ?? 1;
  const pinned = fence.pinned ?? false;

  /* ── 置顶状态应用（启动/切换时） ── */
  useEffect(() => {
    if (!win) return;
    void win.setAlwaysOnTop(pinned).catch(() => undefined);
  }, [pinned]);

  /* ── 启动：显示窗口 + 关闭时同步开关状态 ── */
  useEffect(() => {
    void windowReady().catch(() => undefined);
    if (!win) return;
    const unClose = win.onCloseRequested(() => {
      setOpen(categoryId, false);
    });
    return () => {
      void unClose.then((fn) => fn());
    };
  }, [categoryId, setOpen]);

  /* ── 几何持久化：移动/缩放后防抖写回 ── */
  useEffect(() => {
    if (!win) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        const pos = await win.outerPosition();
        const size = await win.outerSize();
        setGeometry(categoryId, { x: pos.x, y: pos.y, w: size.width, h: size.height });
      }, 500);
    };
    const u1 = win.onMoved(schedule);
    const u2 = win.onResized(schedule);
    return () => {
      if (timer) clearTimeout(timer);
      void u1.then((fn) => fn());
      void u2.then((fn) => fn());
    };
  }, [categoryId, setGeometry]);

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
  }, []);

  const cellW = Math.max(64, Math.round(78 * scale));
  const cellH = Math.max(80, Math.round(94 * scale));
  const cols = Math.max(1, Math.floor((gridSize.w + GAP) / (cellW + GAP)));
  const rows = Math.max(1, Math.floor((gridSize.h + GAP) / (cellH + GAP)));
  const pageSize = Math.max(1, cols * rows);

  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const pageItems = items.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const ghosted = fence.ghost && !hover;

  /* ── 拖入收集：桌面/资源管理器 → 栅栏 ── */
  useEffect(() => {
    if (!win) return;
    let cancelled = false;
    const un = win.onDragDropEvent(async (ev) => {
      const p = ev.payload;
      if (p.type === "enter" || p.type === "over") {
        setHover(true);
        return;
      }
      if (p.type === "leave") {
        setHover(false);
        return;
      }
      if (p.type === "drop") {
        const paths = p.paths;
        if (!paths.length) return;
        try {
          const probed = await probePaths(paths);
          if (cancelled) return;
          const valid = probed.filter((x) => x.kind !== "missing");
          if (!valid.length) return;
          addItems(
            valid.map((x) => ({
              categoryId,
              type: x.kind === "folder" ? ("folder" as const) : ("file" as const),
              title: x.name,
              path: x.path,
              tags: [],
            })),
          );
          toast.success(t("files.collected", { count: valid.length }));
        } catch (e) {
          toast.error(String(e));
        }
      }
    });
    return () => {
      cancelled = true;
      void un.then((fn) => fn());
    };
  }, [categoryId, addItems, t]);

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
  }, [pages, scale, categoryId, setScale]);

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
      if (cy < r.bottom && (cy < r.top || cx < r.left + r.width / 2)) {
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
      x: (atEnd ? ar.right : ar.left) - gr.left + (atEnd ? GAP / 2 : -GAP / 2),
      y: ar.top - gr.top,
      h: ar.height,
    };
  };

  /* ── 条目指针手势：单击选中 · 窗口内拖动=排序 · 拖出窗口=系统拖出 ── */
  const startItemDrag = (e: React.PointerEvent, item: FileItem) => {
    if (e.button !== 0 || dragOutBusy.current) return;
    /** 按下时是否已选中：已选中 → 拖动=排序；未选中 → 拖动=拖出 */
    const wasSelected = selectedId === item.id;
    setSelectedId(item.id);
    const el = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    const sx = e.clientX;
    const sy = e.clientY;
    const isLocal = item.type !== "url";
    let mode: "idle" | "reorder" | "out" = "idle";
    let pending: { anchorId: string | null; x: number; y: number; h: number } | null = null;

    const isOutside = (cx: number, cy: number) => {
      const p = panelRef.current?.getBoundingClientRect();
      if (!p) return false;
      return cx <= p.left || cx >= p.right || cy <= p.top || cy >= p.bottom;
    };

    const cleanup = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
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
        });
    };

    const onMove = (ev: PointerEvent) => {
      if (mode === "out") return;
      if (mode === "idle") {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        // 已选中（或网址条目）→ 拖动=排序；未选中的本地条目 → 仅当拖出栅栏时才移出
        mode = wasSelected || !isLocal ? "reorder" : "out";
        if (mode === "reorder") setDragId(item.id);
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

    // 指针捕获：拖出窗口仍能收到 move/up，状态不会卡死
    el.setPointerCapture(pointerId);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const openItem = (path: string, type: string) => {
    if (Date.now() < suppressClickUntil.current) return;
    const p =
      type === "url"
        ? openUrl(path).catch(() => toast.error(t("common.error")))
        : openPath(path).catch(() => toast.error(t("common.error")));
    void p;
  };

  return (
    <div
      className="absolute inset-0 p-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        ref={panelRef}
        className={cn(
          "flex h-full w-full flex-col overflow-hidden rounded-2xl border transition-opacity duration-300",
          ghosted ? "opacity-[0.14]" : "opacity-100",
        )}
        style={{
          background: "color-mix(in oklch, var(--card) 86%, transparent)",
          borderColor: "var(--border)",
          backdropFilter: "blur(2px)",
        }}
      >
        {/* 迷你标题栏（空白区拖拽移动；双击名称 = 重命名） */}
        <div
          data-tauri-drag-region
          className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 px-3 select-none"
        >
          {renaming ? (
            <input
              ref={renameRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename();
                if (e.key === "Escape") setRenaming(false);
              }}
              className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1 text-[12px] outline-none focus:border-brand/50"
            />
          ) : (
            <span
              onDoubleClick={startRename}
              title={t("files.renameCategory")}
              className="min-w-0 flex-1 cursor-text truncate text-[12px] font-semibold text-foreground/90"
            >
              {category?.name ?? "…"}
            </span>
          )}
          <span className="shrink-0 text-[10px] text-muted-foreground">{items.length}</span>
          <TitleBtn
            title={pinned ? t("files.unpin") : t("files.pin")}
            active={pinned}
            onClick={() => setPinned(categoryId, !pinned)}
          >
            {pinned ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
          </TitleBtn>
          <TitleBtn
            title={t("files.ghostToggle")}
            onClick={() => setGhost(categoryId, !fence.ghost)}
          >
            {fence.ghost ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </TitleBtn>
          <TitleBtn danger title={t("titlebar.close")} onClick={() => void win?.close()}>
            <X className="size-3.5" />
          </TitleBtn>
        </div>

        {/* 条目网格：空白处右键 = 新建/绑定目录；条目右键 = 打开/重命名/删除 */}
        <FileAreaContextMenu
          items={items}
          actions={actions}
          categoryId={categoryId}
          onRenameInline={beginItemRename}
        >
          <div
            ref={gridWrapRef}
            onMouseDown={(e) => {
              // 点空白处取消选中（条目上带 data-item 标记）
              if (!(e.target as HTMLElement).closest("[data-item]")) setSelectedId(null);
            }}
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2"
          >
          {pageItems.length === 0 ? (
            <div className="grid h-full place-items-center px-4 text-center text-[11px] leading-relaxed text-muted-foreground">
              {t("files.fenceEmpty")}
            </div>
          ) : (
            <div
              ref={gridRef}
              className="relative mx-auto grid"
              style={{
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gap: GAP,
                maxWidth: cols * (cellW + GAP),
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
                    ref={(el) => {
                      if (el) itemRefs.current.set(item.id, el);
                      else itemRefs.current.delete(item.id);
                    }}
                    onPointerDown={(e) => {
                      if (!isRenaming) startItemDrag(e, item);
                    }}
                    onDoubleClick={() => openItem(item.path, item.type)}
                    title={t("files.itemHint")}
                    className={cn(
                      "group relative flex touch-none flex-col items-center justify-center gap-1 rounded-lg p-1 transition-colors select-none",
                      isSelected
                        ? "cursor-grab bg-brand/12 ring-1 ring-brand/60 active:cursor-grabbing"
                        : "cursor-pointer hover:bg-surface-hover",
                      isDragging && "opacity-40",
                    )}
                    style={{ height: cellH }}
                  >
                    <span
                      className="grid place-items-center"
                      style={{ width: Math.round(34 * scale), height: Math.round(34 * scale) }}
                    >
                      <ItemIcon
                        type={item.type}
                        path={item.path}
                        iconUrl={item.iconUrl}
                        className="size-full"
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
                          if (e.key === "Enter") void commitItemRename(item);
                          if (e.key === "Escape") setRenameItemId(null);
                        }}
                        className="w-full rounded border border-brand/60 bg-card px-1 py-0.5 text-center text-[10px] outline-none"
                      />
                    ) : (
                      <span
                        className="line-clamp-2 w-full break-all leading-tight text-foreground/85"
                        style={{ fontSize: Math.max(9, Math.round(10 * scale)) }}
                      >
                        {item.title}
                      </span>
                    )}
                  </div>
                );
              })}

              {/* 落点竖线：指示插入位置 */}
              {drop && (
                <div
                  className="pointer-events-none absolute z-20 w-0.5 rounded-full bg-brand shadow-[0_0_6px_var(--brand)]"
                  style={{ left: drop.x, top: drop.y, height: drop.h }}
                />
              )}
            </div>
          )}
          </div>
        </FileAreaContextMenu>

        {/* 翻页圆点 */}
        {pages > 1 && (
          <div className="flex shrink-0 items-center justify-center gap-1.5 pb-2">
            {Array.from({ length: pages }, (_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPage(i)}
                className={cn(
                  "size-1.5 rounded-full transition-all duration-200",
                  i === safePage ? "w-3 bg-brand" : "bg-muted-foreground/40 hover:bg-muted-foreground",
                )}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TitleBtn({
  title,
  active,
  danger,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded transition-colors",
        danger
          ? "text-muted-foreground hover:bg-red-500 hover:text-white"
          : active
            ? "text-brand"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
