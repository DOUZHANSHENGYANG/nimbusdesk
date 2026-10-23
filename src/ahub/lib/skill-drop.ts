/**
 * 「添加技能 → 从文件导入」里拖放那一小段逻辑。
 *
 * 拆成纯函数是因为拖放本身没法在单测里跑（Tauri 的 drop 事件只给绝对路径和光标位置，
 * 需要真实 webview）。这里只管判断：拖进来的是 zip 还是文件夹、落在哪张卡上、
 * 直接导入失败时要不要转去「探查 + 向导」。
 */

export type DroppedKind = "zip" | "folder";

/** `.zip` 走压缩包导入，其余一律当文件夹（Tauri 给的是绝对路径，没有 MIME 可依赖）。 */
export function classifyDroppedPath(path: string): DroppedKind {
  return /\.zip$/i.test(path.trim()) ? "zip" : "folder";
}

/** 一次拖多个时按类分开：同一个入口既能收“一堆技能目录”，也能收“一个压缩包”。 */
export function splitDroppedPaths(paths: readonly string[]): { folders: string[]; zips: string[] } {
  const folders: string[] = [];
  const zips: string[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (!path) continue;
    (classifyDroppedPath(path) === "zip" ? zips : folders).push(path);
  }
  return { folders, zips };
}

/**
 * 直接导入只在「这一层目录自己就是技能」时成立；拖进来的是一个装着若干技能的父目录时，
 * 后端会报 `no SKILL.md in …`——这时该交给探查（逐个下钻找候选）+ 向导，而不是当失败弹红字。
 */
export function needsExplore(message: string): boolean {
  return /no SKILL\.md/i.test(message) || /缺少\s*SKILL\.md/i.test(message) || /not a skill/i.test(message);
}

export interface DropRect { left: number; top: number; right: number; bottom: number }

/** 光标落在哪张卡上。Tauri 的 drop 只给位置，不给元素，所以自己拿 boundingClientRect 比。 */
export function slotAtPoint(rects: { folder?: DropRect | null; zip?: DropRect | null }, x: number, y: number): DroppedKind | null {
  const inside = (rect?: DropRect | null) => Boolean(rect) && x >= rect!.left && x <= rect!.right && y >= rect!.top && y <= rect!.bottom;
  if (inside(rects.folder)) return "folder";
  if (inside(rects.zip)) return "zip";
  return null;
}
