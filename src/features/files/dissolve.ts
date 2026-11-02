/**
 * 解散收纳盒。
 *
 * 两种语义刻意不同：
 * - **映射盒**：内容只是磁盘目录的镜像。解散＝解除映射 —— 盒子与条目从库里消失，
 *   磁盘上的文件一个都不动。（把条目「散落」出去反而更危险：条目指着别人的目录，
 *   用户会以为文件被搬走了。）
 * - **其他盒（快捷 / 存储）**：条目是真的收在这里的东西，解散＝散到另一个盒子里；
 *   若没有别的盒子可收，条目从库里移除、文件仍留在原处（不留孤儿条目）。
 *   存储盒的文件仍在 `<数据目录>/stash/<旧分类id>/` 里，路径不变。
 *
 * 只做 store 层的账，不碰磁盘；调用方负责先关掉桌面栅栏。
 */
import { categoryKind, useFiles, type CategoryKind } from "@/stores/files";

export type DissolveOutcome =
  | { ok: true; kind: "mapped"; dropped: number; movedTo: null }
  | { ok: true; kind: Exclude<CategoryKind, "mapped">; moved: number; movedTo: string }
  /** 没有别的盒子可接收：条目从库里移除，文件不动 */
  | { ok: true; kind: Exclude<CategoryKind, "mapped">; moved: 0; movedTo: null; orphaned: number }
  | { ok: false; reason: "missing" | "has-children" };

export function dissolveBox(categoryId: string): DissolveOutcome {
  const state = useFiles.getState();
  const category = state.categories.find((c) => c.id === categoryId);
  if (!category) return { ok: false, reason: "missing" };
  // 有子分类时不动：连带删掉一整个子树不是「解散」该有的意外
  if (state.categories.some((c) => c.parentId === categoryId)) return { ok: false, reason: "has-children" };

  const own = state.items.filter((item) => item.categoryId === categoryId);
  const kind = categoryKind(category);

  if (kind === "mapped") {
    for (const item of own) state.removeItem(item.id);
    state.removeCategory(categoryId);
    return { ok: true, kind: "mapped", dropped: own.length, movedTo: null };
  }

  // 接收方：优先非映射盒（映射盒不接手工条目），否则任取一个别的盒子
  const others = state.categories.filter((c) => c.id !== categoryId && !c.parentId);
  const target = others.find((c) => categoryKind(c) !== "mapped") ?? others[0];
  if (!target) {
    // 没有别的盒子：条目从库里移除，文件一个都不动
    for (const item of own) state.removeItem(item.id);
    state.removeCategory(categoryId);
    return { ok: true, kind, moved: 0, movedTo: null, orphaned: own.length };
  }
  for (const item of own) state.updateItem(item.id, { categoryId: target.id });
  state.removeCategory(categoryId);
  return { ok: true, kind, moved: own.length, movedTo: target.id };
}
