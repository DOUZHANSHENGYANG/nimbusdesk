import { invoke } from "@tauri-apps/api/core";

/** 数据目录信息 */
export async function getDataDir(): Promise<string> {
  return invoke<string>("get_data_dir");
}

export interface SetDataDirResult {
  dataDir: string;
  pointerFile: string;
  migrated: string[];
}

/** 更换数据目录（快照 SQLite3 并复制模块文件） */
export async function setDataDir(newDir: string): Promise<SetDataDirResult> {
  return invoke<SetDataDirResult>("set_data_dir", { newDir });
}

/** 读取 SQLite 模块状态；不存在返回 null。 */
export async function readJson<T>(key: string): Promise<T | null> {
  return invoke<T | null>("read_json", { key });
}

/** 写入 JSON（原子写） */
export async function writeJson(key: string, value: unknown, base?: { value: unknown }): Promise<unknown> {
  return invoke("write_json", { key, value, base });
}

/** 前端首帧就绪：通知 Rust 显示调用方窗口（防白闪） */
export async function windowReady(): Promise<void> {
  await invoke("window_ready");
}

/** 打开/聚焦某分类的桌面栅栏窗口 */
export async function openFence(
  categoryId: string,
  title: string,
  geo: { x: number; y: number; w: number; h: number },
): Promise<void> {
  await invoke("open_fence", { categoryId, title, x: Math.round(geo.x), y: Math.round(geo.y), w: Math.round(geo.w), h: Math.round(geo.h) });
}

/** 打开/聚焦某日的桌面待办纸片窗口 */
export async function openTodoPaper(
  date: string,
  title: string,
  geo: { x: number; y: number; w: number; h: number },
): Promise<void> {
  await invoke("open_todo_paper", {
    date,
    title,
    x: Math.round(geo.x),
    y: Math.round(geo.y),
    w: Math.round(geo.w),
    h: Math.round(geo.h),
  });
}

/** 关闭某日的待办纸片窗口 */
export async function closeTodoPaper(date: string): Promise<void> {
  await invoke("close_todo_paper", { date });
}

/** 当前已打开的待办纸片日期列表 */
export async function listTodoPapers(): Promise<string[]> {
  return invoke<string[]>("list_todo_papers");
}

/** 关闭某分类的栅栏窗口 */
export async function closeFence(categoryId: string): Promise<void> {
  await invoke("close_fence", { categoryId });
}

/** 探测本地路径类型（folder/file/missing）与名称 */
export interface PathKind {
  path: string;
  kind: "folder" | "file" | "missing";
  name: string;
}

export async function probePaths(paths: string[]): Promise<PathKind[]> {
  return invoke<PathKind[]>("probe_paths", { paths });
}

/** 发起 OLE 系统拖拽（阻塞至释放/取消） */
export async function dragOut(paths: string[]): Promise<void> {
  await invoke("drag_out", { paths });
}

/** 抓取网站元信息（title / description / favicon） */
export interface SiteMeta {
  title: string | null;
  description: string | null;
  iconUrl: string | null;
}

export async function fetchSiteMeta(url: string): Promise<SiteMeta> {
  return invoke<SiteMeta>("fetch_site_meta", { url });
}

/** 系统文件夹选择（OS 级对话框，仅用于目录/文件挑选） */
export async function pickFolder(): Promise<string | null> {
  return invoke<string | null>("pick_folder");
}

/** 系统文件选择（OS 级对话框） */
export async function pickFile(): Promise<string | null> {
  return invoke<string | null>("pick_file");
}

/** 用系统默认程序打开路径（文件/文件夹/URL） */
export async function openPath(path: string): Promise<void> {
  await invoke("open_path", { path });
}

export { openUrl } from "@tauri-apps/plugin-opener";

/** 在资源管理器中显示 */
export async function revealInExplorer(path: string): Promise<void> {
  await invoke("reveal_in_explorer", { path });
}

/* ── 真实磁盘文件操作（右键菜单用） ───────────────────── */

