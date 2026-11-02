import { useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Columns2, ExternalLink, LayoutList, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFiles, useFences, type FileCategory } from "@/stores/files";
import { inTauri, windowReady } from "@/lib/tauri";
import { openTarget } from "./open-target";
import { cn } from "@/lib/utils";
import { boxAppearance, boxDisplayName, boxFontFamily } from "./box-appearance";
import { ItemVisual } from "./file-preview";
import { logicalFenceGeometry } from "./fence-geometry";
import { restoreFenceOnDesktop } from "./desktop-actions";

const win = inTauri ? getCurrentWebviewWindow() : null;

/** 同色编组的宿主窗口：垂直分区（sections）或顶部 Tab。只读展示，条目仍归成员盒子。 */
export function FenceGroupWindow({ groupId }: { groupId: string }) {
  const { t } = useTranslation();
  const [hydrated, setHydrated] = useState(() => useFiles.persist.hasHydrated() && useFences.persist.hasHydrated());
  const categories = useFiles((s) => s.categories);
  const items = useFiles((s) => s.items);
  const group = useFences((s) => s.groups?.[groupId]);
  const setGroupLayout = useFences((s) => s.setGroupLayout);
  const setGroupGeometry = useFences((s) => s.setGroupGeometry);
  const setGroupOpen = useFences((s) => s.setGroupOpen);
  const setGroupActive = useFences((s) => s.setGroupActive);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ready = () => setHydrated(useFiles.persist.hasHydrated() && useFences.persist.hasHydrated());
    const offFiles = useFiles.persist.onFinishHydration(ready);
    const offFences = useFences.persist.onFinishHydration(ready);
    ready();
    return () => { offFiles(); offFences(); };
  }, []);

  const members = categories.filter((category) => category.groupColor?.toLowerCase() === groupId.toLowerCase());
  const activeId = group?.activeCategoryId && members.some((c) => c.id === group.activeCategoryId)
    ? group.activeCategoryId
    : members[0]?.id;
  const layout = group?.layout ?? "sections";
  const color = group?.color ?? groupId;

  useEffect(() => {
    void windowReady().catch(() => undefined);
    if (!win) return;
    void win.setAlwaysOnBottom(true).catch(() => undefined);
    const unClose = win.onCloseRequested((event) => {
      event.preventDefault();
      setGroupOpen(groupId, false);
      // 关闭宿主 = 合并结束：把成员栅栏按原几何恢复（open 没有被改过）。
      const members = useFiles.getState().categories.filter((category) => category.groupColor?.toLowerCase() === groupId.toLowerCase());
      for (const category of members) {
        if (useFences.getState().fences[category.id]?.open) {
          // reveal=true：合并期间成员窗口是被 hide 的，不是销毁；默认恢复会因 existing 提前返回。
          void restoreFenceOnDesktop(category.id, true).catch(() => undefined);
        }
      }
      void win.destroy().catch(() => undefined);
    });
    return () => { void unClose.then((fn) => fn()); };
  }, [groupId, setGroupOpen]);

  // 几何持久化：与 fence 的 paper 窗口同一套逻辑像素换算。
  useEffect(() => {
    if (!win) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const [position, size, scale] = await Promise.all([win.outerPosition(), win.outerSize(), win.scaleFactor()]);
          const geo = logicalFenceGeometry(position, size, scale);
          setGroupGeometry(groupId, geo);
        } catch { /* window may be closing */ }
      }, 300);
    };
    const unMoved = win.onMoved(save);
    const unResized = win.onResized(save);
    return () => {
      if (timer) clearTimeout(timer);
      void unMoved.then((fn) => fn());
      void unResized.then((fn) => fn());
    };
  }, [groupId, setGroupGeometry]);

  const startDrag = (event: React.PointerEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const sx = event.clientX;
    const sy = event.clientY;
    let started = false;
    const onMove = (next: PointerEvent) => {
      if (started) return;
      if (Math.hypot(next.clientX - sx, next.clientY - sy) < 4) return;
      started = true;
      cleanup();
      void win?.startDragging().catch(() => undefined);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
  };

  const open = (path: string, type: "folder" | "file" | "url") => {
    void openTarget(path, type).catch(() => undefined);
  };

  if (!hydrated) return null;
  if (!group) {
    return <div className="grid h-full place-items-center bg-card text-[12px] text-muted-foreground">{t("files.groupMissing")}</div>;
  }

  return (
    <div ref={panelRef} className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border bg-card/95 shadow-xl" style={{ fontFamily: boxFontFamily("system") }}>
      <header
        onPointerDown={startDrag}
        className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3 select-none"
      >
        <span className="size-3 rounded-full border border-black/10" style={{ background: color }} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{t("files.mergeHostTitle")}</span>
        <button type="button" onClick={() => setGroupLayout(groupId, layout === "sections" ? "tabs" : "sections")}
          title={layout === "sections" ? t("files.groupTabs") : t("files.groupSections")}
          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
          {layout === "sections" ? <Columns2 className="size-3.5" /> : <LayoutList className="size-3.5" />}
        </button>
        <button type="button" onClick={() => void win?.close()} title={t("titlebar.close")}
          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-[var(--close-hover-bg)] hover:text-[var(--close-hover-fg)]">
          <X className="size-3.5" />
        </button>
      </header>

      {members.length === 0 ? (
        <div className="grid min-h-40 flex-1 place-items-center px-4 text-center text-[12px] text-muted-foreground">{t("files.groupEmpty")}</div>
      ) : layout === "tabs" ? (
        <>
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/70 px-2 py-1.5">
            {members.map((category) => (
              <button key={category.id} type="button" onClick={() => setGroupActive(groupId, category.id)}
                aria-pressed={activeId === category.id}
                className={cn("shrink-0 rounded-md px-2 py-1 text-[11px]", activeId === category.id ? "bg-brand/10 text-brand" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
                {category.name}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {members.filter((category) => category.id === activeId).map((category) => (
              <GroupSection key={category.id} category={category} items={items} onOpen={open} />
            ))}
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {members.map((category) => (
            <section key={category.id} className="border-b border-border/60 px-2 py-2 last:border-b-0">
              <div className="mb-1 flex items-center gap-1.5 px-1">
                <span className="size-2 rounded-full" style={{ background: category.groupColor }} />
                <span className="text-[11px] font-semibold text-foreground">{category.name}</span>
                <span className="text-[10px] text-muted-foreground">{items.filter((item) => item.categoryId === category.id).length}</span>
              </div>
              <GroupSection category={category} items={items} onOpen={open} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function GroupSection({
  category,
  items,
  onOpen,
}: {
  category: FileCategory;
  items: ReturnType<typeof useFiles.getState>["items"];
  onOpen: (path: string, type: "folder" | "file" | "url") => void;
}) {
  const look = boxAppearance(category.appearance);
  const list = items.filter((item) => item.categoryId === category.id);
  if (list.length === 0) return <p className="px-1 py-2 text-[10px] text-muted-foreground">—</p>;
  return (
    <div
      className={cn(look.view === "list" ? "flex flex-col gap-0.5" : "grid gap-1.5")}
      style={{
        gridTemplateColumns: look.view === "list" ? undefined : `repeat(auto-fill, minmax(${Math.max(72, look.iconSize * 2.2)}px, 1fr))`,
        fontFamily: boxFontFamily(look.fontFamily) || undefined,
      }}
    >
      {list.map((item) => (
        <button
          key={item.id}
          type="button"
          onDoubleClick={() => onOpen(item.path, item.type)}
          title={item.type === "url" ? item.title : item.path}
          className={cn(
            "group flex min-w-0 items-center rounded-md border border-transparent hover:bg-muted",
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
          {look.view === "list" && item.type !== "url" && <ExternalLink className="ml-auto size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />}
        </button>
      ))}
    </div>
  );
}
