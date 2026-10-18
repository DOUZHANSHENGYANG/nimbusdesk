import { probePaths, type PathKind } from "@/lib/tauri";
import { flushAllStorage } from "@/lib/storage";
import { useFiles } from "@/stores/files";

export interface FileImportResult {
  categoryId: string | null;
  added: number;
  duplicates: number;
  missing: number;
}

function pathIdentity(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Collect references only. Desktop fences retain their separate move-on-drop behavior. */
export async function importDroppedFiles(paths: string[], defaultCategoryName: string): Promise<FileImportResult> {
  const result: FileImportResult = { categoryId: null, added: 0, duplicates: 0, missing: 0 };
  if (!paths.length) return result;
  const probed = await probePaths(paths);

  // Probe is asynchronous: a parallel drop may have added these paths in the meantime.
  const state = useFiles.getState();
  const known = new Set(state.items.filter(item => item.type !== "url").map(item => pathIdentity(item.path)));
  const fresh: PathKind[] = [];
  for (const entry of probed) {
    if (entry.kind === "missing") { result.missing++; continue; }
    const key = pathIdentity(entry.path);
    if (known.has(key)) { result.duplicates++; continue; }
    known.add(key);
    fresh.push(entry);
  }

  if (fresh.length) {
    const defaults = new Set(["默认分类", "default", defaultCategoryName.trim().toLowerCase()]);
    const category = state.categories.find(item => !item.parentId && defaults.has(item.name.trim().toLowerCase()));
    const categoryId = category?.id ?? state.addCategory(defaultCategoryName.trim() || "默认分类");
    state.addItems(fresh.map(entry => ({
      categoryId,
      type: entry.kind as "file" | "folder",
      path: entry.path,
      title: entry.name || entry.path.split(/[\\/]/).filter(Boolean).pop() || entry.path,
      tags: [],
    })));
    result.categoryId = categoryId;
    result.added = fresh.length;
  }
  // Also drains a prior failed write when the user retries an already-collected drop.
  await flushAllStorage();
  return result;
}
