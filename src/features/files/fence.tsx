import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Eye, EyeOff, X, Pin, PinOff, GripVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Providers } from "@/app/providers";
import { useFiles, useFences, DEFAULT_FENCE } from "@/stores/files";
import { inTauri, probePaths, openPath, openUrl, dragOut, windowReady } from "@/lib/tauri";
import { ItemIcon } from "@/features/files/icons";
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
  const reorderItem = useFiles((s) => s.reorderItem);
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
  const [gridSize, setGridSize] = useState({ w: 0, h: 0 });
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

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

  /* ── 拖出：按住条目移动即发起 OLE 拖拽 ── */
  const startDragOut = (e: React.MouseEvent, path: string, isLocal: boolean) => {
    if (!isLocal || dragOutBusy.current || !win) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let started = false;

    const onMove = (ev: MouseEvent) => {
      if (started) return;
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      started = true;
      dragOutBusy.current = true;
      setHover(true);
      suppressClickUntil.current = Date.now() + 800;
      void dragOut([path])
        .catch(() => undefined)
        .finally(() => {
          dragOutBusy.current = false;
        });
      cleanup();
    };
    const onUp = () => cleanup();
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
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

        {/* 条目网格（自适应行列，名称不截断） */}
        <div ref={gridWrapRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
          {pageItems.length === 0 ? (
            <div className="grid h-full place-items-center px-4 text-center text-[11px] leading-relaxed text-muted-foreground">
              {t("files.fenceEmpty")}
            </div>
          ) : (
            <div
              className="mx-auto grid"
              style={{
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gap: GAP,
                maxWidth: cols * (cellW + GAP),
              }}
            >
              {pageItems.map((item) => {
                const isLocal = item.type !== "url";
                const isOver = overId === item.id && dragId !== null && dragId !== item.id;
                return (
                  <div
                    key={item.id}
                    onDragOver={(e) => {
                      if (!dragId) return;
                      e.preventDefault();
                      setOverId(item.id);
                    }}
                    onDragLeave={() => setOverId((v) => (v === item.id ? null : v))}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragId) reorderItem(dragId, item.id);
                      setDragId(null);
                      setOverId(null);
                    }}
                    className={cn(
                      "group relative flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg p-1 transition-colors hover:bg-surface-hover",
                      isOver && "ring-2 ring-brand bg-brand/10",
                    )}
                    style={{ height: cellH }}
                  >
                    {/* 排序手柄：悬停浮现，拖拽=排序（不与 OLE 拖出冲突） */}
                    <div
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", `reorder:${item.id}`);
                        setDragId(item.id);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setOverId(null);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      title={t("files.reorderHint")}
                      className="absolute -top-0.5 left-0 z-10 grid size-4 cursor-grab place-items-center rounded text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/70 active:cursor-grabbing"
                    >
                      <GripVertical className="size-3" />
                    </div>

                    <button
                      type="button"
                      title={t("files.dragOutHint")}
                      onMouseDown={(e) => startDragOut(e, item.path, isLocal)}
                      onClick={() => openItem(item.path, item.type)}
                      className="flex h-full w-full flex-col items-center justify-center gap-1 rounded-lg p-1 text-center"
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
                      <span
                        className="line-clamp-2 w-full break-all leading-tight text-foreground/85"
                        style={{ fontSize: Math.max(9, Math.round(10 * scale)) }}
                      >
                        {item.title}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

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
