/**
 * 条目显示名的三种模式（照 Pogget 的 `HideFileExtension`：显示 / 隐藏扩展名 / 只留扩展名）。
 *
 * 只影响**显示**，不动磁盘文件名 —— 栅栏一格只有几十像素，`.docx` 这种尾巴经常把
 * 真正有用的部分挤掉。
 */

export type FileNameMode = "full" | "noExt" | "extOnly";

/** 常见的多点文件名（`a.tar.gz`）只切最后一段 */
export function displayName(title: string, mode: FileNameMode = "full"): string {
  if (mode === "full") return title;
  const dot = title.lastIndexOf(".");
  // 没有扩展名，或点在开头（.gitignore）/ 结尾（"名字."）都不算扩展名
  const hasExt = dot > 0 && dot < title.length - 1;
  if (!hasExt) return title;
  return mode === "noExt" ? title.slice(0, dot) : title.slice(dot + 1);
}