/** 在 parentDir 下新建文件夹/空文件，返回新路径 */
export async function createEntry(
  parentDir: string,
  name: string,
  kind: "folder" | "file",
): Promise<string> {
  return invoke<string>("create_entry", { parentDir, name, kind });
}

/** 重命名磁盘条目（同目录内），返回新路径 */
export async function renameEntry(path: string, newName: string): Promise<string> {
  return invoke<string>("rename_entry", { path, newName });
}

/** 删除到系统回收站（可撤销） */

/** 在 parentDir 下创建目录（递归），返回最终路径 */
export async function ensureDir(path: string): Promise<string> {
  return invoke<string>("ensure_dir", { path });
}

/**
 * 取 Windows 原生图标（PNG data URL；无图标返回 null）。
 *
 * @param size 目标边长（物理像素 = CSS 尺寸 × devicePixelRatio）。
 *   Rust 侧会从 jumbo 图像列表取图并做高质量缩小；
 *   省略则用系统原始尺寸（通常 256，适合交给浏览器缩放）。
 */
export async function nativeIcon(path: string, size?: number): Promise<string | null> {
  return invoke<string | null>("native_icon", { path, size: size ?? null });
}

/** 批量取原生图标（一次 IPC，栅栏一屏用）；size 含义同 nativeIcon */
export async function nativeIcons(paths: string[], size?: number): Promise<(string | null)[]> {
  return invoke<(string | null)[]>("native_icons", { paths, size: size ?? null });
}
export async function deleteEntry(path: string): Promise<void> {
  await invoke("delete_entry", { path });
}

/** 批量删除到回收站（一次可撤销操作） */
export async function deleteEntries(paths: string[]): Promise<void> {
  await invoke("delete_entries", { paths });
}

/** 预创建右键菜单浮窗（保持隐藏）。必须先创建再发菜单数据，否则事件丢失 */
export async function preparePopupMenu(): Promise<void> {
  await invoke("prepare_popup_menu");
}

/** 显示右键菜单浮窗（坐标为逻辑/CSS 像素，Rust 侧换算物理像素并夹到工作区） */
export async function showPopupMenu(
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<void> {
  await invoke("show_popup_menu", { x, y, w, h });
}

/** 隐藏右键菜单浮窗 */
export async function hidePopupMenu(): Promise<void> {
  await invoke("hide_popup_menu");
}

/* ── 备份 / 恢复 ──────────────────────────────────────── */

/** 弹出「另存为」选备份路径（取消返回 null） */
export async function pickBackupSavePath(defaultName: string): Promise<string | null> {
  return invoke<string | null>("pick_backup_save_path", { defaultName });
}

/** 弹出「打开」选备份文件（取消返回 null） */
export async function pickBackupOpenPath(): Promise<string | null> {
  return invoke<string | null>("pick_backup_open_path");
}

export interface BackupExport {
  path: string;
  bytes: number;
}

/** 原子写出备份文件 */
export async function writeBackup(path: string, content: string): Promise<BackupExport> {
  return invoke<BackupExport>("write_backup", { path, content });
}

/** 读入备份文件原文（上限 64MB） */
export async function readBackup(path: string): Promise<string> {
  return invoke<string>("read_backup", { path });
}

/** 扫描目录，返回相对路径列表（只含目录） */
export async function scanDirTree(root: string): Promise<string[]> {
  return invoke<string[]>("scan_dir_tree", { root });
}

/** 按相对路径重建目录，返回新建数量 */
export async function restoreDirTree(root: string, dirs: string[]): Promise<number> {
  return invoke<number>("restore_dir_tree", { root, dirs });
}

/** 是否运行在 Tauri 环境（浏览器 pnpm dev 时为 false） */
export const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface MovedFenceEntry {
  source: string;
  path: string;
  name: string;
  kind: "file" | "folder";
  sourceRetained?: boolean;
}
export interface FenceMoveResult {
  moved: MovedFenceEntry[];
  failed: { source: string; error: string }[];
}
export function moveFenceEntries(paths: string[], destination: string): Promise<FenceMoveResult> {
  return invoke("move_fence_entries", { paths, destination });
}
