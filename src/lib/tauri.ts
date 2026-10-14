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

/** 更换数据目录（自动迁移全部 *.json） */
export async function setDataDir(newDir: string): Promise<SetDataDirResult> {
  return invoke<SetDataDirResult>("set_data_dir", { newDir });
}

/** 读取 JSON（key 如 "settings"，对应 <dataDir>/settings.json；不存在返回 null） */
export async function readJson<T>(key: string): Promise<T | null> {
  return invoke<T | null>("read_json", { key });
}

/** 写入 JSON（原子写） */
export async function writeJson(key: string, value: unknown): Promise<void> {
  await invoke("write_json", { key, value });
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
export async function deleteEntry(path: string): Promise<void> {
  await invoke("delete_entry", { path });
}

/** 批量删除到回收站（一次可撤销操作） */
export async function deleteEntries(paths: string[]): Promise<void> {
  await invoke("delete_entries", { paths });
}

/** 是否运行在 Tauri 环境（浏览器 pnpm dev 时为 false） */
export const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
