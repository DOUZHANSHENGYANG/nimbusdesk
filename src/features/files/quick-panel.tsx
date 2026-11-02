import { useEffect, useMemo, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Columns2, ExternalLink, LayoutGrid, List, Plus, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useFiles, sortedTopCategories, categoryKind, type FileCategory, type FileItem } from "@/stores/files";
import { inTauri, windowReady } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { boxAppearance, boxDisplayName, boxFontFamily } from "./box-appearance";
import { ItemVisual } from "./file-preview";
import { moveItemsToBox } from "./move-between-boxes";
import { openTarget } from "./open-target";

interface Pane {
  id: string;
  categoryId: string | null;
  search: string;
}

let paneSeq = 1;
const newPane = (categoryId: string | null): Pane => ({ id: `pane-${paneSeq++}`, categoryId, search: "" });

/** 快速面板：左侧所有盒子，右侧可拆 1–3 个 pane；双击打开、拖拽跨盒移动。 */
export function QuickPanelWindow() {
  const [hydrated, setHydrated] = useState(() => useFiles.persist.hasHydrated());
  useEffect(() => {
    const ready = () => setHydrated(useFiles.persist.hasHydrated());
    const off = useFiles.persist.onFinishHydration(ready);
    ready();
    return off;
  }, []);
  return hydrated ? <QuickPanelSurface /> : null;
}

function QuickPanelSurface() {
  const { t, i18n } = useTranslation();
  const categories = useFiles((s) => s.categories);
  const items = useFiles((s) => s.items);
  const setCategoryAppearance = useFiles((s) => s.setCategoryAppearance);
  const top = useMemo(() => sortedTopCategories(categories), [categories]);
  const [panes, setPanes] = useState<Pane[]>(() => [newPane(null)]);
  const [activePane, setActivePane] = useState<string | null>(null);

  // 首帧挂载后显示窗口；否则 Rust 侧创建的窗口一直 visible:false。
  useEffect(() => {
    void windowReady().catch(() => undefined);
  }, []);

  // 首次 hydrate 后给第一个 pane 选一个盒子。
  useEffect(() => {
    if (panes.some((pane) => pane.categoryId) || top.length === 0) return;
    setPanes((current) => current.map((pane, index) => index === 0 ? { ...pane, categoryId: top[0].id } : pane));
  }, [top, panes]);

  useEffect(() => {
    if (activePane && panes.some((pane) => pane.id === activePane)) return;
    setActivePane(panes[0]?.id ?? null);
  }, [activePane, panes]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        if (inTauri) void getCurrentWebviewWindow().hide().catch(() => undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selectCategory = (categoryId: string) => {
    const target = activePane ?? panes[0]?.id;
    setPanes((current) => current.map((pane) => pane.id === target ? { ...pane, categoryId } : pane));
  };
  const patchPane = (id: string, patch: Partial<Pane>) => setPanes((current) => current.map((pane) => pane.id === id ? { ...pane, ...patch } : pane));
  const split = () => {
    const source = panes.find((pane) => pane.id === activePane) ?? panes[panes.length - 1];
    if (panes.length >= 3) return;
    const next = newPane(source?.categoryId ?? top[0]?.id ?? null);
    setPanes((current) => [...current, next]);
    setActivePane(next.id);
  };
  const closePane = (id: string) => {
    if (panes.length <= 1) return;
    setPanes((current) => current.filter((pane) => pane.id !== id));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      {/* 顶栏：拖拽区 + 关闭。面板内没有原生标题栏。 */}
      <header data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-3 select-none">
        <span data-tauri-drag-region className="text-[13px] font-semibold">{t("files.quickPanelTitle")}</span>
        <span data-tauri-drag-region className="min-w-0 truncate text-[11px] text-muted-foreground">{t("files.quickPanelHint")}</span>
        <span className="flex-1" data-tauri-drag-region />
        <button type="button" onClick={split} title={t("files.quickPanelSplit")} aria-label={t("files.quickPanelSplit")}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-35"
          disabled={panes.length >= 3}>
          <Columns2 className="size-4" />
        </button>
        <button type="button" onClick={() => inTauri && void getCurrentWebviewWindow().hide()}
          title={t("files.quickPanelClose")} aria-label={t("files.quickPanelClose")}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="size-4" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左：所有盒子 */}
        <aside className="flex w-[190px] shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar p-2">
          <p className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t("files.quickPanelBoxes")}</p>
          {top.map((category) => (
            <BoxRailItem
              key={category.id}
              category={category}
              count={items.filter((item) => item.categoryId === category.id).length}
              active={panes.find((pane) => pane.id === activePane)?.categoryId === category.id}
              onClick={() => selectCategory(category.id)}
            />
          ))}
          {top.length === 0 && <p className="px-2 py-4 text-[11px] leading-relaxed text-muted-foreground">{t("files.boxWallEmpty")}</p>}
        </aside>

        {/* 右：可拆 pane */}
        <main className="flex min-w-0 flex-1 gap-2 overflow-x-auto bg-muted/25 p-2">
          {panes.map((pane) => (
            <QuickPane
              key={pane.id}
              pane={pane}
              categories={categories}
              items={items}
              active={pane.id === activePane}
              canClose={panes.length > 1}
              onActivate={() => setActivePane(pane.id)}
              onPatch={(patch) => patchPane(pane.id, patch)}
              onClose={() => closePane(pane.id)}
              onSplit={split}
              onSetView={(category, view) => setCategoryAppearance(category.id, { view })}
              onMove={(itemId, categoryId) => void moveItemsToBox([itemId], categoryId).then((outcome) => {
                if (outcome.moved > 0) toast.success(i18n.language.startsWith("en") ? "Moved" : "已移动");
                else if (outcome.failed > 0) toast.error(i18n.language.startsWith("en") ? "Move failed" : "移动失败");
              }).catch((error) => toast.error(String(error)))}
            />
          ))}
        </main>
      </div>
    </div>
  );
}

