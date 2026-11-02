/**
 * 条目在收纳盒之间移动（对应「从盒子里拖出来、拖进另一个盒子」）。
 *
 * 两种目标盒语义不同：
 * - 目标不是存储盒：只改条目归属，文件留在原处（路径仍然有效）。存储盒里出来的条目
 *   会留在 `stash/<旧分类id>/` 里，仍然是那份副本。
 * - 目标是存储盒：存储盒的语义就是「文件搬进来」，所以真的把文件移进
 *   `stash/<新分类id>/`（走 Rust 的 `stash_import`），条目指向新路径。
 * - 映射盒既不作为来源也不作为目标：它的内容归磁盘目录管。
 */
import { invoke } from "@tauri-apps/api/core";
import { categoryKind, useFiles, type CategoryKind, type FileItem } from "@/stores/files";
import { inTauri } from "@/lib/tauri";

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export interface MovePlan {
  /** 真正要搬的条目（网址条目与已在目标盒里的排除掉） */
  movable: FileItem[];
  /** 是否要把磁盘文件一起搬（目标盒是存储盒） */
  physical: boolean;
}

/** 纯决策：搬哪些、要不要动磁盘。`node --test` 直接覆盖 */
export function planBoxMove(items: FileItem[], targetKind: CategoryKind, targetId: string): MovePlan {
  if (targetKind === "mapped") return { movable: [], physical: false };
  // 网址条目没有磁盘文件，但它同样属于某个盒子——归属要跟着走，只是不参与搬文件。
  const movable = items.filter((item) => item.categoryId !== targetId);
  return { movable, physical: targetKind === "storage" && movable.some((item) => item.type !== "url") };
}

export interface MoveOutcome {
  moved: number;
  failed: number;
  /** 是否真的把文件搬到了新目录（搬了就不做"改回分类"式撤销，避免路径与归属不一致） */
  physical: boolean;
}

export async function moveItemsToBox(itemIds: string[], targetId: string): Promise<MoveOutcome> {
  const state = useFiles.getState();
  const target = state.categories.find((category) => category.id === targetId);
  if (!target) return { moved: 0, failed: 0, physical: false };

  const picked = state.items.filter((item) => itemIds.includes(item.id));
  const { movable, physical } = planBoxMove(picked, categoryKind(target), targetId);
  if (!movable.length) return { moved: 0, failed: 0, physical: false };

  // 浏览器预览里没有原生 IPC：退化成只改归属，别把交互弄断
  if (!physical || !inTauri) {
    for (const item of movable) state.updateItem(item.id, { categoryId: targetId });
    return { moved: movable.length, failed: 0, physical: false };
  }

  const files = movable.filter((item) => item.type !== "url");
  const moved = await invoke<string[]>("stash_import", {
    categoryId: targetId,
    paths: files.map((item) => item.path),
  });
  const byName = new Map(moved.map((path) => [basename(path), path]));
  let ok = 0;
  let failed = 0;
  for (const item of movable) {
    if (item.type === "url") {
      // 网址条目只改归属
      state.updateItem(item.id, { categoryId: targetId });
      ok++;
      continue;
    }
    const next = byName.get(basename(item.path));
    if (!next) {
      failed++;
      continue;
    }
    state.updateItem(item.id, { path: next, title: basename(next), categoryId: targetId });
    ok++;
  }
  return { moved: ok, failed, physical: true };
}
