/**
 * 条目元信息缓存（size / mtime）。
 *
 * 为什么要缓存：条目一多（整目录映射时上千条），每次渲染或排序都去 stat 一遍磁盘
 * 会让文件页发涩。Pogget 的做法是把 `cachedName/Time/Size/Extension` 挂在条目上，
 * 目录变了再刷。这里照搬这个思路，但只存两样真正有用的：体积与修改时间。
 *
 * 分工：
 *  - 本文件是**纯函数**（筛选谁该刷新），可以在 `node --test` 里直接跑；
 *  - 真正的 `path_meta` 调用在 `use-meta-cache.ts`，只有桌面端才会发生。
 */
import type { FileItem } from "@/stores/files";

/** 缓存有效期：一天。文件页不是文件监视器，不需要秒级准确。 */
export const META_TTL = 24 * 60 * 60 * 1000;

/** 一轮最多刷这么多条，避免一次拉上千个 IPC */
export const REFRESH_CHUNK = 200;

/** 网页条目没有磁盘元信息，永远不刷 */
export function needsMetaRefresh(item: FileItem, now = Date.now()): boolean {
  if (item.type === "url") return false;
  if (item.size === undefined && item.mtime === undefined) return true;
  return now - (item.metaAt ?? 0) > META_TTL;
}

/** 本轮要刷新的条目：过期的优先，按顺序取前 limit 条 */
export function pickMetaTargets(items: FileItem[], now = Date.now(), limit = REFRESH_CHUNK): FileItem[] {
  const out: FileItem[] = [];
  for (const item of items) {
    if (out.length >= limit) break;
    if (needsMetaRefresh(item, now)) out.push(item);
  }
  return out;
}
