/**
 * 快捷访问目录：用户绑定的真实文件夹，只存路径。
 *
 * 它和收纳盒是两回事：收纳盒是「库」，快捷访问目录是磁盘上的真实位置。
 * 把条目或文件拖到它上面 = 把文件真的搬过去（`move_fence_entries`）。
 */
export interface QuickDir {
  id: string;
  /** 显示名：路径最后一段，不另起名字 */
  name: string;
  path: string;
}

/** 路径只用来显示最后一段，完整路径挂在 title 上 */
export function quickDirName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
