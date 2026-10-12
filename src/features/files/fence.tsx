import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Eye, EyeOff, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Providers } from "@/app/providers";
import { ItemIcon } from "@/features/files/icons";
import { useFiles, useFences, DEFAULT_FENCE } from "@/stores/files";
import { inTauri, probePaths, openPath, openUrl, dragOut, windowReady } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 12; // 4 列 × 3 行
const win = inTauri ? getCurrentWebviewWindow() : null;

/** 桌面悬浮栅栏窗口：透明面板 + 幽灵模式 + 翻页 + 拖入收集 + OLE 拖出 */
export function FenceWindow({ categoryId }: { categoryId: string }) {
  return (
    <Providers>
      <FencePanel categoryId={categoryId} />
    </Providers>
  );
}

function FencePanel({ categoryId }: { categoryId: string }) {
  const { t } = useTranslation();
  const categories = useFiles((s) => s.categories);
  const allItems = useFiles((s) => s.items); // 稳定引用，selector 内不得造新数组
  const addItems = useFiles((s) => s.addItems);
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

  const [page, setPage] = useState(0);
  const [hover, setHover] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);
  const dragOutBusy = useRef(false);
  const suppressClickUntil = useRef(0);

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

  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const pageItems = items.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const ghosted = fence.ghost && !hover;

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
          const valid = probed.filter((p) => p.kind !== "missing");
          if (!valid.length) return;
          addItems(
            valid.map((p) => ({
              categoryId,
              type: p.kind === "folder" ? ("folder" as const) : ("file" as const),
              title: p.name,
              path: p.path,
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
    const p = type === "url" ? openUrl(path).catch(() => toast.error(t("common.error"))) : openPath(path).catch(() => toast.error(t("common.error")));
    void p;
  };

  return (
    <div
      className="absolute inset-0 p-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        data-tauri-drag-region
        onWheel={(e) => {
          if (e.deltaY > 0) setPage((p) => Math.min(p + 1, pages - 1));
          else setPage((p) => Math.max(p - 1, 0));
        }}
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
        {/* 迷你标题栏（可拖拽移动窗口；双击名称 = 重命名分类） */}
        <div
          data-tauri-drag-region
          className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3 select-none"
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
          <button
            type="button"
            title={t("files.ghostToggle")}
            onClick={() => setGhost(categoryId, !fence.ghost)}
            className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {fence.ghost ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => void win?.close()}
            className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-red-500 hover:text-white"
          >
            <X className="size-3.5" />
          </button>
        </div>

        {/* 条目网格 */}
        <div className="min-h-0 flex-1 overflow-hidden p-2">
          {pageItems.length === 0 ? (
            <div className="grid h-full place-items-center px-4 text-center text-[11px] leading-relaxed text-muted-foreground">
              {t("files.fenceEmpty")}
            </div>
          ) : (
            <div className="grid h-full grid-cols-4 grid-rows-3 gap-1">
              {pageItems.map((item) => {
                const isLocal = item.type !== "url";
                return (
                  <button
                    key={item.id}
                    type="button"
                    title={t("files.dragOutHint")}
                    onMouseDown={(e) => startDragOut(e, item.path, isLocal)}
                    onClick={() => openItem(item.path, item.type)}
                    className="flex min-h-0 flex-col items-center justify-center gap-1 rounded-lg p-1 transition-colors hover:bg-surface-hover"
                  >
                    <ItemIcon
                      type={item.type}
                      path={item.path}
                      iconUrl={item.iconUrl}
                      className="size-7"
                    />
                    <span className="line-clamp-2 w-full break-all text-center text-[10px] leading-tight text-foreground/85">
                      {item.title}
                    </span>
                  </button>
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
