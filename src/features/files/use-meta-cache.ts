/**
 * 元信息缓存的原生侧：把 `path_meta` 的结果写回条目。
 *
 * 只在桌面端跑；浏览器预览里 `inTauri` 为假，直接跳过（夹具页也因此不发 IPC）。
 * 每轮最多 `REFRESH_CHUNK` 条，写完自然收敛：`patchItemMeta` 会打上新的 `metaAt`，
 * 下一轮就筛不到它们了。
 */
import { useEffect, useRef } from "react";
import { inTauri, pathMeta } from "@/lib/tauri";
import { useFiles, type FileItem } from "@/stores/files";
import { pickMetaTargets } from "./meta-cache";

export function useItemMetaRefresh(items: FileItem[]) {
  const patchItemMeta = useFiles((s) => s.patchItemMeta);
  const running = useRef(false);

  useEffect(() => {
    if (!inTauri || running.current) return;
    const targets = pickMetaTargets(items);
    if (!targets.length) return;
    running.current = true;
    void (async () => {
      try {
        const metas = await pathMeta(targets.map((item) => item.path));
        const byPath = new Map(metas.map((meta) => [meta.path, meta]));
        const updates = targets.flatMap((item) => {
          const meta = byPath.get(item.path);
          if (!meta) return [];
          return [{ id: item.id, size: meta.size, mtime: meta.modified }];
        });
        if (updates.length) patchItemMeta(updates);
      } catch {
        /* 读不到元信息不影响主流程：下一轮还会再试 */
      } finally {
        running.current = false;
      }
    })();
  }, [items, patchItemMeta]);
}
