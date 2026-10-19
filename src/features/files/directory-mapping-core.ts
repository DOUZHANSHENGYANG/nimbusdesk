import type { DirectorySnapshot } from "@/lib/tauri";
import type { FileItem } from "@/stores/files";

/** Windows Shell/canonical paths can use either extended or ordinary spelling. */
export function normalizedMappingPath(path: string): string {
  return path.trim().replace(/\\/g, "/")
    .replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "")
    .replace(/\/+$/, "").toLowerCase();
}

export function validatedMappingEntries(root: string, snapshot: DirectorySnapshot): DirectorySnapshot["entries"] {
  const normalizedRoot = normalizedMappingPath(root);
  if (!snapshot || typeof snapshot.root !== "string" || normalizedMappingPath(snapshot.root) !== normalizedRoot || !Array.isArray(snapshot.entries)) {
    throw new Error("目录快照与映射目录不一致，已保留原有条目。");
  }
  const seen = new Set<string>();
  return snapshot.entries.filter(entry => {
    if (!entry || typeof entry.path !== "string" || typeof entry.name !== "string" || !entry.name || /[\\/]/.test(entry.name) || (entry.kind !== "file" && entry.kind !== "folder")) {
      throw new Error("目录快照不完整，已保留原有条目。");
    }
    const path = normalizedMappingPath(entry.path);
    const segments = path.split("/");
    if (segments.some(part => part === "." || part === "..") || path.slice(0, path.lastIndexOf("/")) !== normalizedRoot) {
      throw new Error("目录快照包含映射范围之外的路径，已保留原有条目。");
    }
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

/** Only a successful complete snapshot can remove generated references. Never touches disk. */
export function reconcileDirectoryItems(
  items: FileItem[], categoryId: string, root: string, snapshot: DirectorySnapshot,
  uid: () => string, now: number,
): FileItem[] {
  const entries = validatedMappingEntries(root, snapshot);
  const byPath = new Map(entries.map(entry => [normalizedMappingPath(entry.path), entry]));
  const manual = new Set(items.filter(item => item.categoryId === categoryId && item.type !== "url" && !item.mappedRoot).map(item => normalizedMappingPath(item.path)));
  const represented = new Set(manual);
  const normalizedRoot = normalizedMappingPath(root);
  const result: FileItem[] = [];
  for (const item of items) {
    if (item.categoryId !== categoryId || !item.mappedRoot || normalizedMappingPath(item.mappedRoot) !== normalizedRoot) {
      result.push(item);
      continue;
    }
    const path = normalizedMappingPath(item.path);
    const entry = byPath.get(path);
    if (!entry || represented.has(path)) continue;
    represented.add(path);
    const basename = item.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    const title = item.title === basename ? entry.name : item.title;
    result.push(item.path === entry.path && item.type === entry.kind && item.title === title ? item
      : { ...item, path: entry.path, type: entry.kind, title, updatedAt: now });
  }
  for (const [path, entry] of byPath) {
    if (represented.has(path)) continue;
    result.push({ id: uid(), categoryId, type: entry.kind, path: entry.path, title: entry.name,
      tags: [], mappedRoot: root, createdAt: now, updatedAt: now });
  }
  return result.length === items.length && result.every((item, index) => item === items[index]) ? items : result;
}
