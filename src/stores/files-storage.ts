import type { PersistStorage } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { applyFilesDelta, diffFiles, isEmptyDelta, type FilesDelta, type FilesSnapshot } from "@/lib/files-diff";
import type { FileCategory, FileItem } from "./files";

/**
 * `files` 的持久化适配器：读走行级表，写只推增量。
 *
 * 以前 zustand persist 每次 `set()` 都把**整份** `{categories, items}` 序列化成一个 key 里的一整行
 * —— 8000 条时单次 12 ms 序列化 + IPC + SQLite 重写整行。现在：
 *
 * - `getItem` → `files_load`（行级表是唯一真源；不再有「回退读旧 `files` 键」的兼容路径）；
 * - `setItem` → 与「上一次落库的快照」比对，只把真正变了的实体推给 `files_apply`；
 * - 跨窗口 → 推成功后就地广播同一份增量，别的窗口 `applyFilesDelta` 合进本窗口的 store，
 *   期间 `applyingRemote` 让回灌引起的 `set()` 只更新快照、**不回写**（否则会来回弹）。
 *
 * 注意：`module_state` 里那份旧的整份 `files` JSON **没有被删除**，只是不再被读取。
 * 万一某台机器上还有这样一份数据且需要找回，见 `docs/plan-storage-sharding.md` 末尾的说明。
 */
const EVENT = "files://changed";
const VERSION = 2;
const source = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`;

/** 上一次确认落库的内容：一次 `set()` 之后靠它算增量。 */
let snapshot: FilesSnapshot | null = null;
/** 正在应用别的窗口推来的增量：此时 `set()` 不该再回写。 */
let applyingRemote = false;

export interface FilesPersisted extends FilesSnapshot {
  categories: FileCategory[];
  items: FileItem[];
}

export function setApplyingRemote(on: boolean) {
  applyingRemote = on;
}

/** 测试/备份用：当前已知的落库快照。 */
export function filesSnapshot(): FilesSnapshot | null {
  return snapshot;
}

export function resetFilesSnapshot(state: FilesSnapshot | null = null) {
  snapshot = state;
}

async function push(delta: FilesDelta) {
  if (isEmptyDelta(delta)) return;
  await invoke("files_apply", { delta });
  await emit(EVENT, { delta, source }).catch(() => undefined);
}

export const filesTableStorage: PersistStorage<FilesPersisted> = {
  async getItem() {
    try {
      const loaded = await invoke<{ categories: FileCategory[]; items: FileItem[] }>("files_load");
      const state: FilesSnapshot = {
        categories: Array.isArray(loaded?.categories) ? loaded.categories : [],
        items: Array.isArray(loaded?.items) ? loaded.items : [],
      };
      snapshot = state;
      return { state: state as FilesPersisted, version: VERSION };
    } catch {
      // 读不出来就当空库：写的时候按「全量插入」走，不会覆盖掉什么
      snapshot = null;
      return null;
    }
  },

  async setItem(_name, value) {
    const next = value.state as FilesSnapshot;
    if (applyingRemote) {
      snapshot = next;
      return;
    }
    const delta = diffFiles(snapshot, next);
    snapshot = next;
    await push(delta);
  },

  async removeItem() {
    const next: FilesSnapshot = { categories: [], items: [] };
    const delta = diffFiles(snapshot, next);
    snapshot = next;
    await push(delta);
  },
};

/** 别的窗口推来的增量 → 合进本窗口 store。 */
export async function applyRemoteFilesDelta(delta: FilesDelta, store: {
  getState: () => FilesPersisted;
  setState: (partial: Partial<FilesPersisted>, replace?: boolean) => void;
}) {
  if (!delta) return;
  applyingRemote = true;
  try {
    store.setState(applyFilesDelta(store.getState(), delta) as Partial<FilesPersisted>);
  } finally {
    applyingRemote = false;
  }
}
