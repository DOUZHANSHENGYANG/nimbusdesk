/**
 * 一键全量备份 / 恢复。
 *
 * ## 备份包含什么
 * - 数据目录下的全部 `*.json`（settings / files / fences / plans / plans-archive …）
 * - 分类根目录的**目录结构清单**（只记文件夹名，不含里面的实际文件）
 *
 * 不打包 `categories/` 里的真实文件：那可能是几个 GB，塞进 JSON 既不现实也没必要。
 * 用户真正会丢的是「分类树长什么样」，而这一点清单就够了。
 *
 * ## 恢复语义：合并，不是覆盖
 * - 同 id：比 `updatedAt`，新的胜
 * - 只有备份里有 → 新增
 * - 只有本机有 → **永不删除**
 *
 * 这个方向是刻意的。恢复是「找回自己的数据」，宁可多留也不错删 —— 与
 * 「导入」（引入外部数据、宁可整体拒绝）正好相反。
 * 另外 `settings` 默认**不覆盖本机值**：从备份恢复数据不该顺手把你的
 * 主题、语言、数据目录改回旧值。
 */

import {
  pickBackupOpenPath,
  pickBackupSavePath,
  readBackup,
  readJson,
  restoreDirTree,
  scanDirTree,
  writeBackup,
  writeJson,
  type BackupExport,
} from "@/lib/tauri";
import { flushAllStorage } from "@/lib/storage";
import { useSettings } from "@/stores/settings";

/** 备份文件格式版本（与各 store 自己的 version 是两件事） */
export const BACKUP_SCHEMA = 1;

/** 备份里会带上的数据 key。顺序即展示顺序 */
export const BACKUP_KEYS = ["settings", "files", "fences", "plans", "plans-archive"] as const;
export type BackupKey = (typeof BACKUP_KEYS)[number];

export interface BackupFile {
  kind: "nimbusdesk-backup";
  schema: number;
  app: string;
  exportedAt: string;
  /** key → 该 key 的原始落盘内容（zustand persist 的 `{ state, version }` 或裸对象） */
  data: Partial<Record<BackupKey, unknown>>;
  /** 分类根目录的相对路径清单（仅目录） */
  dirs?: string[];
  /** 分类根目录的绝对路径（仅供恢复时知道往哪建） */
  root?: string | null;
}

export interface MergeStats {
  added: number;
  updated: number;
  skipped: number;
}

/** 取「这个包里实际有内容」的 key（老备份可能缺某些 key） */
export function backupKeysOf(file: BackupFile): BackupKey[] {
  return BACKUP_KEYS.filter((k) => file.data?.[k] != null);
}

/**
 * 解析并做最小校验。
 *
 * 只校验「是不是我们的备份」这一层；各 store 的内容由它们自己的
 * `migrate` / 读取路径兜底 —— 备份里存的本来就是从磁盘读出来的原样内容，
 * 再多做一层 schema 校验只会重复且容易与 store 漂移。
 */
export function parseBackup(text: string): BackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== "object") throw new Error("not-an-object");
  const file = raw as Partial<BackupFile>;
  if (file.kind !== "nimbusdesk-backup") throw new Error("not-a-nimbusdesk-backup");
  if (typeof file.schema !== "number" || file.schema > BACKUP_SCHEMA) {
    throw new Error(`unsupported-schema:${String(file.schema)}`);
  }
  if (!file.data || typeof file.data !== "object") throw new Error("no-data");
  return file as BackupFile;
}

/** 按 id 取「较新的那个」。缺 `updatedAt` 时退化为「保留本机」（保守优先） */
function newer<T extends { updatedAt?: number; createdAt?: number }>(
  local: T | undefined,
  incoming: T,
): { value: T; replaced: boolean } {
  if (!local) return { value: incoming, replaced: false };
  const lt = local.updatedAt ?? local.createdAt ?? 0;
  const it = incoming.updatedAt ?? incoming.createdAt ?? 0;
  // 相等也保留本机：备份与本机一样新时，本机是用户此刻看到的那份
  return it > lt ? { value: incoming, replaced: true } : { value: local, replaced: false };
}

/**
 * 按 id 合并两个实体数组：本机独有保留、备份独有新增、同 id 取新。
 * 返回的新数组顺序 = 本机顺序 + 新增项追加在尾部（保持用户熟悉的排列）。
 */
export function mergeEntityList<T extends { id: string; updatedAt?: number; createdAt?: number }>(
  local: T[],
  incoming: T[],
  stats: MergeStats,
): T[] {
  const byId = new Map(local.map((x) => [x.id, x]));
  const out = [...local];
  for (const item of incoming) {
    if (!item || typeof item.id !== "string") {
      stats.skipped++;
      continue;
    }
    const hit = byId.get(item.id);
    const { value, replaced } = newer(hit, item);
    if (!hit) {
      byId.set(item.id, value);
      out.push(value);
      stats.added++;
    } else if (replaced) {
      byId.set(item.id, value);
      const at = out.findIndex((x) => x.id === item.id);
      if (at >= 0) out[at] = value;
      stats.updated++;
    } else {
      stats.skipped++;
    }
  }
  return out;
}