function BoxRailItem({ category, count, active, onClick }: { category: FileCategory; count: number; active: boolean; onClick: () => void }) {
  const kind = categoryKind(category);
  const color = kind === "mapped" ? "var(--kind-mapped)" : kind === "storage" ? "var(--kind-storage)" : "var(--kind-shortcut)";
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn("flex min-h-8 items-center gap-2 rounded-md px-2 text-left text-[12px]", active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
      <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="min-w-0 flex-1 truncate">{category.name}</span>
      <span className="text-[10px] tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}

function QuickPane({
  pane, categories, items, active, canClose, onActivate, onPatch, onClose, onSplit, onSetView, onMove,
}: {
  pane: Pane;
  categories: FileCategory[];
  items: FileItem[];
  active: boolean;
  canClose: boolean;
  onActivate: () => void;
  onPatch: (patch: Partial<Pane>) => void;
  onClose: () => void;
  onSplit: () => void;
  onSetView: (category: FileCategory, view: "icons" | "list") => void;
  onMove: (itemId: string, categoryId: string) => void;
}) {
  const { t } = useTranslation();
  const category = categories.find((entry) => entry.id === pane.categoryId) ?? null;
  const look = boxAppearance(category?.appearance);
  const [dragOver, setDragOver] = useState(false);
  const filtered = useMemo(() => {
    const q = pane.search.trim().toLowerCase();
    return items
      .filter((item) => item.categoryId === category?.id)
      .filter((item) => !q || item.title.toLowerCase().includes(q) || item.path.toLowerCase().includes(q));
  }, [items, category?.id, pane.search]);

  const open = (item: FileItem) => {
    void openTarget(item.path, item.type).catch(() => toast.error(t("files.openErr")));
  };

  return (
    <section
      data-quick-pane
      data-active={active}
      onPointerDown={onActivate}
      onDragOver={(event) => { if (event.dataTransfer.types.includes("text/x-nimbus-item")) { event.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        setDragOver(false);
        const itemId = event.dataTransfer.getData("text/x-nimbus-item");
        if (itemId && category && itemId) onMove(itemId, category.id);
      }}
      className={cn(
        "flex min-w-[260px] flex-1 basis-0 flex-col overflow-hidden rounded-lg border bg-card",
        active ? "border-brand/60 ring-1 ring-brand/20" : "border-border",
        dragOver && "border-brand bg-brand/5",
      )}
      style={{
        background: dragOver
          ? undefined
          : `color-mix(in oklch, var(--card) ${Math.round(look.backgroundAlpha * 100)}%, transparent)`,
        borderRadius: look.radius,
      }}
    >
      <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/70 px-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{category?.name ?? t("files.quickPanelPickBox")}</span>
        <span className="text-[10px] tabular-nums text-muted-foreground">{filtered.length}</span>
        {category && (
          <button type="button" onClick={() => onSetView(category, look.view === "list" ? "icons" : "list")}
            title={look.view === "list" ? t("files.appearanceIcons") : t("files.appearanceList")}
            className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
            {look.view === "list" ? <LayoutGrid className="size-3.5" /> : <List className="size-3.5" />}
          </button>
        )}
        <button type="button" onClick={onSplit} title={t("files.quickPanelSplit")} aria-label={t("files.quickPanelSplit")}
          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
          <Plus className="size-3.5" />
        </button>
        <button type="button" onClick={onClose} disabled={!canClose} title={t("files.quickPanelClosePane")} aria-label={t("files.quickPanelClosePane")}
          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30">
          <X className="size-3.5" />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
          <Search className="size-3.5 text-muted-foreground" />
          <input value={pane.search} onChange={(e) => onPatch({ search: e.target.value })}
            placeholder={t("files.boxSearchPlaceholder")} aria-label={t("files.boxSearch")}
            className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/60" />
          {pane.search && <button type="button" onClick={() => onPatch({ search: "" })} aria-label={t("files.boxSearchClear")}><X className="size-3 text-muted-foreground" /></button>}
        </div>
        <div className={cn("min-h-0 flex-1 overflow-y-auto p-2", look.view === "list" ? "flex flex-col gap-1" : "grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-1.5")}
          style={{ fontFamily: boxFontFamily(look.fontFamily) || undefined }}>
          {filtered.length === 0 ? (
            <p className="col-span-full grid h-full place-items-center px-3 text-center text-[11px] text-muted-foreground">
              {pane.search ? t("files.boxNoMatch") : t("files.boxEmptyHint")}
            </p>
          ) : filtered.map((item) => (
            <button
              key={item.id}
              type="button"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData("text/x-nimbus-item", item.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDoubleClick={() => open(item)}
              title={item.type === "url" ? item.title : item.path}
              className={cn(
                "group flex min-w-0 items-center rounded-md border border-transparent text-left transition-colors hover:bg-muted",
                look.view === "list" ? "flex-row gap-2 px-2 py-1" : "flex-col justify-start gap-1 px-1 py-1.5 text-center",
              )}
            >
              <ItemVisual item={item} size={look.view === "list" ? Math.min(24, look.iconSize) : look.iconSize} appearance={look} />
              {look.nameMode !== "none" && (
                <span className={cn("w-full text-foreground/85", look.view === "list" ? "truncate text-left" : "line-clamp-2 break-all")}
                  style={{ fontSize: Math.max(8, look.fontSize) }}>
                  {boxDisplayName(item.title, look.nameMode)}
                </span>
              )}
              {look.view === "list" && item.type !== "url" && (
                <ExternalLink className="ml-auto size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
              )}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
