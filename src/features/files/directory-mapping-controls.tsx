import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderSync, Loader2, MoreHorizontal, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { fileDirectorySnapshot, openPath, pickFolder, type DirectorySnapshot } from "@/lib/tauri";
import { useFiles } from "@/stores/files";
import { normalizedMappingPath, validatedMappingEntries } from "./directory-mapping-core";
import { acceptMappedSnapshot, refreshMappedCategory, useDirectoryMappingStatus } from "./directory-mapping";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

function applyFolder(snapshot: DirectorySnapshot, categoryId: string | undefined, driveLabel: (drive: string) => string): string | null {
  validatedMappingEntries(snapshot.root, snapshot);
  const store = useFiles.getState();
  if (categoryId && !store.categories.some(category => category.id === categoryId)) return null;
  const existing = store.categories.find(category => category.syncDir && category.dir && normalizedMappingPath(category.dir) === normalizedMappingPath(snapshot.root));
  let id = categoryId ?? existing?.id;
  if (!id) {
    const leaf = snapshot.root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Folder";
    const base = /^[a-z]:$/i.test(leaf) ? driveLabel(leaf[0].toUpperCase()) : leaf;
    let name = base, suffix = 2;
    while (store.categories.some(category => !category.parentId && category.name.toLowerCase() === name.toLowerCase())) name = `${base} (${suffix++})`;
    id = store.addCategory(name);
  }
  store.setCategoryMapping(id, snapshot.root);
  acceptMappedSnapshot(id, snapshot.root, snapshot);
  return id;
}

function useMapFolder(categoryId?: string, onMapped?: (id: string) => void) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false), active = useRef(false), pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const map = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      const selected = await pickFolder();
      if (!selected || !active.current) return;
      // Validate a complete snapshot before creating a category or replacing a prior mapping.
      const snapshot = await fileDirectorySnapshot(selected);
      if (!active.current) return;
      const id = applyFolder(snapshot, categoryId, drive => t("files.mapping.drive", { drive }));
      if (id) { onMapped?.(id); toast.success(t("files.mapping.done")); }
    } catch (error) {
      if (active.current) toast.error(t("files.mapping.mapFailed"), { description: String(error) });
    } finally { pending.current = false; if (active.current) setBusy(false); }
  };
  return { busy, map };
}

export function MapFolderButton({ categoryId, onMapped }: { categoryId?: string; onMapped?: (id: string) => void }) {
  const { t } = useTranslation(), { busy, map } = useMapFolder(categoryId, onMapped);
  return <button type="button" disabled={busy} onClick={() => void map()}
    className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border px-3 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50">
    {busy ? <Loader2 className="size-3.5 animate-spin" /> : <FolderSync className="size-3.5" />}
    {t(categoryId ? "files.mapping.mapCategory" : "files.mapping.add")}
  </button>;
}

/** Mapping controls belong to the selected category; the file/fence list uses the shared store. */
export function CategoryMappingBar({ categoryId }: { categoryId: string }) {
  const { t } = useTranslation();
  const category = useFiles(state => state.categories.find(item => item.id === categoryId));
  const status = useDirectoryMappingStatus(categoryId);
  const count = useFiles(state => state.items.filter(item => item.categoryId === categoryId && item.mappedRoot).length);
  const { busy, map } = useMapFolder(categoryId);
  if (!category) return null;
  if (!category.syncDir || !category.dir) return <div className="flex justify-end"><MapFolderButton categoryId={categoryId} /></div>;
  return <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 pb-3 text-xs">
    <FolderSync className="size-4 shrink-0 text-brand" />
    <button type="button" aria-label={t("files.mapping.mappedFolder")} title={category.dir}
      onClick={() => void openPath(category.dir!).catch(() => toast.error(t("files.openErr")))}
      className="min-w-0 max-w-full flex-1 truncate text-left text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand">{category.dir}</button>
    <span role="status" aria-live="polite" title={status.error || t("files.mapping.auto")} className={status.error ? "text-destructive" : "text-muted-foreground"}>
      {status.busy ? t("files.mapping.syncing") : status.error ? t("files.mapping.failed") : t("files.mapping.synced", { count: status.count ?? count })}
    </span>
    <button type="button" aria-label={t("files.mapping.refresh")} title={t("files.mapping.refresh")} disabled={status.busy || busy}
      onClick={() => void refreshMappedCategory(categoryId).catch(() => undefined)}
      className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50">
      <RefreshCw className={`size-3.5 ${status.busy ? "animate-spin" : ""}`} />
    </button>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><button type="button" aria-label={t("files.mapping.options")} title={t("files.mapping.options")} disabled={busy}
        className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50"><MoreHorizontal className="size-4" /></button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void map()}>{t("files.mapping.change")}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => { useFiles.getState().setCategoryMapping(categoryId, null); toast.success(t("files.mapping.unmapped")); }}>{t("files.mapping.unmap")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}