/** 从 persist 包裹里取出业务字段（zustand persist 写的是 `{ state, version }`） */
function unwrapState(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const box = value as { state?: unknown };
  const inner = (box.state ?? value) as Record<string, unknown>;
  return inner && typeof inner === "object" ? inner : null;
}

/** 合并「日期 → 任务数组」形态（plans / plans-archive 共用） */
function mergeDayTasks(
  localDays: Record<string, unknown>,
  incomingDays: Record<string, unknown>,
  stats: MergeStats,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...localDays };
  for (const [date, incoming] of Object.entries(incomingDays)) {
    const local = out[date];
    if (!local) {
      out[date] = incoming;
      const n = Array.isArray((incoming as { tasks?: unknown[] }).tasks)
        ? (incoming as { tasks: unknown[] }).tasks.length
        : Array.isArray(incoming)
          ? incoming.length
          : 1;
      stats.added += n;
      continue;
    }
    // 归档库是 `{ archivedAt, tasks }`，活跃库是 `PlanTask[]`
    const localList = (Array.isArray(local) ? local : (local as { tasks?: unknown[] }).tasks) ?? [];
    const incomingList =
      (Array.isArray(incoming) ? incoming : (incoming as { tasks?: unknown[] }).tasks) ?? [];
    const merged = mergeEntityList(
      localList as { id: string; updatedAt?: number }[],
      incomingList as { id: string; updatedAt?: number }[],
      stats,
    );
    out[date] = Array.isArray(local)
      ? merged
      : { ...(local as object), tasks: merged };
  }
  return out;
}

/**
 * 把备份数据合并进本机 store，并落盘。
 *
 * 直接 `setState` 而不是写文件：让 persist 中间件按正常路径落盘并广播，
 * 免得出现「文件更新了、内存里还是旧的、下一次编辑又写回去」的分叉。
 */
export async function mergeBackup(
  file: BackupFile,
  opts: { overwriteSettings: boolean },
): Promise<MergeStats> {
  const stats: MergeStats = { added: 0, updated: 0, skipped: 0 };

  // —— files ——
  const files = unwrapState(file.data.files);
  if (files) {
    const { useFiles } = await import("@/stores/files");
    const cur = useFiles.getState();
    const categories = mergeEntityList(
      cur.categories as { id: string; updatedAt?: number }[],
      (files.categories ?? []) as { id: string; updatedAt?: number }[],
      stats,
    );
    const items = mergeEntityList(
      cur.items as { id: string; updatedAt?: number }[],
      (files.items ?? []) as { id: string; updatedAt?: number }[],
      stats,
    );
    useFiles.setState({ categories, items } as never);
  }

  // —— fences ——（按分类 id 键控，无 updatedAt，本机优先）
  const fences = unwrapState(file.data.fences);
  if (fences && fences.fences && typeof fences.fences === "object") {
    const { useFences } = await import("@/stores/files");
    const cur = useFences.getState().fences as Record<string, unknown>;
    const incoming = fences.fences as Record<string, unknown>;
    let changed = false;
    const merged = { ...cur };
    for (const [id, geo] of Object.entries(incoming)) {
      if (merged[id]) {
        stats.skipped++;
        continue;
      }
      merged[id] = geo;
      stats.added++;
      changed = true;
    }
    if (changed) useFences.setState({ fences: merged } as never);
  }

  // —— plans ——
  const plans = unwrapState(file.data.plans);
  if (plans && plans.days && typeof plans.days === "object") {
    const { usePlans } = await import("@/features/plans/store");
    const cur = usePlans.getState().days as Record<string, unknown>;
    usePlans.setState({
      days: mergeDayTasks(cur, plans.days as Record<string, unknown>, stats),
    } as never);
  }

  // —— plans-archive ——
  const archive = unwrapState(file.data["plans-archive"]);
  if (archive && archive.days && typeof archive.days === "object") {
    const { usePlansArchive } = await import("@/features/plans/store");
    const cur = usePlansArchive.getState().days as Record<string, unknown>;
    usePlansArchive.setState({
      days: mergeDayTasks(cur, archive.days as Record<string, unknown>, stats),
    } as never);
  }

  // —— settings ——：默认不动本机值
  if (opts.overwriteSettings) {
    const s = unwrapState(file.data.settings);
    if (s) {
      const patch: Record<string, unknown> = {};
      if (typeof s.theme === "string") patch.theme = s.theme;
      if (typeof s.lang === "string") patch.lang = s.lang;
      if (typeof s.sidebarCollapsed === "boolean") patch.sidebarCollapsed = s.sidebarCollapsed;
      // dataDir / filesRoot 不覆盖：它们是本机路径，照搬过来会指向不存在的目录
      useSettings.setState(patch as never);
      stats.updated += Object.keys(patch).length;
    }
  }

  // —— 目录结构 ——
  if (file.dirs?.length) {
    const root = effectiveCategoriesRoot(file.root ?? null);
    if (root) await restoreDirTree(root, file.dirs);
  }

  return stats;
}

