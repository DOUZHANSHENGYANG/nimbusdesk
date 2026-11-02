import { openPath, openUrl } from "@/lib/tauri";

/**
 * 打开条目指向的目标。
 *
 * 条目只有「路径」一种东西：网址是 `http(s)` 路径（进浏览器），文件/文件夹是
 * 磁盘路径（交给系统 shell）。所以这里按路径判断，不按 `item.type` 分支 ——
 * type 只是给图标和提示用的标签。
 */
export function openTarget(path: string, type?: "file" | "folder" | "url"): Promise<void> {
  const isUrl = type === "url" || /^https?:\/\//i.test(path);
  return isUrl ? openUrl(path) : openPath(path);
}