/** 分类根目录：优先本机设置里的 filesRoot，否则 `<dataDir>/categories` */
export function effectiveCategoriesRoot(fromBackup: string | null): string | null {
  const { filesRoot, dataDir } = useSettings.getState();
  if (filesRoot) return filesRoot;
  if (dataDir) return joinPath(dataDir, "categories");
  return fromBackup;
}

export function joinPath(a: string, b: string): string {
  const sep = a.includes("\\") ? "\\" : "/";
  return `${a.replace(/[\\/]+$/, "")}${sep}${b}`;
}

/** 当前分类根目录（导出时用来决定扫哪里） */
export function currentCategoriesRoot(): string | null {
  const { filesRoot, dataDir } = useSettings.getState();
  if (filesRoot) return filesRoot;
  if (dataDir) return joinPath(dataDir, "categories");
  return null;
}

export interface ExportOptions {
  includeDirs: boolean;
}

/** 收集备份内容（不落盘，便于测试） */
export async function buildBackup(opts: ExportOptions): Promise<BackupFile> {
  const data: BackupFile["data"] = {};
  for (const key of BACKUP_KEYS) {
    const v = await readJson<unknown>(key);
    if (v != null) data[key] = v;
  }

  let dirs: string[] | undefined;
  let root: string | null = null;
  if (opts.includeDirs) {
    root = currentCategoriesRoot();
    if (root) {
      try {
        dirs = await scanDirTree(root);
      } catch {
        // 目录还不存在 / 无权限：结构清单缺失不该让整个备份失败
        dirs = [];
      }
    }
  }

  return {
    kind: "nimbusdesk-backup",
    schema: BACKUP_SCHEMA,
    app: "nimbusdesk",
    exportedAt: new Date().toISOString(),
    data,
    dirs,
    root,
  };
}

/** 导出：选路径 → 收集 → 原子写。取消返回 null */
export async function exportBackup(opts: ExportOptions): Promise<BackupExport | null> {
  const stamp = new Date().toISOString().slice(0, 10);
  const path = await pickBackupSavePath(`nimbusdesk-backup-${stamp}.json`);
  if (!path) return null;
  // 先落盘所有待写，保证备份内容是「最新」而不是少 250ms 的那一版
  flushAllStorage();
  const file = await buildBackup(opts);
  return writeBackup(path, JSON.stringify(file, null, 2));
}

/** 恢复：选文件 → 解析 → 合并。取消返回 null */
export async function importBackup(opts: {
  overwriteSettings: boolean;
}): Promise<{ stats: MergeStats; file: BackupFile } | null> {
  const path = await pickBackupOpenPath();
  if (!path) return null;
  const text = await readBackup(path);
  const file = parseBackup(text);
  const stats = await mergeBackup(file, opts);
  // 合并结果立即落盘（setState 会触发 persist，但那是 250ms 防抖）
  flushAllStorage();
  // settings 若被覆盖，需要立刻应用到界面
  const { applyTheme } = await import("@/lib/theme");
  const { changeLang } = await import("@/lib/i18n");
  const s = useSettings.getState();
  applyTheme(s.theme);
  changeLang(s.lang);
  return { stats, file };
}

/** 备份文件里有哪些 key、各多大 —— 用于恢复前给用户看一眼 */
export function describeBackup(file: BackupFile): { key: BackupKey; bytes: number }[] {
  return backupKeysOf(file).map((key) => ({
    key,
    bytes: JSON.stringify(file.data[key] ?? null).length,
  }));
}

/** 供 UI 判断本机是否已有数据（决定是否提示「会合并而不是清空」） */
export async function hasLocalData(): Promise<boolean> {
  for (const key of BACKUP_KEYS) {
    if (key === "settings") continue;
    const v = await readJson<unknown>(key);
    const s = unwrapState(v);
    if (!s) continue;
    if (Array.isArray(s.categories) && s.categories.length) return true;
    if (Array.isArray(s.items) && s.items.length) return true;
    if (s.days && Object.keys(s.days as object).length) return true;
  }
  return false;
}

/** 恢复后需要写入的 key（写回磁盘的入口统一在 store，这里只导出常量供调用方参考） */
export const BACKUP_WRITE_KEYS = BACKUP_KEYS;

/** 直接写某 key（备份恢复的兜底路径；正常走 store 的 persist） */
export async function writeKey(key: BackupKey, value: unknown): Promise<void> {
  await writeJson(key, value);
}
